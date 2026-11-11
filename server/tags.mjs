/**
 * 标签：C 端筛选与详情展示，B 端 CRUD / 层级 / 启停 / 分页 / 剧集打标。
 * 层级只用 parent_id 自关联（一级 parent_id=null，二级挂一级），不做三级以上。
 */
import { db } from './db.mjs'
import { adultVisibilitySql } from './content-visibility.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

const bad = (message, status = 400) => Object.assign(new Error(message), { status })

/**
 * 列表。
 * @param {object} options
 * @param {boolean} [options.withCount] 附带剧集数量
 * @param {boolean} [options.includeDisabled] 后台需要看到被停用的标签
 * @param {number} [options.page] 从 1 开始，配合 pageSize 分页
 * @param {number} [options.pageSize]
 * @param {string} [options.keyword]
 * @param {'top'|'child'|'all'} [options.level]
 * @param {number} [options.parentId] 只看某个一级标签下的二级
 */
export function listTags({ withCount = false, includeDisabled = false, publicOnly = false, scope = 'general', page, pageSize, keyword, level = 'all', parentId } = {}) {
  const p = withCount ? 't.' : ''
  const clauses = []
  const args = []
  if (scope !== 'all') {
    clauses.push(`${p}scope = ?`)
    args.push(scope)
  }
  if (!includeDisabled) clauses.push(`${p}status = 'active'`)
  if (keyword) {
    clauses.push(`${p}name LIKE ?`)
    args.push(`%${String(keyword).trim()}%`)
  }
  if (level === 'top') clauses.push(`${p}parent_id IS NULL`)
  if (level === 'child') clauses.push(`${p}parent_id IS NOT NULL`)
  if (parentId !== undefined && parentId !== null && parentId !== '') {
    clauses.push(`${p}parent_id = ?`)
    args.push(Number(parentId))
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const order = `ORDER BY COALESCE(${p}parent_id, ${p}id), ${p}parent_id IS NOT NULL, ${p}sort, ${p}id`

  const countJoin = publicOnly
    ? `JOIN dramas d ON d.id = dt.drama_id AND d.status = 'published' AND ${adultVisibilitySql(scope === 'adult' ? 'adult' : 'general')}`
    : ''
  const sql = withCount
    ? `SELECT t.*, (SELECT COUNT(*) FROM drama_tags dt ${countJoin} WHERE dt.tag_id = t.id) AS drama_count FROM tags t ${where} ${order}`
    : `SELECT * FROM tags ${where} ${order}`

  const rows = all(sql, ...args).map((row) => (withCount ? { ...row, dramaCount: row.drama_count ?? 0 } : row))
  if (!page) return rows
  const size = Math.min(200, Math.max(1, Number(pageSize) || 20))
  const start = (Math.max(1, Number(page)) - 1) * size
  return { total: rows.length, page: Number(page), pageSize: size, list: rows.slice(start, start + size) }
}

/** 一级/二级树，后台标签管理页直接用。 */
export function tagTree({ includeDisabled = true, withCount = true, scope = 'general' } = {}) {
  const rows = listTags({ withCount, includeDisabled, scope })
  const list = Array.isArray(rows) ? rows : rows.list
  const tops = list.filter((row) => !row.parent_id)
  const children = new Map()
  for (const row of list) {
    if (!row.parent_id) continue
    if (!children.has(row.parent_id)) children.set(row.parent_id, [])
    children.get(row.parent_id).push(row)
  }
  return tops.map((row) => ({ ...row, children: children.get(row.id) ?? [] }))
}

function normalizeParent(parentId, selfId, scope) {
  if (parentId === undefined || parentId === null || parentId === '' || Number(parentId) === 0) return null
  const id = Number(parentId)
  if (!Number.isFinite(id)) throw bad('上级标签不合法')
  if (selfId && id === Number(selfId)) throw bad('不能把自己设为上级')
  const parent = one('SELECT id, parent_id, scope FROM tags WHERE id = ?', id)
  if (!parent) throw bad('上级标签不存在', 404)
  if (parent.scope !== scope) throw bad('上级标签与当前标签类型不一致')
  if (parent.parent_id) throw bad('只支持两级标签：二级标签下不能再挂标签')
  return id
}

export function createTag({ name, sort = 100, status = 'active', parentId = null, scope = 'general' }) {
  if (!['general', 'adult'].includes(scope)) throw bad('标签类型不合法')
  const trimmed = String(name ?? '').trim()
  if (trimmed.length < 1 || trimmed.length > 20) throw bad('标签名需 1–20 字')
  const existing = one('SELECT * FROM tags WHERE name = ?', trimmed)
  if (existing) {
    if (existing.scope !== scope) throw bad('同名标签已存在于其他分类')
    return existing
  }
  const parent = normalizeParent(parentId, null, scope)
  const info = db
    .prepare("INSERT INTO tags (name, scope, sort, status, parent_id, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))")
    .run(trimmed, scope, Number(sort) || 100, status === 'disabled' ? 'disabled' : 'active', parent)
  return one('SELECT * FROM tags WHERE id = ?', Number(info.lastInsertRowid))
}

export function updateTag(id, patch = {}) {
  const tag = one('SELECT * FROM tags WHERE id = ?', Number(id))
  if (!tag) throw bad('标签不存在', 404)
  if (patch.scope !== undefined && patch.scope !== tag.scope) throw bad('标签类型不可修改')
  const name = patch.name !== undefined ? String(patch.name).trim() : tag.name
  if (!name || name.length > 20) throw bad('标签名需 1–20 字')
  const dup = one('SELECT id FROM tags WHERE name = ? AND id <> ?', name, Number(id))
  if (dup) throw bad('标签名重复')
  const sort = patch.sort !== undefined ? Number(patch.sort) || 0 : tag.sort
  const status = patch.status !== undefined ? (patch.status === 'disabled' ? 'disabled' : 'active') : tag.status
  const parent = patch.parentId !== undefined ? normalizeParent(patch.parentId, id, tag.scope) : tag.parent_id
  db.prepare("UPDATE tags SET name = ?, sort = ?, status = ?, parent_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(name, sort, status, parent, Number(id))
  return one('SELECT * FROM tags WHERE id = ?', Number(id))
}

/** 快速启停：列表里的开关按钮调用。 */
export function setTagStatus(id, enabled) {
  const tag = one('SELECT id FROM tags WHERE id = ?', Number(id))
  if (!tag) throw bad('标签不存在', 404)
  db.prepare("UPDATE tags SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(enabled ? 'active' : 'disabled', Number(id))
  return one('SELECT * FROM tags WHERE id = ?', Number(id))
}

export function deleteTag(id) {
  const tagId = Number(id)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('UPDATE tags SET parent_id = NULL WHERE parent_id = ?').run(tagId)
    db.prepare('DELETE FROM drama_tags WHERE tag_id = ?').run(tagId)
    db.prepare('DELETE FROM tags WHERE id = ?').run(tagId)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function tagsOfDrama(dramaId) {
  return all(`SELECT t.* FROM tags t JOIN drama_tags dt ON dt.tag_id = t.id
    WHERE dt.drama_id = ? AND t.status = 'active' ORDER BY COALESCE(t.parent_id, t.id), t.sort, t.id`, Number(dramaId))
}

export function setDramaTags(dramaId, tagIds) {
  const drama = one('SELECT is_adult FROM dramas WHERE id = ?', Number(dramaId))
  if (!drama) throw bad('剧集不存在', 404)
  const scope = Number(drama.is_adult) ? 'adult' : 'general'
  const ids = [...new Set((tagIds ?? []).map(Number).filter((id) => Number.isFinite(id) && id > 0))]
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM drama_tags WHERE drama_id = ?').run(Number(dramaId))
    const insert = db.prepare('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)')
    for (const tagId of ids) {
      const tag = one('SELECT scope FROM tags WHERE id = ?', tagId)
      if (!tag) throw bad('标签不存在', 404)
      if (tag.scope !== scope) throw bad('标签类型与内容不匹配')
      insert.run(Number(dramaId), tagId)
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

/** 一级标签选中时，把它的二级标签一起带上（C 端筛选更符合预期）。 */
export function tagFamilyIds(tagId) {
  const id = Number(tagId)
  if (!Number.isFinite(id) || id <= 0) return []
  const children = all('SELECT id FROM tags WHERE parent_id = ?', id).map((row) => row.id)
  return [id, ...children]
}
