/**
 * 修复回归（报告 §3.2 P1-15..19）：退款事务性、对账补录幂等、券限用/额度/时区、
 * BEGIN IMMEDIATE + busy 退避、多级佣金关系指针与风控口径、统计净额口径。
 * 运行：node --test test/fix-commerce.test.mjs
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const dir = mkdtempSync(join(tmpdir(), 'mh-fix-commerce-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_LINK_SECRET = 'test-link-secret'
process.env.MH_SECRET = 'test-secret'
process.env.MH_ALLOW_SIM_PAY = '1'

let db, dbModule, commerce, dist

before(async () => {
  dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dbModule.migratePayChannels()
  db.prepare("UPDATE pay_channels SET status = 'enabled', is_default = 1 WHERE channel_code = 'mock'").run()
  dbModule.setSetting('pay', { ...dbModule.getSetting('pay', {}), mock: { enabled: true } })
  commerce = await import('../server/commerce.mjs')
  dist = await import('../server/distribution.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const newUser = () => Number(db.prepare("INSERT INTO users (phone, nickname) VALUES (?, 'fix')")
  .run(`1${Date.now()}${Math.floor(Math.random() * 100000)}`).lastInsertRowid)

const couponOf = (code) => db.prepare('SELECT * FROM coupons WHERE code = ?').get(code)

function makeCoupon({ code, total = 0, discount = 5, minAmount = 0, validFrom = null, validTo = null, type = 'amount' }) {
  db.prepare(`INSERT INTO coupons
    (code, name, discount_type, discount_value, min_amount, total, used, valid_from, valid_to, status)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'active')`)
    .run(code, code, type, discount, minAmount, total, validFrom, validTo)
  return couponOf(code)
}

const paidOrder = (userId, planId = 1) => {
  const { order } = commerce.createOrder({ userId, productType: 'subscription', planId, channel: 'mock' })
  commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: `FIX-${order.id}-${Date.now()}` })
  return order
}

/* ---------------- P1-15 退款：审批与执行同事务 ---------------- */

test('退款执行抛错时整笔回滚：退款单仍是 pending，订单金额未被记退款', () => {
  const uid = newUser()
  const order = paidOrder(uid)
  const refund = commerce.createRefund({ orderId: order.id, amount: order.amount_cny, reason: '回归：执行抛错', operatorId: 9001 })

  // 让事务里的最后一步（佣金冲减 outbox）真实抛错
  db.exec('ALTER TABLE commission_reversal_outbox RENAME TO commission_reversal_outbox_bak')
  try {
    assert.throws(() => commerce.approveRefund({ refundId: refund.id, approverId: 9002 }), /no such table/)
  } finally {
    db.exec('ALTER TABLE commission_reversal_outbox_bak RENAME TO commission_reversal_outbox')
  }

  const afterFail = db.prepare('SELECT * FROM refunds WHERE id = ?').get(refund.id)
  assert.equal(afterFail.status, 'pending')
  assert.equal(afterFail.approver_id, null)
  assert.equal(Number(db.prepare('SELECT refunded_amount FROM orders WHERE id = ?').get(order.id).refunded_amount), 0)

  // 状态没被卡死：锁恢复后可以直接重新审批
  const done = commerce.approveRefund({ refundId: refund.id, approverId: 9002 })
  assert.equal(done.ok, true)
  assert.equal(done.refund.status, 'done')
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'refunded')
})

test('支付宝退款接口未开启时返回明确失败语义，订单不被记退款', () => {
  db.prepare("UPDATE pay_channels SET status = 'enabled' WHERE channel_code = 'alipay'").run()
  const pay = dbModule.getSetting('pay', {})
  dbModule.setSetting('pay', { ...pay, alipay: { ...(pay.alipay ?? {}), refundEnabled: false } })
  try {
    const uid = newUser()
    const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'alipay' })
    assert.equal(order.channel, 'alipay')
    commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'alipay', channelTxnId: `FIX-ALI-${order.id}` })
    const refund = commerce.createRefund({ orderId: order.id, amount: order.amount_cny, reason: '回归：网关未开退款', operatorId: 9101 })
    const result = commerce.approveRefund({ refundId: refund.id, approverId: 9102 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'refund_disabled')
    assert.equal(result.refund.status, 'approved')
    assert.equal(Number(db.prepare('SELECT refunded_amount FROM orders WHERE id = ?').get(order.id).refunded_amount), 0)
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'fulfilled')
  } finally {
    db.prepare("UPDATE pay_channels SET status = 'disabled' WHERE channel_code = 'alipay'").run()
    dbModule.setSetting('pay', { ...pay, alipay: { ...(pay.alipay ?? {}), refundEnabled: false } })
  }
})

