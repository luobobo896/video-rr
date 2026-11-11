import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-tracks-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'

let db, adminApi, publicApi, auth, adminToken, userToken, dramaId, episodeId

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

async function callPlay() {
  const res = fakeResponse()
  const path = `/api/play/${dramaId}/1`
  const req = {
    method: 'GET',
    headers: { authorization: `Bearer ${userToken}`, 'user-agent': 'node-test', 'x-mh-lang': 'zh' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await publicApi.handlePublic(path, new URL(`http://localhost${path}`), req, res)
  return { status: res.status, ...res.json() }
}

async function callPublic(method, path, body) {
  const res = fakeResponse()
  const req = new EventEmitter()
  req.method = method
  req.headers = { authorization: `Bearer ${userToken}`, 'user-agent': 'node-test', 'x-mh-lang': 'zh' }
  req.socket = { remoteAddress: '127.0.0.1' }
  const url = new URL(`http://localhost${path}`)
  const promise = publicApi.handlePublic(url.pathname, url, req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  await promise
  return { status: res.status, ...res.json() }
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  adminApi = await import('../server/api-admin.mjs')
  publicApi = await import('../server/api-public.mjs')
  auth = await import('../server/auth.mjs')

  const admin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(admin.id)
  adminToken = auth.issueToken(admin.id, 'admin').token

  const userId = Number(db.prepare("INSERT INTO users (phone, nickname) VALUES ('13900000000', 'track-tester')").run().lastInsertRowid)
  userToken = auth.issueToken(userId, 'user').token
  dramaId = Number(db.prepare("INSERT INTO dramas (title, category, status) VALUES ('轨道测试剧', 'TV', 'published')").run().lastInsertRowid)
  episodeId = Number(db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status, hls_path) VALUES (?, 1, '第 1 集', 60, 'ready', '/media/hls/1/index.m3u8')").run(dramaId).lastInsertRowid)
  db.prepare("INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'free', 0, 0, 0, 'single', 72)").run(dramaId)
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('轨道 CRUD、默认唯一与播放接口匹配', async () => {
  const audio = await callAdmin('POST', `/admin/api/episodes/${episodeId}/tracks`, {
    kind: 'audio', language: 'yue', edition: 'original', label: '粤语原声',
    uri: '/media/hls/1/audio/yue.m3u8', isDefault: true,
  })
  assert.equal(audio.code, '0000', audio.msg)
  assert.equal(audio.data.is_default, 1)

  const subtitle = await callAdmin('POST', `/admin/api/episodes/${episodeId}/tracks`, {
    kind: 'subtitle', language: 'zh-Hans', edition: 'official', label: '简体中文',
    uri: '/media/hls/1/subs/zh-Hans.vtt',
  })
  assert.equal(subtitle.code, '0000', subtitle.msg)

  const list = await callAdmin('GET', `/admin/api/episodes/${episodeId}/tracks`)
  assert.equal(list.code, '0000')
  assert.equal(list.data.list.length, 2)

  const play = await callPlay()
  assert.equal(play.code, '0000', play.msg)
  assert.equal(play.data.audioTracks.length, 1)
  assert.equal(play.data.subtitleTracks.length, 1)
  assert.equal(play.data.preferredAudio.language, 'yue')
  assert.equal(play.data.preferredSubtitle.language, 'zh-Hans')

  const duplicate = await callAdmin('POST', `/admin/api/episodes/${episodeId}/tracks`, {
    kind: 'audio', language: 'yue', edition: 'original', label: '重复',
    uri: '/media/hls/1/audio/yue-2.m3u8',
  })
  assert.equal(duplicate.status, 409)

  const second = await callAdmin('POST', `/admin/api/episodes/${episodeId}/tracks`, {
    kind: 'audio', language: 'zh-Hans', edition: 'mandarin-dub', label: '普通话配音',
    uri: '/media/hls/1/audio/zh.m3u8', isDefault: true,
  })
  assert.equal(second.code, '0000', second.msg)
  const defaults = db.prepare("SELECT COUNT(*) AS n FROM episode_tracks WHERE episode_id = ? AND kind = 'audio' AND is_default = 1").get(episodeId).n
  assert.equal(defaults, 1)

  const updated = await callAdmin('PUT', `/admin/api/tracks/${subtitle.data.id}`, { label: '简体中文字幕' })
  assert.equal(updated.code, '0000', updated.msg)
  assert.equal(updated.data.label, '简体中文字幕')

  const blockedDelete = await callAdmin('DELETE', `/admin/api/tracks/${second.data.id}`)
  assert.equal(blockedDelete.status, 409)
  await callAdmin('PUT', `/admin/api/tracks/${audio.data.id}`, { isDefault: true })
  const deleted = await callAdmin('DELETE', `/admin/api/tracks/${second.data.id}`)
  assert.equal(deleted.code, '0000', deleted.msg)
})

test('登录用户轨道偏好按剧集保存并可恢复', async () => {
  const put = await callPublic('PUT', '/api/me/track-preferences', {
    dramaId, kind: 'audio', language: 'yue', edition: 'original',
  })
  assert.equal(put.code, '0000', put.msg)

  const get = await callPublic('GET', `/api/me/track-preferences?dramaId=${dramaId}`)
  assert.equal(get.code, '0000', get.msg)
  assert.deepEqual(get.data.audio, { language: 'yue', edition: 'original' })

  const off = await callPublic('PUT', '/api/me/track-preferences', {
    dramaId, kind: 'subtitle', off: true,
  })
  assert.equal(off.code, '0000', off.msg)
  const offGet = await callPublic('GET', `/api/me/track-preferences?dramaId=${dramaId}`)
  assert.equal(offGet.data.subtitle, 'off')

  const invalid = await callPublic('PUT', '/api/me/track-preferences', {
    dramaId, kind: 'audio', language: 'ja', edition: 'original',
  })
  assert.equal(invalid.status, 404)

  const badOff = await callPublic('PUT', '/api/me/track-preferences', {
    dramaId, kind: 'audio', off: true,
  })
  assert.equal(badOff.status, 400)
})
