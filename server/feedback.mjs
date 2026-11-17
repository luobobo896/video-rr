/**
 * 投诉反馈域：C 端提交、B 端处理、关联订单与退款。
 * 原则：反馈只是「工单」，钱仍然走 refunds 表（双人复核），这里只记住它发生在哪张工单上。
 * 时间口径：库里一律 UTC（`datetime('now')`），区间筛选用 event-stats 的北京时间窗口，和埋点统计完全一致。
 */
import { db } from './db.mjs'
import { createRefund } from './commerce.mjs'
import { EVENT_RANGES, eventStatsWindow } from './event-stats.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const tx = (fn) => {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 事务已断，忽略 */ }
    throw error
  }
}

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const beijingDay = () => one("SELECT date('now', '+8 hours') AS day").day

export class FeedbackError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export const FEEDBACK_CATEGORIES = [
  { code: 'playback', label: '播放异常', hint: '卡顿、黑屏、没有声音、无法播放' },
  { code: 'payment', label: '付费与退款', hint: '支付未到账、重复扣款、需要退款' },
  { code: 'account', label: '账号问题', hint: '无法登录、设备被踢、权益丢失' },
  { code: 'content', label: '内容问题', hint: '剧集缺失、集数不对、字幕错误' },
  { code: 'report', label: '举报与侵权', hint: '违规内容、侵权投诉' },
  { code: 'suggestion', label: '功能建议', hint: '希望增加或改进的功能' },
  { code: 'other', label: '其他问题', hint: '不属于以上分类的问题' },
]
const CATEGORY_CODES = new Set(FEEDBACK_CATEGORIES.map((item) => item.code))

export const FEEDBACK_STATUSES = [
  { code: 'pending', label: '待处理', tone: 'warn' },
  { code: 'processing', label: '处理中', tone: 'info' },
  { code: 'replied', label: '已回复', tone: 'info' },
  { code: 'resolved', label: '已解决', tone: 'ok' },
  { code: 'closed', label: '已关闭', tone: 'muted' },
]
const STATUS_CODES = new Set(FEEDBACK_STATUSES.map((item) => item.code))
export const FEEDBACK_CATEGORY_LABELS = Object.fromEntries(FEEDBACK_CATEGORIES.map((item) => [item.code, item.label]))
export const FEEDBACK_STATUS_LABELS = Object.fromEntries(FEEDBACK_STATUSES.map((item) => [item.code, item.label]))

const PRIORITY_OF = { playback: 1, payment: 2, account: 1, content: 0, report: 2, suggestion: 0, other: 0 }

const normalizeCategory = (value) => {
  const code = String(value ?? '').trim()
  return CATEGORY_CODES.has(code) ? code : 'other'
}
const normalizeStatus = (value) => {
  const code = String(value ?? '').trim()
  return STATUS_CODES.has(code) ? code : null
}

/** 反馈行的通用投影：带上用户账号、订单摘要、剧目标题与退款状态，前端不用二次拼。 */
const SELECT_FEEDBACK = `
  SELECT f.*, 
    COALESCE(u.email, u.phone, u.nickname) AS user_account,
    u.nickname AS user_nickname,
    o.out_trade_no, o.amount_cny AS order_amount, o.status AS order_status,
    o.refunded_amount AS order_refunded, o.paid_at AS order_paid_at,
    d.title AS drama_title,
    r.status AS refund_status, r.amount AS refund_amount, r.reason AS refund_reason,
    ad.display_name AS replied_by_name
  FROM feedbacks f
  LEFT JOIN users u ON u.id = f.user_id
  LEFT JOIN orders o ON o.id = f.order_id
  LEFT JOIN dramas d ON d.id = f.drama_id
  LEFT JOIN refunds r ON r.id = f.refund_id
  LEFT JOIN admins ad ON ad.id = f.replied_by`

