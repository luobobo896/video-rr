/** 邮箱验证码认证 + 改密 + 换邮箱 + 个人资料 回归测试。 */
import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-otp-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_OTP_SECRET = 'otp-secret'
process.env.MH_EMAIL_DEV = '1'

let db, otp, auth

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  module.seedIfEmpty()
  module.ensureUserSchema()
  otp = await import('../server/otp.mjs')
  auth = await import('../server/auth.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

let counter = 0
const newEmail = () => `user${Date.now()}${counter++}@example.com`

test('发码：6 位数字、5 分钟有效、60 秒冷却', async () => {
  const email = newEmail()
  const sent = await otp.sendCode({ email, purpose: 'login', ip: '1.1.1.1' })
  assert.match(sent.devCode, /^\d{6}$/)
  assert.equal(sent.expiresIn, 300)
  assert.equal(sent.resendAfter, 60)

  await assert.rejects(() => otp.sendCode({ email, purpose: 'login', ip: '1.1.1.1' }), (error) => {
    assert.equal(error.code, 'send_too_frequent')
    assert.ok(error.extra.retryAfter > 0 && error.extra.retryAfter <= 60)
    return true
  })
})

test('邮箱格式校验', async () => {
  await assert.rejects(() => otp.sendCode({ email: 'not-an-email', purpose: 'login' }), /邮箱格式不正确/)
})

test('验证码校验：正确通过、错误提示剩余次数、3 次后作废', async () => {
  const email = newEmail()
  const sent = await otp.sendCode({ email, purpose: 'login' })
  const wrong = sent.devCode === '000000' ? '111111' : '000000'

  // 错一次 → 还剩 2 次
  await assert.rejects(async () => otp.verifyCode({ email, purpose: 'login', code: wrong }), (error) => {
    assert.equal(error.code, 'code_invalid')
    assert.match(error.message, /还可尝试 2 次/)
    return true
  })
  // 再错 → 还剩 1 次
  await assert.rejects(async () => otp.verifyCode({ email, purpose: 'login', code: wrong }), (error) => {
    assert.match(error.message, /还可尝试 1 次/)
    return true
  })
  // 第三次错 → 作废
  await assert.rejects(async () => otp.verifyCode({ email, purpose: 'login', code: wrong }), (error) => {
    assert.equal(error.code, 'code_locked')
    return true
  })
  // 即使输对也不能用了（已被消费）
  await assert.rejects(async () => otp.verifyCode({ email, purpose: 'login', code: sent.devCode }), /验证码已失效/)
})

test('验证码过期：返回 code_expired', async () => {
  const email = newEmail()
  const sent = await otp.sendCode({ email, purpose: 'login' })
  db.prepare("UPDATE email_codes SET expires_at = datetime('now','-1 second') WHERE email = ?").run(email)
  await assert.rejects(async () => otp.verifyCode({ email, purpose: 'login', code: sent.devCode }), (error) => {
    assert.equal(error.code, 'code_expired')
    assert.match(error.message, /过期/)
    return true
  })
})

test('每日上限 20 条', async () => {
  const email = newEmail()
  const today = new Date().toISOString().slice(0, 10)
  const insert = db.prepare('INSERT INTO email_send_log (email, purpose, ip, sent_date, created_at) VALUES (?, ?, ?, ?, datetime(\'now\',\'-2 hours\'))')
  for (let i = 0; i < 20; i++) insert.run(email, 'login', '9.9.9.9', today)
  await assert.rejects(() => otp.sendCode({ email, purpose: 'login' }), (error) => {
    assert.equal(error.code, 'daily_limit')
    return true
  })
})

test('邮箱登录/注册一体：首次建号，再次登录不重复建号', async () => {
  const email = newEmail()
  const first = await otp.sendCode({ email, purpose: 'login' })
  const login1 = (() => { otp.verifyCode({ email, purpose: 'login', code: first.devCode }); return auth.loginByEmail(email) })()
  assert.equal(login1.created, true)
  assert.equal(login1.user.email, email)
  assert.ok(login1.token)

  db.prepare("UPDATE email_send_log SET created_at = datetime('now','-2 minutes') WHERE email = ?").run(email)
  const second = await otp.sendCode({ email, purpose: 'login' })
  otp.verifyCode({ email, purpose: 'login', code: second.devCode })
  const login2 = auth.loginByEmail(email)
  assert.equal(login2.created, false)
  assert.equal(login2.user.id, login1.user.id)
})

test('密码强度：长度/字母/数字', () => {
  assert.equal(auth.checkPasswordStrength('short1').ok, false)
  assert.equal(auth.checkPasswordStrength('passwordonly').ok, false)
  assert.equal(auth.checkPasswordStrength('12345678').ok, false)
  assert.equal(auth.checkPasswordStrength('abcd1234').ok, true)
})

test('改密流程：验证码通过后写入新口令', async () => {
  const email = newEmail()
  const { user } = (() => { auth.loginByEmail(email); return { user: db.prepare('SELECT * FROM users WHERE email = ?').get(email) } })()
  const sent = await otp.sendCode({ email, purpose: 'change_password' })
  otp.verifyCode({ email, purpose: 'change_password', code: sent.devCode })
  auth.setUserPassword(user.id, 'abc12345')
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  assert.ok(updated.password_hash)
  assert.equal(auth.hasPassword(user.id), true)
})

test('改密：弱口令被拒', async () => {
  const email = newEmail()
  auth.loginByEmail(email)
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  assert.throws(() => auth.setUserPassword(user.id, 'weak'), /至少 8 位/)
})

test('换邮箱：占用检测 + 成功后邮箱更新', async () => {
  const emailA = newEmail()
  const emailB = newEmail()
  auth.loginByEmail(emailA)
  auth.loginByEmail(emailB)
  const userA = db.prepare('SELECT * FROM users WHERE email = ?').get(emailA)
  assert.throws(() => auth.changeUserEmail(userA.id, emailB), /已被其他账号使用/)

  const emailC = newEmail()
  const updated = auth.changeUserEmail(userA.id, emailC)
  assert.equal(updated.email, emailC)
})

test('资料完善：昵称/生日/性别/简介校验', () => {
  const email = newEmail()
  auth.loginByEmail(email)
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)

  const updated = auth.updateProfile(user.id, { nickname: '影迷小王', birthday: '1998-05-20', gender: 'male', bio: '爱看剧' })
  assert.equal(updated.nickname, '影迷小王')
  assert.equal(updated.birthday, '1998-05-20')

  assert.throws(() => auth.updateProfile(user.id, { nickname: 'a' }), /2–20/)
  assert.throws(() => auth.updateProfile(user.id, { birthday: '1998/05/20' }), /YYYY-MM-DD/)
  assert.throws(() => auth.updateProfile(user.id, { gender: 'unknown' }), /性别取值/)
  assert.throws(() => auth.updateProfile(user.id, { avatar: 'http://evil/x.png' }), /头像地址/)
  assert.throws(() => auth.updateProfile(user.id, { bio: 'x'.repeat(121) }), /120/)
})

test('清理：过期一天的验证码被删除', async () => {
  const email = newEmail()
  await otp.sendCode({ email, purpose: 'login' })
  db.prepare("UPDATE email_codes SET expires_at = datetime('now','-2 day') WHERE email = ?").run(email)
  otp.cleanupCodes()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email = ?').get(email).n, 0)
})
