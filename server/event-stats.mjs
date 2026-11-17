/**
 * 埋点统计：按 Asia/Shanghai 日历切「今天 / 昨天 / 近 7 天 / 近 30 天」。
 *
 * 库内 created_at 仍是 UTC 文本，所有边界在 JS 里换算成 UTC 再进 SQL；
 * 趋势分桶用 SQLite 的 `+8 hours` 回到北京时间，避免凌晨数据落到前一天。
 */
import { db } from './db.mjs'

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
const TZ_OFFSET_MS = 8 * HOUR_MS
const pad = (value) => String(value).padStart(2, '0')

export const EVENT_RANGES = ['today', 'yesterday', '7d', '30d']
export const EVENT_RANGE_LABELS = { today: '今天', yesterday: '昨天', '7d': '近 7 天', '30d': '近 30 天' }
export const normalizeRange = (value) => (EVENT_RANGES.includes(String(value ?? '')) ? String(value) : '7d')

/** Date → 'YYYY-MM-DD HH:MM:SS'（UTC），与 SQLite datetime('now') 同格式，字符串比较即时间比较。 */
export const dbTime = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

const parseDbTime = (value) => Date.parse(`${String(value).replace(' ', 'T')}Z`)

/** 访客身份：登录用户按 user_id、匿名按 visitor_id、再兜底 IP。 */
// 去重身份：登录用户按账号算一个人（同一账号换设备/换 IP 不重复计），
// 未登录才退回 visitor_id，最后兜底 IP。顺序不能反：反了会让同一个会员被拆成多个访客。
const IDENTITY = `COALESCE(CASE WHEN te.user_id IS NOT NULL THEN 'u:' || te.user_id END, NULLIF(te.visitor_id, ''), NULLIF(te.ip, ''))`

/**
 * 区间窗口。from 闭、to 开；to 为 null 表示「到现在」。
 * prevFrom/prevTo 是同长度的上一个区间，用于环比。
 */
export function eventStatsWindow(range = '7d', now = Date.now()) {
  const key = normalizeRange(range)
  const local = new Date(now + TZ_OFFSET_MS)
  const todayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate())
  const localAt = (ms) => new Date(ms - TZ_OFFSET_MS)
  const todayStart = localAt(todayLocal)

  if (key === 'today') {
    return {
      range: key, label: EVENT_RANGE_LABELS[key], bucket: 'hour', days: 1,
      from: dbTime(todayStart), to: null,
      prevFrom: dbTime(localAt(todayLocal - DAY_MS)), prevTo: dbTime(new Date(now - DAY_MS)),
    }
  }
  if (key === 'yesterday') {
    const from = localAt(todayLocal - DAY_MS)
    return {
      range: key, label: EVENT_RANGE_LABELS[key], bucket: 'hour', days: 1,
      from: dbTime(from), to: dbTime(todayStart),
      prevFrom: dbTime(localAt(todayLocal - 2 * DAY_MS)), prevTo: dbTime(from),
    }
  }
  const days = key === '30d' ? 30 : 7
  const from = localAt(todayLocal - (days - 1) * DAY_MS)
  return {
    range: key, label: EVENT_RANGE_LABELS[key], bucket: 'day', days,
    from: dbTime(from), to: null,
    prevFrom: dbTime(localAt(todayLocal - (2 * days - 1) * DAY_MS)), prevTo: dbTime(from),
  }
}

const rangeOf = (win) => {
  const args = [win.from]
  let sql = 'te.created_at >= ?'
  if (win.to) {
    sql += ' AND te.created_at < ?'
    args.push(win.to)
  }
  return { clause: sql, args }
}

const n = (value) => Number(value ?? 0)

function totalsOf(win) {
  const { clause, args } = rangeOf(win)
  const row = db.prepare(`SELECT COUNT(*) AS events,
      COUNT(DISTINCT ${IDENTITY}) AS visitors,
      COUNT(DISTINCT CASE WHEN te.user_id IS NOT NULL THEN te.user_id END) AS users,
      COUNT(DISTINCT CASE WHEN te.user_id IS NULL THEN ${IDENTITY} END) AS anonymous,
      SUM(CASE WHEN te.user_id IS NOT NULL THEN 1 ELSE 0 END) AS loggedEvents,
      SUM(CASE WHEN te.user_id IS NULL THEN 1 ELSE 0 END) AS anonymousEvents,
      SUM(CASE WHEN te.type = 'session_start' THEN 1 ELSE 0 END) AS sessions,
      SUM(CASE WHEN te.type = 'page_view' AND te.event_op = 1 THEN 1 ELSE 0 END) AS pageViews,
      SUM(CASE WHEN te.type = 'page_view' AND te.event_op = 2 THEN 1 ELSE 0 END) AS pageExits,
      SUM(CASE WHEN te.event_type = 2 THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN te.type IN ('play_start', 'trial_start') THEN 1 ELSE 0 END) AS plays,
      SUM(CASE WHEN te.type = 'search' THEN 1 ELSE 0 END) AS searches,
      SUM(CASE WHEN te.type = 'paywall_view' THEN 1 ELSE 0 END) AS paywallViews,
      SUM(CASE WHEN te.stay_ms > 0 THEN te.stay_ms ELSE 0 END) AS stayMs,
      SUM(CASE WHEN te.stay_ms > 0 THEN 1 ELSE 0 END) AS staySamples
    FROM track_events te WHERE ${clause}`).get(...args)
  const samples = n(row.staySamples)
  const visitors = n(row.visitors)
  return {
    events: n(row.events), visitors, users: n(row.users), anonymous: n(row.anonymous),
    loggedEvents: n(row.loggedEvents), anonymousEvents: n(row.anonymousEvents), sessions: n(row.sessions),
    pageViews: n(row.pageViews), pageExits: n(row.pageExits), clicks: n(row.clicks), plays: n(row.plays),
    searches: n(row.searches), paywallViews: n(row.paywallViews),
    avgStayMs: samples ? Math.round(n(row.stayMs) / samples) : 0,
    eventsPerVisitor: visitors ? Number((n(row.events) / visitors).toFixed(1)) : 0,
  }
}

