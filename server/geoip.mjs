/**
 * IP 归属地：查询 + 内存/SQLite 双层缓存，外部不可用时静默降级为空。
 *
 * 用户 IP 属于个人信息，默认不外发；要开必须显式给开关：
 *   MH_GEOIP=1      打开外发
 *   MH_GEOIP_URL=…  换成自建/付费批量端点（ip-api 版式，仅 https）
 * 默认通道是 ipwho.is：免 key、https、支持 ?lang=zh-CN，一次一个 IP，香港可直连。
 * 不要拿 pro.ip-api.com 当默认：它没有 key 一律 403，地区会静默全空——线上就是这么丢的。
 * 端点一律走 https：原来硬编码 http://ip-api.com/batch，会把用户 IP 明文发到公网。
 */
import { db } from './db.mjs'
import { logWarn } from './logger.mjs'

const IPWHO_URL = 'https://ipwho.is'
const DEFAULT_API_URL = 'https://pro.ip-api.com/batch?lang=zh-CN&fields=status,country,regionName,city,query'
const BATCH = 100
const OK_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FAIL_TTL_MS = 10 * 60 * 1000
const GAP_MS = 1600
const TIMEOUT_MS = 8000

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(?:1[6-9]|2\d|3[01])\./, /^0\./]

const memory = new Map()
const warming = new Set()
let chain = Promise.resolve()

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
/** 默认关闭：只有显式 MH_GEOIP=1 才允许外发查询 */
const enabled = () => String(process.env.MH_GEOIP ?? '').trim() === '1'
/** 自定义批量端点；没配就走 ipwho.is 单查 */
const customEndpoint = () => String(process.env.MH_GEOIP_URL ?? '').trim()
const apiUrl = () => customEndpoint() || DEFAULT_API_URL

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

// 归属地是不同厂商给的：ipwho.is 的「中文」夹简体繁体混排（南寧/猶他州/法蘭西島大區），
// 省市还会一半英文一半中文（日本 · Tokyo · 东京）。不归一，同一座城市会在分布图里裂成两行。
const T2S = {
  寧: '宁', 猶: '犹', 蘭: '兰', 島: '岛', 華: '华', 庫: '库', 灣: '湾', 維: '维', 亞: '亚',
  爾: '尔', 陸: '陆', 區: '区', 國: '国', 縣: '县', 鄉: '乡', 廣: '广', 東: '东', 內: '内',
  韓: '韩', 薩: '萨', 頓: '顿', 緬: '缅', 賴: '赖', 達: '达', 錫: '锡', 麥: '麦', 賓: '宾',
  魯: '鲁', 幾: '几', 岡: '冈', 烏: '乌', 龍: '龙', 門: '门', 陽: '阳', 陰: '阴', 馬: '马',
  謝: '谢', 萬: '万', 豐: '丰', 復: '复', 義: '义', 興: '兴', 樂: '乐', 會: '会', 樓: '楼',
  橋: '桥', 灘: '滩', 頭: '头', 邊: '边', 關: '关', 開: '开', 將: '将', 軍: '军', 嶺: '岭',
  嶼: '屿', 濱: '滨', 澗: '涧', 聖: '圣', 圖: '图', 屬: '属', 際: '际', 葉: '叶', 倫: '伦',
  凱: '凯', 鎮: '镇', 臺: '台', 養: '养', 澤: '泽', 紐: '纽', 約: '约', 羅: '罗', 貝: '贝',
  鳳: '凤', 慶: '庆', 莊: '庄', 勞: '劳', 遼: '辽', 濟: '济', 親: '亲', 車: '车', 漢: '汉', 費: '费',
}

const ASCII_ONLY = /^[\x20-\x7e]+$/
const CJK_RE = /[\u4e00-\u9fff]/

function toSimplified(text) {
  return String(text ?? '').replace(/[\u4e00-\u9fff]/g, (ch) => T2S[ch] ?? ch)
}

/** 城市字段常见脏写法：带括号补充说明、把省名用逗号缀在后面。 */
function cleanCity(city) {
  const text = String(city ?? '').replace(/[（(][^）)]*[）)]/g, '').trim()
  return text.split(/[，,]/)[0]?.trim() || text
}

/** 东京 / 东京都、华盛顿哥伦比亚特区 / 哥伦比亚特区：市名把省名又抄了一遍，只留省。 */
function isRedundant(region, city) {
  if (!region || !city) return false
  if (region === city) return true
  const short = region.length <= city.length ? region : city
  const long = region.length <= city.length ? city : region
  return short.length >= 2 && long.includes(short)
}

/** 统一简体，并让同一行只出现一种语言：省是英文而市是中文时只留市，反之只留省。 */
export function canonicalRegionLabel(label) {
  const parts = String(label ?? '')
    .split('·')
    .map((part) => toSimplified(part).trim())
    .filter(Boolean)
  if (parts.length < 2) return parts.join(' · ')
  const country = parts[0]
  if (parts.length === 2) return `${country} · ${parts[1]}`
  const region = parts[1]
  const city = cleanCity(parts[2])
  if (isRedundant(region, city)) return `${country} · ${region}`
  if (ASCII_ONLY.test(region) && CJK_RE.test(city)) return `${country} · ${city}`
  if (ASCII_ONLY.test(city) && CJK_RE.test(region)) return `${country} · ${region}`
  return `${country} · ${region} · ${city}`
}

