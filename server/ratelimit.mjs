/**
 * 反爬与限流（防抓取、防刷验证码、防批量拉取内容）。
 *
 * 三层：
 * 1) 滑动窗口限流：按 IP + 路由类别，超限返回 429 + Retry-After
 * 2) UA 黑名单：脚本库/爬虫客户端直接 403（浏览器引擎放宽，避免误伤正常用户与自有巡检）
 * 3) 枚举探测：同一 IP 60 秒内访问过多不同内容 ID，判定为批量抓取 → 403 并留痕
 *
 * 计数优先走 Redis（多实例共享、重启不丢），Redis 不可用时自动退回进程内内存，功能不降级。
 * 所有拦截写入 security_events，后台「审计日志 → 安全事件」可查。
 */
import { randomUUID } from 'node:crypto'
import { db } from './db.mjs'
import { cmd, key, redisReady, redisStatus } from './redis.mjs'

const BUCKETS = new Map()      // key -> number[]（时间戳）
const ENUM = new Map()         // ip -> { ids:Set, ts:number }
const FAILS = new Map()        // username/ip -> { count, resetAt }
const COUNTERS = { blocked: 0, rateLimited: 0, uaBlocked: 0, enumBlocked: 0, logins: 0, since: new Date().toISOString() }

const RULES = [
  { name: 'auth-send', match: (path) => /^\/api\/auth\/(email\/send|password\/send|email\/send-change)$/.test(path), limit: 10, window: 60_000 },
  { name: 'auth', match: (path) => path.startsWith('/api/auth/') || path.startsWith('/admin/api/login'), limit: 30, window: 60_000 },
  { name: 'pay', match: (path) => path.startsWith('/api/pay/') || path.startsWith('/api/orders') || path.startsWith('/api/notify/'), limit: 40, window: 60_000 },
  { name: 'play', match: (path) => path.startsWith('/api/play/') || path.startsWith('/api/drama/'), limit: 120, window: 60_000 },
  { name: 'media', match: (path) => path.startsWith('/media/'), limit: 600, window: 60_000 },
  { name: 'api-write', match: (path, method) => method !== 'GET' && path.startsWith('/api/'), limit: 60, window: 60_000 },
  { name: 'api', match: (path) => path.startsWith('/api/'), limit: 400, window: 60_000 },
  { name: 'admin', match: (path) => path.startsWith('/admin/api/'), limit: 240, window: 60_000 },
]

const UA_BLOCK = /(python-requests|python-urllib|scrapy|aiohttp|httpx|curl\/|wget\/|go-http-client|java\/|libwww-perl|apache-httpclient|node-fetch|axios\/)/i
// 播放器 UA 放行：原生播放器、TV 盒子、部分 WebView 不带 UA 或带 okhttp/ExoPlayer
const PLAYER_UA_ALLOW = /(exoplayer|ijkplayer|vlc|lavf|stagefright|android|iphone|ipad|applecoremedia|hls\.js|avplayer|mxplayer|okhttp)/i
const UA_EMPTY_ALLOW = /^$/

const LOGIN_MAX_FAILS = 5
const LOGIN_MAX_FAILS_GLOBAL = 30
const LOGIN_LOCK_SECONDS = 600

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1'
}

/**
 * 解析真实客户端 IP。
 *
 * 只有「连接本身来自本机」（即 nginx 反代）时才相信转发头：
 * - 优先 X-Real-IP（nginx 用 $remote_addr 覆盖写，客户端改不了）
 * - 其次 X-Forwarded-For 的**最后一段**（nginx $proxy_add_x_forwarded_for 把真实 IP 追加在末尾；
 *   攻击者能在前面塞任意值，所以绝不能取第一段）
 * - 直连（socket 非回环）一律用 socket 地址，转发头完全忽略
 */
export function clientInfoOf(req) {
  const socketIp = req.socket?.remoteAddress ?? 'unknown'
  if (!isLoopback(socketIp)) return { ip: socketIp, viaProxy: false }

  const real = req.headers['x-real-ip']
  if (real) {
    const value = String(real).split(',')[0].trim()
    if (value) return { ip: value, viaProxy: true }
  }
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) {
    const parts = String(forwarded).split(',').map((item) => item.trim()).filter(Boolean)
    if (parts.length > 0) return { ip: parts[parts.length - 1], viaProxy: true }
  }
  return { ip: socketIp, viaProxy: false }
}

export function clientIpOf(req) {
  return clientInfoOf(req).ip
}

