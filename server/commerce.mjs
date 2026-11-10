/**
 * 交易域：套餐/优惠券、下单、支付回调（mock/支付宝/USDT）、发放权益、退款、对账。
 * 原则：所有资金相关写入都走事务；回调幂等靠 payments.channel_txn_id 唯一键。
 */
import { createHash, createSign, createVerify, randomBytes } from 'node:crypto'
import { db, getSetting } from './db.mjs'
import { grantPurchase, grantSubscription, revokeByOrder, policyOf } from './entitlements.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const outTradeNo = () => `MH${Date.now()}${randomBytes(2).toString('hex').toUpperCase()}`
const tx = (fn) => {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export class CommerceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/* ---------------- 优惠券 ---------------- */

export function validateCoupon(code, amountCny) {
  if (!code) return { ok: true, discount: 0, coupon: null }
  const coupon = one('SELECT * FROM coupons WHERE code = ?', String(code).toUpperCase())
  if (!coupon) return { ok: false, message: '优惠券不存在' }
  if (coupon.status !== 'active') return { ok: false, message: '优惠券已停用' }
  const today = new Date().toISOString().slice(0, 10)
  if (coupon.valid_from && coupon.valid_from.slice(0, 10) > today) return { ok: false, message: '优惠券未生效' }
  if (coupon.valid_to && coupon.valid_to.slice(0, 10) < today) return { ok: false, message: '优惠券已过期' }
  if (coupon.total > 0 && coupon.used >= coupon.total) return { ok: false, message: '优惠券已领完' }
  if (amountCny < coupon.min_amount) return { ok: false, message: `满 ¥${coupon.min_amount} 可用` }
  const discount = coupon.discount_type === 'amount'
    ? Math.min(amountCny, coupon.discount_value)
    : Math.round(amountCny * (coupon.discount_value / 100) * 100) / 100
  return { ok: true, discount, coupon }
}

/* ---------------- 下单 ---------------- */

export function basePriceOf({ productType, planId, dramaId }) {
  if (productType === 'subscription') {
    const plan = one('SELECT * FROM plans WHERE id = ?', planId)
    if (!plan || plan.status !== 'active') throw new CommerceError('plan_not_found', '套餐不存在或已下架')
    return { price: plan.price_cny, plan }
  }
  const policy = policyOf(dramaId)
  if (!policy) throw new CommerceError('content_not_found', '内容不存在')
  if (policy.access_mode !== 'paid') throw new CommerceError('not_purchasable', '该内容无需单片购买')
  return { price: policy.single_price_cny, policy }
}

export function createOrder({ userId, productType, planId, dramaId, channel = 'mock', couponCode }) {
  if (!userId) throw new CommerceError('unauthorized', '请先登录', 401)
  const { price, plan, policy } = basePriceOf({ productType, planId, dramaId })
  const couponResult = validateCoupon(couponCode, price)
  if (!couponResult.ok) throw new CommerceError('coupon_invalid', couponResult.message)
  const amount = Math.max(0.01, Math.round((price - couponResult.discount) * 100) / 100)

  const site = getSetting('site', {})
  const pay = getSetting('pay', {})
  const rate = Number(site.usdtRate ?? 7.2)
  const order = {
    outTradeNo: outTradeNo(),
    amount,
    usdtAmount: channel === 'usdt' ? Math.round((amount / rate) * 100) / 100 : null,
    usdtRate: channel === 'usdt' ? rate : null,
    address: channel === 'usdt' ? (pay.usdt?.address ?? '') : null,
  }

  const info = run(`INSERT INTO orders
    (out_trade_no, user_id, product_type, plan_id, drama_id, amount_cny, coupon_id, channel, status, pay_url,
     usdt_amount, usdt_rate, usdt_address, expires_at, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
  order.outTradeNo, userId, productType,
  productType === 'subscription' ? plan.id : null,
  productType === 'single' ? Number(dramaId) : null,
  amount, couponResult.coupon?.id ?? null, channel,
  channel === 'mock' ? `/pay/mock/${order.outTradeNo}` : null,
  order.usdtAmount, order.usdtRate, order.address,
  new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 19).replace('T', ' '),
  JSON.stringify({ basePrice: price, discount: couponResult.discount, purchaseKind: policy?.purchase_kind ?? null, couponCode: couponCode ?? null }),
  )
  const created = one('SELECT * FROM orders WHERE id = ?', Number(info.lastInsertRowid))

  if (channel === 'alipay') {
    const alipay = getSetting('pay', {}).alipay
    if (!alipay?.enabled) throw new CommerceError('channel_disabled', '支付宝支付未开通（后台「支付配置」里开启并填入商户参数）')
    return { order: created, payUrl: buildAlipayPayUrl(created) }
  }
  if (channel === 'usdt') {
    const usdt = getSetting('pay', {}).usdt
    if (!usdt?.enabled) throw new CommerceError('channel_disabled', 'USDT 支付未开通')
    return {
      order: created,
      payUrl: null,
      usdt: {
        network: usdt.network ?? 'TRC20',
        address: created.usdt_address,
        amount: created.usdt_amount,
        rate: created.usdt_rate,
        expiresAt: created.expires_at,
        minConfirmations: usdt.minConfirmations ?? 19,
      },
    }
  }
  return { order: created, payUrl: `/pay/mock/${created.out_trade_no}` }
}

/* ---------------- 支付：发放 + 幂等 ---------------- */

export function fulfillOrder(order) {
  if (order.product_type === 'subscription') {
    return grantSubscription({ userId: order.user_id, planId: order.plan_id, orderId: order.id })
  }
  const policy = policyOf(order.drama_id)
  return grantPurchase({
    userId: order.user_id,
    dramaId: order.drama_id,
    orderId: order.id,
    kind: policy?.purchase_kind ?? 'single',
    rentalHours: policy?.rental_hours ?? 72,
  })
}

/**
 * 记一笔支付并发权益。幂等：
 *  - 同一 channel_txn_id 重复回调 → 直接返回既有订单
 *  - 订单已 fulfilled → 直接返回
 */
export function markPaid({ outTradeNo, orderId, channel, channelTxnId, amount, currency = 'CNY', raw }) {
  return tx(() => {
    const order = outTradeNo
      ? one('SELECT * FROM orders WHERE out_trade_no = ?', String(outTradeNo))
      : one('SELECT * FROM orders WHERE id = ?', Number(orderId))
    if (!order) throw new CommerceError('order_not_found', '订单不存在', 404)

    const existingPayment = one('SELECT * FROM payments WHERE channel_txn_id = ?', channelTxnId)
    if (existingPayment) return { order, duplicate: true, payment: existingPayment }
    if (order.status === 'fulfilled') return { order, duplicate: true }
    if (order.status === 'closed') throw new CommerceError('order_closed', '订单已关闭')
    if (order.status === 'refunded') throw new CommerceError('order_refunded', '订单已退款')

    if (amount !== undefined && Math.abs(Number(amount) - Number(order.amount_cny)) > 0.01) {
      throw new CommerceError('amount_mismatch', `金额不一致：应付 ${order.amount_cny}，实收 ${amount}`)
    }

    const payment = run(`INSERT INTO payments (order_id, channel, channel_txn_id, amount, currency, verified, raw_json)
      VALUES (?, ?, ?, ?, ?, 1, ?)`, order.id, channel, channelTxnId, Number(amount ?? order.amount_cny), currency, JSON.stringify(raw ?? {}).slice(0, 4000))

    run(`UPDATE orders SET status = 'paid', paid_at = datetime('now'), channel = ?, channel_txn_id = ? WHERE id = ?`,
      channel, channelTxnId, order.id)

    fulfillOrder(order)
    run(`UPDATE orders SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?`, order.id)
    if (order.coupon_id) {
      run('UPDATE coupons SET used = used + 1 WHERE id = ?', order.coupon_id)
      run('INSERT OR IGNORE INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES (?, ?, ?)', order.coupon_id, order.user_id, order.id)
    }
    const paid = one('SELECT * FROM orders WHERE id = ?', order.id)
    return { order: paid, paymentId: Number(payment.lastInsertRowid), duplicate: false }
  })
}

/* ---------------- 支付渠道实现 ---------------- */

/** 模拟支付（仅演示/联调用，生产必须关闭）。 */
export function mockPay(outTradeNo) {
  const pay = getSetting('pay', {})
  if (!pay.mock?.enabled) throw new CommerceError('channel_disabled', '模拟支付未开启')
  return markPaid({ outTradeNo, channel: 'mock', channelTxnId: `MOCK-${outTradeNo}`, raw: { mock: true } })
}

/* --- 支付宝（RSA2；未配置密钥时明确报错） --- */
function sortedQuery(params) {
  return Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== '' && key !== 'sign')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

export function alipaySign(params, privateKeyPem) {
  const sign = createSign('RSA-SHA256')
  sign.update(sortedQuery(params), 'utf8')
  return sign.sign(privateKeyPem, 'base64')
}

export function alipayVerify(params, publicKeyPem) {
  const sign = params.sign
  if (!sign) return false
  const verify = createVerify('RSA-SHA256')
  verify.update(sortedQuery(params), 'utf8')
  return verify.verify(publicKeyPem, sign, 'base64')
}

export function buildAlipayPayUrl(order) {
  const pay = getSetting('pay', {}).alipay ?? {}
  if (!pay.appId || !pay.privateKey) throw new CommerceError('alipay_not_configured', '支付宝商户参数未配置')
  const params = {
    app_id: pay.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    version: '1.0',
    notify_url: pay.notifyUrl,
    return_url: pay.returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.out_trade_no,
      total_amount: order.amount_cny.toFixed(2),
      subject: '影巢会员/单片',
      product_code: 'FAST_INSTANT_TRADE_PAY',
    }),
  }
  params.sign = alipaySign(params, pay.privateKey)
  return `${pay.gateway ?? 'https://openapi.alipay.com/gateway.do'}?${new URLSearchParams(params).toString()}`
}

export function handleAlipayNotify(body) {
  const pay = getSetting('pay', {}).alipay ?? {}
  if (!pay.publicKey) throw new CommerceError('alipay_not_configured', '支付宝公钥未配置', 500)
  if (!alipayVerify(body, pay.publicKey)) throw new CommerceError('sign_invalid', '支付宝验签失败', 400)
  if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(body.trade_status)) {
    return { ignored: true, tradeStatus: body.trade_status }
  }
  return markPaid({
    outTradeNo: body.out_trade_no,
    channel: 'alipay',
    channelTxnId: body.trade_no,
    amount: Number(body.total_amount),
    raw: body,
  })
}

/* --- USDT（TRC20，链上确认后入账） --- */
export function handleUsdtNotify({ outTradeNo, txid, amount, confirmations }) {
  const pay = getSetting('pay', {}).usdt ?? {}
  const minConf = Number(pay.minConfirmations ?? 19)
  if (!txid) throw new CommerceError('txid_missing', '缺少链上 txid')
  const order = one('SELECT * FROM orders WHERE out_trade_no = ?', String(outTradeNo))
  if (!order) throw new CommerceError('order_not_found', '订单不存在', 404)
  const expected = Number(order.usdt_amount ?? 0)
  if (amount !== undefined && expected > 0 && Math.abs(Number(amount) - expected) > Math.max(0.01, expected * 0.005)) {
    throw new CommerceError('amount_mismatch', `USDT 金额不符：应 ${expected}，实 ${amount}`)
  }
  run('UPDATE orders SET usdt_confirmations = ? WHERE id = ?', Number(confirmations ?? 0), order.id)
  if (Number(confirmations ?? 0) < minConf) {
    return { pending: true, confirmations: Number(confirmations ?? 0), required: minConf }
  }
  return markPaid({ outTradeNo, channel: 'usdt', channelTxnId: txid, amount: order.amount_cny, currency: 'USDT', raw: { txid, confirmations } })
}

/* ---------------- 退款 ---------------- */

export function createRefund({ orderId, amount, reason, operatorId }) {
  if (!reason || String(reason).trim().length < 4) throw new CommerceError('reason_required', '退款原因必填（≥4 字）')
  const order = one('SELECT * FROM orders WHERE id = ?', orderId)
  if (!order) throw new CommerceError('order_not_found', '订单不存在', 404)
  if (!['paid', 'fulfilled'].includes(order.status)) throw new CommerceError('order_not_refundable', '当前订单状态不可退款')
  const refundAmount = Number(amount ?? order.amount_cny)
  if (refundAmount <= 0 || refundAmount > order.amount_cny - order.refunded_amount + 0.001) {
    throw new CommerceError('refund_amount_invalid', '退款金额不合法')
  }
  const pending = one("SELECT * FROM refunds WHERE order_id = ? AND status IN ('pending','approved')", order.id)
  if (pending) throw new CommerceError('refund_exists', '该订单已有待处理退款')
  const info = run("INSERT INTO refunds (order_id, amount, reason, operator_id, status) VALUES (?, ?, ?, ?, 'pending')",
    order.id, refundAmount, reason, operatorId ?? null)
  return one('SELECT * FROM refunds WHERE id = ?', Number(info.lastInsertRowid))
}

export function approveRefund({ refundId, approverId }) {
  const refund = one('SELECT * FROM refunds WHERE id = ?', refundId)
  if (!refund) throw new CommerceError('refund_not_found', '退款单不存在', 404)
  if (refund.status !== 'pending') throw new CommerceError('refund_state_invalid', '退款单状态不可审批')
  if (refund.operator_id && Number(refund.operator_id) === Number(approverId)) {
    throw new CommerceError('dual_control_required', '退款需双人复核：审批人不能是发起人')
  }
  run("UPDATE refunds SET status = 'approved', approver_id = ? WHERE id = ?", approverId ?? null, refund.id)
  return executeRefund(refund.id)
}

export function executeRefund(refundId) {
  return tx(() => {
    const refund = one('SELECT * FROM refunds WHERE id = ?', refundId)
    const order = one('SELECT * FROM orders WHERE id = ?', refund.order_id)
    // 渠道退款：mock 直接成功；支付宝/USDT 需真实接口，这里记录待人工执行
    const channel = order.channel
    if (channel === 'alipay') {
      const pay = getSetting('pay', {}).alipay ?? {}
      if (!pay.refundEnabled) {
        run("UPDATE refunds SET status = 'approved' WHERE id = ?", refund.id)
        return { refund, warning: '支付宝退款接口未启用：需在支付配置开启后再执行' }
      }
    }
    const revoked = revokeByOrder(order.id)
    run("UPDATE orders SET status = 'refunded', refunded_amount = refunded_amount + ? WHERE id = ?", refund.amount, order.id)
    run("UPDATE refunds SET status = 'done', done_at = datetime('now') WHERE id = ?", refund.id)
    return { refund: one('SELECT * FROM refunds WHERE id = ?', refund.id), revoked }
  })
}

export function rejectRefund({ refundId, approverId, reason }) {
  run("UPDATE refunds SET status = 'rejected', approver_id = ?, reason = ? WHERE id = ? AND status = 'pending'",
    approverId ?? null, reason ?? '未通过审核', refundId)
  return one('SELECT * FROM refunds WHERE id = ?', refundId)
}

/* ---------------- 对账 ---------------- */

export function reconcile() {
  const missingPayment = all(`SELECT o.* FROM orders o LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status IN ('paid','fulfilled') AND p.id IS NULL`)
  const orphanPayment = all(`SELECT p.*, o.status AS order_status FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE o.status NOT IN ('paid','fulfilled','refunded')`)
  const stuckPaid = all("SELECT * FROM orders WHERE status = 'paid'")
  const fixes = []
  for (const order of missingPayment) {
    const result = markPaid({ orderId: order.id, channel: order.channel ?? 'unknown', channelTxnId: `RECON-${order.out_trade_no}`, raw: { source: 'reconcile' } })
    fixes.push({ orderId: order.id, action: '补录支付并发权益', duplicate: result.duplicate })
  }
  for (const order of stuckPaid) {
    fulfillOrder(order)
    run("UPDATE orders SET status = 'fulfilled', fulfilled_at = datetime('now') WHERE id = ?", order.id)
    fixes.push({ orderId: order.id, action: '补发权益' })
  }
  return {
    checkedAt: nowSql(),
    missingPayment: missingPayment.length,
    orphanPayment: orphanPayment.length,
    stuckPaid: stuckPaid.length,
    fixes,
  }
}

/* ---------------- 汇总 ---------------- */

export function commerceStats() {
  const sum = (sql) => Number(one(sql)?.n ?? 0)
  return {
    revenue: sum("SELECT COALESCE(SUM(amount_cny),0) AS n FROM orders WHERE status IN ('paid','fulfilled')"),
    refunded: sum("SELECT COALESCE(SUM(refunded_amount),0) AS n FROM orders WHERE status = 'refunded'"),
    orders: sum('SELECT COUNT(*) AS n FROM orders'),
    paidOrders: sum("SELECT COUNT(*) AS n FROM orders WHERE status IN ('paid','fulfilled')"),
    pendingOrders: sum("SELECT COUNT(*) AS n FROM orders WHERE status IN ('created','pending')"),
    pendingRefunds: sum("SELECT COUNT(*) AS n FROM refunds WHERE status = 'pending'"),
    activeSubscriptions: sum("SELECT COUNT(*) AS n FROM subscriptions WHERE status = 'active' AND datetime(valid_to) > datetime('now')"),
    purchases: sum("SELECT COUNT(*) AS n FROM purchases WHERE status = 'active'"),
  }
}

export function listOrders({ limit = 100, status, userId } = {}) {
  const clauses = []
  const args = []
  if (status) { clauses.push('o.status = ?'); args.push(status) }
  if (userId) { clauses.push('o.user_id = ?'); args.push(Number(userId)) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT o.*, u.nickname, u.phone, p.name AS plan_name, d.title AS drama_title
    FROM orders o LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN plans p ON p.id = o.plan_id LEFT JOIN dramas d ON d.id = o.drama_id
    ${where} ORDER BY o.id DESC LIMIT ?`, ...args, Math.min(300, Number(limit) || 100))
}

/** 订单超时关单（定时任务每分钟跑）。 */
export function closeExpiredOrders() {
  const result = run(`UPDATE orders SET status = 'closed'
    WHERE status IN ('created','pending') AND datetime(expires_at) < datetime('now')`)
  return Number(result.changes ?? 0)
}

export { nowSql }
