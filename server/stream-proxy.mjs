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
 */
import { createHash } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { HG_BASE, huangguoPlayback, isHuangguoRef, parseHuangguoRef } from './huangguo.mjs'

const CACHE_DIR = process.env.MH_REMOTE_CACHE || fileURLToPath(new URL('../storage/remote-cache/', import.meta.url))
const SESSION_TTL_MS = 30 * 60 * 1000
/** 现取票的源（huangguo 等）票面有效期短，会话跟着缩短 */
const HG_SESSION_TTL_MS = Number(process.env.MH_HG_SESSION_TTL_MS ?? 3 * 60 * 1000)
const MAX_SEGMENTS_PER_SESSION = 20000
const MAX_SEGMENT_BYTES = 96 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = Number(process.env.MH_REMOTE_TIMEOUT_MS ?? 15000)
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** episodeId -> session；进程内表，重启后播放器重拉 index.m3u8 即可自愈 */
const sessions = new Map()
/** segmentUrl -> 正在下载的 Promise，避免同一分片并发穿透上游 */
const inflight = new Map()

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
  // 播放接口签发的一次性 CDN 凭证（x-cdn-auth / x-cdn-app 等），由 provider 现取现填
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

async function fetchUpstream(url, source, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { ...headerBag(source), ...extraHeaders },
    redirect: 'follow',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!res.ok && res.status !== 206) {
    // 403/401/410 是"票过期或没带对凭证"，跟网络故障分开报，运维才知道要刷新片源
    const rejected = res.status === 403 || res.status === 401 || res.status === 410
    const err = new Error(rejected
      ? `source rejected (${res.status}) 直链签名过期或凭证失效，跑 scripts/jable-import.mjs --refresh 换新链接`
      : `upstream ${res.status} ${url}`)
    err.status = rejected ? 502 : 504
    // 标记成「临时性」：调用方据此丢掉缓存会话并回 Retry-After，让播放器等续期而不是判死
    err.stale = rejected
    throw err
  }
  return res
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
    Object.assign(source.extraHeaders, play.headers)
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
 * 分片在本站的名字。
 * 现取票的源（provider）用「去掉 query 的地址」算摘要：票刷新后上游地址会变、路径不变，
 * 名字稳定才能让正在播的播放器在服务端换票后继续命中同一段。
 */
function segmentName(url, session) {
  const key = session?.source?.provider ? String(url).split('?')[0] : url
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
  const name = segmentName(abs, session)
  if (!session.segments.has(name)) {
    session.index.set(name, session.order.length)
    session.order.push(name)
  }
  session.segments.set(name, { url: abs, kind, exp: Date.now() + SESSION_TTL_MS })
  while (session.segments.size > MAX_SEGMENTS_PER_SESSION) {
    const oldest = session.segments.keys().next().value
    session.segments.delete(oldest)
    session.index.delete(oldest)
  }
  return `${prefix}seg/${name}`
}

function rewriteAttrUri(line, baseUrl, session, prefix) {
  // 密钥文件随会话轮换，不能落盘缓存；init 段（EXT-X-MAP）与普通分片同策略
  const kind = /^#EXT-X-(KEY|SESSION-KEY)/i.test(line) ? 'key' : 'segment'
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
  return rewritePlaylist(text, res.url || url, session, prefix)
}

async function loadEntryPlaylist(session) {
  const url = await manifestOf(session)
  return loadPlaylistAt(url, session, '')
}

function sendText(res, status, body, contentType = 'application/vnd.apple.mpegurl', cache = 'no-store') {  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': cache,
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!m) return null
  const start = m[1] ? Number(m[1]) : 0
  const end = m[2] ? Number(m[2]) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

