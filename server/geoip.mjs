/**
 * IP 归属地：批量查询 + 内存/SQLite 双层缓存，外部不可用时静默降级为空。
 *
 * 用户 IP 属于个人信息，默认不外发；要开必须显式给两个开关之一：
 *   MH_GEOIP=1      打开外发
 *   MH_GEOIP_URL=…  指定端点（缺省见 DEFAULT_API_URL）
 * 端点一律走 https：原来硬编码 http://ip-api.com/batch，会把用户 IP 明文发到公网。
 * 免费版 ip-api 只支持 http，需要它的话自己填 MH_GEOIP_URL 并接受明文这一后果。
 */
import { db } from './db.mjs'
import { logWarn } from './logger.mjs'

const DEFAULT_API_URL = 'https://pro.ip-api.com/batch?lang=zh-CN&fields=status,country,regionName,city,query'
const BATCH = 100
const OK_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FAIL_TTL_MS = 10 * 60 * 1000
const GAP_MS = 1600
const TIMEOUT_MS = 8000

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^0\./]

const memory = new Map()
let chain = Promise.resolve()

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
/** 默认关闭：只有显式 MH_GEOIP=1 才允许外发查询 */
const enabled = () => String(process.env.MH_GEOIP ?? '').trim() === '1'
const apiUrl = () => String(process.env.MH_GEOIP_URL ?? '').trim() || DEFAULT_API_URL

/** 日志里的 IP 只留前两段（v4）/ 前两组（v6）：归属地统计不需要精确到主机 */
export function maskIp(ip) {
  const value = String(ip ?? '').trim()
  if (!value) return ''
  if (value.includes(':')) return `${value.split(':').filter(Boolean).slice(0, 2).join(':')}:…`
  const parts = value.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : value
}

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).host
  } catch {
    return 'invalid'
  }
}

/** 内网/本机/保留地址：不打外部接口。IPv6 只做粗判（ULA 与链路本地）。 */
export function isPrivateIp(ip) {
  const value = String(ip ?? '').trim().toLowerCase()
  if (!value) return true
  if (value === '::1' || value === 'localhost') return true
  if (value.includes(':')) return /^f[cd]/.test(value) || /^fe[89ab]/.test(value)
  return PRIVATE_V4.some((re) => re.test(value))
}

/** 把国家/省/市拼成一行展示串，重复或空段自动去掉。 */
export function regionLabel({ country, region, city } = {}) {
  const parts = []
  for (const raw of [country, region, city]) {
    const text = String(raw ?? '').trim()
    if (!text || parts.includes(text)) continue
    parts.push(text)
  }
  return parts.join(' · ')
}

function readRow(ip, now) {
  const row = db.prepare('SELECT label, checked_at FROM ip_geo WHERE ip = ?').get(ip)
  if (!row) return null
  if (now - Number(row.checked_at ?? 0) > OK_TTL_MS) return null
  return row.label ?? ''
}

function writeRow(ip, label, now) {
  db.prepare(`INSERT INTO ip_geo (ip, label, checked_at) VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET label = excluded.label, checked_at = excluded.checked_at`)
    .run(ip, label, now)
}

async function queryBatch(ips) {
  const endpoint = apiUrl()
  if (!/^https:\/\//i.test(endpoint)) {
    // 明文端点会把用户 IP 抖给链路上的任何人：只说不做，让运维显式改配置
    logWarn('geoip.insecure_endpoint', { host: endpointHost(endpoint), count: ips.length })
    return null
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ips),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      // 只记主机名与状态码：URL 里可能带 API key，按 docs/LOGGING.md 一律不外泄
      logWarn('geoip.query_failed', { host: endpointHost(endpoint), status: res.status, count: ips.length, sample: maskIp(ips[0]) })
      return null
    }
    const data = await res.json()
    if (!Array.isArray(data)) return null
    return data
  } catch (error) {
    logWarn('geoip.query_error', { host: endpointHost(endpoint), count: ips.length, sample: maskIp(ips[0]), message: error?.message ?? 'unknown' })
    return null
  }
}

const serialize = (task) => {
  const next = chain.then(task, task)
  chain = next.then(() => undefined, () => undefined)
  return next
}

/**
 * 批量解析 IP 归属地，返回 Map<ip, label>。
 * 解析不到的 IP 不写库（十分钟内不重复试），调用方拿不到就当空串处理。
 */
export async function resolveRegions(ips) {
  const out = new Map()
  const list = [...new Set((ips ?? []).map((ip) => String(ip ?? '').trim()).filter(Boolean))]
  if (!list.length) return out

  const now = Date.now()
  const need = []
  for (const ip of list) {
    if (isPrivateIp(ip)) {
      out.set(ip, '内网')
      continue
    }
    const hit = memory.get(ip)
    if (hit && now - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) {
      out.set(ip, hit.label)
      continue
    }
    const cached = readRow(ip, now)
    if (cached !== null) {
      memory.set(ip, { label: cached, at: now, ok: true })
      out.set(ip, cached)
      continue
    }
    need.push(ip)
  }
  if (!need.length) return out
  if (!enabled()) {
    for (const ip of need) out.set(ip, '')
    return out
  }

  for (let index = 0; index < need.length; index += BATCH) {
    const slice = need.slice(index, index + BATCH)
    if (index) await sleep(GAP_MS)
    const rows = await serialize(() => queryBatch(slice))
    const stamp = Date.now()
    for (const ip of slice) {
      // 端点可换（MH_GEOIP_URL），按 ip-api 版式解析，同时兼容 ipwho.is 的 success/ip 字段
      const row = rows?.find((item) => (item?.query ?? item?.ip) === ip)
      const hit = row && (row.status === 'success' || row.success === true)
      const label = hit ? regionLabel({ country: row.country, region: row.regionName ?? row.region, city: row.city }) : ''
      memory.set(ip, { label, at: stamp, ok: Boolean(label) })
      if (label) writeRow(ip, label, stamp)
      out.set(ip, label)
    }
  }
  return out
}

/** 单个 IP 便捷入口（命中缓存时同步返回，否则等一次批量往返）。 */
export async function regionOf(ip) {
  const regions = await resolveRegions([ip])
  return regions.get(String(ip ?? '').trim()) ?? ''
}

/** 清空内存缓存（测试用）。 */
export function clearGeoCache() {
  memory.clear()
}
