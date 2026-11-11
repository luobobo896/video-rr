import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-guest-trial-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_LINK_SECRET = 'test-link-secret-0123456789'

let db
let api
let dramaId

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

async function callTrial(visitorId = 'visitor-trial-test') {
  const res = fakeResponse()
  const path = `/api/play/${dramaId}/1?trial=1`
  const req = {
    method: 'GET',
    headers: { 'user-agent': 'node-test', ...(visitorId ? { 'x-mh-visitor': visitorId } : {}) },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await api.handlePublic('/api/play/' + dramaId + '/1', new URL(`http://localhost${path}`), req, res)
  return { status: res.status, ...JSON.parse(res.rawBody) }
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  api = await import('../server/api-public.mjs')
  dramaId = Number(db.prepare("INSERT INTO dramas (title, category, status) VALUES ('游客试看测试', 'TV', 'published')").run().lastInsertRowid)
  db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status, hls_path) VALUES (?, 1, '第 1 集', 60, 'ready', ?)")
    .run(dramaId, `/media/hls/${dramaId}/index.m3u8`)
  db.prepare("INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'paid', 0, 300, 6, 'single', 72)").run(dramaId)
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('游客试看 15 秒、复用剩余时长、到期后 24 小时内拦截', async () => {
  const first = await callTrial()
  assert.equal(first.status, 200, first.msg)
  assert.equal(first.data.source, 'trial')
  assert.equal(first.data.trialSeconds, 15)

  const active = await callTrial()
  assert.equal(active.status, 200, active.msg)
  assert.ok(active.data.trialSeconds >= 1 && active.data.trialSeconds <= 15)

  db.prepare("UPDATE guest_trials SET expires_at = datetime('now', '-1 second') WHERE visitor_id = 'visitor-trial-test'").run()
  const expired = await callTrial()
  assert.equal(expired.status, 403)
  assert.equal(expired.code, '0403')
  assert.match(expired.msg, /试看已结束/)
})

test('游客试看缺少访客标识时拒绝', async () => {
  const result = await callTrial('')
  assert.equal(result.status, 400)
  assert.match(result.msg, /访客/)
})
