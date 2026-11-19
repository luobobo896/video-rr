/** 内容统计：点击、有效观看会话、收藏事件、聚合报表和榜单快照。 */
import { createHash, randomUUID } from 'node:crypto'
import { db } from './db.mjs'
import { parseDays } from './analytics.mjs'
import { adultVisibilitySql } from './content-visibility.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const hash = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 40)
const normalizeVisitorId = (value) => {
  const id = String(value ?? '').trim().slice(0, 64)
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}
const viewerKeyOf = (userId, visitorId) => userId ? `u:${userId}` : `v:${normalizeVisitorId(visitorId) ?? ''}`
const contentOf = (contentId) => one('SELECT * FROM dramas WHERE id = ?', Number(contentId))

export function viewThresholdSeconds(duration) {
  const total = Number(duration ?? 0)
  if (!(total > 0)) return 30
  return Math.min(120, Math.max(30, total * 0.1))
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function recordClick({
  userId, visitorId, contentId, episodeId, entryPage = 'unknown', sourceModule = 'unknown',
  position = 0, ip, ua, requestId,
} = {}) {
  const content = contentOf(contentId)
  if (!content) throw Object.assign(new Error('内容不存在'), { code: 'content_not_found', status: 404 })
  if (content.status !== 'published') throw Object.assign(new Error('内容未上架'), { code: 'content_not_published', status: 404 })
  const viewerKey = viewerKeyOf(userId, visitorId)
  if (!viewerKey || viewerKey === 'v:') throw Object.assign(new Error('访客标识无效'), { code: 'invalid_identity', status: 400 })
  const bucket = Math.floor(Date.now() / 1_800_000)
  // 只信服务端生成的统计身份和内容 ID；entryPage/sourceModule 可展示但不能参与去重键。
  const dedupKey = hash(`bucket:${bucket}|${viewerKey}|${content.id}`)
  const info = run(`INSERT OR IGNORE INTO content_click_events
    (dedup_key, viewer_key, user_id, visitor_id, content_id, episode_id, entry_page, source_module, position,
     occurred_at, client_ts, ip_hash, ua_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)`,
  dedupKey, viewerKey, userId ?? null, normalizeVisitorId(visitorId), content.id,
  Number(episodeId) || null, String(entryPage).slice(0, 80), String(sourceModule).slice(0, 80),
  Number(position) || 0, nowSql(), ip ? hash(ip) : null, ua ? hash(ua) : null)
  return { accepted: true, counted: Number(info.changes ?? 0) > 0, dedupKey, contentId: content.id }
}

export function startViewSession({
  userId, visitorId, contentId, episodeId, source = 'play', duration, ip, ua,
} = {}) {
  const content = contentOf(contentId)
  if (!content) throw Object.assign(new Error('内容不存在'), { code: 'content_not_found', status: 404 })
  const viewerKey = viewerKeyOf(userId, visitorId)
  if (!viewerKey || viewerKey === 'v:') throw Object.assign(new Error('访客标识无效'), { code: 'invalid_identity', status: 400 })
  const id = randomUUID()
  const sessionSource = String(source ?? 'play')
  run(`INSERT INTO content_view_sessions
    (id, viewer_key, user_id, visitor_id, content_id, episode_id, content_type, source, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, viewerKey, userId ?? null, normalizeVisitorId(visitorId), content.id,
  Number(episodeId) || null, content.content_type ?? (content.category === 'MOVIE' ? 'movie' : 'series'),
  sessionSource, Number(duration) > 0 ? Number(duration) : null)
  return { id, thresholdSeconds: viewThresholdSeconds(duration), heartbeatIntervalSeconds: 15 }
}

export function applyHeartbeat({
  sessionId, userId, visitorId, positionSeconds, durationSeconds, playing, visible, playbackRate,
} = {}) {
  return tx(() => {
  const session = one('SELECT * FROM content_view_sessions WHERE id = ?', String(sessionId ?? ''))
  if (!session) throw Object.assign(new Error('观看会话不存在'), { code: 'session_not_found', status: 404 })
  if (session.status !== 'active') throw Object.assign(new Error('观看会话已结束'), { code: 'session_closed', status: 409 })
  if (session.user_id && Number(session.user_id) !== Number(userId)) {
    throw Object.assign(new Error('观看会话不属于当前用户'), { code: 'session_forbidden', status: 403 })
  }
  if (!session.user_id && normalizeVisitorId(visitorId) !== session.visitor_id) {
    throw Object.assign(new Error('观看会话不属于当前访客'), { code: 'session_forbidden', status: 403 })
  }
  const guestTrial = session.source === 'trial' && !session.user_id
  const storedDuration = Number(session.duration_seconds ?? 0)
  const clientDuration = Number(durationSeconds ?? 0)
  const duration = storedDuration > 0 ? storedDuration : clientDuration
  if (!(duration > 0)) {
    run("UPDATE content_view_sessions SET status = 'invalid', ended_at = datetime('now') WHERE id = ?", session.id)
    return {
      sessionId: session.id, effectiveSeconds: Number(session.effective_seconds ?? 0),
      thresholdSeconds: null, valid: false, completed: false, sessionStatus: 'invalid',
    }
  }
  const threshold = viewThresholdSeconds(duration)
  // 播放位置来自客户端：夹在 [0, duration]。明显越界（比整片还长 2 秒以上，如 positionSeconds=1e9）
  // 视为伪造心跳——不推进进度、不置完播，只能沿用已累计的最远位置。
  const rawPosition = Number(positionSeconds ?? 0)
  const storedPosition = Number(session.max_position_seconds ?? 0)
  const plausible = Number.isFinite(rawPosition) && rawPosition >= 0 && (guestTrial || rawPosition <= duration + 2)
  const position = plausible ? Math.min(duration, rawPosition) : Math.min(duration, Math.max(0, storedPosition))
  const last = new Date(String(session.last_heartbeat_at).replace(' ', 'T') + 'Z').getTime()
  const elapsedSinceLast = Number.isFinite(last) ? Math.max(0, (Date.now() - last) / 1000) : 0
  if (!guestTrial && elapsedSinceLast > 45) {
    run("UPDATE content_view_sessions SET status = 'expired', ended_at = datetime('now') WHERE id = ?", session.id)
    return {
      sessionId: session.id, effectiveSeconds: Number(session.effective_seconds ?? 0),
      thresholdSeconds: threshold, valid: Boolean(session.is_valid), completed: Boolean(session.completed),
      sessionStatus: 'expired',
    }
  }
  const elapsed = Math.min(20, elapsedSinceLast)
  const progressDelta = Math.max(0, position - Number(session.max_position_seconds ?? 0))
  const rate = Math.max(0.25, Math.min(4, Number(playbackRate) || 1))
  const effectiveDelta = playing && visible && progressDelta > 0.05 ? Math.min(elapsed, 20) : 0
  const previous = Number(session.effective_seconds ?? 0)
  const effective = guestTrial
    ? Math.min(duration, previous + (elapsedSinceLast <= 20 && playing && visible ? Math.min(elapsed, progressDelta / rate) : 0))
    : previous + effectiveDelta
  if (guestTrial) {
    run(`UPDATE content_view_sessions SET effective_seconds = ?, max_position_seconds = ?,
      last_heartbeat_at = datetime('now') WHERE id = ?`, effective, position, session.id)
    run(`UPDATE trial_uses SET seconds_used = ? WHERE view_session_id = ?
      AND created_at >= datetime('now', ?)`, Math.floor(effective), session.id, `-${duration + 60} seconds`)
    return { sessionId: session.id, effectiveSeconds: effective, thresholdSeconds: threshold,
      valid: false, completed: false, sessionStatus: 'active' }
  }
  // 完播一旦达成就保持（回拖不该把已有的完播抹掉），且伪造心跳永远不算完播
  const completed = Number(session.completed ?? 0) || (plausible && position / duration >= 0.9) ? 1 : 0
  let valid = Number(session.is_valid ?? 0)
  let validAt = session.valid_at
  if (!valid && effective >= threshold) {
    const prior = one(`SELECT 1 AS x FROM content_view_sessions
      WHERE viewer_key = ? AND content_id = ? AND COALESCE(episode_id, 0) = COALESCE(?, 0)
        AND is_valid = 1 AND id <> ? AND started_at >= datetime('now', '-1 day')
      LIMIT 1`, session.viewer_key, session.content_id, session.episode_id, session.id)
    if (!prior) {
      valid = 1
      validAt = nowSql()
    }
  }
  run(`UPDATE content_view_sessions SET effective_seconds = ?, max_position_seconds = MAX(max_position_seconds, ?),
    duration_seconds = COALESCE(?, duration_seconds), playback_rate = ?, last_heartbeat_at = datetime('now'),
    completed = ?, is_valid = ?, valid_at = COALESCE(?, valid_at),
    status = CASE WHEN ? = 1 THEN 'ended' ELSE status END, ended_at = CASE WHEN ? = 1 THEN datetime('now') ELSE ended_at END
    WHERE id = ?`,
  effective, position, storedDuration > 0 ? storedDuration : clientDuration, rate, completed ? 1 : 0, valid, validAt,
  completed ? 1 : 0, completed ? 1 : 0, session.id)
  return {
    sessionId: session.id, effectiveSeconds: effective, thresholdSeconds: threshold,
    valid: Boolean(valid), completed: Boolean(completed), sessionStatus: completed ? 'ended' : 'active',
  }
  })
}

export function toggleFavorite({ userId, contentId, requestId } = {}) {
  if (!userId) throw Object.assign(new Error('需要登录'), { code: 'unauthorized', status: 401 })
  const content = contentOf(contentId)
  if (!content) throw Object.assign(new Error('内容不存在'), { code: 'content_not_found', status: 404 })
  const dedupKey = `favorite:${userId}:${content.id}:${requestId ? hash(requestId) : randomUUID()}`
  return tx(() => {
    const existingEvent = one('SELECT * FROM content_favorite_events WHERE dedup_key = ?', dedupKey)
    const current = one('SELECT 1 AS x FROM favorites WHERE user_id = ? AND drama_id = ?', userId, content.id)
    if (existingEvent) {
      return { favorited: Boolean(current), favoriteCount: favoriteCount(content.id), changed: false }
    }
    if (current) run('DELETE FROM favorites WHERE user_id = ? AND drama_id = ?', userId, content.id)
    else run('INSERT INTO favorites (user_id, drama_id) VALUES (?, ?)', userId, content.id)
    const toState = current ? 0 : 1
    run(`INSERT OR IGNORE INTO content_favorite_events
      (dedup_key, user_id, content_id, action, from_state, to_state, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    dedupKey, userId, content.id, toState ? 'add' : 'remove', current ? 1 : 0, toState)
    return { favorited: Boolean(toState), favoriteCount: favoriteCount(content.id), changed: true }
  })
}

