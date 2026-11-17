import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-feedback-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'

const { db } = await import('../server/db.mjs')
const {
  createFeedback, getFeedback, listFeedbacks, listMyFeedbacks, countFeedbacks,
  replyFeedback, setFeedbackStatus, refundFeedback, feedbackStats, feedbacksOfOrder,
  FEEDBACK_CATEGORIES, FEEDBACK_STATUSES,
} = await import('../server/feedback.mjs')

/** 北京时间 2026-11-17 16:50（UTC 08:50）。 */
const NOW = Date.parse('2026-11-17T08:50:00Z')

db.exec('DELETE FROM feedbacks')
db.exec('DELETE FROM refunds')
db.exec('DELETE FROM orders')
db.exec('DELETE FROM users')

const userInfo = db.prepare("INSERT INTO users (phone, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)")
  .run('13800000001', 'x', '用户甲', '2026-11-01 00:00:00')
const userId = Number(userInfo.lastInsertRowid)
const orderInfo = db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, status, paid_at, created_at)
  VALUES (?, ?, 'single', 19.9, 'paid', '2026-11-16 02:00:00', '2026-11-16 02:00:00')`).run('MH20261116000001', userId)
const orderId = Number(orderInfo.lastInsertRowid)

/** 直接写库造历史工单：只测查询/统计口径，不掺业务写入时序。 */
function seedFeedback(createdAt, { status = 'pending', category = 'playback', reply = null, refundId = null, userId: uid = null } = {}) {
  const info = db.prepare(`INSERT INTO feedbacks (user_id, category, content, contact, status, priority, reply, refund_id, created_at, updated_at)
    VALUES (?, ?, '内容问题描述', 'a@b.c', ?, 0, ?, ?, ?, ?)`)
    .run(uid, category, status, reply, refundId, createdAt, createdAt)
  return Number(info.lastInsertRowid)
}

test('分类与状态常量覆盖 B 端筛选所需的全部选项', () => {
  assert.deepEqual(FEEDBACK_CATEGORIES.map((item) => item.code), ['playback', 'payment', 'account', 'content', 'report', 'suggestion', 'other'])
  assert.deepEqual(FEEDBACK_STATUSES.map((item) => item.code), ['pending', 'processing', 'replied', 'resolved', 'closed'])
})

test('提交反馈：内容太短、匿名不留联系方式都被挡下，报错带稳定错误码', () => {
  assert.throws(() => createFeedback({ category: 'playback', content: '太短', contact: 'a@b.c' }), /至少 5 个字/)
  assert.throws(
    () => createFeedback({ category: 'playback', content: '视频一直黑屏播不了' }),
    (error) => error.code === 'feedback_contact_required',
  )
  // 未知分类不报错，落成「其他问题」，避免前端旧缓存值把提交打断。
  const unknown = createFeedback({ category: 'nope', content: '视频一直黑屏播不了', contact: 'a@b.c' })
  assert.equal(unknown.category, 'other')
  assert.equal(db.prepare('DELETE FROM feedbacks WHERE id = ?').run(unknown.id).changes, 1)
})

test('提交反馈后生成北京日期工单号，付费类自动升优先级', () => {
  const created = createFeedback({
    userId, category: 'payment', content: '付了两次钱，只到账一次', contact: '13800000001',
    orderId, visitorId: 'v-9', ip: '1.2.3.4', ua: 'unit-test',
  })
  assert.equal(created.status, 'pending')
  assert.equal(created.priority, 2)
  assert.match(created.ticket_no, /^FB\d{8}-\d{4}$/)
  assert.equal(created.order_id, orderId)
  assert.equal(getFeedback(created.id).ticket_no, created.ticket_no)
})

test('订单归属校验：别人的订单不能挂到自己工单上', () => {
  const other = db.prepare("INSERT INTO users (phone, password_hash, nickname, created_at) VALUES ('13800000002', 'x', '用户乙', '2026-11-01 00:00:00')").run()
  const stolen = db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, status, paid_at, created_at)
    VALUES ('MH20261116000002', ?, 'single', 9.9, 'paid', '2026-11-16 03:00:00', '2026-11-16 03:00:00')`)
    .run(Number(other.lastInsertRowid))
  assert.throws(
    () => createFeedback({ userId, category: 'payment', content: '这不是我的订单吧', contact: 'x', orderId: Number(stolen.lastInsertRowid) }),
    (error) => error.code === 'feedback_order_foreign' && error.status === 403,
  )
})

test('回复把状态推进到已回复，只改状态时不覆盖已有回复', () => {
  const created = createFeedback({ userId, category: 'playback', content: '第三集卡在 12 分钟处', contact: '13800000001' })
  const replied = replyFeedback({ id: created.id, reply: '已切换线路，请刷新后重看', adminId: 1 })
  assert.equal(replied.status, 'replied')
  assert.equal(replied.reply, '已切换线路，请刷新后重看')
  assert.ok(replied.replied_at)
  assert.throws(() => replyFeedback({ id: created.id, reply: '短' }), /太短/)

  const status = setFeedbackStatus({ id: created.id, status: 'resolved', note: '用户确认已恢复', adminId: 1 })
  assert.equal(status.status, 'resolved')
  assert.equal(status.reply, '已切换线路，请刷新后重看')
  assert.match(status.admin_note, /用户确认已恢复/)
  assert.throws(() => setFeedbackStatus({ id: created.id, status: 'nope' }), /状态不合法/)
})

