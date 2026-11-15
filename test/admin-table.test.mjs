import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-admin-table-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'

let db, adminApi, adminToken

function fakeResponse() {
  const headers = new Map()
  return {
    headersSent: false,
    status: 0,
    rawBody: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)) },
    writeHead(status, values = {}) {
      this.status = status
      this.headersSent = true
      for (const [name, value] of Object.entries(values)) headers.set(String(name).toLowerCase(), String(value))
    },
    end(body = '') {
      this.rawBody = String(body)
      this.headersSent = true
    },
    json() { return JSON.parse(this.rawBody) },
  }
}

async function callAdmin(method, path) {
  const res = fakeResponse()
  const url = new URL(`http://localhost${path}`)
  const req = {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'user-agent': 'node-test' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await adminApi.handleAdmin(url.pathname, url, req, res, undefined)
  return { status: res.status, ...res.json() }
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  adminApi = await import('../server/api-admin.mjs')
  const auth = await import('../server/auth.mjs')
  const admin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(admin.id)
  adminToken = auth.issueToken(admin.id, 'admin').token
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('用户列表按关键词和状态筛选，并按白名单字段排序', async () => {
  const insert = db.prepare("INSERT INTO users (email, nickname, status) VALUES (?, ?, ?)")
  insert.run('tableaudit-b@example.test', 'Table Audit B', 'active')
  insert.run('tableaudit-a@example.test', 'Table Audit A', 'active')
  insert.run('tableaudit-c@example.test', 'Table Audit C', 'banned')

  const result = await callAdmin('GET', '/admin/api/users?q=tableaudit&status=active&sort=nickname&dir=asc&pageSize=10')
  assert.equal(result.code, '0000', result.msg)
  assert.equal(result.data.total, 2)
  assert.deepEqual(result.data.list.map((row) => row.nickname), ['Table Audit A', 'Table Audit B'])

  const clamped = await callAdmin('GET', '/admin/api/users?q=tableaudit&status=active&page=99&pageSize=10')
  assert.equal(clamped.data.page, 1)

  const invalid = await callAdmin('GET', '/admin/api/users?status=deleted')
  assert.equal(invalid.status, 400)
  assert.equal(invalid.code, '0400')

  const prototypeSort = await callAdmin('GET', '/admin/api/users?sort=constructor')
  assert.equal(prototypeSort.code, '0000')
})

test('订单列表按金额排序，筛选条件同时作用于分页总数', async () => {
  const userId = Number(db.prepare("INSERT INTO users (email, nickname) VALUES ('tableaudit-order@example.test', 'Table Audit Order')")
    .run().lastInsertRowid)
  const insert = db.prepare(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, status, created_at)
    VALUES (?, ?, 'subscription', ?, 'paid', datetime('now'))`)
  insert.run('TABLEAUDIT-ORDER-20', userId, 20)
  insert.run('TABLEAUDIT-ORDER-10', userId, 10)

  const result = await callAdmin('GET', '/admin/api/orders?q=TABLEAUDIT-ORDER&sort=amount_cny&dir=asc&pageSize=10')
  assert.equal(result.code, '0000', result.msg)
  assert.equal(result.data.total, 2)
  assert.deepEqual(result.data.list.map((row) => row.amount_cny), [10, 20])

  const clamped = await callAdmin('GET', '/admin/api/orders?q=TABLEAUDIT-ORDER&page=99&pageSize=10')
  assert.equal(clamped.data.page, 1)

  const prototypeSort = await callAdmin('GET', '/admin/api/orders?sort=constructor')
  assert.equal(prototypeSort.code, '0000')
})