export function favoriteCount(contentId) {
  return Number(one('SELECT COUNT(*) AS n FROM favorites WHERE drama_id = ?', Number(contentId))?.n ?? 0)
}

function dailyForContent(contentId, date) {
  const clicks = one(`SELECT COUNT(*) AS n, COUNT(DISTINCT viewer_key) AS uv
    FROM content_click_events WHERE content_id = ? AND date(occurred_at) = ?`, contentId, date)
  const plays = one(`SELECT COUNT(*) AS n FROM play_events
    WHERE drama_id = ? AND date(created_at) = ?`, contentId, date)
  const views = one(`SELECT COUNT(*) AS n, COUNT(DISTINCT viewer_key) AS uv,
      SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) AS completed,
      COALESCE(AVG(effective_seconds), 0) AS avgSeconds
    FROM content_view_sessions
    WHERE content_id = ? AND is_valid = 1 AND source NOT IN ('trial','preview') AND date(started_at) = ?`, contentId, date)
  const favorites = one(`SELECT
      SUM(CASE WHEN action = 'add' THEN 1 ELSE 0 END) AS addCount,
      SUM(CASE WHEN action = 'remove' THEN 1 ELSE 0 END) AS removeCount,
      COUNT(DISTINCT CASE WHEN action = 'add' THEN user_id END) AS addUv
    FROM content_favorite_events
    WHERE content_id = ? AND is_migration = 0 AND date(occurred_at) = ?`, contentId, date)
  return {
    clickCount: Number(clicks?.n ?? 0), clickUv: Number(clicks?.uv ?? 0),
    playRequestCount: Number(plays?.n ?? 0), viewCount: Number(views?.n ?? 0),
    viewerCount: Number(views?.uv ?? 0), completionCount: Number(views?.completed ?? 0),
    completionRate: Number(views?.n ?? 0) ? Number(views?.completed ?? 0) / Number(views.n) : 0,
    favoriteAddCount: Number(favorites?.addCount ?? 0), favoriteRemoveCount: Number(favorites?.removeCount ?? 0),
    favoriteAddUv: Number(favorites?.addUv ?? 0), avgWatchSeconds: Number(views?.avgSeconds ?? 0),
  }
}