function contentTypeOf(name) {
  if (name.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl'
  if (name.endsWith('.ts')) return 'video/mp2t'
  if (name.endsWith('.m4s') || name.endsWith('.mp4')) return 'video/mp4'
  if (name.endsWith('.aac')) return 'audio/aac'
  if (name.endsWith('.vtt')) return 'text/vtt'
  return 'application/octet-stream'
}

function sendCached(res, file, name, rangeHeader) {
  const size = statSync(file).size
  const range = parseRange(rangeHeader, size)
  const headers = {
    'content-type': contentTypeOf(name),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
    'access-control-allow-origin': '*',
  }
  if (range) {
    headers['content-range'] = `bytes ${range.start}-${range.end}/${size}`
    headers['content-length'] = String(range.end - range.start + 1)
    res.writeHead(206, headers)
    createReadStream(file, { start: range.start, end: range.end }).pipe(res)
    return
  }
  headers['content-length'] = String(size)
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
}

// 上游是跨境 CDN：一段 850KB–1.4MB 实测要 1.8–2.1 秒，而这一段只播 4 秒。
// 只靠「播放器要哪段就去回源哪段」是踩在临界线上——并发多一点点、链路抖一下，
// 缓冲就被吃光，播放器几秒后停住（fatal fragLoadError/bufferStall）。
// 所以服务端把后面几段提前拉进磁盘缓存：播放器来要时多数直接命中，抖动被摊平。
const PREFETCH_AHEAD = Number(process.env.MH_REMOTE_PREFETCH ?? 10)
const PREFETCH_CONCURRENCY = Number(process.env.MH_REMOTE_PREFETCH_CONCURRENCY ?? 3)
const WARM_ON_MANIFEST = Number(process.env.MH_REMOTE_WARM ?? 16)

const prefetchQueue = []
const prefetchQueued = new Set()
let prefetchActive = 0

async function runPrefetch(session, name, entry) {
  const cached = cachePathOf(name)
  if (existsSync(cached)) return
  const tmp = `${cached}.${process.pid}.pre.part`
  const task = (async () => {
    const upstream = await fetchUpstream(entry.url, session.source)
    if (!upstream.ok || !upstream.body) throw new Error(`prefetch ${upstream.status}`)
    const length = Number(upstream.headers.get('content-length') ?? 0)
    if (length > MAX_SEGMENT_BYTES) throw new Error('prefetch too large')
    ensureDir(join(CACHE_DIR, name.slice(0, 2)))
    await pipeline(Readable.fromWeb(upstream.body), createWriteStream(tmp))
    renameSync(tmp, cached)
  })()
  // 登记到 inflight：真身请求碰上同一段时会等它落盘，然后直接命中缓存，不会重复回源
  inflight.set(entry.url, task)
  try {
    await task
  } catch {
    rmSync(tmp, { force: true })
  } finally {
    inflight.delete(entry.url)
  }
}

function drainPrefetch() {
  while (prefetchActive < PREFETCH_CONCURRENCY && prefetchQueue.length) {
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

function prefetchSegment(session, name, entry) {
  if (!entry || entry.kind === 'key' || entry.kind === 'playlist') return
  if (prefetchQueued.has(name)) return
  if (inflight.has(entry.url)) return
  if (existsSync(cachePathOf(name))) return
  prefetchQueued.add(name)
  prefetchQueue.push({ session, name, entry })
  drainPrefetch()
}

/** 从 name 往后预热 ahead 段（key / 变体清单跳过） */
function warmAhead(session, name, ahead = PREFETCH_AHEAD) {
  if (prefetchQueue.length >= 40) return
  const start = session.index.get(name)
  if (start === undefined) return
  for (let i = 1; i <= ahead; i++) {
    const next = session.order[start + i]
    if (!next) break
    prefetchSegment(session, next, session.segments.get(next))
  }
}

async function pipeSegment(session, entry, name, req, res) {
  const cached = cachePathOf(name)
  const cacheable = entry.kind !== 'key'
  const rangeHeader = req.headers.range

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
    warmAhead(session, name)
    return sendCached(res, cached, name, rangeHeader)
  }

  const pending = inflight.get(entry.url)
  if (pending) await pending.catch(() => {})
  if (cacheable && existsSync(cached)) {
    warmAhead(session, name)
    return sendCached(res, cached, name, rangeHeader)
  }

  const headers = rangeHeader ? { range: rangeHeader } : {}
  const task = (async () => {
    let upstream
    try {
      upstream = await fetchUpstream(entry.url, session.source, headers)
    } catch (err) {
      // 现取票的源：票面过期表现为上游 403/410。静默换票并重建映射后重试一次，
      // 播放器看不到错误（分片名去 query 后稳定，重试仍能命中同一个 name）。
      if (err.status !== 502 || !session.source.provider) throw err
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
    const passHeaders = {
      'content-type': upstream.headers.get('content-type') ?? contentTypeOf(name),
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
    body.pipe(sink)
    body.pipe(res)
    await done
    if (existsSync(tmp) && statSync(tmp).size > 0 && !sink.writableErrored) renameSync(tmp, cached)
    else rmSync(tmp, { force: true })
    warmAhead(session, name)
  })()

  inflight.set(entry.url, task)
  try {
    await task
  } finally {
    inflight.delete(entry.url)
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
  body.on('error', () => { try { res.destroy() } catch {} })
  body.pipe(res)
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
      return sendText(res, 200, text)
    }
    const match = /^seg\/([^/]+)$/.exec(tail)
    if (!match) {
      sendText(res, 404, '404', 'text/plain; charset=utf-8')
      return
    }
    const name = match[1]
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
    if (entry.kind === 'playlist') {
      // 变体清单（多码率 / 多音轨）：以 seg/<name>/ 为前缀重写，里面的分片继续由本网关转发
      sendText(res, 200, await loadPlaylistAt(entry.url, session, `seg/${name}/`))
      return
    }
    await pipeSegment(session, entry, name, req, res)
  } catch (err) {
    if (err.stale) {
      // 票过期是临时状态：丢掉这份会话（下次会按库里的新直链重建），
      // 回 503 + Retry-After，hls.js 会自带重试；比 502 更像"稍后再来"而不是"坏了"
      sessions.delete(Number(episodeId))
      res.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
        'retry-after': '30',
      })
      res.end('503 片源签名已过期，正在自动续期，请 30 秒后重试')
      return
    }
    const status = err.status ?? 504
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
  return { dir: CACHE_DIR, files, bytes, sessions: sessions.size }
}
