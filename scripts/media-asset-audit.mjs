#!/usr/bin/env node
/**
 * media_assets 回填 + 缺口体检（只读默认，--apply 才写库）。
 *
 * 目的：把 storage/images 下已生成的变体登记进 media_assets，并输出「源图存在但 w640 缺失」
 * 的清单，让每日构建只补真正的缺口，而不是遍历 14950 张图。
 *
 * 用法：
 *   node scripts/media-asset-audit.mjs                    # 体检：统计缺口，不写库
 *   node scripts/media-asset-audit.mjs --apply            # 把现存变体登记进 media_assets（幂等 upsert）
 *   node scripts/media-asset-audit.mjs --apply --dir storage/images
 *
 * 幂等：UNIQUE(src_path, width)，重跑只更新时间戳与字节数。
 * 注意：本脚本不生成图片，缺口补建仍由 scripts/build-image-variants.mjs 负责。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

const IMG_DIR = resolve(process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1]
  : 'storage/images')
const DB_PATH = process.env.MH_DB ?? resolve('storage/app.db')
const APPLY = process.argv.includes('--apply')

const VARIANT_RE = /^(.+)-w(\d+)\.webp$/
const KIND_OF = (name) =>
  name.startsWith('cover-') ? 'cover'
  : name.startsWith('banner-') ? 'banner'
  : name.startsWith('poster-') ? 'poster'
  : name.startsWith('preview-') ? 'preview'
  : 'other'

function sourceOf(variantName) {
  const match = VARIANT_RE.exec(variantName)
  if (!match) return null
  return { base: `${match[1]}.jpg`, width: Number(match[2]) }
}

const variantsDir = join(IMG_DIR, 'variants')
if (!existsSync(variantsDir)) {
  console.error(`没有变体目录：${variantsDir}`)
  process.exit(2)
}

const sourceFiles = new Set(
  readdirSync(IMG_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ['.jpg', '.jpeg', '.png'].includes(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
)

const rows = []
const missingBySource = new Map()
for (const name of readdirSync(variantsDir)) {
  const parsed = sourceOf(name)
  if (!parsed) continue
  if (!sourceFiles.has(parsed.base)) {
    // 源图没了但变体还在：孤儿。源图可能已迁到别处，仅统计不删。
    missingBySource.set(`${parsed.base}#orphan`, (missingBySource.get(`${parsed.base}#orphan`) ?? 0) + 1)
    continue
  }
  const stat = statSync(join(variantsDir, name))
  rows.push({
    srcPath: parsed.base,
    kind: KIND_OF(parsed.base),
    width: parsed.width,
    variantPath: `variants/${name}`,
    bytes: stat.size,
    srcMtime: Math.floor(statSync(join(IMG_DIR, parsed.base)).mtimeMs / 1000),
  })
}

// 源图有、但 w640 没有：每日构建要补的目标集合
const have640 = new Set(rows.filter((row) => row.width === 640).map((row) => row.srcPath))
const gap = [...sourceFiles].filter((name) => !have640.has(name))

const byKind = rows.reduce((acc, row) => {
  const key = `${row.kind}/w${row.width}`
  acc[key] = (acc[key] ?? 0) + 1
  return acc
}, {})

console.log(`变体文件：${rows.length} 条；源图：${sourceFiles.size} 张；w640 缺口：${gap.length}`)
console.log('按类型统计：', byKind)
console.log('w640 缺口样例：', gap.slice(0, 10))

if (!APPLY) {
  console.log('（只读模式；加 --apply 写库）')
  process.exit(0)
}

const db = new DatabaseSync(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS media_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src_path TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other',
    width INTEGER NOT NULL,
    height INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    variant_path TEXT NOT NULL DEFAULT '',
    content_type TEXT NOT NULL DEFAULT 'image/webp',
    built_at TEXT NOT NULL DEFAULT (datetime('now')),
    src_mtime INTEGER NOT NULL DEFAULT 0,
    UNIQUE (src_path, width)
  )`)
const upsert = db.prepare(`INSERT INTO media_assets (src_path, kind, width, bytes, variant_path, src_mtime)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (src_path, width) DO UPDATE SET
    bytes = excluded.bytes, variant_path = excluded.variant_path,
    src_mtime = excluded.src_mtime, built_at = datetime('now')`)
db.exec('BEGIN')
try {
  for (const row of rows) upsert.run(row.srcPath, row.kind, row.width, row.bytes, row.variantPath, row.srcMtime)
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}
const total = db.prepare('SELECT COUNT(*) AS n FROM media_assets').get().n
db.close()
console.log(`已登记 ${rows.length} 条，media_assets 现有 ${total} 行`)
