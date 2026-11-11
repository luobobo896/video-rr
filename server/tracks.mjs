import { db } from './db.mjs'

const KINDS = new Set(['audio', 'subtitle'])
const STATUSES = new Set(['ready', 'processing', 'error'])
const LANGUAGE_RE = /^(und|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/
const EDITION_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/

export class TrackError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'TrackError'
    this.status = status
  }
}

function text(value, field, { required = false, max = 80 } = {}) {
  const result = String(value ?? '').trim()
  if (required && !result) throw new TrackError(`请填写${field}`)
  if (result.length > max) throw new TrackError(`${field}不能超过 ${max} 个字符`)
  return result
}

function kindOf(value) {
  const kind = String(value ?? '').trim()
  if (!KINDS.has(kind)) throw new TrackError('轨道类型必须是 audio 或 subtitle')
  return kind
}

function languageOf(value) {
  const language = text(value, '语言', { required: true, max: 35 })
  if (!LANGUAGE_RE.test(language)) throw new TrackError('语言需使用 BCP-47 格式，例如 zh-Hans、yue、en')
  return language
}

function editionOf(value) {
  const edition = text(value ?? 'original', '版本/片源', { required: true, max: 40 }).toLowerCase()
  if (!EDITION_RE.test(edition)) throw new TrackError('版本/片源只能使用小写字母、数字、点、下划线或短横线')
  return edition
}

function statusOf(value) {
  const status = String(value ?? 'ready').trim()
  if (!STATUSES.has(status)) throw new TrackError('轨道状态无效')
  return status
}

function sameTrack(episodeId, kind, language, edition, exceptId = null) {
  const row = db.prepare(`SELECT id FROM episode_tracks
    WHERE episode_id = ? AND kind = ? AND lower(language) = lower(?) AND edition = ?
      AND (? IS NULL OR id != ?)`)
    .get(Number(episodeId), kind, language, edition, exceptId, exceptId)
  return row
}

export function listEpisodeTracks(episodeId) {
  return db.prepare(`SELECT * FROM episode_tracks
    WHERE episode_id = ?
    ORDER BY kind, is_default DESC, language, edition`).all(Number(episodeId))
}

function preferredOf(tracks, lang, { subtitle = false } = {}) {
  if (!tracks.length) return null
  const base = String(lang ?? '').trim().toLowerCase().split('-')[0]
  const match = (base && tracks.find((track) => {
    const value = String(track.language ?? '').toLowerCase()
    return value === base || value.startsWith(`${base}-`)
  })) || tracks.find((track) => Number(track.is_default) === 1) || (subtitle ? null : tracks[0])
  return match ? { id: match.id, language: match.language, edition: match.edition } : null
}

export function publicTracksOf(episodeId, lang = 'zh') {
  const rows = listEpisodeTracks(episodeId)
  const publicTrack = (row) => ({
    id: row.id,
    language: row.language,
    edition: row.edition,
    label: row.label,
    source: row.source ?? '',
    default: Number(row.is_default) === 1,
    status: row.status,
  })
  const audioTracks = rows.filter((row) => row.kind === 'audio').map(publicTrack)
  const subtitleTracks = rows.filter((row) => row.kind === 'subtitle').map(publicTrack)
  return {
    audioTracks,
    subtitleTracks,
    preferredAudio: preferredOf(audioTracks, lang),
    preferredSubtitle: preferredOf(subtitleTracks, lang, { subtitle: true }),
  }
}

