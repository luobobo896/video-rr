/**
 * 黄果短剧（huangguoai.com）批量导入。
 *
 * 站点是服务端渲染 + 接口加密，但详情页里内嵌了 videoInitialData，
 * 剧名/封面/简介/标签/集数全在里面，不需要破解接口就能拿元数据。
 * 播放地址不落库：episodes.remote_url 只存 huangguo://<videoId>/<ep>，
 * 播放时由 server/stream-proxy.mjs 现调播放接口换票（见 server/huangguo.mjs）。
 *
 *   node scripts/huangguo-import.mjs --page /original/ --pages 7
 *   node scripts/huangguo-import.mjs --id 12166 --id 13692
 *   node scripts/huangguo-import.mjs --page /tag/dushi/ --pages 5 --limit 60 --no-images
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { db } from '../server/db.mjs'
import {
  HG_BASE,
  decryptHuangguoImage,
  fetchHuangguoPage,
  hgRefOf,
  parseHuangguoList,
  parseHuangguoPage,
} from '../server/huangguo.mjs'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMG_DIR = join(ROOT, 'storage', 'images')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const valueOf = (name, fallback = '') => {
  const i = argv.indexOf(name)
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : fallback
}
const valuesOf = (name) => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1])
    if (argv[i].startsWith(name + '=')) out.push(argv[i].slice(name.length + 1))
  }
  return out
}

const pagePath = valueOf('--page')
const pageCount = Number(valueOf('--pages', '1')) || 1
const startPage = Number(valueOf('--start-page', '1')) || 1
const limit = Number(valueOf('--limit', '0')) || 0
const dry = flags.has('--dry')
const skipImages = flags.has('--no-images')
const skipExisting = flags.has('--skip-existing')
const concurrency = Math.max(1, Math.min(8, Number(valueOf('--concurrency', '4')) || 4))
const allTags = flags.has('--tags')
const discover = flags.has('--discover')
const idsFile = valueOf('--ids-file')

// /tag/<slug>/ 下的全部题材；--tags 时逐个翻页收集（--discover 会从站点导航抓全量）
const TAG_SLUGS = [
  'dushi', 'gufeng', 'qihuan', 'xiandai', 'zhichang', 'nixi', 'xiaoyuan', 'lvmao', 'shunv', 'muzi',
  'luanlun', 'xitong', 'xianxia', 'hougong', 'dananzhu', 'xingzhuan', 'naodong', 'xuanyi', 'ntr', 'wuxia',
  'sm', 'nantong', 'nuelian', 'chuanyue', 'chaonengli', 'tianchong', 'nvtong', 'xiangcun', 'tongxue',
  'nianxia', 'tongshi', 'mori', 'bazong', 'youxi', 'lingyi', 'yulequan', 'wanghong', 'jiedi', 'fanzui',
  'renqi', 'xiongmei', 'haomen', 'quanmou',
]

// 站点导航里出现过、但上面还没收录的题材，--discover 时从种子页补
const DISCOVER_SEEDS = ['/', '/tag/dushi/', '/tag/xiandai/', '/tag/sm/', '/tag/nantong/']

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 列表页第 n 页的地址：原创页 /original/2/，题材页 /tag/dushi/page/2/ */
function listUrl(base, n) {
  const clean = '/' + base.replace(/^\/+|\/+$/g, '')
  if (n <= 1) return clean + '/'
  const tag = clean.match(/^\/tag\/([a-z0-9-]+)$/)
  if (tag) return `/tag/${tag[1]}/page/${n}/`
  return `${clean}/${n}/`
}

function readIdsFile(path) {
  const text = readFileSync(path, 'utf8').trim()
  const raw = text.startsWith('[') ? JSON.parse(text) : text.split(/[\s,]+/)
  return raw.map(Number).filter((n) => Number.isInteger(n) && n > 0)
}

