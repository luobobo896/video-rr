import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-movie-'))
const hlsDir = join(dir, 'hls')
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_HLS_DIR = hlsDir

let db
let mergeMovieEpisodes
let dramaId
let firstId
let secondId
let thirdId

function writeHls(id) {
  const root = join(hlsDir, String(id))
  mkdirSync(join(root, '720p'), { recursive: true })
  writeFileSync(join(root, 'index.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
    '720p/index.m3u8',
    '',
  ].join('\n'))
  writeFileSync(join(root, '720p', 'index.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:5',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:5.000,',
    'seg_000.ts',
    '#EXTINF:5.000,',
    'seg_001.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n'))
  writeFileSync(join(root, '720p', 'seg_000.ts'), 'a')
  writeFileSync(join(root, '720p', 'seg_001.ts'), 'b')
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  mergeMovieEpisodes = (await import('../scripts/migrate-movie-episodes.mjs')).mergeMovieEpisodes

  dramaId = Number(db.prepare("INSERT INTO dramas (title, category, status) VALUES ('测试电影', 'MOVIE', 'published')").run().lastInsertRowid)
  const ids = []
  for (let no = 1; no <= 3; no += 1) {
    const id = Number(db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, ?, ?, 10, 'ready')")
      .run(dramaId, no, `第 ${no} 集`).lastInsertRowid)
    ids.push(id)
    db.prepare('UPDATE episodes SET hls_path = ? WHERE id = ?').run(`/media/hls/${id}/index.m3u8`, id)
    writeHls(id)
  }
  ;[firstId, secondId, thirdId] = ids

  db.prepare("INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours) VALUES (?, 'subscription', 3, 60, 0, 'single', 72)").run(dramaId)
  const userId = Number(db.prepare("INSERT INTO users (phone, nickname) VALUES ('13800000000', 'tester')").run().lastInsertRowid)
  db.prepare('INSERT INTO history (user_id, drama_id, episode_no, position) VALUES (?, ?, 2, 3)').run(userId, dramaId)
  db.prepare("INSERT INTO danmus (episode_id, time_ms, content, status) VALUES (?, 1000, 'test', 'approved')").run(secondId)
})

after(() => {
  try { db?.close() } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true })
})

test('多集电影合并为单集正片并保留进度和弹幕', () => {
  const result = mergeMovieEpisodes({ apply: true })
  assert.equal(result.errors.length, 0)
  assert.equal(result.ready.length, 1)
  assert.ok(result.backup && existsSync(result.backup))

  const first = db.prepare('SELECT hls_path, duration, title, status FROM episodes WHERE id = ?').get(firstId)
  assert.equal(first.hls_path, `/media/hls/${firstId}/merged/index.m3u8`)
  assert.equal(first.duration, 30)
  assert.equal(first.title, '正片')
  assert.equal(first.status, 'ready')

  for (const id of [secondId, thirdId]) {
    const episode = db.prepare('SELECT hls_path, status FROM episodes WHERE id = ?').get(id)
    assert.equal(episode.hls_path, null)
    assert.equal(episode.status, 'merged')
  }

  assert.equal(db.prepare('SELECT free_episodes FROM content_policies WHERE drama_id = ?').get(dramaId).free_episodes, 0)
  const history = db.prepare('SELECT episode_no, position FROM history WHERE drama_id = ?').get(dramaId)
  assert.equal(history.episode_no, 1)
  assert.equal(history.position, 13)
  const danmu = db.prepare('SELECT episode_id, time_ms FROM danmus WHERE content = ?').get('test')
  assert.equal(danmu.episode_id, firstId)
  assert.equal(danmu.time_ms, 11_000)

  const playlist = readFileSync(join(hlsDir, String(firstId), 'merged', '720p', 'index.m3u8'), 'utf8')
  assert.equal((playlist.match(/#EXTINF:/g) ?? []).length, 6)
  assert.equal((playlist.match(/#EXT-X-DISCONTINUITY/g) ?? []).length, 2)
  assert.ok(existsSync(join(hlsDir, String(firstId), 'merged', 'index.m3u8')))
  assert.ok(existsSync(join(hlsDir, String(firstId), 'merged', '720p', 'seg_005.ts')))
})