export function rebuildContentStats({ days = 2 } = {}) {
  const dates = []
  for (let i = 0; i < Math.max(1, Math.min(31, Number(days) || 2)); i += 1) {
    dates.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10))
  }
  // 只重算窗口内真正有事件的内容。全库 10 万+ 部时逐部重算会把 Node 主线程占满，
  // 而日聚合/总量只会随新事件变化；没有事件的内容保留上次结果即可。
  const since = `${dates[dates.length - 1]} 00:00:00`
  const contents = all(`SELECT d.id, d.content_type FROM dramas d
    WHERE d.status = 'published' AND (
      EXISTS (SELECT 1 FROM play_events p WHERE p.drama_id = d.id AND p.created_at >= ?)
      OR EXISTS (SELECT 1 FROM content_click_events c WHERE c.content_id = d.id AND c.occurred_at >= ?)
      OR EXISTS (SELECT 1 FROM content_view_sessions v WHERE v.content_id = d.id AND v.started_at >= ?)
      OR EXISTS (SELECT 1 FROM content_favorite_events f WHERE f.content_id = d.id AND f.occurred_at >= ?)
    )`, since, since, since, since)
  for (const content of contents) {
    for (const date of dates) {
      const row = dailyForContent(content.id, date)
      run(`INSERT INTO content_stats_daily
        (stat_date, content_id, content_type, click_count, click_uv, play_request_count, view_count, viewer_count,
         completion_count, completion_rate, favorite_add_count, favorite_remove_count, favorite_add_uv,
         avg_watch_seconds, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(stat_date, content_id) DO UPDATE SET
          content_type = excluded.content_type, click_count = excluded.click_count, click_uv = excluded.click_uv,
          play_request_count = excluded.play_request_count, view_count = excluded.view_count,
          viewer_count = excluded.viewer_count, completion_count = excluded.completion_count,
          completion_rate = excluded.completion_rate, favorite_add_count = excluded.favorite_add_count,
          favorite_remove_count = excluded.favorite_remove_count, favorite_add_uv = excluded.favorite_add_uv,
          avg_watch_seconds = excluded.avg_watch_seconds, updated_at = datetime('now')`,
      date, content.id, content.content_type ?? null, row.clickCount, row.clickUv, row.playRequestCount,
      row.viewCount, row.viewerCount, row.completionCount, row.completionRate,
      row.favoriteAddCount, row.favoriteRemoveCount, row.favoriteAddUv, row.avgWatchSeconds)
    }
    const life = one(`SELECT
      (SELECT COUNT(*) FROM content_click_events WHERE content_id = ?) AS clicks,
      (SELECT COUNT(*) FROM content_view_sessions WHERE content_id = ? AND is_valid = 1 AND source NOT IN ('trial','preview')) AS views,
      (SELECT COUNT(DISTINCT viewer_key) FROM content_view_sessions WHERE content_id = ? AND is_valid = 1 AND source NOT IN ('trial','preview')) AS viewers,
      (SELECT COUNT(*) FROM favorites WHERE drama_id = ?) AS favorites`,
    content.id, content.id, content.id, content.id)
    run(`INSERT INTO content_stats_total
      (content_id, lifetime_click_count, lifetime_view_count, lifetime_viewer_count, current_favorite_count, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(content_id) DO UPDATE SET
        lifetime_click_count = excluded.lifetime_click_count, lifetime_view_count = excluded.lifetime_view_count,
        lifetime_viewer_count = excluded.lifetime_viewer_count, current_favorite_count = excluded.current_favorite_count,
        updated_at = datetime('now')`,
    content.id, Number(life?.clicks ?? 0), Number(life?.views ?? 0), Number(life?.viewers ?? 0), Number(life?.favorites ?? 0))
  }
  return { contents: contents.length, days: dates.length }
}