test('从反馈发起退款：默认退剩余全额，重复发起回 409，无订单直接报错', () => {
  const created = createFeedback({ userId, category: 'payment', content: '不想看了，申请退款', contact: '13800000001', orderId })
  const { refund, feedback } = refundFeedback({ id: created.id, reason: '用户投诉退款', operatorId: 2 })
  assert.equal(refund.status, 'pending')
  assert.equal(Number(refund.amount), 19.9)
  assert.equal(feedback.refund_id, refund.id)
  assert.equal(feedback.status, 'processing')
  assert.throws(
    () => refundFeedback({ id: created.id, reason: '再退一次', operatorId: 2 }),
    (error) => error.code === 'feedback_refund_exists' && error.status === 409,
  )

  const noOrder = createFeedback({ userId, category: 'suggestion', content: '希望加一个倍速记忆', contact: '13800000001' })
  assert.throws(() => refundFeedback({ id: noOrder.id, reason: '随便退点', operatorId: 2 }), /没有关联订单/)
})

test('列表按区间/状态/分类/关键词过滤，状态 open 合并待处理与处理中', () => {
  db.exec('DELETE FROM feedbacks')
  // 北京时间今天（11-17）：01:00 / 09:00 / 16:00 三条
  seedFeedback('2026-11-16 17:00:00', { status: 'pending', category: 'playback' })
  seedFeedback('2026-11-17 01:00:00', { status: 'processing', category: 'payment' })
  seedFeedback('2026-11-17 08:00:00', { status: 'closed', category: 'account' })
  // 昨天（北京 11-16 23:00）
  seedFeedback('2026-11-16 15:00:00', { status: 'replied', category: 'playback', reply: '已处理' })
  // 15 天前：只进近 30 天
  seedFeedback('2026-11-02 03:00:00', { status: 'pending', category: 'playback' })

  assert.equal(listFeedbacks({ range: 'today', now: NOW }).total, 3)
  assert.equal(listFeedbacks({ range: 'yesterday', now: NOW }).total, 1)
  assert.equal(listFeedbacks({ range: '7d', now: NOW }).total, 4)
  assert.equal(listFeedbacks({ range: '30d', now: NOW }).total, 5)
  assert.equal(listFeedbacks({ range: '7d', status: 'open', now: NOW }).total, 2)
  assert.equal(listFeedbacks({ range: '7d', status: 'closed', now: NOW }).total, 1)
  assert.equal(listFeedbacks({ range: '7d', category: 'payment', now: NOW }).total, 1)
  assert.equal(listFeedbacks({ range: '7d', q: '内容问题', now: NOW }).total, 4)
  assert.equal(listFeedbacks({ range: '7d', q: '不存在的关键词', now: NOW }).total, 0)

  // 角标忽略状态筛选但保留区间：近 7 天里待处理/处理中/已回复/已关闭各 1
  const counts = listFeedbacks({ range: '7d', status: 'closed', now: NOW }).counts
  assert.equal(counts.byStatus.pending, 1)
  assert.equal(counts.byStatus.processing, 1)
  assert.equal(counts.byStatus.replied, 1)
  assert.equal(counts.byStatus.closed, 1)
  assert.equal(counts.total, 4)
  assert.equal(countFeedbacks({ range: '30d', now: NOW }), 5)
})

test('反馈统计按四区间出数，趋势桶数随区间变化', () => {
  assert.equal(feedbackStats('today', NOW).totals.tickets, 3)
  assert.equal(feedbackStats('yesterday', NOW).totals.tickets, 1)
  assert.equal(feedbackStats('7d', NOW).totals.tickets, 4)
  assert.equal(feedbackStats('30d', NOW).totals.tickets, 5)
  assert.equal(feedbackStats('today', NOW).trend.length, 17)
  assert.equal(feedbackStats('yesterday', NOW).trend.length, 24, '昨天是 24 个整点桶，右端开区间不能多补一格')
  assert.equal(feedbackStats('7d', NOW).trend.length, 7)
  assert.equal(feedbackStats('30d', NOW).trend.length, 30)
  assert.equal(feedbackStats('nope', NOW).range, '7d')
  const stats = feedbackStats('7d', NOW)
  assert.equal(stats.totals.open, 2)
  assert.equal(stats.totals.replied, 1)
  assert.equal(stats.byCategory[0].count >= 1, true)
  assert.equal(stats.categories.length, 7)
  assert.ok(stats.oldestPending)
})

test('我的反馈只返回本人提交，按订单可反查同一单的所有工单', () => {
  db.exec('DELETE FROM feedbacks')
  const mine = createFeedback({ userId, category: 'playback', content: '播放一直转圈怎么解决', contact: '13800000001', orderId })
  createFeedback({ category: 'other', content: '匿名游客的问题描述', contact: 'guest@example.com', visitorId: 'v-anon' })
  const list = listMyFeedbacks(userId)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, mine.id)
  assert.equal(feedbacksOfOrder(orderId).length, 1)
})
