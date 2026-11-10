/**
 * 加固回归（对应评审报告 R2/R3/R4 与「未终态可重试」状态机）：
 *  - 老库密钥兜底：dev-link-secret / 过短密钥必须被启动逻辑换掉
 *  - 老库口令兜底：仍用 admin123 的账号必须被轮换并强制改密
 *  - USDT 链上扫描：确认数不足只记 pending，下一轮确认足够后入账且只入账一次
 * 运行：node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-hard-'))
process.env.MH_DB = join(dir, 'hard.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret-for-hardening'
process.env.MH_OTP_SECRET = 'test-otp-secret-for-hardening'

const dbModule = await import('../server/db.mjs')
const db = dbModule.db
dbModule.seedIfEmpty()
dbModule.migratePayChannels()
dbModule.ensureAdminSchema()

const auth = await import('../server/auth.mjs')
const commerce = await import('../server/commerce.mjs')
const watch = await import('../server/usdt-watch.mjs')

const ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'

test('密钥加固：dev-link-secret 与过短密钥会被替换成随机值', () => {
  dbModule.setSetting('site', { ...dbModule.getSetting('site', {}), linkSecret: 'dev-link-secret' })
  const first = dbModule.ensureLinkSecret()
  const after = dbModule.getSetting('site', {}).linkSecret
  assert.notEqual(after, 'dev-link-secret')
  assert.ok(String(after).length >= 16, `新密钥长度应 ≥16，实际 ${after}`)
  assert.equal(first.rotated, true)

  // 已存在强密钥时不再变动（幂等）
  const second = dbModule.ensureLinkSecret()
  assert.equal(second.rotated, false)
  assert.equal(dbModule.getSetting('site', {}).linkSecret, after)

  dbModule.setSetting('site', { ...dbModule.getSetting('site', {}), linkSecret: 'short' })
  assert.equal(dbModule.ensureLinkSecret().rotated, true)
})

test('口令加固：仍在用 admin123 的账号被轮换并强制改密', async () => {
  const salt = 'legacy-salt'
  db.prepare("UPDATE admins SET password_hash = ?, salt = ?, password_updated_at = NULL, must_change_password = 0 WHERE username = 'admin'")
    .run(auth.hashPassword('admin123', salt), salt)

  // 测试夹具默认 MH_ADMIN_INIT_PASSWORD=admin123；轮换用例必须走随机口令，否则"轮换"回同一弱口令
  const savedInit = process.env.MH_ADMIN_INIT_PASSWORD
  delete process.env.MH_ADMIN_INIT_PASSWORD
  const result = dbModule.ensureAdminCredentials()
  if (savedInit === undefined) delete process.env.MH_ADMIN_INIT_PASSWORD
  else process.env.MH_ADMIN_INIT_PASSWORD = savedInit
  assert.ok(result.rotated >= 1, '应轮换至少一个账号')

  const row = db.prepare("SELECT * FROM admins WHERE username = 'admin'").get()
  assert.equal(row.must_change_password, 1, '轮换后必须强制改密')
  assert.equal(auth.verifyPassword('admin123', row.salt, row.password_hash), false, 'admin123 必须失效')
  assert.equal(auth.verifyPassword('admin123', 'x', 'y'), false)
})

test('USDT 扫描：确认数不足只记 pending，补足后入账且只入账一次', async () => {
  const channel = commerce.listChannels().find((item) => item.channel_code === 'usdt')
  commerce.upsertChannel({
    channelCode: 'usdt', env: 'production', status: 'enabled',
    config: { walletAddress: ADDRESS, rate: 7.2, network: 'TRC20', minConfirmations: 19 },
  }, channel?.id)

  const orderNo = `USDT-HARD-${Date.now()}`
  const dramaId = db.prepare('SELECT id FROM dramas LIMIT 1').get().id
  db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, drama_id, amount_cny, channel, status, usdt_amount, usdt_address)
    VALUES (?, 1, 'single', ?, 25, 'usdt', 'created', 25, ?)`).run(orderNo, dramaId, ADDRESS)

  const txid = `txhard${Date.now()}`
  const transfer = {
    transaction_id: txid, to: ADDRESS, value: '25000000',
    token_info: { decimals: 6 }, block_timestamp: Date.now() - 3_000,
  }
  const realFetch = globalThis.fetch
  let transfers = [transfer]
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ data: transfers }) })
  try {
    // 第 1 轮：只有 1 个确认 / 需要 19 → pending，不入账
    const first = await watch.scanOnce()
    assert.equal(first.matched, 0, '确认数不足不应入账')
    assert.equal(db.prepare('SELECT status FROM orders WHERE out_trade_no = ?').get(orderNo).status, 'created')
    const row = db.prepare('SELECT status FROM chain_txns WHERE txid = ?').get(txid)
    assert.match(row.status, /^pending:/, `应记 pending，实际 ${row.status}`)

    // 第 2 轮：链上时间推进到 20 个确认 → 入账
    transfers = [{ ...transfer, block_timestamp: Date.now() - 20 * 3_000 }]
    const second = await watch.scanOnce()
    assert.equal(second.matched, 1, '确认足够后应入账')
    const paid = db.prepare('SELECT status, paid_at FROM orders WHERE out_trade_no = ?').get(orderNo)
    assert.ok(['paid', 'fulfilled'].includes(paid.status), `订单应为已支付/已发放，实际 ${paid.status}`)
    assert.ok(paid.paid_at, 'paid_at 应写入')
    assert.equal(db.prepare('SELECT status FROM chain_txns WHERE txid = ?').get(txid).status, 'credited')

    // 第 3 轮：同一 txid 不再重复入账
    const third = await watch.scanOnce()
    assert.equal(third.matched, 0, '终态交易不应重复入账')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('USDT 扫描：拉取失败不抛错，仅记录错误', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('network down') }
  try {
    const result = await watch.scanOnce()
    assert.equal(result.matched, 0)
    assert.match(String(result.error), /network down/)
  } finally {
    globalThis.fetch = realFetch
  }
})
