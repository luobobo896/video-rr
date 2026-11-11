import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-distribution-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_LINK_SECRET = 'test-link-secret'
process.env.MH_SECRET = 'test-secret'
process.env.MH_ALLOW_SIM_PAY = '1'

let db, dist, commerce

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dbModule.migratePayChannels()
  db.prepare("UPDATE pay_channels SET status='enabled', is_default=1 WHERE channel_code='mock'").run()
  dist = await import('../server/distribution.mjs')
  commerce = await import('../server/commerce.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const newUser = () => Number(db.prepare("INSERT INTO users (email,nickname) VALUES (?, 'dist')")
  .run(`dist-${Date.now()}-${Math.random()}@example.com`).lastInsertRowid)

function chain() {
  const a = newUser()
  const b = newUser()
  const c = newUser()
  const d = newUser()
  for (const uid of [a, b, c, d]) dist.applyDistributor(uid)
  const codeA = dist.getOrCreateReferralCode(a)
  const codeB = dist.getOrCreateReferralCode(b)
  const codeC = dist.getOrCreateReferralCode(c)
  dist.recordInviteClick({ code: codeA.code, visitorId: 'v-b' })
  dist.bindReferral({ userId: b, visitorId: 'v-b', code: codeA.code })
  dist.recordInviteClick({ code: codeB.code, visitorId: 'v-c' })
  dist.bindReferral({ userId: c, visitorId: 'v-c', code: codeB.code })
  dist.recordInviteClick({ code: codeC.code, visitorId: 'v-d' })
  dist.bindReferral({ userId: d, visitorId: 'v-d', code: codeC.code })
  for (const level of [1, 2, 3]) {
    dist.upsertCommissionRule({ ruleCode: `DIST_${level}`, relationLevel: level, rateBp: [1000, 500, 300][level - 1] })
  }
  return { a, b, c, d }
}

test('没有有效点击的邀请码不会绑定关系', () => {
  const inviter = newUser()
  const invitee = newUser()
  dist.applyDistributor(inviter)
  const code = dist.getOrCreateReferralCode(inviter)
  assert.equal(dist.bindReferral({ userId: invitee, visitorId: 'v-no-click', code: code.code }), null)
})

test('三级闭包与逐级佣金生成', () => {
  const { a, b, c, d } = chain()
  const rows = db.prepare('SELECT ancestor_user_id, depth FROM distribution_tree_closure WHERE descendant_user_id = ? ORDER BY depth').all(d)
  assert.deepEqual(rows.map((row) => [row.ancestor_user_id, row.depth]), [[c, 1], [b, 2], [a, 3]])

  const order = commerce.createOrder({
    userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock',
  })
  const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `DIST-${Date.now()}` })
  const commissions = db.prepare('SELECT * FROM commission_records WHERE order_id = ? ORDER BY commission_level').all(paid.order.id)
  assert.equal(commissions.length, 3)
  assert.deepEqual(commissions.map((row) => row.distributor_user_id), [c, b, a])
  assert.deepEqual(commissions.map((row) => row.commission_amount_fen), [250, 125, 75])

  const duplicate = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: 'DIST-DUPLICATE' })
  assert.equal(duplicate.duplicate, true)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM commission_records WHERE order_id = ?').get(paid.order.id).n, 3)
})

test('退款按比例冲减每一级佣金', () => {
  const { d } = chain()
  const order = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `REF-${Date.now()}` })
  const refund = commerce.createRefund({ orderId: paid.order.id, amount: paid.order.amount_cny / 2, reason: '测试部分退款', operatorId: 11 })
  const result = commerce.approveRefund({ refundId: refund.id, approverId: 12 })
  const rows = db.prepare('SELECT commission_amount_fen, reversed_fen, status FROM commission_records WHERE order_id = ? ORDER BY commission_level').all(paid.order.id)
  assert.equal(rows.length, 3)
  for (const row of rows) assert.equal(row.reversed_fen, Math.floor(row.commission_amount_fen / 2 + 0.5))
  assert.equal(result.refund.status, 'done')
})

