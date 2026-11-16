/** C 端接口：内容、权益判定、播放令牌、套餐下单、支付回调、我的。 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { db, getSetting, ROOT } from './db.mjs'
import * as dbModule from './db.mjs'
import { adultMenuSettings } from './adult-menu.mjs'
import { adultVisibilitySql } from './content-visibility.mjs'
import { adultStatsFor } from './adult-stats.mjs'
import {
  authOf, changeUserEmail, checkPasswordStrength, issueToken, loginByEmail, publicUser, revokeSessions, revokeToken, setUserPassword,
  updateProfile, verifyPasswordAsync,
} from './auth.mjs'
import { OtpError, normalizeEmail, otpTestHookEnabled, sendCode, verifyCode } from './otp.mjs'
import {
  LINK_TTL, decideEpisodes, entitlementsOf, freeEpisodesOf, policyOf, priceInfo, resolveAccess, rulesOfDrama, secureLink,
  secureLinkScoped, signPayTicket, verifyPayTicket,
} from './entitlements.mjs'
import { publicTracksOf, saveUserTrackPreference, userTrackPreferences } from './tracks.mjs'
import { escapeLike } from './sql-like.mjs'
import { remotePlaybackPath } from './stream-proxy.mjs'
import { ensureFreshForPlay, staleOf } from './jable-refresh.mjs'
import { isClientTrackType, recordEvent, recordPlay } from './analytics.mjs'
import { bindUserAcquisition, recordTouch } from './attribution.mjs'
import {
  applyDistributor, bindReferral, createWithdrawalRequest, detectCurrency, distributionSummary,
  getOrCreateReferralCode, listCurrencies, listWithdrawals, payoutOptions, recordInviteClick,
} from './distribution.mjs'
import {
  CONTENT_RANK_TYPES, applyHeartbeat, contentRank, recordClick, startViewSession, toggleFavorite,
} from './content-stats.mjs'
import { clearLoginFailures, clientIpOf, loginLockSeconds, noteLoginFailure } from './ratelimit.mjs'
import { logError, logWarn } from './logger.mjs'
import { listTags, tagsOfDrama } from './tags.mjs'
import { previewUrlForCover } from './previews.mjs'
import { posterWallPayload } from './poster-wall.mjs'
import { enumLabel, langFromRequest, localizedYearLabel, normalizeLang } from './i18n.mjs'
import {
  CommerceError, createOrder, handleAlipayNotify, listOrders, markPaid, mockPay, orderDto, paymentOptions, validateCoupon,
  buildSimulatedAlipayNotify, syncAlipayOrder, payUrlFor,
} from './commerce.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

/** 单次播放链接的最长有效期：覆盖整集时长，默认 2 小时（可用 MH_PLAY_TTL_MAX 调整）。 */
const PLAY_TTL_MAX = Math.max(LINK_TTL, Math.min(4 * 3600, Number(process.env.MH_PLAY_TTL_MAX ?? 7200) || 7200))

/**
 * 播放接口愿意为「续期过期直链」等多久。
 * 超过这个时间就先返回 409 让前端提示重试——比让用户盯着转圈 2 分钟要好。
 */
const PLAY_REFRESH_WAIT_MS = Math.max(0, Number(process.env.MH_PLAY_REFRESH_WAIT_MS ?? 8000) || 8000)

/* ---------- 通用取值、本地签名与门禁（访客标识 / 成人凭证 / 试看台账） ---------- */

/**
 * 进 SQL 的数值参数一律过这里：Number('') / Number(null) / 非数字直进 SQL 会变成缺陷
 * （`LIMIT NULL` 在 SQLite 里等价于不限），白名单夹取后才是确定的整数。
 */
function intOf(value, def = 0, min = 0, max = Number.MAX_SAFE_INTEGER) {
  // 注意 Number(null) === 0：缺省/空值必须先归 def，否则 pageSize 这类带下限的参数会被夹成 1
  if (value === null || value === undefined || value === '') return def
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 冷却/重试秒数口径：夹在 [4, 15]，与 docs/REMOTE-SOURCE.md 的前端倒计时一致。 */
const retrySecondsOf = (value, fallback = 5) => intOf(value || fallback, fallback, 4, 15)

const VISITOR_COOKIE = 'mh_visitor'
const VISITOR_MAX_AGE = 2592000
const ADULT_COOKIE = 'mh_adult'
const ADULT_MAX_AGE = 2592000
const COOKIE_MAX = 512

let localSecretCache
/** 本地 HMAC 密钥：优先 MH_SECRET，其次站点设置里的 linkSecret（与播放签名同源）。 */
function localSecret() {
  if (localSecretCache) return localSecretCache
  localSecretCache = String(process.env.MH_SECRET || getSetting('site', {})?.linkSecret || 'mh-local-dev-secret')
  return localSecretCache
}

const hmacOf = (text) => createHmac('sha256', localSecret()).update(String(text)).digest('base64url')

/** 日志里的账号/关键词只留 12 位摘要：能复盘同一主体，又不把邮箱写进日志。 */
const tagOf = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 12)

const AVATAR_MAX_BYTES = 1024 * 1024

/**
 * 头像魔数判定：Content-Type、data: 前缀、扩展名都是客户端声明，只有头部字节说了算。
 * 返回落盘扩展名，不是 png/jpeg/webp 一律 null。
 */
function imageKindOf(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) return 'png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}

/**
 * otp 层限流错误 → 429 + retryAfterSeconds（与试看/片源同一套口径：4–15 秒起）。
 * 对外形状与「已发送」保持一致（同名字段、只差状态码），日志里才记真实原因与主体摘要：
 * 既不给账号枚举留回显，运营又能查到是谁把第三方邮箱刷爆了。
 * 返回 null 表示不是限流错误，调用方原样抛出。
 */
function otpLimitReply(res, error, { email, expiresIn = 600 } = {}) {
  if (error?.code !== 'rate_limited' && error?.code !== 'send_too_frequent') return null
  const seconds = Number(error.retryAfterSeconds ?? error.retryAfter ?? 0)
  const retryAfterSeconds = retrySecondsOf(seconds, 5)
  logWarn('otp.send_limited', {
    requestId: res.getHeader?.('x-request-id'), reason: error.code, retryAfterSeconds, seconds,
    emailTag: tagOf(email),
  })
  res.setHeader('retry-after', String(seconds > 0 ? Math.ceil(seconds) : retryAfterSeconds))
  return {
    code: '0429', message: '发送过于频繁，请稍后再试', status: 429,
    data: { email, expiresIn, resendAfter: retryAfterSeconds, delivered: false, retryAfterSeconds },
  }
}

/** 签名 Cookie 值：`v1.<payload>.<mac>`，payload 只放服务端校验需要的最小信息。 */
const signCookie = (payload) => `v1.${payload}.${hmacOf(payload).slice(0, 32)}`

/** 校验签名 Cookie，返回 payload；签名不合法一律返回 null（当没签过）。 */
function openCookie(raw) {
  const text = String(raw ?? '').slice(0, COOKIE_MAX)
  const match = /^v1\.([A-Za-z0-9_.:-]{1,400})\.([A-Za-z0-9_-]{32})$/.exec(text)
  if (!match) return null
  const expected = Buffer.from(hmacOf(match[1]).slice(0, 32))
  const actual = Buffer.from(match[2])
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return match[1]
}

/** 追加 Set-Cookie：secureLinkScoped 会整块覆盖 set-cookie，各自 setHeader 会互相踩掉。 */
function appendSetCookie(res, cookie) {
  if (!cookie) return
  const existing = res.getHeader?.('set-cookie')
  const list = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [String(existing)]
  list.push(cookie)
  res.setHeader('set-cookie', list)
}

const cookieFlags = (req, maxAge) => {
  const proto = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  return `; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${proto === 'https' ? '; Secure' : ''}`
}

