import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-adult-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'

let db
let adminApi
let publicApi
let auth
let mediaImport
let posterWall
let adminToken
let userToken
let adultDramaId
let generalDramaId
let episodeId
let userId
let posterAdultId
let posterGeneralId
const posterCoverFile = join(process.cwd(), 'storage', 'images', 'cover-sintel.jpg')

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

async function callPublic(path, token = '', lang = 'zh') {
  const res = fakeResponse()
  const url = new URL(`http://localhost${path}`)
  const req = {
    method: 'GET',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'user-agent': 'node-test',
      'x-mh-lang': lang,
    },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await publicApi.handlePublic(url.pathname, url, req, res)
  return { status: res.status, ...res.json() }
}

async function createDrama(title, isAdult) {
  const result = await callAdmin('POST', '/admin/api/dramas', {
    title,
    category: 'MOVIE',
    contentType: 'movie',
    coverUrl: `/media/images/cover-${isAdult ? 'adult' : 'general'}.jpg`,
    description: title,
    year: 2026,
    area: '美国',
    score: 8.1,
    isAdult,
    status: 'published',
  })
  assert.equal(result.code, '0000', result.msg)
  return result.data.drama
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  adminApi = await import('../server/api-admin.mjs')
  publicApi = await import('../server/api-public.mjs')
  auth = await import('../server/auth.mjs')
  mediaImport = await import('../server/media-import.mjs')
  posterWall = await import('../server/poster-wall.mjs')

  const admin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(admin.id)
  adminToken = auth.issueToken(admin.id, 'admin').token

  userId = Number(db.prepare("INSERT INTO users (email, nickname) VALUES ('adult-test@example.com', 'adult-tester')").run().lastInsertRowid)
  userToken = auth.issueToken(userId, 'user').token

  const adult = await createDrama('成人独占测试片', true)
  adultDramaId = Number(adult.id)
  const general = await createDrama('普通对照测试片', false)
  generalDramaId = Number(general.id)
  episodeId = Number(db.prepare("INSERT INTO episodes (drama_id, no, title, status) VALUES (?, 1, '正片', 'ready')")
    .run(adultDramaId).lastInsertRowid)

  const tagId = Number(db.prepare("INSERT INTO tags (name, sort, status) VALUES ('成人回归标签', 0, 'active')").run().lastInsertRowid)
  db.prepare('INSERT INTO drama_tags (drama_id, tag_id) VALUES (?, ?)').run(adultDramaId, tagId)
  db.prepare('INSERT INTO drama_tags (drama_id, tag_id) VALUES (?, ?)').run(generalDramaId, tagId)

  const sectionId = Number(db.prepare("INSERT INTO sections (title, sort, enabled) VALUES ('成人回归楼层', 99, 1)").run().lastInsertRowid)
  db.prepare('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, 1)').run(sectionId, adultDramaId)
  db.prepare('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, 2)').run(sectionId, generalDramaId)
  db.prepare("INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES ('成人回归横幅', '', '', ?, 99, 1)")
    .run(adultDramaId)

  const rankListId = Number(db.prepare("INSERT INTO rank_lists (name, type, sort) VALUES ('成人过滤榜', 'ADULTFILTER', 99)").run().lastInsertRowid)
  db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, 1)').run(rankListId, adultDramaId)
  db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, 2)').run(rankListId, generalDramaId)

  mkdirSync(join(process.cwd(), 'storage', 'images'), { recursive: true })
  writeFileSync(posterCoverFile, 'poster-test')
  posterAdultId = Number(db.prepare("INSERT INTO dramas (title, cover_url, category, is_adult, status, content_type) VALUES ('辛特尔', '/media/images/cover-sintel.jpg', 'ANIME', 1, 'published', 'comic_drama')").run().lastInsertRowid)
  posterGeneralId = Number(db.prepare("INSERT INTO dramas (title, cover_url, category, is_adult, status, content_type) VALUES ('辛特尔', '/media/images/cover-sintel.jpg', 'ANIME', 0, 'published', 'comic_drama')").run().lastInsertRowid)

  db.prepare("INSERT INTO history (user_id, drama_id, episode_no, position) VALUES (?, ?, 1, 12)").run(userId, adultDramaId)
  db.prepare('INSERT INTO favorites (user_id, drama_id) VALUES (?, ?)').run(userId, adultDramaId)
})

after(() => {
  try { db?.close() } catch { /* ignore */ }
  rmSync(posterCoverFile, { force: true })
  rmSync(dir, { recursive: true, force: true })
})