test('结算单需要双人复核，打款后佣金记已结算', () => {
  const { a, d } = chain()
  const order = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `SET-${Date.now()}` })
  db.prepare("UPDATE commission_records SET available_at=datetime('now','-1 minute') WHERE order_id = ?").run(paid.order.id)
  dist.markCommissionsAvailable()
  db.prepare("UPDATE distribution_config SET min_settlement_fen=0 WHERE site_code='default'").run()
  const settlement = dist.createSettlement({
    distributorUserId: a, periodStart: '2000-01-01', periodEnd: '2099-12-31', createdBy: 21,
  })
  assert.ok(settlement.amount_fen > 0)
  const approved = dist.reviewSettlement({ settlementId: settlement.id, action: 'approve', reviewerId: 22 })
  assert.equal(approved.status, 'approved')
  const paidSettlement = dist.reviewSettlement({ settlementId: settlement.id, action: 'pay', reviewerId: 22, payoutRef: 'BANK-TEST' })
  assert.equal(paidSettlement.status, 'paid')
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM commission_records WHERE distributor_user_id = ? AND status = 'paid'").get(a).n >= 1)
})

test('已结算后退款形成待抵扣负余额', () => {
  const { a, d } = chain()
  const order = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `DEBT-${Date.now()}` })
  db.prepare("UPDATE commission_records SET available_at=datetime('now','-1 minute') WHERE order_id = ?").run(paid.order.id)
  dist.markCommissionsAvailable()
  db.prepare("UPDATE distribution_config SET min_settlement_fen=0 WHERE site_code='default'").run()
  const settlement = dist.createSettlement({ distributorUserId: a, periodStart: '2000-01-01', periodEnd: '2099-12-31', createdBy: 31 })
  dist.reviewSettlement({ settlementId: settlement.id, action: 'approve', reviewerId: 32 })
  dist.reviewSettlement({ settlementId: settlement.id, action: 'pay', reviewerId: 32, payoutRef: 'BANK-DEBT' })
  const refund = commerce.createRefund({ orderId: paid.order.id, amount: paid.order.amount_cny, reason: '已结算后退款', operatorId: 33 })
  commerce.approveRefund({ refundId: refund.id, approverId: 34 })
  dist.refreshBalances(a)
  assert.ok(Number(db.prepare('SELECT debt_fen FROM distributor_profiles WHERE user_id = ?').get(a).debt_fen) > 0)
})

test('按 IP/手动币种返回 CNY 或 USD 展示余额，并可提交提现', () => {
  assert.equal(dist.detectCurrency({ country: 'CN' }), 'CNY')
  assert.equal(dist.detectCurrency({ country: 'US' }), 'USD')
  assert.equal(dist.detectCurrency({ requested: 'CNY', country: 'US' }), 'CNY')
  assert.equal(dist.detectCurrency({ country: 'HK', acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' }), 'CNY')
  assert.equal(dist.detectCurrency({ country: 'US', acceptLanguage: 'zh-CN,zh;q=0.9' }), 'USD')

  const { a, d } = chain()
  db.prepare("UPDATE payout_methods SET min_amount_minor=0 WHERE code='cny_bank'").run()
  const order = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `WD-${Date.now()}` })
  db.prepare("UPDATE commission_records SET available_at=datetime('now','-1 minute') WHERE order_id = ?").run(paid.order.id)
  dist.markCommissionsAvailable()
  const summary = dist.distributionSummary(a)
  assert.ok(summary.balances.some((row) => row.code === 'CNY' && row.amount > 0))
  const amount = summary.balances.find((row) => row.code === 'CNY').amount
  const withdrawal = dist.createWithdrawalRequest({
    userId: a, amount, currency: 'CNY', methodCode: 'cny_bank',
    account: { accountName: 'A', bankName: 'B', accountNo: '12345678' },
  })
  assert.equal(withdrawal.status, 'pending_review')
  assert.equal('account_cipher' in withdrawal, false)
  assert.equal(dist.distributionSummary(a).commissions.withdrawableFen, 0)
  const approved = dist.reviewWithdrawal({ withdrawalId: withdrawal.id, action: 'approve', reviewerId: 51 })
  assert.equal(approved.status, 'approved')
  const paidWithdrawal = dist.reviewWithdrawal({ withdrawalId: withdrawal.id, action: 'pay', reviewerId: 51, payoutRef: 'BANK-WD-1' })
  assert.equal(paidWithdrawal.status, 'paid')
  const paidCommission = db.prepare(`SELECT COUNT(*) AS n FROM commission_records
    WHERE distributor_user_id = ? AND settled_fen > 0`).get(a)
  assert.ok(paidCommission.n > 0)
  assert.equal(dist.distributionSummary(a).commissions.withdrawableFen, 0)

  const nextOrder = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  const nextPaid = commerce.markPaid({ outTradeNo: nextOrder.order.out_trade_no, channel: 'mock', channelTxnId: `WD-NEXT-${Date.now()}` })
  db.prepare("UPDATE commission_records SET available_at=datetime('now','-1 minute') WHERE order_id = ?").run(nextPaid.order.id)
  dist.markCommissionsAvailable()
  db.prepare("UPDATE distribution_config SET min_settlement_fen=0 WHERE site_code='default'").run()
  assert.doesNotThrow(() => dist.createSettlement({ distributorUserId: a, periodStart: '2000-01-01', periodEnd: '2099-12-31', createdBy: 52 }))
})

test('风控冻结后驳回结算不能把佣金恢复为可提现', () => {
  const { a, d } = chain()
  const order = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `RISK-${Date.now()}` })
  db.prepare("UPDATE commission_records SET available_at=datetime('now','-1 minute') WHERE order_id = ?").run(paid.order.id)
  dist.markCommissionsAvailable()
  db.prepare("UPDATE distribution_config SET min_settlement_fen=0 WHERE site_code='default'").run()
  const settlement = dist.createSettlement({ distributorUserId: a, periodStart: '2000-01-01', periodEnd: '2099-12-31', createdBy: 61 })
  const relation = db.prepare('SELECT id FROM distribution_relations WHERE invitee_user_id = ?').get(d)
  dist.applyRiskAction({ relationId: relation.id, action: 'freeze', reason: 'QA 风控', operatorId: 62 })
  dist.reviewSettlement({ settlementId: settlement.id, action: 'reject', reviewerId: 63, reason: 'QA 驳回' })
  const statuses = db.prepare('SELECT DISTINCT status FROM commission_records WHERE order_id = ?').all(paid.order.id).map((row) => row.status)
  assert.deepEqual(statuses, ['frozen'])
})

