/**
 * 核心域回归：权益判定矩阵、订单状态机与幂等、优惠券、双人复核、播放签名。
 * 运行：node --test test/
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-test-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_LINK_SECRET = 'test-link-secret'
process.env.MH_SECRET = 'test-secret'

let db, seedIfEmpty, ent, commerce, rbac, auth

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  seedIfEmpty = dbModule.seedIfEmpty
  seedIfEmpty()
  dbModule.syncMenuCatalog()
  dbModule.migratePayChannels()
  // 生产默认禁用模拟支付；测试显式打开
  process.env.MH_ALLOW_SIM_PAY = '1'
  dbModule.db.prepare("UPDATE pay_channels SET status = 'enabled', is_default = 1 WHERE channel_code = 'mock'").run()
  dbModule.setSetting('pay', { ...dbModule.getSetting('pay', {}), mock: { enabled: true } })
  ent = await import('../server/entitlements.mjs')
  commerce = await import('../server/commerce.mjs')
  rbac = await import('../server/rbac.mjs')
  auth = await import('../server/auth.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const userId = () => db.prepare("INSERT INTO users (phone, nickname) VALUES (?, 'tester')").run(`1${Date.now()}${Math.floor(Math.random() * 1000)}`).lastInsertRowid

/* ---------------- 权益矩阵 ---------------- */
test('权益判定顺序：单片 > 订阅 > 免费集 > 拒绝', () => {
  const uid = Number(userId())
  const drama = db.prepare("SELECT * FROM dramas WHERE category != 'MOVIE' ORDER BY id LIMIT 1").get()
  db.prepare("UPDATE content_policies SET access_mode='subscription', free_episodes=1, trial_seconds=300 WHERE drama_id=?").run(drama.id)

  // 1) 无权益：第 1 集免费，第 2 集拒绝
  assert.equal(ent.resolveAccess(uid, drama.id, 1).source, 'free')
  const denied = ent.resolveAccess(uid, drama.id, 2)
  assert.equal(denied.allow, false)
  assert.equal(denied.reason, 'subscription_required')
  assert.equal(denied.trialSeconds, 300)

  // 2) 订阅后：全部可看
  db.prepare("INSERT INTO subscriptions (user_id, plan_id, scope, valid_to, status) VALUES (?, 1, 'all', datetime('now','+30 day'), 'active')").run(uid)
  assert.equal(ent.resolveAccess(uid, drama.id, 2).source, 'subscription')

  // 3) 单片付费内容：订阅也不放行，需购买
  db.prepare("UPDATE content_policies SET access_mode='paid', single_price_cny=12 WHERE drama_id=?").run(drama.id)
  const blocked = ent.resolveAccess(uid, drama.id, 1)
  assert.equal(blocked.allow, false)
  assert.equal(blocked.reason, 'single_purchase_required')
  assert.equal(blocked.price, 12)

  // 4) 购买后：优先命中 purchase
  db.prepare("INSERT INTO purchases (user_id, drama_id, kind, status) VALUES (?, ?, 'single', 'active')").run(uid, drama.id)
  assert.equal(ent.resolveAccess(uid, drama.id, 1).source, 'purchase')
})

test('过期订阅不再授权', () => {
  const uid = Number(userId())
  const drama = db.prepare("SELECT * FROM dramas WHERE category != 'MOVIE' ORDER BY id DESC LIMIT 1").get()
  db.prepare("UPDATE content_policies SET access_mode='subscription', free_episodes=0 WHERE drama_id=?").run(drama.id)
  db.prepare("INSERT INTO subscriptions (user_id, plan_id, scope, valid_to, status) VALUES (?, 1, 'all', datetime('now','-1 day'), 'active')").run(uid)
  assert.equal(ent.resolveAccess(uid, drama.id, 2).allow, false)
})

/* ---------------- 订单状态机 ---------------- */
test('下单 → 支付 → 发放权益，回调幂等', () => {
  const uid = Number(userId())
  const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock' })
  assert.equal(order.status, 'created')
  assert.ok(order.amount_cny > 0)

  const first = commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: 'TX-1' })
  assert.equal(first.order.status, 'fulfilled')

  // 同一 channel_txn_id 重放 → 不重复发放
  const again = commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: 'TX-1' })
  assert.equal(again.duplicate, true)
  const subs = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE order_id = ?').get(order.id).n
  assert.equal(subs, 1)
})

