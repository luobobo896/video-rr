/**
 * 外部片源冷代理（remote source gateway）
 *
 * 站点不自建转码、不落整片，只做「清单重写 + 分片转发」：
 *   /media/remote/<episodeId>/index.m3u8  → 拉上游清单，把所有 URI 重写成本站相对路径
 *   /media/remote/<episodeId>/seg/<key>   → 流式转发上游分片（Range 透传 + 磁盘冷缓存）
 *
 * 上游既可以是 m3u8，也可以是播放页；播放页会自动抽出 m3u8。
 * 上游请求头（Referer / Origin / User-Agent / Cookie）来自剧集配置，统一由服务器带出：
 * 上游按 IP / UA / Referer 做的绑定全部落在 HK 这台机器上，播放器看到的始终是本站域名。
 *
 * 签名沿用 entitlements.secureLink：scope = /media/remote/<id>/，一集一次签名，
 * 清单与分片通用（与 /media/hls/ 完全同一套规则，nginx 侧不需要额外 auth 分支）。
 *
 * 上游可信度：remote_url 是管理员/脚本填的第三方地址，但它可能被 302 引到内网
 * （SSRF），所以每一跳都过 assertPublicUrl，且 redirect 手写跟随（最多 3 跳）。
 * 逃生阀：MH_REMOTE_ALLOW_PRIVATE=1（本地联调 / 单测用，生产别开）。
 */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { logError, logInfo, logWarn } from './logger.mjs'
import { HG_BASE, huangguoPlayback, isHuangguoRef, parseHuangguoRef } from './huangguo.mjs'
import { normalizePlaylistUri, truncatePlaylist } from './trial-playlist.mjs'

const CACHE_DIR = process.env.MH_REMOTE_CACHE || fileURLToPath(new URL('../storage/remote-cache/', import.meta.url))
const SESSION_TTL_MS = 30 * 60 * 1000
/** 现取票的源（huangguo 等）票面有效期短，会话跟着缩短 */
const HG_SESSION_TTL_MS = Number(process.env.MH_HG_SESSION_TTL_MS ?? 3 * 60 * 1000)
const MAX_SEGMENTS_PER_SESSION = 20000
/** 会话表上限：episodeId -> session，进程内表，按"最久未续期"淘汰 */
const MAX_SESSIONS = Number(process.env.MH_REMOTE_SESSIONS ?? 200)
const MAX_SEGMENT_BYTES = 96 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = Number(process.env.MH_REMOTE_TIMEOUT_MS ?? 15000)
/** 落盘/转发一整个分片的最长等待：上游半包不发也不断时不能让 done 永不 resolve */
const STREAM_MAX_MS = Number(process.env.MH_REMOTE_STREAM_TIMEOUT_MS ?? 120000)
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 分片缓存 TTL / 容量：缓存名里的签名去掉后才会稳定，但内容仍可能过期或被下架 */
const cacheTtlMs = () => Number(process.env.MH_REMOTE_CACHE_TTL ?? 6 * 3600 * 1000)
const cacheMaxBytes = () => Number(process.env.MH_REMOTE_CACHE_MAX_MB ?? 4096) * 1024 * 1024
const CACHE_SWEEP_GAP_MS = 5 * 60 * 1000
/** 上游 404/410 的结论短时缓存：下架片别每来一个请求就换一次票 */
const GONE_TTL_MS = Number(process.env.MH_REMOTE_GONE_TTL ?? 10 * 60 * 1000)
const MAX_GONE = Number(process.env.MH_REMOTE_GONE_MAX ?? 500)

/** episodeId -> session；进程内表，重启后播放器重拉 index.m3u8 即可自愈 */
const sessions = new Map()
/** 规范化后的分片地址 -> 正在下载的 Promise，避免同一分片并发穿透上游 */
const inflight = new Map()
/** 规范化后的分片地址 -> { status, at }：上游明确 404/410 的结论，短时不再回源 */
const gone = new Map()

// AES key 只有 16 字节，但每次都要跨境回源 200ms 上下；播放器一旦漏取或重取，
// 就直接抛 keyLoadError 整片停住。这里给 key 做短时内存缓存（不落盘、按 URL 区分）。
const KEY_CACHE_TTL_MS = 5 * 60 * 1000
const KEY_CACHE_MAX = 512
const keyCache = new Map()

