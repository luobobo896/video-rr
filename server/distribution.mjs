/** 多级分销：邀请关系、祖先闭包、逐级佣金、退款冲回、结算和风险控制。 */
import { createHash, randomBytes } from 'node:crypto'
import { db } from './db.mjs'
import { sealSecret } from './secretbox.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const hash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32)
const upperCode = (value) => String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 32)
const normalizeMethodCode = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)
const roundHalfUp = (value) => Math.floor(Number(value) + 0.5)
const numberOr = (value, fallback) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}
const maskEmail = (value) => {
  const email = String(value ?? '')
  const at = email.indexOf('@')
  return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : null
}
const maskAccount = (account = {}) => Object.fromEntries(Object.entries(account).map(([key, value]) => {
  const text = String(value ?? '')
  if (/address/i.test(key)) return [key, text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-4)}` : '****']
  if (/account|iban|card/i.test(key)) return [key, text.length > 8 ? `${text.slice(0, 2)}****${text.slice(-4)}` : '****']
  return [key, text.length > 4 ? `${text.slice(0, 2)}****${text.slice(-2)}` : '****']
}))

function publicWithdrawal(row) {
  if (!row) return row
  const { account_cipher, ...safe } = row
  let accountPreview = null
  try { accountPreview = JSON.parse(row.account_preview) } catch { /* keep null */ }
  return {
    ...safe,
    account_preview: accountPreview,
    amount: Number(row.amount_minor) / 100,
    fee: Number(row.fee_minor) / 100,
    netAmount: Number(row.net_amount_minor) / 100,
  }
}

export class DistributionError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function getDistributionConfig() {
  return one("SELECT * FROM distribution_config WHERE site_code = 'default'")
}

export function updateDistributionConfig(payload = {}, operatorId) {
  const current = getDistributionConfig()
  const maxLevel = Math.max(1, Math.min(5, Number(payload.maxEnabledLevel ?? current.max_enabled_level) || 3))
  const hardMax = Math.max(maxLevel, Math.min(5, Number(payload.hardMaxLevel ?? current.hard_max_level) || 5))
  const maxRate = Math.max(0, Math.min(10000, Number(payload.maxTotalRateBp ?? current.max_total_rate_bp) || 0))
  const activeRules = all(`SELECT relation_level, SUM(rate_bp) AS rate FROM commission_rules
    WHERE status = 'active' AND relation_level <= ? GROUP BY relation_level`, maxLevel)
  const activeRate = activeRules.reduce((sum, row) => sum + Number(row.rate ?? 0), 0)
  if (activeRate > maxRate) throw new DistributionError('rate_cap_conflict', '已启用规则比例合计超过总比例上限', 409)
  run(`UPDATE distribution_config SET max_enabled_level = ?, hard_max_level = ?, max_total_rate_bp = ?,
    auto_approve = ?, attribution_window_days = ?, freeze_days = ?, min_settlement_fen = ?,
    status = ?, updated_by = ?, updated_at = datetime('now') WHERE site_code = 'default'`,
  maxLevel, hardMax, maxRate, payload.autoApprove === false ? 0 : 1,
  Math.max(1, numberOr(payload.attributionWindowDays, current.attribution_window_days)),
  Math.max(0, numberOr(payload.freezeDays, current.freeze_days)),
  Math.max(0, numberOr(payload.minSettlementFen, current.min_settlement_fen)),
  payload.status === 'disabled' ? 'disabled' : 'active', operatorId ?? null)
  return getDistributionConfig()
}

export function listCommissionRules() {
  return all('SELECT * FROM commission_rules ORDER BY relation_level, priority, id')
}

export function listCurrencies({ enabledOnly = false } = {}) {
  const where = enabledOnly ? 'WHERE enabled = 1' : ''
  return all(`SELECT * FROM currencies ${where} ORDER BY sort, code`).map((row) => ({
    ...row,
    rateToCny: Number(row.rate_to_cny),
    isPayout: Boolean(row.is_payout),
  }))
}

export function upsertCurrency(payload = {}) {
  const code = upperCode(payload.code)
  if (!code) throw new DistributionError('currency_code_required', '币种编码必填')
  const rate = Number(payload.rateToCny ?? payload.rate_to_cny)
  if (!(rate > 0)) throw new DistributionError('rate_invalid', '汇率必须大于 0')
  const existing = one('SELECT * FROM currencies WHERE code = ?', code)
  if (existing) {
    run(`UPDATE currencies SET name = ?, symbol = ?, rate_to_cny = ?, decimals = 2,
      enabled = ?, is_payout = ?, sort = ? WHERE code = ?`,
    payload.name ?? existing.name, payload.symbol ?? existing.symbol, rate,
    payload.enabled === false ? 0 : 1, payload.isPayout === false ? 0 : 1,
    Number(payload.sort ?? existing.sort) || 100, code)
  } else {
    run(`INSERT INTO currencies (code, name, symbol, rate_to_cny, decimals, enabled, is_payout, sort)
      VALUES (?, ?, ?, ?, 2, ?, ?, ?)`, code, payload.name ?? code, payload.symbol ?? code,
    rate, payload.enabled === false ? 0 : 1, payload.isPayout === false ? 0 : 1,
    Number(payload.sort ?? 100) || 100)
  }
  return one('SELECT * FROM currencies WHERE code = ?', code)
}

export function listPayoutMethods({ currency, enabledOnly = true } = {}) {
  const clauses = []
  const args = []
  if (currency) { clauses.push('m.currency_code = ?'); args.push(upperCode(currency)) }
  if (enabledOnly) clauses.push('m.enabled = 1')
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT m.*, c.name AS currency_name, c.symbol AS currency_symbol
    FROM payout_methods m JOIN currencies c ON c.code = m.currency_code
    ${where} ORDER BY m.sort, m.id`, ...args).map((row) => {
    let fields = []
    try { fields = JSON.parse(row.account_fields_json) } catch { fields = [] }
    return {
      ...row,
      account_fields_json: undefined,
      fields,
      minAmountMinor: Number(row.min_amount_minor),
      feeBp: Number(row.fee_bp),
      fixedFeeMinor: Number(row.fixed_fee_minor),
    }
  })
}