const buildFilter = (opts = {}) => {
  const where = []
  const args = []
  const status = String(opts.status ?? '').trim()
  if (status === 'open') {
    where.push("f.status IN ('pending', 'processing')")
  } else if (status && status !== 'all') {
    const code = normalizeStatus(status)
    if (code) {
      where.push('f.status = ?')
      args.push(code)
    }
  }
  const category = String(opts.category ?? '').trim()
  if (category && category !== 'all' && CATEGORY_CODES.has(category)) {
    where.push('f.category = ?')
    args.push(category)
  }
  if (opts.priority !== undefined && opts.priority !== null && opts.priority !== '' && opts.priority !== 'all') {
    where.push('f.priority >= ?')
    args.push(Number(opts.priority) || 0)
  }
  if (opts.userId) {
    where.push('f.user_id = ?')
    args.push(Number(opts.userId))
  }
  if (opts.orderId) {
    where.push('f.order_id = ?')
    args.push(Number(opts.orderId))
  }
  if (opts.ticketNo) {
    where.push('f.ticket_no = ?')
    args.push(String(opts.ticketNo))
  }
  const keyword = String(opts.q ?? '').trim()
  if (keyword) {
    const like = `%${keyword}%`
    where.push('(f.ticket_no LIKE ? OR f.content LIKE ? OR f.contact LIKE ? OR u.email LIKE ? OR o.out_trade_no LIKE ?)')
    args.push(like, like, like, like, like)
  }
  const range = String(opts.range ?? '').trim()
  if (EVENT_RANGES.includes(range)) {
    const window = eventStatsWindow(range, opts.now)
    where.push('f.created_at >= ?')
    args.push(window.from)
    if (window.to) {
      where.push('f.created_at < ?')
      args.push(window.to)
    }
  } else {
    if (opts.from) {
      where.push('f.created_at >= ?')
      args.push(String(opts.from))
    }
    if (opts.to) {
      where.push('f.created_at < ?')
      args.push(String(opts.to))
    }
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args }
}

/* ---------------- 写入 ---------------- */

/**
 * C 端提交。登录用户带 userId；匿名只带 visitorId，但必须留联系方式，否则回复没人收得到。
 */
