/**
 * 安全加固回归：后台强口令策略、登录失败锁定、限流（内存降级）、播放签名 UA 绑定、验证码不回显。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-sec-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'
process.env.MH_OTP_SECRET = 'otp-secret'
process.env.MH_LINK_SECRET = 'link-secret'
process.env.MH_LINK_TTL = '300'
delete process.env.MH_REDIS_URL

let db, security, entitlements, ratelimit, otp, adminApi

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  module.seedIfEmpty()
  module.ensureUserSchema()
  module.ensureAdminSchema()
  security = await import('../server/security-check.mjs').catch(() => null)
  entitlements = await import('../server/entitlements.mjs')
  ratelimit = await import('../server/ratelimit.mjs')
  otp = await import('../server/otp.mjs')
  adminApi = await import('../server/api-admin.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const checkAdminPassword = (password, username = 'admin') => {
  const fn = adminApi.checkAdminPassword ?? security?.checkAdminPassword
  return fn(password, username)
}

test('后台口令策略：长度/字符/用户名/重复字符/常见弱口令', () => {
  assert.equal(typeof checkAdminPassword, 'function')
  const bad = (password, username, pattern) => {
    const result = checkAdminPassword(password, username)
    assert.equal(result.ok, false, `${password} 应被拒绝`)
    assert.match(result.message, pattern)
  }
  bad('Ab1', 'admin', /至少 12 位/)
  bad('abcdefghijkl', 'admin', /字母和数字/)
  bad('123456789012', 'admin', /字母和数字/)
  bad('Admin12345678', 'admin', /用户名/)
  bad('password1234', 'ops01', /常见/)
  bad('aaaaaaaaaaa1', 'ops01', /重复/)
  assert.equal(checkAdminPassword('Xk7mQ2pLw9Za', 'ops01').ok, true)
})

test('登录失败 5 次锁定 10 分钟，成功一次清零', async () => {
  const user = 'fin01'
  assert.equal(await ratelimit.loginLockSeconds(user), 0)
  for (let i = 0; i < 4; i += 1) await ratelimit.noteLoginFailure(user)
  assert.equal(await ratelimit.loginLockSeconds(user), 0, '4 次仍未锁定')
  await ratelimit.noteLoginFailure(user)
  const locked = await ratelimit.loginLockSeconds(user)
  assert.ok(locked > 0 && locked <= 600, `锁定秒数应在 1..600，实际 ${locked}`)
  await ratelimit.clearLoginFailures(user)
  assert.equal(await ratelimit.loginLockSeconds(user), 0)
})

test('限流：auth-send 每分钟 10 次，第 11 次 429；本机回环放行', async () => {
  // 直连：socket 地址就是客户端地址，转发头一律不信
  const direct = (ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36') => ({
    socket: { remoteAddress: '203.0.113.9' }, headers: { 'user-agent': ua },
  })
  for (let i = 0; i < 10; i += 1) {
    const result = await ratelimit.inspect(direct(), '/api/auth/email/send', 'POST')
    assert.equal(result.blocked, false, `第 ${i + 1} 次应通过`)
  }
  const blocked = await ratelimit.inspect(direct(), '/api/auth/email/send', 'POST')
  assert.equal(blocked.blocked, true)
  assert.equal(blocked.status, 429)
  assert.ok(blocked.retryAfter > 0)

  // 本机直连回环（健康检查/内部脚本）完全放行
  const loop = await ratelimit.inspect({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }, '/api/auth/email/send', 'POST')
  assert.equal(loop.blocked, false, '本机回环应放行')
})

test('限流：伪造 X-Forwarded-For 不能绕过（只信反代来源的 x-real-ip）', async () => {
  // 公网直连 + 伪造回环 XFF：应仍按 socket 地址限流，且不被当作回环放行
  const forged = { socket: { remoteAddress: '198.51.100.66' }, headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '127.0.0.1' } }
  for (let i = 0; i < 10; i += 1) await ratelimit.inspect(forged, '/api/auth/email/send', 'POST')
  const blocked = await ratelimit.inspect(forged, '/api/auth/email/send', 'POST')
  assert.equal(blocked.blocked, true)

  // 经 nginx（socket 回环）时信 x-real-ip
  const viaProxy = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'user-agent': 'Mozilla/5.0', 'x-real-ip': '203.0.113.77' } }
  const first = await ratelimit.inspect(viaProxy, '/api/auth/email/send', 'POST')
  assert.equal(first.blocked, false)
})

test('限流：脚本 UA 直接 403', async () => {
  const result = await ratelimit.inspect({ headers: { 'user-agent': 'python-requests/2.31', 'x-forwarded-for': '198.51.100.7' } }, '/api/home', 'GET')
  assert.equal(result.blocked, true)
  assert.equal(result.status, 403)
  assert.equal(result.reason, 'automated_access_denied')
})

test('播放签名：默认 300 秒、绑 UA、篡改 UA 或签名失效', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
  const link = entitlements.secureLink('/media/hls/1/index.m3u8', undefined, ua)
  assert.ok(link.expires - Math.floor(Date.now() / 1000) > 280)
  assert.equal(entitlements.verifyLink('/media/hls/1/index.m3u8', link.sign, link.expires, ua), true)
  assert.equal(entitlements.verifyLink('/media/hls/1/index.m3u8', link.sign, link.expires, 'curl/8.4.0'), false)
  // 签名作用域是「整集目录」：同集其它码率列表与分片都可用，跨集不可用
  assert.equal(entitlements.verifyLink('/media/hls/1/720p/index.m3u8', link.sign, link.expires, ua), true)
  assert.equal(entitlements.verifyLink('/media/hls/1/720p/seg_000.ts', link.sign, link.expires, ua), true)
  assert.equal(entitlements.verifyLink('/media/hls/2/index.m3u8', link.sign, link.expires, ua), false)
  const shortLived = entitlements.secureLink('/media/hls/2/index.m3u8', 120, ua)
  assert.ok(shortLived.expires - Math.floor(Date.now() / 1000) <= 120)
})

test('验证码：默认不返回明文（仅 MH_OTP_TEST=1 时返回 testCode）', async () => {
  delete process.env.MH_OTP_TEST
  await assert.rejects(
    () => otp.sendCode({ email: `nodev${Date.now()}@example.com`, purpose: 'login', ip: '203.0.113.44' }),
    (error) => {
      assert.equal(error.code, 'mail_not_configured')
      assert.equal(error.status, 503)
      return true
    },
  )
  process.env.MH_OTP_TEST = '1'
  const sent = await otp.sendCode({ email: `hook${Date.now()}@example.com`, purpose: 'login', ip: '203.0.113.45' })
  assert.equal(sent.devCode, undefined)
  assert.match(sent.testCode, /^\d{6}$/)
  delete process.env.MH_OTP_TEST
})

test('后台代发登录码：管理员可签发一次性验证码，且带审计信息', async () => {
  const email = `assist${Date.now()}@example.com`
  const issued = await otp.issueAssistCode(email, { operator: 'admin' })
  assert.match(issued.code, /^\d{6}$/)
  assert.equal(issued.expiresIn, 300)
  const row = db.prepare('SELECT user_agent FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email)
  assert.equal(row.user_agent, 'admin-assist:admin')
  await otp.verifyCode({ email, purpose: 'login', code: issued.code })
})