/** 行政区后缀只影响写法，不影响是哪座城市；合并键里去掉，东京 / 东京都才能并成一行。 */
const REGION_SUFFIX = /(特别行政区|特区|自治区|社区发展理事会|大区|地区|省|市|都|县|区|州)$/

/** 分布图合并键：国家 + 最后一段（城市优先）。省名口径不同（法兰西岛 / 法兰西岛大区）也能并成一行。 */
export function regionMergeKey(label) {
  const parts = String(label ?? '').split(' · ').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0]
  const tail = parts.at(-1)
  return `${parts[0]} · ${tail.replace(REGION_SUFFIX, '') || tail}`
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

/** ipwho.is 单 IP 查询：GET /{ip}?lang=zh-CN，返回 { ip, success, country, region, city } */
async function queryOne(ip) {
  const host = endpointHost(IPWHO_URL)
  const endpoint = `${IPWHO_URL}/${encodeURIComponent(ip)}?lang=zh-CN`
  try {
    const res = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      logWarn('geoip.query_failed', { host, status: res.status, count: 1, sample: maskIp(ip) })
      return null
    }
    const data = await res.json()
    return data && typeof data === 'object' ? data : null
  } catch (error) {
    logWarn('geoip.query_error', { host, count: 1, sample: maskIp(ip), message: error?.message ?? 'unknown' })
    return null
  }
}

const serialize = (task) => {
  const next = chain.then(task, task)
  chain = next.then(() => undefined, () => undefined)
  return next
}

/** 统一把各家返回的字段收敛成展示串（ipwho.is 用 region，ip-api 用 regionName） */
function labelOf(row) {
  if (!row) return ''
  if (row.success === false || row.status === 'fail') return ''
  return canonicalRegionLabel(regionLabel({ country: row.country, region: row.regionName ?? row.region, city: row.city }))
}

/**
 * 只读缓存：不发任何外部请求，供埋点列表/统计这类请求内同步使用。
 * 未缓存的 IP 返回空串，由 warmRegions 在后台补齐。
 */
export function cachedRegions(ips) {
  const out = new Map()
  const now = Date.now()
  const list = [...new Set((ips ?? []).map((ip) => String(ip ?? '').trim()).filter(Boolean))]
  const lookup = []
  for (const ip of list) {
    if (isPrivateIp(ip)) {
      out.set(ip, '内网')
      continue
    }
    const hit = memory.get(ip)
    if (hit && now - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) {
      out.set(ip, canonicalRegionLabel(hit.label ?? ''))
      continue
    }
    lookup.push(ip)
  }
  // 一条 IN 查询取全部，避免 IP 多时打成 N 次单查；SQLite 变量上限按 900 分批
  for (let index = 0; index < lookup.length; index += 900) {
    const slice = lookup.slice(index, index + 900)
    const rows = db.prepare(`SELECT ip, label, checked_at FROM ip_geo WHERE ip IN (${slice.map(() => '?').join(',')})`).all(...slice)
    for (const row of rows) {
      const fresh = now - Number(row.checked_at ?? 0) <= OK_TTL_MS
      const label = fresh ? canonicalRegionLabel(row.label ?? '') : ''
      memory.set(row.ip, { label, at: now, ok: fresh })
      out.set(row.ip, label)
    }
  }
  for (const ip of lookup) if (!out.has(ip)) out.set(ip, '')
  return out
}

/**
 * 后台预热：把缓存里还没有的 IP 丢给外部接口，立刻返回。
 * 调用方（埋点列表/统计）不等待网络，页面先显示已知归属地。
 */
export function warmRegions(ips) {
  if (!enabled()) return
  const list = [...new Set((ips ?? []).map((ip) => String(ip ?? '').trim()).filter(Boolean))]
  if (!list.length) return
  const known = cachedRegions(list)
  const miss = list.filter((ip) => !warming.has(ip) && !known.get(ip))
  if (!miss.length) return
  for (const ip of miss) warming.add(ip)
  resolveRegions(miss)
    .catch(() => {})
    .finally(() => { for (const ip of miss) warming.delete(ip) })
}

/**
 * 解析 IP 归属地，返回 Map<ip, label>。
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

  if (!customEndpoint()) {
    // 默认通道：ipwho.is 单查，按 GAP_MS 限速，失败十分钟内不再重试
    let lastAt = 0
    for (const ip of need) {
      if (lastAt) await sleep(Math.max(0, GAP_MS - (Date.now() - lastAt)))
      const row = await serialize(() => queryOne(ip))
      lastAt = Date.now()
      const label = labelOf(row)
      memory.set(ip, { label, at: lastAt, ok: Boolean(label) })
      if (label) writeRow(ip, label, lastAt)
      out.set(ip, label)
    }
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
      const label = labelOf(row)
      memory.set(ip, { label, at: stamp, ok: Boolean(label) })
      if (label) writeRow(ip, label, stamp)
      out.set(ip, label)
    }
  }
  return out
}

/** 单个 IP 便捷入口（命中缓存时同步返回，否则等一次往返）。 */
export async function regionOf(ip) {
  const regions = await resolveRegions([ip])
  return regions.get(String(ip ?? '').trim()) ?? ''
}

/** 唯一地区数（测试与脚本用）。 */
export function cachedIpCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM ip_geo').get().n
}

/** 清空内存缓存（测试用）。 */
export function clearGeoCache() {
  memory.clear()
  warming.clear()
}



