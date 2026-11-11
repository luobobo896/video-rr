/**
 * 渠道可用性闸门 + 行为埋点白名单。
 * 背景：线上曾出现「支付宝没配商户密钥，下单却下发 /pay/alipay-sim/… 模拟收银台」——
 * 等于白送会员。这里锁死：配置不全的渠道必须拒绝下单，也不能出现在收银台里。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-payguard-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_LINK_SECRET = 'test-link-secret'
process.env.MH_SECRET = 'test-secret'
process.env.MH_CONFIG_KEYS = `1:${Buffer.alloc(32, 11).toString('base64')}`
process.env.MH_CONFIG_KEY_VERSION = '1'

let db, commerce, analytics, entitlements

const TRON = 'TQqJV8HW8tUHDPXbqu43NsrmJvHZ19Fn9Z'

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dbModule.migratePayChannels()
  commerce = await import('../server/commerce.mjs')
  analytics = await import('../server/analytics.mjs')
  entitlements = await import('../server/entitlements.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const newUser = () => Number(db.prepare("INSERT INTO users (phone, nickname) VALUES (?, 'payguard')")
  .run(`9${Date.now()}${Math.floor(Math.random() * 1000)}`).lastInsertRowid)

const upsert = (code, config, patch = {}) => {
  const row = db.prepare('SELECT * FROM pay_channels WHERE channel_code = ?').get(code)
  commerce.upsertChannel({
    channelCode: code, env: 'production', status: 'enabled', config,
    name: patch.name ?? row?.name ?? code, scene: patch.scene ?? 'all',
    priority: patch.priority ?? 10, currency: patch.currency ?? 'CNY', isDefault: Boolean(patch.isDefault),
    minAmount: 0, maxAmount: 0,
  }, row?.id)
}

test('支付宝缺商户密钥：拒绝下单，不下发模拟收银台', () => {
  upsert('alipay', { appId: '', privateKey: '', publicKey: '' }, { isDefault: true })
  const verdict = commerce.paymentOptions('all').find((channel) => channel.code === 'alipay')
  assert.equal(verdict.usable, false)
  assert.match(verdict.unavailableReason, /商户密钥未配置/)

  assert.throws(
    () => commerce.createOrder({ userId: newUser(), productType: 'subscription', planId: 1, channel: 'alipay' }),
    (error) => error.code === 'channel_not_configured',
  )
})

test('支付宝配齐三件套后才允许下单', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  upsert('alipay', { appId: '2021000000000000', privateKey, publicKey }, { isDefault: true })
  const verdict = commerce.paymentOptions('all').find((channel) => channel.code === 'alipay')
  assert.equal(verdict.usable, true)
  const result = commerce.createOrder({ userId: newUser(), productType: 'subscription', planId: 1, channel: 'alipay' })
  assert.equal(result.simulated, false)
  assert.match(result.payUrl, /^https:\/\/openapi\.alipay\.com/)
})

test('USDT 地址为空或格式错误时渠道不可用，写入合法 TRC20 地址后可用', () => {
  upsert('usdt', { walletAddress: '', network: 'TRC20', rate: 7.2 }, { currency: 'USDT', isDefault: false, priority: 20 })
  let verdict = commerce.paymentOptions('all').find((channel) => channel.code === 'usdt')
  assert.equal(verdict.usable, false)
  assert.match(verdict.unavailableReason, /地址未配置/)

  upsert('usdt', { walletAddress: 'T-not-a-address', network: 'TRC20', rate: 7.2 }, { currency: 'USDT', priority: 20 })
  verdict = commerce.paymentOptions('all').find((channel) => channel.code === 'usdt')
  assert.equal(verdict.usable, false)

  upsert('usdt', { walletAddress: TRON, network: 'TRC20', rate: 7.2, minConfirmations: 19 }, { currency: 'USDT', priority: 20 })
  verdict = commerce.paymentOptions('all').find((channel) => channel.code === 'usdt')
  assert.equal(verdict.usable, true)
  const order = commerce.createOrder({ userId: newUser(), productType: 'subscription', planId: 1, channel: 'usdt' })
  assert.equal(order.usdt.address, TRON)
  assert.ok(order.usdt.amount > 0)
})

test('默认渠道选择会跳过不可用渠道', () => {
  // usdt 设为默认但地址是坏的（upsert 把空串当「不修改」，所以用非法地址表示清空）→ 落到 alipay
  upsert('usdt', { walletAddress: 'T-broken', network: 'TRC20', rate: 7.2 }, { currency: 'USDT', isDefault: true, priority: 1 })
  upsert('alipay', { appId: '2021000000000000', privateKey: 'PRIVATE', publicKey: 'PUBLIC' }, { isDefault: false, priority: 10 })
  const picked = commerce.resolveChannel({ scene: 'all', amount: 25 })
  assert.equal(picked.channel_code, 'alipay')
})

test('行为埋点只收白名单类型，并能汇总到训练漏斗', () => {
  const uid = newUser()
  assert.equal(analytics.recordEvent({ type: 'detail_view', userId: uid, dramaId: 1 }), true)
  assert.equal(analytics.recordEvent({ type: 'paywall_view', userId: uid, dramaId: 1 }), true)
  assert.equal(analytics.recordEvent({ type: 'play_end', userId: uid, dramaId: 1, position: 590, duration: 600, value: 0.98 }), true)
  assert.equal(analytics.recordEvent({ type: 'detail_view', userId: uid, dramaId: 1, value: 0 }), true)
  // 非白名单类型（例如想借埋点接口写任意表）直接拒绝
  assert.equal(analytics.recordEvent({ type: 'orders', userId: uid }), false)
  assert.equal(analytics.recordEvent({ type: '', userId: uid }), false)
  assert.equal(analytics.isClientTrackType('payment_success'), false)
  assert.equal(analytics.isClientTrackType('order_created'), false)
  assert.equal(analytics.isClientTrackType('detail_view'), true)

  const report = analytics.analyticsReport({ days: 7 })
  assert.equal(report.tracking.upstream.detailViews, 2)
  assert.equal(report.tracking.upstream.paywallViews, 1)
  assert.equal(report.tracking.completion.samples, 1)
  assert.equal(report.tracking.completion.finished, 1)
  assert.ok(report.tracking.completion.avgRate > 0.9)
  const byType = Object.fromEntries(report.tracking.byType.map((row) => [row.type, row.n]))
  assert.equal(byType.detail_view, 2)
})

test('匿名访客：生成 visitor_id、关联 user_id，并进入分析漏斗', () => {
  const uid = newUser()
  const visitorId = `anon-${Date.now()}`
  assert.equal(analytics.recordEvent({ type: 'page_view', visitorId, path: '#/home' }), true)
  assert.equal(analytics.recordEvent({ type: 'impression', visitorId, userId: uid, dramaId: 1 }), true)
  const visitor = db.prepare('SELECT * FROM visitors WHERE id = ?').get(visitorId)
  assert.ok(visitor)
  assert.equal(visitor.user_id, uid)
  const report = analytics.analyticsReport({ days: 7 })
  assert.ok(report.visitors.total >= 1)
  assert.ok(report.tracking.upstream.pageViews >= 1)
  assert.ok(report.conversion.some((stage) => stage.key === 'visitors' && stage.value >= 1))
})

test('转化漏斗按访客逐级去重，订单与支付继承 visitor_id', () => {
  const previousSimPay = process.env.MH_ALLOW_SIM_PAY
  process.env.MH_ALLOW_SIM_PAY = '1'
  try {
    upsert('mock', {}, { isDefault: true, priority: 1 })
    const uid = newUser()
    const visitorId = `funnel-${Date.now()}`
    assert.equal(analytics.recordEvent({ type: 'page_view', visitorId, path: '#/home' }), true)
    assert.equal(analytics.recordEvent({ type: 'login_open', visitorId }), true)
    assert.equal(analytics.recordEvent({ type: 'login_success', visitorId, userId: uid, meta: { method: 'code' } }), true)
    assert.equal(analytics.recordEvent({ type: 'detail_view', visitorId, userId: uid, dramaId: 1 }), true)
    assert.doesNotThrow(() => analytics.recordPlay({ userId: uid, visitorId, dramaId: 1, episodeId: 1, episodeNo: 1 }))
    assert.equal(analytics.recordEvent({ type: 'paywall_view', visitorId, userId: uid, dramaId: 1 }), true)

    const created = commerce.createOrder({ userId: uid, visitorId, productType: 'subscription', planId: 1, channel: 'mock' })
    assert.equal(created.order.visitor_id, visitorId)
    const paid = commerce.markPaid({
      orderId: created.order.id, channel: 'mock', channelTxnId: `FUNNEL-${Date.now()}`,
    })
    assert.equal(paid.order.status, 'fulfilled')

    const report = analytics.analyticsReport({ days: 7 })
    const stages = Object.fromEntries(report.conversion.map((stage) => [stage.key, stage.value]))
    assert.ok(stages.visitors >= 1)
    assert.ok(stages.detailViews >= 1)
    assert.ok(stages.plays >= 1)
    assert.ok(stages.paywallViews >= 1)
    assert.ok(stages.orders >= 1)
    assert.ok(stages.paid >= 1)
    for (let index = 1; index < report.conversion.length; index += 1) {
      assert.ok(report.conversion[index].value <= report.conversion[index - 1].value)
      assert.ok(report.conversion[index].rate <= 100)
    }
    const byType = Object.fromEntries(report.tracking.byType.map((row) => [row.type, row.n]))
    assert.ok(byType.order_created >= 1)
    assert.ok(byType.payment_success >= 1)
  } finally {
    if (previousSimPay === undefined) delete process.env.MH_ALLOW_SIM_PAY
    else process.env.MH_ALLOW_SIM_PAY = previousSimPay
  }
})

test('策略组覆盖单剧策略，改组后已分配剧集实时生效', () => {
  const groupId = Number(db.prepare(`INSERT INTO policy_groups
    (name, description, access_mode, free_episodes, trial_seconds, single_price_cny)
    VALUES ('测试策略组', '', 'paid', 2, 30, 9.9)`).run().lastInsertRowid)
  db.prepare(`INSERT INTO content_policies
    (drama_id, policy_group_id, access_mode, free_episodes, trial_seconds, single_price_cny)
    VALUES (1, ?, 'subscription', 0, 0, 0)
    ON CONFLICT(drama_id) DO UPDATE SET policy_group_id = excluded.policy_group_id,
      access_mode = excluded.access_mode, free_episodes = excluded.free_episodes,
      trial_seconds = excluded.trial_seconds, single_price_cny = excluded.single_price_cny`)
    .run(groupId)
  let policy = entitlements.policyOf(1)
  assert.equal(policy.policy_group_id, groupId)
  assert.equal(policy.access_mode, 'paid')
  assert.equal(policy.free_episodes, 2)
  assert.equal(policy.single_price_cny, 9.9)
  db.prepare("UPDATE policy_groups SET access_mode = 'free', single_price_cny = 0 WHERE id = ?").run(groupId)
  policy = entitlements.policyOf(1)
  assert.equal(policy.access_mode, 'free')
  assert.equal(policy.single_price_cny, 0)
})