export function createFeedback(input = {}) {
  const content = String(input.content ?? '').trim()
  if (content.length < 5) throw new FeedbackError('feedback_content_too_short', '请把问题描述清楚（至少 5 个字）')
  if (content.length > 2000) throw new FeedbackError('feedback_content_too_long', '描述过长，请压缩到 2000 字以内')
  const contact = String(input.contact ?? '').trim().slice(0, 120)
  const userId = Number(input.userId) || null
  if (!userId && !contact) throw new FeedbackError('feedback_contact_required', '未登录提交请留一个联系方式，便于我们回复')

  const category = normalizeCategory(input.category)
  const orderId = Number(input.orderId) || null
  let dramaId = Number(input.dramaId) || null
  if (orderId) {
    const order = one('SELECT id, user_id, drama_id FROM orders WHERE id = ?', orderId)
    if (!order) throw new FeedbackError('feedback_order_missing', '关联的订单不存在', 404)
    if (userId && Number(order.user_id) !== Number(userId)) {
      throw new FeedbackError('feedback_order_foreign', '不能对别人的订单提交反馈', 403)
    }
    if (!dramaId) dramaId = order.drama_id ?? null
  }
  const visitorId = String(input.visitorId ?? '').trim().slice(0, 64) || null
  const source = String(input.source ?? 'web').trim().slice(0, 20) || 'web'
  const priority = PRIORITY_OF[category] ?? 0

  const id = tx(() => {
    const result = run(`INSERT INTO feedbacks
      (user_id, visitor_id, order_id, drama_id, category, content, contact, source, status, priority, ip, ua, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    userId, visitorId, orderId, dramaId, category, content, contact || null, source, priority,
    String(input.ip ?? '').slice(0, 64) || null, String(input.ua ?? '').slice(0, 255) || null, nowSql(), nowSql())
    const newId = Number(result.lastInsertRowid)
    // 工单号在拿到自增 id 后才能定型：FB20261117-0012，客服与用户对单只报这个。
    run('UPDATE feedbacks SET ticket_no = ? WHERE id = ?', `FB${beijingDay().replaceAll('-', '')}-${String(newId).padStart(4, '0')}`, newId)
    return newId
  })
  return getFeedback(id)
}

export function getFeedback(id) {
  const row = one(`${SELECT_FEEDBACK} WHERE f.id = ?`, Number(id))
  if (!row) throw new FeedbackError('feedback_not_found', '反馈不存在', 404)
  return row
}

/** B 端回复：写回复内容，并把状态推进到 replied（或调用方显式指定）。 */
export function replyFeedback({ id, reply, status, adminId } = {}) {
  const feedback = getFeedback(id)
  const text = String(reply ?? '').trim()
  if (text.length < 2) throw new FeedbackError('feedback_reply_too_short', '回复内容太短')
  if (text.length > 2000) throw new FeedbackError('feedback_reply_too_long', '回复内容过长')
  const next = normalizeStatus(status) ?? 'replied'
  run(`UPDATE feedbacks SET reply = ?, replied_by = ?, replied_at = ?, status = ?, updated_at = ? WHERE id = ?`,
    text, Number(adminId) || null, nowSql(), next, nowSql(), feedback.id)
  return getFeedback(feedback.id)
}

/** 只改状态（受理、关闭、标记已解决），不覆盖已有回复。 */
export function setFeedbackStatus({ id, status, note, adminId } = {}) {
  const feedback = getFeedback(id)
  const next = normalizeStatus(status)
  if (!next) throw new FeedbackError('feedback_status_invalid', '状态不合法')
  const extra = String(note ?? '').trim().slice(0, 500)
  const adminNote = extra ? `${feedback.admin_note ? `${feedback.admin_note}\n` : ''}${nowSql()} ${extra}` : feedback.admin_note
  run('UPDATE feedbacks SET status = ?, admin_note = ?, updated_at = ? WHERE id = ?', next, adminNote || null, nowSql(), feedback.id)
  return getFeedback(feedback.id)
}

/**
 * 从反馈直接发起退款：金额默认剩余可退全额，退款单仍要财务复核（createRefund 里已有的规则）。
 */
export function refundFeedback({ id, amount, reason, operatorId } = {}) {
  const feedback = getFeedback(id)
  if (!feedback.order_id) throw new FeedbackError('feedback_order_required', '该反馈没有关联订单，无法退款')
  if (feedback.refund_id) throw new FeedbackError('feedback_refund_exists', '该反馈已经发起过退款', 409)
  const order = one('SELECT * FROM orders WHERE id = ?', feedback.order_id)
  const remaining = Math.max(0, Number(order.amount_cny ?? 0) - Number(order.refunded_amount ?? 0))
  const value = Number(amount) > 0 ? Math.round(Number(amount) * 100) / 100 : Math.round(remaining * 100) / 100
  if (value <= 0) throw new FeedbackError('feedback_refund_amount', '该订单没有可退金额', 409)
  const why = String(reason ?? '').trim() || `工单 ${feedback.ticket_no}：${FEEDBACK_CATEGORY_LABELS[feedback.category] ?? '用户投诉'}`
  const refund = createRefund({ orderId: order.id, amount: value, reason: why, operatorId })
  run('UPDATE feedbacks SET refund_id = ?, status = ?, updated_at = ? WHERE id = ?',
    refund.id, feedback.status === 'pending' ? 'processing' : feedback.status, nowSql(), feedback.id)
  return { feedback: getFeedback(feedback.id), refund }
}

/* ---------------- 查询 ---------------- */

export function countFeedbacks(opts = {}) {
  const { clause, args } = buildFilter(opts)
  return Number(one(`SELECT COUNT(*) AS n FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN orders o ON o.id = f.order_id ${clause}`, ...args)?.n ?? 0)
}

export function listFeedbacks(opts = {}) {
  const { clause, args } = buildFilter(opts)
  const pageSize = Math.min(200, Math.max(1, Number(opts.pageSize) || 20))
  const page = Math.max(1, Number(opts.page) || 1)
  const total = countFeedbacks(opts)
  const list = all(`${SELECT_FEEDBACK} ${clause} ORDER BY f.priority DESC, f.id DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, (page - 1) * pageSize)
  return { list, total, page, pageSize, counts: feedbackCounts(opts) }
}

/** 分状态计数：忽略状态筛选，方便列表顶部显示「待处理 12」这类角标。 */
export function feedbackCounts(opts = {}) {
  const { clause, args } = buildFilter({ ...opts, status: 'all' })
  const byStatus = Object.fromEntries(FEEDBACK_STATUSES.map((item) => [item.code, 0]))
  for (const row of all(`SELECT f.status, COUNT(*) AS n FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN orders o ON o.id = f.order_id ${clause} GROUP BY f.status`, ...args)) {
    if (row.status in byStatus) byStatus[row.status] = Number(row.n)
  }
  const byCategory = Object.fromEntries(FEEDBACK_CATEGORIES.map((item) => [item.code, 0]))
  for (const row of all(`SELECT f.category, COUNT(*) AS n FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN orders o ON o.id = f.order_id ${clause} GROUP BY f.category`, ...args)) {
    if (row.category in byCategory) byCategory[row.category] = Number(row.n)
  }
  const total = Number(one(`SELECT COUNT(*) AS n FROM feedbacks f LEFT JOIN users u ON u.id = f.user_id
    LEFT JOIN orders o ON o.id = f.order_id ${clause}`, ...args)?.n ?? 0)
  return { total, byStatus, byCategory }
}

/** C 端「我的反馈」：只给自己的，按时间倒序。 */
export function listMyFeedbacks(userId, { limit = 50 } = {}) {
  const id = Number(userId)
  if (!id) return []
  return all(`${SELECT_FEEDBACK} WHERE f.user_id = ? ORDER BY f.id DESC LIMIT ?`, id, Math.min(100, Math.max(1, Number(limit) || 50)))
    .map((row) => ({
      id: row.id,
      ticketNo: row.ticket_no,
      category: row.category,
      categoryLabel: FEEDBACK_CATEGORY_LABELS[row.category] ?? row.category,
      content: row.content,
      contact: row.contact,
      status: row.status,
      statusLabel: FEEDBACK_STATUS_LABELS[row.status] ?? row.status,
      reply: row.reply,
      repliedAt: row.replied_at,
      refundStatus: row.refund_status,
      refundAmount: row.refund_amount,
      orderNo: row.out_trade_no,
      dramaTitle: row.drama_title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
}

/** 后台统计：四区间（今天/昨天/近 7 天/近 30 天）+ 趋势 + 分类/状态分布 + 响应时长。 */
export function feedbackStats(range = '7d', now) {
  const key = EVENT_RANGES.includes(String(range)) ? String(range) : '7d'
  const window = eventStatsWindow(key, now)
  const to = window.to
  const rangeWhere = to ? 'f.created_at >= ? AND f.created_at < ?' : 'f.created_at >= ?'
  const rangeArgs = to ? [window.from, to] : [window.from]

  const totalsOf = (where, args) => {
    const row = one(`SELECT COUNT(*) AS tickets,
        SUM(CASE WHEN f.status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN f.reply IS NOT NULL AND f.reply <> '' THEN 1 ELSE 0 END) AS replied,
        SUM(CASE WHEN f.refund_id IS NOT NULL THEN 1 ELSE 0 END) AS refunds,
        SUM(CASE WHEN f.user_id IS NOT NULL THEN 1 ELSE 0 END) AS logged
      FROM feedbacks f WHERE ${where}`, ...args)
    return {
      tickets: Number(row?.tickets ?? 0),
      open: Number(row?.open ?? 0),
      replied: Number(row?.replied ?? 0),
      refunds: Number(row?.refunds ?? 0),
      logged: Number(row?.logged ?? 0),
      anonymous: Number(row?.tickets ?? 0) - Number(row?.logged ?? 0),
    }
  }

  const totals = totalsOf(rangeWhere, rangeArgs)
  // 上一个等长区间，用于「比上一周期」环比
  const prevWhere = window.prevTo ? 'f.created_at >= ? AND f.created_at < ?' : 'f.created_at >= ?'
  const prevArgs = window.prevTo ? [window.prevFrom, window.prevTo] : [window.prevFrom]
  const prevTotals = totalsOf(prevWhere, prevArgs)

  const bucketExpr = window.bucket === 'hour'
    ? "strftime('%Y-%m-%d %H', f.created_at, '+8 hours') || ':00'"
    : "date(f.created_at, '+8 hours')"
  const rows = all(`SELECT ${bucketExpr} AS bucket, COUNT(*) AS tickets FROM feedbacks f
    WHERE ${rangeWhere} GROUP BY bucket ORDER BY bucket`, ...rangeArgs)
  const counts = new Map(rows.map((row) => [row.bucket, Number(row.tickets)]))
  const step = window.bucket === 'hour' ? 3600_000 : 86_400_000
  const startMs = Date.parse(`${window.from.replace(' ', 'T')}Z`)
  const endMs = to ? Date.parse(`${to.replace(' ', 'T')}Z`) : (Number.isFinite(Number(now)) ? Number(now) : Date.now())
  const trend = []
  // 有右边界时右端是开区间，不能把 endMs 那一桶也补进去（否则「昨天」会多出一小时）
  for (let at = startMs; to ? at < endMs : at <= endMs; at += step) {
    const label = window.bucket === 'hour'
      ? `${new Date(at + 8 * 3600_000).toISOString().slice(0, 13).replace('T', ' ')}:00`
      : new Date(at + 8 * 3600_000).toISOString().slice(0, 10)
    trend.push({ bucket: label, tickets: counts.get(label) ?? 0 })
  }

  const byCategory = all(`SELECT f.category, COUNT(*) AS n FROM feedbacks f WHERE ${rangeWhere}
    GROUP BY f.category ORDER BY n DESC`, ...rangeArgs)
    .map((row) => ({ code: row.category, label: FEEDBACK_CATEGORY_LABELS[row.category] ?? row.category, count: Number(row.n) }))
  const byStatus = all(`SELECT f.status, COUNT(*) AS n FROM feedbacks f WHERE ${rangeWhere}
    GROUP BY f.status ORDER BY n DESC`, ...rangeArgs)
    .map((row) => ({ code: row.status, label: FEEDBACK_STATUS_LABELS[row.status] ?? row.status, count: Number(row.n) }))
  const replyRow = one(`SELECT COUNT(*) AS n, AVG((julianday(f.replied_at) - julianday(f.created_at)) * 1440) AS avg_minutes
    FROM feedbacks f WHERE ${rangeWhere} AND f.replied_at IS NOT NULL`, ...rangeArgs)
  const oldest = one(`SELECT id, ticket_no, created_at, category FROM feedbacks
    WHERE status IN ('pending', 'processing') ORDER BY created_at ASC LIMIT 1`)

  return {
    range: key,
    label: window.label,
    from: window.from,
    to,
    bucket: window.bucket,
    totals,
    prevTotals,
    trend,
    byCategory,
    byStatus,
    reply: { count: Number(replyRow?.n ?? 0), avgMinutes: replyRow?.avg_minutes ? Math.round(Number(replyRow.avg_minutes)) : 0 },
    oldestPending: oldest ? {
      id: oldest.id,
      ticketNo: oldest.ticket_no,
      category: FEEDBACK_CATEGORY_LABELS[oldest.category] ?? oldest.category,
      createdAt: oldest.created_at,
    } : null,
    categories: FEEDBACK_CATEGORIES,
    statuses: FEEDBACK_STATUSES,
  }
}

/** 订单页用的轻量查询：某订单有没有关联工单。 */
export function feedbacksOfOrder(orderId) {
  return all(`${SELECT_FEEDBACK} WHERE f.order_id = ? ORDER BY f.id DESC`, Number(orderId))
}