/** 从站点导航抓全部题材，避免内置清单漏掉新增标签 */
async function discoverSlugs() {
  const slugs = new Set(TAG_SLUGS)
  for (const seed of DISCOVER_SEEDS) {
    try {
      const html = await fetchHuangguoPage(seed)
      for (const m of html.matchAll(/\/tag\/([a-z0-9-]+)\//g)) slugs.add(m[1])
    } catch {
      // 单页失败不影响其它种子
    }
  }
  return [...slugs]
}

async function collectIds() {
  const ids = new Set()
  const direct = valuesOf('--id').map(Number).filter((n) => Number.isInteger(n) && n > 0)
  for (const id of direct) ids.add(id)
  if (idsFile) for (const id of readIdsFile(idsFile)) ids.add(id)
  const crawl = async (base) => {
    for (let n = startPage; n < startPage + pageCount; n++) {
      const path = listUrl(base, n)
      try {
        const html = await fetchHuangguoPage(path)
        const found = parseHuangguoList(html)
        for (const id of found) ids.add(id)
        process.stdout.write(`  列表 ${path} → ${found.length} 部（累计 ${ids.size}）\n`)
        if (!found.length) break
      } catch (err) {
        process.stdout.write(`  列表 ${path} 失败：${err.message}\n`)
        break
      }
      await sleep(200)
    }
  }
  if (pagePath) await crawl(pagePath)
  if (allTags || discover) {
    const slugs = discover ? await discoverSlugs() : TAG_SLUGS
    for (const slug of slugs) await crawl(`/tag/${slug}/`)
  }
  return [...ids]
}

async function downloadTo(url, dest) {
  if (!url) return ''
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: HG_BASE + '/' }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`image ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024) throw new Error('image too small')
  writeFileSync(dest, buf)
  return dest
}

/** 拉封面 → 解密（站点图片是 AES 密文）→ 统一转成 3:4 竖版 JPEG */
async function saveCover(url, dest, rawDest) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: HG_BASE + '/' }, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`image ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1024) throw new Error('image too small')
  writeFileSync(rawDest, decryptHuangguoImage(buf))
  await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', rawDest,
    '-vf', 'scale=720:-2',
    '-q:v', '3', dest,
  ])
  return `/media/images/${dest.split(/[\\/]/).pop()}`
}

async function makeBanner(coverPath, bannerPath) {
  await exec('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', coverPath,
    '-vf', 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900',
    '-q:v', '3', bannerPath,
  ])
}

async function grabArtwork(meta) {
  const out = { cover: '', banner: '' }
  if (!mkdirSyncSafe()) return out
  const slug = `hg-${meta.videoId}`
  const coverPath = join(IMG_DIR, `cover-${slug}.jpg`)
  const rawPath = join(IMG_DIR, `.raw-${slug}`)
  try {
    out.cover = await saveCover(meta.cover, coverPath, rawPath)
  } catch (err) {
    process.stdout.write(`    封面失败：${err.message}\n`)
    return out
  } finally {
    try {
      rmSync(rawPath, { force: true })
    } catch {
      // 忽略
    }
  }
  const bannerPath = join(IMG_DIR, `banner-${slug}.jpg`)
  try {
    await makeBanner(coverPath, bannerPath)
    out.banner = `/media/images/banner-${slug}.jpg`
  } catch {
    out.banner = out.cover
  }
  return out
}

function mkdirSyncSafe() {
  try {
    if (!existsSync(IMG_DIR)) mkdirSync(IMG_DIR, { recursive: true })
    return true
  } catch {
    return false
  }
}

// 短剧题材词（大男主/都市/系统/逆袭…）在原有的成人标签树里没有，
// 新词统一挂到自建的「短劇」根分组下，避免污染 jable 那套 8 个分组。
const DRAMA_ROOT = '短劇'

function rootTagId() {
  const row = one('SELECT id FROM tags WHERE name = ?', DRAMA_ROOT)
  if (row) return row.id
  const info = run(
    "INSERT INTO tags (name, scope, sort, status, parent_id, updated_at) VALUES (?, 'adult', 90, 'active', NULL, datetime('now'))",
    DRAMA_ROOT,
  )
  return Number(info.lastInsertRowid)
}