export function createTrack(input = {}) {
  const episodeId = Number(input.episodeId)
  if (!Number.isInteger(episodeId) || episodeId <= 0) throw new TrackError('分集 ID 无效')
  if (!db.prepare('SELECT id FROM episodes WHERE id = ?').get(episodeId)) throw new TrackError('分集不存在', 404)

  const kind = kindOf(input.kind)
  const language = languageOf(input.language)
  const edition = editionOf(input.edition)
  const label = text(input.label, '展示名', { required: true, max: 80 })
  const source = text(input.source, '来源', { max: 120 })
  const uri = text(input.uri, 'URI', { required: true, max: 500 })
  const isDefault = Boolean(input.isDefault)
  const status = statusOf(input.status)
  if (sameTrack(episodeId, kind, language, edition)) throw new TrackError('同语言同版本轨道已存在', 409)

  db.exec('BEGIN')
  try {
    if (isDefault) db.prepare('UPDATE episode_tracks SET is_default = 0 WHERE episode_id = ? AND kind = ?').run(episodeId, kind)
    const info = db.prepare(`INSERT INTO episode_tracks
      (episode_id, kind, language, edition, label, source, uri, is_default, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(episodeId, kind, language, edition, label, source || null, uri, isDefault ? 1 : 0, status)
    db.exec('COMMIT')
    return db.prepare('SELECT * FROM episode_tracks WHERE id = ?').get(Number(info.lastInsertRowid))
  } catch (error) {
    db.exec('ROLLBACK')
    if (String(error.message).includes('UNIQUE')) throw new TrackError('同语言同版本轨道已存在', 409)
    throw error
  }
}

export function updateTrack(id, input = {}) {
  const trackId = Number(id)
  const before = db.prepare('SELECT * FROM episode_tracks WHERE id = ?').get(trackId)
  if (!before) throw new TrackError('轨道不存在', 404)

  const kind = input.kind === undefined ? before.kind : kindOf(input.kind)
  const language = input.language === undefined ? before.language : languageOf(input.language)
  const edition = input.edition === undefined ? before.edition : editionOf(input.edition)
  const label = input.label === undefined ? before.label : text(input.label, '展示名', { required: true, max: 80 })
  const source = input.source === undefined ? before.source : text(input.source, '来源', { max: 120 })
  const uri = input.uri === undefined ? before.uri : text(input.uri, 'URI', { required: true, max: 500 })
  const isDefault = input.isDefault === undefined ? Number(before.is_default) === 1 : Boolean(input.isDefault)
  const status = input.status === undefined ? before.status : statusOf(input.status)
  const duplicate = sameTrack(before.episode_id, kind, language, edition, trackId)
  if (duplicate) throw new TrackError('同语言同版本轨道已存在', 409)

  db.exec('BEGIN')
  try {
    if (isDefault) db.prepare('UPDATE episode_tracks SET is_default = 0 WHERE episode_id = ? AND kind = ?').run(before.episode_id, kind)
    db.prepare(`UPDATE episode_tracks SET kind = ?, language = ?, edition = ?, label = ?, source = ?,
      uri = ?, is_default = ?, status = ? WHERE id = ?`)
      .run(kind, language, edition, label, source || null, uri, isDefault ? 1 : 0, status, trackId)
    db.exec('COMMIT')
    return db.prepare('SELECT * FROM episode_tracks WHERE id = ?').get(trackId)
  } catch (error) {
    db.exec('ROLLBACK')
    if (String(error.message).includes('UNIQUE')) throw new TrackError('同语言同版本轨道已存在', 409)
    throw error
  }
}

export function deleteTrack(id) {
  const trackId = Number(id)
  const before = db.prepare('SELECT * FROM episode_tracks WHERE id = ?').get(trackId)
  if (!before) throw new TrackError('轨道不存在', 404)
  if (Number(before.is_default) === 1) {
    const others = db.prepare('SELECT COUNT(*) AS n FROM episode_tracks WHERE episode_id = ? AND kind = ? AND id != ?')
      .get(before.episode_id, before.kind, trackId).n
    if (Number(others) > 0) throw new TrackError('请先指定新的默认轨道', 409)
  }
  db.prepare('DELETE FROM episode_tracks WHERE id = ?').run(trackId)
  return before
}

function preferenceOf(row) {
  if (!row) return null
  return Number(row.off) === 1 ? 'off' : { language: row.language, edition: row.edition }
}

export function userTrackPreferences(userId, dramaId) {
  const result = { audio: null, subtitle: null }
  for (const row of db.prepare('SELECT * FROM user_track_preferences WHERE user_id = ? AND drama_id = ?')
    .all(Number(userId), Number(dramaId))) {
    result[row.kind] = preferenceOf(row)
  }
  return result
}

export function saveUserTrackPreference({ userId, dramaId, kind, language, edition, off = false } = {}) {
  const id = Number(dramaId)
  if (!Number.isInteger(id) || id <= 0) throw new TrackError('剧集 ID 无效')
  if (!db.prepare('SELECT id FROM dramas WHERE id = ?').get(id)) throw new TrackError('剧集不存在', 404)
  const trackKind = kindOf(kind)
  if (off && trackKind !== 'subtitle') throw new TrackError('只有字幕可以关闭')

  let nextLanguage = ''
  let nextEdition = ''
  if (!off) {
    nextLanguage = languageOf(language)
    nextEdition = editionOf(edition)
    const track = db.prepare(`SELECT t.id FROM episode_tracks t
      JOIN episodes e ON e.id = t.episode_id
      WHERE e.drama_id = ? AND t.kind = ? AND lower(t.language) = lower(?) AND t.edition = ?
      LIMIT 1`).get(id, trackKind, nextLanguage, nextEdition)
    if (!track) throw new TrackError('轨道不存在', 404)
  }

  db.prepare(`INSERT INTO user_track_preferences (user_id, drama_id, kind, language, edition, off)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, drama_id, kind) DO UPDATE SET
      language = excluded.language, edition = excluded.edition, off = excluded.off, updated_at = datetime('now')`)
    .run(Number(userId), id, trackKind, nextLanguage, nextEdition, off ? 1 : 0)
  return { kind: trackKind, preference: off ? 'off' : { language: nextLanguage, edition: nextEdition } }
}
