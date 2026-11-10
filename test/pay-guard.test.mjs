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

let db, commerce, analytics

const TRON = 'TQqJV8HW8tUHDPXbqu43NsrmJvHZ19Fn9Z'

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dbModule.migratePayChannels()
  commerce = await import('../server/commerce.mjs')
  analytics = await import('../server/analytics.mjs')
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

  const report = analytics.analyticsReport({ days: 7 })
  assert.equal(report.tracking.upstream.detailViews, 2)
  assert.equal(report.tracking.upstream.paywallViews, 1)
  assert.equal(report.tracking.completion.samples, 1)
  assert.equal(report.tracking.completion.finished, 1)
  assert.ok(report.tracking.completion.avgRate > 0.9)
  const byType = Object.fromEntries(report.tracking.byType.map((row) => [row.type, row.n]))
  assert.equal(byType.detail_view, 2)
})
