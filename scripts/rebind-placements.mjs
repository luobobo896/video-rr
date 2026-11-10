/**
 * 修正楼层/榜单的编排归属。
 *
 * 背景：`import-catalog.mjs --force` 会删掉旧剧重建（剧 id 变了），而 `--keep`
 * 又会跳过楼层编排的写入，于是重建后的剧会从首页楼层和榜单里消失。
 * 本脚本按 data/catalog.json 的 slugs 顺序，把缺失的条目补回去（已有的不动）。
 *
 * 用法：
 *   node scripts/rebind-placements.mjs          # 补齐缺失的编排
 *   node scripts/rebind-placements.mjs --dry    # 只看差异，不写库
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../server/db.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DRY = process.argv.includes('--dry')
const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8'))

const idOf = new Map(db.prepare('SELECT id, title FROM dramas').all().map((row) => [row.title, row.id]))
const slugToTitle = new Map((catalog.dramas ?? []).map((drama) => [drama.slug, drama.title]))

let added = 0
let missing = 0

function ensure(kind, itemTable, ownerColumn, sortColumn, ownerId, slug, sort) {
  const title = slugToTitle.get(slug)
  const dramaId = title ? idOf.get(title) : undefined
  if (!dramaId) {
    missing += 1
    console.log(`  ! ${kind} 缺少剧:${slug}`)
    return
  }
  const existing = db.prepare(`SELECT 1 AS x FROM ${itemTable} WHERE ${ownerColumn} = ? AND drama_id = ?`).get(ownerId, dramaId)
  if (existing) return
  console.log(`  + ${kind} 补入:${slug}（drama ${dramaId}，sort ${sort}）`)
  added += 1
  if (DRY) return
  db.prepare(`INSERT INTO ${itemTable} (${ownerColumn}, drama_id, ${sortColumn}) VALUES (?, ?, ?)`).run(ownerId, dramaId, sort)
}

db.exec('BEGIN IMMEDIATE')
try {
  for (const [index, section] of (catalog.sections ?? []).entries()) {
    const row = db.prepare('SELECT id FROM sections WHERE title = ?').get(section.title)
    if (!row) {
      console.log(`  ! 楼层不存在:${section.title}（可用 --build 重建，或先在后台新建）`)
      continue
    }
    for (const [sort, slug] of (section.slugs ?? []).entries()) ensure('楼层', 'section_items', 'section_id', 'sort', row.id, slug, sort)
    void index
  }
  for (const rank of catalog.ranks ?? []) {
    const row = db.prepare('SELECT id FROM rank_lists WHERE name = ?').get(rank.name)
    if (!row) {
      console.log(`  ! 榜单不存在:${rank.name}`)
      continue
    }
    for (const [sort, slug] of (rank.slugs ?? []).entries()) ensure('榜单', 'rank_items', 'list_id', 'rank_no', row.id, slug, sort + 1)
  }
  db.exec(DRY ? 'ROLLBACK' : 'COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

console.log(`${DRY ? '（dry-run）' : ''}补齐 ${added} 条编排，缺少 ${missing} 部剧`)
if (missing > 0) process.exitCode = 1
