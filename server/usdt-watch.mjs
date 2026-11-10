/**
 * USDT（TRC20）链上到账监听：替代人工点「确认到账」。
 *
 * 做法：定时拉 TronGrid 的 TRC20 转入记录（只拉配置的收款地址），
 * 命中未支付订单的应付金额即调用 handleUsdtNotify 入账（金额校验、幂等、审计都在 commerce 里）。
 *
 * 配置：支付渠道里 usdt 的 walletAddress 即监听地址；MH_TRON_API_KEY 可选（提高限额）。
 * 关闭：MH_USDT_WATCH=0。
 */
import { db, getSetting, setSetting } from './db.mjs'
import { channelConfig, handleUsdtNotify } from './commerce.mjs'

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const API_BASE = process.env.MH_TRON_API_BASE ?? 'https://api.trongrid.io'
/** 唯一权威：渠道 config.minConfirmations 优先，其次环境变量，最后 19（TRON 官方建议的交易所级确认数）。 */
const DEFAULT_MIN_CONFIRMATIONS = Math.max(1, Number(process.env.MH_USDT_MIN_CONFIRMATIONS ?? 19))
const AMOUNT_TOLERANCE = 0.01
const MATCH_WINDOW_HOURS = 6
const PAGE_LIMIT = 200
const TERMINAL = new Set(['credited'])

const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

let lastRun = { at: null, scanned: 0, matched: 0, error: null }

/** TRON 地址格式：T 开头、34 位 base58；演示地址与空值视为未配置。 */
const DEMO_ADDRESSES = new Set(['TDemoAddressForLocalTesting'])
const isValidTronAddress = (address) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(String(address ?? ''))

/** 取生效的 usdt 渠道（优先启用 + 默认），配置里的 walletAddress 即监听地址。 */
function usdtChannel() {
  const row = one(`SELECT * FROM pay_channels WHERE channel_code = 'usdt'
    ORDER BY (status = 'enabled') DESC, is_default DESC, id ASC LIMIT 1`)
  if (!row) return null
  const config = channelConfig(row) ?? {}
  const address = String(config.walletAddress ?? '')
  if (!address || DEMO_ADDRESSES.has(address) || !isValidTronAddress(address)) return null
  return { channel: row, config }
}