/* ---------------- P1-16 对账：真正补录支付流水 ---------------- */

test('对账为 fulfilled 但无 payments 行的订单真补录，连跑两次幂等', () => {
  const uid = newUser()
  const order = paidOrder(uid)
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'fulfilled')
  // 复现历史 bug 留下的状态：订单已 fulfilled，但 payments 行缺失
  db.prepare('DELETE FROM payments WHERE order_id = ?').run(order.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(order.id).n, 0)

  const first = commerce.reconcile()
  const rows = db.prepare('SELECT * FROM payments WHERE order_id = ?').all(order.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].channel_txn_id, `reconcile:${order.out_trade_no}`)
  assert.equal(Number(rows[0].amount), Number(order.amount_cny))
  assert.equal(Number(rows[0].verified), 0)
  assert.ok(first.missingPayment >= 1)

  const second = commerce.reconcile()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(order.id).n, 1)
  assert.equal(second.missingPayment, 0)
  assert.equal(second.fixes.some((fix) => Number(fix.orderId) === Number(order.id)), false)
})

/* ---------------- P1-17 优惠券：每人限用 / 额度预占 / 时区 ---------------- */

test('同一张券每人只能下单一次，第二次被拒且不留订单', () => {
  const coupon = makeCoupon({ code: 'FIX-ONCE', total: 10, discount: 5 })
  const uid = newUser()
  commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code })
  assert.throws(
    () => commerce.createOrder({ userId: uid, productType: 'subscription', planId: 2, channel: 'mock', couponCode: coupon.code }),
    /限用一次/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?')
    .get(coupon.id, uid).n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(uid).n, 1)
  assert.equal(Number(couponOf(coupon.code).used), 0)
})

test('券总量为 1 时第二笔下单被拒（不超发），used 只在支付成功后递增', () => {
  const coupon = makeCoupon({ code: 'FIX-ONE-SLOT', total: 1, discount: 3 })
  const a = newUser()
  const b = newUser()
  const { order } = commerce.createOrder({ userId: a, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code })
  assert.equal(Number(couponOf(coupon.code).used), 0)
  assert.throws(
    () => commerce.createOrder({ userId: b, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code }),
    /已领完/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(b).n, 0)
  commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: `FIX-SLOT-${order.id}` })
  assert.equal(Number(couponOf(coupon.code).used), 1)
})