function createTag(label) {
  run(
    "INSERT OR IGNORE INTO tags (name, scope, sort, status, parent_id, updated_at) VALUES (?, 'adult', 100, 'active', ?, datetime('now'))",
    label, rootTagId(),
  )
  return one('SELECT id FROM tags WHERE name = ?', label)?.id ?? 0
}

function matchTag(name) {
  const label = String(name || '').trim()
  if (!label) return 0
  const exact = one("SELECT id FROM tags WHERE name = ? AND scope = 'adult'", label)
  if (exact) return exact.id
  const loose = one(
    "SELECT id FROM tags WHERE scope = 'adult' AND (name LIKE ? OR ? LIKE '%' || name || '%') ORDER BY length(name) DESC LIMIT 1",
    `%${label}%`, label,
  )
  return loose ? loose.id : createTag(label)
}

function linkTags(dramaId, names) {
  let linked = 0
  for (const name of names) {
    const tagId = matchTag(name)
    if (!tagId) continue
    run('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)', dramaId, tagId)
    linked++
  }
  return linked
}

function descriptionOf(meta) {
  const parts = []
  if (meta.description) parts.push(meta.description)
  if (meta.author) parts.push(`出品：${meta.author}`)
  if (meta.tags.length) parts.push(`標籤：${meta.tags.join('、')}`)
  parts.push(`番號：${meta.sourceKey} · 共 ${meta.totalEpisodes} 集`)
  return parts.join('\n')
}

function upsertDrama(meta, artwork) {
  const key = meta.sourceKey
  const existing = one('SELECT * FROM dramas WHERE source_key = ? ORDER BY id LIMIT 1', key)
  const coverUrl = artwork.cover || meta.cover
  const year = Number((meta.publishedAt || '').slice(0, 4)) || null
  const releaseDate = (meta.publishedAt || '').slice(0, 10) || null
  const subtitle = [meta.typeName || 'AI短剧', meta.author].filter(Boolean).join(' · ')
  const description = descriptionOf(meta)

  if (existing) {
    const keepBlurb = String(existing.description ?? '').startsWith('簡介：')
    run(
      `UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?,
        category = 'PLAYLET', content_type = 'drama', is_adult = 1, release_date = ?,
        status = 'published', published_at = COALESCE(published_at, ?), updated_at = datetime('now')
       WHERE id = ?`,
      meta.title, subtitle, coverUrl, keepBlurb ? existing.description : description, year, '中国',
      releaseDate, releaseDate, existing.id,
    )
    return { id: existing.id, created: false }
  }
  const info = run(
    `INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category,
      content_type, is_adult, release_date, status, published_at, sort, source_key)
     VALUES (?, ?, ?, ?, ?, '中国', 'PLAYLET', 'drama', 1, ?, 'published', ?, 0, ?)`,
    meta.title, subtitle, coverUrl, description, year, releaseDate, releaseDate, key,
  )
  return { id: Number(info.lastInsertRowid), created: true }
}

function upsertEpisodes(dramaId, meta) {
  let written = 0
  for (const ep of meta.episodeNos) {
    const duration = Number(meta.episodeDurations?.[ep]) || 0
    run(
      `INSERT INTO episodes (drama_id, no, title, duration, remote_url, remote_referer, remote_ua, remote_cookie, status, progress)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', 'ready', 100)
       ON CONFLICT(drama_id, no) DO UPDATE SET
         remote_url = excluded.remote_url,
         remote_referer = excluded.remote_referer,
         remote_ua = excluded.remote_ua,
         duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE episodes.duration END,
         status = 'ready', error = NULL, progress = 100`,
      dramaId, ep, `第 ${ep} 集`, duration, hgRefOf(meta.videoId, ep), HG_BASE + '/', UA,
    )
    written++
  }
  return written
}

