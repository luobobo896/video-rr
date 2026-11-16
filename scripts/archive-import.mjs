/**
 * 用 archive.org 公开馆藏补全「非短剧」片库。
 *
 * 站点里所有短剧（PLAYLET）都是成人内容，外层不展示；外层要有人能看的片子，
 * 就从这个刮削器补。一个 identifier = 一部片，多个视频文件 = 多集。
 * 片源走站内的远程片源代理（/media/remote/<episodeId>/…），不用下载转码，
 * 只需要把 remote_url 写进 episodes。
 *
 * 用法：
 *   node scripts/archive-import.mjs --rows 20 --limit 5 --dry      # 只看会进哪些片
 *   node scripts/archive-import.mjs --rows 20 --limit 10           # 真导入
 *   node scripts/archive-import.mjs --collection feature_films --year-from 1940 --year-to 1965
 *   node scripts/archive-import.mjs --query 'title:(chaplin)' --category MOVIE
 *   node scripts/archive-import.mjs --refresh                      # 库中已导入的重抓元数据/补集
 *
 * 解包/解析逻辑在 server/archive.mjs，那边是纯函数，测试见 test/archive.test.mjs。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '../server/db.mjs'
import {
  buildDrama, fetchArchiveItem, searchArchive, THUMB_URL,
} from '../server/archive.mjs'
import { exitCodeFor, exitCodeHint, shouldPruneEpisodes } from './lib/import-guards.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMG_DIR = join(ROOT, 'storage', 'images')
const REFERER = 'https://archive.org/'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((item) => item.startsWith('--') && !item.includes('=')))
const valueOf = (name, fallback = '') => {
  const inline = argv.find((item) => item.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const at = argv.indexOf(name)
  if (at < 0) return fallback
  const next = argv[at + 1]
  return next && !next.startsWith('--') ? next : fallback
}
const numberArg = (name, fallback) => {
  const value = Number(valueOf(name, ''))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const dry = flags.has('--dry')
const refresh = flags.has('--refresh')
const skipExisting = !flags.has('--no-skip-existing')
const noCover = flags.has('--no-cover')
const limit = numberArg('--limit', 10)
const rows = numberArg('--rows', 25)
const pages = numberArg('--pages', 1)
const minDuration = numberArg('--min-duration', 300)
const maxEpisodes = numberArg('--max-episodes', 60)
const category = valueOf('--category', '')
const query = valueOf('--query', '')
const collection = valueOf('--collection', '')
const yearFrom = numberArg('--year-from', 0)
const yearTo = numberArg('--year-to', 0)
const sort = valueOf('--sort', 'downloads desc')

// ---------- 素材 ----------
const slugOf = (identifier) => String(identifier).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

async function downloadCover(identifier, draft) {
  if (noCover) return draft.coverUrl
  mkdirSync(IMG_DIR, { recursive: true })
  const slug = slugOf(identifier)
  const dest = join(IMG_DIR, `cover-archive-${slug}.jpg`)
  if (existsSync(dest)) return `/media/images/cover-archive-${slug}.jpg`
  try {
    const response = await fetch(`${THUMB_URL}/${encodeURIComponent(identifier)}`, {
      headers: { referer: REFERER, 'user-agent': 'MH-Clone/1.0 (+archive import)' },
      signal: AbortSignal.timeout(30000),
    })
    if (!response.ok) return draft.coverUrl
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 1024) return draft.coverUrl
    writeFileSync(dest, buffer)
    return `/media/images/cover-archive-${slug}.jpg`
  } catch {
    return draft.coverUrl
  }
}

// ---------- 标签 ----------
function generalTagId(name) {
  const clean = String(name ?? '').trim().slice(0, 24)
  if (!clean) return 0
  const hit = one("SELECT id FROM tags WHERE name = ? AND scope = 'general'", clean)
  if (hit) return hit.id
  // tags.name 全局唯一：成人侧已经建过同名标签时，裸 INSERT 会抛 SQLITE_CONSTRAINT_UNIQUE
  // 把整轮导入打断，还留下写了一半的剧。冲突就复用已有 id。
  const sameName = one('SELECT id, scope FROM tags WHERE name = ? LIMIT 1', clean)
  if (sameName) return Number(sameName.id) || 0
  try {
    const info = run("INSERT INTO tags (name, scope, sort, status) VALUES (?, 'general', 100, 'active')", clean)
    return Number(info.lastInsertRowid) || 0
  } catch (error) {
    if (!/UNIQUE/i.test(String(error?.message ?? ''))) throw error
    return Number(one('SELECT id FROM tags WHERE name = ? LIMIT 1', clean)?.id) || 0
  }
}

// ---------- 入库 ----------
function existingOf(sourceKey) {
  return one('SELECT * FROM dramas WHERE source_key = ?', sourceKey)
}

function insertDrama(draft, coverUrl) {
  const info = run(
    `INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, is_adult,
       release_date, score, status, sort, content_type, source_key, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'published', 0, ?, ?, datetime('now'))`,
    draft.title, draft.subTitle, coverUrl, draft.description, draft.year, draft.area,
    draft.category, draft.adult ? 1 : 0, draft.contentType, draft.sourceKey,
  )
  return Number(info.lastInsertRowid) || 0
}

function updateDrama(id, draft, coverUrl) {
  run(
    `UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?,
       category = ?, content_type = ?, is_adult = ?, updated_at = datetime('now')
     WHERE id = ?`,
    draft.title, draft.subTitle, coverUrl, draft.description, draft.year, draft.area,
    draft.category, draft.contentType, draft.adult ? 1 : 0, id,
  )
}

function writeEpisodes(dramaId, episodes) {
  const dbNosBefore = all('SELECT no FROM episodes WHERE drama_id = ?', dramaId).map((row) => Number(row.no))
  let written = 0
  for (const episode of episodes) {
    run(
      `INSERT INTO episodes (drama_id, no, title, duration, remote_url, remote_referer, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ready')
       ON CONFLICT(drama_id, no) DO UPDATE SET
         title = excluded.title,
         duration = COALESCE(excluded.duration, episodes.duration),
         remote_url = excluded.remote_url,
         remote_referer = excluded.remote_referer,
         status = 'ready',
         error = NULL`,
      dramaId, episode.no, episode.title, episode.duration || null, episode.remoteUrl, REFERER,
    )
    written += 1
  }
  // 源站删掉条目后库里会留下播不了的幽灵集；只在「本次导出集号 ⊇ 库内集号」时清
  const exportedNos = episodes.map((episode) => episode.no)
  let pruned = 0
  if (shouldPruneEpisodes({ exportedNos, dbNos: dbNosBefore, claimedByTitle: false })) {
    for (const no of dbNosBefore) {
      if (exportedNos.includes(no)) continue
      run('DELETE FROM episodes WHERE drama_id = ? AND no = ?', dramaId, no)
      pruned += 1
    }
  }
  return { written, pruned }
}

function writeTags(dramaId, tags) {
  let written = 0
  for (const name of tags) {
    const tagId = generalTagId(name)
    if (!tagId) continue
    run('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)', dramaId, tagId)
    written += 1
  }
  return written
}

const clock = (seconds) => {
  const total = Math.round(Number(seconds) || 0)
  if (!total) return '—'
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  return hours ? `${hours}小时${minutes}分` : `${minutes}分`
}

function describe(draft) {
  return [
    `${draft.title}${draft.year ? ` (${draft.year})` : ''}`,
    `${draft.category}/${draft.contentType}`,
    draft.area || '地区未知',
    `${draft.episodes.length} 集`,
    clock(draft.durationSeconds),
    draft.licenseUrl ? '有授权' : '无授权声明',
    draft.adult ? '18+（外层隐藏）' : '',
  ].filter(Boolean).join(' · ')
}

// ---------- 主流程 ----------
const seen = new Set()
let created = 0
let updated = 0
let skipped = 0
let failed = 0
let episodeCount = 0

async function importIdentifier(identifier) {
  if (seen.has(identifier)) return 'duplicate'
  seen.add(identifier)
  const sourceKey = `archive:${identifier}`
  const before = existingOf(sourceKey)
  if (before && skipExisting && !refresh) return 'exists'

  let item
  try {
    item = await fetchArchiveItem(identifier)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${identifier} 元数据失败：${error.message}`)
    return 'failed'
  }
  if (!item) return 'gone'

  let draft
  try {
    draft = buildDrama({ identifier, metadata: item.metadata, files: item.files, category })
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${identifier} 解析失败：${error.message}`)
    return 'failed'
  }
  if (!draft) {
    skipped += 1
    console.log(`  · ${identifier} 没有可用视频文件，跳过`)
    return 'no-video'
  }
  if (draft.episodes.length > maxEpisodes) {
    skipped += 1
    console.log(`  · ${identifier} 文件过多（${draft.episodes.length} 集），跳过`)
    return 'too-many'
  }
  if (draft.durationSeconds && draft.durationSeconds < minDuration) {
    skipped += 1
    console.log(`  · ${identifier} 正片太短（${clock(draft.durationSeconds)}），当预告片跳过`)
    return 'too-short'
  }

  console.log(`  → ${describe(draft)}`)
  if (dry) {
    const sample = draft.episodes.slice(0, 3).map((episode) => `      ${String(episode.no).padStart(2, '0')} ${episode.title}`).join('\n')
    if (sample) console.log(sample)
    if (draft.episodes.length > 3) console.log(`      …共 ${draft.episodes.length} 集`)
    if (draft.licenseUrl) console.log(`      授权 ${draft.licenseUrl}`)
    return 'dry'
  }

  const coverUrl = await downloadCover(identifier, draft)
  const dramaId = before ? before.id : insertDrama(draft, coverUrl)
  if (before) {
    updateDrama(dramaId, draft, coverUrl || before.cover_url)
    updated += 1
  } else created += 1
  const written = writeEpisodes(dramaId, draft.episodes)
  episodeCount += written.written
  if (written.pruned) console.log(`  ⌄ ${identifier} 清掉源站已没有的 ${written.pruned} 集`)
  writeTags(dramaId, draft.tags)
  return before ? 'updated' : 'created'
}

// 只刷新库里已有的归档条目时不必再检索：直接按 source_key 回原条目补元数据和缺集
const refreshOnly = refresh && !query && !collection
console.log(refreshOnly
  ? `刮削 archive.org：[refresh] 库中归档条目重抓，上限 ${limit} 部${dry ? ' [dry]' : ''}`
  : `刮削 archive.org：query=${query || '(默认)'} collection=${collection || '-'} 分类=${category || '自动'} 行数=${rows} 页数=${pages} 上限=${limit}${dry ? ' [dry]' : ''}`)

let handled = 0
outer:
for (let page = 1; !refreshOnly && page <= pages; page += 1) {
  let result
  try {
    result = await searchArchive({ query, collection, yearFrom, yearTo, rows, page, sort })
  } catch (error) {
    console.log(`✗ 检索失败（第 ${page} 页）：${error.message}`)
    break
  }
  console.log(`第 ${page} 页：命中 ${result.total} 条，本页 ${result.docs.length} 条`)
  if (!result.docs.length) break
  for (const doc of result.docs) {
    if (handled >= limit) break outer
    const status = await importIdentifier(doc.identifier)
    if (status === 'created' || status === 'updated' || status === 'dry') handled += 1
  }
}

if (refreshOnly) {
  const rowsInDb = all("SELECT source_key FROM dramas WHERE source_key LIKE 'archive:%' AND status != 'hidden' ORDER BY updated_at DESC")
  console.log(`库中 ${rowsInDb.length} 条归档剧目`)
  for (const row of rowsInDb) {
    if (handled >= limit) break
    const status = await importIdentifier(String(row.source_key).slice('archive:'.length))
    if (status === 'created' || status === 'updated' || status === 'dry') handled += 1
  }
}

console.log(`\n完成：新建 ${created} · 更新 ${updated} · 跳过 ${skipped} · 失败 ${failed} · 写入 ${episodeCount} 集`)
if (created || updated) console.log('提示：外层片库现在有非成人内容了，进后台「内容」核对分类与标签，再刷新前台首页。')
// 有失败项时退出码非 0，否则计划任务看到的永远是「成功」
const exitCode = exitCodeFor({ ok: created + updated, failed })
if (exitCode) console.log(`本轮结果：${exitCodeHint(exitCode).replace(/^（|）$/g, '')}`)
process.exitCode = exitCode