/** 确认数阈值：渠道配置优先，否则用全局默认值（两处口径统一在此函数）。 */
function minConfOf(config) {
  const value = Number(config?.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MIN_CONFIRMATIONS
}

async function fetchTransfers(address, { since = 0, limit = PAGE_LIMIT } = {}) {
  const url = `${API_BASE}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`
    + `?limit=${limit}&only_to=true&contract_address=${USDT_CONTRACT}`
    + (since > 0 ? `&min_timestamp=${Math.max(0, Number(since) - 1000)}` : '')
  const headers = { accept: 'application/json' }
  if (process.env.MH_TRON_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.MH_TRON_API_KEY
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error(`TronGrid HTTP ${response.status}`)
    const payload = await response.json()
    return Array.isArray(payload?.data) ? payload.data : []
  } finally {
    clearTimeout(timer)
  }
}

function amountOf(transfer) {
  const decimals = Number(transfer?.token_info?.decimals ?? 6)
  const raw = Number(transfer?.value ?? 0)
  if (!Number.isFinite(raw)) return 0
  return Math.round((raw / 10 ** decimals) * 1e6) / 1e6
}

function confirmationsOf(transfer, now = Date.now()) {
  const blockTs = Number(transfer?.block_timestamp ?? 0)
  if (!blockTs) return 0
  // TRON 出块约 3 秒
  return Math.floor((now - blockTs) / 3000)
}

/** 找到金额与地址都匹配的待支付订单（同额多单时取金额最接近、其次最新的一笔）。 */
export function matchOrder(toAddress, amount) {
  const row = one(`SELECT * FROM orders
    WHERE channel = 'usdt' AND status IN ('created', 'pending')
      AND usdt_address = ?
      AND ABS(usdt_amount - ?) <= ?
      AND datetime(created_at) >= datetime('now', '-${MATCH_WINDOW_HOURS} hours')
    ORDER BY ABS(usdt_amount - ?) ASC, id DESC LIMIT 1`,
  toAddress, amount, AMOUNT_TOLERANCE, amount)
  return row ?? null
}

/** 订单已超时关闭但用户仍打款：找同期同额已关闭订单，用于标记「迟付」并进人工处理。 */
export function matchClosedOrder(toAddress, amount) {
  const row = one(`SELECT * FROM orders
    WHERE channel = 'usdt' AND status = 'closed'
      AND usdt_address = ?
      AND ABS(usdt_amount - ?) <= ?
      AND datetime(created_at) >= datetime('now', '-${MATCH_WINDOW_HOURS} hours')
    ORDER BY ABS(usdt_amount - ?) ASC, id DESC LIMIT 1`,
  toAddress, amount, AMOUNT_TOLERANCE, amount)
  return row ?? null
}

/** 只跳过「已终态」的交易；pending / unmatched / error 下一轮会重试。 */
export function seen(txid) {
  const row = one('SELECT status FROM chain_txns WHERE txid = ?', txid)
  return Boolean(row && TERMINAL.has(row.status))
}

export function remember(txid, transfer, orderNo, status) {
  const existing = one('SELECT id, status FROM chain_txns WHERE txid = ?', txid)
  if (existing) {
    // 已入账的不要被后续轮次覆盖成 pending
    if (TERMINAL.has(existing.status)) return
    run('UPDATE chain_txns SET status = ?, order_no = COALESCE(?, order_no) WHERE id = ?',
      status, orderNo ?? null, existing.id)
    return
  }
  run(`INSERT INTO chain_txns (network, txid, to_address, amount, block_ts, order_no, status)
       VALUES ('TRC20', ?, ?, ?, ?, ?, ?)`,
  txid, String(transfer?.to ?? '').slice(0, 64), amountOf(transfer), Number(transfer?.block_timestamp ?? 0), orderNo ?? null, status)
}

/**
 * 扫描一轮。返回 { scanned, matched, skipped, error }。
 * 拉取失败只记录，不抛给调用方（定时任务不该因网络抖动崩掉）。
 */
export async function scanOnce() {
  if (process.env.MH_USDT_WATCH === '0') return { scanned: 0, matched: 0, skipped: 0, disabled: true }
  const target = usdtChannel()
  if (!target) return { scanned: 0, matched: 0, skipped: 0, disabled: true }

  const minConf = minConfOf(target.config)
  const watch = getSetting('usdtWatch', {}) ?? {}
  const since = Number(watch.lastBlockTs ?? 0)

  let transfers = []
  try {
    transfers = await fetchTransfers(target.config.walletAddress, { since })
  } catch (error) {
    lastRun = { at: new Date().toISOString(), scanned: 0, matched: 0, error: error.message }
    console.warn('[usdt-watch] 拉取失败', error.message)
    return { scanned: 0, matched: 0, skipped: 0, error: error.message }
  }

  let matched = 0
  let skipped = 0
  let maxBlockTs = since
  for (const transfer of transfers) {
    const txid = String(transfer?.transaction_id ?? '')
    const to = String(transfer?.to ?? '')
    const blockTs = Number(transfer?.block_timestamp ?? 0)
    if (blockTs > maxBlockTs) maxBlockTs = blockTs
    if (!txid || seen(txid)) { skipped += 1; continue }
    if (to !== target.config.walletAddress) { skipped += 1; continue }
    const amount = amountOf(transfer)
    const confirmations = confirmationsOf(transfer)
    if (confirmations < minConf) {
      // 确认数不足：记 pending，等下一轮重新评估（绝不写终态，否则永远不入账）
      remember(txid, transfer, null, `pending:${confirmations}/${minConf}`)
      skipped += 1
      continue
    }

    const order = matchOrder(to, amount)
    if (!order) {
      const closed = matchClosedOrder(to, amount)
      remember(txid, transfer, closed?.out_trade_no ?? null, closed ? 'late_payment' : 'unmatched')
      if (closed) console.warn(`[usdt-watch] 迟付 ${closed.out_trade_no} ${amount} USDT（订单已关闭，需人工处理）tx=${txid}`)
      skipped += 1
      continue
    }

    try {
      const result = handleUsdtNotify({
        outTradeNo: order.out_trade_no, txid, amount, confirmations, channelId: target.channel.id,
      })
      if (result?.pending) {
        remember(txid, transfer, order.out_trade_no, `pending:${confirmations}/${result.required ?? minConf}`)
        skipped += 1
        continue
      }
      remember(txid, transfer, order.out_trade_no, 'credited')
      matched += 1
      console.log(`[usdt-watch] 到账 ${order.out_trade_no} ${amount} USDT conf=${confirmations} tx=${txid}`)
    } catch (error) {
      // 失败不写终态，下一轮重试；连续失败由后台「链上交易」列表暴露
      remember(txid, transfer, order.out_trade_no, `error:${error.message}`.slice(0, 120))
      console.warn('[usdt-watch] 入账失败', order.out_trade_no, error.message)
    }
  }

  if (maxBlockTs > since) setSetting('usdtWatch', { ...watch, lastBlockTs: maxBlockTs, updatedAt: new Date().toISOString() })
  lastRun = { at: new Date().toISOString(), scanned: transfers.length, matched, error: null }
  return { scanned: transfers.length, matched, skipped, error: null }
}

export function usdtWatchStatus() {
  const target = usdtChannel()
  const recent = all("SELECT txid, amount, order_no, status, datetime(created_at) AS at FROM chain_txns ORDER BY id DESC LIMIT 20")
  return {
    enabled: process.env.MH_USDT_WATCH !== '0' && Boolean(target),
    address: target?.config.walletAddress ?? null,
    minConfirmations: target ? minConfOf(target.config) : DEFAULT_MIN_CONFIRMATIONS,
    watermark: getSetting('usdtWatch', {})?.lastBlockTs ?? 0,
    lastRun,
    recent,
  }
}