/** 站内换 id 重发的同一部片：标题、集数相同且总时长差 <= 3s */
function findTwin(meta) {
  const eps = meta.episodeNos.length
  const total = meta.episodeNos.reduce((sum, n) => sum + (Number(meta.episodeDurations?.[n]) || 0), 0)
  if (!eps || !total) return null
  const rows = all(
    `SELECT d.id, d.source_key,
       (SELECT COUNT(*) FROM episodes e WHERE e.drama_id = d.id) AS eps,
       (SELECT COALESCE(SUM(duration), 0) FROM episodes e WHERE e.drama_id = d.id) AS secs
     FROM dramas d WHERE d.title = ? AND d.source_key LIKE 'huangguo:%'`,
    meta.title,
  )
  return rows.find((r) => r.eps === eps && Math.abs(Number(r.secs) - total) <= 3 && r.source_key !== meta.sourceKey) || null
}

async function importOne(videoId) {
  const preKey = `huangguo:${videoId}`
  if (skipExisting && one('SELECT id FROM dramas WHERE source_key = ?', preKey)) {
    return { skipped: true }
  }
  const pageUrl = `${HG_BASE}/video/${videoId}/`
  const html = await fetchHuangguoPage(pageUrl)
  const meta = parseHuangguoPage(html, pageUrl)
  if (!meta) throw new Error('页面没有 videoInitialData')
  meta.sourceKey = `huangguo:${meta.videoId}`

  if (skipExisting && one('SELECT id FROM dramas WHERE source_key = ?', meta.sourceKey)) {
    return { skipped: true, meta }
  }
  if (skipExisting) {
    const twin = findTwin(meta)
    if (twin) return { duplicate: twin.source_key, meta }
  }
  const artwork = skipImages ? { cover: '', banner: '' } : await grabArtwork(meta)
  if (dry) return { dry: true, meta, artwork }

  const { id, created } = upsertDrama(meta, artwork)
  const episodes = upsertEpisodes(id, meta)
  const tags = linkTags(id, meta.tags)
  return { id, created, episodes, tags, meta }
}

async function runPool(items, worker) {
  const results = []
  let cursor = 0
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      try {
        results[index] = await worker(item, index)
      } catch (err) {
        results[index] = { error: err.message, item }
      }
    }
  })
  await Promise.all(lanes)
  return results
}

async function main() {
  const ids = await collectIds()
  if (!ids.length) {
    process.stdout.write('没有找到要导入的剧集，用 --page /original/ 或 --id 12166 指定\n')
    return
  }
  const targets = limit > 0 ? ids.slice(0, limit) : ids
  process.stdout.write(`待导入 ${targets.length} 部（并发 ${concurrency}${dry ? '，dry-run' : ''}）\n`)

  const started = Date.now()
  const results = await runPool(targets, importOne)
  let created = 0
  let updated = 0
  let skipped = 0
  let duplicates = 0
  let failed = 0
  let episodes = 0
  let tags = 0
  for (const r of results) {
    if (!r) continue
    if (r.error) {
      failed++
      process.stdout.write(`  ✗ ${r.item}：${r.error}\n`)
      continue
    }
    if (r.skipped) {
      skipped++
      continue
    }
    if (r.duplicate) {
      duplicates++
      process.stdout.write(`  ≡ ${r.meta.videoId} ${r.meta.title} 与 ${r.duplicate} 同片，跳过\n`)
      continue
    }
    if (r.dry) {
      process.stdout.write(`  · ${r.meta.videoId} ${r.meta.title} / ${r.meta.totalEpisodes} 集 / ${r.meta.tags.join(',')}\n`)
      continue
    }
    if (r.created) created++
    else updated++
    episodes += r.episodes
    tags += r.tags
    process.stdout.write(`  ✓ #${r.id} ${r.meta.title} / ${r.episodes} 集 / ${r.tags} 标签\n`)
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  process.stdout.write(
    `\n完成：新增 ${created} · 更新 ${updated} · 跳过 ${skipped} · 同片重复 ${duplicates} · 失败 ${failed} · 剧集 ${episodes} 条 · 标签关联 ${tags} · ${seconds}s\n`,
  )
}

await main()
db.close?.()
