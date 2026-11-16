/**
 * 用 TMDB 补齐片库缺失的评分与年份（只填空，不覆盖已有值）。
 *
 *   node scripts/tmdb-fill.mjs --dry
 *   node scripts/tmdb-fill.mjs --category MOVIE --concurrency 4
 *   node scripts/tmdb-fill.mjs --limit 100 --category PLAYLET
 *
 * 参数：
 *   --category <CAT>   只处理某分类（默认 MOVIE，传 ALL 表示全部）
 *   --limit N          最多处理 N 部
 *   --concurrency N    并发（默认 4）
 *   --dry              只打印命中结果，不写库
 *
 * 凭据：server/tmdb.mjs 内置 Kodi 公共 key，可用 TMDB_API_KEY / TMDB_READ_TOKEN 覆盖。
 */
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const argValue = (name, fallback = '') => {
  const at = argv.indexOf(name)
  if (at < 0) return fallback
  const next = argv[at + 1]
  if (next && !next.startsWith('--')) return next
  const inline = argv.find((item) => item.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : fallback
}
const has = (name) => argv.includes(name)

const category = argValue('--category', 'MOVIE')
const adult = argValue('--adult', '0')
const limit = Number(argValue('--limit', '0')) || 0
const concurrency = Math.max(1, Number(argValue('--concurrency', '4')) || 4)
const dry = has('--dry')

const dbPath = process.env.MH_DB || 'storage/app.db'
const db = new DatabaseSync(dbPath)

const { findTmdb } = await import('../server/tmdb.mjs')

const where = ["(score IS NULL OR score = '' OR year IS NULL OR year = '')"]
const params = []
if (category && category !== 'ALL') {
  where.push('category = ?')
  params.push(category)
}
// 成人片（番号 / 短剧）在 TMDB 没有对应条目，默认跳过
if (adult === '0' || adult === '1') {
  where.push('is_adult = ?')
  params.push(Number(adult))
}
const rows = db
  .prepare(
    `SELECT id, title, sub_title, year, score, category FROM dramas
      WHERE ${where.join(' AND ')}
      ORDER BY (score IS NULL OR score = '') DESC, id`
  )
  .all(...params)
const targets = limit > 0 ? rows.slice(0, limit) : rows
console.log(`待补 ${targets.length} 部（库存 ${rows.length}，分类 ${category}，并发 ${concurrency}${dry ? '，dry-run' : ''}）`)

const update = db.prepare(
  `UPDATE dramas SET
     score = CASE WHEN score IS NULL OR score = '' THEN ? ELSE score END,
     year = CASE WHEN year IS NULL OR year = '' THEN ? ELSE year END,
     updated_at = datetime('now')
   WHERE id = ?`
)

let cursor = 0
let hit = 0
let miss = 0
let failed = 0
let updated = 0
const misses = []
const startedAt = Date.now()

await new Promise((resolve) => {
  let active = 0
  const pump = () => {
    if (cursor >= targets.length) {
      if (active === 0) resolve()
      return
    }
    const row = targets[cursor]
    cursor += 1
    active += 1
    ;(async () => {
      try {
        const found = await findTmdb(row.title, {
          subTitle: row.sub_title ?? '',
          year: row.year ? Number(row.year) : null,
          category: row.category
        })
        if (!found) {
          miss += 1
          misses.push(`${row.id} ${row.title}`)
          return
        }
        hit += 1
        const nextScore = found.score ?? null
        const nextYear = found.year ?? null
        const needScore = !row.score && nextScore
        const needYear = !row.year && nextYear
        if (!needScore && !needYear) return
        if (dry) {
          console.log(`  · ${row.id} ${row.title} → ${nextScore ?? '-'} 分 / ${nextYear ?? '-'}`)
          return
        }
        const result = update.run(nextScore, nextYear === null ? null : String(nextYear), row.id)
        updated += result.changes
      } catch (error) {
        failed += 1
        console.warn(`  ✗ ${row.id} ${row.title} ${error.message}`)
      } finally {
        active -= 1
        if (cursor % 50 === 0) console.log(`  进度 ${cursor}/${targets.length}（命中 ${hit}，更新 ${updated}）`)
        pump()
      }
    })()
  }
  for (let i = 0; i < concurrency; i += 1) pump()
  if (!targets.length) resolve()
})

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
console.log(
  `完成：命中 ${hit} · 未命中 ${miss} · 写入 ${updated} · 失败 ${failed} · ${seconds}s`
)
if (misses.length) {
  console.log(`未命中 ${misses.length} 部（前 20）：`)
  for (const line of misses.slice(0, 20)) console.log(`  - ${line}`)
}
db.close()