/** 内容分析用的公共 SELECT：9 个时间窗参数在前，筛选参数在后（占位符顺序与 SQL 文本一致）。 */
function analyticsSelect({ since, contentType, category, contentId }) {
  const clauses = ["d.status = 'published'"]
  const filters = []
  if (contentType && contentType !== 'all') { clauses.push('d.content_type = ?'); filters.push(contentType) }
  if (category && category !== 'all') { clauses.push('d.category = ?'); filters.push(category) }
  if (contentId) { clauses.push('d.id = ?'); filters.push(Number(contentId)) }
  const sql = `SELECT d.id AS contentId, d.title, d.content_type AS contentType, d.category,
      d.score, d.published_at AS publishedAt,
      (SELECT COUNT(*) FROM content_click_events e WHERE e.content_id = d.id AND e.occurred_at >= ?) AS clickCount,
      (SELECT COUNT(DISTINCT e.viewer_key) FROM content_click_events e WHERE e.content_id = d.id AND e.occurred_at >= ?) AS clickUv,
      (SELECT COUNT(*) FROM content_view_sessions s WHERE s.content_id = d.id AND s.is_valid = 1 AND s.source NOT IN ('trial','preview') AND s.started_at >= ?) AS viewCount,
      (SELECT COUNT(DISTINCT s.viewer_key) FROM content_view_sessions s WHERE s.content_id = d.id AND s.is_valid = 1 AND s.source NOT IN ('trial','preview') AND s.started_at >= ?) AS viewerCount,
      (SELECT COUNT(*) FROM content_view_sessions s WHERE s.content_id = d.id AND s.is_valid = 1 AND s.source NOT IN ('trial','preview') AND s.completed = 1 AND s.started_at >= ?) AS completionCount,
      (SELECT COALESCE(SUM(s.effective_seconds), 0) FROM content_view_sessions s WHERE s.content_id = d.id AND s.is_valid = 1 AND s.source NOT IN ('trial','preview') AND s.started_at >= ?) AS watchSeconds,
      (SELECT COUNT(*) FROM content_favorite_events f WHERE f.content_id = d.id AND f.is_migration = 0 AND f.action = 'add' AND f.occurred_at >= ?) AS favoriteAddCount,
      (SELECT COUNT(*) FROM content_favorite_events f WHERE f.content_id = d.id AND f.is_migration = 0 AND f.action = 'remove' AND f.occurred_at >= ?) AS favoriteRemoveCount,
      (SELECT COUNT(DISTINCT f.user_id) FROM content_favorite_events f WHERE f.content_id = d.id AND f.is_migration = 0 AND f.action = 'add' AND f.occurred_at >= ?) AS favoriteAddUv,
      (SELECT COUNT(*) FROM favorites fv WHERE fv.drama_id = d.id) AS favoriteCount
    FROM dramas d WHERE ${clauses.join(' AND ')}`
  return { sql, args: [...Array(9).fill(since), ...filters], since }
}