test('金额不一致的支付回调被拒绝', () => {
  const uid = Number(userId())
  const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 2, channel: 'mock' })
  assert.throws(
    () => commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: 'TX-BAD', amount: order.amount_cny + 10 }),
    /金额不一致/,
  )
})

test('超时订单会被关闭', () => {
  const uid = Number(userId())
  const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock' })
  db.prepare("UPDATE orders SET expires_at = datetime('now','-1 minute') WHERE id = ?").run(order.id)
  commerce.closeExpiredOrders()
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'closed')
})

/* ---------------- 优惠券 ---------------- */
test('优惠券：满减、折扣、门槛与停用', () => {
  const ok = commerce.validateCoupon('WELCOME10', 25)
  assert.equal(ok.ok, true)
  assert.equal(ok.discount, 10)

  const belowMin = commerce.validateCoupon('WELCOME10', 20)
  assert.equal(belowMin.ok, false)

  const percent = commerce.validateCoupon('VIP15', 100)
  assert.equal(percent.ok, true)
  assert.equal(percent.discount, 15)

  const missing = commerce.validateCoupon('NOPE', 100)
  assert.equal(missing.ok, false)
})

test('下单使用优惠券后金额正确且券计数递增', () => {
  const uid = Number(userId())
  const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 3, channel: 'mock', couponCode: 'WELCOME10' })
  const before = db.prepare("SELECT used FROM coupons WHERE code='WELCOME10'").get().used
  commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: `TX-C-${order.id}` })
  const after = db.prepare("SELECT used FROM coupons WHERE code='WELCOME10'").get().used
  assert.equal(after, before + 1)
  assert.ok(order.amount_cny < 238)
})

/* ---------------- 退款双人复核 ---------------- */
test('退款：发起人不能自己审批，他人审批后回收权益', () => {
  const uid = Number(userId())
  const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock' })
  commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: `TX-R-${order.id}` })

  const refund = commerce.createRefund({ orderId: order.id, amount: order.amount_cny, reason: '用户申请退款', operatorId: 2 })
  assert.throws(() => commerce.approveRefund({ refundId: refund.id, approverId: 2 }), /双人复核/)

  const result = commerce.approveRefund({ refundId: refund.id, approverId: 3 })
  assert.equal(result.revoked.subscriptions, 1)
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'refunded')
  assert.equal(ent.resolveAccess(uid, db.prepare('SELECT id FROM dramas LIMIT 1').get().id, 5).allow, false)
})

/* ---------------- RBAC ---------------- */
test('RBAC：内容运营不能退款，超管可以', () => {
  const ops = rbac.loadPrincipal(db.prepare("SELECT id FROM admins WHERE username='ops01'").get().id)
  const admin = rbac.loadPrincipal(db.prepare("SELECT id FROM admins WHERE username='admin'").get().id)
  assert.equal(rbac.hasPermission(ops, 'finance.refund.create'), false)
  assert.equal(rbac.hasPermission(ops, 'content.drama.write'), true)
  assert.equal(rbac.hasPermission(admin, 'finance.refund.approve'), true)
})

test('审计日志可写入与查询', () => {
  rbac.audit({ actorId: 1, actorName: 'admin', action: 'test.action', targetType: 'unit', targetId: 1 })
  const logs = rbac.listAudit({ limit: 5 })
  assert.ok(logs.some((log) => log.action === 'test.action'))
})

/* ---------------- 播放签名 ---------------- */
test('播放签名：正确签名通过，篡改/过期失败', () => {
  const uri = '/media/hls/1/index.m3u8'
  const link = ent.secureLink(uri, 60)
  assert.equal(ent.verifyLink(uri, link.sign, link.expires), true)
  assert.equal(ent.verifyLink('/media/hls/2/index.m3u8', link.sign, link.expires), false)
  assert.equal(ent.verifyLink(uri, link.sign, Math.floor(Date.now() / 1000) - 10), false)
})

/* ---------------- 账号 ---------------- */
test('管理员口令校验与 token', () => {
  const result = auth.loginAdmin('admin', 'admin123')
  assert.ok(result?.token)
  const payload = auth.verifyToken(result.token)
  assert.equal(payload.role, 'admin')
  assert.equal(auth.loginAdmin('admin', 'wrong'), undefined)
})
