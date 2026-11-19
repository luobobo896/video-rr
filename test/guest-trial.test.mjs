import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-guest-trial-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_LINK_SECRET = 'test-link-secret-0123456789'
// 访客标识改为服务端签发的签名 Cookie 后，直接调 handlePublic 的单元测试没有 Cookie 罐：
// 只能用测试/本地调试专用的 x-mh-visitor 兜底（生产默认关闭，见 MH_ALLOW_VISITOR_HEADER）。
process.env.MH_ALLOW_VISITOR_HEADER = '1'

let db
let api
let dramaId
let freeDramaId

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
  return { status: res.status, setCookie: res.getHeader('set-cookie') ?? '', ...JSON.parse(res.rawBody) }
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
  freeDramaId = Number(db.prepare("INSERT INTO dramas (title, category, status) VALUES ('游客免费集测试', 'TV', 'published')").run().lastInsertRowid)
  db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status, hls_path) VALUES (?, 1, '第 1 集', 60, 'ready', ?)")
    .run(freeDramaId, `/media/hls/${freeDramaId}/index.m3u8`)
  db.prepare("INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'free', 1, 0, 0, 'single', 72)").run(freeDramaId)
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('游客同剧只发放一次 15 秒试看，发放时不计播放秒数', async () => {
  const first = await callTrial()
  assert.equal(first.status, 200, first.msg)
  assert.equal(first.data.source, 'trial')
  assert.equal(first.data.trialSeconds, 15)
  assert.equal(first.data.trialBudget.windows, 1)
  assert.equal(first.data.trialBudget.usedSeconds, 0)
  assert.equal(first.data.expiresIn, 75)

  const exhausted = await callTrial()
  assert.equal(exhausted.status, 402)
  assert.equal(exhausted.data.code, 'trial_exhausted')
  assert.ok(Number(exhausted.data.retryAfterSeconds) >= 4 && Number(exhausted.data.retryAfterSeconds) <= 15)
})

test('游客没有访客标识时由服务端签发签名 Cookie', async () => {
  const result = await callTrial('')
  assert.equal(result.status, 200, result.msg)
  assert.match(result.setCookie, /mh_visitor=/)
  assert.match(result.setCookie, /HttpOnly/i)
})

test('游客播放免费集不再查空用户观看进度', async () => {
  const res = fakeResponse()
  const req = {
    method: 'GET',
    headers: { 'user-agent': 'node-test', 'x-mh-visitor': 'visitor-free-test' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await api.handlePublic(`/api/play/${freeDramaId}/1`, new URL(`http://localhost/api/play/${freeDramaId}/1?trial=1`), req, res)
  const body = JSON.parse(res.rawBody)
  assert.equal(res.status, 200, body.msg)
  assert.equal(body.data.source, 'free')
  assert.equal(body.data.resumePosition, 0)
})
