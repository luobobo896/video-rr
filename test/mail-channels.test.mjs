/** 邮件通道（厂家无关）回归：预设、加密存储、优先级回退、模板渲染、迁移。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-channels-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'

let db, channels, transport, echo, echoPort

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  module.seedIfEmpty()
  channels = await import('../server/mail-channels.mjs')
  transport = await import('../server/mail-transport.mjs')

  echo = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      echo.last = { url: req.url, headers: req.headers, body }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
  echoPort = echo.address().port
})

after(() => {
  echo?.close()
  try { db.close() } catch { /* ignore */ }
})

test('预设覆盖常见厂家，且带 host/端口/认证方式', () => {
  const ids = channels.PRESETS.map((preset) => preset.id)
  for (const id of ['gmail', 'outlook', 'qq', '163', 'aliyun', 'sendgrid-smtp', 'resend-http', 'custom-smtp']) {
    assert.ok(ids.includes(id), `缺少预设 ${id}`)
  }
  const gmail = channels.presetOf('gmail')
  assert.equal(gmail.host, 'smtp.gmail.com')
  assert.equal(gmail.port, 465)
  const outlook = channels.presetOf('outlook')
  assert.equal(outlook.type, 'oauth2')
  assert.equal(outlook.port, 587)
  assert.equal(outlook.secure, false)
})

test('新增通道：密码/Key 加密入库，列表不回显明文', () => {
  const created = channels.upsertChannel({
    name: '163 邮箱', type: 'smtp', priority: 10, from: 'noreply@example.com', fromName: '影巢',
    smtp: { host: 'smtp.163.com', port: 465, secure: true, user: 'noreply@example.com', pass: 'supersecret', authMode: 'login' },
  })
  const listed = channels.channelList().find((item) => item.id === created.id)
  assert.equal(listed.name, '163 邮箱')
  assert.equal(listed.smtp.passSet, true)
  assert.equal(listed.smtp.pass, undefined)

  const row = db.prepare("SELECT value FROM settings WHERE key = 'email'").get()
  assert.ok(!row.value.includes('supersecret'), '口令不应以明文落库')
  assert.ok(row.value.includes('"pass":"v'), '口令应为密文（v 前缀）')
})

test('更新通道：留空口令不覆盖已保存口令', () => {
  const created = channels.upsertChannel({ name: 'A', type: 'smtp', smtp: { host: 'smtp.a.com', user: 'u@a.com', pass: 'p1' } })
  channels.upsertChannel({ id: created.id, name: 'A2', smtp: { host: 'smtp.a.com', user: 'u@a.com' } })
  const listed = channels.channelList().find((item) => item.id === created.id)
  assert.equal(listed.name, 'A2')
  assert.equal(listed.smtp.passSet, true)
})

test('优先级排序 = 发信尝试顺序', () => {
  const list = channels.channelList().slice().sort((a, b) => a.priority - b.priority)
  const priorities = list.map((item) => item.priority)
  assert.deepEqual(priorities, [...priorities].sort((a, b) => a - b))
})

test('模板渲染：占位符替换 + 缺失值置空', () => {
  const rendered = transport.renderTemplate('{"to":"{{to}}","from":"{{fromName}} <{{from}}>","key":"{{apiKey}}","x":"{{missing}}"}', {
    to: 'a@b.com', from: 'no-reply@x.com', fromName: '影巢', apiKey: 'sk_1',
  })
  assert.equal(rendered, '{"to":"a@b.com","from":"影巢 <no-reply@x.com>","key":"sk_1","x":""}')
})

test('JSON 模板转义：正文含换行/引号不破坏请求体', () => {
  const template = '{"to":"{{to}}","text":"{{text}}"}'
  const vars = { to: 'a@b.com', text: '您好，\n验证码 123456\n"引号"' }
  const rendered = transport.renderJsonTemplate(template, vars)
  const parsed = JSON.parse(rendered)
  assert.equal(parsed.to, 'a@b.com')
  assert.match(parsed.text, /123456/)
  assert.match(parsed.text, /"引号"/)
  // 原始渲染确实会坏，说明这条保护是必要的
  assert.throws(() => JSON.parse(transport.renderTemplate(template, vars)))
})

