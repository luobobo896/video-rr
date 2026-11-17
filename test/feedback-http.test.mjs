import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'mh-feedback-http-'))
process.env.MH_DB = join(root, 'app.db')
process.env.MH_SECRET = 'feedback-http'
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'

const dbModule = await import('../server/db.mjs')
const db = dbModule.db
dbModule.seedIfEmpty()
const auth = await import('../server/auth.mjs')
const adminApi = await import('../server/api-admin.mjs')
const { handlePublic } = await import('../server/api-public.mjs')

let server
let base

const makeRole = (code, name, codes) => {
  const info = db.prepare('INSERT INTO roles (code, name, is_system) VALUES (?, ?, 0)').run(code, name)
  const roleId = Number(info.lastInsertRowid)
  const link = db.prepare('INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
  for (const item of codes) link.run(roleId, item)
  return roleId
}

const makeAdmin = (username, roleIds) => {
  const salt = 'fbsalt'
  const hash = auth.hashPassword('Passw0rd!2345', salt)
  const info = db.prepare(`INSERT INTO admins (username, password_hash, salt, display_name, status, must_change_password)
    VALUES (?, ?, ?, ?, 'active', 0)`).run(username, hash, salt, username)
  const adminId = Number(info.lastInsertRowid)
  const link = db.prepare('INSERT INTO admin_roles (admin_id, role_id) VALUES (?, ?)')
  for (const roleId of roleIds) link.run(adminId, roleId)
  return { id: adminId, token: auth.issueToken(adminId, 'admin').token }
}

const callAdmin = async (method, path, { body, token } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  // 后台统一回 { code, msg, data }：把业务字段摊平，断言直接读 result.total / result.feedback
  const flat = payload.data && typeof payload.data === 'object' ? payload.data : {}
  // 业务字段里也可能有 status（工单状态），HTTP 状态单独放 httpStatus，别互相覆盖
  return { httpStatus: response.status, code: payload.code, msg: payload.msg, data: payload.data, ...flat }
}

let rootActor
let readerActor
let refundOnlyActor
let userId
let orderId
let feedbackId

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname.startsWith('/api/')) {
      await handlePublic(url.pathname, url, req, res)
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = {}
    if (raw) {
      try { body = JSON.parse(raw) } catch { body = {} }
    }
    await adminApi.handleAdmin(url.pathname, url, req, res, body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  const seeded = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(seeded.id)
  rootActor = { id: seeded.id, token: auth.issueToken(seeded.id, 'admin').token }
  // cs 客服只给读权限：能看列表，不能回复/退款
  readerActor = makeAdmin('cs-reader', [makeRole('cs-reader-role', '客服只读', ['cs.feedback', 'cs.feedback.read'])])
  // 只有退款权限的财务：能发起退款，但读不到工单列表
  refundOnlyActor = makeAdmin('finance-refund', [makeRole('finance-refund-role', '财务退款', ['cs.feedback.refund', 'finance.refund.create'])])

  const userInfo = db.prepare("INSERT INTO users (phone, password_hash, nickname, created_at) VALUES ('13900000001', 'x', '反馈用户', '2026-11-01 00:00:00')").run()
  userId = Number(userInfo.lastInsertRowid)
  const orderInfo = db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, status, paid_at, created_at)
    VALUES ('MH20261117000009', ?, 'single', 29.9, 'paid', '2026-11-16 03:00:00', '2026-11-16 03:00:00')`).run(userId)
  orderId = Number(orderInfo.lastInsertRowid)
})

after(() => {
  server?.close()
  // sqlite 句柄还没释放时 Windows 会报 EPERM，临时目录清不掉也不算测试失败
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('C 端提交反馈走 POST /api/feedback，返回工单号', async () => {
  const response = await fetch(`${base}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: 'payment', content: '付款后会员没到账，请处理', contact: '13900000001', orderId }),
  })
  const payload = await response.json()
  assert.equal(response.status, 200)
  const created = payload.data?.feedback ?? payload.data
  assert.match(String(created.ticket_no ?? created.ticketNo), /^FB\d{8}-\d{4}$/)
  feedbackId = created.id

  const list = await callAdmin('GET', '/admin/api/feedbacks?range=7d', { token: rootActor.token })
  assert.equal(list.httpStatus, 200)
  assert.equal(list.total >= 1, true)
})

test('后台接口按权限分级：只读客服能看列表，不能回复、不能退款', async () => {
  const readable = await callAdmin('GET', '/admin/api/feedbacks?range=7d', { token: readerActor.token })
  assert.equal(readable.httpStatus, 200)

  const denied = await callAdmin('POST', `/admin/api/feedbacks/${feedbackId}/reply`, {
    token: readerActor.token, body: { reply: '我们马上处理' },
  })
  assert.equal(denied.httpStatus, 403)

  const deniedRefund = await callAdmin('POST', `/admin/api/feedbacks/${feedbackId}/refund`, {
    token: readerActor.token, body: { reason: '客服想退钱' },
  })
  assert.equal(deniedRefund.httpStatus, 403)

  const statsDenied = await callAdmin('GET', '/admin/api/feedbacks/stats?range=today', { token: readerActor.token })
  assert.equal(statsDenied.httpStatus, 200, 'cs.feedback.read 也能看统计')
})

test('统计接口支持今天/昨天/近 7 天/近 30 天四个区间', async () => {
  for (const range of ['today', 'yesterday', '7d', '30d']) {
    const result = await callAdmin('GET', `/admin/api/feedbacks/stats?range=${range}`, { token: rootActor.token })
    assert.equal(result.httpStatus, 200, `${range} 应返回 200`)
    assert.equal(result.range, range)
    assert.ok(result.trend.length > 0)
    assert.ok('total' in result || 'totals' in result)
  }
  const dirty = await callAdmin('GET', '/admin/api/feedbacks/stats?range=abc', { token: rootActor.token })
  assert.equal(dirty.range, '7d')
})

test('回复与状态流转走后台接口，退款需要双重权限', async () => {
  const replied = await callAdmin('POST', `/admin/api/feedbacks/${feedbackId}/reply`, {
    token: rootActor.token, body: { reply: '已补发会员，请刷新查看' },
  })
  assert.equal(replied.httpStatus, 200)
  assert.equal(replied.status, 'replied')

  const status = await callAdmin('POST', `/admin/api/feedbacks/${feedbackId}/status`, {
    token: rootActor.token, body: { status: 'processing', note: '等待财务复核' },
  })
  assert.equal(status.httpStatus, 200)
  assert.equal(status.status, 'processing')

  // 只有 cs.feedback.refund 没有 feedback.read 的财务：读详情被拒，退款仍可发起
  const detail = await callAdmin('GET', `/admin/api/feedbacks/${feedbackId}`, { token: refundOnlyActor.token })
  assert.equal(detail.httpStatus, 403)

  const refund = await callAdmin('POST', `/admin/api/feedbacks/${feedbackId}/refund`, {
    token: rootActor.token, body: { reason: '用户要求退款', amount: 10 },
  })
  assert.equal(refund.httpStatus, 200)
  assert.equal(Number(refund.refund.amount), 10)
  assert.equal(refund.feedback.refund_id, refund.refund.id)

  const again = await callAdmin('POST', `/admin/api/feedbacks/${feedbackId}/refund`, {
    token: rootActor.token, body: { reason: '再退一次试试' },
  })
  assert.equal(again.httpStatus, 409)
})




