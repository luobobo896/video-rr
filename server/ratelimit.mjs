/**
 * 反爬与限流（防抓取、防刷验证码、防批量拉取内容）。
 *
 * 三层：
 * 1) 滑动窗口限流：按 IP + 路由类别，超限返回 429 + Retry-After
 * 2) UA 黑名单：脚本库/爬虫客户端直接 403（浏览器引擎放宽，避免误伤正常用户与自有巡检）
 * 3) 枚举探测：同一 IP 60 秒内访问过多不同内容 ID，判定为批量抓取 → 403 并留痕
 *
 * 所有拦截写入 security_events，后台「审计日志 → 安全事件」可查。
 */
import { db } from './db.mjs'

const BUCKETS = new Map()      // key -> number[]（时间戳）
const ENUM = new Map()         // ip -> { ids:Set, ts:number }
const COUNTERS = { blocked: 0, rateLimited: 0, uaBlocked: 0, enumBlocked: 0, since: new Date().toISOString() }

const RULES = [
  { name: 'auth-send', match: (path) => /^\/api\/auth\/(email\/send|password\/send|email\/send-change)$/.test(path), limit: 10, window: 60_000 },
  { name: 'auth', match: (path) => path.startsWith('/api/auth/'), limit: 30, window: 60_000 },
  { name: 'pay', match: (path) => path.startsWith('/api/pay/') || path.startsWith('/api/orders') || path.startsWith('/api/notify/'), limit: 40, window: 60_000 },
  { name: 'play', match: (path) => path.startsWith('/api/play/') || path.startsWith('/api/drama/'), limit: 120, window: 60_000 },
  { name: 'media', match: (path) => path.startsWith('/media/'), limit: 600, window: 60_000 },
  { name: 'api-write', match: (path, method) => method !== 'GET' && path.startsWith('/api/'), limit: 60, window: 60_000 },
  { name: 'api', match: (path) => path.startsWith('/api/'), limit: 400, window: 60_000 },
]

const UA_BLOCK = /(python-requests|python-urllib|scrapy|aiohttp|httpx|curl\/|wget\/|go-http-client|java\/|libwww-perl|okhttp|apache-httpclient|node-fetch|axios\/)/i
const UA_EMPTY_ALLOW = /^$/

export function clientIpOf(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return String(forwarded).split(',')[0].trim()
  return req.socket?.remoteAddress ?? 'unknown'
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

/** 返回 { blocked, status, reason, retryAfter } */
export function inspect(req, pathname, method) {
  const ip = clientIpOf(req)
  const ua = req.headers['user-agent'] ?? ''

  // 本机（nginx 反代 / 健康检查 / 内部脚本）不做 UA 与限流拦截
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip === '::ffff:127.0.0.1') {
    return { blocked: false }
  }

  // 1) UA 黑名单（空 UA 也拦，正常浏览器一定带 UA）
  if (pathname.startsWith('/api/') || pathname.startsWith('/media/')) {
    if (UA_EMPTY_ALLOW.test(ua) || UA_BLOCK.test(ua)) {
      record('bad_ua', ip, pathname, ua, ua ? 'suspicious client' : 'empty user-agent')
      return { blocked: true, status: 403, reason: 'automated_access_denied' }
    }
  }

  // 2) 滑动窗口限流
  const rule = RULES.find((item) => item.match(pathname, method))
  if (!rule) return { blocked: false }

  const now = Date.now()
  const key = `${rule.name}:${ip}`
  const hits = (BUCKETS.get(key) ?? []).filter((ts) => now - ts < rule.window)
  hits.push(now)
  BUCKETS.set(key, hits)
  if (hits.length > rule.limit) {
    record('rate_limit', ip, pathname, ua, `${rule.name} ${hits.length}/${rule.limit} per ${rule.window / 1000}s`)
    return { blocked: true, status: 429, reason: 'too_many_requests', retryAfter: Math.ceil(rule.window / 1000) }
  }

  // 3) 内容枚举探测（批量抓剧集/播放）
  const idMatch = /^\/(?:api\/(?:drama|play|access))\/(\d+)/.exec(pathname)
  if (idMatch) {
    const state = ENUM.get(ip) ?? { ids: new Set(), ts: now }
    if (now - state.ts > 60_000) { state.ids = new Set(); state.ts = now }
    state.ids.add(idMatch[1])
    ENUM.set(ip, state)
    if (state.ids.size > 60) {
      record('enumeration', ip, pathname, ua, `distinct content ids=${state.ids.size} in 60s`)
      return { blocked: true, status: 403, reason: 'enumeration_denied' }
    }
  }

  return { blocked: false }
}

/** 周期性清理内存桶，避免长期运行膨胀 */
export function sweep() {
  const now = Date.now()
  for (const [key, hits] of BUCKETS) {
    const alive = hits.filter((ts) => now - ts < 120_000)
    if (alive.length === 0) BUCKETS.delete(key)
    else BUCKETS.set(key, alive)
  }
  for (const [ip, state] of ENUM) {
    if (now - state.ts > 120_000) ENUM.delete(ip)
  }
}

export function guardStats() {
  const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM security_events WHERE datetime(created_at) > datetime(\'now\', \'-24 hours\') GROUP BY kind').all()
  return {
    counters: { ...COUNTERS, window: 'since-process-start' },
    last24h: Object.fromEntries(rows.map((row) => [row.kind, row.n])),
  }
}
