import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-content-stats-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_LINK_SECRET = 'test-link-secret'
process.env.MH_SECRET = 'test-secret'

let db, stats

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  stats = await import('../server/content-stats.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const newUser = () => Number(db.prepare("INSERT INTO users (email,nickname) VALUES (?, 'stats')")
  .run(`stats-${Date.now()}-${Math.random()}@example.com`).lastInsertRowid)

test('点击 30 分钟桶去重，收藏切换不产生负数', () => {
  const uid = newUser()
  const content = db.prepare('SELECT * FROM dramas LIMIT 1').get()
  const first = stats.recordClick({ userId: uid, contentId: content.id, entryPage: '#/home', sourceModule: 'grid', requestId: 'a' })
  const second = stats.recordClick({ userId: uid, contentId: content.id, entryPage: '#/home', sourceModule: 'grid', requestId: 'b' })
  assert.equal(first.counted, true)
  assert.equal(second.counted, false)

  const added = stats.toggleFavorite({ userId: uid, contentId: content.id, requestId: 'fav-1' })
  assert.equal(added.favorited, true)
  assert.equal(added.favoriteCount, 1)
  const removed = stats.toggleFavorite({ userId: uid, contentId: content.id, requestId: 'fav-2' })
  assert.equal(removed.favorited, false)
  assert.equal(removed.favoriteCount, 0)
  const repeated = stats.toggleFavorite({ userId: uid, contentId: content.id, requestId: 'fav-2' })
  assert.equal(repeated.favorited, false)
  assert.equal(repeated.favoriteCount, 0)
})

test('有效观看达到阈值，24 小时内同集不重复计有效观看', () => {
  const uid = newUser()
  const content = db.prepare('SELECT * FROM dramas LIMIT 1').get()
  const episode = db.prepare('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no LIMIT 1').get(content.id)
  const session = stats.startViewSession({
    userId: uid, contentId: content.id, episodeId: episode.id, duration: 600, source: 'free',
  })
  db.prepare("UPDATE content_view_sessions SET effective_seconds=55, last_heartbeat_at=datetime('now','-10 seconds'), max_position_seconds=55 WHERE id=?")
    .run(session.id)
  const heartbeat = stats.applyHeartbeat({
    sessionId: session.id, userId: uid, positionSeconds: 66, durationSeconds: 600,
    playing: true, visible: true, playbackRate: 1,
  })
  assert.equal(heartbeat.valid, true)

  const second = stats.startViewSession({
    userId: uid, contentId: content.id, episodeId: episode.id, duration: 600, source: 'free',
  })
  db.prepare("UPDATE content_view_sessions SET effective_seconds=100, last_heartbeat_at=datetime('now','-10 seconds'), max_position_seconds=100 WHERE id=?")
    .run(second.id)
  const duplicate = stats.applyHeartbeat({
    sessionId: second.id, userId: uid, positionSeconds: 110, durationSeconds: 600,
    playing: true, visible: true, playbackRate: 1,
  })
  assert.equal(duplicate.valid, false)
})

test('统计聚合和热播榜快照可生成', () => {
  const uid = newUser()
  const content = db.prepare('SELECT * FROM dramas WHERE content_type IS NOT NULL ORDER BY id DESC LIMIT 1').get()
  const episode = db.prepare('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no LIMIT 1').get(content.id)
  const session = stats.startViewSession({ userId: uid, contentId: content.id, episodeId: episode.id, duration: 600, source: 'free' })
  db.prepare("UPDATE content_view_sessions SET effective_seconds=70, max_position_seconds=70, last_heartbeat_at=datetime('now','-5 seconds') WHERE id=?")
    .run(session.id)
  stats.applyHeartbeat({ sessionId: session.id, userId: uid, positionSeconds: 80, durationSeconds: 600, playing: true, visible: true, playbackRate: 1 })
  stats.toggleFavorite({ userId: uid, contentId: content.id, requestId: 'rank-fav' })
  const rebuilt = stats.rebuildContentStats({ days: 1 })
  assert.ok(rebuilt.contents >= 1)
  const analytics = stats.contentAnalytics({ days: 7, contentId: content.id })
  assert.ok(analytics.rows[0].viewCount >= 1)
  assert.ok(analytics.rows[0].favoriteAddCount >= 1)
  const rank = stats.buildContentRank({ rankType: 'hot', limit: 10 })
  assert.ok(rank.items.length >= 1)
  const published = stats.contentRank({ rankType: 'hot' })
  assert.ok(published.items.length >= 1)
})

test('心跳超过 45 秒过期，客户端不能缩短片长绕过阈值', () => {
  const uid = newUser()
  const content = db.prepare('SELECT * FROM dramas WHERE content_type IS NOT NULL LIMIT 1').get()
  const episode = db.prepare('SELECT * FROM episodes WHERE drama_id = ? LIMIT 1').get(content.id)
  const expired = stats.startViewSession({ userId: uid, contentId: content.id, episodeId: episode.id, duration: 600, source: 'free' })
  db.prepare("UPDATE content_view_sessions SET last_heartbeat_at=datetime('now','-1 hour') WHERE id=?").run(expired.id)
  const expiredResult = stats.applyHeartbeat({ sessionId: expired.id, userId: uid, positionSeconds: 20, durationSeconds: 600, playing: true, visible: true, playbackRate: 1 })
  assert.equal(expiredResult.sessionStatus, 'expired')

  const session = stats.startViewSession({ userId: uid, contentId: content.id, episodeId: episode.id, duration: 600, source: 'free' })
  db.prepare("UPDATE content_view_sessions SET effective_seconds=35, last_heartbeat_at=datetime('now','-10 seconds'), max_position_seconds=35 WHERE id=?").run(session.id)
  const result = stats.applyHeartbeat({ sessionId: session.id, userId: uid, positionSeconds: 40, durationSeconds: 30, playing: true, visible: true, playbackRate: 1 })
  assert.equal(result.thresholdSeconds, 60)
  assert.equal(result.valid, false)
})
