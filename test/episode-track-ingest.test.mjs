import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-track-ingest-'))
const hlsDir = join(dir, 'hls')
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_HLS_DIR = hlsDir

let db
let addEpisodeTrack
let rewriteMaster
let episodeId

const masterSource = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720',
  '720p/index.m3u8',
  '',
].join('\n')

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  const script = await import('../scripts/add-episode-track.mjs')
  addEpisodeTrack = script.addEpisodeTrack
  rewriteMaster = script.rewriteMaster

  const dramaId = Number(db.prepare("INSERT INTO dramas (title, category, status) VALUES ('轨道接入测试', 'TV', 'published')").run().lastInsertRowid)
  episodeId = Number(db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status, hls_path) VALUES (?, 1, '第 1 集', 60, 'ready', ?)")
    .run(dramaId, `/media/hls/${dramaId}/index.m3u8`).lastInsertRowid)
  const root = join(hlsDir, String(episodeId))
  mkdirSync(join(root, '720p'), { recursive: true })
  writeFileSync(join(root, 'index.m3u8'), masterSource)
  writeFileSync(join(root, '720p', 'index.m3u8'), '#EXTM3U\n#EXT-X-ENDLIST\n')
  db.prepare('UPDATE episodes SET hls_path = ? WHERE id = ?').run(`/media/hls/${episodeId}/index.m3u8`, episodeId)
})

after(() => {
  try { db?.close() } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true })
})

test('master 重写包含音轨/字幕组和流属性', () => {
  const master = rewriteMaster(masterSource, [
    { kind: 'audio', language: 'yue', label: '粤语原声', is_default: 1, uri: 'audio/original/index.m3u8' },
    { kind: 'subtitle', language: 'zh-Hans', label: '简体中文', is_default: 0, uri: 'subs/zh-Hans-official/index.m3u8' },
  ])
  assert.match(master, /#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="yue",NAME="粤语原声",DEFAULT=YES,AUTOSELECT=YES,URI="audio\/original\/index\.m3u8"/)
  assert.match(master, /#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="zh-Hans",NAME="简体中文",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subs\/zh-Hans-official\/index\.m3u8"/)
  assert.match(master, /#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720,AUDIO="audio",SUBTITLES="subs"/)
})

test('字幕接入生成 WebVTT 播放列表并更新 master', async () => {
  const vtt = join(dir, 'zh-Hans.vtt')
  writeFileSync(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n你好\n')
  const track = await addEpisodeTrack({
    episodeId, kind: 'subtitle', file: vtt, language: 'zh-Hans', edition: 'official', label: '简体中文',
  })
  assert.equal(track.kind, 'subtitle')
  assert.equal(track.uri, `/media/hls/${episodeId}/subs/zh-Hans-official/index.m3u8`)
  const playlist = readFileSync(join(hlsDir, String(episodeId), 'subs', 'zh-Hans-official', 'index.m3u8'), 'utf8')
  assert.match(playlist, /#EXTINF:60,/)
  assert.match(playlist, /sub\.vtt/)
  const master = readFileSync(join(hlsDir, String(episodeId), 'index.m3u8'), 'utf8')
  assert.match(master, /TYPE=SUBTITLES/)
  assert.match(master, /SUBTITLES="subs"/)

  const again = await addEpisodeTrack({
    episodeId, kind: 'subtitle', file: vtt, language: 'zh-Hans', edition: 'official', label: '简体中文字幕',
  })
  assert.equal(again.id, track.id)
  assert.equal(again.label, '简体中文字幕')
})

test('音轨接入生成 HLS 音轨并更新 master', async (t) => {
  const wav = join(dir, 'tone.wav')
  const generated = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'pcm_s16le', wav], { stdio: 'ignore' })
  if (generated.status !== 0) return t.skip('ffmpeg 不可用')

  const track = await addEpisodeTrack({
    episodeId, kind: 'audio', file: wav, language: 'yue', edition: 'original', label: '粤语原声', isDefault: true,
  })
  assert.equal(track.kind, 'audio')
  assert.equal(track.uri, `/media/hls/${episodeId}/audio/original/index.m3u8`)
  assert.ok(existsSync(join(hlsDir, String(episodeId), 'audio', 'original', 'index.m3u8')))
  assert.ok(existsSync(join(hlsDir, String(episodeId), 'audio', 'original', 'seg_000.ts')))
  const master = readFileSync(join(hlsDir, String(episodeId), 'index.m3u8'), 'utf8')
  assert.match(master, /TYPE=AUDIO/)
  assert.match(master, /AUDIO="audio"/)
})
