/**
 * 运营统计：播放 / 用户 / 订单 / 订阅 / 内容 多维汇总。
 * 数据源：play_events（播放埋点）+ orders/payments/subscriptions/users/dramas/episodes。
 */
import { db } from './db.mjs'

const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)

const normalizeVisitorId = (value) => {
  const id = String(value ?? '').trim().slice(0, 64)
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}

function touchVisitor({ visitorId, userId, path, ip, ua } = {}) {
  const id = normalizeVisitorId(visitorId)
  if (!id) return null
  db.prepare(`INSERT INTO visitors (id, user_id, first_path, ip, ua)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, visitors.user_id),
      last_seen = datetime('now'),
      ip = COALESCE(excluded.ip, visitors.ip),
      ua = COALESCE(excluded.ua, visitors.ua)`).run(
    id, userId ?? null, String(path ?? '').slice(0, 200),
    String(ip ?? '').slice(0, 64), String(ua ?? '').slice(0, 200),
  )
  return id
}

/** 播放埋点（每次成功播放/试看记一条） */
export function recordPlay({ userId, visitorId, dramaId, episodeId, episodeNo, source = 'play', ip, ua }) {
  try {
    const visitor = touchVisitor({ visitorId, userId, path: `/play/${dramaId}/${episodeNo}`, ip, ua })
    db.prepare(`INSERT INTO play_events (user_id, visitor_id, drama_id, episode_id, episode_no, source, ip, ua)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId ?? null, visitor, Number(dramaId), episodeId ?? null, episodeNo ?? null,
      source, String(ip ?? '').slice(0, 64), String(ua ?? '').slice(0, 200),
    )
  } catch { /* 埋点失败不影响播放 */ }
}

/** 行为埋点白名单：只收已知类型，避免被当成任意写入的口子 */
export const TRACK_TYPES = new Set([
  'impression', 'detail_view', 'paywall_view', 'paywall_click', 'play_end', 'search', 'share',
  'category_filter', 'rank_view', 'login_open', 'login_success', 'page_view', 'session_start',
  'play_start', 'play_error', 'episode_click', 'favorite', 'order_created', 'payment_success',
  'track_change', 'lp_view', 'lp_cta_click', 'trial_start', 'trial_end',
])

const SERVER_ONLY_TRACK_TYPES = new Set(['order_created', 'payment_success'])
export const isClientTrackType = (type) => TRACK_TYPES.has(String(type ?? '')) && !SERVER_ONLY_TRACK_TYPES.has(String(type ?? ''))

/**
 * 漏斗上游埋点。播放开始已有 play_events，这里补曝光/详情/付费墙/完播。
 * 完播用 value = 完播率（position/duration），方便算平均完播。
 */
export function recordEvent({ type, userId, visitorId, dramaId, episodeId, path, value, position, duration, meta, ip, ua } = {}) {
  const kind = String(type ?? '')
  if (!TRACK_TYPES.has(kind)) return false
  try {
    const visitor = touchVisitor({ visitorId, userId, path, ip, ua })
    db.prepare(`INSERT INTO track_events
      (type, user_id, visitor_id, drama_id, episode_id, path, value, position, duration, meta_json, ip, ua)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      kind, userId ?? null, visitor, dramaId ? Number(dramaId) : null, episodeId ? Number(episodeId) : null,
      String(path ?? '').slice(0, 200),
      Number.isFinite(Number(value)) ? Number(value) : null,
      Number.isFinite(Number(position)) ? Number(position) : null,
      Number.isFinite(Number(duration)) ? Number(duration) : null,
      meta ? JSON.stringify(meta).slice(0, 500) : null,
      String(ip ?? '').slice(0, 64), String(ua ?? '').slice(0, 200),
    )
    return true
  } catch { return false }
}

const dateRange = (days) => {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
  return since
}

