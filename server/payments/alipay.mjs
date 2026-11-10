/**
 * 支付宝（RSA2）完整实现：签名、验签、页面支付、查单、退款、关单、异步通知。
 * 兼容正式环境与沙箱；未配置商户参数时可用内置模拟收银台（同一套签名/验签逻辑）。
 */
import { createSign, createVerify, generateKeyPairSync } from 'node:crypto'

export const GATEWAY = {
  prod: 'https://openapi.alipay.com/gateway.do',
  sandbox: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
}

/** 业务参数以外所有公共参数，按字典序拼接（去掉 sign / sign_type）。 */
export function canonical(params) {
  return Object.keys(params)
    .filter((key) => key !== 'sign' && key !== 'sign_type' && params[key] !== undefined && params[key] !== null && params[key] !== '')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('&')
}

export function signRSA2(params, privateKeyPem) {
  if (!privateKeyPem) throw new Error('缺少支付宝商户私钥')
  const signer = createSign('RSA-SHA256')
  signer.update(canonical(params), 'utf8')
  return signer.sign(privateKeyPem, 'base64')
}

export function verifyRSA2(params, publicKeyPem) {
  if (!params?.sign || !publicKeyPem) return false
  const verifier = createVerify('RSA-SHA256')
  verifier.update(canonical(params), 'utf8')
  try {
    return verifier.verify(publicKeyPem, params.sign, 'base64')
  } catch {
    return false
  }
}

function gatewayOf(config) {
  if (config.gateway) return config.gateway
  return config.env === 'prod' ? GATEWAY.prod : GATEWAY.sandbox
}

function publicParams(config, method, bizContent) {
  return {
    app_id: config.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
    version: '1.0',
    notify_url: config.notifyUrl,
    return_url: config.returnUrl,
    biz_content: JSON.stringify(bizContent ?? {}),
  }
}

/** 电脑网站支付：返回可直接跳转的 URL。 */
export function buildPagePayUrl(order, config) {
  if (!config?.appId || !config?.privateKey) {
    const error = new Error('支付宝渠道未配置 AppID / 商户私钥')
    error.code = 'alipay_not_configured'
    throw error
  }
  const params = publicParams(config, 'alipay.trade.page.pay', {
    out_trade_no: order.out_trade_no,
    total_amount: Number(order.amount_cny).toFixed(2),
    subject: config.subject ?? '影巢会员/单片',
    product_code: 'FAST_INSTANT_TRADE_PAY',
    timeout_express: '15m',
  })
  params.sign = signRSA2(params, config.privateKey)
  const query = new URLSearchParams(params).toString()
  return `${gatewayOf(config)}?${query}`
}

/** 统一请求（表单 POST，JSON 返回）。 */
export async function callAlipay(config, method, bizContent) {
  const params = publicParams(config, method, bizContent)
  params.sign = signRSA2(params, config.privateKey)
  const response = await fetch(gatewayOf(config), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15000),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`支付宝返回非 JSON：${text.slice(0, 200)}`) }
  const key = `${method.replace(/\./g, '_')}_response`
  const payload = json[key] ?? json.error_response ?? {}
  if (payload.code && payload.code !== '10000') {
    const error = new Error(payload.sub_msg || payload.msg || `支付宝错误 ${payload.code}`)
    error.code = payload.sub_code || payload.code
    error.payload = payload
    throw error
  }
  return payload
}

export const queryTrade = (config, outTradeNo) => callAlipay(config, 'alipay.trade.query', { out_trade_no: outTradeNo })

export const refundTrade = (config, { outTradeNo, amount, reason, outRequestNo }) => callAlipay(config, 'alipay.trade.refund', {
  out_trade_no: outTradeNo,
  refund_amount: Number(amount).toFixed(2),
  refund_reason: reason?.slice(0, 200),
  out_request_no: outRequestNo,
})

export const closeTrade = (config, outTradeNo) => callAlipay(config, 'alipay.trade.close', { out_trade_no: outTradeNo })

/** 异步通知：验签 + 归一化。 */
export function parseNotify(params, publicKeyPem) {
  const ok = verifyRSA2(params, publicKeyPem)
  return {
    ok,
    outTradeNo: params.out_trade_no,
    tradeNo: params.trade_no,
    totalAmount: Number(params.total_amount ?? 0),
    tradeStatus: params.trade_status,
    appId: params.app_id,
    buyerId: params.buyer_id,
    notifyId: params.notify_id,
    gmtPayment: params.gmt_payment,
    raw: params,
  }
}

/**
 * 模拟收银台：生成一对**独立的**模拟密钥（simPrivateKey/simPublicKey），
 * 不覆盖真实的商户密钥；付款时用模拟私钥签通知、服务端用模拟公钥验签。
 */
export function ensureSimulatorKeys(config) {
  if (config.simPrivateKey && config.simPublicKey) return config
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { ...config, simulator: true, simPrivateKey: privateKey, simPublicKey: publicKey }
}

/** 构造一笔"已支付"的异步通知参数（签名用模拟私钥）。 */
export function buildSimulatedNotify(order, config) {
  const params = {
    app_id: config.appId || '2021000000000000',
    notify_id: `sim-${Date.now()}`,
    notify_type: 'trade_status_sync',
    notify_time: new Date().toISOString().slice(0, 19).replace('T', ' '),
    charset: 'utf-8',
    version: '1.0',
    sign_type: 'RSA2',
    trade_no: `SIM${Date.now()}`,
    out_trade_no: order.out_trade_no,
    trade_status: 'TRADE_SUCCESS',
    total_amount: Number(order.amount_cny).toFixed(2),
    seller_id: config.sellerId ?? '2088000000000000',
    buyer_id: '2088100000000000',
    gmt_payment: new Date().toISOString().slice(0, 19).replace('T', ' '),
  }
  params.sign = signRSA2(params, config.simPrivateKey ?? config.privateKey)
  return params
}