/** 只看 TCP 对端地址：反代后面 req.socket.remoteAddress 才是可信来源。 */
const isLoopback = (req) => {
  const address = String(req?.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 访客标识只认服务端签发的 Cookie：
 * - 签名 Cookie 有效 → 直接用；
 * - 否则生成新访客（randomUUID）并由调用方签发 Cookie，**不信任**客户端提供的原值；
 * - `x-mh-visitor` 头只在 MH_ALLOW_VISITOR_HEADER=1（测试/本地调试）时兜底。
 */
function visitorOf(req) {
  const payload = openCookie(cookieValue(req, VISITOR_COOKIE))
  if (payload && /^[0-9a-f-]{36}$/i.test(payload)) return { id: payload, fresh: false }
  const header = String(req.headers?.['x-mh-visitor'] ?? '').trim().slice(0, 64)
  if (process.env.MH_ALLOW_VISITOR_HEADER === '1' && header) return { id: header, fresh: false }
  return { id: randomUUID(), fresh: true }
}

const visitorCookie = (req, id) => `${VISITOR_COOKIE}=${encodeURIComponent(signCookie(id))}${cookieFlags(req, VISITOR_MAX_AGE)}`

/** 成人年龄凭证：服务端签名 Cookie（30 天）；query 上的 audience 只是「想不想要」，不是凭据。 */
function adultConfirmed(req) {
  const payload = openCookie(cookieValue(req, ADULT_COOKIE))
  if (!payload) return false
  const issuedAt = Number(String(payload).split('.')[0])
  return Number.isFinite(issuedAt) && issuedAt > 0 && Date.now() - issuedAt < ADULT_MAX_AGE * 1000
}

/**
 * audience 参数 + 成人门禁：没签过年龄凭证时按外层（general）处理，
 * 响应体给 gated:true 让前端弹年龄确认，不返回 403 把前端打崩。
 */
function audienceOf(url, req) {
  const requested = String(url.searchParams.get('audience') ?? '').trim().toLowerCase()
  if (requested !== 'adult') return { audience: 'general', gated: false }
  return adultConfirmed(req) ? { audience: 'adult', gated: false } : { audience: 'general', gated: true }
}

/** Object.prototype 上的键名不作为分类词查表，也不参与 SQL 分支。 */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 搜索埋点去重：同主体（登录用户或访客）同关键词 10 分钟只记一次，
 * 避免匿名刷任意关键词把 /api/rank 的搜索榜顶上去。
 */
const SEARCH_TRACK_SEEN = new Map()
const SEARCH_TRACK_WINDOW_MS = 600000
function searchTrackFresh(subject, keyword) {
  const key = `${subject}:${String(keyword ?? '').trim().toLowerCase().slice(0, 60)}`
  const now = Date.now()
  const last = SEARCH_TRACK_SEEN.get(key)
  if (last && now - last < SEARCH_TRACK_WINDOW_MS) return false
  SEARCH_TRACK_SEEN.set(key, now)
  if (SEARCH_TRACK_SEEN.size > 5000) {
    for (const [seenKey, at] of SEARCH_TRACK_SEEN) if (now - at >= SEARCH_TRACK_WINDOW_MS) SEARCH_TRACK_SEEN.delete(seenKey)
    if (SEARCH_TRACK_SEEN.size > 5000) SEARCH_TRACK_SEEN.delete(SEARCH_TRACK_SEEN.keys().next().value)
  }
  return true
}

/* ---------- 试看台账：登录与匿名都计量，按 subject + 剧 24h 结算 ---------- */

let trialTableReady = false
/** trial_uses 由 db.mjs 建立；这里补一次幂等建表，缺表也不会把试看打成 500。 */
function ensureTrialTable() {
  if (trialTableReady) return
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS trial_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      drama_id INTEGER NOT NULL,
      episode_id INTEGER,
      seconds_used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_trial_uses_budget ON trial_uses(subject_kind, subject, drama_id, created_at)')
  } catch (error) {
    logWarn('trial.schema_unavailable', { error })
  }
  trialTableReady = true
}

/**
 * 24h 试看额度。db.mjs 的 trialBudget() 是权威实现；下面的同表 SQL 只在它还没导出时兜底
 * （并行子代理交付后走不到这一支），保证本文件的额度判定在任何部署顺序下都成立。
 */
function trialBudgetOf({ subjectKind, subject, dramaId, windowHours = 24 }) {
  ensureTrialTable()
  if (typeof dbModule.trialBudget === 'function') return dbModule.trialBudget({ subjectKind, subject, dramaId, windowHours })
  const row = one(`SELECT COALESCE(SUM(seconds_used), 0) AS used, COUNT(*) AS windows FROM trial_uses
    WHERE subject_kind = ? AND subject = ? AND drama_id = ? AND created_at >= datetime('now', ?)`,
  subjectKind, subject, dramaId, `-${intOf(windowHours, 24, 1, 168)} hours`)
  return { usedSeconds: Number(row?.used ?? 0), windows: Number(row?.windows ?? 0) }
}

function recordTrialUse({ subjectKind, subject, dramaId, episodeId, secondsUsed }) {
  // db.mjs 的 recordTrialUse 是权威实现（参数名 secondsUsed），只在它还没导出时走同表兜底
  if (typeof dbModule.recordTrialUse === 'function') {
    return dbModule.recordTrialUse({ subjectKind, subject, dramaId, episodeId, secondsUsed })
  }
  ensureTrialTable()
  db.prepare(`INSERT INTO trial_uses (subject_kind, subject, drama_id, episode_id, seconds_used, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`)
    .run(subjectKind, String(subject), dramaId, episodeId, intOf(secondsUsed, 0, 0, 86400))
}

/* ---------- 「全部分类」筛选taxonomy：固定枚举，空库也有完整分类树 ---------- */
export const CATEGORY_CHANNELS = [
  { value: 'ALL', label: '全部' },
  { value: 'TV', label: '电视剧' },
  { value: 'MOVIE', label: '电影' },
  { value: 'PLAYLET', label: '短剧' },
  { value: 'ANIME', label: '动漫' },
  { value: 'VARIETY', label: '综艺' },
  { value: 'DOCUMENTARY', label: '纪录片' },
]
export const CATEGORY_SORTS = [
  { value: 'hot', label: '最热' },
  { value: 'new', label: '最新' },
  { value: 'score', label: '好评' },
  { value: 'discuss', label: '讨论最多' },
  { value: 'upcoming', label: '即将上线' },
]
/** 地区按 area 文本匹配；negate 的「其他」= 不属于任何已知地区 */
export const CATEGORY_REGIONS = [
  { value: 'US', label: '美国', areas: ['美国'] },
  { value: 'UK', label: '英国', areas: ['英国'] },
  { value: 'KR', label: '韩国', areas: ['韩国'] },
  { value: 'JP', label: '日本', areas: ['日本'] },
  { value: 'TH', label: '泰国', areas: ['泰国'] },
  { value: 'CN', label: '内地', areas: ['内地', '中国大陆', '中国'] },
  { value: 'HK', label: '中国香港', areas: ['中国香港', '香港'] },
  { value: 'TW', label: '中国台湾', areas: ['中国台湾', '台湾'] },
  { value: 'OTHER', label: '其他', areas: [], negate: true },
]
/** 类型按标签名匹配（值即标签名，一级标签会带上其子标签） */
export const CATEGORY_GENRES = [
  '剧情', '喜剧', '动作', '冒险', '爱情', '动画', '歌舞', '医疗', '科幻', '奇幻',
  '悬疑', '惊悚', '犯罪', '传记', '历史', '战争', '灾难', '美食', '真人秀', '脱口秀',
]
const CURRENT_YEAR = new Date().getFullYear() + 1
export const CATEGORY_YEARS = [
  { value: String(CURRENT_YEAR), label: String(CURRENT_YEAR), from: CURRENT_YEAR, to: CURRENT_YEAR },
  { value: String(CURRENT_YEAR - 1), label: String(CURRENT_YEAR - 1), from: CURRENT_YEAR - 1, to: CURRENT_YEAR - 1 },
  { value: String(CURRENT_YEAR - 2), label: String(CURRENT_YEAR - 2), from: CURRENT_YEAR - 2, to: CURRENT_YEAR - 2 },
  { value: String(CURRENT_YEAR - 3), label: String(CURRENT_YEAR - 3), from: CURRENT_YEAR - 3, to: CURRENT_YEAR - 3 },
  { value: String(CURRENT_YEAR - 4), label: String(CURRENT_YEAR - 4), from: CURRENT_YEAR - 4, to: CURRENT_YEAR - 4 },
  { value: String(CURRENT_YEAR - 5), label: String(CURRENT_YEAR - 5), from: CURRENT_YEAR - 5, to: CURRENT_YEAR - 5 },
  { value: '2011-2020', label: '2011—2020', from: 2011, to: 2020 },
  { value: '2000-2010', label: '2000—2010', from: 2000, to: 2010 },
  { value: '1990s', label: '90年代', from: 1990, to: 1999 },
  { value: '1980s', label: '80年代', from: 1980, to: 1989 },
]

export function send(res, data, code = '0000', msg = 'Success', status = 200, cacheControl = 'no-store') {
  const requestId = String(res.getHeader?.('x-request-id') ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`)
  if (code !== '0000') logWarn('http.api_error', { requestId, code, msg, status })
  const body = JSON.stringify({ requestId, code, msg, data })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl })
  res.end(body)
}

/** 公开聚合接口允许浏览器短缓存：返回箭头时不用再等一个来回，10 秒内的内容变化对观众无感。
 *  private：这些响应里带登录态字段（owned/access），不能被共享缓存复用。 */
const PUBLIC_CACHE = 'private, max-age=10, stale-while-revalidate=30'
const sendPublic = (res, data) => {
  res.setHeader('vary', 'x-mh-lang')
  return send(res, data, '0000', 'Success', 200, PUBLIC_CACHE)
}

const fail = (res, code, msg, status = 400, extra = {}) => send(res, extra, code, msg, status)

/** 播放签名放 Cookie：HLS 播放器请求分片时不带 query，但会自动带 Cookie。 */
function setLinkCookies(res, link, ttl, req, scopeId) {
  const proto = String(req?.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  const secure = proto === 'https'
  const flags = `; Path=/; Max-Age=${ttl}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`
  const list = []
  // 按集分名：同一浏览器开两个标签播不同剧时，通用名会互相覆盖签名 → 先开的那个黑屏
  if (scopeId !== undefined && scopeId !== null) {
    list.push(`mh_link_${scopeId}=${link.sign}${flags}`, `mh_exp_${scopeId}=${link.expires}${flags}`)
  }
  list.push(`mh_link=${link.sign}${flags}`, `mh_exp=${link.expires}${flags}`)
  res.setHeader('set-cookie', list)
}

/**
 * 列表页逐条 cardOf() 会各自 policyOf() 一次，一页 24 条就是 24 次带 JOIN 的查询。
 * 这里按整页 id 一次取回策略，供 cardOf 通过 context.policies 复用（口径与 entitlements.policyOf 一致）。
 */
function policyMapOf(rows) {
  const ids = [...new Set((rows ?? []).map((row) => intOf(row?.id, 0, 0, Number.MAX_SAFE_INTEGER)).filter((id) => id > 0))]
  if (!ids.length) return new Map()
  const list = all(`SELECT p.drama_id,
      COALESCE(g.access_mode, p.access_mode) AS access_mode,
      COALESCE(g.free_episodes, p.free_episodes) AS free_episodes,
      COALESCE(g.trial_seconds, p.trial_seconds) AS trial_seconds,
      p.single_price_cny, p.purchase_kind, p.rental_hours
    FROM content_policies p LEFT JOIN policy_groups g ON g.id = p.policy_group_id
    WHERE p.drama_id IN (${ids.map(() => '?').join(',')})`, ...ids)
  return new Map(list.map((row) => [Number(row.drama_id), row]))
}

/** 给一页数据带上批量策略上下文。 */
function cardContext(context, rows) {
  return { ...context, policies: policyMapOf(rows) }
}

function cardOf(drama, userId, context = {}) {
  const policy = context.policies?.get(drama.id) ?? context.policy ?? policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0 }
  let access = policy.access_mode === 'paid' ? 'paid' : policy.access_mode === 'free' ? 'free' : 'subscription'
  if (userId && context.purchase && context.purchase.has(drama.id)) access = 'owned'
  else if (userId && context.subscription && access !== 'paid') access = 'subscribed'
  const lang = context.lang ?? 'zh'
  return {
    dramaId: drama.id,
    title: drama.title,
    subTitle: drama.sub_title,
    coverUrl: drama.cover_url || `/media/placeholder.svg?t=${encodeURIComponent(drama.title ?? '')}`,
    dramaType: drama.category,
    dramaTypeLabel: enumLabel(lang, 'category', drama.category),
    isAdult: Boolean(drama.is_adult),
    releaseDate: drama.release_date ?? null,
    updatedAt: drama.updated_at ?? null,
    stats: drama.adult_stats ?? null,
    score: drama.score,
    year: drama.year,
    area: drama.area,
    areaLabel: enumLabel(lang, 'area', drama.area, drama.area),
    access,
    accessLabel: enumLabel(lang, 'access', access),
    accessMode: policy.access_mode,
    freeEpisodes: freeEpisodesOf(policy, drama),
    trialSeconds: policy.trial_seconds,
    singlePrice: policy.access_mode === 'paid' ? Number(policy.single_price_cny) || 0 : 0,
    playCount: Number(drama.play_count ?? 0),
    previewUrl: previewUrlForCover(drama.cover_url),
    // 参考站海报左上角有「最新上线 / 独播 / 正在热播」角标：这里只发可判定的「最新上线」
    // （created_at 是 datetime('now') 的 UTC 文本，直接按字符串比较即可，30 天内算新）
    isNew: String(drama.created_at ?? '') >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' '),
  }
}

/** 批量补播放量（列表排序与"最多播放"筛选要用，避免 N+1）。 */
function withPlayCounts(rows) {
  if (!rows.length) return rows
  const ids = rows.map((row) => row.id)
  const marks = ids.map(() => '?').join(',')
  const counts = new Map(all(`SELECT drama_id, COUNT(*) AS n FROM play_events WHERE drama_id IN (${marks}) GROUP BY drama_id`, ...ids)
    .map((row) => [row.drama_id, Number(row.n)]))
  return rows.map((row) => ({ ...row, play_count: counts.get(row.id) ?? 0 }))
}

function wideArtworkForCover(coverUrl) {
  const slug = /\/cover-([^/?.]+)\.jpg(?:\?.*)?$/i.exec(String(coverUrl ?? ''))?.[1]
  if (!slug) return null
  return existsSync(join(ROOT, 'storage', 'images', `banner-${slug}.jpg`))
    ? `/media/images/banner-${slug}.jpg`
    : null
}

/** 资料完整度（个人中心引导用）。 */
function profileCompletion(user) {
  const fields = [
    ['avatar', '头像'], ['nickname', '昵称'], ['birthday', '生日'],
    ['gender', '性别'], ['bio', '个人简介'], ['password_hash', '登录密码'],
  ]
  const filled = fields.filter(([key]) => Boolean(user?.[key])).length
  return {
    filled,
    total: fields.length,
    percent: Math.round((filled / fields.length) * 100),
    missing: fields.filter(([key]) => !user?.[key]).map(([, label]) => label),
  }
}

/** 一次性取出用户的订阅与单片所有权，供列表批量判定。 */
function userContext(userId) {
  if (!userId) return { subscription: undefined, purchase: new Set() }
  const subscription = one(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'
    AND datetime(valid_to) > datetime('now') ORDER BY datetime(valid_to) DESC LIMIT 1`, userId)
  const purchases = new Set(all(`SELECT drama_id FROM purchases WHERE user_id = ? AND status = 'active'
    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`, userId).map((row) => row.drama_id))
  return { subscription, purchase: purchases }
}

/**
 * 请求体读取：Buffer 累积到 end 再整体解码，跨块 UTF-8 不会被拆坏；
 * 超限 destroy()（只 pause() 会让对端继续灌数据、占着 socket），并带超时兜底。
 */
function readRawBody(req, limit = 1024 * 1024, options = {}) {
  const timeoutMs = intOf(options.timeoutMs ?? process.env.MH_BODY_TIMEOUT_MS, 15000, 1000, 120000)
  const tooLarge = options.message ?? '请求体过大'
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const abortWith = (error) => {
      finish(reject, error)
      // 先让调用方把 413 写出去，再销毁 socket（立刻 destroy 会把响应一起掐掉，客户端只看得到 RST）
      setTimeout(() => req.destroy?.(), 25).unref?.()
    }
    const timer = setTimeout(() => {
      abortWith(Object.assign(new Error('请求体读取超时'), { code: '0408', status: 408 }))
    }, timeoutMs)
    timer.unref?.()
    req.on('data', (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > limit) {
        abortWith(Object.assign(new Error(tooLarge), { code: '0413', status: 413 }))
        return
      }
      chunks.push(buffer)
    })
    req.on('aborted', () => finish(reject, Object.assign(new Error('请求体读取中断'), { code: '0400', status: 400 })))
    req.on('end', () => finish(resolve, Buffer.concat(chunks)))
    req.on('error', (error) => finish(reject, error))
  })
}

/** JSON 请求体：空体当 {}（无体 POST 是合法用法），坏 JSON 直接 400，不静默变 {}。 */
async function readBody(req, limit = 4e6, options = {}) {
  const raw = (await readRawBody(req, limit, options)).toString('utf8')
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: '0400', status: 400 })
  }
}

const clientIp = (req) => clientIpOf(req)

function cookieValue(req, name) {
  const raw = String(req.headers?.cookie ?? '')
  const found = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return found ? decodeURIComponent(found.slice(name.length + 1)) : ''
}