test('订单超时关闭时释放券预占，额度可以被下一单继续使用', () => {
  const coupon = makeCoupon({ code: 'FIX-RELEASE', total: 1, discount: 2 })
  const a = newUser()
  const b = newUser()
  const { order } = commerce.createOrder({ userId: a, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code })
  assert.throws(
    () => commerce.createOrder({ userId: b, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code }),
    /已领完/,
  )
  db.prepare("UPDATE orders SET expires_at = datetime('now','-1 minute') WHERE id = ?").run(order.id)
  assert.ok(commerce.closeExpiredOrders() >= 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ?').get(order.id).n, 0)
  const reused = commerce.createOrder({ userId: b, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code })
  assert.ok(reused.order.id > 0)
})

test('券有效期按 Asia/Shanghai 判定：上海当天可用，UTC 昨天必过期、上海明天必未生效', () => {
  const today = db.prepare("SELECT date('now','+8 hours') AS d").get().d
  db.prepare(`INSERT INTO coupons (code, name, discount_type, discount_value, min_amount, total, used, valid_from, valid_to, status)
    VALUES ('FIX-TZ-TODAY', '时区当天', 'amount', 5, 0, 0, 0, ?, ?, 'active')`).run(today, today)
  db.prepare(`INSERT INTO coupons (code, name, discount_type, discount_value, min_amount, total, used, valid_from, valid_to, status)
    VALUES ('FIX-TZ-UTC', 'UTC 昨天', 'amount', 5, 0, 0, 0, NULL, date('now','-1 day'), 'active')`).run()
  db.prepare(`INSERT INTO coupons (code, name, discount_type, discount_value, min_amount, total, used, valid_from, valid_to, status)
    VALUES ('FIX-TZ-FUTURE', '上海明天生效', 'amount', 5, 0, 0, 0, date('now','+8 hours','+1 day'), NULL, 'active')`).run()

  assert.equal(commerce.validateCoupon('FIX-TZ-TODAY', 25).ok, true)
  const expired = commerce.validateCoupon('FIX-TZ-UTC', 25)
  assert.equal(expired.ok, false)
  assert.equal(expired.message, '优惠券已过期')
  const future = commerce.validateCoupon('FIX-TZ-FUTURE', 25)
  assert.equal(future.ok, false)
  assert.equal(future.message, '优惠券未生效')
})

test('券额度已满时历史订单的支付仍完成，used 不越过 total', () => {
  const coupon = makeCoupon({ code: 'FIX-OVERFLOW', total: 1, discount: 1 })
  const uid = newUser()
  // 模拟修复前下的单：没有 coupon_redemptions 占用行，而券额度已被别处用满
  const info = db.prepare(`INSERT INTO orders
    (out_trade_no, user_id, product_type, plan_id, amount_cny, coupon_id, channel, status, meta_json)
    VALUES (?, ?, 'subscription', 1, 24, ?, 'mock', 'created', '{}')`)
    .run(`FIXLEGACY${Date.now()}`, uid, coupon.id)
  const orderId = Number(info.lastInsertRowid)
  db.prepare('UPDATE coupons SET used = total WHERE id = ?').run(coupon.id)

  const paid = commerce.markPaid({ orderId, channel: 'mock', channelTxnId: `FIX-OVER-${orderId}` })
  assert.equal(paid.order.status, 'fulfilled')
  assert.equal(Number(couponOf(coupon.code).used), 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(orderId).n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ?').get(orderId).n, 1)
})

/* ---------------- P1-18 写事务：BEGIN IMMEDIATE + busy 退避 ---------------- */

test('写事务遇锁竞争：退避重试后如实抛出，不留半截记账', () => {
  const uid = newUser()
  // 订单先建好（这步不参与锁竞争），后面用 markPaid 直接打事务（tx 的第一步就是 BEGIN IMMEDIATE）
  const { order } = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock' })
  const other = new DatabaseSync(process.env.MH_DB)
  db.exec('PRAGMA busy_timeout = 0')
  other.exec('PRAGMA busy_timeout = 0')
  other.exec('BEGIN IMMEDIATE')
  const startedAt = Date.now()
  try {
    assert.throws(
      () => commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: `FIX-BUSY-${order.id}` }),
      /SQLITE_BUSY|database is locked/i,
    )
  } finally {
    other.exec('ROLLBACK')
    other.close()
    db.exec('PRAGMA busy_timeout = 5000')
  }
  // 3 次退避（20/60/150ms）后才放弃，说明确实在排队重试而不是立刻失败
  assert.ok(Date.now() - startedAt >= 200)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(order.id).n, 0)
  assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(order.id).status, 'created')
  // 锁释放后同一条路径恢复正常
  const ok = commerce.markPaid({ outTradeNo: order.out_trade_no, channel: 'mock', channelTxnId: `FIX-BUSY-${order.id}` })
  assert.equal(ok.order.status, 'fulfilled')
})

/* ---------------- P1-19 多级佣金：关系指针与风控口径 ---------------- */