export function analyticsReport({ days = 7 } = {}) {
  const since = dateRange(days)
  const identityOf = (table) => `COALESCE(NULLIF(${table}.visitor_id, ''),
    CASE WHEN ${table}.user_id IS NOT NULL THEN 'u:' || ${table}.user_id ELSE 'ip:' || COALESCE(${table}.ip, '') END)`
  const viewerExpr = identityOf('play_events')
  const plays = all(`SELECT date(created_at) AS day, COUNT(*) AS plays, COUNT(DISTINCT ${viewerExpr}) AS viewers
    FROM play_events WHERE created_at >= ? GROUP BY day ORDER BY day`, since)

  const totals = {
    plays: one('SELECT COUNT(*) AS n FROM play_events WHERE created_at >= ?', since).n,
    viewers: one(`SELECT COUNT(DISTINCT ${viewerExpr}) AS n FROM play_events WHERE created_at >= ?`, since).n,
    dramasPlayed: one('SELECT COUNT(DISTINCT drama_id) AS n FROM play_events WHERE created_at >= ?', since).n,
    playsAllTime: one('SELECT COUNT(*) AS n FROM play_events').n,
  }

  const topDramas = all(`SELECT d.id AS dramaId, d.title,
      COUNT(*) AS plays, COUNT(DISTINCT COALESCE(p.visitor_id, CASE WHEN p.user_id IS NOT NULL THEN 'u:' || p.user_id ELSE 'ip:' || COALESCE(p.ip, '') END)) AS viewers
    FROM play_events p JOIN dramas d ON d.id = p.drama_id
    WHERE date(p.created_at) >= date(?)
    GROUP BY p.drama_id ORDER BY plays DESC LIMIT 10`, since)

  const sourceSplit = all(`SELECT source, COUNT(*) AS n FROM play_events
    WHERE created_at >= ? GROUP BY source ORDER BY n DESC`, since)

  const ordersByDay = all(`SELECT date(created_at) AS day,
      COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN amount_cny ELSE 0 END), 0) AS revenue
    FROM orders WHERE created_at >= ? GROUP BY day ORDER BY day`, since)

  const byChannel = all(`SELECT channel, COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN amount_cny ELSE 0 END), 0) AS revenue
    FROM orders WHERE created_at >= ? GROUP BY channel ORDER BY revenue DESC`, since)

  const byProduct = all(`SELECT product_type, COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN amount_cny ELSE 0 END), 0) AS revenue
    FROM orders WHERE created_at >= ? GROUP BY product_type`, since)

  const funnel = {
    orders: one('SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?', since).n,
    paid: one("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND status IN ('paid','fulfilled')", since).n,
    closed: one("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND status = 'closed'", since).n,
    refunded: one("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND status = 'refunded'", since).n,
  }
  funnel.payRate = funnel.orders ? Number(((funnel.paid / funnel.orders) * 100).toFixed(2)) : 0

  const revenue = one(`SELECT COALESCE(SUM(amount_cny),0) AS n FROM orders
    WHERE created_at >= ? AND status IN ('paid','fulfilled')`, since).n
  const paidCount = funnel.paid
  const money = {
    revenue,
    aov: paidCount ? Number((revenue / paidCount).toFixed(2)) : 0,
    refunded: one("SELECT COALESCE(SUM(refunded_amount),0) AS n FROM orders WHERE status = 'refunded' AND created_at >= ?", since).n,
    pendingRefunds: one("SELECT COUNT(*) AS n FROM refunds WHERE status = 'pending'").n,
  }

  const users = {
    total: one('SELECT COUNT(*) AS n FROM users').n,
    newInRange: one('SELECT COUNT(*) AS n FROM users WHERE created_at >= ?', since).n,
    newByDay: all('SELECT date(created_at) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day ORDER BY day', since),
    paying: one(`SELECT COUNT(DISTINCT user_id) AS n FROM orders
      WHERE status IN ('paid','fulfilled') AND created_at >= ?`, since).n,
  }

  const visitors = {
    total: one('SELECT COUNT(*) AS n FROM visitors WHERE last_seen >= ?', since).n,
    anonymous: one('SELECT COUNT(*) AS n FROM visitors WHERE user_id IS NULL AND last_seen >= ?', since).n,
    linked: one('SELECT COUNT(*) AS n FROM visitors WHERE user_id IS NOT NULL AND last_seen >= ?', since).n,
    newByDay: all('SELECT date(first_seen) AS day, COUNT(*) AS n FROM visitors WHERE first_seen >= ? GROUP BY day ORDER BY day', since),
  }

  const subscriptions = {
    active: one("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND datetime(valid_to) > datetime('now')").n,
    byPlan: all(`SELECT p.name, COUNT(*) AS n FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status = 'active' AND datetime(s.valid_to) > datetime('now') GROUP BY s.plan_id ORDER BY n DESC`),
  }

  const content = {
    dramas: one("SELECT COUNT(*) AS n FROM dramas WHERE status = 'published'").n,
    episodes: one('SELECT COUNT(*) AS n FROM episodes').n,
    readyEpisodes: one("SELECT COUNT(*) AS n FROM episodes WHERE status = 'ready'").n,
    pendingDanmu: one("SELECT COUNT(*) AS n FROM danmus WHERE status = 'pending'").n,
    pendingComments: one("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").n,
  }

  const perViewer = totals.viewers ? Number((totals.plays / totals.viewers).toFixed(2)) : 0

  /* ---------- 漏斗上游（曝光 → 详情 → 付费墙 → 下单 → 支付）---------- */
  const countOf = (type) => one('SELECT COUNT(*) AS n FROM track_events WHERE type = ? AND created_at >= ?', type, since).n
  const upstream = {
    pageViews: countOf('page_view'),
    impressions: countOf('impression'),
    detailViews: countOf('detail_view'),
    episodeClicks: countOf('episode_click'),
    playStarts: countOf('play_start'),
    playErrors: countOf('play_error'),
    paywallViews: countOf('paywall_view'),
    paywallClicks: countOf('paywall_click'),
    loginOpens: countOf('login_open'),
    loginSuccesses: countOf('login_success'),
    favorites: countOf('favorite'),
    orderEvents: countOf('order_created'),
    paymentEvents: countOf('payment_success'),
    playEnds: countOf('play_end'),
    searches: countOf('search'),
    shares: countOf('share'),
    visitors: one(`SELECT COUNT(DISTINCT ${identityOf('track_events')}) AS n
      FROM track_events WHERE type IN ('page_view', 'session_start') AND created_at >= ?`, since).n,
  }
  upstream.detailToPaywall = upstream.detailViews ? Number(((upstream.paywallViews / upstream.detailViews) * 100).toFixed(2)) : 0
  upstream.paywallToOrder = upstream.paywallViews ? Number(((funnel.orders / upstream.paywallViews) * 100).toFixed(2)) : 0
  upstream.orderToPaid = funnel.payRate

  const trackByType = all(`SELECT type, COUNT(*) AS n FROM track_events
    WHERE created_at >= ? GROUP BY type ORDER BY n DESC`, since)
  const trackByDay = all(`SELECT date(created_at) AS day, type, COUNT(*) AS n FROM track_events
    WHERE created_at >= ? GROUP BY day, type ORDER BY day`, since)
  const completion = one(`SELECT COUNT(*) AS n, COALESCE(AVG(value),0) AS avgRate FROM track_events
    WHERE type = 'play_end' AND value IS NOT NULL AND created_at >= ?`, since)
  const completionStats = {
    samples: completion.n,
    avgRate: Number(Number(completion.avgRate ?? 0).toFixed(3)),
    finished: one(`SELECT COUNT(*) AS n FROM track_events
      WHERE type = 'play_end' AND COALESCE(value,0) >= 0.9 AND created_at >= ?`, since).n,
  }
  const topDetailViews = all(`SELECT t.drama_id AS dramaId, d.title, COUNT(*) AS n, COALESCE(AVG(t.value),0) AS avgRate
    FROM track_events t LEFT JOIN dramas d ON d.id = t.drama_id
    WHERE t.type = 'detail_view' AND date(t.created_at) >= date(?)
    GROUP BY t.drama_id ORDER BY n DESC LIMIT 10`, since)
  const searchTerms = all(`SELECT path AS term, COUNT(*) AS n FROM track_events
    WHERE type = 'search' AND created_at >= ? AND path <> ''
    GROUP BY path ORDER BY n DESC LIMIT 10`, since)

  // 漏斗按同一访客逐级去重：后一步只统计完成过前一步的访客，避免历史数据造成倒挂或 >100%。
  const trackIdentity = identityOf('track_events')
  const playIdentity = identityOf('play_events')
  const orderIdentity = `COALESCE(NULLIF(orders.visitor_id, ''), 'u:' || orders.user_id)`
  const reach = one(`WITH
    visited AS (
      SELECT DISTINCT ${trackIdentity} AS id FROM track_events WHERE created_at >= ?
      UNION
      SELECT DISTINCT ${playIdentity} AS id FROM play_events WHERE created_at >= ?
    ),
    detailed AS (
      SELECT DISTINCT ${trackIdentity} AS id FROM track_events
      WHERE type = 'detail_view' AND created_at >= ? AND ${trackIdentity} IN (SELECT id FROM visited)
    ),
    played AS (
      SELECT DISTINCT ${playIdentity} AS id FROM play_events
      WHERE created_at >= ? AND ${playIdentity} IN (SELECT id FROM detailed)
    ),
    paywalled AS (
      SELECT DISTINCT ${trackIdentity} AS id FROM track_events
      WHERE type = 'paywall_view' AND created_at >= ? AND ${trackIdentity} IN (SELECT id FROM played)
    ),
    ordered AS (
      SELECT DISTINCT ${orderIdentity} AS id FROM orders
      WHERE created_at >= ? AND ${orderIdentity} IN (SELECT id FROM paywalled)
    ),
    converted AS (
      SELECT DISTINCT ${orderIdentity} AS id FROM orders
      WHERE status IN ('paid', 'fulfilled') AND created_at >= ?
        AND ${orderIdentity} IN (SELECT id FROM ordered)
    )
    SELECT
      (SELECT COUNT(*) FROM visited) AS visitors,
      (SELECT COUNT(*) FROM detailed) AS details,
      (SELECT COUNT(*) FROM played) AS plays,
      (SELECT COUNT(*) FROM paywalled) AS paywalls,
      (SELECT COUNT(*) FROM ordered) AS orders,
      (SELECT COUNT(*) FROM converted) AS paid`, since, since, since, since, since, since, since)
  const conversion = [
    { key: 'visitors', label: '访问访客', value: Number(reach.visitors ?? 0) },
    { key: 'detailViews', label: '查看详情', value: Number(reach.details ?? 0) },
    { key: 'plays', label: '开始播放', value: Number(reach.plays ?? 0) },
    { key: 'paywallViews', label: '触达付费墙', value: Number(reach.paywalls ?? 0) },
    { key: 'orders', label: '创建订单', value: Number(reach.orders ?? 0) },
    { key: 'paid', label: '支付成功', value: Number(reach.paid ?? 0) },
  ].map((stage, index, list) => {
    const previous = index === 0 ? stage.value : list[index - 1].value
    return {
      ...stage,
      rate: index === 0 ? (stage.value ? 100 : 0) : (previous ? Number(((stage.value / previous) * 100).toFixed(1)) : 0),
      dropped: index === 0 ? 0 : Math.max(0, previous - stage.value),
    }
  })

  return {
    range: { days, since }, totals: { ...totals, playsPerViewer: perViewer }, playsByDay: plays, topDramas, sourceSplit,
    ordersByDay, byChannel, byProduct, funnel, money, users, visitors, subscriptions, content, conversion,
    tracking: { upstream, byType: trackByType, byDay: trackByDay, completion: completionStats, topDetailViews, searchTerms },
  }
}