function record(kind, ip, path, ua, detail) {
  COUNTERS.blocked += 1
  if (kind === 'rate_limit') COUNTERS.rateLimited += 1
  if (kind === 'bad_ua') COUNTERS.uaBlocked += 1
  if (kind === 'enumeration') COUNTERS.enumBlocked += 1
  try {
    db.prepare('INSERT INTO security_events (kind, ip, path, ua, detail) VALUES (?, ?, ?, ?, ?)')
      .run(kind, ip, String(path).slice(0, 200), String(ua ?? '').slice(0, 200), String(detail ?? '').slice(0, 300))
  } catch { /* 留痕失败不影响主流程 */ }
}

/* ---------------- 计数：Redis 优先，内存兜底 ---------------- */

async function hitRedis(bucketKey, window, member) {
  if (!redisReady()) return null
  const now = Date.now()
  const target = key(bucketKey)
  const results = await Promise.all([
    cmd('ZREMRANGEBYSCORE', target, 0, now - window),
    cmd('ZADD', target, now, member),
    cmd('ZCARD', target),
    cmd('PEXPIRE', target, window),
  ])
  if (results.some((value) => value === null)) return null
  return Number(results[2] ?? 0)
}

function hitMemory(bucketKey, window, now) {
  const hits = (BUCKETS.get(bucketKey) ?? []).filter((ts) => now - ts < window)
  hits.push(now)
  BUCKETS.set(bucketKey, hits)
  return hits.length
}

async function countDistinct(enumKey, id, windowSeconds) {
  if (redisReady()) {
    const target = key(enumKey)
    const results = await Promise.all([
      cmd('SADD', target, id),
      cmd('SCARD', target),
      cmd('EXPIRE', target, windowSeconds),
    ])
    if (!results.some((value) => value === null)) return Number(results[1] ?? 0)
  } else {
    await Promise.resolve()
  }
  const now = Date.now()
  const state = ENUM.get(enumKey) ?? { ids: new Set(), ts: now }
  if (now - state.ts > windowSeconds * 1000) { state.ids = new Set(); state.ts = now }
  state.ids.add(id)
  ENUM.set(enumKey, state)
  return state.ids.size
}

/** 返回 { blocked, status, reason, retryAfter } */
export async function inspect(req, pathname, method) {
  const { ip, viaProxy } = clientInfoOf(req)
  const ua = req.headers['user-agent'] ?? ''

  // 仅「本机直连」（健康检查 / 内部脚本）完全放行；
  // 经反代的请求即使解析出回环地址也照常走 UA 与限流，避免伪造转发头关掉防护
  if (!viaProxy && isLoopback(ip)) return { blocked: false }

  // 1) UA 黑名单
  //    /api/ 严格：空 UA 与脚本客户端一律拦
  //    /media/ 宽松：放行原生播放器与空 UA（TV/盒子），避免正常用户看不了片
  const isMedia = pathname.startsWith('/media/')
  if (pathname.startsWith('/api/') || isMedia) {
    const playerAllowed = isMedia && (UA_EMPTY_ALLOW.test(ua) || PLAYER_UA_ALLOW.test(ua))
    if (!playerAllowed && (UA_EMPTY_ALLOW.test(ua) || UA_BLOCK.test(ua))) {
      record('bad_ua', ip, pathname, ua, ua ? 'suspicious client' : 'empty user-agent')
      return { blocked: true, status: 403, reason: 'automated_access_denied' }
    }
  }

  // 2) 内容枚举探测（批量抓剧集/播放）——先于窗口限流判定，
  //    否则扫描者会先撞速率上限拿到 429，永远触发不了枚举拦截（403）
  const idMatch = /^\/(?:api\/(?:drama|play|access))\/(\d+)/.exec(pathname)
  if (idMatch) {
    const bucket = Math.floor(Date.now() / 60_000)
    const distinct = await countDistinct(`enum:${ip}:${bucket}`, idMatch[1], 90)
    if (distinct > 40) {
      record('enumeration', ip, pathname, ua, `distinct content ids=${distinct} in 60s`)
      return { blocked: true, status: 403, reason: 'enumeration_denied' }
    }
  }

  // 3) 滑动窗口限流
  const rule = RULES.find((item) => item.match(pathname, method))
  if (!rule) return { blocked: false }

  const now = Date.now()
  const bucketKey = `${rule.name}:${ip}`
  const member = `${now}-${randomUUID().slice(0, 8)}`
  const count = (await hitRedis(bucketKey, rule.window, member)) ?? hitMemory(bucketKey, rule.window, now)
  if (count > rule.limit) {
    record('rate_limit', ip, pathname, ua, `${rule.name} ${count}/${rule.limit} per ${rule.window / 1000}s`)
    return { blocked: true, status: 429, reason: 'too_many_requests', retryAfter: Math.ceil(rule.window / 1000) }
  }

  return { blocked: false }
}