function threeLevelChain() {
  const a = newUser()
  const b = newUser()
  const c = newUser()
  const d = newUser()
  for (const uid of [a, b, c, d]) dist.applyDistributor(uid)
  const codeA = dist.getOrCreateReferralCode(a).code
  const codeB = dist.getOrCreateReferralCode(b).code
  const codeC = dist.getOrCreateReferralCode(c).code
  dist.recordInviteClick({ code: codeA, visitorId: 'fx-b' })
  dist.bindReferral({ userId: b, visitorId: 'fx-b', code: codeA })
  dist.recordInviteClick({ code: codeB, visitorId: 'fx-c' })
  dist.bindReferral({ userId: c, visitorId: 'fx-c', code: codeB })
  dist.recordInviteClick({ code: codeC, visitorId: 'fx-d' })
  dist.bindReferral({ userId: d, visitorId: 'fx-d', code: codeC })
  for (const level of [1, 2, 3]) {
    dist.upsertCommissionRule({ ruleCode: `FIX_L${level}`, relationLevel: level, rateBp: [1000, 500, 300][level - 1] })
  }
  return { a, b, c, d }
}

test('二三级佣金记录指向各自层级的关系，直属关系被冻结不连带上级', () => {
  const { b, c, d } = threeLevelChain()
  const relAB = db.prepare('SELECT * FROM distribution_relations WHERE invitee_user_id = ?').get(b)
  const relBC = db.prepare('SELECT * FROM distribution_relations WHERE invitee_user_id = ?').get(c)
  const relCD = db.prepare('SELECT * FROM distribution_relations WHERE invitee_user_id = ?').get(d)

  const order = paidOrder(d)
  const records = db.prepare('SELECT * FROM commission_records WHERE order_id = ? ORDER BY commission_level').all(order.id)
  assert.equal(records.length, 3)
  assert.deepEqual(records.map((row) => Number(row.source_relation_id)),
    [Number(relCD.id), Number(relBC.id), Number(relAB.id)])

  // 只冻结直属关系（c→d）：一级佣金停住，二三级按自己那一层的关系照常放行
  db.prepare("UPDATE distribution_relations SET risk_status = 'frozen' WHERE id = ?").run(relCD.id)
  db.prepare("UPDATE commission_records SET available_at = datetime('now','-1 minute') WHERE order_id = ?").run(order.id)
  dist.markCommissionsAvailable()
  const statuses = db.prepare('SELECT status FROM commission_records WHERE order_id = ? ORDER BY commission_level').all(order.id)
  assert.deepEqual(statuses.map((row) => row.status), ['frozen', 'available', 'available'])
})

test('佣金的关系行被置空后不放行（fail-closed）', () => {
  // 恢复所有关系，避免上一条用例的冻结干扰
  db.prepare("UPDATE distribution_relations SET status = 'active', risk_status = 'normal'").run()
  const target = db.prepare("SELECT * FROM commission_records WHERE status = 'frozen' ORDER BY id DESC LIMIT 1").get()
  assert.ok(target)
  db.prepare('UPDATE commission_records SET source_relation_id = NULL, available_at = datetime(\'now\',\'-1 minute\') WHERE id = ?')
    .run(target.id)
  dist.markCommissionsAvailable()
  assert.equal(db.prepare('SELECT status FROM commission_records WHERE id = ?').get(target.id).status, 'frozen')
})

/* ---------------- 汇总口径：SQL 聚合 / 净额 / 过期租赁 ---------------- */

