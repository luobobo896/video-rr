/**
 * 成人短剧不出外层：后台建 PLAYLET 一律落成成人内容，外层筛选栏与列表不出现它。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-adult-visibility-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'

let db
let adminApi
let publicApi
let auth
let adminToken
let generalMovieId

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

async function callAdmin(method, path, body) {
  const res = fakeResponse()
  const req = {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'user-agent': 'node-test' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await adminApi.handleAdmin(path, new URL(`http://localhost${path}`), req, res, body)
  return { status: res.status, ...res.json() }
}

async function callPublic(path) {
  const res = fakeResponse()
  const url = new URL(`http://localhost${path}`)
  const req = {
    method: 'GET',
    headers: { 'user-agent': 'node-test', 'x-mh-lang': 'zh' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await publicApi.handlePublic(url.pathname, url, req, res)
  return { status: res.status, ...res.json() }
}

async function createDrama(title, { category = 'MOVIE', isAdult = false } = {}) {
  const result = await callAdmin('POST', '/admin/api/dramas', {
    title,
    category,
    contentType: category === 'PLAYLET' ? 'series' : 'movie',
    coverUrl: '/media/images/cover-general.jpg',
    description: title,
    year: 2026,
    releaseDate: '2026-01-02',
    area: '美国',
    score: 8.1,
    isAdult,
    status: 'published',
  })
  assert.equal(result.code, '0000', result.msg)
  return result.data.drama
}

const rowOf = (id) => db.prepare('SELECT category, is_adult FROM dramas WHERE id = ?').get(Number(id))

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  auth = await import('../server/auth.mjs')
  adminApi = await import('../server/api-admin.mjs')
  publicApi = await import('../server/api-public.mjs')
  const admin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(admin.id)
  adminToken = auth.issueToken(admin.id, 'admin').token
})

after(() => {
  try { db.close() } catch {}
  rmSync(dir, { recursive: true, force: true })
})

test('后台新建短剧即使不勾成人，也强制落成成人内容', async () => {
  const drama = await createDrama('测试短剧一', { category: 'PLAYLET' })
  const row = rowOf(drama.id)
  assert.equal(row.category, 'PLAYLET')
  assert.equal(row.is_adult, 1)
})

test('后台新建短剧显式传 isAdult=false 也仍然是成人内容', async () => {
  const drama = await createDrama('测试短剧二', { category: 'PLAYLET', isAdult: false })
  assert.equal(rowOf(drama.id).is_adult, 1)
})

test('普通电影按勾选落成人标记', async () => {
  const general = await createDrama('测试电影普通')
  generalMovieId = general.id
  assert.equal(rowOf(generalMovieId).is_adult, 0)

  const adult = await createDrama('测试电影成人', { isAdult: true })
  assert.equal(rowOf(adult.id).is_adult, 1)
})

test('把普通电影改成短剧分类，会同时升级成成人内容', async () => {
  const updated = await callAdmin('PUT', `/admin/api/dramas/${generalMovieId}`, { category: 'PLAYLET' })
  assert.equal(updated.code, '0000', updated.msg)
  const row = rowOf(generalMovieId)
  assert.equal(row.category, 'PLAYLET')
  assert.equal(row.is_adult, 1)
})

test('外层分类接口不暴露短剧频道，也不列成人内容', async () => {
  const result = await callPublic('/api/category')
  assert.equal(result.status, 200)
  const channels = result.data.facets.channels.map((row) => row.value)
  assert.ok(!channels.includes('PLAYLET'), '外层筛选栏不应出现短剧频道')
  for (const row of result.data.facets.channels) {
    if (row.value === 'ALL') continue
    assert.ok(row.count > 0, `外层不该出现 0 计数的频道：${row.value}`)
  }
  const titles = (result.data.list ?? []).map((item) => item.title)
  assert.ok(!titles.includes('测试短剧一'))
  assert.ok(!titles.includes('测试电影成人'))
})

test('成人专区（audience=adult）仍能看到短剧与成人标记内容', async () => {
  const result = await callPublic('/api/category?audience=adult&type=PLAYLET')
  assert.equal(result.status, 200)
  const titles = (result.data.list ?? []).map((item) => item.title)
  assert.ok(titles.includes('测试短剧一'), '成人专区应能看到短剧')
  const channels = result.data.facets.channels.map((row) => row.value)
  assert.ok(channels.includes('PLAYLET'), '成人专区的筛选栏要有短剧频道')
})

test('外层常量接口不下发短剧频道', async () => {
  const result = await callPublic('/api/constants')
  assert.equal(result.status, 200)
  const codes = result.data.categories.map((row) => row.code)
  assert.ok(!codes.includes('PLAYLET'), '外层分类枚举不应包含短剧')
  const channels = result.data.taxonomy.channels.map((row) => row.value)
  assert.ok(!channels.includes('PLAYLET'), '外层频道枚举不应包含短剧')
})

test('首页楼层用真实内容兜底，且不含成人短剧', async () => {
  const result = await callPublic('/api/home')
  assert.equal(result.status, 200)
  const sections = result.data.sections
  assert.ok(sections.length > 0, '运营没配楼层时也要有内容')
  const titles = sections.flatMap((section) => section.items.map((item) => item.title))
  assert.ok(titles.length > 0, '楼层要有内容')
  assert.ok(!titles.includes('测试短剧一'), '成人短剧不能出现在外层首页')
  assert.ok(!titles.includes('测试电影成人'), '成人电影不能出现在外层首页')
})

test('榜单没配置时用真实内容兜底，且不含成人短剧', async () => {
  const result = await callPublic('/api/rank?type=HOT')
  assert.equal(result.status, 200)
  assert.ok(result.data.items.length > 0, '没配榜单也要有内容')
  const titles = result.data.items.map((item) => item.title)
  assert.ok(!titles.includes('测试短剧一'), '成人短剧不能进外层榜单')
  assert.equal(result.data.items[0].rankNo, 1)
})

test('外层搜索搜不到成人短剧', async () => {
  const result = await callPublic('/api/search?keyword=测试短剧一')
  assert.equal(result.status, 200)
  assert.equal(result.data.total, 0)
})
