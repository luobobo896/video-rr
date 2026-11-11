import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-landing-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'

let db
let api
let analytics

function fakeResponse() {
  const headers = new Map()
  return {
    status: 0,
    rawBody: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)) },
    getHeader(name) { return headers.get(String(name).toLowerCase()) },
    writeHead(status) { this.status = status },
    end(body = '') { this.rawBody = String(body) },
  }
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  api = await import('../server/api-public.mjs')
  analytics = await import('../server/analytics.mjs')
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('未登录可读取公开会员套餐', async () => {
  const res = fakeResponse()
  const req = { method: 'GET', headers: { 'user-agent': 'node-test' }, socket: { remoteAddress: '127.0.0.1' } }
  await api.handlePublic('/api/plans', new URL('http://localhost/api/plans'), req, res)
  const body = JSON.parse(res.rawBody)
  assert.equal(res.status, 200)
  assert.equal(body.code, '0000')
  assert.ok(body.data.plans.length >= 1)
})

test('落地页事件在白名单内', () => {
  assert.equal(analytics.isClientTrackType('lp_view'), true)
  assert.equal(analytics.isClientTrackType('lp_cta_click'), true)
})
