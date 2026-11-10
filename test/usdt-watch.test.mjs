/** USDT 链上监听：配置、订单匹配、去重、状态。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-usdt-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'

const ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'

let db, watch, commerce

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  module.seedIfEmpty()
  module.ensureUserSchema()
  module.ensureAdminSchema()
  module.ensureSettings()
  module.migratePayChannels()
  commerce = await import('../server/commerce.mjs')
  watch = await import('../server/usdt-watch.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

test('未配置收款地址时监听关闭', () => {
  const status = watch.usdtWatchStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.address, null)
})

test('配置 walletAddress 后监听启用并回显地址', () => {
  const channel = db.prepare("SELECT id FROM pay_channels WHERE channel_code = 'usdt' LIMIT 1").get()
  commerce.upsertChannel({ channelCode: 'usdt', env: 'production', status: 'enabled', config: { walletAddress: ADDRESS } }, channel.id)
  const status = watch.usdtWatchStatus()
  assert.equal(status.enabled, true)
  assert.equal(status.address, ADDRESS)
})

test('订单匹配：地址 + 金额容差命中，金额偏差/地址不符不命中', () => {
  db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, channel, status, usdt_amount, usdt_address)
    VALUES (?, 1, 'single', 25, 'usdt', 'created', 25, ?)`).run('USDT-TEST-1', ADDRESS)

  assert.equal(watch.matchOrder(ADDRESS, 25)?.out_trade_no, 'USDT-TEST-1')
  assert.equal(watch.matchOrder(ADDRESS, 25.004)?.out_trade_no, 'USDT-TEST-1')
  assert.equal(watch.matchOrder(ADDRESS, 25.5), null, '超出 0.01 容差不匹配')
  assert.equal(watch.matchOrder('TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb', 25), null, '地址不符不匹配')
})

test('订单匹配：已支付订单不再重复匹配', () => {
  db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, channel, status, usdt_amount, usdt_address)
    VALUES (?, 1, 'single', 12, 'usdt', 'paid', 12, ?)`).run('USDT-TEST-2', ADDRESS)
  assert.equal(watch.matchOrder(ADDRESS, 12), null)
})

test('订单匹配：超过 6 小时的订单不再匹配', () => {
  db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, channel, status, usdt_amount, usdt_address, created_at)
    VALUES (?, 1, 'single', 33, 'usdt', 'created', 33, ?, datetime('now', '-7 hours'))`).run('USDT-TEST-3', ADDRESS)
  assert.equal(watch.matchOrder(ADDRESS, 33), null)
})

test('交易去重：同一 txid 只处理一次', () => {
  const txid = `txtest${Date.now()}`
  assert.equal(watch.seen(txid), false)
  watch.remember(txid, { to: ADDRESS, value: '25000000', block_timestamp: Date.now() }, 'USDT-TEST-1', 'pending:1/19')
  assert.equal(watch.seen(txid), false, '未终态应允许下轮重试')
  watch.remember(txid, { to: ADDRESS, value: '25000000', block_timestamp: Date.now() }, 'USDT-TEST-1', 'credited')
  assert.equal(watch.seen(txid), true, '终态才跳过')
  const row = db.prepare('SELECT order_no, status FROM chain_txns WHERE txid = ?').get(txid)
  assert.equal(row.order_no, 'USDT-TEST-1')
  assert.equal(row.status, 'credited')
})