test('成人菜单配置独立保存，并在常量中返回双语标签', async () => {
  const initial = await callAdmin('GET', '/admin/api/adult-menu')
  assert.equal(initial.code, '0000')
  assert.equal(initial.data.enabled, true)
  assert.equal(initial.data.labelZh, '成人')
  assert.equal(initial.data.labelEn, 'Adult')

  const saved = await callAdmin('PUT', '/admin/api/adult-menu', {
    enabled: true,
    labelZh: '18+',
    labelEn: 'Adults',
  })
  assert.equal(saved.code, '0000')
  assert.equal(saved.data.labelZh, '18+')

  const constants = await callPublic('/api/constants', '', 'en')
  assert.equal(constants.code, '0000')
  assert.deepEqual(constants.data.adultMenu, { enabled: true, labels: { zh: '18+', en: 'Adults' } })

  const tooLong = await callAdmin('PUT', '/admin/api/adult-menu', {
    enabled: true,
    labelZh: '超'.repeat(21),
    labelEn: 'Adult',
  })
  assert.equal(tooLong.status, 400)

  const wrongType = await callAdmin('PUT', '/admin/api/adult-menu', {
    enabled: 'false',
    labelZh: '18+',
    labelEn: 'Adults',
  })
  assert.equal(wrongType.status, 400)

  const emptyLabel = await callAdmin('PUT', '/admin/api/adult-menu', {
    enabled: true,
    labelZh: '',
    labelEn: 'Adults',
  })
  assert.equal(emptyLabel.status, 400)
})

test('成人内容只进入成人列表，普通分类、搜索与标签计数均排除', async () => {
  const general = await callPublic('/api/category?audience=general&pageSize=60')
  assert.equal(general.code, '0000')
  assert.ok(general.data.list.some((item) => item.dramaId === generalDramaId))
  assert.ok(!general.data.list.some((item) => item.dramaId === adultDramaId))
  assert.ok(!general.data.list.some((item) => item.dramaId === posterAdultId))

  const adult = await callPublic('/api/category?audience=adult&pageSize=60')
  assert.equal(adult.code, '0000')
  assert.equal(adult.data.active.audience, 'adult')
  const adultIds = adult.data.list.map((item) => item.dramaId)
  assert.ok(adultIds.includes(adultDramaId))
  assert.ok(adultIds.includes(posterAdultId))
  assert.ok(!adultIds.includes(generalDramaId))
  assert.ok(adult.data.list.every((item) => item.isAdult === true))

  const search = await callPublic(`/api/search?keyword=${encodeURIComponent('成人独占测试片')}`)
  assert.equal(search.code, '0000')
  assert.equal(search.data.total, 0)

  const tags = await callPublic('/api/tags')
  const tag = tags.data.list.find((row) => row.name === '成人回归标签')
  assert.equal(tag.dramaCount, 1)

  const home = await callPublic('/api/home')
  assert.equal(home.code, '0000')
  const homeAdultIds = home.data.sections.flatMap((section) => section.items).map((item) => item.dramaId)
  assert.ok(!homeAdultIds.includes(adultDramaId))
  assert.ok(!home.data.banners.some((banner) => banner.targetDramaId === adultDramaId))

  const rank = await callPublic('/api/rank?type=ADULTFILTER')
  assert.equal(rank.code, '0000')
  assert.deepEqual(rank.data.items.map((item) => item.dramaId), [generalDramaId])

  const detail = await callPublic(`/api/drama/${adultDramaId}`)
  assert.equal(detail.data.isAdult, true)
  assert.ok(detail.data.similar.every((item) => item.dramaId !== generalDramaId && item.isAdult))

  const posterIds = posterWall.posterWallCandidates().map((item) => item.dramaId)
  assert.ok(posterIds.includes(posterGeneralId))
  assert.ok(!posterIds.includes(posterAdultId))
})

test('个人历史与收藏保留成人记录', async () => {
  const me = await callPublic('/api/me', userToken)
  assert.equal(me.code, '0000')
  assert.ok(me.data.history.some((row) => row.dramaId === adultDramaId))
  assert.ok(me.data.favorites.some((row) => row.dramaId === adultDramaId && row.isAdult === true))
})

test('URL 导入拒绝私网、非 HTTP 协议与带凭据地址', async () => {
  assert.equal(mediaImport.isBlockedAddress('127.0.0.1'), true)
  assert.equal(mediaImport.isBlockedAddress('10.1.2.3'), true)
  assert.equal(mediaImport.isBlockedAddress('169.254.169.254'), true)
  assert.equal(mediaImport.isBlockedAddress('::1'), true)
  assert.equal(mediaImport.isBlockedAddress('::ffff:127.0.0.1'), true)
  assert.equal(mediaImport.isBlockedAddress('1.1.1.1'), false)

  await assert.rejects(() => mediaImport.assertPublicMediaUrl('file:///tmp/a.mp4'), /HTTP/)
  await assert.rejects(() => mediaImport.assertPublicMediaUrl('http://127.0.0.1/a.mp4'), /内网/)
  await assert.rejects(() => mediaImport.assertPublicMediaUrl('https://user:pass@1.1.1.1/a.mp4'), /账号或密码/)
  const ok = await mediaImport.assertPublicMediaUrl('https://1.1.1.1/movie.mp4')
  assert.equal(ok.hostname, '1.1.1.1')

  const blocked = await callAdmin('POST', `/admin/api/episodes/${episodeId}/import-url`, { url: 'http://127.0.0.1/movie.mp4' })
  assert.equal(blocked.status, 400)
  assert.match(blocked.msg, /内网/)
})
