import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-status-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'

let db
let adminApi
let auth
let adminToken

function fakeResponse() {
  const headers = new Map()
  return {
    headersSent: false,
    status: 0,
    rawBody: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)) },
    getHeader(name) { return headers.get(String(name).toLowerCase()) },
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

async function callAdmin(target) {
  const res = fakeResponse()
  const req = {
    method: 'GET',
    headers: { authorization: `Bearer ${adminToken}`, 'user-agent': 'node-test' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  const url = new URL(`http://localhost${target}`)
  await adminApi.handleAdmin(url.pathname, url, req, res)
  if (process.env.MH_DEBUG_STATUS) console.log('DBG', target, res.status, res.rawBody.slice(0, 120))
  return { status: res.status, ...res.json() }
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  adminApi = await import('../server/api-admin.mjs')
  auth = await import('../server/auth.mjs')

  const admin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(admin.id)
  adminToken = auth.issueToken(admin.id, 'admin').token

  // 种子数据里剧集很多，先清空才谈得上"每种状态恰好 1 条"的断言
  db.prepare('DELETE FROM dramas').run()
  const insert = db.prepare(
    `INSERT INTO dramas (title, category, status, is_adult) VALUES (?, 'MOVIE', ?, 0)`
  )
  insert.run('状态回归-已上架', 'published')
  insert.run('状态回归-草稿', 'draft')
  insert.run('状态回归-已下架', 'offline')
  insert.run('状态回归-已隐藏', 'hidden')
})

after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('概览的草稿数只算 draft，被隐藏的片子不混进草稿', async () => {
  const result = await callAdmin('/admin/api/stats')
  assert.equal(result.code, '0000', result.msg)
  assert.equal(Number(result.data.publishedDramas), 1)
  assert.equal(Number(result.data.draftDramas), 1)
  assert.equal(Number(result.data.offlineDramas), 1)
  assert.equal(Number(result.data.hiddenDramas), 1)
})

test('剧集库按每种状态筛选都能查到对应条目', async () => {
  for (const [status, expected] of [['published', 1], ['draft', 1], ['offline', 1], ['hidden', 1]]) {
    const result = await callAdmin(`/admin/api/dramas?status=${status}&pageSize=50`)
    assert.equal(result.code, '0000', result.msg)
    assert.equal(Number(result.data.total), expected, `status=${status}`)
    assert.equal(result.data.list.every((row) => row.status === status), true, `status=${status} 混进了别的状态`)
  }
})

test('状态筛选项覆盖库中出现的每个状态，选项数量与列表一致', async () => {
  const result = await callAdmin('/admin/api/dramas?pageSize=5')
  const options = result.data.options.dramaStatus.map((item) => item.value)
  const counts = new Map(result.data.statusCounts.map((row) => [row.status, Number(row.n)]))
  for (const [status, n] of counts) {
    assert.equal(options.includes(status), true, `筛选项缺少 ${status}`)
    const filtered = await callAdmin(`/admin/api/dramas?status=${status}&pageSize=50`)
    assert.equal(Number(filtered.data.total), n, `${status} 的计数与筛选结果不一致`)
  }
})

test('未知状态不会悄悄变成“全部”', async () => {
  const result = await callAdmin('/admin/api/dramas?status=trashed&pageSize=5')
  assert.equal(result.code, '0000', result.msg)
  const total = Number(result.data.total)
  const all = await callAdmin('/admin/api/dramas?pageSize=5')
  assert.equal(total, Number(all.data.total), '未知状态应被忽略，返回全量')
})

test('「可播」按 HLS 或远程直链统计：只有 remote_url 的集也算可播', async () => {
  const drama = db.prepare("SELECT id FROM dramas WHERE title = '状态回归-已上架'").get()
  const before = await callAdmin('/admin/api/stats')
  const baseReady = Number(before.data.readyEpisodes)
  const baseList = await callAdmin('/admin/api/dramas?status=published&pageSize=50')
  const baseRow = baseList.data.list.find((item) => item.id === drama.id)
  const baseRowReady = Number(baseRow.readyEpisodes ?? 0)
  const baseRowEpisodes = Number(baseRow.episodeCount ?? 0)

  const insert = db.prepare(
    `INSERT INTO episodes (drama_id, no, status, hls_path, remote_url) VALUES (?, ?, 'ready', ?, ?)`
  )
  insert.run(drama.id, 901, '/media/hls/1/master.m3u8', null) // 本地 HLS 就绪
  insert.run(drama.id, 902, null, 'https://cdn.example.com/a.m3u8') // 只有远程直链（生产主形态）
  insert.run(drama.id, 903, null, null) // 两种源都没有 → 不可播

  const stats = await callAdmin('/admin/api/stats')
  assert.equal(stats.code, '0000', stats.msg)
  assert.equal(Number(stats.data.readyEpisodes) - baseReady, 2, '只有 hls_path 的旧口径会把远程直链算成不可播')

  const list = await callAdmin('/admin/api/dramas?status=published&pageSize=50')
  const row = list.data.list.find((item) => item.id === drama.id)
  assert.equal(Number(row.readyEpisodes) - baseRowReady, 2, '剧集库每行的可播数也要同一口径')
  assert.equal(Number(row.episodeCount) - baseRowEpisodes, 3)

  db.prepare('DELETE FROM episodes WHERE drama_id = ? AND no >= 901').run(drama.id)
})