const TREND_METRICS = `COUNT(*) AS events, COUNT(DISTINCT ${IDENTITY}) AS visitors,
  SUM(CASE WHEN te.type = 'page_view' AND te.event_op = 1 THEN 1 ELSE 0 END) AS pageViews,
  SUM(CASE WHEN te.event_type = 2 THEN 1 ELSE 0 END) AS clicks,
  SUM(CASE WHEN te.type IN ('play_start', 'trial_start') THEN 1 ELSE 0 END) AS plays`

const bucketKeyOf = (localMs, bucket) => {
  const date = new Date(localMs)
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  return bucket === 'hour' ? `${day} ${pad(date.getUTCHours())}:00` : day
}

/** 趋势：按小时（今天/昨天）或按天（7/30 天），空桶补 0，前端折线不会断。 */
function trendOf(win, now = Date.now()) {
  const { clause, args } = rangeOf(win)
  const bucketExpr = win.bucket === 'hour'
    ? "strftime('%Y-%m-%d %H', te.created_at, '+8 hours') || ':00'"
    : "date(te.created_at, '+8 hours')"
  const rows = db.prepare(`SELECT ${bucketExpr} AS day, ${TREND_METRICS}
    FROM track_events te WHERE ${clause} GROUP BY day ORDER BY day`).all(...args)
  const found = new Map(rows.map((row) => [row.day, row]))
  const startLocal = parseDbTime(win.from) + TZ_OFFSET_MS
  const endLocal = (win.to ? parseDbTime(win.to) : now) + TZ_OFFSET_MS
  const step = win.bucket === 'hour' ? HOUR_MS : DAY_MS
  const count = Math.max(1, Math.floor((endLocal - startLocal) / step) + (win.to ? 0 : 1))
  const trend = []
  for (let index = 0; index < count; index += 1) {
    const key = bucketKeyOf(startLocal + index * step, win.bucket)
    const row = found.get(key)
    trend.push({
      day: key,
      events: n(row?.events), visitors: n(row?.visitors),
      pageViews: n(row?.pageViews), clicks: n(row?.clicks), plays: n(row?.plays),
    })
  }
  return trend
}

function rankingsOf(win) {
  const { clause, args } = rangeOf(win)
  // 热门页面只算页面浏览：曝光、播放、搜索词、订单号这类事件没有页面语义，混进来会顶掉真实页面排行。
  const topPages = db.prepare(`SELECT te.path AS path,
      COUNT(*) AS n, COUNT(DISTINCT ${IDENTITY}) AS visitors
    FROM track_events te
    WHERE ${clause} AND te.path IS NOT NULL AND te.path <> ''
      AND te.type IN ('page_view', 'page_exit')
    GROUP BY path ORDER BY n DESC LIMIT 10`).all(...args)
  const topEvents = db.prepare(`SELECT COALESCE(NULLIF(te.event_code, ''), te.type) AS code, te.type, COUNT(*) AS n
    FROM track_events te WHERE ${clause} GROUP BY code ORDER BY n DESC LIMIT 12`).all(...args)
  const topActions = db.prepare(`SELECT te.action AS action, COUNT(*) AS n
    FROM track_events te WHERE ${clause} AND te.action IS NOT NULL AND te.action <> ''
    GROUP BY te.action ORDER BY n DESC LIMIT 10`).all(...args)
  const topDramas = db.prepare(`SELECT te.drama_id AS id, COALESCE(d.title, '#' || te.drama_id) AS title, COUNT(*) AS n
    FROM track_events te LEFT JOIN dramas d ON d.id = te.drama_id
    WHERE ${clause} AND te.drama_id IS NOT NULL GROUP BY te.drama_id ORDER BY n DESC LIMIT 10`).all(...args)
  const devices = db.prepare(`SELECT te.device AS label, COUNT(*) AS n
    FROM track_events te WHERE ${clause} AND te.device IS NOT NULL AND te.device <> ''
    GROUP BY te.device ORDER BY n DESC LIMIT 8`).all(...args)
  const systems = db.prepare(`SELECT te.os AS label, COUNT(*) AS n
    FROM track_events te WHERE ${clause} AND te.os IS NOT NULL AND te.os <> ''
    GROUP BY te.os ORDER BY n DESC LIMIT 8`).all(...args)
  return { topPages, topEvents, topActions, topDramas, devices, systems }
}

export function eventStats(range = '7d', now = Date.now()) {
  const win = eventStatsWindow(range, now)
  const { clause, args } = rangeOf(win)
  const byType = db.prepare(`SELECT te.type, COUNT(*) AS n, COUNT(DISTINCT ${IDENTITY}) AS visitors
    FROM track_events te WHERE ${clause} GROUP BY te.type ORDER BY n DESC`).all(...args)
  const byEventType = db.prepare(`SELECT te.event_type AS eventType, COUNT(*) AS n
    FROM track_events te WHERE ${clause} GROUP BY te.event_type ORDER BY n DESC`).all(...args)
  return {
    range: win.range,
    label: win.label,
    bucket: win.bucket,
    days: win.days,
    from: win.from,
    to: win.to ?? dbTime(new Date(now)),
    totals: totalsOf(win),
    prevTotals: totalsOf({ from: win.prevFrom, to: win.prevTo }),
    trend: trendOf(win, now),
    byType,
    byEventType,
    ...rankingsOf(win),
  }
}
