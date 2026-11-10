#!/usr/bin/env node
/**
 * 按 data/catalog.json 重新绑定剧目标签（合并而非覆盖），用于恢复被「设置标签」接口覆盖掉的绑定。
 * 用法：node scripts/rebind-tags.mjs [--dry]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, ROOT } from '../server/db.mjs'

const dry = process.argv.includes('--dry')
const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8'))

function upsertTag(name) {
  const found = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)
  if (found) return Number(found.id)
  const info = db.prepare("INSERT INTO tags (name, sort, status) VALUES (?, 100, 'active')").run(name)
  return Number(info.lastInsertRowid)
}

let bound = 0
let skipped = 0
for (const entry of catalog.dramas ?? []) {
  const drama = db.prepare('SELECT id, title FROM dramas WHERE title = ?').get(entry.title)
  if (!drama) {
    console.log(`跳过 ${entry.title}：库中无此剧`)
    skipped += 1
    continue
  }
  const existing = new Set(db.prepare('SELECT tag_id FROM drama_tags WHERE drama_id = ?').all(drama.id).map((row) => Number(row.tag_id)))
  for (const name of entry.tags ?? []) {
    const tagId = dry ? 0 : upsertTag(name)
    if (dry) { console.log(`[dry] ${drama.title} ← ${name}`); continue }
    if (existing.has(tagId)) continue
    db.prepare('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)').run(drama.id, tagId)
    existing.add(tagId)
    bound += 1
  }
  console.log(`${drama.title}: 标签 ${existing.size} 个`)
}

const total = db.prepare('SELECT COUNT(*) AS n FROM drama_tags').get().n
console.log(dry ? '[dry] 未写入' : `新增绑定 ${bound} 条，drama_tags 总计 ${total} 条，跳过 ${skipped} 部`)