const TOTAL_KEYS = ['clickCount', 'clickUv', 'viewCount', 'viewerCount', 'completionCount', 'watchSeconds', 'favoriteAddCount', 'favoriteRemoveCount', 'favoriteCount']

/** 全量合计：一次聚合查询算完，分页只影响 rows，不影响口径。 */
function analyticsTotals({ since, contentType, category, contentId }) {
  const { sql, args } = analyticsSelect({ since, contentType, category, contentId })
  const row = one(`SELECT COUNT(*) AS contents, ${TOTAL_KEYS.map((key) => `COALESCE(SUM(${key}), 0) AS ${key}`).join(', ')}
    FROM (${sql})`, ...args) ?? {}
  const totals = { contents: Number(row.contents ?? 0) }
  for (const key of TOTAL_KEYS) totals[key] = Number(row[key] ?? 0)
  totals.completionRate = totals.viewCount ? totals.completionCount / totals.viewCount : 0
  totals.favoriteRate = totals.viewerCount ? totals.favoriteAddCount / totals.viewerCount : 0
  // 平均观看时长按「总观看秒数 / 有效播放数」算：先按剧求均值再求平均是错的（长剧会带偏整体）
  totals.avgWatchSeconds = totals.viewCount ? totals.watchSeconds / totals.viewCount : 0
  return totals
}

