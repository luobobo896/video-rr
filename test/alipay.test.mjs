/** 支付宝链路 + 登录门禁 回归测试。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-alipay-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'
process.env.MH_CONFIG_KEYS = `1:${Buffer.alloc(32, 3).toString('base64')}`
process.env.MH_CONFIG_KEY_VERSION = '1'

let db, commerce, alipay, ent, sealSecret

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  module.seedIfEmpty()
  module.syncMenuCatalog()
  module.migratePayChannels()
  commerce = await import('../server/commerce.mjs')
  alipay = await import('../server/payments/alipay.mjs')
  ent = await import('../server/entitlements.mjs')
  sealSecret = (await import('../server/secretbox.mjs')).sealSecret
})

after(() => { try { db.close() } catch { /* ignore */ } })

const userId = () => Number(db.prepare("INSERT INTO users (phone, nickname) VALUES (?, 'payer')").run(`1${Date.now()}${Math.floor(Math.random() * 999)}`).lastInsertRowid)

test('RSA2 签名与验签：篡改参数验签失败', () => {
  const { simPrivateKey: privateKey, simPublicKey: publicKey } = alipay.ensureSimulatorKeys({})
  const params = { app_id: '2021000', out_trade_no: 'A1', total_amount: '0.01', timestamp: '2026-01-01 00:00:00' }
  const sign = alipay.signRSA2(params, privateKey)
  assert.equal(alipay.verifyRSA2({ ...params, sign }, publicKey), true)
  assert.equal(alipay.verifyRSA2({ ...params, total_amount: '0.02', sign }, publicKey), false)
  assert.equal(alipay.verifyRSA2({ ...params }, publicKey), false)
})

test('canonical：剔除 sign/sign_type 并按字典序拼接', () => {
  const text = alipay.canonical({ b: '2', a: '1', sign: 'x', sign_type: 'RSA2', empty: '' })
  assert.equal(text, 'a=1&b=2')
})

test('未配置真实凭证时走模拟收银台，付款后权益到账', () => {
  const uid = userId()
  const channel = db.prepare("SELECT * FROM pay_channels WHERE channel_code='alipay'").get()
  db.prepare('UPDATE pay_channels SET status = ?, config_cipher = ? WHERE id = ?')
    .run('enabled', sealSecret({}), channel.id)
  commerce.setDefaultChannel({ channelId: channel.id })

  const created = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1 })
  assert.equal(created.order.channel, 'alipay')
  assert.match(created.payUrl, /\/pay\/alipay-sim\//)
  assert.equal(created.simulated, true)

  const { params } = commerce.buildSimulatedAlipayNotify(created.order.out_trade_no)
  const result = commerce.handleAlipayNotify(params, { simulator: true })
  assert.equal(result.order.status, 'fulfilled')

  const drama = db.prepare('SELECT id FROM dramas WHERE category != ? LIMIT 1').get('MOVIE')
  db.prepare('UPDATE content_policies SET access_mode = ?, free_episodes = 0 WHERE drama_id = ?').run('subscription', drama.id)
  assert.equal(ent.resolveAccess(uid, drama.id, 3).source, 'subscription')
})

test('模拟通知被篡改金额后验签失败', () => {
  const uid = userId()
  const created = commerce.createOrder({ userId: uid, productType: 'subscription', planId: 1 })
  const outTradeNo = created.order.out_trade_no
  const { params } = commerce.buildSimulatedAlipayNotify(outTradeNo)
  assert.throws(() => commerce.handleAlipayNotify({ ...params, total_amount: '0.01' }, { simulator: true }), /验签失败/)
})

test('渠道自检返回签名校验结果', () => {
  const channel = db.prepare("SELECT * FROM pay_channels WHERE channel_code='alipay'").get()
  const result = commerce.testChannel({ channelId: channel.id })
  assert.equal(typeof result.ok, 'boolean')
  if (result.signatureCheck) assert.equal(result.signatureCheck.ok, true)
})

test('登录门禁：浏览公开、播放与个人数据需登录', async () => {
  const { createServer } = await import('node:http')
  const { handlePublic } = await import('../server/api-public.mjs')
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    void handlePublic(url.pathname, url, req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  try {
    const home = await fetch(`${base}/api/home`)
    assert.equal(home.status, 200)

    // 浏览类接口对未登录开放（分享链接不能撞登录墙）
    for (const path of ['/api/drama/1', '/api/rank?type=HOT', '/api/category?type=TV']) {
      const res = await fetch(base + path)
      assert.equal(res.status, 200, path)
    }
    // 播放与个人数据仍需登录
    for (const path of ['/api/play/1/1', '/api/me']) {
      const res = await fetch(base + path)
      assert.equal(res.status, 401, path)
      const json = await res.json()
      assert.equal(json.code, '0401')
    }
  } finally {
    server.close()
  }
})
