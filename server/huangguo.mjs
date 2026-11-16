import { createECDH, createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto'

/**
 * 黄果短剧（huangguoai.com）片源适配。
 *
 * 站点把业务接口整体放在「加密通道」后面：客户端 ECDH(P-256) 握手，
 * HKDF-SHA256 派生请求/响应两把 AES-256-GCM 密钥，之后每个 /api/* 调用
 * 都是 {method,path,body} 的密文包。播放地址必须现取（带 auth_key 的 CDN 票），
 * 所以这里做两件事：
 *   1. 复刻握手与加解密，使本站能直接调 /api/videos/:id/episodes/:ep/playback
 *   2. 解析详情页内嵌的 videoInitialData，拿到剧名/封面/简介/集数
 * 播放时拿到的清单还需要 x-cdn-auth / x-cdn-app 两个头才能被 CDN 放行。
 */

export const HG_BASE = (process.env.MH_HG_BASE || 'https://huangguoai.com').replace(/\/+$/, '')
export const HG_PROTOCOL = 'dx150-edge-v1'
const HG_ENDPOINTS = {
  user: '/api/user/request',
  playback: '/api/playback/request',
  public: '/api/public/request',
  dynamic: '/api/dynamic/request',
}
const HG_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PLAY_TTL_MS = Number(process.env.MH_HG_TTL_MS ?? 90 * 1000)

/** 站点引用写法：huangguo://<videoId>/<ep>，存进 episodes.remote_url */
export function hgRefOf(videoId, ep) {
  return `huangguo://${Number(videoId)}/${Number(ep)}`
}

/**
 * 图片同样是加密的：crypto-image-protocol.js 里公开一对 AES-128-CBC / NoPadding 凭据，
 * 密文裸存 16 字节对齐，解密后才是真 JPEG/PNG（短剧封面是 3:4 竖版）。
 */
export const HG_IMAGE_KEY = 'f5d965df75336270'
export const HG_IMAGE_IV = '97b60394abc2fbe1'

const IMAGE_MAGIC = [
  [0xff, 0xd8, 0xff], // JPEG
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x52, 0x49, 0x46, 0x46], // RIFF(WebP)
]

export function isImageBuffer(buf) {
  if (!buf || buf.length < 4) return false
  return IMAGE_MAGIC.some((magic) => magic.every((byte, i) => buf[i] === byte))
}

/** 解密站点的加密图；已明文或长度不对齐时原样返回 */
export function decryptHuangguoImage(buf) {
  if (isImageBuffer(buf) || !buf?.length || buf.length % 16 !== 0) return buf
  const decipher = createDecipheriv('aes-128-cbc', Buffer.from(HG_IMAGE_KEY, 'utf8'), Buffer.from(HG_IMAGE_IV, 'utf8'))
  decipher.setAutoPadding(false)
  const plain = Buffer.concat([decipher.update(buf), decipher.final()])
  return isImageBuffer(plain) ? plain : buf
}

export function isHuangguoRef(value) {
  return /^huangguo:\/\//i.test(String(value ?? '').trim())
}

export function parseHuangguoRef(value) {
  const m = /^huangguo:\/\/(\d+)\/(\d+)/i.exec(String(value ?? '').trim())
  return m ? { videoId: Number(m[1]), ep: Number(m[2]) } : null
}

function aadOf(info, direction, seq, ts) {
  return Buffer.from([info, direction, seq, ts].join('\n'), 'utf8')
}

function nonceOf(seq) {
  const iv = Buffer.alloc(12)
  iv.writeUInt32BE(seq >>> 0, 8)
  return iv
}

