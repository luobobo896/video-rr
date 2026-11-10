/** 标签：C 端筛选与详情展示，B 端 CRUD 与剧集打标。 */
import { db } from './db.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

export function listTags({ withCount = false } = {}) {
  const rows = all('SELECT * FROM tags ORDER BY sort, id')
  if (!withCount) return rows
  const counts = new Map(all(`SELECT tag_id, COUNT(*) AS n FROM drama_tags GROUP BY tag_id`).map((row) => [row.tag_id, row.n]))
  return rows.map((row) => ({ ...row, dramaCount: counts.get(row.id) ?? 0 }))
}

export function createTag({ name, sort = 100, status = 'active' }) {
  const trimmed = String(name ?? '').trim()
  if (trimmed.length < 1 || trimmed.length > 20) throw Object.assign(new Error('标签名需 1–20 字'), { status: 400 })
  const existing = one('SELECT * FROM tags WHERE name = ?', trimmed)
  if (existing) return existing
  const info = db.prepare('INSERT INTO tags (name, sort, status) VALUES (?, ?, ?)').run(trimmed, Number(sort), status)
  return one('SELECT * FROM tags WHERE id = ?', Number(info.lastInsertRowid))
}

export function updateTag(id, patch) {
  const tag = one('SELECT * FROM tags WHERE id = ?', Number(id))
  if (!tag) throw Object.assign(new Error('标签不存在'), { status: 404 })
  const name = patch.name !== undefined ? String(patch.name).trim() : tag.name
  const sort = patch.sort !== undefined ? Number(patch.sort) : tag.sort
  const status = patch.status ?? tag.status
  db.prepare('UPDATE tags SET name = ?, sort = ?, status = ? WHERE id = ?').run(name, sort, status, Number(id))
  return one('SELECT * FROM tags WHERE id = ?', Number(id))
}

export function deleteTag(id) {
  db.prepare('DELETE FROM tags WHERE id = ?').run(Number(id))
}

export function tagsOfDrama(dramaId) {
  return all(`SELECT t.* FROM tags t JOIN drama_tags dt ON dt.tag_id = t.id
    WHERE dt.drama_id = ? AND t.status = 'active' ORDER BY t.sort, t.id`, Number(dramaId))
}

export function setDramaTags(dramaId, tagIds) {
  const ids = [...new Set((tagIds ?? []).map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM drama_tags WHERE drama_id = ?').run(Number(dramaId))
    const insert = db.prepare('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)')
    for (const tagId of ids) {
      if (one('SELECT 1 AS x FROM tags WHERE id = ?', tagId)) insert.run(Number(dramaId), tagId)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return tagsOfDrama(dramaId)
}

export function dramaIdsByTag(tagId) {
  return all('SELECT drama_id FROM drama_tags WHERE tag_id = ?', Number(tagId)).map((row) => row.drama_id)
}