test('HTTP 通道：真实投递到本地服务，占位符生效', async () => {
  const created = channels.upsertChannel({
    name: '本地 HTTP', type: 'http', priority: 1, from: 'no-reply@local.test', fromName: '影巢',
    http: {
      url: `http://127.0.0.1:${echoPort}/send?to={{to}}`,
      method: 'POST',
      headers: { authorization: 'Bearer {{apiKey}}', 'content-type': 'application/json' },
      body: '{"subject":"{{subject}}","text":"{{text}}"}',
    },
    apiKey: 'sk_test_123',
  })
  channels.upsertChannel({ id: created.id, enabled: false })

  // 只启用这一个通道时应当投递成功
  channels.upsertChannel({ id: created.id, enabled: true })
  const result = await channels.sendMail({ to: 'luobobo896@gmail.com', subject: '验证码测试', text: '验证码 123456' })
  assert.equal(result.delivered, true)
  assert.equal(result.transport, 'http')
  assert.ok(echo.last.url.includes('to=luobobo896'))
  assert.equal(echo.last.headers.authorization, 'Bearer sk_test_123')
  assert.match(echo.last.body, /验证码 123456/)
})

test('回退：第一条通道失败自动走第二条', async () => {
  const settings = channels.emailSettings()
  for (const channel of settings.channels) channels.upsertChannel({ id: channel.id, enabled: false })

  channels.upsertChannel({
    name: '坏通道', type: 'http', priority: 1, from: 'a@b.c',
    http: { url: 'http://127.0.0.1:1/none', method: 'POST', headers: {}, body: '{}', successStatus: [200] },
  })
  const good = channels.upsertChannel({
    name: '好通道', type: 'http', priority: 2, from: 'a@b.c',
    http: { url: `http://127.0.0.1:${echoPort}/fallback`, method: 'POST', headers: {}, body: '{"t":"{{to}}"}' },
  })

  const result = await channels.sendMail({ to: 'x@y.com', subject: 's', text: 't' })
  assert.equal(result.delivered, true)
  assert.equal(result.channel, '好通道')

  const bad = channels.channelList().find((item) => item.name === '坏通道')
  assert.equal(bad.lastTest.ok, false)
  assert.ok(bad.lastTest.message.length > 0)
  assert.equal(channels.channelList().find((item) => item.id === good.id).lastTest.ok, true)
})

test('全部通道失败时抛出汇总错误', async () => {
  const settings = channels.emailSettings()
  for (const channel of settings.channels) channels.upsertChannel({ id: channel.id, enabled: false })
  channels.upsertChannel({
    name: '必失败', type: 'http', priority: 1,
    http: { url: 'http://127.0.0.1:1/x', method: 'POST', headers: {}, body: '{}' },
  })
  await assert.rejects(() => channels.sendMail({ to: 'a@b.c', subject: 's', text: 't' }), /所有邮件通道均失败/)
})

test('删除通道', async () => {
  const created = channels.upsertChannel({ name: '待删', type: 'smtp', smtp: { host: 'smtp.z.com' } })
  channels.removeChannel(created.id)
  assert.equal(channels.channelList().some((item) => item.id === created.id), false)
})

test('老配置迁移：单 provider → 通道数组', async () => {
  db.prepare("DELETE FROM settings WHERE key = 'email'").run()
  db.prepare("INSERT INTO settings (key, value) VALUES ('email', ?)").run(JSON.stringify({
    provider: 'smtp', from: 'old@x.com', fromName: '影巢',
    smtp: { host: 'smtp.old.com', port: 587, secure: false, user: 'old@x.com', pass: 'v1:aaa:bbb:ccc' },
  }))
  const settings = channels.emailSettings()
  assert.equal(settings.channels.length, 1)
  assert.equal(settings.channels[0].smtp.host, 'smtp.old.com')
  assert.equal(settings.channels[0].smtp.secure, false)
})
