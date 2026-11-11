import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCodeEmail, buildPasswordResetEmail, normalizeCodeTemplate } from '../server/email-template.mjs'

test('验证码邮件：大号验证码、品牌模板和纯文本兜底', () => {
  const mail = buildCodeEmail({
    to: 'user@example.com',
    code: '123456',
    purpose: 'login',
    template: { brand: '测试影巢', accent: '#3366ff', title: '{{action}}验证码' },
  })
  assert.match(mail.subject, /测试影巢/)
  assert.match(mail.subject, /登录/)
  assert.match(mail.html, /123456/)
  assert.match(mail.html, /font-size:38px/)
  assert.match(mail.html, /#3366ff/)
  assert.match(mail.text, /123456/)
})

test('密码重置邮件：临时密码使用独立模板，不泄露到主题', () => {
  const mail = buildPasswordResetEmail({ to: 'user@example.com', password: 'TempPass123456', template: { brand: '影巢' } })
  assert.equal(mail.subject, '影巢 · 密码已重置')
  assert.match(mail.html, /TempPass123456/)
  assert.doesNotMatch(mail.subject, /TempPass/)
  assert.equal(normalizeCodeTemplate({ accent: 'javascript:alert(1)' }).accent, '#ff3d6e')
})
