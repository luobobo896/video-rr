/**
 * 交易域：套餐/优惠券、下单、支付回调（mock/支付宝/USDT）、发放权益、退款、对账。
 * 原则：所有资金相关写入都走事务；回调幂等靠 payments.channel_txn_id 唯一键。
 */
import { createHash, createSign, createVerify, randomBytes } from 'node:crypto'
import { db, getSetting } from './db.mjs'
import { grantPurchase, grantSubscription, revokeByOrder, policyOf } from './entitlements.mjs'
import { currentKeyVersion, maskConfig, openSecret, sealSecret } from './secretbox.mjs'

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
  return rows.map((row) => ({
    ...row,
    config_cipher: undefined,
    config_preview: row.config_preview ? JSON.parse(row.config_preview) : maskConfig(channelConfig(row)),
    hasSecret: Boolean(row.config_cipher),
  }))
}

/**
 * 选渠道：显式指定优先；否则按场景取默认（is_default），再按 priority 兜底。
 * 会校验金额区间与币种，避免"配了但用不了"。
 */
export function resolveChannel({ scene = 'all', channelCode, amount = 0, currency } = {}) {
  const rows = all("SELECT * FROM pay_channels WHERE status = 'enabled' ORDER BY is_default DESC, priority ASC, id ASC")
  const candidates = rows.filter((row) => {
    if (channelCode) return row.channel_code === channelCode
    return row.scene === 'all' || row.scene === scene
  }).filter((row) => {
    if (currency && row.currency && row.currency !== currency && row.channel_code !== 'usdt') return false
    if (row.min_amount > 0 && amount < row.min_amount) return false
    if (row.max_amount > 0 && amount > row.max_amount) return false
    return true
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
      configured: Object.values(row.config_preview ?? {}).some((value) => value && value !== ''),
    }))
}

function resolveByCode(channelCode) {
  const rows = all('SELECT * FROM pay_channels WHERE channel_code = ? ORDER BY is_default DESC, priority ASC LIMIT 1', channelCode)
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
  if (!row) throw new CommerceError('channel_unavailable', '没有可用的支付渠道（后台「支付渠道」里启用一个）')
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
    return { order: created, payUrl: buildAlipayPayUrl(created, config) }
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

export function buildAlipayPayUrl(order, config = channelConfig(resolveByCode('alipay') ?? {})) {
  if (!config.appId || !config.privateKey) throw new CommerceError('alipay_not_configured', '支付宝渠道未配置 AppID / 商户私钥（后台「支付渠道」里填写）')
  const params = {
    app_id: config.appId,
    method: 'alipay.trade.page.pay',
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    version: '1.0',
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    biz_content: JSON.stringify({
      out_trade_no: order.out_trade_no,
      total_amount: order.amount_cny.toFixed(2),
      subject: '影巢会员/单片',
      product_code: 'FAST_INSTANT_TRADE_PAY',
    }),
  }
  params.sign = alipaySign(params, config.privateKey)
  return `${config.gateway ?? 'https://openapi.alipay.com/gateway.do'}?${new URLSearchParams(params).toString()}`
}

export function handleAlipayNotify(body) {
  const config = channelConfig(resolveByCode('alipay') ?? {})
  if (!config.publicKey) throw new CommerceError('alipay_not_configured', '支付宝公钥未配置', 500)
  if (!alipayVerify(body, config.publicKey)) throw new CommerceError('sign_invalid', '支付宝验签失败', 400)
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
  const config = channelConfig(resolveByCode('usdt') ?? {})
  const minConf = Number(config.minConfirmations ?? 19)
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

/** 测试渠道：校验必填配置是否齐全（不发真实请求，避免误扣款）。 */
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
  return {
    channelId: channel.id, channelCode: channel.channel_code,
    ok: missing.length === 0, missing,
    keyVersion: channel.key_version, env: channel.env,
    checkedAt: nowSql(),
  }
}

export { nowSql, resolveByCode }