export function upsertPayoutMethod(payload = {}) {
  const code = normalizeMethodCode(payload.code)
  const currency = upperCode(payload.currency ?? payload.currencyCode)
  if (!code || !currency) throw new DistributionError('payout_method_required', '提现方式编码和币种必填')
  if (!one('SELECT 1 AS x FROM currencies WHERE code = ?', currency)) {
    throw new DistributionError('currency_not_found', '币种不存在', 404)
  }
  const fields = Array.isArray(payload.fields) ? payload.fields : []
  const existing = one('SELECT * FROM payout_methods WHERE code = ? COLLATE NOCASE', code)
  if (existing) {
    run(`UPDATE payout_methods SET name = ?, currency_code = ?, enabled = ?, min_amount_minor = ?,
      fee_bp = ?, fixed_fee_minor = ?, account_fields_json = ?, instructions = ?, sort = ?,
      updated_at = datetime('now') WHERE id = ?`,
    payload.name ?? existing.name, currency, payload.enabled === false ? 0 : 1,
    Math.max(0, Number(payload.minAmountMinor ?? existing.min_amount_minor) || 0),
    Math.max(0, Number(payload.feeBp ?? existing.fee_bp) || 0),
    Math.max(0, Number(payload.fixedFeeMinor ?? existing.fixed_fee_minor) || 0),
    JSON.stringify(fields), payload.instructions ?? existing.instructions,
    Number(payload.sort ?? existing.sort) || 100, existing.id)
  } else {
    run(`INSERT INTO payout_methods
      (code, name, currency_code, enabled, min_amount_minor, fee_bp, fixed_fee_minor, account_fields_json, instructions, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, code, payload.name ?? code, currency,
    payload.enabled === false ? 0 : 1, Math.max(0, Number(payload.minAmountMinor) || 0),
    Math.max(0, Number(payload.feeBp) || 0), Math.max(0, Number(payload.fixedFeeMinor) || 0),
    JSON.stringify(fields), payload.instructions ?? null, Number(payload.sort ?? 100) || 100)
  }
  return listPayoutMethods({ enabledOnly: false }).find((row) => row.code === code)
}

export function detectCurrency({ requested, country, acceptLanguage } = {}) {
  // 展示币种只有 CNY / USD；USDT 只作为提现方式，不参与账户余额展示。
  const currencies = listCurrencies({ enabledOnly: true }).filter((row) => ['CNY', 'USD'].includes(row.code))
  const available = new Set(currencies.map((row) => row.code))
  const requestedCode = upperCode(requested)
  if (requestedCode && available.has(requestedCode)) return requestedCode
  const countryCode = String(country ?? '').toUpperCase()
  if (countryCode === 'US' && available.has('USD')) return 'USD'
  if (countryCode === 'CN' && available.has('CNY')) return 'CNY'
  if (/^zh(?:[-_]|$)/i.test(String(acceptLanguage ?? '')) && available.has('CNY')) return 'CNY'
  if (available.has('USD')) return 'USD'
  return currencies[0]?.code ?? 'CNY'
}

export function currencyBalances(baseCnyFen, currencies = listCurrencies({ enabledOnly: true })) {
  return currencies.filter((currency) => ['CNY', 'USD'].includes(currency.code)).map((currency) => {
    const amountMinor = Math.round(Number(baseCnyFen ?? 0) / Number(currency.rate_to_cny || 1))
    return {
      code: currency.code,
      name: currency.name,
      symbol: currency.symbol,
      rateToCny: Number(currency.rate_to_cny),
      amountMinor,
      amount: amountMinor / 100,
    }
  })
}

function withdrawalReservedFen(userId) {
  const row = one(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('pending_review','approved') THEN base_cny_fen ELSE 0 END),0) AS reservedFen,
      COALESCE(SUM(CASE WHEN status = 'paid' AND commission_applied = 0 THEN base_cny_fen ELSE 0 END),0) AS paidFen
    FROM withdrawal_requests WHERE distributor_user_id = ?`, Number(userId))
  const commission = one(`SELECT COALESCE(SUM(commission_amount_fen - reversed_fen - settled_fen),0) AS availableFen
    FROM commission_records WHERE distributor_user_id = ? AND status = 'available'`, Number(userId))
  const commissionAvailableFen = Number(commission?.availableFen ?? 0)
  const reservedFen = Number(row?.reservedFen ?? 0)
  const paidFen = Number(row?.paidFen ?? 0)
  return {
    commissionAvailableFen, reservedFen, paidFen,
    withdrawableFen: commissionAvailableFen - reservedFen - paidFen,
  }
}

/**
 * 提现打款后，把对应的 CNY 佣金按 FIFO 标记为已结算。
 * 这样提现与结算共用同一份佣金余额，避免两条打款链路重复占用。
 */
function applyWithdrawalToCommissions(request) {
  if (!request || Number(request.commission_applied) === 1) return
  let remaining = Math.max(0, Number(request.base_cny_fen ?? 0))
  if (!remaining) throw new DistributionError('withdrawal_amount_invalid', '提现金额无效', 400)
  const rows = all(`SELECT * FROM commission_records
    WHERE distributor_user_id = ? AND status = 'available'
    ORDER BY id ASC`, Number(request.distributor_user_id))
  let applied = 0
  for (const row of rows) {
    if (remaining <= 0) break
    const amount = Math.max(0, Number(row.commission_amount_fen) - Number(row.reversed_fen) - Number(row.settled_fen))
    if (amount <= 0) continue
    const take = Math.min(remaining, amount)
    const settled = Number(row.settled_fen) + take
    const fullySettled = settled >= Number(row.commission_amount_fen) - Number(row.reversed_fen)
    run(`UPDATE commission_records SET settled_fen = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
      settled, fullySettled ? 'paid' : 'available', row.id)
    run(`INSERT INTO commission_events (commission_id, event_type, amount_fen, reason, reference_type, reference_id)
      VALUES (?, 'withdrawal_paid', ?, 'withdrawal_paid', 'withdrawal', ?)`, row.id, -take, request.id)
    remaining -= take
    applied += take
  }
  if (remaining > 0) {
    throw new DistributionError('commission_state_invalid', '可结算佣金不足，提现打款已阻止', 409)
  }
  run(`UPDATE withdrawal_requests SET commission_applied = 1 WHERE id = ?`, request.id)
  return applied
}

/** 兼容旧库：为历史已打款但未回写佣金的提现做一次幂等补偿。 */
export function reconcileWithdrawalCommissions() {
  for (const request of all("SELECT * FROM withdrawal_requests WHERE status = 'paid' AND commission_applied = 0")) {
    try {
      tx(() => applyWithdrawalToCommissions(request))
    } catch (error) {
      console.warn(`[distribution] 历史提现 #${request.id} 佣金回写失败: ${error.message}`)
    }
  }
}

export function payoutOptions({ currency } = {}) {
  const currencies = listCurrencies({ enabledOnly: true }).filter((row) => row.isPayout)
  const selected = currencies.find((row) => row.code === upperCode(currency)) ?? currencies[0]
  if (!selected) return { currencies: [], currency: null, methods: [] }
  const methods = listPayoutMethods({ currency: selected.code }).filter((row) => row.enabled)
  return {
    currencies: currencies.map((row) => ({ code: row.code, name: row.name, symbol: row.symbol, rateToCny: row.rateToCny })),
    currency: selected, methods,
  }
}

export function createWithdrawalRequest({ userId, amount, currency, methodCode, account } = {}) {
  if (!userId) throw new DistributionError('unauthorized', '需要登录', 401)
  const profile = getDistributorProfile(userId)
  if (!profile || profile.status !== 'active') throw new DistributionError('distributor_not_active', '佣金推广未启用', 403)
  const code = upperCode(currency)
  const method = one(`SELECT m.*, c.rate_to_cny FROM payout_methods m
    JOIN currencies c ON c.code = m.currency_code
    WHERE m.code = ? COLLATE NOCASE AND m.enabled = 1 AND m.currency_code = ? AND c.enabled = 1`,
  normalizeMethodCode(methodCode), code)
  if (!method) throw new DistributionError('payout_method_invalid', '提现方式不可用', 404)
  const amountMinor = Math.round(Number(amount) * 100)
  if (!(amountMinor > 0)) throw new DistributionError('withdrawal_amount_invalid', '提现金额必须大于 0')
  if (amountMinor < Number(method.min_amount_minor ?? 0)) {
    throw new DistributionError('withdrawal_below_minimum', '低于该提现方式的最低金额', 400)
  }
  let fields = []
  try { fields = JSON.parse(method.account_fields_json) } catch { fields = [] }
  const normalizedAccount = {}
  for (const field of fields) {
    const value = String(account?.[field.key] ?? '').trim()
    if (!value) throw new DistributionError('payout_account_incomplete', `请填写${field.label ?? field.key}`, 400)
    if (field.key === 'address' && method.currency_code === 'USDT' && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
      throw new DistributionError('payout_address_invalid', 'TRC20 地址格式不正确', 400)
    }
    normalizedAccount[field.key] = value.slice(0, 200)
  }
  const rate = Number(method.rate_to_cny)
  const baseCnyFen = Math.round(amountMinor * rate)
  const feeMinor = Math.round(amountMinor * Number(method.fee_bp ?? 0) / 10000) + Number(method.fixed_fee_minor ?? 0)
  const netAmountMinor = Math.max(0, amountMinor - feeMinor)
  return tx(() => {
    const openSettlement = one(`SELECT 1 AS x FROM commission_settlements
      WHERE distributor_user_id = ? AND status IN ('pending_review','approved','paying') LIMIT 1`, Number(userId))
    if (openSettlement) throw new DistributionError('settlement_already_open', '该推广员已有待处理结算，请先在结算单处理', 409)
    const balance = withdrawalReservedFen(userId)
    if (baseCnyFen > balance.withdrawableFen) {
      throw new DistributionError('withdrawal_insufficient_balance', '可提现余额不足', 409)
    }
    const info = run(`INSERT INTO withdrawal_requests
      (distributor_user_id, amount_minor, fee_minor, net_amount_minor, currency, base_cny_fen,
       exchange_rate, method_code, account_cipher, account_preview, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
    Number(userId), amountMinor, feeMinor, netAmountMinor, code, baseCnyFen, rate,
    method.code, sealSecret(normalizedAccount), JSON.stringify(maskAccount(normalizedAccount)))
    return publicWithdrawal(one(`SELECT w.*, m.name AS method_name, c.name AS currency_name, c.symbol AS currency_symbol
      FROM withdrawal_requests w
      JOIN payout_methods m ON m.code = w.method_code
      JOIN currencies c ON c.code = w.currency
      WHERE w.id = ?`, Number(info.lastInsertRowid)))
  })
}

export function listWithdrawals({ distributorUserId, status } = {}) {
  const clauses = []
  const args = []
  if (distributorUserId) { clauses.push('w.distributor_user_id = ?'); args.push(Number(distributorUserId)) }
  if (status) { clauses.push('w.status = ?'); args.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT w.*, m.name AS method_name, c.name AS currency_name, c.symbol AS currency_symbol,
      u.nickname, u.email
    FROM withdrawal_requests w
    JOIN payout_methods m ON m.code = w.method_code
    JOIN currencies c ON c.code = w.currency
    LEFT JOIN users u ON u.id = w.distributor_user_id
    ${where} ORDER BY w.id DESC LIMIT 300`, ...args).map((row) => ({
    ...publicWithdrawal(row),
    email: maskEmail(row.email),
  }))
}

export function pageWithdrawals({ distributorUserId, status, page = 1, pageSize = 20 } = {}) {
  const current = Math.max(1, Number(page) || 1)
  const size = Math.max(1, Math.min(100, Number(pageSize) || 20))
  const clauses = []
  const args = []
  if (distributorUserId) { clauses.push('w.distributor_user_id = ?'); args.push(Number(distributorUserId)) }
  if (status) { clauses.push('w.status = ?'); args.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = Number(one(`SELECT COUNT(*) AS n FROM withdrawal_requests w ${where}`, ...args)?.n ?? 0)
  const summary = one(`SELECT
      COALESCE(SUM(CASE WHEN w.status = 'pending_review' THEN 1 ELSE 0 END), 0) AS pendingCount,
      COALESCE(SUM(CASE WHEN w.status = 'approved' THEN w.base_cny_fen ELSE 0 END), 0) AS approvedFen,
      COALESCE(SUM(CASE WHEN w.status = 'paid' THEN w.base_cny_fen ELSE 0 END), 0) AS paidFen
    FROM withdrawal_requests w ${where}`, ...args)
  const rows = all(`SELECT w.*, m.name AS method_name, c.name AS currency_name, c.symbol AS currency_symbol,
      u.nickname, u.email
    FROM withdrawal_requests w
    JOIN payout_methods m ON m.code = w.method_code
    JOIN currencies c ON c.code = w.currency
    LEFT JOIN users u ON u.id = w.distributor_user_id
    ${where} ORDER BY w.id DESC LIMIT ? OFFSET ?`, ...args, size, (current - 1) * size)
  const list = rows.map((row) => ({ ...publicWithdrawal(row), email: maskEmail(row.email) }))
  return {
    list, items: list,
    page: current, pageSize: size, total,
    summary: {
      pendingCount: Number(summary?.pendingCount ?? 0),
      approvedFen: Number(summary?.approvedFen ?? 0),
      paidFen: Number(summary?.paidFen ?? 0),
    },
  }
}

export function reviewWithdrawal({ withdrawalId, action, reviewerId, payoutRef } = {}) {
  return tx(() => {
    const request = one('SELECT * FROM withdrawal_requests WHERE id = ?', Number(withdrawalId))
    if (!request) throw new DistributionError('withdrawal_not_found', '提现申请不存在', 404)
    if (action === 'approve') {
      const changed = run(`UPDATE withdrawal_requests SET status = 'approved', reviewer_id = ?, reviewed_at = datetime('now')
        WHERE id = ? AND status = 'pending_review'`, reviewerId ?? null, request.id)
      if (Number(changed.changes ?? 0) !== 1) throw new DistributionError('withdrawal_state_invalid', '提现申请状态不可批准', 409)
    } else if (action === 'reject') {
      const changed = run(`UPDATE withdrawal_requests SET status = 'rejected', reviewer_id = ?, reviewed_at = datetime('now')
        WHERE id = ? AND status = 'pending_review'`, reviewerId ?? null, request.id)
      if (Number(changed.changes ?? 0) !== 1) throw new DistributionError('withdrawal_state_invalid', '提现申请状态不可驳回', 409)
    } else if (action === 'pay') {
      applyWithdrawalToCommissions(request)
      const changed = run(`UPDATE withdrawal_requests SET status = 'paid', reviewer_id = ?, reviewed_at = datetime('now'),
        paid_at = datetime('now'), payout_ref = ? WHERE id = ? AND status = 'approved'`,
      reviewerId ?? null, String(payoutRef ?? '').slice(0, 200) || null, request.id)
      if (Number(changed.changes ?? 0) !== 1) throw new DistributionError('withdrawal_state_invalid', '提现申请需先批准', 409)
    } else {
      throw new DistributionError('withdrawal_action_invalid', '未知提现动作', 400)
    }
    return listWithdrawals({}).find((row) => Number(row.id) === Number(request.id))
  })
}

export function withdrawalSummary(userId) {
  const balance = withdrawalReservedFen(userId)
  return {
    ...balance,
    balances: currencyBalances(balance.withdrawableFen),
    withdrawals: listWithdrawals({ distributorUserId: userId }),
  }
}

export function upsertCommissionRule(payload = {}) {
  const code = upperCode(payload.ruleCode ?? payload.rule_code)
  if (!code) throw new DistributionError('rule_code_required', '规则编码必填')
  const level = Math.max(1, Math.min(5, Number(payload.relationLevel ?? payload.relation_level) || 1))
  const rate = Math.max(0, Math.min(10000, Number(payload.rateBp ?? payload.rate_bp) || 0))
  const existing = one('SELECT * FROM commission_rules WHERE rule_code = ?', code)
  const willEnable = payload.status === 'disabled' ? false : (existing?.status === 'active' || !existing || payload.status !== 'disabled')
  if (willEnable) {
    const config = getDistributionConfig()
    const otherRate = one(`SELECT COALESCE(SUM(rate_bp),0) AS n FROM commission_rules
      WHERE status = 'active' AND relation_level <= ? AND id <> ?`,
    Number(config?.max_enabled_level ?? 3), Number(existing?.id ?? 0))?.n ?? 0
    if (Number(otherRate) + rate > Number(config?.max_total_rate_bp ?? 1800)) {
      throw new DistributionError('rate_cap_conflict', '各层级佣金比例合计超过总比例上限', 409)
    }
  }
  if (existing) {
    run(`UPDATE commission_rules SET scope_type = ?, scope_value = ?, relation_level = ?, rate_bp = ?,
      min_order_fen = ?, max_commission_fen = ?, status = ?, valid_from = ?, valid_to = ?, priority = ?,
      updated_at = datetime('now') WHERE id = ?`,
    payload.scopeType ?? existing.scope_type, payload.scopeValue ?? existing.scope_value,
    level, rate, Math.max(0, Number(payload.minOrderFen ?? existing.min_order_fen) || 0),
    Math.max(0, Number(payload.maxCommissionFen ?? existing.max_commission_fen) || 0),
    payload.status === 'disabled' ? 'disabled' : 'active', payload.validFrom ?? existing.valid_from,
    payload.validTo ?? existing.valid_to, Number(payload.priority ?? existing.priority) || 100, existing.id)
    return one('SELECT * FROM commission_rules WHERE id = ?', existing.id)
  }
  const info = run(`INSERT INTO commission_rules
    (rule_code, scope_type, scope_value, relation_level, rate_bp, min_order_fen, max_commission_fen,
     status, valid_from, valid_to, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  code, payload.scopeType ?? 'global', payload.scopeValue ?? null, level, rate,
  Math.max(0, Number(payload.minOrderFen) || 0), Math.max(0, Number(payload.maxCommissionFen) || 0),
  payload.status === 'disabled' ? 'disabled' : 'active', payload.validFrom ?? null,
  payload.validTo ?? null, Number(payload.priority ?? 100) || 100)
  return one('SELECT * FROM commission_rules WHERE id = ?', Number(info.lastInsertRowid))
}

export function getDistributorProfile(userId) {
  return one('SELECT * FROM distributor_profiles WHERE user_id = ?', Number(userId))
}

export function applyDistributor(userId) {
  const existing = getDistributorProfile(userId)
  if (existing) return existing
  const config = getDistributionConfig()
  const status = Number(config?.auto_approve ?? 1) ? 'active' : 'pending'
  run(`INSERT INTO distributor_profiles (user_id, status, available_balance_fen, frozen_balance_fen, settled_total_fen)
    VALUES (?, ?, 0, 0, 0)`, Number(userId), status)
  return getDistributorProfile(userId)
}

export function setDistributorStatus(userId, status) {
  const next = ['active', 'pending', 'disabled'].includes(status) ? status : 'disabled'
  run(`INSERT INTO distributor_profiles (user_id, status, available_balance_fen, frozen_balance_fen, settled_total_fen, updated_at)
    VALUES (?, ?, 0, 0, 0, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`, Number(userId), next)
  return getDistributorProfile(userId)
}

function createCode(userId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `D${Number(userId).toString(36).toUpperCase()}${randomBytes(3).toString('hex').toUpperCase()}`
    try {
      const info = run(`INSERT INTO referral_codes (code, distributor_user_id, code_type, status)
        VALUES (?, ?, 'link', 'active')`, code, Number(userId))
      return one('SELECT * FROM referral_codes WHERE id = ?', Number(info.lastInsertRowid))
    } catch { /* retry only on unique collision */ }
  }
  throw new DistributionError('code_generation_failed', '邀请码生成失败，请重试', 500)
}

export function getOrCreateReferralCode(userId) {
  let code = one("SELECT * FROM referral_codes WHERE distributor_user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", Number(userId))
  if (code) return code
  const profile = getDistributorProfile(userId)
  if (!profile || profile.status !== 'active') throw new DistributionError('distributor_not_active', '分销员未启用', 403)
  code = createCode(userId)
  return code
}

export function recordInviteClick({ code, visitorId, userId, ip, ua, referrer } = {}) {
  const normalized = upperCode(code)
  if (!normalized) throw new DistributionError('invite_code_required', '邀请码必填')
  const codeRow = one(`SELECT rc.*, dp.status AS distributor_status FROM referral_codes rc
    JOIN distributor_profiles dp ON dp.user_id = rc.distributor_user_id
    WHERE rc.code = ?`, normalized)
  if (!codeRow || codeRow.status !== 'active' || codeRow.distributor_status !== 'active') {
    throw new DistributionError('invite_code_invalid', '邀请码无效或已停用', 404)
  }
  const now = nowSql()
  if (codeRow.valid_from && codeRow.valid_from > now) throw new DistributionError('invite_code_inactive', '邀请码尚未生效', 409)
  if (codeRow.valid_to && codeRow.valid_to < now) throw new DistributionError('invite_code_expired', '邀请码已过期', 409)
  const info = run(`INSERT INTO distribution_clicks
    (code, distributor_user_id, visitor_id, user_id, ip_hash, ua_hash, referrer_url, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  normalized, codeRow.distributor_user_id, String(visitorId ?? '').slice(0, 64) || null,
  userId ?? null, ip ? hash(ip) : null, ua ? hash(ua) : null, String(referrer ?? '').slice(0, 500) || null)
  return { clickId: Number(info.lastInsertRowid), code: normalized, distributorUserId: codeRow.distributor_user_id }
}

export function bindReferral({ userId, visitorId, code, inviterUserId } = {}) {
  if (!userId) return null
  const existing = one('SELECT * FROM distribution_relations WHERE invitee_user_id = ?', Number(userId))
  if (existing) return existing
  let codeRow = null
  if (code) {
    const normalized = upperCode(code)
    codeRow = one(`SELECT rc.*, dp.status AS distributor_status FROM referral_codes rc
      JOIN distributor_profiles dp ON dp.user_id = rc.distributor_user_id
      WHERE rc.code = ?`, normalized)
    if (!codeRow || codeRow.status !== 'active' || codeRow.distributor_status !== 'active') return null
    const now = nowSql()
    if ((codeRow.valid_from && codeRow.valid_from > now) || (codeRow.valid_to && codeRow.valid_to < now)) return null
  }
  const inviter = Number(inviterUserId ?? codeRow?.distributor_user_id)
  if (!inviter) return null
  if (inviter === Number(userId)) throw new DistributionError('self_invite', '不能邀请自己', 409)
  const existingInviter = one('SELECT 1 AS x FROM distribution_relations WHERE invitee_user_id = ?', Number(userId))
  if (existingInviter) return existing
  const config = getDistributionConfig()
  const windowSql = new Date(Date.now() - Number(config.attribution_window_days ?? 30) * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  const click = codeRow ? one(`SELECT * FROM distribution_clicks
    WHERE code = ? AND (visitor_id = ? OR user_id = ?) AND occurred_at >= ?
    ORDER BY id ASC LIMIT 1`, codeRow.code, String(visitorId ?? '').slice(0, 64), Number(userId), windowSql) : null
  if (codeRow && !click) return null
  const ancestor = one('SELECT 1 AS x FROM distribution_tree_closure WHERE ancestor_user_id = ? AND descendant_user_id = ?', Number(userId), inviter)
  if (ancestor) throw new DistributionError('invite_cycle', '邀请关系会形成闭环', 409)

  return tx(() => {
    const info = run(`INSERT INTO distribution_relations
      (inviter_user_id, invitee_user_id, relation_level, source_code, source_click_id, status, risk_status, bound_at)
      VALUES (?, ?, 1, ?, ?, 'active', 'normal', datetime('now'))`,
    inviter, Number(userId), codeRow?.code ?? null, click?.id ?? null)
    const relationId = Number(info.lastInsertRowid)
    const hardMax = Number(config.hard_max_level ?? 5)
    run('INSERT OR IGNORE INTO distribution_tree_closure (ancestor_user_id, descendant_user_id, depth) VALUES (?, ?, 1)',
      inviter, Number(userId))
    const ancestors = all(`SELECT ancestor_user_id, depth FROM distribution_tree_closure
      WHERE descendant_user_id = ? AND depth < ? ORDER BY depth ASC`, inviter, hardMax)
    for (const row of ancestors) {
      if (Number(row.depth) + 1 <= hardMax) {
        run('INSERT OR IGNORE INTO distribution_tree_closure (ancestor_user_id, descendant_user_id, depth) VALUES (?, ?, ?)',
          row.ancestor_user_id, Number(userId), Number(row.depth) + 1)
      }
    }
    return one('SELECT * FROM distribution_relations WHERE id = ?', relationId)
  })
}

export function getUplineChain(userId, maxLevel = 5) {
  const direct = one('SELECT * FROM distribution_relations WHERE invitee_user_id = ?', Number(userId))
  if (!direct) return []
  return all(`SELECT c.ancestor_user_id AS distributorUserId, c.depth AS commissionLevel, ? AS sourceRelationId
    FROM distribution_tree_closure c JOIN distributor_profiles dp
      ON dp.user_id = c.ancestor_user_id AND dp.status = 'active'
    WHERE c.descendant_user_id = ? AND c.depth <= ?
    ORDER BY c.depth ASC`, direct.id, Number(userId), Math.max(1, Number(maxLevel) || 5))
}

export function getDistributionSnapshot(userId) {
  const relation = one('SELECT * FROM distribution_relations WHERE invitee_user_id = ? AND status = ?', Number(userId), 'active')
  if (!relation) return { distributorUserId: null, distributionCode: null, relationId: null }
  return {
    distributorUserId: relation.inviter_user_id,
    distributionCode: relation.source_code,
    relationId: relation.id,
  }
}

function resolveCommissionRule(level, order) {
  const now = nowSql()
  const rows = all(`SELECT * FROM commission_rules
    WHERE status = 'active' AND relation_level = ?
      AND (valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)
    ORDER BY priority ASC, id ASC`, level, now, now)
  const content = order.drama_id ? one('SELECT content_type FROM dramas WHERE id = ?', order.drama_id) : null
  return rows.find((rule) => {
    if (rule.scope_type === 'global') return true
    if (rule.scope_type === 'plan') return String(rule.scope_value) === String(order.plan_id)
    if (rule.scope_type === 'content') return String(rule.scope_value) === String(order.drama_id)
    if (rule.scope_type === 'content_type') return String(rule.scope_value) === String(content?.content_type)
    return false
  })
}

export function createCommissionsForOrder(order, { paidAt = nowSql() } = {}) {
  return tx(() => {
  if (!order?.id || !order?.user_id) return []
  const config = getDistributionConfig()
  if (!config || config.status !== 'active') return []
  const chain = getUplineChain(order.user_id, config?.max_enabled_level ?? 3)
  if (!chain.length) return []
  const baseFen = Math.max(0, roundHalfUp(Number(order.amount_cny) * 100))
  if (!baseFen) return []
  let cumulativeRate = 0
  const records = []
  const freezeDays = Math.max(0, Number(config?.freeze_days ?? 7))
  const availableAt = new Date(Date.parse(`${paidAt.replace(' ', 'T')}Z`) + freezeDays * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  for (const row of chain) {
    const level = Number(row.commissionLevel)
    const rule = resolveCommissionRule(level, order)
    if (!rule || Number(rule.rate_bp) <= 0) continue
    if (Number(rule.min_order_fen ?? 0) > baseFen) continue
    const rate = Number(rule.rate_bp)
    if (cumulativeRate + rate > Number(config?.max_total_rate_bp ?? 1800)) continue
    let amount = roundHalfUp(baseFen * rate / 10000)
    if (Number(rule.max_commission_fen ?? 0) > 0) amount = Math.min(amount, Number(rule.max_commission_fen))
    if (amount <= 0) continue
    const snap = {
      ruleCode: rule.rule_code, level, rateBp: rate, scopeType: rule.scope_type,
      scopeValue: rule.scope_value, maxCommissionFen: Number(rule.max_commission_fen ?? 0),
      maxTotalRateBp: Number(config?.max_total_rate_bp ?? 1800),
    }
    const info = run(`INSERT OR IGNORE INTO commission_records
      (order_id, distributor_user_id, invitee_user_id, source_relation_id, commission_level,
       order_amount_fen, base_amount_fen, rule_code, rate_bp, rule_snapshot_json, commission_amount_fen,
       status, available_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?)`,
    order.id, row.distributorUserId, order.user_id, row.sourceRelationId, level,
    roundHalfUp(Number(order.amount_cny) * 100), baseFen, rule.rule_code, rate,
    JSON.stringify(snap), amount, availableAt)
    if (Number(info.changes ?? 0) > 0) {
      const commissionId = Number(info.lastInsertRowid)
      run(`INSERT INTO commission_events (commission_id, event_type, amount_fen, reason, reference_type, reference_id)
        VALUES (?, 'created', ?, 'payment_success', 'order', ?)`, commissionId, amount, order.id)
      records.push(one('SELECT * FROM commission_records WHERE id = ?', commissionId))
      cumulativeRate += rate
    } else {
      records.push(one('SELECT * FROM commission_records WHERE order_id = ? AND distributor_user_id = ?', order.id, row.distributorUserId))
    }
  }
  const inserted = records.filter(Boolean)
  run(`UPDATE orders SET commission_base_fen = ?, commission_total_fen = ?, commission_record_count = ?,
    commission_rule_snapshot_json = ? WHERE id = ?`,
  baseFen, inserted.reduce((sum, row) => sum + Number(row.commission_amount_fen ?? 0), 0),
  inserted.length, JSON.stringify(inserted.map((row) => ({ level: row.commission_level, rule: row.rule_code, rate: row.rate_bp }))), order.id)
  for (const row of inserted) refreshBalances(row.distributor_user_id)
  return inserted
  })
}

export function markCommissionsAvailable() {
  const rows = all(`SELECT c.* FROM commission_records c
    LEFT JOIN distribution_relations r ON r.id = c.source_relation_id
    WHERE c.status = 'frozen' AND c.available_at IS NOT NULL AND c.available_at <= datetime('now')
      AND COALESCE(r.status, 'active') = 'active' AND COALESCE(r.risk_status, 'normal') = 'normal'`)
  for (const row of rows) {
    run("UPDATE commission_records SET status = 'available', updated_at = datetime('now') WHERE id = ? AND status = 'frozen'", row.id)
    run(`INSERT INTO commission_events (commission_id, event_type, amount_fen, reason, reference_type, reference_id)
      VALUES (?, 'available', 0, 'freeze_expired', 'commission', ?)`, row.id, row.id)
    refreshBalances(row.distributor_user_id)
  }
  return rows.length
}

export function reverseCommissionsForRefund({ order, totalRefundedAmount, referenceId, reason = 'refund' } = {}) {
  return tx(() => {
  if (!order?.id) return 0
  const records = all('SELECT * FROM commission_records WHERE order_id = ?', order.id)
  const orderFen = Math.max(1, roundHalfUp(Number(order.amount_cny) * 100))
  const totalRefundFen = Math.max(0, roundHalfUp(Number(totalRefundedAmount) * 100))
  let changed = 0
  for (const row of records) {
    const target = Math.min(Number(row.commission_amount_fen), roundHalfUp(Number(row.commission_amount_fen) * totalRefundFen / orderFen))
    const delta = target - Number(row.reversed_fen ?? 0)
    if (delta <= 0) continue
    const fullyReversed = target >= Number(row.commission_amount_fen)
    run(`UPDATE commission_records SET reversed_fen = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
      target, fullyReversed ? 'reversed' : row.status, row.id)
    run(`INSERT INTO commission_events (commission_id, event_type, amount_fen, reason, reference_type, reference_id)
      VALUES (?, 'reversed', ?, ?, 'refund', ?)`, row.id, -delta, reason, referenceId ?? null)
    refreshBalances(row.distributor_user_id)
    changed += 1
  }
  return changed
  })
}

export function refreshBalances(distributorUserId) {
  const sums = one(`SELECT
      COALESCE(SUM(CASE WHEN status = 'frozen' THEN commission_amount_fen - reversed_fen ELSE 0 END), 0) AS frozen,
      COALESCE(SUM(CASE WHEN status = 'available' THEN commission_amount_fen - reversed_fen - settled_fen ELSE 0 END), 0) AS available,
      COALESCE(SUM(settled_fen), 0) AS settled,
      COALESCE(SUM(CASE WHEN commission_amount_fen - reversed_fen - settled_fen < 0
        THEN -(commission_amount_fen - reversed_fen - settled_fen) ELSE 0 END), 0) AS rawDebt
    FROM commission_records WHERE distributor_user_id = ?`, Number(distributorUserId))
  const profile = getDistributorProfile(distributorUserId)
  const debt = Math.max(0, Number(sums?.rawDebt ?? 0) - Number(profile?.debt_offset_fen ?? 0))
  run(`UPDATE distributor_profiles SET frozen_balance_fen = ?, available_balance_fen = ?, settled_total_fen = ?,
    debt_fen = ?,
    updated_at = datetime('now') WHERE user_id = ?`,
  Number(sums?.frozen ?? 0), Number(sums?.available ?? 0), Number(sums?.settled ?? 0), debt, Number(distributorUserId))
  return { ...sums, debt }
}

export function distributionSummary(userId) {
  const profile = getDistributorProfile(userId)
  if (!profile) return { profile: null, code: null, directInvitees: 0, teamSize: 0, levels: [], commissions: null }
  const code = profile.status === 'active'
    ? one("SELECT * FROM referral_codes WHERE distributor_user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", userId)
    : null
  const config = getDistributionConfig()
  const maxLevel = Number(config?.max_enabled_level ?? 3)
  const team = one(`SELECT COUNT(DISTINCT descendant_user_id) AS n FROM distribution_tree_closure
    WHERE ancestor_user_id = ? AND depth <= ?`, userId, maxLevel)
  const direct = one(`SELECT COUNT(DISTINCT descendant_user_id) AS n FROM distribution_tree_closure
    WHERE ancestor_user_id = ? AND depth = 1`, userId)
  const levels = all(`SELECT depth, COUNT(DISTINCT descendant_user_id) AS n
    FROM distribution_tree_closure WHERE ancestor_user_id = ? AND depth <= ?
    GROUP BY depth ORDER BY depth`, userId, maxLevel).map((row) => ({ level: row.depth, users: Number(row.n) }))
  const commissions = one(`SELECT
      COALESCE(SUM(CASE WHEN status = 'frozen' THEN commission_amount_fen - reversed_fen ELSE 0 END), 0) AS pendingFen,
      COALESCE(SUM(CASE WHEN status = 'available' THEN commission_amount_fen - reversed_fen - settled_fen ELSE 0 END), 0) AS availableFen,
      COALESCE(SUM(settled_fen), 0) AS settledFen,
      COALESCE(SUM(reversed_fen), 0) AS reversedFen
    FROM commission_records WHERE distributor_user_id = ?`, userId)
  const withdrawal = withdrawalReservedFen(userId)
  const paidOrders = one(`SELECT COUNT(*) AS n, COALESCE(SUM(o.amount_cny),0) AS amount
    FROM orders o JOIN distribution_tree_closure c ON c.descendant_user_id = o.user_id
    WHERE c.ancestor_user_id = ? AND c.depth <= ? AND o.status IN ('paid','fulfilled')`, userId, maxLevel)
  return {
    profile, code, directInvitees: Number(direct?.n ?? 0), teamSize: Number(team?.n ?? 0), levels,
    paidOrders: Number(paidOrders?.n ?? 0), teamPaidAmount: Number(paidOrders?.amount ?? 0),
    commissions: {
      pendingFen: Number(commissions?.pendingFen ?? 0), availableFen: Number(commissions?.availableFen ?? 0),
      settledFen: Number(commissions?.settledFen ?? 0), reversedFen: Number(commissions?.reversedFen ?? 0),
      debtFen: Number(profile.debt_fen ?? 0),
      withdrawableFen: Number(withdrawal.withdrawableFen ?? 0),
      withdrawalReservedFen: Number(withdrawal.reservedFen ?? 0),
      withdrawalPaidFen: Number(withdrawal.paidFen ?? 0),
    },
    balances: currencyBalances(withdrawal.withdrawableFen),
  }
}

export function createSettlement({ distributorUserId, periodStart, periodEnd, createdBy } = {}) {
  return tx(() => {
    const openWithdrawal = one(`SELECT 1 AS x FROM withdrawal_requests
      WHERE distributor_user_id = ? AND status IN ('pending_review','approved') LIMIT 1`, Number(distributorUserId))
    if (openWithdrawal) throw new DistributionError('withdrawal_already_open', '该推广员已有提现流程，请先在提现申请处理', 409)
    const config = getDistributionConfig()
    const rows = all(`SELECT * FROM commission_records
      WHERE distributor_user_id = ? AND status = 'available'
        AND date(created_at) >= date(?) AND date(created_at) <= date(?)
      ORDER BY id`, Number(distributorUserId), periodStart, periodEnd)
    const items = rows.map((row) => ({
      commissionId: row.id,
      amountFen: Number(row.commission_amount_fen) - Number(row.reversed_fen) - Number(row.settled_fen),
    })).filter((row) => row.amountFen > 0)
    const total = items.reduce((sum, row) => sum + row.amountFen, 0)
    if (total <= 0) throw new DistributionError('no_settleable_commission', '没有可结算佣金', 409)
    const profile = getDistributorProfile(distributorUserId)
    const debtOffset = Math.min(total, Math.max(0, Number(profile?.debt_fen ?? 0)))
    const payable = total - debtOffset
    if (payable <= 0) throw new DistributionError('settlement_offset_by_debt', '可结算佣金全部用于抵扣负余额', 409)
    if (payable < Number(config?.min_settlement_fen ?? 10000)) {
      throw new DistributionError('settlement_below_minimum', '未达到最低结算金额', 400)
    }
    const info = run(`INSERT INTO commission_settlements
      (distributor_user_id, period_start, period_end, amount_fen, debt_offset_fen, status, created_by)
      VALUES (?, ?, ?, ?, ?, 'pending_review', ?)`,
    Number(distributorUserId), periodStart, periodEnd, payable, debtOffset, createdBy ?? null)
    const settlementId = Number(info.lastInsertRowid)
    for (const item of items) {
      run('INSERT INTO commission_settlement_items (settlement_id, commission_id, amount_fen) VALUES (?, ?, ?)',
        settlementId, item.commissionId, item.amountFen)
      const changed = run(`UPDATE commission_records SET status = 'settling', settlement_id = ?, updated_at = datetime('now')
        WHERE id = ? AND status = 'available'`, settlementId, item.commissionId)
      if (Number(changed.changes ?? 0) !== 1) {
        throw new DistributionError('commission_settlement_conflict', '佣金已被其他结算单占用', 409)
      }
    }
    if (debtOffset > 0) {
      run(`UPDATE distributor_profiles SET debt_offset_fen = debt_offset_fen + ?, updated_at = datetime('now')
        WHERE user_id = ?`, debtOffset, Number(distributorUserId))
    }
    refreshBalances(distributorUserId)
    return one('SELECT * FROM commission_settlements WHERE id = ?', settlementId)
  })
}

export function reviewSettlement({ settlementId, action, reviewerId, payoutRef, reason } = {}) {
  return tx(() => {
    const settlement = one('SELECT * FROM commission_settlements WHERE id = ?', Number(settlementId))
    if (!settlement) throw new DistributionError('settlement_not_found', '结算单不存在', 404)
    if (settlement.created_by && Number(settlement.created_by) === Number(reviewerId)) {
      throw new DistributionError('dual_control_required', '结算复核人不能是创建人', 409)
    }
    if (action === 'reject') {
      if (settlement.status !== 'pending_review') throw new DistributionError('settlement_state_invalid', '当前状态不可驳回', 409)
      const changed = run("UPDATE commission_settlements SET status = 'rejected', reviewed_by = ? WHERE id = ? AND status = 'pending_review'",
        reviewerId ?? null, settlement.id)
      if (Number(changed.changes ?? 0) !== 1) throw new DistributionError('settlement_state_invalid', '结算单状态已变化', 409)
      for (const item of all('SELECT * FROM commission_settlement_items WHERE settlement_id = ?', settlement.id)) {
        const commission = one('SELECT * FROM commission_records WHERE id = ? AND status = ?', item.commission_id, 'settling')
        if (!commission) continue
        const relation = one('SELECT status, risk_status FROM distribution_relations WHERE invitee_user_id = ?', commission.invitee_user_id)
        const nextStatus = relation?.status === 'active' && relation?.risk_status === 'normal' ? 'available' : 'frozen'
        run("UPDATE commission_records SET status = ?, settlement_id = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'settling'",
          nextStatus, item.commission_id)
      }
      if (Number(settlement.debt_offset_fen ?? 0) > 0) {
        run(`UPDATE distributor_profiles SET debt_offset_fen = MAX(0, debt_offset_fen - ?), updated_at = datetime('now')
          WHERE user_id = ?`, Number(settlement.debt_offset_fen), settlement.distributor_user_id)
      }
      refreshBalances(settlement.distributor_user_id)
      return one('SELECT * FROM commission_settlements WHERE id = ?', settlement.id)
    }
    if (action === 'approve') {
      if (settlement.status !== 'pending_review') throw new DistributionError('settlement_state_invalid', '当前状态不可批准', 409)
      const changed = run("UPDATE commission_settlements SET status = 'approved', reviewed_by = ? WHERE id = ? AND status = 'pending_review'",
        reviewerId ?? null, settlement.id)
      if (Number(changed.changes ?? 0) !== 1) throw new DistributionError('settlement_state_invalid', '结算单状态已变化', 409)
      return one('SELECT * FROM commission_settlements WHERE id = ?', settlement.id)
    }
    if (action === 'pay') {
      if (settlement.status !== 'approved') throw new DistributionError('settlement_state_invalid', '结算单需先批准', 409)
      const items = all('SELECT * FROM commission_settlement_items WHERE settlement_id = ?', settlement.id)
      let actualTotal = 0
      for (const item of items) {
        const commission = one('SELECT * FROM commission_records WHERE id = ? AND status = ?', item.commission_id, 'settling')
        if (!commission) continue
        const available = Math.max(0, Number(commission.commission_amount_fen) - Number(commission.reversed_fen) - Number(commission.settled_fen))
        const payAmount = Math.min(Number(item.amount_fen), available)
        if (payAmount <= 0) continue
        const paid = run(`UPDATE commission_records SET status = 'paid', settled_fen = settled_fen + ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'settling'`, payAmount, item.commission_id)
        if (Number(paid.changes ?? 0) !== 1) throw new DistributionError('commission_state_invalid', '佣金状态已变化，结算已回滚', 409)
        run('UPDATE commission_settlement_items SET amount_fen = ? WHERE settlement_id = ? AND commission_id = ?',
          payAmount, settlement.id, item.commission_id)
        run(`INSERT INTO commission_events (commission_id, event_type, amount_fen, reason, operator_id, reference_type, reference_id)
          VALUES (?, 'settled', ?, ?, ?, 'settlement', ?)`,
        item.commission_id, -payAmount, reason ?? 'settlement_paid', reviewerId ?? null, settlement.id)
        actualTotal += payAmount
      }
      if (actualTotal <= 0) throw new DistributionError('commission_state_invalid', '结算佣金已被退款或占用，无法打款', 409)
      const oldDebtOffset = Number(settlement.debt_offset_fen ?? 0)
      const newDebtOffset = Math.min(oldDebtOffset, actualTotal)
      if (newDebtOffset < oldDebtOffset) {
        run(`UPDATE distributor_profiles SET debt_offset_fen = MAX(0, debt_offset_fen - ?), updated_at = datetime('now')
          WHERE user_id = ?`, oldDebtOffset - newDebtOffset, settlement.distributor_user_id)
      }
      if (actualTotal !== Number(settlement.amount_fen) || newDebtOffset !== oldDebtOffset) {
        run('UPDATE commission_settlements SET amount_fen = ?, debt_offset_fen = ? WHERE id = ?',
          actualTotal, newDebtOffset, settlement.id)
      }
      const changed = run(`UPDATE commission_settlements SET status = 'paid', payout_ref = ?, paid_at = datetime('now')
        WHERE id = ? AND status = 'approved'`,
      String(payoutRef ?? '').slice(0, 200) || null, settlement.id)
      if (Number(changed.changes ?? 0) !== 1) throw new DistributionError('settlement_state_invalid', '结算单状态已变化', 409)
      refreshBalances(settlement.distributor_user_id)
      return one('SELECT * FROM commission_settlements WHERE id = ?', settlement.id)
    }
    throw new DistributionError('settlement_action_invalid', '未知结算动作', 400)
  })
}

export function listSettlements({ distributorUserId, status } = {}) {
  const clauses = []
  const args = []
  if (distributorUserId) { clauses.push('s.distributor_user_id = ?'); args.push(Number(distributorUserId)) }
  if (status) { clauses.push('s.status = ?'); args.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT s.*, u.nickname, u.email FROM commission_settlements s
    LEFT JOIN users u ON u.id = s.distributor_user_id ${where}
    ORDER BY s.id DESC LIMIT 200`, ...args).map((row) => ({ ...row, email: maskEmail(row.email) }))
}

export function pageSettlements({ distributorUserId, status, page = 1, pageSize = 20 } = {}) {
  const current = Math.max(1, Number(page) || 1)
  const size = Math.max(1, Math.min(100, Number(pageSize) || 20))
  const clauses = []
  const args = []
  if (distributorUserId) { clauses.push('s.distributor_user_id = ?'); args.push(Number(distributorUserId)) }
  if (status) { clauses.push('s.status = ?'); args.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const total = Number(one(`SELECT COUNT(*) AS n FROM commission_settlements s ${where}`, ...args)?.n ?? 0)
  const rows = all(`SELECT s.*, u.nickname, u.email FROM commission_settlements s
    LEFT JOIN users u ON u.id = s.distributor_user_id ${where}
    ORDER BY s.id DESC LIMIT ? OFFSET ?`, ...args, size, (current - 1) * size)
  const list = rows.map((row) => ({ ...row, email: maskEmail(row.email) }))
  return { list, items: list, page: current, pageSize: size, total }
}

export function listCommissions({ distributorUserId, commissionLevel, status } = {}) {
  const clauses = []
  const args = []
  if (distributorUserId) { clauses.push('c.distributor_user_id = ?'); args.push(Number(distributorUserId)) }
  if (commissionLevel) { clauses.push('c.commission_level = ?'); args.push(Number(commissionLevel)) }
  if (status) { clauses.push('c.status = ?'); args.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT c.*, o.out_trade_no, o.product_type, o.drama_id, d.title AS drama_title
    FROM commission_records c
    LEFT JOIN orders o ON o.id = c.order_id
    LEFT JOIN dramas d ON d.id = o.drama_id
    ${where} ORDER BY c.id DESC LIMIT 300`, ...args)
}

export function pageCommissions({ distributorUserId, commissionLevel, status, page = 1, pageSize = 20 } = {}) {
  const current = Math.max(1, Number(page) || 1)
  const size = Math.max(1, Math.min(100, Number(pageSize) || 20))
  const clauses = []
  const args = []
  if (distributorUserId) { clauses.push('c.distributor_user_id = ?'); args.push(Number(distributorUserId)) }
  if (commissionLevel) { clauses.push('c.commission_level = ?'); args.push(Number(commissionLevel)) }
  if (status) { clauses.push('c.status = ?'); args.push(status) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const joins = `FROM commission_records c LEFT JOIN orders o ON o.id = c.order_id LEFT JOIN dramas d ON d.id = o.drama_id`
  const total = Number(one(`SELECT COUNT(*) AS n ${joins} ${where}`, ...args)?.n ?? 0)
  const rows = all(`SELECT c.*, o.out_trade_no, o.product_type, o.drama_id, d.title AS drama_title
    ${joins} ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...args, size, (current - 1) * size)
  return { list: rows, items: rows, page: current, pageSize: size, total }
}

export function listRelations({ ancestorUserId, depth, status, riskStatus } = {}) {
  const clauses = []
  const args = []
  if (ancestorUserId) { clauses.push('c.ancestor_user_id = ?'); args.push(Number(ancestorUserId)) }
  if (depth) { clauses.push('c.depth = ?'); args.push(Number(depth)) }
  if (status) { clauses.push('r.status = ?'); args.push(status) }
  if (riskStatus) { clauses.push('r.risk_status = ?'); args.push(riskStatus) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT c.ancestor_user_id, c.descendant_user_id, c.depth, r.id AS relationId, r.status, r.risk_status,
      r.bound_at, r.source_code, u.nickname, u.email
    FROM distribution_tree_closure c
    JOIN distribution_relations r ON r.invitee_user_id = c.descendant_user_id
    LEFT JOIN users u ON u.id = c.descendant_user_id
    ${where} ORDER BY c.depth ASC, c.descendant_user_id ASC LIMIT 300`, ...args)
    .map((row) => ({ ...row, email: maskEmail(row.email) }))
}

export function pageRelations({ ancestorUserId, depth, status, riskStatus, page = 1, pageSize = 20 } = {}) {
  const current = Math.max(1, Number(page) || 1)
  const size = Math.max(1, Math.min(100, Number(pageSize) || 20))
  const clauses = []
  const args = []
  if (ancestorUserId) { clauses.push('c.ancestor_user_id = ?'); args.push(Number(ancestorUserId)) }
  if (depth) { clauses.push('c.depth = ?'); args.push(Number(depth)) }
  if (status) { clauses.push('r.status = ?'); args.push(status) }
  if (riskStatus) { clauses.push('r.risk_status = ?'); args.push(riskStatus) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const joins = `FROM distribution_tree_closure c
    JOIN distribution_relations r ON r.invitee_user_id = c.descendant_user_id
    LEFT JOIN users u ON u.id = c.descendant_user_id`
  const total = Number(one(`SELECT COUNT(*) AS n ${joins} ${where}`, ...args)?.n ?? 0)
  const rows = all(`SELECT c.ancestor_user_id, c.descendant_user_id, c.depth, r.id AS relationId, r.status, r.risk_status,
      r.bound_at, r.source_code, u.nickname, u.email
    ${joins} ${where} ORDER BY c.depth ASC, c.descendant_user_id ASC LIMIT ? OFFSET ?`, ...args, size, (current - 1) * size)
  const list = rows.map((row) => ({ ...row, email: maskEmail(row.email) }))
  return { list, items: list, page: current, pageSize: size, total }
}

export function applyRiskAction({ relationId, action, reason, operatorId } = {}) {
  const relation = one('SELECT * FROM distribution_relations WHERE id = ?', Number(relationId))
  if (!relation) throw new DistributionError('relation_not_found', '分销关系不存在', 404)
  if (!['freeze', 'unfreeze', 'block'].includes(action)) {
    throw new DistributionError('risk_action_invalid', '未知风险动作', 400)
  }
  const next = action === 'block' ? { status: 'frozen', risk: 'blocked' }
    : action === 'unfreeze' ? { status: 'active', risk: 'normal' }
      : { status: 'frozen', risk: 'review' }
  return tx(() => {
    run(`UPDATE distribution_relations SET status = ?, risk_status = ?, updated_at = datetime('now') WHERE id = ?`,
      next.status, next.risk, relation.id)
    run(`INSERT INTO security_events (kind, detail, created_at) VALUES (?, ?, datetime('now'))`,
      `distribution_${action}`, JSON.stringify({ relationId: relation.id, reason: reason ?? null, operatorId: operatorId ?? null }).slice(0, 1000))
    const subtree = all('SELECT descendant_user_id FROM distribution_tree_closure WHERE ancestor_user_id = ?', relation.invitee_user_id)
      .map((row) => Number(row.descendant_user_id))
    const inviteeIds = [Number(relation.invitee_user_id), ...subtree]
    const marks = inviteeIds.map(() => '?').join(',')
    const affected = all(`SELECT * FROM commission_records
      WHERE invitee_user_id IN (${marks}) AND status IN ('frozen','available','settling')`, ...inviteeIds)
    const settlementIds = [...new Set(affected.map((row) => row.settlement_id).filter(Boolean))]
    if (action !== 'unfreeze') {
      for (const settlementId of settlementIds) {
        run("UPDATE commission_settlements SET status = 'pending_review' WHERE id = ? AND status IN ('pending_review','approved','paying')", settlementId)
      }
    }
    for (const row of affected) {
      if (action === 'block' || action === 'freeze') {
        run("UPDATE commission_records SET status = 'frozen', updated_at = datetime('now') WHERE id = ?", row.id)
      }
      refreshBalances(row.distributor_user_id)
    }
    return { relation: one('SELECT * FROM distribution_relations WHERE id = ?', relation.id), affected: affected.length }
  })
}

export function distributionAnalytics({ days = 7 } = {}) {
  const since = new Date(Date.now() - Math.max(1, Number(days) || 7) * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  const rows = all(`SELECT dp.user_id AS distributorUserId, u.nickname, u.email, dp.status,
      (SELECT COUNT(DISTINCT c.descendant_user_id) FROM distribution_tree_closure c
        WHERE c.ancestor_user_id = dp.user_id AND c.depth = 1) AS directInvitees,
      (SELECT COUNT(DISTINCT c.descendant_user_id) FROM distribution_tree_closure c
        WHERE c.ancestor_user_id = dp.user_id AND c.depth <= (SELECT max_enabled_level FROM distribution_config WHERE site_code='default')) AS teamSize,
      (SELECT COUNT(*) FROM commission_records cr WHERE cr.distributor_user_id = dp.user_id AND cr.created_at >= ?) AS commissions,
      (SELECT COALESCE(SUM(cr.commission_amount_fen - cr.reversed_fen),0) FROM commission_records cr
        WHERE cr.distributor_user_id = dp.user_id AND cr.created_at >= ?) AS netCommissionFen,
      (SELECT COALESCE(SUM(CASE WHEN cr.status = 'available' THEN cr.commission_amount_fen - cr.reversed_fen - cr.settled_fen ELSE 0 END),0)
        FROM commission_records cr WHERE cr.distributor_user_id = dp.user_id) AS availableFen,
      (SELECT COUNT(*) FROM orders o JOIN distribution_tree_closure tc ON tc.descendant_user_id = o.user_id
        WHERE tc.ancestor_user_id = dp.user_id AND tc.depth <= (SELECT max_enabled_level FROM distribution_config WHERE site_code='default')
          AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?) AS paidOrders,
      (SELECT COUNT(DISTINCT o.user_id) FROM orders o JOIN distribution_tree_closure tc ON tc.descendant_user_id = o.user_id
        WHERE tc.ancestor_user_id = dp.user_id AND tc.depth <= (SELECT max_enabled_level FROM distribution_config WHERE site_code='default')
          AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?) AS paidUsers,
      (SELECT COALESCE(SUM(o.amount_cny),0) FROM orders o JOIN distribution_tree_closure tc ON tc.descendant_user_id = o.user_id
        WHERE tc.ancestor_user_id = dp.user_id AND tc.depth <= (SELECT max_enabled_level FROM distribution_config WHERE site_code='default')
          AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?) AS paidAmount,
      (SELECT COALESCE(SUM(r.amount),0) FROM refunds r JOIN orders o ON o.id = r.order_id
        JOIN distribution_tree_closure tc ON tc.descendant_user_id = o.user_id
        WHERE tc.ancestor_user_id = dp.user_id AND tc.depth <= (SELECT max_enabled_level FROM distribution_config WHERE site_code='default')
          AND r.status = 'done' AND r.done_at >= ?) AS refundAmount,
      (SELECT COUNT(*) FROM distribution_clicks dc WHERE dc.distributor_user_id = dp.user_id AND dc.occurred_at >= ?) AS inviteClicks
    FROM distributor_profiles dp LEFT JOIN users u ON u.id = dp.user_id
    ORDER BY netCommissionFen DESC, dp.user_id ASC LIMIT 200`, since, since, since, since, since, since, since)
  const totals = rows.reduce((acc, row) => {
    acc.directInvitees += Number(row.directInvitees ?? 0)
    acc.teamSize += Number(row.teamSize ?? 0)
    acc.commissions += Number(row.commissions ?? 0)
    acc.netCommissionFen += Number(row.netCommissionFen ?? 0)
    acc.availableFen += Number(row.availableFen ?? 0)
    acc.paidOrders += Number(row.paidOrders ?? 0)
    acc.paidUsers += Number(row.paidUsers ?? 0)
    acc.paidAmount += Number(row.paidAmount ?? 0)
    acc.refundAmount += Number(row.refundAmount ?? 0)
    acc.inviteClicks += Number(row.inviteClicks ?? 0)
    return acc
  }, { directInvitees: 0, teamSize: 0, commissions: 0, netCommissionFen: 0, availableFen: 0, paidOrders: 0, paidUsers: 0, paidAmount: 0, refundAmount: 0, inviteClicks: 0 })
  return { since, rows: rows.map((row) => ({ ...row, email: maskEmail(row.email) })), totals }
}

/**
 * 分销经营看板：邀请漏斗、支付与佣金趋势、层级/内容贡献、Top 分销员。
 * 金额统一返回分；前端负责格式化为元。
 */
export function distributionDashboard({ days = 30 } = {}) {
  const windowDays = Math.max(1, Math.min(180, Number(days) || 30))
  const since = new Date(Date.now() - windowDays * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  const overview = distributionAnalytics({ days: windowDays })
  const clicks = one(`SELECT COUNT(*) AS clicks, COUNT(DISTINCT visitor_id) AS visitors
    FROM distribution_clicks WHERE occurred_at >= ?`, since)
  const invites = one(`SELECT COUNT(*) AS invites, COUNT(DISTINCT invitee_user_id) AS invitees
    FROM distribution_relations WHERE bound_at >= ? AND status <> 'invalid'`, since)
  const paid = one(`SELECT COUNT(DISTINCT o.user_id) AS paidUsers, COUNT(*) AS paidOrders,
      COALESCE(SUM(o.amount_cny),0) AS paidAmount
    FROM orders o WHERE o.distributor_user_id IS NOT NULL AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?`, since)
  const refunds = one(`SELECT COALESCE(SUM(r.amount),0) AS refundAmount
    FROM refunds r JOIN orders o ON o.id = r.order_id
    WHERE o.distributor_user_id IS NOT NULL AND r.status = 'done' AND r.done_at >= ?`, since)
  const commission = one(`SELECT
      COALESCE(SUM(commission_amount_fen),0) AS totalFen,
      COALESCE(SUM(reversed_fen),0) AS reversedFen,
      COALESCE(SUM(CASE WHEN status = 'frozen' THEN commission_amount_fen - reversed_fen ELSE 0 END),0) AS pendingFen,
      COALESCE(SUM(CASE WHEN status = 'available' THEN commission_amount_fen - reversed_fen - settled_fen ELSE 0 END),0) AS availableFen,
      COALESCE(SUM(settled_fen),0) AS settledFen
    FROM commission_records WHERE created_at >= ?`, since)
  const withdrawals = one(`SELECT
      COALESCE(SUM(CASE WHEN status IN ('pending_review','approved') THEN base_cny_fen ELSE 0 END),0) AS pendingFen,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN base_cny_fen ELSE 0 END),0) AS paidFen
    FROM withdrawal_requests WHERE created_at >= ?`, since)
  const distributors = one(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled
    FROM distributor_profiles`)
  const statuses = all(`SELECT status, COUNT(*) AS n,
      COALESCE(SUM(commission_amount_fen - reversed_fen),0) AS netFen
    FROM commission_records WHERE created_at >= ? GROUP BY status ORDER BY status`, since)
  const dailyDays = []
  for (let i = 0; i < windowDays; i += 1) {
    dailyDays.push(new Date(Date.now() + 8 * 3600_000 - i * 86400_000).toISOString().slice(0, 10))
  }
  const dailyMap = new Map(dailyDays.map((day) => [day, {
    day, clicks: 0, visitors: 0, invites: 0, paidOrders: 0, paidUsers: 0, paidAmount: 0, commissionFen: 0,
  }]))
  for (const row of all(`SELECT date(occurred_at, '+8 hours') AS day, COUNT(*) AS clicks,
      COUNT(DISTINCT visitor_id) AS visitors
    FROM distribution_clicks WHERE occurred_at >= ? GROUP BY day`, since)) {
    const item = dailyMap.get(row.day)
    if (item) { item.clicks = Number(row.clicks); item.visitors = Number(row.visitors) }
  }
  for (const row of all(`SELECT date(bound_at, '+8 hours') AS day, COUNT(*) AS invites
    FROM distribution_relations WHERE bound_at >= ? AND status <> 'invalid' GROUP BY day`, since)) {
    const item = dailyMap.get(row.day)
    if (item) item.invites = Number(row.invites)
  }
  for (const row of all(`SELECT date(o.paid_at, '+8 hours') AS day, COUNT(*) AS paidOrders,
      COUNT(DISTINCT o.user_id) AS paidUsers, COALESCE(SUM(o.amount_cny),0) AS paidAmount
    FROM orders o WHERE o.distributor_user_id IS NOT NULL AND o.status IN ('paid','fulfilled')
      AND o.paid_at >= ? GROUP BY day`, since)) {
    const item = dailyMap.get(row.day)
    if (item) {
      item.paidOrders = Number(row.paidOrders)
      item.paidUsers = Number(row.paidUsers)
      item.paidAmount = Number(row.paidAmount)
    }
  }
  for (const row of all(`SELECT date(created_at, '+8 hours') AS day,
      COALESCE(SUM(commission_amount_fen - reversed_fen),0) AS commissionFen
    FROM commission_records WHERE created_at >= ? GROUP BY day`, since)) {
    const item = dailyMap.get(row.day)
    if (item) item.commissionFen = Number(row.commissionFen)
  }
  const byLevel = all(`SELECT cr.commission_level AS level,
      COUNT(DISTINCT cr.invitee_user_id) AS invitees,
      COUNT(DISTINCT cr.order_id) AS paidOrders,
      COALESCE(SUM(o.amount_cny),0) AS paidAmount,
      COALESCE(SUM(cr.commission_amount_fen - cr.reversed_fen),0) AS commissionFen
    FROM commission_records cr LEFT JOIN orders o ON o.id = cr.order_id
    WHERE cr.created_at >= ? GROUP BY cr.commission_level ORDER BY cr.commission_level`, since)
  const byContentType = all(`SELECT COALESCE(d.content_type, 'subscription') AS contentType,
      COUNT(DISTINCT cr.order_id) AS paidOrders,
      COALESCE(SUM(o.amount_cny),0) AS paidAmount,
      COALESCE(SUM(cr.commission_amount_fen - cr.reversed_fen),0) AS commissionFen
    FROM commission_records cr LEFT JOIN orders o ON o.id = cr.order_id
    LEFT JOIN dramas d ON d.id = o.drama_id
    WHERE cr.created_at >= ? GROUP BY contentType ORDER BY commissionFen DESC`, since)
  const topContent = all(`SELECT COALESCE(d.title, '会员订阅') AS title,
      COUNT(DISTINCT o.id) AS paidOrders,
      COALESCE(SUM(o.amount_cny),0) AS paidAmount,
      COALESCE(SUM(cr.commission_amount_fen - cr.reversed_fen),0) AS commissionFen
    FROM orders o JOIN commission_records cr ON cr.order_id = o.id
    LEFT JOIN dramas d ON d.id = o.drama_id
    WHERE o.paid_at >= ? GROUP BY o.drama_id, d.title ORDER BY paidAmount DESC LIMIT 10`, since)
  const topDistributors = overview.rows
    .slice()
    .sort((a, b) => Number(b.netCommissionFen ?? 0) - Number(a.netCommissionFen ?? 0))
    .slice(0, 20)
  return {
    range: { days: windowDays, since },
    summary: {
      inviteClicks: Number(clicks?.clicks ?? 0),
      inviteVisitors: Number(clicks?.visitors ?? 0),
      invites: Number(invites?.invites ?? 0),
      invitees: Number(invites?.invitees ?? 0),
      paidUsers: Number(paid?.paidUsers ?? 0),
      paidOrders: Number(paid?.paidOrders ?? 0),
      paidAmount: Number(paid?.paidAmount ?? 0),
      paidAmountFen: Math.round(Number(paid?.paidAmount ?? 0) * 100),
      refundAmount: Number(refunds?.refundAmount ?? 0),
      refundAmountFen: Math.round(Number(refunds?.refundAmount ?? 0) * 100),
      netAmount: Number(paid?.paidAmount ?? 0) - Number(refunds?.refundAmount ?? 0),
      netAmountFen: Math.round((Number(paid?.paidAmount ?? 0) - Number(refunds?.refundAmount ?? 0)) * 100),
      commissionTotalFen: Number(commission?.totalFen ?? 0),
      commissionReversedFen: Number(commission?.reversedFen ?? 0),
      commissionPendingFen: Number(commission?.pendingFen ?? 0),
      commissionAvailableFen: Number(commission?.availableFen ?? 0),
      commissionSettledFen: Number(commission?.settledFen ?? 0),
      withdrawalPendingFen: Number(withdrawals?.pendingFen ?? 0),
      withdrawalPaidFen: Number(withdrawals?.paidFen ?? 0),
      distributors: Number(distributors?.total ?? 0),
      activeDistributors: Number(distributors?.active ?? 0),
      pendingDistributors: Number(distributors?.pending ?? 0),
      disabledDistributors: Number(distributors?.disabled ?? 0),
      clickToInviteRate: Number(clicks?.visitors ?? 0) ? Number(invites?.invitees ?? 0) / Number(clicks.visitors) : 0,
      inviteToPaidRate: Number(invites?.invitees ?? 0) ? Number(paid?.paidUsers ?? 0) / Number(invites.invitees) : 0,
    },
    funnel: [
      { key: 'clicks', label: '邀请点击', value: Number(clicks?.visitors ?? 0) },
      { key: 'invites', label: '有效邀请', value: Number(invites?.invitees ?? 0) },
      { key: 'paidUsers', label: '付费用户', value: Number(paid?.paidUsers ?? 0) },
      { key: 'paidOrders', label: '支付订单', value: Number(paid?.paidOrders ?? 0) },
    ],
    daily: [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
    statuses,
    byLevel,
    byContentType,
    topDistributors,
    topContent,
  }
}

export function teamTree({ rootUserId, maxDepth = 3 } = {}) {
  const depth = Math.max(1, Math.min(5, Number(maxDepth) || 3))
  return all(`SELECT c.depth, c.descendant_user_id AS userId, u.nickname, u.email,
      (SELECT COUNT(*) FROM orders o WHERE o.user_id = c.descendant_user_id AND o.status IN ('paid','fulfilled')) AS paidOrders,
      (SELECT COALESCE(SUM(o.amount_cny),0) FROM orders o WHERE o.user_id = c.descendant_user_id AND o.status IN ('paid','fulfilled')) AS paidAmount,
      (SELECT COALESCE(SUM(cr.commission_amount_fen - cr.reversed_fen),0) FROM commission_records cr
        WHERE cr.distributor_user_id = c.ancestor_user_id AND cr.invitee_user_id = c.descendant_user_id) AS commissionFen
    FROM distribution_tree_closure c LEFT JOIN users u ON u.id = c.descendant_user_id
    WHERE c.ancestor_user_id = ? AND c.depth <= ?
    ORDER BY c.depth ASC, c.descendant_user_id ASC LIMIT 500`, Number(rootUserId), depth)
    .map((row) => ({ ...row, email: maskEmail(row.email) }))
}