export async function handlePublic(pathname, url, req, res) {
  const auth = authOf(req)
  const userId = auth?.role === 'user' ? auth.sub : undefined
  // 访客标识由服务端签发（visitorOf）；客户端给的 x-mh-visitor 只在 MH_ALLOW_VISITOR_HEADER=1 时兜底
  const visitor = visitorOf(req)
  const visitorId = visitor.id
  const lang = langFromRequest(req, url)
  const context = { ...userContext(userId), lang }
  const method = req.method

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (auth?.token) revokeToken(auth.token)
    return send(res, { ok: true })
  }

  /**
   * 登录门禁：浏览类接口公开（分享链接、搜索、榜单是免费流量入口），
   * 播放/权益/订单/个人中心必须登录。未登录用户看详情→点播放时才撞登录墙。
   */
  const OPEN_PATHS = new Set([
    '/api/constants', '/api/home', '/api/feed', '/api/auth/login', '/api/category', '/api/rank',
    '/api/search', '/api/tags', '/api/auth/email/send', '/api/auth/email/login', '/api/auth/email/password',
    // 年龄凭证：state 让前端知道要不要弹 18+ 确认，confirm 负责种签名 Cookie，两者都必须免登录
    '/api/adult/state', '/api/adult/confirm',
    '/api/plans',
    '/api/track', '/api/poster-wall', '/api/attribution/touch', '/api/content/click', '/api/content/rank',
    '/api/currency/options',
    // 模拟收银台在独立标签页，带不了 Bearer：靠一次性 HMAC 支付票据校验，见 mayPay()
    '/api/pay/mock', '/api/pay/alipay-sim',
  ])
  const OPEN_PREFIXES = ['/api/drama/', '/api/category/', '/api/tags/']
  // 只有支付宝服务端回调是公开的（自带 RSA2 验签）；其余回调一律留在内网/进程内
  const guestTrial = pathname.startsWith('/api/play/') && method === 'GET' && url.searchParams.get('trial') === '1'
  const isOpen = OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((p) => pathname.startsWith(p)) || guestTrial || pathname === '/api/notify/alipay'
  if (!isOpen && !userId) {
    return fail(res, '0401', '登录后才可播放与查看个人内容', 401)
  }

  try {
    /* ---------- 成人年龄凭证：服务端签发 Cookie，query 只表达「想不想看」 ---------- */
    if (pathname === '/api/adult/state' && method === 'GET') {
      return send(res, { enabled: adultConfirmed(req) })
    }

    if (pathname === '/api/adult/confirm' && method === 'POST') {
      appendSetCookie(res, `${ADULT_COOKIE}=${encodeURIComponent(signCookie(`${Date.now()}`))}${cookieFlags(req, ADULT_MAX_AGE)}`)
      return send(res, { enabled: true, expiresIn: ADULT_MAX_AGE })
    }

    if (pathname === '/api/attribution/touch' && method === 'POST') {
      const body = await readBody(req)
      const result = recordTouch({
        visitorId: body.visitorId ?? visitorId,
        userId,
        promoCode: body.promoCode ?? url.searchParams.get('c') ?? url.searchParams.get('promoCode'),
        host: req.headers['x-forwarded-host'] ?? req.headers.host,
        pathname: body.landingPath ?? url.pathname,
        referrer: body.referrer,
        utm: body.utm ?? {},
        ip: clientIp(req),
        ua: req.headers['user-agent'],
      })
      let referral = null
      const referralCode = body.referralCode ?? body.refCode ?? url.searchParams.get('ref')
      if (referralCode) {
        try {
          referral = recordInviteClick({
            code: referralCode, visitorId: body.visitorId ?? visitorId, userId,
            ip: clientIp(req), ua: req.headers['user-agent'], referrer: body.referrer,
          })
        } catch (error) {
          logWarn('attribution.referral_rejected', { requestId: res.getHeader?.('x-request-id'), code: error.code ?? 'invalid', error })
        }
      }
      return send(res, { ...result, referral })
    }

    if (pathname === '/api/content/click' && method === 'POST') {
      const body = await readBody(req)
      const result = recordClick({
        userId,
        visitorId: body.visitorId ?? visitorId,
        contentId: body.contentId,
        episodeId: body.episodeId,
        entryPage: body.entryPage ?? url.pathname,
        sourceModule: body.sourceModule,
        position: body.position,
        requestId: body.requestId,
        ip: clientIp(req),
        ua: req.headers['user-agent'],
      })
      return send(res, result)
    }

    if (pathname === '/api/content/rank' && method === 'GET') {
      const type = url.searchParams.get('type') ?? 'hot'
      const contentType = url.searchParams.get('contentType') ?? 'all'
      return sendPublic(res, {
        ...contentRank({ rankType: type, contentType }),
        lists: Object.entries(CONTENT_RANK_TYPES).map(([value, label]) => ({
          value, label: enumLabel(lang, 'contentRank', value, label),
        })),
      })
    }

    if (pathname === '/api/currency/options' && method === 'GET') {
      const requested = url.searchParams.get('currency') ?? cookieValue(req, 'mh_currency') ?? req.headers['x-mh-currency']
      const detected = detectCurrency({
        requested,
        country: req.headers['cf-ipcountry'] ?? req.headers['x-country'],
        acceptLanguage: req.headers['accept-language'],
      })
      return sendPublic(res, {
        detected,
        currencies: listCurrencies({ enabledOnly: true }).filter((row) => ['CNY', 'USD'].includes(row.code))
          .map((row) => ({ ...row, name: enumLabel(lang, 'currency', row.code, row.name) })),
        payoutCurrencies: listCurrencies({ enabledOnly: true }).filter((row) => row.isPayout)
          .map((row) => ({ ...row, name: enumLabel(lang, 'currency', row.code, row.name) })),
      })
    }

    if (pathname === '/api/distribution/me' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const requested = url.searchParams.get('currency') ?? cookieValue(req, 'mh_currency') ?? req.headers['x-mh-currency']
      const currency = detectCurrency({
        requested,
        country: req.headers['cf-ipcountry'] ?? req.headers['x-country'],
        acceptLanguage: req.headers['accept-language'],
      })
      const summary = distributionSummary(userId)
      const code = summary.profile?.status === 'active' ? summary.code?.code ?? null : null
      const localizedPayouts = payoutOptions({ currency })
      return send(res, {
        ...summary,
        currency,
        code,
        link: code ? `/i/${encodeURIComponent(code)}` : null,
        payoutOptions: {
          ...localizedPayouts,
          currencies: localizedPayouts.currencies.map((row) => ({
            ...row, name: enumLabel(lang, 'currency', row.code, row.name),
          })),
        },
        withdrawals: listWithdrawals({ distributorUserId: userId }).map((row) => ({
          ...row, statusLabel: enumLabel(lang, 'withdrawalStatus', row.status),
        })),
        canApply: !summary.profile,
      })
    }

    if (pathname === '/api/distribution/apply' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const profile = applyDistributor(userId)
      let code = null
      if (profile.status === 'active') code = getOrCreateReferralCode(userId).code
      return send(res, {
        profile,
        code,
        link: code ? `/i/${encodeURIComponent(code)}` : null,
        message: profile.status === 'active' ? '已开通佣金推广' : '已提交推广申请，等待审核',
      })
    }

    if (pathname === '/api/distribution/payout-options' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      return send(res, payoutOptions({ currency: url.searchParams.get('currency') ?? 'USD' }))
    }

    if (pathname === '/api/distribution/withdrawals' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      return send(res, { list: listWithdrawals({ distributorUserId: userId }) })
    }

    if (pathname === '/api/distribution/withdrawals' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const result = createWithdrawalRequest({
        userId, amount: body.amount, currency: body.currency, methodCode: body.methodCode, account: body.account,
      })
      return send(res, result)
    }

    /* ---------- 基础 ---------- */
    if (pathname === '/api/constants') {
      const channels = paymentOptions('all')
      const live = channels.filter((channel) => channel.usable)
      const site = getSetting('site', {}) ?? {}
      const adultMenu = adultMenuSettings()
      // 外层不暴露「短剧」频道：该频道全部是成人内容，入口只在成人专区里（见 /api/category 的同款过滤）
      const outerChannels = CATEGORY_CHANNELS.filter((row) => row.value !== 'PLAYLET')
      // 会员价优先取在售套餐里的最低月价，避免运营忘配 settings.site 时收银台显示「元/月」
      const plan = all("SELECT price_cny, duration_days FROM plans WHERE status = 'active' ORDER BY price_cny ASC LIMIT 1")[0]
      const planMonthly = plan ? (Number(plan.price_cny) / Math.max(1, Number(plan.duration_days) / 30)).toFixed(2) : ''
      return sendPublic(res, {
        site: { name: '影巢' },
        supportEmail: process.env.MH_SUPPORT_EMAIL || site.supportEmail || '',
        vipPrice: site.vipPrice ?? (plan ? Number(plan.price_cny).toFixed(2) : ''),
        vipMonthlyPrice: planMonthly,
        vipUnit: site.vipUnit ?? '元/月',
        categories: outerChannels.filter((row) => row.value !== 'ALL').map((row) => ({ code: row.value, name: row.label })),
        adultMenu: {
          enabled: adultMenu.enabled,
          labels: { zh: adultMenu.labelZh, en: adultMenu.labelEn },
        },
        taxonomy: {
          channels: outerChannels,
          sorts: CATEGORY_SORTS,
          regions: CATEGORY_REGIONS.map((row) => ({ value: row.value, label: row.label })),
          genres: CATEGORY_GENRES,
          years: CATEGORY_YEARS.map((row) => ({ value: row.value, label: row.label })),
        },
        pay: {
          channels,
          alipay: live.some((channel) => channel.code === 'alipay'),
          usdt: live.some((channel) => channel.code === 'usdt'),
          mock: live.some((channel) => channel.code === 'mock'),
          usdtNetwork: 'TRC20',
          defaultChannel: live.find((channel) => channel.isDefault)?.code ?? live[0]?.code ?? null,
        },
        auth: {
          method: 'email',
          codeLength: 6,
          ttlSeconds: 300,
          resendSeconds: 60,
          maxAttempts: 3,
          passwordLogin: true,
        },
      })
    }

    if (pathname === '/api/poster-wall') {
      const payload = posterWallPayload()
      return sendPublic(res, {
        ...payload,
        items: (payload.items ?? []).map((item) => ({
          ...item,
          categoryLabel: enumLabel(lang, 'category', item.category, item.category),
        })),
      })
    }

    if (pathname === '/api/home') {
      const { audience, gated } = audienceOf(url, req)
      // 未确认 18+ 时不要「空壳首页」：直接给 gated 形状，前端弹年龄确认后重取
      if (gated) return sendPublic(res, { banners: [], sections: [], hotwords: [], items: [], total: 0, gated: true })
      const banners = all(`SELECT b.id, b.name, b.title, b.image, b.target_drama_id, b.sort,
          d.sub_title, d.description, d.year, d.area, d.category, d.score, d.cover_url
        FROM banners b LEFT JOIN dramas d ON d.id = b.target_drama_id
        WHERE b.enabled = 1 AND (b.target_drama_id IS NULL OR (d.id IS NOT NULL AND ${adultVisibilitySql(audience)}))
        ORDER BY b.sort`).map((banner) => ({
        id: banner.id,
        name: banner.name,
        title: banner.title,
        image: banner.image,
        targetDramaId: banner.target_drama_id,
        subTitle: banner.sub_title,
        description: banner.description,
        year: banner.year,
        area: banner.area,
        areaLabel: enumLabel(lang, 'area', banner.area, banner.area),
        category: banner.category,
        categoryLabel: enumLabel(lang, 'category', banner.category),
        score: banner.score,
        previewUrl: previewUrlForCover(banner.cover_url),
      }))
      const backdropByDrama = new Map()
      for (const banner of banners) {
        if (banner.targetDramaId && banner.image && !backdropByDrama.has(banner.targetDramaId)) {
          backdropByDrama.set(banner.targetDramaId, banner.image)
        }
      }
      const sections = all('SELECT * FROM sections WHERE enabled = 1 ORDER BY sort').map((section) => {
        const sectionRows = withPlayCounts(all(`SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? AND d.status = 'published' AND ${adultVisibilitySql(audience)}
          ORDER BY si.sort LIMIT 30`, section.id))
        const sectionCtx = cardContext(context, sectionRows)
        return {
          id: section.id,
          title: section.title,
          items: sectionRows.map((drama) => ({
            ...cardOf(drama, userId, sectionCtx),
            backdropUrl: backdropByDrama.get(drama.id) ?? wideArtworkForCover(drama.cover_url),
          })),
        }
      })
      // 运营没配楼层时首页不能是空壳：按真实内容拼几个默认楼层（全部走外层可见性过滤，成人内容不会混进来）
      if (!sections.length) {
        const fallbackRows = (where, params, order) => {
          const rowsOfFloor = withPlayCounts(all(
            `SELECT d.* FROM dramas d WHERE d.status = 'published' AND ${adultVisibilitySql(audience)} AND ${where} ORDER BY ${order} LIMIT 12`,
            ...params,
          ))
          const floorCtx = cardContext(context, rowsOfFloor)
          return rowsOfFloor.map((drama) => ({
            ...cardOf(drama, userId, floorCtx),
            backdropUrl: backdropByDrama.get(drama.id) ?? wideArtworkForCover(drama.cover_url),
          }))
        }
        const plans = [
          { key: 'latest', title: '最新上架', where: '1 = 1', params: [], order: 'COALESCE(d.published_at, d.created_at) DESC, d.id DESC' },
          { key: 'movie', title: '电影精选', where: "d.category = 'MOVIE'", params: [], order: 'COALESCE(d.score, 0) DESC, d.id DESC' },
          { key: 'series', title: '剧集与纪录', where: "d.category IN ('TV', 'DOCUMENTARY')", params: [], order: 'COALESCE(d.score, 0) DESC, d.id DESC' },
          { key: 'anime', title: '动漫与综艺', where: "d.category IN ('ANIME', 'VARIETY')", params: [], order: 'COALESCE(d.score, 0) DESC, d.id DESC' },
        ]
        for (const plan of plans) {
          const items = fallbackRows(plan.where, plan.params, plan.order)
          if (items.length) sections.push({ id: plan.key, title: plan.title, items })
        }
      }
      const hot = all(`SELECT title FROM dramas WHERE ${adultVisibilitySql(audience, '')} ORDER BY score DESC LIMIT 8`).map((row) => row.title)
      return sendPublic(res, { banners, sections, hotwords: hot, gated: false })
    }

    if (pathname === '/api/category') {
      // 「全部分类」筛选：频道 / 排序 / 地区 / 类型（按标签名）/ 年份（单年或年代桶）/ 标签 + 分页
      // total 为筛选后的真实总数；facets 的计数按当前频道内统计，用于给筛选项打数量
      const p = url.searchParams
      const channel = (p.get('type') ?? p.get('channel') ?? 'ALL').trim().toUpperCase()
      const page = intOf(p.get('page'), 1, 1, 10000)
      const pageSize = intOf(p.get('pageSize'), 24, 1, 60)
      const sort = (p.get('sort') ?? 'hot').trim().toLowerCase()
      const { audience, gated } = audienceOf(url, req)
      // 没签过年龄凭证：HTTP 200 + gated，一个成人条目都不下发（403 会把前端打崩）
      if (gated) {
        return sendPublic(res, {
          page, pageSize, total: 0, list: [], items: [], gated: true,
          facets: { channels: [], sorts: [], regions: [], genres: [], years: [], tags: [] },
          active: { audience: 'adult', channel, sort },
        })
      }
      const audienceSql = adultVisibilitySql(audience)

      const where = ["d.status = 'published'", audienceSql]
      const params = []
      const channelWhere = []
      const channelParams = []
      if (channel && channel !== 'ALL') {
        // 频道条件既进主查询（列表/总数），也作为 facets 计数的「当前频道」范围
        channelWhere.push('d.category = ?')
        channelParams.push(channel)
        where.push('d.category = ?')
        params.push(channel)
      }

      // 地区：前端传标准 code（US/UK/KR/JP/TH/CN/HK/TW/OTHER），按 area 文本映射
      const region = (p.get('region') ?? '').trim().toUpperCase()
      const regionRule = CATEGORY_REGIONS.find((row) => row.value === region)
      if (regionRule) {
        if (regionRule.negate) {
          const known = CATEGORY_REGIONS.filter((row) => !row.negate).flatMap((row) => row.areas)
          where.push(`COALESCE(d.area, '') NOT IN (${known.map(() => '?').join(',')})`)
          params.push(...known)
        } else {
          where.push(`d.area IN (${regionRule.areas.map(() => '?').join(',')})`)
          params.push(...regionRule.areas)
        }
      }

      // 年份：2026 这种单年，或 2011-2020 / 2000-2010 / 1990s / 1980s 这种区间
      const year = (p.get('year') ?? '').trim()
      const yearRule = CATEGORY_YEARS.find((row) => row.value === year)
      if (yearRule && Number.isInteger(yearRule.from)) {
        where.push('d.year >= ? AND d.year <= ?')
        params.push(yearRule.from, yearRule.to)
      }

      // 类型：按标签名匹配（标签支持一级/二级，选一级时带上其子标签）
      const genre = (p.get('genre') ?? '').trim()
      if (genre) {
        where.push(`d.id IN (SELECT dt.drama_id FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id
          WHERE t.name = ? OR t.parent_id IN (SELECT id FROM tags WHERE name = ?))`)
        params.push(genre, genre)
      }

      // 标签：直接指定 tagId（后台/C 端标签墙进入）
      const tagId = intOf(p.get('tag'), 0, 0, Number.MAX_SAFE_INTEGER)
      if (tagId) {
        where.push('d.id IN (SELECT drama_id FROM drama_tags WHERE tag_id = ?)')
        params.push(tagId)
      }

      // 兼容旧参数（area 精确 / sort=play|new|score）
      const legacyArea = (p.get('area') ?? '').trim()
      if (!regionRule && legacyArea) { where.push('d.area = ?'); params.push(legacyArea) }

      const orderBy = sort === 'new' ? 'd.year DESC, d.id DESC'
        : sort === 'score' ? 'd.score DESC, d.id DESC'
          : sort === 'discuss' ? 'discuss_count DESC, d.score DESC'
            : sort === 'upcoming' ? 'd.year DESC, d.id DESC'
              : 'hot_score DESC, d.score DESC'

      // 热播 = 播放 + 完播×2 + 收藏×3（30 天），讨论 = 弹幕 + 评论
      const FROM = `FROM dramas d
        LEFT JOIN (SELECT drama_id, COUNT(*) AS play_count FROM play_events WHERE created_at >= datetime('now', '-30 days') GROUP BY drama_id) pe ON pe.drama_id = d.id
        LEFT JOIN (SELECT e.drama_id, COUNT(*) AS danmu_count FROM danmus m JOIN episodes e ON e.id = m.episode_id WHERE m.status = 'approved' GROUP BY e.drama_id) dm ON dm.drama_id = d.id
        LEFT JOIN (SELECT drama_id, COUNT(*) AS comment_count FROM comments WHERE status = 'approved' GROUP BY drama_id) cm ON cm.drama_id = d.id
        LEFT JOIN (SELECT drama_id, COUNT(*) AS fav_count FROM favorites GROUP BY drama_id) fv ON fv.drama_id = d.id`
      const SELECT = `SELECT d.*, COALESCE(pe.play_count, 0) AS play_count,
        COALESCE(dm.danmu_count, 0) + COALESCE(cm.comment_count, 0) AS discuss_count,
        (COALESCE(pe.play_count, 0) + COALESCE(dm.danmu_count, 0) * 2 + COALESCE(fv.fav_count, 0) * 3) AS hot_score`

      const clause = where.join(' AND ')
      const rows = all(`${SELECT} ${FROM} WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        ...params, pageSize, (page - 1) * pageSize)
      const total = one(`SELECT COUNT(*) AS n ${FROM} WHERE ${clause}`, ...params).n

      /**
       * 筛选项计数：原来每个地区/类型/年份各打一次 COUNT（单请求 40–70 条 SQL），
       * 现在每个维度一条 GROUP BY、在内存里聚合 → 常数条（≤ 8 条/请求）。
       * 计数范围按「当前频道内」统计，与外层筛选栏显示的口径一致。
       */
      const channelClause = channelWhere.length
        ? `WHERE d.status = 'published' AND ${audienceSql} AND ${channelWhere.join(' AND ')}`
        : `WHERE d.status = 'published' AND ${audienceSql}`
      const groupRows = (column) => all(
        `SELECT COALESCE(${column}, '') AS key, COUNT(*) AS n ${FROM} ${channelClause} GROUP BY key`,
        ...channelParams,
      )
      const channelCounts = new Map(groupRows('d.category').map((row) => [row.key, Number(row.n)]))
      // 外层（未确认 18+）只放当前可见内容：「短剧」这类整频道都是成人片的频道不能出现在外层的筛选栏里，
      // 否则等于把成人专区的存在和片量直接摊在外层。成人 audience 保持全量枚举，方便运营切频道。
      const channelRows = CATEGORY_CHANNELS.map((row) => ({
        value: row.value,
        label: enumLabel(lang, 'category', row.value, row.label),
        count: row.value === 'ALL'
          ? [...channelCounts.values()].reduce((sum, n) => sum + n, 0)
          : channelCounts.get(row.value) ?? 0,
      }))
      // 地区：按 area 文本聚合一次，再映射到地区代码；不属于任何已知地区的归「其他」
      const knownRegions = CATEGORY_REGIONS.filter((row) => !row.negate)
      const regionCounts = new Map(knownRegions.map((row) => [row.value, 0]))
      let unclassifiedAreas = 0
      for (const row of groupRows('d.area')) {
        const hit = knownRegions.find((rule) => rule.areas.includes(row.key))
        if (hit) regionCounts.set(hit.value, (regionCounts.get(hit.value) ?? 0) + Number(row.n))
        else unclassifiedAreas += Number(row.n)
      }
      // 类型：一次把标签树拉出来，把子标签命中数累加到一级标签，避免每个类型一条子查询
      const tagCounts = all(`SELECT t.id, t.name, t.parent_id, COUNT(DISTINCT dt.drama_id) AS n ${FROM}
        JOIN drama_tags dt ON dt.drama_id = d.id LEFT JOIN tags t ON t.id = dt.tag_id
        ${channelClause} GROUP BY t.id`, ...channelParams)
      const genreCounts = new Map()
      for (const row of tagCounts) {
        // 子标签被命中时，一级标签也要计数（选一级类型等于选它 + 它的子标签）
        const parent = tagCounts.find((item) => item.id === row.parent_id)
        if (row.name) genreCounts.set(row.name, (genreCounts.get(row.name) ?? 0) + Number(row.n))
        if (parent?.name) genreCounts.set(parent.name, (genreCounts.get(parent.name) ?? 0) + Number(row.n))
      }
      const yearCounts = groupRows('d.year')
      const facets = {
        channels: audience === 'adult' ? channelRows : channelRows.filter((row) => row.value === 'ALL' || row.count > 0),
        sorts: CATEGORY_SORTS.map((row) => ({ value: row.value, label: enumLabel(lang, 'sort', row.value, row.label) })),
        regions: CATEGORY_REGIONS.map((row) => ({
          value: row.value,
          label: enumLabel(lang, 'region', row.value, row.label),
          count: row.negate ? unclassifiedAreas : regionCounts.get(row.value) ?? 0,
        })),
        genres: CATEGORY_GENRES.map((label) => ({
          value: label, label: enumLabel(lang, 'genre', label, label), count: genreCounts.get(label) ?? 0,
        })),
        years: CATEGORY_YEARS.map((row) => ({
          value: row.value,
          label: localizedYearLabel(lang, row.label),
          count: yearCounts.reduce((sum, item) => {
            const year = Number(item.key)
            return year >= row.from && year <= row.to ? sum + Number(item.n) : sum
          }, 0),
        })),
        tags: all(`SELECT t.id, t.name, (SELECT COUNT(*) FROM drama_tags dt
            JOIN dramas d ON d.id = dt.drama_id AND d.status = 'published' AND ${audienceSql}
            WHERE dt.tag_id = t.id) AS n
          FROM tags t WHERE t.status = 'active' ORDER BY n DESC, t.sort LIMIT 24`)
          .map((row) => ({ value: Number(row.id), label: enumLabel(lang, 'genre', row.name, row.name), count: Number(row.n) })),
      }
      const adultStats = audience === 'adult' ? adultStatsFor(rows.map((drama) => drama.id)) : null
      const listRows = adultStats
        ? rows.map((drama) => ({ ...drama, adult_stats: adultStats.get(drama.id) }))
        : rows
      const cardCtx = cardContext(context, listRows)
      return sendPublic(res, {
        page, pageSize, total, gated: false,
        list: listRows.map((drama) => cardOf(drama, userId, cardCtx)),
        facets,
        active: { audience, channel, sort, region, year, genre, tagId },
      })
    }

    if (pathname === '/api/rank') {
      const type = String(url.searchParams.get('type') ?? 'HOT').trim().slice(0, 32) || 'HOT'
      const { audience, gated } = audienceOf(url, req)
      if (gated) {
        // 未确认 18+：榜单一条都不下发，方向留给前端弹年龄确认
        return sendPublic(res, { type, listName: '', lists: [], items: [], total: 0, gated: true })
      }
      const lists = all('SELECT name, type FROM rank_lists ORDER BY sort').map((row) => ({
        name: row.name, type: row.type, label: enumLabel(lang, 'rank', row.type, row.name),
      }))
      const list = one('SELECT * FROM rank_lists WHERE type = ? ORDER BY sort LIMIT 1', type)
      // 运营没配榜单时也别给空页：按评分与热播度现算一份，外层过滤照旧
      if (!list) {
        const fallbackName = lang === 'en' ? 'Trending' : '热门榜'
        const rowsFallback = withPlayCounts(all(`SELECT d.* FROM dramas d
          WHERE d.status = 'published' AND ${adultVisibilitySql(audience)}
          ORDER BY COALESCE(d.score, 0) DESC, d.id DESC LIMIT 20`))
        const fallbackCtx = cardContext(context, rowsFallback)
        const items = rowsFallback
          .map((drama, index) => ({ ...cardOf(drama, userId, fallbackCtx), rankNo: index + 1 }))
        return sendPublic(res, {
          type, listName: fallbackName,
          lists: lists.length ? lists : [{ name: fallbackName, type: 'HOT', label: fallbackName }],
          items,
        })
      }
      // 榜单项是历史快照：剧下架后 item 还在，这里补 status 兜底，避免泄漏未上架内容
      const rankRows = withPlayCounts(all(`SELECT d.*, ri.rank_no FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id
        WHERE ri.list_id = ? AND d.status = 'published' AND ${adultVisibilitySql(audience)} ORDER BY ri.rank_no`, list.id))
      const rankCtx = cardContext(context, rankRows)
      const items = rankRows
        .map((drama) => ({ ...cardOf(drama, userId, rankCtx), rankNo: drama.rank_no }))
      return sendPublic(res, { type, listName: enumLabel(lang, 'rank', list.type, list.name), lists, items })
    }

    /* 「换一换」：按分区随机重排；无分区参数时全站随机 */
    if (pathname === '/api/feed') {
      const sectionId = intOf(url.searchParams.get('section'), 0, 0, Number.MAX_SAFE_INTEGER)
      const { audience, gated } = audienceOf(url, req)
      if (gated) return sendPublic(res, { sectionId, items: [], total: 0, gated: true })
      if (sectionId) {
        const sectionRows = withPlayCounts(all(`SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? AND d.status = 'published' AND ${adultVisibilitySql(audience)}
          ORDER BY RANDOM() LIMIT 12`, sectionId))
        const sectionCtx = cardContext(context, sectionRows)
        const items = sectionRows.map((drama) => cardOf(drama, userId, sectionCtx))
        if (items.length > 1) return sendPublic(res, { sectionId, items, gated: false })
      }
      const feedRows = withPlayCounts(all(`SELECT * FROM dramas WHERE status = 'published' AND ${adultVisibilitySql(audience, '')} ORDER BY RANDOM() LIMIT 12`))
      const feedCtx = cardContext(context, feedRows)
      const items = feedRows.map((drama) => cardOf(drama, userId, feedCtx))
      return sendPublic(res, { sectionId, items, gated: false })
    }

    if (pathname === '/api/search') {
      // 关键词一律先 String()：searchParams 给 null，原型链键名（constructor 等）也不能当查表键用
      const keyword = String(url.searchParams.get('keyword') ?? '').slice(0, 60).trim()
      const tagId = intOf(url.searchParams.get('tag') ?? url.searchParams.get('tagId'), 0, 0, Number.MAX_SAFE_INTEGER)
      const { audience, gated } = audienceOf(url, req)
      if (gated) return sendPublic(res, { keyword, tagId, total: 0, list: [], items: [], gated: true })
      const where = ["status = 'published'", adultVisibilitySql(audience, '')]
      const params = []
      // 标签与关键词可以叠加：标签缩小集合，关键词在集合内再筛（原来两者互斥，搜标签名搜不到片）
      if (tagId) {
        where.push('id IN (SELECT drama_id FROM drama_tags WHERE tag_id = ?)')
        params.push(tagId)
      }
      const prototypeKey = PROTO_KEYS.has(keyword) || PROTO_KEYS.has(keyword.toLowerCase())
      if (keyword && prototypeKey) {
        // 原型链键名（__proto__ / constructor / prototype）不当分类词，也不进 LIKE：直接判空
        where.push('0 = 1')
      } else if (keyword) {
        // % 与 _ 转义后再进 LIKE，否则一个 `%` 就等于全库匹配（配上 ESCAPE 才生效）
        const like = `%${escapeLike(keyword)}%`
        const categoryMap = {
          电影: 'MOVIE',
          电视剧: 'TV',
          短剧: 'PLAYLET',
          动漫: 'ANIME',
          纪录片: 'DOCUMENTARY',
          movie: 'MOVIE',
          movies: 'MOVIE',
          tv: 'TV',
          'tv series': 'TV',
          'short drama': 'PLAYLET',
          anime: 'ANIME',
          documentary: 'DOCUMENTARY',
        }
        // hasOwnProperty 兜底：categoryMap[keyword] 为字符串时未命中会返回 undefined，
        // 但 keyword 若等于 'constructor' 会命中原型链（旧实现直接 500），这里只查自有键
        const exact = Object.prototype.hasOwnProperty.call(categoryMap, keyword) ? categoryMap[keyword] : undefined
        const lowered = keyword.toLowerCase()
        const category = exact ?? (Object.prototype.hasOwnProperty.call(categoryMap, lowered) ? categoryMap[lowered] : undefined)
        const keywordWhere = [
          "title LIKE ? ESCAPE '\\'",
          "sub_title LIKE ? ESCAPE '\\'",
          "description LIKE ? ESCAPE '\\'",
          "area LIKE ? ESCAPE '\\'",
          `id IN (SELECT dt.drama_id FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id
            WHERE t.status = 'active' AND t.name LIKE ? ESCAPE '\\')`,
        ]
        params.push(like, like, like, like, like)
        if (category) {
          keywordWhere.push('category = ?')
          params.push(category)
        }
        where.push(`(${keywordWhere.join(' OR ')})`)
      }
      if (!keyword && !tagId) return send(res, { keyword, tagId, total: 0, list: [], gated: false })
      const clause = where.join(' AND ')
      const total = one(`SELECT COUNT(*) AS n FROM dramas WHERE ${clause}`, ...params).n
      const rows = all(`SELECT * FROM dramas WHERE ${clause} ORDER BY score DESC LIMIT 60`, ...params)
      const searchCtx = cardContext(context, rows)
      return sendPublic(res, { keyword, tagId, total, gated: false, list: rows.map((drama) => cardOf(drama, userId, searchCtx)) })
    }

    if (pathname === '/api/tags') {
      const requestedScope = url.searchParams.get('scope') ?? 'general'
      const scope = requestedScope === 'adult' ? 'adult' : 'general'
      // 成人标签墙与成人列表同一条门禁：没签年龄凭证就不下发成人标签
      if (scope === 'adult' && !adultConfirmed(req)) return sendPublic(res, { list: [], items: [], total: 0, gated: true })
      return sendPublic(res, {
        list: listTags({ withCount: true, publicOnly: true, scope }).map((tag) => ({
          ...tag,
          label: scope === 'adult'
            ? enumLabel(lang, 'adultTag', tag.name, tag.name)
            : enumLabel(lang, 'genre', tag.name, tag.name),
        })),
      })
    }

    /* ---------- 详情 / 权益 ---------- */
    if (pathname.startsWith('/api/drama/')) {
      const dramaId = intOf(pathname.split('/')[3], 0, 0, Number.MAX_SAFE_INTEGER)
      const drama = one("SELECT * FROM dramas WHERE id = ? AND status = 'published'", dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)
      const policy = policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0, purchase_kind: 'single' }
      const episodes = all("SELECT id, no, title, duration, status, hls_path, remote_url FROM episodes WHERE drama_id = ? AND status != 'merged' ORDER BY no", drama.id)
      const purchase = context.purchase.has(drama.id) ? one(`SELECT * FROM purchases WHERE user_id = ? AND drama_id = ? AND status = 'active'
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) ORDER BY id DESC LIMIT 1`, userId, drama.id) : undefined
      const decided = decideEpisodes({ drama, policy, subscription: context.subscription, purchase, episodes })
      // 收藏态与观看进度：详情页要靠这两个字段渲染「✓ 已收藏」「继续观看第 N 集」，
      // 否则前端只能再打一次 /api/me，多一轮请求且首屏会闪。
      const favorite = userId ? one('SELECT 1 AS x FROM favorites WHERE user_id = ? AND drama_id = ?', userId, drama.id) : undefined
      const resume = userId ? one('SELECT episode_no, position, updated_at FROM history WHERE user_id = ? AND drama_id = ?', userId, drama.id) : undefined
      const card = cardOf(drama, userId, context)
      // 单集内容同样不存在「首集免费」，按真实集数收敛一次
      card.freeEpisodes = freeEpisodesOf(policy, drama, episodes.length)
      if (drama.is_adult) card.stats = adultStatsFor([drama.id]).get(drama.id)
      return sendPublic(res, {
        ...card,
        description: drama.description,
        episodes: decided.map((episode) => ({
          id: episode.id, no: episode.no, title: episode.title, duration: episode.duration,
          status: episode.status, allow: episode.allow, source: episode.source,
          reason: episode.reason ?? null,
          rule: episode.rule ? { mode: episode.rule.mode, price: Number(episode.rule.price_cny ?? 0) } : null,
          trialSeconds: episode.trialSeconds, price: episode.price,
          // 外部片源的签名过期了：详情页据此提示「续期中」，别让人点进去才踩灰按钮
          stale: staleOf(episode.remote_url),
        })),
        priceInfo: {
          ...priceInfo(drama),
          rules: rulesOfDrama(drama.id).map((rule) => ({
            fromNo: Number(rule.from_no),
            toNo: rule.to_no === null || rule.to_no === undefined ? null : Number(rule.to_no),
            mode: rule.mode,
            price: Number(rule.price_cny ?? 0),
            note: rule.note ?? '',
          })),
        },
        tags: tagsOfDrama(drama.id).map((tag) => ({
          id: tag.id,
          name: tag.name,
          label: tag.scope === 'adult'
            ? enumLabel(lang, 'adultTag', tag.name, tag.name)
            : enumLabel(lang, 'genre', tag.name, tag.name),
        })),
        hasSubscription: Boolean(context.subscription),
        favorited: Boolean(favorite),
        resumeEpisodeNo: resume?.episode_no ?? null,
        resumePosition: resume?.position ?? null,
        resumeUpdatedAt: resume?.updated_at ?? null,
        // 参考站详情页右侧/底部有「类似影视」：同类型优先，不足时用高分剧补齐，最多 8 部
        similar: (() => {
          // 相似推荐跟着详情页本身的口径走：成人剧的相似只给成人条目（不把外层内容混进成人页），
          // 普通详情页只给外层条目（未确认 18+ 时也不会把成人内容混进来）
          const detailAudience = drama.is_adult ? 'adult' : 'general'
          const sameType = all(
            `SELECT d.* FROM dramas d
              WHERE d.id <> ? AND d.status = 'published' AND d.category = ? AND ${adultVisibilitySql(detailAudience)}
              ORDER BY d.score DESC, d.id DESC LIMIT 8`,
            drama.id, drama.category,
          )
          const fill = sameType.length >= 4
            ? []
            : all(
              `SELECT d.* FROM dramas d WHERE d.id <> ? AND d.status = 'published' AND ${adultVisibilitySql(detailAudience)}
                ORDER BY d.score DESC, d.id DESC LIMIT ?`,
              drama.id, 8 - sameType.length,
            )
          const seen = new Set(sameType.map((row) => row.id))
          const similar = [...sameType, ...fill.filter((row) => !seen.has(row.id))]
          const similarCtx = cardContext(context, similar)
          return similar.map((row) => cardOf(row, userId, similarCtx))
        })(),
      })
    }

    if (pathname.startsWith('/api/access/')) {
      const [, , , dramaIdRaw, noRaw] = pathname.split('/')
      const dramaId = intOf(dramaIdRaw, 0, 0, Number.MAX_SAFE_INTEGER)
      const no = intOf(noRaw, 0, 0, 100000)
      // 集号 0 / 缺失 / 非数字都不存在：不能因为「首集免费」就把不存在的第 0 集判成 allow
      if (!dramaId || no < 1) {
        return send(res, { allow: false, reason: 'invalid_episode', episodeNo: no, trialSeconds: 0, price: 0, purchaseKind: null })
      }
      return send(res, resolveAccess(userId, dramaId, no))
    }

    if (pathname.startsWith('/api/play/session/') && pathname.endsWith('/heartbeat') && method === 'POST') {
      const sessionId = pathname.split('/')[4]
      const body = await readBody(req)
      const result = applyHeartbeat({
        sessionId, userId, visitorId,
        positionSeconds: body.positionSeconds,
        durationSeconds: body.durationSeconds,
        playing: Boolean(body.playing),
        visible: Boolean(body.visible),
        playbackRate: body.playbackRate,
      })
      return send(res, result)
    }

    /* ---------- 播放：签发短时链接 ---------- */
    if (pathname.startsWith('/api/play/')) {
      const [, , , dramaIdRaw, noRaw] = pathname.split('/')
      const dramaId = intOf(dramaIdRaw, 0, 0, Number.MAX_SAFE_INTEGER)
      let no = intOf(noRaw ?? 1, 1, 1, 100000)
      const drama = one('SELECT id, title, category, status FROM dramas WHERE id = ?', dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)

      /** 取集：单集电影允许回落到合并集；不做片源探测（探测要等上游，不该影响 404/402 的响应时间）。 */
      const loadEpisode = () => {
        let row = one("SELECT * FROM episodes WHERE drama_id = ? AND no = ? AND status != 'merged'", dramaId, no)
        if (!row && drama.category === 'MOVIE') {
          row = one("SELECT * FROM episodes WHERE drama_id = ? AND no = 1 AND hls_path LIKE '%/merged/%'", dramaId)
          if (row) no = 1
        }
        return row
      }
      const notReady = (row) => send(res, {
        dramaId, episodeId: row.id, episodeStatus: row.status, reason: 'episode_not_ready',
        message: row.status === 'error' ? '该集片源处理失败，请稍后再试' : '该集片源正在处理中，请稍后再试',
      }, '0409', '该集片源尚未就绪', 409)

      /**
       * 外部片源（jable）的直链带签名，过期后上游一律 410，前端只会拿到一个灰按钮。
       * 只有票真的过期了才当场换（没过期一次都不刷，点开就能播）；换不上就把原因写清楚，
       * 让前端倒计时自动重试。**只在鉴权/试看额度判定之后调用**：未授权请求不替我们触发上游续期。
       */
      const freshen = async (row) => {
        if (!row?.remote_url) return { episode: row }
        try {
          const fresh = await ensureFreshForPlay(row.id, { timeoutMs: PLAY_REFRESH_WAIT_MS })
          const reloaded = one('SELECT * FROM episodes WHERE id = ?', row.id) ?? row
          if (!staleOf(reloaded.remote_url)) return { episode: reloaded }
          // 连刷三次都拿不到新票：多半是源站把这部下了（404），再让用户每 30 秒回来自动重试就是折磨
          if ((fresh?.failureCount ?? 0) >= 3) {
            return {
              reject: {
                code: '0409', msg: '该集片源暂不可用', status: 409,
                data: {
                  dramaId, episodeId: reloaded.id, episodeStatus: reloaded.status, reason: 'source_unavailable',
                  permanent: true, retryAfterSeconds: 0, message: '该集片源已下架或源站暂时无法获取，换一集试试',
                },
              },
            }
          }
          return {
            reject: {
              code: '0409', msg: '片源签名已过期', status: 409,
              data: {
                dramaId, episodeId: reloaded.id, episodeStatus: reloaded.status, reason: 'source_link_expired',
                // 换票通常 1～3 秒：夹在 [4, 15] 让前端很快回来自动重试，而不是干等半分钟
                retryAfterSeconds: retrySecondsOf(Math.round((fresh?.cooldownMs ?? 0) / 1000), fresh?.busy ? 4 : 5),
                message: '片源签名已过期，服务器正在自动续期，请稍后重试',
              },
            },
          }
        } catch (error) {
          logWarn('play.refresh_failed', { requestId: res.getHeader?.('x-request-id'), episodeId: row.id, error })
          return { episode: row }
        }
      }
      const sendReject = (reject) => send(res, reject.data, reject.code, reject.msg, reject.status)

      const access = resolveAccess(userId, dramaId, no)
      const trialWanted = url.searchParams.get('trial') === '1'
      const ua = String(req.headers['user-agent'] ?? '')
      /**
       * 试看：scope 收窄到 /media/trial/<episodeId>/（index.mjs 按 sec 秒数截断清单、只放行窗口内分片），
       * 登录与匿名都写 trial_uses 计量：24h 内同 subject 同剧累计超过 trialSeconds+60 或窗口数 ≥3 就封顶。
       */
      if (!access.allow && access.trialSeconds > 0 && trialWanted) {
        const episode = loadEpisode()
        if (!episode) return fail(res, '0404', '该集不存在', 404)
        if ((!episode.hls_path && !episode.remote_url) || episode.status !== 'ready') return notReady(episode)
        // 试看清单只能从本地 HLS 目录截断；纯远端片源没有本地分片，直接给购买引导而不是发一张 404 的链接
        if (!episode.hls_path && episode.remote_url) {
          return send(res, {
            reason: 'trial_unavailable', code: 'trial_unavailable', gated: false,
            trialSeconds: 0, price: access.price ?? 0, purchaseKind: access.purchaseKind ?? null,
            message: '该片源暂不支持试看，购买后可看完整剧集',
          }, '0402', '该片源暂不支持试看', 402)
        }
        const subjectKind = userId ? 'user' : 'visitor'
        const subject = userId ? String(userId) : visitor.id
        const policyTrial = intOf(access.trialSeconds, 0, 1, 3600)
        // 访客单次封顶 15 秒（老口径），登录用户按剧的 trial_seconds
        const grantSeconds = Math.max(1, Math.min(policyTrial, userId ? 3600 : 15))
        const capSeconds = policyTrial + 60
        const budget = trialBudgetOf({ subjectKind, subject, dramaId })
        const usedSeconds = intOf(budget?.usedSeconds, 0, 0, 86400)
        const windows = intOf(budget?.windows, 0, 0, 1000)
        if (windows >= 3 || usedSeconds + grantSeconds > capSeconds) {
          logWarn('trial.exhausted', { requestId: res.getHeader?.('x-request-id'), subjectKind, dramaId, usedSeconds, windows })
          return send(res, {
            reason: 'trial_exhausted', code: 'trial_exhausted', gated: false,
            trialSeconds: 0, usedSeconds, windows, capSeconds,
            retryAfterSeconds: retrySecondsOf(5),
            price: access.price ?? 0, purchaseKind: access.purchaseKind ?? null,
            message: '本剧试看额度已用完，购买后可看完整剧集',
          }, '0402', '试看额度已用完', 402)
        }
        const fresh = await freshen(episode)
        if (fresh.reject) return sendReject(fresh.reject)
        const playable = fresh.episode
        const tracks = publicTracksOf(playable.id, lang)
        // 签名 TTL 覆盖整个试看窗口：秒数已进 scope，链接过期前都能拿到窗口内分片
        const trialTtl = Math.min(3600, Math.max(1, grantSeconds)) + 5
        // scope 里带秒数（防篡改），对外 URL 仍是 /media/trial/<id>/index.m3u8，秒数走 query
        const scope = `/media/trial/${playable.id}/${grantSeconds}/`
        // ua 必须显式传：handlePublic 里没有 res.req，缺省会签成 noua 与 index.mjs 的校验不一致
        const link = secureLinkScoped(res, scope, trialTtl, ua)
        const trialHls = `/media/trial/${playable.id}/index.m3u8?sign=${encodeURIComponent(link.sign)}&expires=${link.expires}&sec=${grantSeconds}`
        // 首次试看才下发访客 Cookie；必须排在 secureLinkScoped 之后（它会整块覆盖 set-cookie）
        if (visitor.fresh) appendSetCookie(res, visitorCookie(req, visitor.id))
        recordTrialUse({ subjectKind, subject, dramaId, episodeId: playable.id, secondsUsed: grantSeconds })
        recordPlay({ userId, visitorId, dramaId, episodeId: playable.id, episodeNo: no, source: 'trial', ip: clientIp(req), ua: req.headers['user-agent'] })
        let viewSession = null
        try {
          viewSession = startViewSession({
            userId, visitorId, contentId: dramaId, episodeId: playable.id, source: 'trial',
            duration: playable.duration, ip: clientIp(req), ua: req.headers['user-agent'],
          })
        } catch (error) {
          logWarn('content.view_session_failed', { requestId: res.getHeader?.('x-request-id'), userId, dramaId, error })
        }
        return send(res, {
          dramaId, title: drama.title, episodeId: playable.id, episodeStatus: playable.status,
          episode: { id: playable.id, no: playable.no, title: playable.title },
          source: 'trial', hls: trialHls, expiresIn: trialTtl, trialSeconds: grantSeconds,
          trialBudget: { usedSeconds: usedSeconds + grantSeconds, windows: windows + 1, capSeconds },
          danmu: [],
          viewSessionId: viewSession?.id ?? null, heartbeatIntervalSeconds: 15,
          viewThresholdSeconds: viewSession?.thresholdSeconds ?? 30, duration: Number(playable.duration ?? 0),
          ...tracks,
        })
      }
      if (!access.allow) {
        return send(res, {
          reason: access.reason,
          trialSeconds: access.trialSeconds ?? 0,
          price: access.price ?? 0,
          purchaseKind: access.purchaseKind ?? null,
          plans: access.plans ?? [],
          membership: access.membership ?? false,
        }, '0402', access.reason === 'single_purchase_required' ? '该片需单独购买' : '需要开通会员', 402)
      }
      const episode = loadEpisode()
      if (!episode) return fail(res, '0404', '该集不存在', 404)
      if ((!episode.hls_path && !episode.remote_url) || episode.status !== 'ready') return notReady(episode)
      // 权益已通过，才去探测/续期外部片源（未授权请求不替我们触发上游换票）
      const fresh = await freshen(episode)
      if (fresh.reject) return sendReject(fresh.reject)
      const playable = fresh.episode
      const tracks = publicTracksOf(playable.id, lang)
      const hlsPath = remotePlaybackPath(playable) ?? playable.hls_path ?? null
      // 有效期覆盖整集时长（否则 45 分钟一集在 5 分钟处断流），上限 MH_PLAY_TTL_MAX
      const duration = Number(playable.duration ?? 0)
      const playTtl = Math.min(PLAY_TTL_MAX, Math.max(LINK_TTL, duration > 0 ? duration + 300 : LINK_TTL))
      const link = hlsPath ? secureLink(hlsPath, playTtl, ua) : { url: null, sign: null, expires: 0 }
      if (hlsPath) setLinkCookies(res, link, playTtl, req, playable.id)
      recordPlay({ userId, visitorId, dramaId, episodeId: playable.id, episodeNo: no, source: 'play', ip: clientIp(req), ua: req.headers['user-agent'] })
      let viewSession = null
      try {
        viewSession = startViewSession({
          userId, visitorId, contentId: dramaId, episodeId: playable.id, source: access.source,
          duration: playable.duration, ip: clientIp(req), ua: req.headers['user-agent'],
        })
      } catch (error) {
        logWarn('content.view_session_failed', { requestId: res.getHeader?.('x-request-id'), userId, dramaId, error })
      }
      const danmu = all("SELECT time_ms, content FROM danmus WHERE episode_id = ? AND status = 'approved' ORDER BY time_ms", playable.id)
      // 续播：该用户在该集的已看进度；连播：下一集集号（同剧存在即给）
      const resume = userId
        ? one('SELECT position FROM history WHERE user_id = ? AND drama_id = ? AND episode_no = ?', userId, dramaId, no)
        : undefined
      const nextEp = one("SELECT no FROM episodes WHERE drama_id = ? AND no > ? AND status != 'merged' ORDER BY no LIMIT 1", dramaId, no)
      return send(res, {
        dramaId, title: drama.title, episodeId: playable.id, episodeStatus: playable.status,
        episode: { id: playable.id, no: playable.no, title: playable.title },
        source: access.source,
        hls: hlsPath,
        expiresIn: playTtl,
        viewSessionId: viewSession?.id ?? null,
        heartbeatIntervalSeconds: 15,
        viewThresholdSeconds: viewSession?.thresholdSeconds ?? 30,
        duration: Number(playable.duration ?? 0),
        trialSeconds: 0,
        resumePosition: Number(resume?.position ?? 0),
        nextEpisodeNo: nextEp ? nextEp.no : null,
        danmu: danmu.map((row) => ({ time: row.time_ms, text: row.content })),
        ...tracks,
      })
    }

    /* ---------- 套餐 / 优惠券 / 下单 ---------- */
    if (pathname === '/api/plans') {
      const plans = all("SELECT * FROM plans WHERE status = 'active' ORDER BY sort").map((plan) => ({
        id: plan.id, code: plan.code, name: plan.name, price: plan.price_cny,
        days: plan.duration_days, scope: plan.scope, description: plan.description,
      }))
      return send(res, { plans, currency: 'CNY' })
    }

    if (pathname === '/api/coupons/validate' && method === 'POST') {
      const body = await readBody(req)
      // 金额一定要是确定整数分：Number('abc') 进券判定会变成 NaN 比较
      return send(res, validateCoupon(body.code, intOf(Math.round(Number(body.amount ?? 0)), 0, 0, 100000000)))
    }

    if (pathname === '/api/orders' && method === 'POST') {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      const body = await readBody(req)
      // 不传 channel 时由后端按"场景默认渠道"解析（后台可切换默认渠道）
      const channel = body.channel ?? undefined
      const result = createOrder({
        userId,
        visitorId,
        productType: body.productType === 'single' ? 'single' : 'subscription',
        planId: intOf(body.planId, 0, 1, Number.MAX_SAFE_INTEGER) || undefined,
        dramaId: intOf(body.dramaId, 0, 1, Number.MAX_SAFE_INTEGER) || undefined,
        channel,
        couponCode: body.couponCode,
        ip: clientIp(req),
        ua: req.headers['user-agent'],
      })
      // 模拟收银台是独立标签页，带不了 Bearer → 用一次性票据换取支付权限
      const simTicket = result.payUrl && result.simulated ? signPayTicket(result.order.out_trade_no) : null
      return send(res, {
        outTradeNo: result.order.out_trade_no,
        amount: result.order.amount_cny,
        channel: result.order.channel,
        status: result.order.status,
        statusLabel: enumLabel(lang, 'orderStatus', result.order.status),
        expiresAt: result.order.expires_at,
        payUrl: simTicket ? `${result.payUrl}?ticket=${encodeURIComponent(simTicket)}` : result.payUrl,
        simulated: result.simulated ?? false,
        usdt: result.usdt ?? null,
      })
    }

    if (pathname === '/api/orders' && method === 'GET') {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      return send(res, {
        list: listOrders({ userId, limit: 50 }).map((row) => ({
          ...orderDto(row),
          statusLabel: enumLabel(lang, 'orderStatus', row.status),
        })),
      })
    }

    if (pathname.startsWith('/api/orders/')) {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      const outTradeNo = pathname.split('/')[3]
      let order = one('SELECT * FROM orders WHERE out_trade_no = ? AND user_id = ?', outTradeNo, userId)
      if (!order) return fail(res, '0404', '订单不存在', 404)
      // 支付宝查单兜底：回调可能丢失，轮询时主动向渠道确认一次
      if (order.channel === 'alipay' && ['created', 'pending'].includes(order.status)) {
        const sync = await syncAlipayOrder(outTradeNo).catch(() => ({ synced: false }))
        if (sync.synced) order = one('SELECT * FROM orders WHERE id = ?', order.id)
      }
      const payable = payUrlFor(order)
      // 模拟收银台在独立标签页打开，拿不到 Bearer：给订单签一张短时票据放进 payUrl
      const simTicket = payable.payUrl && payable.simulated ? signPayTicket(order.out_trade_no) : null
      const payUrl = simTicket ? `${payable.payUrl}?ticket=${encodeURIComponent(simTicket)}` : payable.payUrl
      return send(res, {
        outTradeNo: order.out_trade_no, status: order.status,
        statusLabel: enumLabel(lang, 'orderStatus', order.status), amount: order.amount_cny,
        channel: order.channel, paidAt: order.paid_at, expiresAt: order.expires_at,
        payUrl, simulated: Boolean(payable.simulated), payReason: payable.reason ?? null,
        usdt: order.usdt_amount ? {
          amount: order.usdt_amount, rate: order.usdt_rate, address: order.usdt_address, confirmations: order.usdt_confirmations,
        } : null,
      })
    }

    /* ---------- 支付回调 ---------- */
    if (pathname === '/api/notify/alipay' && method === 'POST') {
      // 回调在 OPEN_PATHS 上、没有登录态：必须自己限体积与耗时，否则慢速大包能把连接拖死
      const maxBytes = intOf(process.env.MH_NOTIFY_MAX_BYTES, 64 * 1024, 1024, 4 * 1024 * 1024)
      let raw = ''
      try {
        raw = (await readRawBody(req, maxBytes, { message: '回调请求体过大', timeoutMs: 8000 })).toString('utf8')
      } catch (error) {
        logWarn('notify.alipay_body_rejected', { code: error.code ?? 'unknown', message: error.message })
        // 支付宝只认纯文本：这里也必须回 text/plain，超限 413、超时 408
        res.writeHead(intOf(error.status, 413, 400, 500), { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        return res.end('failure')
      }
      const params = Object.fromEntries(new URLSearchParams(raw))
      // 支付宝只认纯文本 success：任何 JSON 信封（含异常被外层兜成信封）都会触发 25 小时重试
      let ok = false
      try {
        ok = handleAlipayNotify(params)?.code === '0000'
      } catch (error) {
        console.warn('[notify/alipay]', error?.message ?? error)
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(ok ? 'success' : 'failure')
    }

    /* USDT 只走进程内链上监听（usdt-watch.mjs），不提供公网回调入口 */

    /* 模拟支付：仅本地/联调可用（MH_ALLOW_SIM_PAY=1），只能是本人订单或用支付票据（sim 收银台在独立标签页，带不了 Bearer） */
    const simPayEnabled = process.env.MH_ALLOW_SIM_PAY === '1'
    const ownOrder = (outTradeNo) => {
      const row = one('SELECT id, user_id FROM orders WHERE out_trade_no = ?', String(outTradeNo ?? ''))
      if (!row) return false
      return Number(row.user_id) === Number(userId)
    }
    const mayPay = (body) => ownOrder(body.outTradeNo) || verifyPayTicket(body.outTradeNo, body.ticket)

    if (pathname === '/api/pay/mock' && method === 'POST') {
      if (!simPayEnabled) return fail(res, '0404', '接口不存在', 404)
      const body = await readBody(req)
      if (!mayPay(body)) return fail(res, '0403', '支付票据无效或已过期', 403)
      return send(res, mockPay(body.outTradeNo))
    }

    /* 支付宝模拟收银台：用真实 RSA2 签名通知 → 走同一套验签入账 */
    if (pathname.startsWith('/api/pay/alipay-sim') && method === 'POST') {
      if (!simPayEnabled) return fail(res, '0404', '接口不存在', 404)
      const body = await readBody(req)
      if (!mayPay(body)) return fail(res, '0403', '支付票据无效或已过期', 403)
      const { params } = buildSimulatedAlipayNotify(body.outTradeNo)
      const result = handleAlipayNotify(params, { simulator: true })
      return send(res, { ...result, simulated: true })
    }

    /* 消息中心：订单/权益/到期提醒 */
    if (pathname === '/api/me/messages') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const messages = []
      // 会员提醒：优先取仍在有效期内的一条；确实过期了就明说已到期，而不是显示「剩 -30 天」
      const subscription = one(`SELECT s.*, p.name AS plan_name FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = ? AND s.status IN ('active', 'expired')
        ORDER BY (datetime(s.valid_to) > datetime('now')) DESC, datetime(s.valid_to) DESC LIMIT 1`, userId)
      if (subscription) {
        const iso = String(subscription.valid_to ?? '').trim().replace(' ', 'T')
        const validToMs = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime()
        const expired = !Number.isFinite(validToMs) || validToMs <= Date.now()
        // 剩余天数不能是负数：过期一律夹 0，状态由 expired 表达
        const daysLeft = Number.isFinite(validToMs) ? Math.max(0, Math.ceil((validToMs - Date.now()) / 86400000)) : 0
        messages.push({
          type: 'subscription',
          status: expired ? 'expired' : 'active',
          title: expired ? '会员已到期' : '会员生效中',
          body: expired
            ? `${subscription.plan_name ?? '会员'}，已于 ${subscription.valid_to} 到期，续费后继续观看`
            : `${subscription.plan_name ?? '会员'}，有效期至 ${subscription.valid_to}${daysLeft <= 7 ? `（剩 ${daysLeft} 天，建议续费）` : ''}`,
          daysLeft,
          validTo: subscription.valid_to,
          createdAt: subscription.created_at,
        })
      }
      const ORDER_STATUS_TEXT = {
        created: '待支付', pending: '支付确认中', paid: '已支付', fulfilled: '已完成',
        closed: '已关闭', failed: '支付失败', refunded: '已退款', refunding: '退款中', refund_pending: '退款待审',
      }
      for (const order of listOrders({ userId, limit: 5 })) {
        messages.push({
          type: 'order', title: `订单 ${order.out_trade_no}`,
          body: `${order.product_type === 'subscription' ? '会员订阅' : '一次性购买'} ¥${Number(order.amount_cny).toFixed(2)} · ${ORDER_STATUS_TEXT[order.status] ?? order.status}`,
          createdAt: order.created_at,
        })
      }
      return send(res, { messages })
    }

    /* ---------- 邮箱验证码认证（登录/注册一体） ---------- */
    if (pathname === '/api/auth/email/send' && method === 'POST') {
      const body = await readBody(req)
      let result
      try {
        result = await sendCode({
          email: body.email,
          purpose: 'login',
          ip: clientIp(req),
          userAgent: req.headers['user-agent'],
        })
      } catch (error) {
        const limited = otpLimitReply(res, error, { email: normalizeEmail(body.email) })
        if (limited) return send(res, limited.data, limited.code, limited.message, limited.status)
        throw error
      }
      // 明文验证码只在「测试钩子开启 + 请求来自回环地址」时回显；反代后面只看 socket 对端地址
      const echoTestCode = Boolean(result.testCode) && otpTestHookEnabled() && isLoopback(req)
      return send(res, {
        email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter,
        delivered: result.delivered,
        ...(echoTestCode ? { testCode: result.testCode } : {}),
      })
    }

    if (pathname === '/api/auth/email/login' && method === 'POST') {
      const body = await readBody(req)
      verifyCode({ email: body.email, purpose: 'login', code: body.code })
      const result = loginByEmail(body.email, { nickname: body.nickname })
      let acquisitionBonded = false
      let distributionBonded = false
      if (result.created) {
        try {
          acquisitionBonded = Boolean(bindUserAcquisition({ userId: result.user.id, visitorId }))
        } catch (error) {
          logWarn('auth.acquisition_bind_failed', { requestId: res.getHeader?.('x-request-id'), userId: result.user.id, error })
        }
        const referralCode = body.referralCode ?? cookieValue(req, 'mh_ref')
        if (referralCode) {
          try {
            distributionBonded = Boolean(bindReferral({ userId: result.user.id, visitorId, code: referralCode }))
          } catch (error) {
            logWarn('auth.distribution_bind_failed', { requestId: res.getHeader?.('x-request-id'), userId: result.user.id, code: error.code ?? 'invalid', error })
          }
        }
      }
      return send(res, {
        token: result.token,
        expiresAt: result.expiresAt,
        created: result.created,
        acquisitionBonded,
        distributionBonded,
        user: publicUser(result.user),
      })
    }

    // 邮箱 + 密码登录：已经设置过密码的用户在邮件通道异常时仍可登录
    if (pathname === '/api/auth/email/password' && method === 'POST') {
      const body = await readBody(req)
      const email = normalizeEmail(body.email)
      const ip = clientIpOf(req)
      // 失败计数/锁定与后台登录同一套（ratelimit.mjs）：否则只有 auth 30/60s/IP 的桶，
      // 单 IP 一天约 4.3 万次就能在线撞库
      const locked = await loginLockSeconds(email, ip)
      if (locked > 0) {
        const retryAfterSeconds = Math.max(4, Math.ceil(locked))
        logWarn('auth.password_locked', { requestId: res.getHeader?.('x-request-id'), emailTag: tagOf(email), ip, retryAfterSeconds })
        res.setHeader('retry-after', String(retryAfterSeconds))
        return send(res, { code: 'login_locked', retryAfterSeconds }, '0429', '尝试次数过多，请稍后再试', 429)
      }
      const user = one('SELECT * FROM users WHERE email = ?', email)
      const passed = user?.password_hash
        ? await verifyPasswordAsync(String(body.password ?? ''), user.password_salt ?? null, user.password_hash)
        : false
      if (!user || !passed) {
        const left = await noteLoginFailure(email, ip)
        logWarn('auth.password_failed', {
          requestId: res.getHeader?.('x-request-id'), emailTag: tagOf(email), ip,
          hasUser: Boolean(user), left,
        })
        return fail(res, '0401', '邮箱或密码不正确', 401)
      }
      if (user.status && user.status !== 'active') return fail(res, '0403', '账号已被停用', 403)
      await clearLoginFailures(email, ip)
      const result = loginByEmail(email)
      return send(res, { token: result.token, expiresAt: result.expiresAt, created: false, user: publicUser(result.user) })
    }

    // 手机号登录已下线（系统统一走邮箱验证码）
    if (pathname === '/api/auth/login' && method === 'POST') {
      return fail(res, '0410', '系统已改为邮箱验证码登录，请使用 /api/auth/email/send', 410)
    }

    /* ---------- 修改密码 ---------- */
    if (pathname === '/api/auth/password/send' && method === 'POST') {
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      if (!user?.email) return fail(res, '0400', '当前账号未绑定邮箱', 400)
      const body = await readBody(req)
      const email = normalizeEmail(body.email ?? user.email)
      if (email !== user.email) return fail(res, '0403', '只能向注册邮箱发送验证码', 403)
      let result
      try {
        result = await sendCode({ email, purpose: 'change_password', ip: clientIp(req), userAgent: req.headers['user-agent'] })
      } catch (error) {
        const limited = otpLimitReply(res, error, { email })
        if (limited) return send(res, limited.data, limited.code, limited.message, limited.status)
        throw error
      }
      return send(res, { email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter })
    }

    if (pathname === '/api/auth/password/change' && method === 'POST') {
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      const body = await readBody(req)
      if (String(body.email ?? '').trim().toLowerCase() !== user?.email) {
        return fail(res, '0403', '邮箱与当前账号不一致', 403)
      }
      // 先校验口令强度，再消费验证码：避免"密码不合规"把验证码浪费掉
      const strength = checkPasswordStrength(body.newPassword)
      if (!strength.ok) return fail(res, 'password_weak', strength.message, 400)
      verifyCode({ email: user.email, purpose: 'change_password', code: body.code })
      setUserPassword(userId, body.newPassword)
      // 改密后吊销该账号此前签发的全部会话，避免旧 token 继续可用
      revokeSessions(userId, 'user')
      const fresh = issueToken(userId, 'user')
      return send(res, { ok: true, message: '密码已更新，其他设备需重新登录', token: fresh.token, expiresAt: fresh.expiresAt })
    }

    /* ---------- 更换邮箱：新邮箱验证码 + 旧邮箱验证码 + 当前口令 ---------- */
    // 旧邮箱收码（换绑的第一步）。两个地址各用 change_email 用途，行按 email 分键，互不覆盖。
    if (pathname === '/api/auth/email/send-current' && method === 'POST') {
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      if (!user?.email) return fail(res, '0400', '当前账号未绑定邮箱', 400)
      let result
      try {
        result = await sendCode({ email: user.email, purpose: 'change_email', ip: clientIp(req), userAgent: req.headers['user-agent'] })
      } catch (error) {
        const limited = otpLimitReply(res, error, { email: user.email })
        if (limited) return send(res, limited.data, limited.code, limited.message, limited.status)
        throw error
      }
      // 明文码只在测试钩子 + 回环地址下回显（与 /api/auth/email/send 同口径）
      const echoTestCode = Boolean(result.testCode) && otpTestHookEnabled() && isLoopback(req)
      return send(res, {
        email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter,
        ...(echoTestCode ? { testCode: result.testCode } : {}),
      })
    }

    if (pathname === '/api/auth/email/send-change' && method === 'POST') {
      const body = await readBody(req)
      const newEmail = normalizeEmail(body.newEmail ?? body.email)
      const taken = one('SELECT id FROM users WHERE email = ? AND id != ?', newEmail, userId)
      if (taken) return fail(res, '0409', '该邮箱已被其他账号使用', 409)
      let result
      try {
        result = await sendCode({ email: newEmail, purpose: 'change_email', ip: clientIp(req), userAgent: req.headers['user-agent'] })
      } catch (error) {
        const limited = otpLimitReply(res, error, { email: newEmail })
        if (limited) return send(res, limited.data, limited.code, limited.message, limited.status)
        throw error
      }
      return send(res, { email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter })
    }

    if (pathname === '/api/auth/email/change' && method === 'POST') {
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      if (!user?.email) return fail(res, '0400', '当前账号未绑定邮箱', 400)
      const body = await readBody(req)
      const newEmail = normalizeEmail(body.newEmail ?? body.email)
      const code = String(body.code ?? '').trim()
      const oldCode = String(body.oldCode ?? '').trim()
      const password = String(body.password ?? '')
      // 三要素缺一不可：只验新邮箱码等于拿到会话就能把账号换走（接管）
      if (!code) return fail(res, 'new_code_required', '请填写新邮箱验证码', 400)
      if (!oldCode) return fail(res, 'old_code_required', '请填写当前邮箱验证码', 400)
      if (!password) return fail(res, 'password_required', '请填写当前登录密码', 400)
      if (!user.password_hash) return fail(res, 'password_not_set', '当前账号尚未设置密码，请先设置密码后再换绑邮箱', 409)
      if (newEmail === user.email) return fail(res, 'email_unchanged', '新邮箱与当前邮箱相同', 400)
      const taken = one('SELECT id FROM users WHERE email = ? AND id != ?', newEmail, userId)
      if (taken) return fail(res, '0409', '该邮箱已被其他账号使用', 409)
      const passed = await verifyPasswordAsync(password, user.password_salt ?? null, user.password_hash)
      if (!passed) {
        const left = await noteLoginFailure(user.email, clientIpOf(req))
        logWarn('auth.email_change_password_failed', { requestId: res.getHeader?.('x-request-id'), userId, left })
        return fail(res, 'password_invalid', '当前登录密码不正确', 401)
      }
      try {
        verifyCode({ email: user.email, purpose: 'change_email', code: oldCode })
      } catch (error) {
        if (error?.code === 'code_invalid' || error?.code === 'code_expired' || error?.code === 'code_missing') {
          return fail(res, 'old_code_invalid', '当前邮箱验证码不正确或已过期', 400)
        }
        throw error
      }
      verifyCode({ email: newEmail, purpose: 'change_email', code })
      const updated = changeUserEmail(userId, newEmail)
      revokeSessions(userId, 'user')
      const fresh = issueToken(userId, 'user')
      return send(res, { ok: true, user: publicUser(updated), token: fresh.token, expiresAt: fresh.expiresAt })
    }

    /* ---------- 个人中心 ---------- */
    if (pathname === '/api/me/profile' && method === 'PUT') {
      const body = await readBody(req)
      const updated = updateProfile(userId, body)
      return send(res, { ok: true, user: publicUser(updated) })
    }

    if (pathname === '/api/me/avatar' && method === 'POST') {
      const rawType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      let buffer
      if (['image/png', 'image/jpeg', 'image/webp'].includes(rawType)) {
        try {
          buffer = await readRawBody(req, AVATAR_MAX_BYTES, { message: '头像不能超过 1MB' })
        } catch (error) {
          return fail(res, error.code ?? '0400', error.message ?? '头像上传失败', error.status ?? 400)
        }
      } else {
        const body = await readBody(req)
        const dataUrl = String(body.dataUrl ?? '')
        const match = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
        if (!match) return fail(res, '0400', '头像格式需为 PNG / JPEG / WebP', 400)
        buffer = Buffer.from(match[3], 'base64')
      }
      if (!buffer?.length) return fail(res, '0400', '头像内容为空', 400)
      // 超限必须在落盘前拦下：静默截断会存进半张图
      if (buffer.length > AVATAR_MAX_BYTES) return fail(res, '0413', '头像不能超过 1MB', 413)
      // 魔数说了算：Content-Type 与 data: 前缀都是客户端声明，改一个字就绕过扩展名白名单
      const kind = imageKindOf(buffer)
      if (!kind) return fail(res, '0400', '头像需为 PNG / JPEG / WebP 图片', 400)
      const dir = join(ROOT, 'storage', 'images', 'avatars')
      mkdirSync(dir, { recursive: true })
      // 文件名用内容哈希：重复上传同一张图不涨盘，也不给猜文件名的机会
      const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 24)
      const name = `avatar-${userId}-${digest}.${kind}`
      writeFileSync(join(dir, name), buffer)
      // 单用户只保留一张：落盘成功后删掉该用户的其它头像（历史 avatar-<id>-*.ext）
      for (const file of readdirSync(dir)) {
        if (file !== name && file.startsWith(`avatar-${userId}-`)) {
          try { rmSync(join(dir, file), { force: true }) } catch { /* 旧文件清理失败不影响本次上传 */ }
        }
      }
      const avatar = `/media/images/avatars/${name}`
      const updated = updateProfile(userId, { avatar })
      return send(res, { ok: true, avatar, user: publicUser(updated) })
    }

    /* 弹幕：发送后进入待审，审核通过才展示 */
    if (pathname === '/api/danmu' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const episodeId = intOf(body.episodeId, 0, 0, Number.MAX_SAFE_INTEGER)
      if (!episodeId) return fail(res, '0404', '分集不存在', 404)
      // 只认已上架剧目的真实分集：不校验就能往未上架/已删的集里灌弹幕
      const episode = one(`SELECT e.id, e.no FROM episodes e JOIN dramas d ON d.id = e.drama_id
        WHERE e.id = ? AND e.status != 'merged' AND d.status = 'published'`, episodeId)
      if (!episode) return fail(res, '0404', '分集不存在', 404)
      const content = String(body.content ?? '').trim().slice(0, 60)
      if (!content) return fail(res, '0400', '弹幕内容不能为空', 400)
      db.prepare("INSERT INTO danmus (episode_id, user_id, time_ms, content, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(episode.id, userId, intOf(Math.round(Number(body.timeMs ?? 0)), 0, 0, 86400000), content)
      return send(res, { ok: true, status: 'pending', message: '已提交，审核通过后展示' })
    }

    /* 行为埋点：匿名的曝光/详情也收，用于算漏斗上游（只收白名单类型） */
    if (pathname === '/api/track' && method === 'POST') {
      const body = await readBody(req)
      if (!isClientTrackType(body.type) && ['order_created', 'payment_success'].includes(body.type)) {
        return fail(res, '0403', '交易事件只允许服务端记录', 403)
      }
      // 搜索埋点去重：同一主体（登录用户/访客）同关键词 10 分钟只记一次。
      // 不然匿名换个 visitor 反复 POST 就能把 /api/rank 的搜索榜刷成任意词。
      const trackType = String(body.type ?? '')
      if (/search/i.test(trackType)) {
        const subject = userId ? `u:${userId}` : `v:${visitorId}`
        const keyword = body.term ?? body.keyword ?? body.value ?? body.meta?.keyword ?? ''
        if (!searchTrackFresh(subject, keyword)) return send(res, { ok: true, deduped: true })
      }
      const ok = recordEvent({
        type: body.type, userId, visitorId: body.visitorId ?? visitorId, dramaId: body.dramaId, episodeId: body.episodeId,
        path: body.path ?? body.term, value: body.value, position: body.position, duration: body.duration,
        meta: body.meta, ip: clientIp(req), ua: req.headers['user-agent'],
        // 明细字段：账号由服务端按 userId 查，客户端只补它自己才知道的（页面地址、停留、点击文案）
        pageUrl: body.pageUrl, eventCode: body.eventCode, eventType: body.eventType, eventOp: body.eventOp,
        action: body.action, description: body.description, stayMs: body.stayMs,
      })
      return send(res, { ok })
    }

    if (pathname === '/api/me') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      const { subscription, purchases } = entitlementsOf(userId)
      const history = all(`SELECT h.*, d.title, d.cover_url FROM history h JOIN dramas d ON d.id = h.drama_id
        WHERE h.user_id = ? ORDER BY h.updated_at DESC LIMIT 12`, userId)
      const favorites = all(`SELECT d.* FROM favorites f JOIN dramas d ON d.id = f.drama_id WHERE f.user_id = ? ORDER BY f.created_at DESC`, userId)
      const favoritesCtx = cardContext(context, favorites)
      return send(res, {
        user: publicUser(user),
        subscription: subscription ? { planId: subscription.plan_id, scope: subscription.scope, validTo: subscription.valid_to } : null,
        purchases: purchases.map((row) => ({ dramaId: row.drama_id, title: row.title, kind: row.kind, expiresAt: row.expires_at })),
        history: history.map((row) => ({ dramaId: row.drama_id, episode: row.episode_no, position: row.position, title: row.title, coverUrl: row.cover_url })),
        favorites: favorites.map((drama) => cardOf(drama, userId, favoritesCtx)),
        completion: profileCompletion(user),
      })
    }

    if (pathname === '/api/me/track-preferences' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const dramaId = Number(url.searchParams.get('dramaId'))
      if (!Number.isInteger(dramaId) || dramaId <= 0) return fail(res, '0400', 'dramaId 无效', 400)
      return send(res, userTrackPreferences(userId, dramaId))
    }

    if (pathname === '/api/me/track-preferences' && method === 'PUT') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      try {
        const saved = saveUserTrackPreference({ ...body, userId })
        return send(res, saved)
      } catch (error) {
        if (error?.name === 'TrackError') {
          return fail(res, error.status === 404 ? '0404' : '0400', error.message, error.status)
        }
        throw error
      }
    }

    if (pathname === '/api/me/history' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const dramaId = intOf(body.seasonId ?? body.dramaId, 0, 0, Number.MAX_SAFE_INTEGER)
      if (!dramaId) return fail(res, '0400', 'dramaId 无效', 400)
      // 进度只写已上架剧目的真实分集：不校验就能往任意 id 塞垃圾进度、把冷启动推荐污染掉
      const drama = one("SELECT id FROM dramas WHERE id = ? AND status = 'published'", dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)
      const episodeNo = intOf(body.episode, 1, 1, 100000)
      const episode = one('SELECT id FROM episodes WHERE drama_id = ? AND no = ?', dramaId, episodeNo)
      if (!episode) return fail(res, '0404', '分集不存在', 404)
      db.prepare(`INSERT INTO history (user_id, drama_id, episode_no, position) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, drama_id) DO UPDATE SET episode_no = excluded.episode_no,
        position = excluded.position, updated_at = datetime('now')`)
        .run(userId, dramaId, episodeNo, intOf(Math.round(Number(body.position ?? 0)), 0, 0, 86400))
      return send(res, { ok: true })
    }

    if (pathname === '/api/me/favorite' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const dramaId = intOf(body.seasonId ?? body.dramaId, 0, 0, Number.MAX_SAFE_INTEGER)
      const favoriteDrama = one("SELECT id FROM dramas WHERE id = ? AND status = 'published'", dramaId)
      if (!favoriteDrama) return fail(res, '0404', '内容不存在', 404)
      return send(res, toggleFavorite({ userId, contentId: dramaId, requestId: body.requestId }))
    }

    return fail(res, '0404', '接口不存在', 404)
  } catch (error) {
    if (error instanceof OtpError) return send(res, { ...error.extra }, error.code, error.message, error.status)
    if (error instanceof CommerceError) return fail(res, error.code, error.message, error.status)
    if (error?.status === 413) {
      res.setHeader('connection', 'close')
      return fail(res, error.code ?? '0413', error.message ?? '请求体过大', 413)
    }
    if (error?.status && error?.code) return fail(res, error.code, error.message, error.status)
    if (error?.code === 'password_weak' || error?.code === 'email_taken' || error?.code === 'user_banned' || error?.code === 'avatar_invalid') {
      return fail(res, error.code, error.message, 400)
    }
    logError('public.exception', { requestId: res.getHeader?.('x-request-id'), method: req.method, path: pathname, userId, error })
    return fail(res, '0500', '服务器错误', 500)
  }
}

export { markPaid }

