/** IP 归属地：批量查询 + 内存/SQLite 双层缓存，外部不可用时静默降级为空。 */
import { db } from './db.mjs'

const API_URL = 'http://ip-api.com/batch?lang=zh-CN&fields=status,country,regionName,city,query'
const BATCH = 100
const OK_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FAIL_TTL_MS = 10 * 60 * 1000
const GAP_MS = 1600
const TIMEOUT_MS = 8000

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^0\./]

const memory = new Map()
let chain = Promise.resolve()

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
const off = () => String(process.env.MH_GEOIP ?? '').trim().toLowerCase() === 'off'

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
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ips),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data)) return null
    return data
  } catch {
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
  if (off()) {
    for (const ip of need) out.set(ip, '')
    return out
  }

  for (let index = 0; index < need.length; index += BATCH) {
    const slice = need.slice(index, index + BATCH)
    if (index) await sleep(GAP_MS)
    const rows = await serialize(() => queryBatch(slice))
    const stamp = Date.now()
    for (const ip of slice) {
      const row = rows?.find((item) => item?.query === ip)
      const label = row && row.status === 'success' ? regionLabel({ country: row.country, region: row.regionName, city: row.city }) : ''
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