function gcmEncrypt(key, iv, aad, plain) {
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

function gcmDecrypt(key, iv, aad, buf) {
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(0, buf.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

const sessions = new Map()

async function postEnc(scope, body) {
  const res = await fetch(HG_BASE + HG_ENDPOINTS[scope], {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': HG_UA,
      referer: HG_BASE + '/',
      origin: HG_BASE,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  return { ok: res.ok, status: res.status, text: await res.text() }
}

async function openSession(scope) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const helloRes = await postEnc(scope, {
    v: 1,
    type: 'hello',
    client_pub: ecdh.getPublicKey().toString('base64url'),
  })
  if (!helloRes.ok) {
    const err = new Error(`huangguo hello failed (${helloRes.status})`)
    err.status = 502
    throw err
  }
  const hello = JSON.parse(helloRes.text)
  const shared = ecdh.computeSecret(Buffer.from(hello.server_pub, 'base64url'))
  const salt = Buffer.from(hello.salt, 'base64url')
  const info = [HG_PROTOCOL, scope, hello.site, hello.kid, hello.sid].join('\n')
  const derive = (direction) =>
    Buffer.from(hkdfSync('sha256', shared, salt, Buffer.from(`${info}\n${direction}`, 'utf8'), 32))
  const localTime = Math.floor(Date.now() / 1000)
  const session = {
    scope,
    info,
    kid: hello.kid,
    sid: hello.sid,
    clockOffset: hello.server_time - localTime,
    expiresAt: localTime + hello.expires_at - hello.server_time,
    sequence: 0,
    requestKey: derive('req'),
    responseKey: derive('res'),
  }
  sessions.set(scope, session)
  return session
}

async function sessionOf(scope) {
  const existing = sessions.get(scope)
  const now = Math.floor(Date.now() / 1000)
  if (existing && existing.expiresAt > now + 5 && existing.sequence < 16384) return existing
  return openSession(scope)
}

/** 以业务 HTTP 语义调用被加密的接口；返回 {status, json} */
export async function huangguoApi(method, path, body, { scope = 'dynamic' } = {}) {
  const session = await sessionOf(scope)
  const seq = ++session.sequence
  const ts = Math.floor(Date.now() / 1000) + session.clockOffset
  const iv = nonceOf(seq)
  const raw = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const packet = {
    request: {
      method: String(method).toUpperCase(),
      path,
      body: raw ? Buffer.from(raw, 'utf8').toString('base64') : '',
      content_type: raw ? 'application/json' : '',
    },
  }
  const ciphertext = gcmEncrypt(
    session.requestKey,
    iv,
    aadOf(session.info, 'req', seq, ts),
    Buffer.from(JSON.stringify(packet), 'utf8'),
  ).toString('base64url')
  const res = await postEnc(scope, {
    v: 1,
    type: 'call',
    kid: session.kid,
    sid: session.sid,
    seq,
    ts,
    ciphertext,
  })
  if (!res.ok) {
    sessions.delete(scope)
    const err = new Error(`huangguo call failed (${res.status})`)
    err.status = 502
    throw err
  }
  const result = JSON.parse(res.text)
  if (result.sid !== session.sid || result.seq !== seq) {
    const err = new Error('huangguo response mismatch')
    err.status = 502
    throw err
  }
  const plain = gcmDecrypt(
    session.responseKey,
    iv,
    aadOf(session.info, 'res', seq, ts),
    Buffer.from(result.ciphertext, 'base64url'),
  )
  const inner = JSON.parse(plain.toString('utf8'))
  let json = null
  if (inner.body) {
    try {
      json = JSON.parse(Buffer.from(inner.body, 'base64').toString('utf8'))
    } catch {
      json = null
    }
  }
  return { status: inner.status, json }
}

const playCache = new Map()

/** 取某集的可播放清单地址与所需 CDN 头；结果短时缓存，过期由超时重取兜底 */
export async function huangguoPlayback(videoId, ep, { force = false } = {}) {
  const id = Number(videoId)
  const no = Number(ep) || 1
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('invalid huangguo video id')
    err.status = 502
    throw err
  }
  const key = `${id}:${no}`
  const hit = playCache.get(key)
  if (!force && hit && hit.expiresAt > Date.now()) return hit.value
  const res = await huangguoApi('POST', `/api/videos/${id}/episodes/${no}/playback`, {}, { scope: 'playback' })
  const data = res.json?.data
  const url = data?.streams?.main
  if (res.status !== 200 || !url) {
    const err = new Error(`huangguo playback unavailable (${res.status})`)
    err.status = 502
    throw err
  }
  const cdn = data.cdn || {}
  const headers = {}
  if (cdn.authKey && cdn.authValue) headers[cdn.authKey] = cdn.authValue
  if (cdn.app) headers['x-cdn-app'] = String(cdn.app)
  const value = { url, headers, cdn, timestamp: data.timestamp }
  playCache.set(key, { value, expiresAt: Date.now() + PLAY_TTL_MS })
  if (playCache.size > 512) playCache.delete(playCache.keys().next().value)
  return value
}

export function clearHuangguoCache() {
  playCache.clear()
  sessions.clear()
}

/** 详情页里 <script id="videoInitialData"> 的 JSON */
function initialDataOf(html) {
  const m = /<script[^>]*id="videoInitialData"[^>]*>([\s\S]*?)<\/script>/i.exec(String(html || ''))
  if (!m) return null
  try {
    return JSON.parse(m[1].trim())
  } catch {
    return null
  }
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 详情页 → 剧集元数据；解析不到 id 返回 null */
export function parseHuangguoPage(html, pageUrl = '') {
  const data = initialDataOf(html)
  if (!data || !data.id) return null
  const tracking = data.tracking || {}
  const episodes = data.trackingEpisodes && typeof data.trackingEpisodes === 'object' ? data.trackingEpisodes : {}
  const epNos = Object.keys(episodes)
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b)
  const total = Number(tracking.total_episode) || epNos.length || 1
  const finalNos = epNos.length ? epNos : Array.from({ length: total }, (_, i) => i + 1)
  const cover = textOf(data.coverSrc) || textOf(data.posterSrc)
  const tags = Array.isArray(data.tags) ? data.tags.map(textOf).filter(Boolean) : []
  const durationOfEp = {}
  for (const no of finalNos) durationOfEp[no] = Number(episodes[no]?.drama_duration) || 0
  return {
    videoId: Number(data.id),
    pageUrl: pageUrl || `${HG_BASE}/video/${data.id}/`,
    title: textOf(data.title),
    description: textOf(data.description),
    cover,
    poster: textOf(data.posterSrc) || cover,
    tags,
    tagLinks: Array.isArray(data.tagLinks) ? data.tagLinks.map((t) => ({ name: textOf(t.name), url: textOf(t.url) })) : [],
    author: textOf(data.author),
    authorId: textOf(data.authorId),
    views: textOf(data.views),
    viewsNum: parseCount(data.views),
    likes: textOf(data.likes),
    collects: textOf(data.collects),
    score: scoreOf({ views: data.views, likes: data.likes, collects: data.collects }),
    publishedAt: textOf(data.time),
    totalEpisodes: total,
    episodeNos: finalNos,
    episodeDurations: durationOfEp,
    cdnApp: textOf(data.cdnApp),
    cdnAuthKey: textOf(data.cdnAuthKey),
    cdnAuthValue: textOf(data.cdnAuthValue),
    typeName: textOf(tracking.drama_type_name),
    typeId: textOf(tracking.drama_type_id),
  }
}

/**
 * 中文计数转数字：`10.1w` → 101000、`3.8k` → 3800、`246.7万` → 2467000。
 * 解析不了返回 0，调用方按「无数据」处理。
 */
export function parseCount(text) {
  const raw = String(text ?? '').trim().toLowerCase().replace(/,/g, '')
  if (!raw) return 0
  const num = Number.parseFloat(raw)
  if (!Number.isFinite(num) || num < 0) return 0
  if (/w$|万$/.test(raw)) return Math.round(num * 10000)
  if (/k$|千$/.test(raw)) return Math.round(num * 1000)
  if (/m$/.test(raw)) return Math.round(num * 1000000)
  if (/亿$/.test(raw)) return Math.round(num * 100000000)
  return Math.round(num)
}

/**
 * 评分由源站真实热度推导，不做人工编造：
 * 播放量（对数，封顶 3 分）+ 收藏率（封顶 2 分）+ 点赞率（封顶 2 分），落在 6.0–9.6。
 * 没有播放数据时返回 null，保留「未评分」而不是编一个数。
 */
export function scoreOf({ views, likes, collects } = {}) {
  const play = parseCount(views)
  if (play <= 0) return null
  const reach = Math.max(0, Math.min(3, (Math.log10(play + 1) - 3) * 0.75))
  const save = Math.max(0, Math.min(2, (parseCount(collects) / play) * 20))
  const like = Math.max(0, Math.min(2, (parseCount(likes) / play) * 300))
  return Math.round(Math.max(6, Math.min(9.6, 5.2 + reach + save + like)) * 10) / 10
}

/** 列表页 → videoId 列表（去重保序） */
export function parseHuangguoList(html) {
  const out = []
  const seen = new Set()
  for (const m of String(html || '').matchAll(/href="\/video\/(\d+)\/"/g)) {
    const id = Number(m[1])
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

/** 抓详情页 HTML（站内页面，无 Cloudflare 挑战） */
export async function fetchHuangguoPage(pathOrUrl) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : HG_BASE + pathOrUrl
  const res = await fetch(url, {
    headers: { 'user-agent': HG_UA, referer: HG_BASE + '/', accept: 'text/html,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    const err = new Error(`huangguo page ${res.status} ${url}`)
    err.status = res.status === 404 ? 404 : 502
    throw err
  }
  return res.text()
}
