import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-remote-expiry-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_LINK_SECRET = 'test-link-secret-0123456789'
// 续期要开浏览器：测试环境没有 flock/chromium，spawn 会立刻报错退出，这里把等待压到最短
process.env.MH_REFRESH_TIMEOUT_MS = '1'
process.env.MH_PLAY_REFRESH_WAIT_MS = '1'

let db
let api
let freshDramaId
let expiredDramaId
let localDramaId

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

async function play(dramaId, episodeNo = 1) {
  const res = fakeResponse()
  const req = {
    method: 'GET',
    headers: { 'user-agent': 'node-test', 'x-mh-visitor': 'visitor-remote-expiry' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await api.handlePublic(`/api/play/${dramaId}/${episodeNo}`, new URL(`http://localhost/api/play/${dramaId}/${episodeNo}?trial=1`), req, res)
  return { status: res.status, ...JSON.parse(res.rawBody) }
}

/** 造一条 jable 直链：expiresIn 秒后过期（负数即已过期）。 */
function hlsUrl(secondsFromNow) {
  const exp = Math.floor(Date.now() / 1000) + secondsFromNow
  return `https://mock-source.alonestreaming.com/hls/testtoken/${exp}/62000/62185/62185.m3u8`
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  api = await import('../server/api-public.mjs')

  expiredDramaId = Number(db.prepare("INSERT INTO dramas (title, category, status, sub_title) VALUES ('签名过期测试', 'MOVIE', 'published', 'TEST-001 · 演员')").run().lastInsertRowid)
  db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, status, remote_url, remote_referer)
    VALUES (?, 1, '正片', 60, 'ready', ?, 'https://jable.tv/')`).run(expiredDramaId, hlsUrl(-600))
  db.prepare("INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'free', 1, 0, 0, 'single', 72)").run(expiredDramaId)

  // 还没过期、且离过期不到 10 分钟的直链：点开就该立刻开播，一次都不许刷
  freshDramaId = Number(db.prepare(`INSERT INTO dramas (title, category, status, sub_title) VALUES ('即将过期但还活着', 'MOVIE', 'published', 'TEST-002 · 演员')`).run().lastInsertRowid)
  db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, status, remote_url, remote_referer) VALUES (?, 1, '正片', 60, 'ready', ?, 'https://jable.tv/')`).run(freshDramaId, hlsUrl(120))
  db.prepare(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'free', 1, 0, 0, 'single', 72)`).run(freshDramaId)

  // 本地引用式片源（huangguo:// 这种）解析不出签名时间，永远不该被判过期
  localDramaId = Number(db.prepare("INSERT INTO dramas (title, category, status, sub_title) VALUES ('本地引用测试', 'MOVIE', 'published', 'HG-002 · 演员')").run().lastInsertRowid)
  db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, status, remote_url, remote_referer)
    VALUES (?, 1, '正片', 60, 'ready', 'huangguo://12988/1', 'https://huangguo.example/')`).run(localDramaId)
  db.prepare("INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'free', 1, 0, 0, 'single', 72)").run(localDramaId)
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('直链签名过期：播放接口回 409 且 reason 是 source_link_expired（前端据此倒计时重试）', async () => {
  const result = await play(expiredDramaId)
  assert.equal(result.status, 409, result.msg)
  assert.equal(result.code, '0409')
  assert.equal(result.data.reason, 'source_link_expired')
  // 换票通常 1～3 秒，不再让用户干等 30 秒：前端几秒后就自动重试
  assert.ok(result.data.retryAfterSeconds >= 3 && result.data.retryAfterSeconds <= 15, `retryAfterSeconds=${result.data.retryAfterSeconds}`)
})

test('没过期的直链点开就播：不触发任何续期', async () => {
  const { refreshStats } = await import('../server/jable-refresh.mjs')
  const before = refreshStats().attempts
  const started = Date.now()
  const result = await play(freshDramaId)
  const cost = Date.now() - started
  assert.equal(result.status, 200, result.msg)
  assert.ok(result.data.hls, '应返回可播路径')
  assert.equal(refreshStats().attempts, before, '没过期不该尝试换票')
  assert.ok(cost < 500, `不该为没到期的票等待换票，耗时 ${cost}ms`)
})

test('解析不出签名时间的本地引用片源不算过期：播放接口照常 200', async () => {
  const result = await play(localDramaId)
  assert.equal(result.status, 200, result.msg)
  assert.ok(result.data.hls, '应返回可播路径')
})

test('片源列表里的 stale 只对签名过期的直链亮起', async () => {
  const { staleOf } = await import('../server/jable-refresh.mjs')
  assert.equal(staleOf(hlsUrl(-600)), true)
  assert.equal(staleOf(hlsUrl(600)), false)
  assert.equal(staleOf('huangguo://12988/1'), false)
})