/* ---------------- 登录失败锁定（后台账号） ---------------- */

/** 记录一次失败；返回剩余可尝试次数（0 表示已锁定）。
 *  - 按 `username:ip` 精确锁定（防单点爆破）
 *  - 同时累计 `username` 全局计数，阈值更高（防分布式撞库）
 *  Redis 侧用 Lua 保证 INCR + EXPIRE 原子，避免「加了计数没设过期」永久锁定。
 */
export async function noteLoginFailure(username, ip = 'unknown') {
  const user = String(username ?? '').toLowerCase()
  const pairKey = `login-fail:${user}:${ip}`
  const userKey = `login-fail-user:${user}`
  const pairCount = await bump(pairKey, LOGIN_LOCK_SECONDS)
  const userCount = await bump(userKey, LOGIN_LOCK_SECONDS)
  const left = Math.max(0, LOGIN_MAX_FAILS - pairCount)
  const globalLeft = Math.max(0, LOGIN_MAX_FAILS_GLOBAL - userCount)
  return Math.min(left, globalLeft)
}

const LUA_BUMP = 'local c = redis.call("INCR", KEYS[1]) if c == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end return c'

async function bump(bucketKey, seconds) {
  if (redisReady()) {
    const hits = await cmd('EVAL', LUA_BUMP, 1, key(bucketKey), seconds)
    if (hits !== null) return Number(hits)
  }
  const now = Date.now()
  const state = FAILS.get(bucketKey) ?? { count: 0, resetAt: now + seconds * 1000 }
  if (now > state.resetAt) { state.count = 0; state.resetAt = now + seconds * 1000 }
  state.count += 1
  FAILS.set(bucketKey, state)
  return state.count
}

/** 锁定剩余的秒数，0 表示未锁定。 */
export async function loginLockSeconds(username, ip = 'unknown') {
  const user = String(username ?? '').toLowerCase()
  const pair = await lockLeft(`login-fail:${user}:${ip}`, LOGIN_MAX_FAILS)
  if (pair > 0) return pair
  return lockLeft(`login-fail-user:${user}`, LOGIN_MAX_FAILS_GLOBAL)
}

async function lockLeft(bucketKey, threshold) {
  if (redisReady()) {
    const results = await Promise.all([cmd('GET', key(bucketKey)), cmd('TTL', key(bucketKey))])
    const hits = Number(results[0] ?? 0)
    const ttl = Number(results[1] ?? 0)
    if (results[0] !== null && hits >= threshold && ttl > 0) return ttl
    return 0
  }
  const state = FAILS.get(bucketKey)
  if (!state) return 0
  if (Date.now() > state.resetAt) { FAILS.delete(bucketKey); return 0 }
  if (state.count < threshold) return 0
  return Math.ceil((state.resetAt - Date.now()) / 1000)
}

/** 登录成功后清空失败计数（按该账号 + 该 IP 的正对计数，以及全局计数）。 */
export async function clearLoginFailures(username, ip = 'unknown') {
  const user = String(username ?? '').toLowerCase()
  const keys = [`login-fail:${user}:${ip}`, `login-fail-user:${user}`]
  for (const bucketKey of keys) FAILS.delete(bucketKey)
  if (redisReady()) await cmd('DEL', ...keys.map((item) => key(item)))
  COUNTERS.logins += 1
}

/* ---------------- 维护 ---------------- */

/** 周期性清理内存桶，避免长期运行膨胀（Redis 侧靠 TTL 自动过期）。 */
export function sweep() {
  const now = Date.now()
  for (const [bucketKey, hits] of BUCKETS) {
    const alive = hits.filter((ts) => now - ts < 120_000)
    if (alive.length === 0) BUCKETS.delete(bucketKey)
    else BUCKETS.set(bucketKey, alive)
  }
  for (const [ip, state] of ENUM) {
    if (now - state.ts > 120_000) ENUM.delete(ip)
  }
  for (const [id, state] of FAILS) {
    if (now > state.resetAt) FAILS.delete(id)
  }
}

export function guardStats() {
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM security_events WHERE datetime(created_at) > datetime(\'now\', \'-24 hours\') GROUP BY kind').all()
  return {
    counters: { ...COUNTERS, window: 'since-process-start' },
    last24h: Object.fromEntries(rows.map((row) => [row.kind, row.n])),
    redis: redisStatus(),
    loginLock: { maxFails: LOGIN_MAX_FAILS, maxFailsPerAccount: LOGIN_MAX_FAILS_GLOBAL, lockSeconds: LOGIN_LOCK_SECONDS },
  }
}