test('分销后台列表返回服务端分页总数', () => {
  const page = dist.pageCommissions({ page: 1, pageSize: 2 })
  assert.equal(page.page, 1)
  assert.equal(page.pageSize, 2)
  assert.ok(page.total >= page.list.length)
  assert.equal(page.items.length, page.list.length)
})

test('提现方式编码大小写归一，编辑不会生成重复记录', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM payout_methods').get().n
  const updated = dist.upsertPayoutMethod({
    code: 'CNY_BANK', name: '人民币银行卡', currency: 'CNY', minAmountMinor: 0,
    fields: [
      { key: 'accountName', label: '收款人' },
      { key: 'bankName', label: '开户行' },
      { key: 'accountNo', label: '银行卡号' },
    ],
  })
  const after = db.prepare('SELECT COUNT(*) AS n FROM payout_methods').get().n
  assert.equal(after, before)
  assert.equal(updated.code, 'cny_bank')
})

test('佣金规则保存超过总比例上限时拒绝', () => {
  assert.throws(
    () => dist.upsertCommissionRule({ ruleCode: 'CAP_B2', relationLevel: 1, rateBp: 600 }),
    /总比例上限/,
  )
})

test('分销配置可更新审核方式、归因窗口和启停状态', () => {
  const updated = dist.updateDistributionConfig({
    autoApprove: false, attributionWindowDays: 45, status: 'disabled',
  }, 1)
  assert.equal(updated.auto_approve, 0)
  assert.equal(updated.attribution_window_days, 45)
  assert.equal(updated.status, 'disabled')
  const zero = dist.updateDistributionConfig({ freezeDays: 0, minSettlementFen: 0 }, 1)
  assert.equal(zero.freeze_days, 0)
  assert.equal(zero.min_settlement_fen, 0)
  dist.updateDistributionConfig({ autoApprove: true, attributionWindowDays: 30, status: 'active' }, 1)
})

test('佣金表异常不阻断已确认的支付', () => {
  const { d } = chain()
  const order = commerce.createOrder({ userId: d, visitorId: 'v-d', productType: 'subscription', planId: 1, channel: 'mock' })
  db.exec('ALTER TABLE commission_rules RENAME TO commission_rules_payment_test')
  try {
    const paid = commerce.markPaid({ outTradeNo: order.order.out_trade_no, channel: 'mock', channelTxnId: `PAY-COMMISSION-${Date.now()}` })
    assert.equal(paid.order.status, 'fulfilled')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(paid.order.id).n, 1)
    assert.equal(db.prepare("SELECT status FROM commission_outbox WHERE order_id = ?").get(paid.order.id).status, 'pending')
  } finally {
    db.exec('ALTER TABLE commission_rules_payment_test RENAME TO commission_rules')
  }
  assert.equal(commerce.processCommissionOutbox(order.order.id), 1)
  assert.equal(db.prepare("SELECT status FROM commission_outbox WHERE order_id = ?").get(order.order.id).status, 'done')
})