const M3U8_RE = /\.m3u8(\?|$)/i
/** 直链文件源（archive.org 这类）没有清单，走整文件 Range 转发，播放器用原生 mp4 播 */
const DIRECT_FILE_RE = /\.(mp4|m4v|webm|mkv|mov|ogv|ogm)(?:\?|$)/i
const PAGE_CANDIDATES = [
  /"file"\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
  /"url"\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
  /"src"\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
  /(?:file|source|src|hls)\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
  /(https?:\\?\/\\?\/[^"'\s\\]+\.m3u8[^"'\s\\]*)/i,
]

/** 上游地址里参与签名的 query 参数：算缓存名时剔掉，否则换票就全量重落盘 */
const SIGNATURE_PARAMS = new Set([
  'exp', 'expires', 'token', 'sig', 'signature',
  'auth_key', 'auth_key_id', 'policy', 'key-pair-id',
  'x-amz-signature', 'x-amz-credential', 'x-amz-date', 'st',
])

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function cachePathOf(name) {
  return join(CACHE_DIR, name.slice(0, 2), name)
}

function headerBag(source) {
  const headers = {
    'user-agent': source.ua || DEFAULT_UA,
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  if (source.referer) headers.referer = source.referer
  if (source.origin) headers.origin = source.origin
  if (source.cookie) headers.cookie = source.cookie
  // 播放接口签发的一次性 CDN 凭证（x-cdn-auth / x-cdn-app 等）只对签发它的主机有效，
  // 换票/换 CDN 之后必须整份重建，否则旧凭证会跟着发给新主机（跨域泄漏 + 被 403）
  if (source.extraHeaders) Object.assign(headers, source.extraHeaders)
  return headers
}

/** 把 episodes 行里的三段配置拼成上游描述；也接受纯 URL 字符串 */
export function remoteSourceOf(episode) {
  const raw = typeof episode === 'string' ? episode : episode?.remote_url
  if (!raw) return null
  const value = String(raw).trim()
  // 不走 URL 的源（需要先调上游接口换票），用 provider 分支描述
  if (isHuangguoRef(value)) {
    const ref = parseHuangguoRef(value)
    if (!ref) return null
    return {
      provider: 'huangguo',
      videoId: ref.videoId,
      ep: ref.ep,
      pageUrl: value,
      referer: (typeof episode === 'object' && episode.remote_referer) || `${HG_BASE}/`,
      origin: HG_BASE,
      ua: (typeof episode === 'object' && episode.remote_ua) || DEFAULT_UA,
      cookie: (typeof episode === 'object' && episode.remote_cookie) || '',
      extraHeaders: {},
    }
  }
  if (!/^https?:\/\//i.test(value)) return null
  const pageUrl = value
  let referer = typeof episode === 'object' ? episode.remote_referer || '' : ''
  if (!referer) {
    try {
      referer = new URL(pageUrl).origin + '/'
    } catch {
      referer = ''
    }
  }
  let origin = ''
  try {
    origin = referer ? new URL(referer).origin : new URL(pageUrl).origin
  } catch {
    origin = ''
  }
  return {
    pageUrl,
    referer,
    origin,
    ua: (typeof episode === 'object' && episode.remote_ua) || DEFAULT_UA,
    cookie: (typeof episode === 'object' && episode.remote_cookie) || '',
    extraHeaders: {},
  }
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
]

function allowPrivateUpstream() {
  return process.env.MH_REMOTE_ALLOW_PRIVATE === '1'
}

/** hostname 归一：去 IPv6 方括号、去尾点、小写 */
function normalizeHost(hostname) {
  let host = String(hostname ?? '').trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

/**
 * 把各种 IPv4 变形收敛成点分四段：十进制整串（2130706433）、十六进制（0x7f000001）、
 * 逐段十六进制（0x7f.0.0.1）。不是 IPv4 就返回空串。
 */
function ipv4Of(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host
  if (/^(?:0x[0-9a-f]+|\d+)$/.test(host)) {
    const n = Number(host)
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return ''
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  }
  const parts = host.split('.')
  if (parts.length === 4 && parts.every((part) => /^(?:0x[0-9a-f]+|\d+)$/.test(part))) {
    const bytes = parts.map((part) => Number(part))
    if (bytes.every((byte) => Number.isSafeInteger(byte) && byte >= 0 && byte <= 255)) return bytes.join('.')
  }
  return ''
}

/** 这个 host（或 IP）是否指向内网/本机/链路本地，这类地址一律拒绝回源 */
export function isBlockedHost(hostname) {
  const host = normalizeHost(hostname)
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') return true
  if (host.includes(':')) {
    // IPv6：ULA(fc00::/7) / link-local(fe80::/10) 以及 ::ffff:127.0.0.1 这类映射地址
    if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return true
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host)
    if (mapped) return isBlockedHost(mapped[1])
    // URL 会把 ::ffff:127.0.0.1 收敛成十六进制写法 [::ffff:7f00:1]
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
    if (hexMapped) {
      const high = parseInt(hexMapped[1], 16)
      const low = parseInt(hexMapped[2], 16)
      return isBlockedHost([high >> 8, high & 255, low >> 8, low & 255].join('.'))
    }
    return false
  }
  const ipv4 = ipv4Of(host)
  if (!ipv4) return false
  return PRIVATE_V4.some((re) => re.test(ipv4))
}

const dnsCache = new Map()
const DNS_CACHE_TTL_MS = 60 * 1000

async function addressesOf(host) {
  if (ipv4Of(host) || host.includes(':')) return [host]
  const hit = dnsCache.get(host)
  if (hit && hit.exp > Date.now()) return hit.ips
  let ips = []
  try {
    const rows = await lookup(host, { all: true })
    ips = rows.map((row) => row.address)
  } catch {
    // 解析不了就交给 fetch 报错，这里不额外判死
    return []
  }
  if (dnsCache.size > 256) dnsCache.clear()
  dnsCache.set(host, { ips, exp: Date.now() + DNS_CACHE_TTL_MS })
  return ips
}

function targetError(message) {
  const err = new Error(message)
  err.status = 502
  err.blocked = true
  return err
}

/**
 * 只允许回源到公网 http(s)：拒绝 loopback / 私网 / 链路本地 / 元数据地址及其十进制、十六进制变形。
 * 解析不了域名时不做拦截（fetch 自己会失败），但解析出来的每个地址都要过一遍。
 */
export async function assertPublicUrl(raw, { allowPrivate = allowPrivateUpstream() } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw targetError('上游地址不合法')
  }
  if (!/^https?:$/.test(url.protocol)) throw targetError(`不支持的上游协议 ${url.protocol}`)
  if (allowPrivate) return url
  if (isBlockedHost(url.hostname)) throw targetError(`拒绝回源到内网地址 ${url.hostname}`)
  const ips = await addressesOf(normalizeHost(url.hostname))
  for (const ip of ips) {
    if (isBlockedHost(ip)) throw targetError(`拒绝回源到内网地址 ${url.hostname}(${ip})`)
  }
  return url
}

const MAX_REDIRECTS = 3

async function fetchUpstream(url, source, extraHeaders = {}, { timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  let current = String(url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // 逃生阀只对管理员配置的首跳生效：302 目标由上游控制，一律按严格规则判
    await assertPublicUrl(current, { allowPrivate: hop === 0 && allowPrivateUpstream() })
    const res = await fetch(current, {
      headers: { ...headerBag(source), ...extraHeaders },
      // 自己跟 302：每跳都要重新判目标，redirect:'follow' 会把内网地址直接放进来
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      try { await res.body?.cancel() } catch { /* 已经关掉 */ }
      const next = location && absolutize(location, current)
      if (!next) {
        const err = new Error(`upstream redirect 缺少可用 location（${res.status}）`)
        err.status = 502
        throw err
      }
      current = next
      continue
    }
    if (!res.ok && res.status !== 206) {
      // 403/401 是"票过期或没带对凭证"，跟网络故障分开报，运维才知道要刷新片源；
      // 404/410 是"这段/这部片没了"，换票重试没有意义，别把它也算成可自愈
      const rejected = res.status === 403 || res.status === 401
      const missing = res.status === 404 || res.status === 410
      const err = new Error(rejected
        ? `source rejected (${res.status}) 直链签名过期或凭证失效，跑 scripts/jable-import.mjs --refresh 换新链接`
        : `upstream ${res.status} ${current}`)
      err.status = rejected || missing ? 502 : 504
      // 标记成「临时性」：调用方据此丢掉缓存会话并回 Retry-After，让播放器等续期而不是判死
      err.stale = rejected
      err.gone = missing
      err.upstreamStatus = res.status
      err.url = current
      throw err
    }
    return res
  }
  const err = new Error(`upstream 重定向超过 ${MAX_REDIRECTS} 跳`)
  err.status = 502
  throw err
}

function absolutize(uri, baseUrl) {
  try {
    return new URL(String(uri).replace(/\\\//g, '/'), baseUrl).toString()
  } catch {
    return null
  }
}

/** 播放页 → m3u8。抽不到就抛，语义是「源站改版 / 被挡」 */
async function resolveManifest(source) {
  // 需要先换票的源：播放地址与 CDN 头都只在这里现取
  if (source.provider === 'huangguo') {
    const play = await huangguoPlayback(source.videoId, source.ep)
    // 整份重建：上一次票带的 x-cdn-* 不能跟着发到这次的主机
    source.extraHeaders = { ...play.headers }
    return play.url
  }
  if (M3U8_RE.test(source.pageUrl)) return source.pageUrl
  const res = await fetchUpstream(source.pageUrl, source, { accept: 'text/html,*/*;q=0.8' })
  const html = await res.text()
  const base = res.url || source.pageUrl
  for (const re of PAGE_CANDIDATES) {
    const hit = html.match(re)?.[1]
    const abs = hit && absolutize(hit, base)
    if (abs && M3U8_RE.test(abs)) return abs
  }
  const loose = html.match(/(https?:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*)/i)?.[1]
  if (loose) return loose
  const err = new Error('no m3u8 found in page')
  err.status = 502
  throw err
}

/**
 * 去签名的规范化地址：query 里的签名参数剔掉，路径里 jable 那种 /hls/<token>/<exp>/ 也压平。
 * 缓存名、并发去重键都基于它，换票前后才是同一个名字。
 */
export function canonicalCacheUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    return String(raw)
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SIGNATURE_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name)
  }
  url.searchParams.sort()
  url.pathname = url.pathname.replace(/\/hls\/[^/]+\/\d{9,13}(?=\/)/, '/hls/-')
  return url.toString()
}

/**
 * 分片在本站的名字（sha1 前 20 位 + 扩展名）。
 * 用去签名的规范化地址算摘要：票刷新后上游地址会变、内容不变，名字稳定才能让正在播的
 * 播放器在服务端换票后继续命中同一段，也不会把旧缓存留成永久孤儿。
 */
function segmentName(url, session) {
  const key = canonicalCacheUrl(url)
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 20)
  if (M3U8_RE.test(url)) return `${digest}.m3u8`
  const ext = /\.(ts|m4s|mp4|aac|vtt|key)(\?|$)/i.exec(url)?.[1] ?? 'bin'
  return `${digest}.${ext}`
}

function register(session, uri, baseUrl, prefix, kind) {
  const abs = absolutize(uri, baseUrl)
  if (!abs) return uri
  // 调用方可能传入只带 segments 的裸 session（测试/旧调用），这里补全顺序索引
  if (!session.order) session.order = []
  if (!session.index) session.index = new Map()
  // 变体清单里的分片带上前缀（<variant>/<name>）：不同码率的同名分片不会互相覆盖，
  // 请求路径 seg/<前缀><name> 也能反查回同一个键
  const name = `${prefix}${segmentName(abs, session)}`
  if (!session.segments.has(name)) {
    session.index.set(name, session.order.length)
    session.order.push(name)
  }
  session.segments.set(name, { url: abs, kind, exp: Date.now() + SESSION_TTL_MS })
  while (session.segments.size > MAX_SEGMENTS_PER_SESSION) {
    const oldest = session.segments.keys().next().value
    session.segments.delete(oldest)
    session.index.delete(oldest)
    const at = session.order.indexOf(oldest)
    if (at >= 0) session.order.splice(at, 1)
  }
  return `seg/${name}`
}

function rewriteAttrUri(line, baseUrl, session, prefix) {
  // 密钥文件随会话轮换，不能落盘缓存；init 段（EXT-X-MAP）与普通分片同策略。
  // EXT-X-MEDIA / EXT-X-I-FRAME-STREAM-INF 的 URI 指向的是"另一份清单"，必须按清单重写，
  // 否则多音轨/多码率源的子清单会被当成一个分片，播放器一律 404。
  let kind = 'segment'
  if (/^#EXT-X-(KEY|SESSION-KEY)/i.test(line)) kind = 'key'
  else if (/^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/i.test(line)) kind = 'playlist'
  return line.replace(/URI="([^"]+)"/g, (all, uri) => `URI="${register(session, uri, baseUrl, prefix, kind)}"`)
}

/** 把上游清单里每一条 URI 换成本站相对路径；prefix 为空表示入口清单 */
export function rewritePlaylist(text, baseUrl, session, prefix = '') {
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      if (/^#EXT-X-(KEY|MAP|MEDIA|I-FRAME-STREAM-INF|SESSION-KEY)/i.test(trimmed)) {
        out.push(rewriteAttrUri(trimmed, baseUrl, session, prefix))
      } else {
        out.push(trimmed)
      }
      continue
    }
    const kind = M3U8_RE.test(trimmed) ? 'playlist' : 'segment'
    out.push(register(session, trimmed, baseUrl, prefix, kind))
  }
  return `${out.join('\n')}\n`
}

export function getSession(episodeId, source, { force = false } = {}) {
  const id = Number(episodeId)
  const now = Date.now()
  const existing = sessions.get(id)
  if (!force && existing && existing.source.pageUrl === source.pageUrl && existing.expiresAt > now) return existing
  // 现取票的源，票比会话短命，会话跟着缩短，避免拿着过期票反复 403
  const ttl = source.provider ? HG_SESSION_TTL_MS : SESSION_TTL_MS
  const session = {
    episodeId: id,
    source,
    manifestUrl: null,
    segments: new Map(),
    order: [],
    index: new Map(),
    createdAt: now,
    expiresAt: now + ttl,
    booting: null,
  }
  sessions.set(id, session)
  // 会话表按"最早过期"淘汰：长跑进程里每部片都留一份会无界增长
  if (sessions.size > MAX_SESSIONS) {
    const expired = [...sessions.values()].filter((row) => row.expiresAt <= now)
    for (const row of expired) sessions.delete(row.episodeId)
    while (sessions.size > MAX_SESSIONS) {
      const oldest = [...sessions.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0]
      if (!oldest) break
      sessions.delete(oldest.episodeId)
    }
  }
  return session
}

async function manifestOf(session) {
  if (session.manifestUrl) return session.manifestUrl
  if (!session.booting) {
    session.booting = resolveManifest(session.source).then(
      (url) => {
        session.manifestUrl = url
        session.booting = null
        return url
      },
      (err) => {
        session.booting = null
        sessions.delete(session.episodeId)
        throw err
      },
    )
  }
  return session.booting
}

async function loadPlaylistAt(url, session, prefix) {
  const res = await fetchUpstream(url, session.source)
  const text = await res.text()
  if (/^\s*<(!doctype|html)/i.test(text.slice(0, 200))) {
    const err = new Error('upstream returned html instead of m3u8')
    err.status = 502
    throw err
  }
  // 维护页/签名过期页长得很像清单：不以 #EXTM3U 开头就不是真清单，别重写也别缓存
  assertPlaylistBody(text)
  return rewritePlaylist(text, res.url || url, session, prefix)
}

async function loadEntryPlaylist(session) {
  const url = await manifestOf(session)
  return loadPlaylistAt(url, session, '')
}

function sendText(res, status, body, contentType = 'application/vnd.apple.mpegurl', cache = 'no-store') {
  const text = String(body ?? '')
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': cache,
    'access-control-allow-origin': '*',
    // 清单内容一变 etag 就变：播放器刷新清单时能省掉一次解析
    etag: `"${createHash('sha1').update(text).digest('hex').slice(0, 16)}"`,
  })
  res.end(text)
}

