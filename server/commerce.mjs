/**
 * 交易域：套餐/优惠券、下单、支付回调（mock/支付宝/USDT）、发放权益、退款、对账。
 * 原则：所有资金相关写入都走事务；回调幂等靠 payments.channel_txn_id 唯一键。
 */
import { createHash, createSign, createVerify, randomBytes } from 'node:crypto'
import { db, getSetting } from './db.mjs'
import { grantPurchase, grantSubscription, revokeByOrder, policyOf } from './entitlements.mjs'
import { currentKeyVersion, maskConfig, openSecret, sealSecret } from './secretbox.mjs'
import * as alipay from './payments/alipay.mjs'

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

/* ---------------- 支付渠道（多渠道路由 + 配置解密） ---------------- */

export function channelConfig(row) {
  if (!row?.config_cipher) return {}
  try { return openSecret(row.config_cipher) } catch (error) { console.error('[pay-channel] 解密失败', row.id, error.message); return {} }
}

export function listChannels({ scene } = {}) {
  const rows = scene
    ? all('SELECT * FROM pay_channels WHERE scene = ? OR scene = \'all\' ORDER BY priority, id', scene)
    : all('SELECT * FROM pay_channels ORDER BY priority, id')
  return rows.map((row) => {
    // 可用性必须在剥掉密文之前算：channelUsable 需要解密后的 config
    const verdict = channelUsable(row)
    return {
      ...row,
      config_cipher: undefined,
      config_preview: row.config_preview ? JSON.parse(row.config_preview) : maskConfig(channelConfig(row)),
      hasSecret: Boolean(row.config_cipher),
      usable: verdict.usable,
      unavailableReason: verdict.usable ? '' : verdict.reason,
    }
  })
}

/**
 * 选渠道：显式指定优先；否则按场景取默认（is_default），再按 priority 兜底。
 * 会校验金额区间与币种，避免"配了但用不了"。
 */
const SIM_PAY_ALLOWED = () => process.env.MH_ALLOW_SIM_PAY === '1'
const TRON_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/

/**
 * 渠道是否真的能收款。
 * 「启用」只是开关，不等于「可用」：支付宝缺商户密钥、USDT 缺地址时，
 * 下单必须直接失败，绝不能下发模拟收银台（那等于白送会员）。
 */
export function channelUsable(row) {
  if (!row) return { usable: false, reason: '支付渠道不存在' }
  if (row.status !== 'enabled') return { usable: false, reason: '支付渠道已停用' }
  const config = channelConfig(row)
  switch (row.channel_code) {
    case 'mock':
      return SIM_PAY_ALLOWED()
        ? { usable: true, reason: '' }
        : { usable: false, reason: '模拟支付通道已关闭' }
    case 'alipay': {
      const hasKeys = Boolean(config.appId && config.privateKey && config.publicKey)
      if (hasKeys) return { usable: true, reason: '' }
      return SIM_PAY_ALLOWED()
        ? { usable: true, reason: '', simulated: true }
        : { usable: false, reason: '支付宝商户密钥未配置（需 appId / 应用私钥 / 支付宝公钥）' }
    }
    case 'usdt': {
      const address = String(config.walletAddress ?? '')
      if (!TRON_ADDRESS.test(address)) return { usable: false, reason: 'USDT 收款地址未配置或格式不正确' }
      return { usable: true, reason: '' }
    }
    default:
      return { usable: true, reason: '' }
  }
}

export function resolveChannel({ scene = 'all', channelCode, amount = 0, currency } = {}) {
  const rows = all("SELECT * FROM pay_channels WHERE status = 'enabled' ORDER BY is_default DESC, priority ASC, id ASC")
  const candidates = rows.filter((row) => {
    if (channelCode) return row.channel_code === channelCode
    return row.scene === 'all' || row.scene === scene
  }).filter((row) => {
    if (currency && row.currency && row.currency !== currency && row.channel_code !== 'usdt') return false
    if (row.min_amount > 0 && amount < row.min_amount) return false
    if (row.max_amount > 0 && amount > row.max_amount) return false
    // 显式指定渠道时不做可用性过滤，让调用方拿到明确的原因（channel_not_configured）
    if (channelCode) return true
    return channelUsable(row).usable
  })
  return candidates[0]
}

