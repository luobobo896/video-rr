/**
 * 运营统计：播放 / 用户 / 订单 / 订阅 / 内容 多维汇总。
 * 数据源：play_events（播放埋点）+ orders/payments/subscriptions/users/dramas/episodes。
 */
import { db } from './db.mjs'

const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)

/** 播放埋点（每次成功播放/试看记一条） */
export function recordPlay({ userId, dramaId, episodeId, episodeNo, source = 'play', ip, ua }) {
  try {
    db.prepare(`INSERT INTO play_events (user_id, drama_id, episode_id, episode_no, source, ip, ua)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      userId ?? null, Number(dramaId), episodeId ?? null, episodeNo ?? null,
      source, String(ip ?? '').slice(0, 64), String(ua ?? '').slice(0, 200),
    )
  } catch { /* 埋点失败不影响播放 */ }
}

const dateRange = (days) => {
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
  return since
}

export function analyticsReport({ days = 7 } = {}) {
  const since = dateRange(days)
  const plays = all(`SELECT date(created_at) AS day, COUNT(*) AS plays, COUNT(DISTINCT COALESCE(user_id, ip)) AS viewers
    FROM play_events WHERE date(created_at) >= date(?) GROUP BY day ORDER BY day`, since)

  const totals = {
    plays: one('SELECT COUNT(*) AS n FROM play_events WHERE date(created_at) >= date(?)', since).n,
    viewers: one('SELECT COUNT(DISTINCT COALESCE(user_id, ip)) AS n FROM play_events WHERE date(created_at) >= date(?)', since).n,
    dramasPlayed: one('SELECT COUNT(DISTINCT drama_id) AS n FROM play_events WHERE date(created_at) >= date(?)', since).n,
    playsAllTime: one('SELECT COUNT(*) AS n FROM play_events').n,
  }

  const topDramas = all(`SELECT d.id AS dramaId, d.title,
      COUNT(*) AS plays, COUNT(DISTINCT COALESCE(p.user_id, p.ip)) AS viewers
    FROM play_events p JOIN dramas d ON d.id = p.drama_id
    WHERE date(p.created_at) >= date(?)
    GROUP BY p.drama_id ORDER BY plays DESC LIMIT 10`, since)

  const sourceSplit = all(`SELECT source, COUNT(*) AS n FROM play_events
    WHERE date(created_at) >= date(?) GROUP BY source ORDER BY n DESC`, since)

  const ordersByDay = all(`SELECT date(created_at) AS day,
      COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN amount_cny ELSE 0 END), 0) AS revenue
    FROM orders WHERE date(created_at) >= date(?) GROUP BY day ORDER BY day`, since)

  const byChannel = all(`SELECT channel, COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN amount_cny ELSE 0 END), 0) AS revenue
    FROM orders WHERE date(created_at) >= date(?) GROUP BY channel ORDER BY revenue DESC`, since)

  const byProduct = all(`SELECT product_type, COUNT(*) AS orders,
      COALESCE(SUM(CASE WHEN status IN ('paid','fulfilled') THEN amount_cny ELSE 0 END), 0) AS revenue
    FROM orders WHERE date(created_at) >= date(?) GROUP BY product_type`, since)

  const funnel = {
    orders: one('SELECT COUNT(*) AS n FROM orders WHERE date(created_at) >= date(?)', since).n,
    paid: one("SELECT COUNT(*) AS n FROM orders WHERE date(created_at) >= date(?) AND status IN ('paid','fulfilled')", since).n,
    closed: one("SELECT COUNT(*) AS n FROM orders WHERE date(created_at) >= date(?) AND status = 'closed'", since).n,
    refunded: one("SELECT COUNT(*) AS n FROM orders WHERE date(created_at) >= date(?) AND status = 'refunded'", since).n,
  }
  funnel.payRate = funnel.orders ? Number(((funnel.paid / funnel.orders) * 100).toFixed(2)) : 0

  const revenue = one(`SELECT COALESCE(SUM(amount_cny),0) AS n FROM orders
    WHERE date(created_at) >= date(?) AND status IN ('paid','fulfilled')`, since).n
  const paidCount = funnel.paid
  const money = {
    revenue,
    aov: paidCount ? Number((revenue / paidCount).toFixed(2)) : 0,
    refunded: one("SELECT COALESCE(SUM(refunded_amount),0) AS n FROM orders WHERE status = 'refunded' AND date(created_at) >= date(?)", since).n,
    pendingRefunds: one("SELECT COUNT(*) AS n FROM refunds WHERE status = 'pending'").n,
  }

  const users = {
    total: one('SELECT COUNT(*) AS n FROM users').n,
    newInRange: one('SELECT COUNT(*) AS n FROM users WHERE date(created_at) >= date(?)', since).n,
    newByDay: all('SELECT date(created_at) AS day, COUNT(*) AS n FROM users WHERE date(created_at) >= date(?) GROUP BY day ORDER BY day', since),
    paying: one(`SELECT COUNT(DISTINCT user_id) AS n FROM orders
      WHERE status IN ('paid','fulfilled') AND date(created_at) >= date(?)`, since).n,
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

  return { range: { days, since }, totals: { ...totals, playsPerViewer: perViewer }, playsByDay: plays, topDramas, sourceSplit, ordersByDay, byChannel, byProduct, funnel, money, users, subscriptions, content }
}