/**
 * RFC 9110 Range 解析：
 *   - 缺省/坏格式 → null（整段 200）
 *   - `bytes=-N` → 最后 N 字节
 *   - `start >= size`、`start > end`、空区间 → 'unsatisfiable'（调用方回 416 + bytes * /size）
 *   - `end` 越界 → 截断到 size-1
 *   - 多段只服务第一段（浏览器/播放器不会发多段 Range，多段响应要 multipart，不值得）
 */
export function parseRangeHeader(header, size) {
  const raw = String(header ?? '').trim()
  if (!raw || !Number.isFinite(size) || size <= 0) return null
  const m = /^bytes=(.+)$/i.exec(raw)
  if (!m) return null
  const first = m[1].split(',')[0].trim()
  const dm = /^(\d*)-(\d*)$/.exec(first)
  if (!dm || (!dm[1] && !dm[2])) return 'unsatisfiable'
  if (!dm[1]) {
    const suffix = Number(dm[2])
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(dm[1])
  let end = dm[2] ? Number(dm[2]) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'unsatisfiable'
  if (start > end || start >= size) return 'unsatisfiable'
  end = Math.min(end, size - 1)
  return { start, end }
}

function contentTypeOf(name) {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (name.endsWith('.ts')) return 'video/mp2t'
  if (name.endsWith('.m4s') || name.endsWith('.mp4')) return 'video/mp4'
  if (name.endsWith('.aac')) return 'audio/aac'
  if (name.endsWith('.vtt')) return 'text/vtt'
  return 'application/octet-stream'
}

/**
 * 读文件 → 响应。单独收口的原因：读失败（构建时原子替换 dist、转码清理、管理员删集）
 * 会让 createReadStream 抛 error，没有监听就是 uncaughtException，整个 API 进程退出。
 * 这里把连接直接断掉，请求日志里留一条 aborted，其它请求不受影响。
 */
export function pipeFile(res, filePath, range) {
  const stream = range ? createReadStream(filePath, range) : createReadStream(filePath)
  stream.on('error', () => {
    try { res.destroy() } catch { /* 客户端可能已经走了 */ }
  })
  res.on('close', () => stream.destroy())
  stream.pipe(res)
  return stream
}

function cacheEtag(file, name, stat) {
  return `"${createHash('sha1').update(`${name}:${stat.size}:${stat.mtimeMs.toFixed(0)}`).digest('hex').slice(0, 16)}"`
}

/** 命中缓存即刷新 mtime：TTL 按"多久没人看"算，淘汰按同一时间戳做 LRU */
function touchCache(file) {
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch { /* 并发淘汰掉了也不算错 */ }
}

function sendCached(res, file, name, rangeHeader) {
  const stat = statSync(file)
  const size = stat.size
  const range = parseRangeHeader(rangeHeader, size)
  const headers = {
    'content-type': contentTypeOf(name),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'access-control-allow-origin': '*',
    etag: cacheEtag(file, name, stat),
  }
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${size}`, 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
    headers['content-length'] = String(range.end - range.start + 1)
    res.writeHead(206, headers)
    pipeFile(res, file, { start: range.start, end: range.end })
    return
  }
  headers['content-length'] = String(size)
  res.writeHead(200, headers)
  pipeFile(res, file)
}

let lastSweepAt = 0

/**
 * 缓存清扫：先删超过 TTL 的（缓存名稳定之后，过期内容会一直躺在盘上），
 * 再按 LRU（mtime 最旧优先）压到 MH_REMOTE_CACHE_MAX_MB 以内。
 */
export function sweepRemoteCache({ force = false } = {}) {
  const now = Date.now()
  if (!force && now - lastSweepAt < CACHE_SWEEP_GAP_MS) return { skipped: true, removed: 0, bytes: 0 }
  lastSweepAt = now
  ensureDir(CACHE_DIR)
  const entries = []
  const walk = (dir) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else entries.push({ path: p, size: st.size, mtime: st.mtimeMs })
    }
  }
  walk(CACHE_DIR)
  let bytes = 0
  let removed = 0
  const ttl = cacheTtlMs()
  const maxBytes = cacheMaxBytes()
  const alive = []
  for (const entry of entries) {
    if (now - entry.mtime > ttl) {
      try { rmSync(entry.path, { force: true }); removed += 1 } catch { alive.push(entry); bytes += entry.size }
      continue
    }
    alive.push(entry)
    bytes += entry.size
  }
  if (bytes > maxBytes) {
    alive.sort((a, b) => a.mtime - b.mtime)
    for (const entry of alive) {
      if (bytes <= maxBytes) break
      try {
        rmSync(entry.path, { force: true })
        bytes -= entry.size
        removed += 1
      } catch { /* 被别的请求占着，下一轮再说 */ }
    }
  }
  if (removed > 0) logInfo('media.remote_cache.sweep', { removed, bytes, files: entries.length - removed })
  return { skipped: false, removed, bytes }
}

// 上游是跨境 CDN：一段 850KB–1.4MB 实测要 1.8–2.1 秒，而这一段只播 4 秒。
// 只靠「播放器要哪段就去回源哪段」是踩在临界线上——并发多一点点、链路抖一下，
// 缓冲就被吃光，播放器几秒后停住（fatal fragLoadError/bufferStall）。
// 所以服务端把后面几段提前拉进磁盘缓存：播放器来要时多数直接命中，抖动被摊平。
const PREFETCH_AHEAD = Number(process.env.MH_REMOTE_PREFETCH ?? 10)
const PREFETCH_CONCURRENCY = Number(process.env.MH_REMOTE_PREFETCH_CONCURRENCY ?? 3)
const WARM_ON_MANIFEST = Number(process.env.MH_REMOTE_WARM ?? 16)
/** 单次预取的头+body 超时：跨境链路卡住时不能占着槽位不放 */
const PREFETCH_TIMEOUT_MS = Number(process.env.MH_PREFETCH_TIMEOUT_MS ?? 20000)
/** 预取单段体积上限：没有 content-length 的上游也可能无限发，必须自己封顶 */
const PREFETCH_MAX_BYTES = Number(process.env.MH_PREFETCH_MAX_BYTES ?? 32 * 1024 * 1024)
/** 全局预取预算（同时进行的预取数）：播放请求优先，预取永远不抢满带宽 */
const PREFETCH_BUDGET = Number(process.env.MH_PREFETCH_BUDGET ?? 8)
/** 预取队列上限：清单一来就排 16 段，队列无限增长等于给自己发包 */
const UPSTREAM_QUEUE_LIMIT = Number(process.env.MH_UPSTREAM_QUEUE ?? 40)

const prefetchQueue = []
const prefetchQueued = new Set()
let prefetchActive = 0

function prefetchBudgetLeft() {
  return Math.max(0, PREFETCH_BUDGET - prefetchActive)
}

async function runPrefetch(session, name, entry) {
  const cached = cachePathOf(name)
  if (existsSync(cached)) return
  const tmp = `${cached}.${process.pid}.pre.part`
  const cap = Math.min(MAX_SEGMENT_BYTES, PREFETCH_MAX_BYTES)
  const task = (async () => {
    const upstream = await fetchUpstream(entry.url, session.source, {}, { timeoutMs: PREFETCH_TIMEOUT_MS })
    if (!upstream.ok || !upstream.body) throw new Error(`prefetch ${upstream.status}`)
    const length = Number(upstream.headers.get('content-length') ?? 0)
    if (length > cap) throw new Error('prefetch too large')
    ensureDir(join(CACHE_DIR, name.slice(0, 2)))
    let written = 0
    const guard = new Transform({
      transform(chunk, encoding, callback) {
        written += chunk.length
        if (written > cap) callback(new Error('prefetch too large'))
        else callback(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(upstream.body), guard, createWriteStream(tmp))
    renameSync(tmp, cached)
  })()
  // 登记到 inflight：真身请求碰上同一段时会等它落盘，然后直接命中缓存，不会重复回源
  const inflightKey = canonicalCacheUrl(entry.url)
  inflight.set(inflightKey, task)
  try {
    await task
  } catch (error) {
    rmSync(tmp, { force: true })
    logWarn('media.remote_prefetch_failed', { name, message: error?.message ?? 'unknown', stack: error?.stack })
  } finally {
    inflight.delete(inflightKey)
  }
}

function drainPrefetch() {
  while (prefetchActive < PREFETCH_CONCURRENCY && prefetchActive < PREFETCH_BUDGET && prefetchQueue.length) {
    const job = prefetchQueue.shift()
    prefetchActive++
    runPrefetch(job.session, job.name, job.entry).finally(() => {
      prefetchActive--
      prefetchQueued.delete(job.name)
      drainPrefetch()
    })
  }
}

/**
 * 换票：清掉清单缓存与段映射，重新解析一次。
 * 只对「播放地址现取」的源生效；普通直链源的票写在 URL 里，只能由运维脚本刷新。
 */
async function refreshTicket(session) {
  const source = session.source
  if (source.provider !== 'huangguo') return false
  await huangguoPlayback(source.videoId, source.ep, { force: true })
  session.manifestUrl = null
  session.segments.clear()
  session.order = []
  session.index.clear()
  await loadEntryPlaylist(session)
  session.expiresAt = Date.now() + HG_SESSION_TTL_MS
  return true
}

/**
 * 上游 404/410 的结论短时缓存：TTL 内不再回源。
 * 返回缓存的上游状态码，过期或不存在返回 0。
 */
function goneStatus(key) {
  const hit = gone.get(key)
  if (!hit) return 0
  if (Date.now() - hit.at > GONE_TTL_MS) {
    gone.delete(key)
    return 0
  }
  return hit.status
}

function prefetchSegment(session, name, entry) {
  if (!entry || entry.kind === 'key' || entry.kind === 'playlist') return
  if (prefetchQueued.has(name)) return
  const inflightKey = canonicalCacheUrl(entry.url)
  if (inflight.has(inflightKey)) return
  if (existsSync(cachePathOf(name))) return
  if (goneStatus(inflightKey)) return
  if (prefetchBudgetLeft() <= 0) return
  prefetchQueued.add(name)
  prefetchQueue.push({ session, name, entry })
  drainPrefetch()
}

/**
 * 从 name 往后预热 ahead 段（key / 变体清单跳过）。
 * 顺序直接按 segments 的插入顺序现算：旧实现依赖 session.order 的下标，
 * 而 order 在段落淘汰后不跟着裁剪，下标一错位就预取错段。
 */
function warmAhead(session, name, ahead = PREFETCH_AHEAD) {
  if (prefetchQueue.length >= UPSTREAM_QUEUE_LIMIT) return
  const order = [...session.segments.keys()]
  const start = order.indexOf(name)
  if (start < 0) return
  for (let i = 1; i <= ahead; i++) {
    const next = order[start + i]
    if (!next) break
    prefetchSegment(session, next, session.segments.get(next))
  }
}

/** 上游返回的错误页（CDN 签名过期页 / 维护页）不能进缓存，m3u8 与分片都按内容判 */
function assertPlaylistBody(text) {
  const head = String(text ?? '').trimStart().slice(0, 16)
  if (!head.toUpperCase().startsWith('#EXTM3U')) {
    const err = new Error('upstream returned non-m3u8 body')
    err.status = 502
    throw err
  }
}

async function pipeSegment(session, entry, name, req, res) {
  const cached = cachePathOf(name)
  const cacheable = entry.kind !== 'key'
  const rangeHeader = req.headers.range
  // 快照：refreshTicket 会把 entry 重绑到新 url，finally 里若读 entry.url 删的是新键，
  // 旧键留成永久占位（inflight 无界增长、旧 URL 去重彻底失效）
  const inflightKey = canonicalCacheUrl(entry.url)

  // 上游 404 的结论在 TTL 内直接复用：下架片不会被每个请求反复换票重试
  const known = cacheable ? goneStatus(inflightKey) : 0
  if (known) {
    sendText(res, 404, `404 上游已下架该片源（${known}）`, 'text/plain; charset=utf-8')
    return
  }

  if (entry.kind === 'key') {
    const hit = keyCache.get(entry.url)
    if (hit && hit.exp > Date.now()) {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(hit.body.length),
        'cache-control': 'private, max-age=300',
        'access-control-allow-origin': '*',
      })
      res.end(hit.body)
      return
    }
  }

  if (cacheable && existsSync(cached)) {
    touchCache(cached)
    warmAhead(session, name)
    return sendCached(res, cached, name, rangeHeader)
  }

  const pending = inflight.get(inflightKey)
  if (pending) await pending.catch(() => {})
  if (cacheable && existsSync(cached)) {
    touchCache(cached)
    warmAhead(session, name)
    return sendCached(res, cached, name, rangeHeader)
  }

  const headers = rangeHeader ? { range: rangeHeader } : {}
  const task = (async () => {
    let upstream
    try {
      upstream = await fetchUpstream(entry.url, session.source, headers)
    } catch (err) {
      // 现取票的源：票面过期表现为上游 403。静默换票并重建映射后重试一次，
      // 播放器看不到错误（分片名去 query 后稳定，重试仍能命中同一个 name）。
      if (!err.stale || !session.source.provider) throw err
      await refreshTicket(session)
      const next = session.segments.get(name)
      if (!next) throw err
      entry = next
      upstream = await fetchUpstream(entry.url, session.source, headers)
    }
    const length = Number(upstream.headers.get('content-length') ?? 0)
    if (length > MAX_SEGMENT_BYTES) {
      const err = new Error('segment too large')
      err.status = 502
      throw err
    }
    const upstreamType = upstream.headers.get('content-type') ?? ''
    if (!rangeHeader && /text\/html|application\/json/i.test(upstreamType)) {
      const err = new Error('upstream returned html instead of segment')
      err.status = 502
      throw err
    }
    const passHeaders = {
      'content-type': upstreamType || contentTypeOf(name),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
      'access-control-allow-origin': '*',
    }
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) passHeaders['content-range'] = contentRange
    if (length) passHeaders['content-length'] = String(length)
    res.writeHead(upstream.status === 206 ? 206 : 200, passHeaders)
    if (!upstream.body) {
      res.end()
      return
    }
    const body = Readable.fromWeb(upstream.body)
    // 上游半包/断流会让 body 抛 error：没有监听就是 uncaughtException，整个进程退出
    body.on('error', (error) => {
      logWarn('media.remote_upstream_aborted', { name, message: error?.message ?? 'unknown' })
      try { res.destroy() } catch { /* 已经断开 */ }
    })
    if (!cacheable) {
      // 密钥虽有固定体积但不落盘：轮换后旧 key 不能复用。内存里放 5 分钟足够一次播放。
      const chunks = []
      await new Promise((resolve) => {
        body.on('data', (chunk) => chunks.push(chunk))
        body.on('error', () => resolve())
        body.on('end', resolve)
      })
      const buf = Buffer.concat(chunks)
      if (buf.length > 0 && buf.length <= 4096) {
        if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value)
        keyCache.set(entry.url, { body: buf, exp: Date.now() + KEY_CACHE_TTL_MS })
      }
      res.end(buf)
      return
    }
    if (rangeHeader) {
      // Range 请求是局部区间，回写磁盘没有意义
      await new Promise((resolve) => {
        body.on('error', () => resolve())
        res.on('close', resolve)
        res.on('finish', resolve)
        body.pipe(res)
      })
      return
    }
    ensureDir(join(CACHE_DIR, name.slice(0, 2)))
    const tmp = `${cached}.${process.pid}.part`
    const sink = createWriteStream(tmp)
    let written = 0
    body.on('data', (chunk) => {
      written += chunk.length
      if (written > MAX_SEGMENT_BYTES) body.destroy(new Error('segment overflow'))
    })
    const done = new Promise((resolve) => {
      let left = 2
      const tick = () => {
        if (--left === 0) resolve()
      }
      sink.on('close', tick)
      res.on('close', tick)
      sink.on('error', () => {
        res.destroy()
        tick()
      })
    })
    // 兜底：上游既不结束也不断（半包），done 不能永久挂住，否则 task 永不 settle、
    // inflight 条目永久占位、播放器侧 3s 超时无限重试
    const stalled = new Promise((resolve) => {
      AbortSignal.timeout(STREAM_MAX_MS).addEventListener('abort', () => {
        body.destroy(new Error('segment stream timeout'))
        resolve()
      }, { once: true })
    })
    body.pipe(sink)
    body.pipe(res)
    await Promise.race([done, stalled])
    const writtenSize = existsSync(tmp) ? statSync(tmp).size : 0
    const complete = writtenSize > 0 && !sink.writableErrored
    // 长度与 content-length 不一致 = 半包/错误页：宁可丢缓存也不要把坏数据留成"永久命中"
    if (complete && (!length || writtenSize === length)) {
      renameSync(tmp, cached)
      sweepRemoteCache()
    } else {
      rmSync(tmp, { force: true })
      const err = new Error(length
        ? `segment length mismatch (${writtenSize}/${length})`
        : 'segment stream interrupted')
      err.status = 504
      throw err
    }
    warmAhead(session, name)
  })()

  inflight.set(inflightKey, task)
  try {
    await task
  } finally {
    inflight.delete(inflightKey)
  }
}

/**
 * 直链文件源：整文件透传（Range 由播放器发起、上游支持 206），不落盘缓存
 * —— 单片动辄几百 MB，缓存既占盘又没必要，起播的第一跳反而更快。
 */
async function pipeDirectFile(req, res, session) {
  const range = req.headers.range ? { range: String(req.headers.range) } : {}
  const upstream = await fetchUpstream(session.source.pageUrl, session.source, range)
  const headers = {
    'content-type': upstream.headers.get('content-type') || 'video/mp4',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'access-control-allow-origin': '*',
  }
  const length = upstream.headers.get('content-length')
  if (length) headers['content-length'] = length
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers['content-range'] = contentRange
  res.writeHead(contentRange ? 206 : 200, headers)
  if (req.method === 'HEAD' || !upstream.body) {
    res.end()
    return
  }
  const body = Readable.fromWeb(upstream.body)
  // 播放器拖动进度条会反复中断请求：上游流要跟着销毁，别把跨境连接晾在那儿
  req.on('close', () => body.destroy())
  body.on('error', () => { try { res.destroy() } catch { /* 已经断开 */ } })
  body.pipe(res)
}

/** 清单请求带了 sec（公网接口给试看签的秒数）时，只给前 N 秒，并记下白名单 */
function applyTrialWindow(session, text, seconds) {
  if (!(seconds > 0)) return text
  const cut = truncatePlaylist(text, { seconds })
  session.trialSeconds = seconds
  session.trialAllowed = new Set([...cut.allowed].map((uri) => normalizePlaylistUri(uri).replace(/^seg\//, '')))
  logInfo('media.remote_trial_manifest', { episodeId: session.episodeId, seconds, kept: session.trialAllowed.size })
  return cut.text
}

/**
 * 处理一次 /media/remote/<id>/... 请求。
 * 调用方（index.mjs）已完成签名校验，这里只管取流。
 */
export async function handleRemoteRequest(req, res, { episodeId, episode, rest }) {
  const source = remoteSourceOf(episode)
  if (!source) {
    sendText(res, 404, '404 该集未配置外部片源', 'text/plain; charset=utf-8')
    return
  }
  const session = getSession(episodeId, source)
  // 滑动续期：一部片能播三个小时，固定 30 分钟 TTL 会让播到一半的会话先过期
  session.expiresAt = Date.now() + (source.provider ? HG_SESSION_TTL_MS : SESSION_TTL_MS)
  const tail = String(rest ?? '')
  let seconds = 0
  try {
    const rawSeconds = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('sec')
    seconds = Number(rawSeconds ?? 0) || 0
  } catch {
    seconds = 0
  }

  try {
    if (/^file\.[a-z0-9]{2,5}$/.test(tail)) {
      await pipeDirectFile(req, res, session)
      return
    }
    if (!tail || tail === 'index.m3u8') {
      const text = await loadEntryPlaylist(session)
      // 播放器拿到清单到真正点播放之间有几秒空档：先把开头几段拉到缓存，起播不再等跨境回源
      const first = session.order.find((name) => session.segments.get(name)?.kind === 'segment')
      if (first) warmAhead(session, first, WARM_ON_MANIFEST)
      return sendText(res, 200, applyTrialWindow(session, text, seconds))
    }
    // 变体清单的子 URI 形如 seg/<name>/<file>，多斜杠必须放行（旧正则 [^/]+ 会让多码率源全 404）
    const match = /^seg\/(.+)$/.exec(tail)
    if (!match) {
      sendText(res, 404, '404', 'text/plain; charset=utf-8')
      return
    }
    const name = normalizePlaylistUri(match[1])
    if (!name || name.includes('..') || name.startsWith('/')) {
      sendText(res, 404, '404', 'text/plain; charset=utf-8')
      return
    }
    let entry = session.segments.get(name)
    if (!entry || entry.exp < Date.now()) {
      // 服务重启、会话过期、或播放器手里是上一份清单：重新解析一次把索引补回来，
      // 不能让长片播到一半因为内存映射丢了就整段 410
      session.manifestUrl = null
      session.segments.clear()
      session.order = []
      session.index.clear()
      await loadEntryPlaylist(session)
      entry = session.segments.get(name)
      if (!entry || entry.exp < Date.now()) {
        sendText(res, 410, '410 分片索引已过期，请重新加载播放列表', 'text/plain; charset=utf-8')
        return
      }
    }
    // 试看窗口：只认清单里真实存在的前 N 秒分片，其余一律 403
    if (session.trialSeconds > 0 && session.trialAllowed && !session.trialAllowed.has(name)) {
      sendText(res, 403, '403 试看已结束，购买后可看完整剧集', 'text/plain; charset=utf-8')
      return
    }
    if (entry.kind === 'playlist') {
      // 变体清单（多码率 / 多音轨）：以 <name>/ 为前缀重写，里面的分片继续由本网关转发
      const text = await loadPlaylistAt(entry.url, session, `${name}/`)
      return sendText(res, 200, applyTrialWindow(session, text, seconds))
    }
    await pipeSegment(session, entry, name, req, res)
  } catch (err) {
    if (err.stale) {
      // 票过期是临时状态：丢掉这份会话（下次会按库里的新直链重建），
      // 回 503 + Retry-After，hls.js 会自带重试；比 502 更像"稍后再来"而不是"坏了"
      sessions.delete(Number(episodeId))
      logWarn('media.remote_source_stale', { episodeId: Number(episodeId), status: err.upstreamStatus ?? 0, message: err.message })
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'retry-after': '30',
      })
      res.end('503 片源签名已过期，正在自动续期，请 30 秒后重试')
      return
    }
    if (err.gone) {
      // 404/410 是"没了"，不是"票过期"：短时缓存这个结论，别每来一个请求就换票重试
      const key = err.url ? canonicalCacheUrl(err.url) : `episode:${Number(episodeId)}`
      gone.set(key, { status: err.upstreamStatus ?? 404, at: Date.now() })
      while (gone.size > MAX_GONE) gone.delete(gone.keys().next().value)
      logWarn('media.remote_upstream_gone', { episodeId: Number(episodeId), status: err.upstreamStatus ?? 0, message: err.message })
      sendText(res, 404, `404 上游已下架该片源（${err.upstreamStatus ?? 404}）`, 'text/plain; charset=utf-8')
      return
    }
    const status = err.status ?? 504
    if (res.headersSent) {
      // 已经开始吐流了：状态码改不了，直接把连接断掉让播放器重试
      try { res.destroy() } catch { /* 已经断开 */ }
      logWarn('media.remote_stream_aborted', { episodeId: Number(episodeId), status, message: err.message })
      return
    }
    if (status >= 500) {
      logError('media.remote_upstream_failed', { episodeId: Number(episodeId), status, message: err.message, stack: err.stack })
    } else {
      logWarn('media.remote_upstream_failed', { episodeId: Number(episodeId), status, message: err.message })
    }
    sendText(res, status, `${status} 上游片源不可用：${err.message}`, 'text/plain; charset=utf-8')
  }
}

/** 播放接口用它决定入口：外部源优先，其次本地 HLS；直链文件源给 file.<ext> */
export function remotePlaybackPath(episode) {
  const source = remoteSourceOf(episode)
  if (!source) return null
  const ext = DIRECT_FILE_RE.exec(source.pageUrl)?.[1]
  if (ext) return `/media/remote/${episode.id}/file.${ext.toLowerCase()}`
  return `/media/remote/${episode.id}/index.m3u8`
}

export function remoteCacheStats() {
  ensureDir(CACHE_DIR)
  let bytes = 0
  let files = 0
  const walk = (dir) => {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else {
        bytes += st.size
        files += 1
      }
    }
  }
  walk(CACHE_DIR)
  return { dir: CACHE_DIR, files, bytes, sessions: sessions.size, gone: gone.size }
}

// 启动扫一次：上次进程留下的过期缓存不该等到第一次播放才清
try {
  sweepRemoteCache({ force: true })
} catch (error) {
  logWarn('media.remote_cache.sweep_failed', { message: error?.message ?? 'unknown' })
}