test('分销分析 totals 覆盖全部推广员，不受展示 200 行限制', () => {
  const before = dist.distributionAnalytics({ days: 3650 }).totals
  const insertUser = db.prepare("INSERT INTO users (phone, nickname) VALUES (?, 'bulk')")
  const insertProfile = db.prepare(`INSERT INTO distributor_profiles
    (user_id, status, available_balance_fen, frozen_balance_fen, settled_total_fen) VALUES (?, 'active', 0, 0, 0)`)
  const insertRelation = db.prepare(`INSERT INTO distribution_relations
    (inviter_user_id, invitee_user_id, relation_level, status, risk_status) VALUES (?, ?, 1, 'active', 'normal')`)
  const insertClosure = db.prepare(`INSERT OR IGNORE INTO distribution_tree_closure
    (ancestor_user_id, descendant_user_id, depth) VALUES (?, ?, 1)`)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (let i = 0; i < 205; i += 1) {
      const inviter = Number(insertUser.run(`9${Date.now()}${i}`).lastInsertRowid)
      const invitee = Number(insertUser.run(`8${Date.now()}${i}`).lastInsertRowid)
      insertProfile.run(inviter)
      insertRelation.run(inviter, invitee)
      insertClosure.run(inviter, invitee)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const page = dist.distributionAnalytics({ days: 3650 })
  assert.equal(page.rows.length, 200)
  assert.equal(page.totals.directInvitees - before.directInvitees, 205)
})

test('交易统计按净额计：部分退款减少收入，过期租赁不计入 purchases', () => {
  const uid = newUser()
  const order = paidOrder(uid)
  const before = commerce.commerceStats()
  const refund = commerce.createRefund({ orderId: order.id, amount: 10, reason: '回归：部分退款净额', operatorId: 9301 })
  const done = commerce.approveRefund({ refundId: refund.id, approverId: 9302 })
  assert.equal(done.ok, true)
  const after = commerce.commerceStats()
  assert.equal(Math.round((before.revenue - after.revenue) * 100) / 100, 10)
  assert.equal(Math.round((after.refunded - before.refunded) * 100) / 100, 10)
  assert.equal(Math.round((before.grossRevenue - after.grossRevenue) * 100) / 100, 0)

  const drama = db.prepare('SELECT id FROM dramas LIMIT 1').get()
  const purchaseBefore = commerce.commerceStats().purchases
  db.prepare("INSERT INTO purchases (user_id, drama_id, kind, expires_at, status) VALUES (?, ?, 'rental', datetime('now','-1 hour'), 'active')")
    .run(uid, drama.id)
  db.prepare("INSERT INTO purchases (user_id, drama_id, kind, expires_at, status) VALUES (?, ?, 'rental', datetime('now','+1 hour'), 'active')")
    .run(uid, drama.id)
  db.prepare("INSERT INTO purchases (user_id, drama_id, kind, expires_at, status) VALUES (?, ?, 'single', NULL, 'active')")
    .run(uid, drama.id)
  assert.equal(commerce.commerceStats().purchases - purchaseBefore, 2)
})

test('分销看板层级支付金额按净额统计：部分退款后同步减少', () => {
  const inviter = newUser()
  const invitee = newUser()
  dist.applyDistributor(inviter)
  const code = dist.getOrCreateReferralCode(inviter).code
  dist.recordInviteClick({ code, visitorId: 'fx-net' })
  dist.bindReferral({ userId: invitee, visitorId: 'fx-net', code })
  const order = paidOrder(invitee)
  const levelOne = () => Number(dist.distributionDashboard({ days: 7 }).byLevel
    .find((row) => Number(row.level) === 1)?.paidAmount ?? 0)
  const before = levelOne()
  const refund = commerce.createRefund({ orderId: order.id, amount: 10, reason: '看板净额回归用例', operatorId: 9401 })
  commerce.approveRefund({ refundId: refund.id, approverId: 9402 })
  const after = levelOne()
  assert.equal(Math.round((before - after) * 100) / 100, 10)
})

/* ---------------- 归因绑定与下单同事务（lead 补） ---------------- */

const acquisitionsOf = (userId) => Number(db.prepare(
  'SELECT COUNT(*) AS n FROM user_acquisitions WHERE user_id = ?').get(userId)?.n ?? 0)

test('首触归因绑定与订单同事务提交：下单成功即建立 user_acquisitions', () => {
  const uid = newUser()
  assert.equal(acquisitionsOf(uid), 0)
  commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock' })
  assert.equal(acquisitionsOf(uid), 1)
})

test('下单在事务中途失败时归因绑定一起回滚，不留孤儿首触记录', () => {
  const uid = newUser()
  const coupon = makeCoupon({ code: `TXROLL${Date.now()}`, total: 1, discount: 1 })
  // 另一个用户先占掉唯一一张券的额度（未支付，只在 coupon_redemptions 里占位）
  commerce.createOrder({ userId: newUser(), productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code })
  assert.equal(acquisitionsOf(uid), 0)
  // 这一单会在 tx 内部抛 coupon_exhausted：归因写入发生在同一个事务里，必须跟着回滚
  assert.throws(
    () => commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1, channel: 'mock', couponCode: coupon.code }),
    /优惠券已领完/)
  assert.equal(acquisitionsOf(uid), 0)
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE user_id = ?').get(uid)?.n ?? 0), 0)
})