function analyticsRows({ days = 7, contentType, category, contentId, limit = 0, offset = 0 } = {}) {
  const span = parseDays(days, 7, 1, 365)
  const since = new Date(Date.now() - span * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
  const { sql, args } = analyticsSelect({ since, contentType, category, contentId })
  const paged = Number(limit) > 0
  const rows = paged
    ? all(`${sql} ORDER BY d.id ASC LIMIT ? OFFSET ?`, ...args, Math.trunc(Number(limit)), Math.max(0, Math.trunc(Number(offset)) || 0))
    : all(`${sql} ORDER BY d.id ASC`, ...args)
  return rows.map((row) => {
    const viewCount = Number(row.viewCount ?? 0)
    const viewerCount = Number(row.viewerCount ?? 0)
    const completionCount = Number(row.completionCount ?? 0)
    const clickUv = Number(row.clickUv ?? 0)
    const favoriteAddUv = Number(row.favoriteAddUv ?? 0)
    const watchSeconds = Number(row.watchSeconds ?? 0)
    const interim = one(`SELECT COUNT(*) AS n FROM (
      SELECT viewer_key AS id FROM content_view_sessions
      WHERE content_id = ? AND is_valid = 1 AND source NOT IN ('trial','preview') AND started_at >= ?
      INTERSECT
      SELECT 'u:' || user_id FROM content_favorite_events
      WHERE content_id = ? AND is_migration = 0 AND action = 'add' AND occurred_at >= ?
    )`, row.contentId, since, row.contentId, since)
    return {
      ...row,
      contentId: Number(row.contentId), clickCount: Number(row.clickCount ?? 0), clickUv,
      viewCount, viewerCount, completionCount, watchSeconds,
      completionRate: viewCount ? completionCount / viewCount : 0,
      avgWatchSeconds: viewCount ? watchSeconds / viewCount : 0,
      favoriteAddCount: Number(row.favoriteAddCount ?? 0),
      favoriteRemoveCount: Number(row.favoriteRemoveCount ?? 0),
      favoriteAddUv, favoriteCount: Number(row.favoriteCount ?? 0),
      favoriteRate: viewerCount ? Number(interim?.n ?? 0) / viewerCount : 0,
      clickToViewRate: clickUv ? viewerCount / clickUv : 0,
    }
  })
}

export function contentAnalytics(options = {}) {
  const days = parseDays(options.days, 7, 1, 365)
  // 默认 50、上限 200：早期一次性把整站内容连 INTERSECT 全部算完，库一大后台就超时
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(options.limit)) || 50))
  const offset = Math.max(0, Math.trunc(Number(options.offset)) || 0)
  const rows = analyticsRows({ ...options, days, limit, offset })
  const totals = analyticsTotals({ ...options, since: new Date(Date.now() - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ') })
  const total = totals.contents
  return {
    rows, totals, total,
    page: { limit, offset, hasMore: offset + rows.length < total },
    range: { days },
  }
}

const RANK_META = {
  hot: { label: '热播榜', windowDays: 7 },
  favorite: { label: '收藏榜', windowDays: 7 },
  completion: { label: '完播榜', windowDays: 7 },
  new: { label: '新片榜', windowDays: 30 },
  recommend: { label: '推荐榜', windowDays: 7 },
}

export const CONTENT_RANK_TYPES = Object.fromEntries(Object.entries(RANK_META).map(([key, value]) => [key, value.label]))

export function buildContentRank({ rankType = 'hot', contentType = 'all', days, limit = 20 } = {}) {
  const meta = RANK_META[rankType] ?? RANK_META.hot
  const windowDays = parseDays(days, meta.windowDays, 1, 365)
  let rows = analyticsRows({ days: windowDays, contentType })
  rows = rows.filter((row) => Boolean(row.contentType))
  if (rankType === 'hot') rows = rows.filter((row) => row.viewerCount > 0)
  if (rankType === 'favorite') rows = rows.filter((row) => row.favoriteAddUv > 0 || row.favoriteCount > 0)
  if (rankType === 'completion') rows = rows.filter((row) => row.viewerCount >= 20)
  if (rankType === 'new') {
    const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
    rows = rows.filter((row) => row.viewerCount > 0 && row.publishedAt && row.publishedAt >= since)
  }
  if (rankType === 'recommend') {
    rows = rows.filter((row) => row.viewerCount >= 20)
    const maxViewer = Math.max(1, ...rows.map((row) => row.viewerCount))
    const maxFav = Math.max(1, ...rows.map((row) => row.favoriteAddUv))
    for (const row of rows) {
      const published = row.publishedAt ? new Date(String(row.publishedAt).replace(' ', 'T') + 'Z').getTime() : 0
      const ageDays = published ? Math.max(0, (Date.now() - published) / 86400_000) : 90
      const freshness = Math.max(0, 1 - ageDays / 90)
      row.score = 0.4 * (row.viewerCount / maxViewer) + 0.3 * row.completionRate
        + 0.2 * (row.favoriteAddUv / maxFav) + 0.1 * freshness
    }
    rows.sort((a, b) => b.score - a.score || b.viewerCount - a.viewerCount || a.contentId - b.contentId)
  } else if (rankType === 'favorite') {
    rows.sort((a, b) => b.favoriteAddUv - a.favoriteAddUv || b.favoriteCount - a.favoriteCount
      || b.viewerCount - a.viewerCount || a.contentId - b.contentId)
  } else if (rankType === 'completion') {
    rows.sort((a, b) => b.completionRate - a.completionRate || b.viewerCount - a.viewerCount
      || b.viewCount - a.viewCount || a.contentId - b.contentId)
  } else {
    rows.sort((a, b) => b.viewerCount - a.viewerCount || b.viewCount - a.viewCount
      || b.completionRate - a.completionRate || b.favoriteCount - a.favoriteCount || a.contentId - b.contentId)
  }
  rows = rows.slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
  // 一次榜单生成要写 runs + snapshots 两张表：中途失败不能留下「有 run 没快照」的半截榜单
  const runId = tx(() => {
    const runInfo = run(`INSERT INTO content_rank_runs
      (rank_type, dimension_type, dimension_value, window_start, window_end, strategy_version, status, generated_at)
      VALUES (?, 'content_type', ?, datetime('now', ?), datetime('now'), 'v1', 'success', datetime('now'))`,
    rankType, contentType, `-${windowDays} days`)
    const id = Number(runInfo.lastInsertRowid)
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      const metrics = {
        viewerCount: row.viewerCount, viewCount: row.viewCount, completionRate: row.completionRate,
        favoriteAddUv: row.favoriteAddUv, favoriteCount: row.favoriteCount, score: row.score ?? null,
      }
      run(`INSERT INTO content_rank_snapshots
        (run_id, content_id, rank_no, score, metrics_json, generated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      id, row.contentId, index + 1, Number(row.score ?? row.viewerCount ?? 0), JSON.stringify(metrics))
    }
    return id
  })
  return { runId, rankType, label: meta.label, contentType, windowDays, items: rows.map((row, index) => ({ rankNo: index + 1, ...row })) }
}

export function refreshContentRanks() {
  const results = []
  for (const rankType of Object.keys(RANK_META)) {
    try {
      results.push(buildContentRank({ rankType, limit: 20 }))
    } catch (error) {
      results.push({ rankType, error: error.message })
    }
  }
  return results
}

export function contentRank({ rankType = 'hot', contentType = 'all' } = {}) {
  const meta = RANK_META[rankType] ?? RANK_META.hot
  const rankRun = one(`SELECT * FROM content_rank_runs
    WHERE rank_type = ? AND dimension_type = 'content_type' AND dimension_value = ? AND status = 'success'
    ORDER BY id DESC LIMIT 1`, rankType, contentType)
  if (!rankRun) return { type: rankType, label: meta.label, items: [], generatedAt: null }
  const items = all(`SELECT s.*, d.title, d.cover_url, d.sub_title, d.category, d.score, d.year, d.area,
      d.content_type
    FROM content_rank_snapshots s JOIN dramas d ON d.id = s.content_id
    WHERE s.run_id = ? AND ${adultVisibilitySql()} ORDER BY s.rank_no`, rankRun.id)
  return {
    type: rankType, label: meta.label, contentType, generatedAt: rankRun.generated_at,
    strategyVersion: rankRun.strategy_version,
    items: items.map((row) => ({
      dramaId: row.content_id, title: row.title, coverUrl: row.cover_url, subTitle: row.sub_title,
      dramaType: row.category, contentType: row.content_type, score: row.score, year: row.year,
      area: row.area, rankNo: row.rank_no, metrics: row.metrics_json ? JSON.parse(row.metrics_json) : {},
    })),
  }
}

export { viewerKeyOf }