export function paymentOptions(scene = 'all') {
  return listChannels({ scene })
    .filter((row) => row.status === 'enabled')
    .map((row) => ({
      code: row.channel_code, name: row.name, scene: row.scene, currency: row.currency,
      isDefault: Boolean(row.is_default), priority: row.priority,
      minAmount: row.min_amount, maxAmount: row.max_amount,
      configured: row.usable,
      usable: row.usable,
      unavailableReason: row.unavailableReason ?? '',
    }))
}

function resolveByCode(channelCode) {
  const rows = all("SELECT * FROM pay_channels WHERE channel_code = ? AND status = 'enabled' ORDER BY is_default DESC, priority ASC LIMIT 1", channelCode)
  return rows[0]
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

export function createOrder({ userId, productType, planId, dramaId, channel, couponCode }) {
  if (!userId) throw new CommerceError('unauthorized', '请先登录', 401)
  const { price, plan, policy } = basePriceOf({ productType, planId, dramaId })
  const couponResult = validateCoupon(couponCode, price)
  if (!couponResult.ok) throw new CommerceError('coupon_invalid', couponResult.message)
  const amount = Math.max(0.01, Math.round((price - couponResult.discount) * 100) / 100)

  // 渠道解析：显式指定 > 场景默认 > 优先级兜底；金额/币种不满足则跳过
  const scene = productType === 'subscription' ? 'subscription' : 'single'
  const row = resolveChannel({ scene, channelCode: channel || undefined, amount })
  if (!row) throw new CommerceError('channel_unavailable', '没有可用的支付渠道（后台「支付渠道」里启用并配置好一个）')
  const verdict = channelUsable(row)
  if (!verdict.usable) throw new CommerceError('channel_not_configured', verdict.reason, 409)
  const channelCode = row.channel_code
  const config = channelConfig(row)
  const rate = Number(config.rate ?? getSetting('site', {}).usdtRate ?? 7.2)

  const order = {
    outTradeNo: outTradeNo(),
    amount,
    usdtAmount: channelCode === 'usdt' ? Math.round((amount / rate) * 100) / 100 : null,
    usdtRate: channelCode === 'usdt' ? rate : null,
    address: channelCode === 'usdt' ? (config.walletAddress ?? '') : null,
  }

  const info = run(`INSERT INTO orders
    (out_trade_no, user_id, product_type, plan_id, drama_id, amount_cny, coupon_id, channel, status, pay_url,
     usdt_amount, usdt_rate, usdt_address, expires_at, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
  order.outTradeNo, userId, productType,
  productType === 'subscription' ? plan.id : null,
  productType === 'single' ? Number(dramaId) : null,
  amount, couponResult.coupon?.id ?? null, channelCode,
  channelCode === 'mock' ? `/pay/mock/${order.outTradeNo}` : null,
  order.usdtAmount, order.usdtRate, order.address,
  new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 19).replace('T', ' '),
  JSON.stringify({
    basePrice: price, discount: couponResult.discount, purchaseKind: policy?.purchase_kind ?? null,
    couponCode: couponCode ?? null,
    channelId: row.id, channelEnv: row.env, channelKeyVersion: row.key_version,
  }),
  )
  const created = one('SELECT * FROM orders WHERE id = ?', Number(info.lastInsertRowid))

  if (channelCode === 'alipay') {
    const configured = Boolean(config.appId && config.privateKey && config.publicKey)
    if (!configured && !SIM_PAY_ALLOWED()) {
      throw new CommerceError('channel_not_configured', '支付宝商户密钥未配置，暂不可用', 409)
    }
    return {
      order: created,
      payUrl: configured ? buildAlipayPayUrl(created, config) : `/pay/alipay-sim/${created.out_trade_no}`,
      simulated: !configured,
    }
  }
  if (channelCode === 'usdt') {
    return {
      order: created,
      payUrl: null,
      usdt: {
        network: config.network ?? 'TRC20',
        address: created.usdt_address,
        amount: created.usdt_amount,
        rate: created.usdt_rate,
        expiresAt: created.expires_at,
        minConfirmations: Number(config.minConfirmations ?? 19),
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

/* --- USDT：只由进程内链上监听调用（无公网回调入口） --- */
export function handleUsdtNotify({ outTradeNo, txid, amount, confirmations, channelId }) {
  const row = channelId ? one('SELECT * FROM pay_channels WHERE id = ?', Number(channelId)) : resolveByCode('usdt')
  const config = channelConfig(row ?? {})
  const minConf = Number(config.minConfirmations ?? 19)
  if (!txid) throw new CommerceError('txid_missing', '缺少链上 txid')
  const order = one('SELECT * FROM orders WHERE out_trade_no = ?', String(outTradeNo))
  if (!order) throw new CommerceError('order_not_found', '订单不存在', 404)
  if (order.status === 'closed') throw new CommerceError('order_closed', '订单已超时关闭，需人工处理', 409)
  const expected = Number(order.usdt_amount ?? 0)
  if (!(Number(amount) > 0)) throw new CommerceError('amount_required', '缺少链上转账金额')
  // 容差与监听端保持一致（0.01 USDT），避免"监听匹配成功但入账被拒"
  if (expected > 0 && Math.abs(Number(amount) - expected) > 0.01) {
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

/* --- 支付宝（RSA2） --- */
export function alipayChannel() {
  const row = resolveByCode('alipay')
  if (!row) return undefined
  return { row, config: { ...channelConfig(row), env: row.env } }
}

function saveChannelConfig(row, config) {
  run(`UPDATE pay_channels SET config_cipher = ?, config_preview = ?, key_version = ?, updated_at = datetime('now') WHERE id = ?`,
    sealSecret(config), JSON.stringify(maskConfig(config)), currentKeyVersion(), row.id)
}

/** 首次使用模拟收银台时，为渠道生成 RSA 密钥对（加密入库），后续强制走真实签名/验签。 */
export function ensureAlipaySimulator() {
  const channel = alipayChannel()
  if (!channel) throw new CommerceError('channel_not_found', '支付宝渠道不存在', 404)
  const config = alipay.ensureSimulatorKeys(channel.config)
  if (!channel.config.simPrivateKey) {
    saveChannelConfig(channel.row, config)
    return { ...channel, config }
  }
  return channel
}

export function buildAlipayPayUrl(order, config) {
  try {
    return alipay.buildPagePayUrl(order, config)
  } catch (error) {
    throw new CommerceError(error.code ?? 'alipay_error', error.message)
  }
}

export function handleAlipayNotify(body, { simulator = false } = {}) {
  const channel = alipayChannel()
  if (!channel) throw new CommerceError('channel_not_found', '支付宝渠道不存在', 404)
  const verifyKey = simulator ? channel.config.simPublicKey : channel.config.publicKey
  if (!verifyKey) {
    throw new CommerceError('alipay_not_configured', simulator ? '模拟收银台未初始化（先发起一笔支付宝订单）' : '支付宝公钥未配置', 500)
  }
  const parsed = alipay.parseNotify(body, verifyKey)
  if (!parsed.ok) throw new CommerceError('sign_invalid', '支付宝验签失败', 400)
  if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(parsed.tradeStatus)) {
    return { ignored: true, tradeStatus: parsed.tradeStatus }
  }
  return markPaid({
    outTradeNo: parsed.outTradeNo,
    channel: 'alipay',
    channelTxnId: parsed.tradeNo,
    amount: parsed.totalAmount,
    raw: parsed.raw,
  })
}

/** 查单兜底：订单轮询时主动向支付宝查一次，避免回调丢失导致权益不到账。 */
export async function syncAlipayOrder(outTradeNo) {
  const order = one('SELECT * FROM orders WHERE out_trade_no = ?', String(outTradeNo))
  if (!order || order.channel !== 'alipay') return { synced: false, reason: 'not_alipay' }
  if (order.status === 'fulfilled' || order.status === 'paid') return { synced: false, reason: 'already_paid', order }
  const channel = alipayChannel()
  if (!channel?.config?.appId || !channel?.config?.privateKey) return { synced: false, reason: 'not_configured' }
  try {
    const result = await alipay.queryTrade(channel.config, order.out_trade_no)
    if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(result.trade_status)) {
      const paid = markPaid({
        outTradeNo: order.out_trade_no,
        channel: 'alipay',
        channelTxnId: result.trade_no,
        amount: Number(result.total_amount),
        raw: result,
      })
      return { synced: true, tradeStatus: result.trade_status, order: paid.order }
    }
    return { synced: false, tradeStatus: result.trade_status }
  } catch (error) {
    return { synced: false, reason: error.message }
  }
}

export function buildSimulatedAlipayNotify(outTradeNo) {
  const order = one('SELECT * FROM orders WHERE out_trade_no = ?', String(outTradeNo))
  if (!order) throw new CommerceError('order_not_found', '订单不存在', 404)
  if (order.channel !== 'alipay') throw new CommerceError('channel_mismatch', '该订单不是支付宝订单', 400)
  const channel = ensureAlipaySimulator()
  return { order, params: alipay.buildSimulatedNotify(order, channel.config) }
}

/* ---------------- 渠道管理（后台） ---------------- */

const CHANNEL_FIELDS = new Set(['channel_code', 'name', 'scene', 'env', 'status', 'priority', 'currency', 'min_amount', 'max_amount', 'remark'])

/** 新增/更新渠道。config 只接收"新增的明文"，未提供的敏感字段保留原值（写后不可读）。 */
export function upsertChannel(payload, channelId) {
  const existing = channelId
    ? one('SELECT * FROM pay_channels WHERE id = ?', Number(channelId))
    : one('SELECT * FROM pay_channels WHERE channel_code = ? AND env = ? AND scene = ?',
      String(payload.channelCode ?? payload.channel_code ?? ''), payload.env ?? 'sandbox', payload.scene ?? 'all')

  const code = String(payload.channelCode ?? payload.channel_code ?? existing?.channel_code ?? '').trim()
  if (!code) throw new CommerceError('channel_code_required', '渠道编码必填')

  const mergedConfig = { ...(existing ? channelConfig(existing) : {}) }
  const providedConfig = payload.config ?? {}
  let configDirty = false
  for (const [key, value] of Object.entries(providedConfig)) {
    if (value === undefined || value === null) continue
    if (value === '' && key in mergedConfig) continue       // 空值 = 不修改
    mergedConfig[key] = value
    configDirty = true
  }
  if (!existing) configDirty = true

  const fields = {
    channel_code: code,
    name: payload.name ?? existing?.name ?? code,
    scene: payload.scene ?? existing?.scene ?? 'all',
    env: payload.env ?? existing?.env ?? 'sandbox',
    status: payload.status ?? existing?.status ?? 'disabled',
    priority: Number(payload.priority ?? existing?.priority ?? 100),
    currency: payload.currency ?? existing?.currency ?? 'CNY',
    min_amount: Number(payload.minAmount ?? existing?.min_amount ?? 0),
    max_amount: Number(payload.maxAmount ?? existing?.max_amount ?? 0),
    remark: payload.remark ?? existing?.remark ?? null,
  }

  const cipher = configDirty || !existing ? sealSecret(mergedConfig) : existing.config_cipher
  const preview = configDirty || !existing ? JSON.stringify(maskConfig(mergedConfig)) : existing.config_preview
  const version = existing?.key_version ?? currentKeyVersion()

  if (existing) {
    run(`UPDATE pay_channels SET channel_code=?, name=?, scene=?, env=?, status=?, priority=?, currency=?,
      min_amount=?, max_amount=?, config_cipher=?, config_preview=?, key_version=?, remark=?, updated_at=datetime('now')
      WHERE id=?`,
    fields.channel_code, fields.name, fields.scene, fields.env, fields.status, fields.priority,
    fields.currency, fields.min_amount, fields.max_amount, cipher, preview, version, fields.remark, existing.id)
    return one('SELECT * FROM pay_channels WHERE id = ?', existing.id)
  }
  const info = run(`INSERT INTO pay_channels
    (channel_code, name, scene, env, status, is_default, priority, currency, min_amount, max_amount, config_cipher, config_preview, key_version, remark)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
  fields.channel_code, fields.name, fields.scene, fields.env, fields.status, fields.priority,
  fields.currency, fields.min_amount, fields.max_amount, cipher, preview, version, fields.remark)
  return one('SELECT * FROM pay_channels WHERE id = ?', Number(info.lastInsertRowid))
}

export function setChannelStatus({ channelId, status }) {
  const channel = one('SELECT * FROM pay_channels WHERE id = ?', Number(channelId))
  if (!channel) throw new CommerceError('channel_not_found', '渠道不存在', 404)
  run("UPDATE pay_channels SET status = ?, updated_at = datetime('now') WHERE id = ?", status === 'enabled' ? 'enabled' : 'disabled', channel.id)
  // 停用后清掉默认标记，避免"默认渠道不可用"
  if (status !== 'enabled' && channel.is_default) {
    run('UPDATE pay_channels SET is_default = 0 WHERE id = ?', channel.id)
  }
  return one('SELECT * FROM pay_channels WHERE id = ?', channel.id)
}

/** 设默认：同一 scene 内唯一；切换在一个事务里完成，避免并发出现双默认。 */
export function setDefaultChannel({ channelId }) {
  const channel = one('SELECT * FROM pay_channels WHERE id = ?', Number(channelId))
  if (!channel) throw new CommerceError('channel_not_found', '渠道不存在', 404)
  if (channel.status !== 'enabled') throw new CommerceError('channel_disabled', '只有启用中的渠道可设为默认')
  db.exec('BEGIN')
  try {
    run('UPDATE pay_channels SET is_default = 0 WHERE scene = ?', channel.scene)
    run('UPDATE pay_channels SET is_default = 1, updated_at = datetime(\'now\') WHERE id = ?', channel.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return one('SELECT * FROM pay_channels WHERE id = ?', channel.id)
}

export function deleteChannel({ channelId }) {
  const channel = one('SELECT * FROM pay_channels WHERE id = ?', Number(channelId))
  if (!channel) throw new CommerceError('channel_not_found', '渠道不存在', 404)
  if (channel.is_default) throw new CommerceError('channel_is_default', '默认渠道不能删除，请先切换默认')
  run('DELETE FROM pay_channels WHERE id = ?', channel.id)
  return { deleted: true }
}

/** 测试渠道：校验必填配置并做一次真实签名/验签自检（不发真实请求，避免误扣款）。 */
export function testChannel({ channelId }) {
  const channel = one('SELECT * FROM pay_channels WHERE id = ?', Number(channelId))
  if (!channel) throw new CommerceError('channel_not_found', '渠道不存在', 404)
  const config = channelConfig(channel)
  const required = {
    alipay: ['appId', 'privateKey', 'publicKey'],
    wechat: ['appId', 'mchId', 'apiV3Key'],
    usdt: ['walletAddress'],
  }[channel.channel_code] ?? []
  const missing = required.filter((key) => !config[key])

  let signatureCheck
  if (channel.channel_code === 'alipay') {
    // 有模拟密钥就用模拟密钥自检，否则用真实密钥自检
    const keyPair = config.simPrivateKey && config.simPublicKey
      ? { privateKey: config.simPrivateKey, publicKey: config.simPublicKey, mode: 'simulator' }
      : { privateKey: config.privateKey, publicKey: config.publicKey, mode: 'real' }
    if (keyPair.privateKey && keyPair.publicKey) {
      const sample = { app_id: config.appId ?? 'test', out_trade_no: 'SELFTEST', total_amount: '0.01', timestamp: String(Date.now()) }
      const signature = alipay.signRSA2(sample, keyPair.privateKey)
      signatureCheck = { mode: keyPair.mode, ok: alipay.verifyRSA2({ ...sample, sign: signature }, keyPair.publicKey) }
    }
  }

  return {
    channelId: channel.id, channelCode: channel.channel_code,
    ok: missing.length === 0 && (signatureCheck?.ok ?? true),
    missing,
    signatureCheck,
    keyVersion: channel.key_version, env: channel.env,
    checkedAt: nowSql(),
  }
}

export { nowSql, resolveByCode }
