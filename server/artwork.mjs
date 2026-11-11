/**
 * 封面 / 横幅素材流水线。
 *
 * 三个来源，按质量从高到低：
 *   1) 已有本地文件 storage/images/cover-<slug>.jpg / banner-<slug>.jpg（导入脚本抽的帧，质量最好）
 *   2) 本地源片 storage/sources/<slug>.* 现抽一帧（导入过但没抽图的剧）
 *   3) 片源方缩略图（archive.org → https://archive.org/services/img/<identifier>），下载后本地化
 *
 * 所有素材最终都落到 storage/images/ 并回写 dramas.cover_url / banners.image，
 * 不给前端留外链（中国大陆访问 archive.org 不稳，热链会白屏）。
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { db } from './db.mjs'
import { findTmdb } from './tmdb.mjs'
import { findWikipediaArtwork } from './wikipedia.mjs'
import { logInfo, logWarn } from './logger.mjs'

const exec = promisify(execFile)
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMG_DIR = join(ROOT, 'storage', 'images')
const SRC_DIR = join(ROOT, 'storage', 'sources')
const FFMPEG = process.env.MH_FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.MH_FFPROBE ?? 'ffprobe'
const ALLOWED_IMAGE_HOSTS = new Set([
  'archive.org',
  'download.blender.org',
  'image.tmdb.org',
  'upload.wikimedia.org',
  'commons.wikimedia.org',
])
export function isAllowedRemoteImage(value) {
  try {
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    return /^https?:$/.test(parsed.protocol)
      && (ALLOWED_IMAGE_HOSTS.has(host) || host.endsWith('.archive.org'))
  } catch {
    return false
  }
}

const normalize = (text) => String(text ?? '').toLowerCase().replace(/[\s·:：\-—()（）\[\]【】]/g, '')

let catalogCache = null
function catalog() {
  if (catalogCache) return catalogCache
  try {
    catalogCache = JSON.parse(readFileSync(join(ROOT, 'data/catalog.json'), 'utf8')).dramas ?? []
  } catch {
    catalogCache = []
  }
  return catalogCache
}

/** 剧 → 片库条目：先按标题精确/包含匹配，再按片源地址里的文件名匹配。 */
export function catalogEntryOf(drama) {
  const rows = catalog()
  const key = normalize(drama?.title)
  if (!key) return null
  const exact = rows.find((row) => normalize(row.title) === key)
  if (exact) return exact
  const partial = rows.find((row) => {
    const rowKey = normalize(row.title)
    return rowKey && (rowKey.includes(key) || key.includes(rowKey))
  })
  return partial ?? null
}

function sourceFileOf(slug) {
  for (const ext of ['mp4', 'mov', 'avi', 'mkv', 'webm']) {
    const file = join(SRC_DIR, `${slug}.${ext}`)
    if (existsSync(file)) return file
  }
  return null
}

function archiveIdOf(url) {
  const match = /archive\.org\/(?:download|details|embed)\/([^/?#]+)/i.exec(String(url ?? ''))
  return match ? match[1] : ''
}

export function coverPath(slug) {
  return join(IMG_DIR, `cover-${slug}.jpg`)
}

export function bannerPath(slug) {
  return join(IMG_DIR, `banner-${slug}.jpg`)
}

const fileOk = (file) => existsSync(file) && statSync(file).size > 5000

async function grabFrame(source, percent, target, filter) {
  let duration = 0
  try {
    const { stdout } = await exec(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source])
    duration = Number(String(stdout).trim()) || 0
  } catch {
    duration = 0
  }
  const at = duration > 0 ? Math.max(0, duration * percent) : 0
  await exec(FFMPEG, ['-y', '-ss', String(at), '-i', source, '-frames:v', '1', '-vf', filter, '-q:v', '3', target])
  if (!fileOk(target)) throw new Error(`抽帧失败：${target}`)
  return statSync(target).size
}

async function downloadRemote(url, target, filter) {
  const assertAllowed = (value) => {
    if (!isAllowedRemoteImage(value)) throw new Error(`封面来源不在白名单：${value}`)
  }
  assertAllowed(url)
  let current = String(url)
  let response
  for (let redirect = 0; redirect < 4; redirect += 1) {
    response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location) break
    current = new URL(location, current).toString()
    assertAllowed(current)
  }
  if (!response.ok) throw new Error(`封面下载失败 HTTP ${response.status}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > 20 * 1024 * 1024) throw new Error('封面下载内容过大')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > 20 * 1024 * 1024) throw new Error('封面下载内容过大')
  if (buffer.length < 3000) throw new Error('封面下载内容过小')
  const tmp = `${target}.src`
  try {
    writeFileSync(tmp, buffer)
    // 统一裁成站内规格（竖版 480x720 / 横版 1600x900），避免前端比例错乱
    if (filter) await exec(FFMPEG, ['-y', '-i', tmp, '-frames:v', '1', '-vf', filter, '-q:v', '3', target])
    else await exec(FFMPEG, ['-y', '-i', tmp, '-frames:v', '1', '-q:v', '3', target])
    if (!fileOk(target)) throw new Error('封面转码失败')
    return statSync(target).size
  } finally {
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

/**
 * 确保一部剧有本地封面（必要时补横幅）。
 * @returns {Promise<{cover:string|null, banner:string|null, from:string, updated:boolean}>}
 */
export async function ensureArtwork(drama, { force = false } = {}) {
  const entry = catalogEntryOf(drama)
  const coverSlug = /\/cover-([^/?.]+)\.jpg(?:\?.*)?$/i.exec(String(drama.cover_url ?? ''))?.[1]
  const slug = String(entry?.slug ?? coverSlug ?? '').trim() || `drama-${drama.id}`
  let from = 'existing'
  let cover = !force && fileOk(coverPath(slug)) ? `/media/images/cover-${slug}.jpg` : null
  let banner = !force && fileOk(bannerPath(slug)) ? `/media/images/banner-${slug}.jpg` : null

  const source = sourceFileOf(slug)
  if (!cover && source && !force) {
    try {
      await grabFrame(source, 0.12, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
      cover = `/media/images/cover-${slug}.jpg`
      from = 'video'
    } catch { /* 继续尝试外部元数据 */ }
  }
  if (!banner && source && !force && entry?.banner !== false) {
    try {
      await grabFrame(source, 0.22, bannerPath(slug), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900')
      banner = `/media/images/banner-${slug}.jpg`
      from = 'video'
    } catch { /* ignore */ }
  }

  if (!cover || !banner) {
    const archiveId = archiveIdOf(entry?.source?.url)
    const archive = archiveId ? `https://archive.org/services/img/${encodeURIComponent(archiveId)}` : ''
    if (!cover && archive && !force) {
      try {
        await downloadRemote(archive, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'archive'
      } catch { /* continue */ }
    }
    const tmdb = await findTmdb(drama.title, {
      subTitle: drama.sub_title, year: drama.year, category: drama.category,
    }).catch(() => null)
    const wiki = (!cover || !banner)
      ? await findWikipediaArtwork(drama.title, { subTitle: drama.sub_title, year: drama.year }).catch(() => null)
      : null
    if (!cover && tmdb?.posterUrl) {
      try {
        await downloadRemote(tmdb.posterUrl, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'tmdb'
      } catch { /* continue */ }
    }
    if (!cover && /^https?:\/\//i.test(String(drama.cover_url ?? ''))) {
      try {
        await downloadRemote(drama.cover_url, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'remote'
      } catch { /* continue */ }
    }
    if (!cover && wiki?.image) {
      try {
        await downloadRemote(wiki.image, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'wikipedia'
      } catch { /* continue */ }
    }
    if (!cover && archive && force && !source) {
      try {
        await downloadRemote(archive, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'archive'
      } catch { /* continue */ }
    }
    if (!cover && source && force) {
      try {
        await grabFrame(source, 0.12, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'video'
      } catch { /* continue */ }
    }
    if (!banner && tmdb?.backdropUrl) {
      try {
        await downloadRemote(tmdb.backdropUrl, bannerPath(slug), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900')
        banner = `/media/images/banner-${slug}.jpg`
        from = 'tmdb'
      } catch { /* continue */ }
    }
    // 强制重刮是明确的人工操作：即使片库曾标记 banner:false，也要从源片补出横幅。
    if (!banner && source && force) {
      try {
        await grabFrame(source, 0.22, bannerPath(slug), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900')
        banner = `/media/images/banner-${slug}.jpg`
        from = from === 'existing' ? 'video' : from
      } catch { /* continue */ }
    }
    if (!banner && wiki?.image && (force || entry?.banner !== false)) {
      try {
        await downloadRemote(wiki.image, bannerPath(slug), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900,gblur=sigma=18')
        banner = `/media/images/banner-${slug}.jpg`
        from = from === 'existing' ? 'wikipedia' : from
      } catch { /* continue */ }
    }
    if (!banner && (tmdb?.posterUrl || archive || /^https?:\/\//i.test(String(drama.cover_url ?? ''))) && (force || entry?.banner !== false)) {
      const fallback = tmdb?.posterUrl || archive || drama.cover_url
      try {
        await downloadRemote(fallback, bannerPath(slug), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900,gblur=sigma=18')
        banner = `/media/images/banner-${slug}.jpg`
        from = from === 'existing' ? 'remote' : from
      } catch { /* continue */ }
    }
  }

  // 强制重刮失败时保留原有文件，不能让一张坏图把已可用素材删掉。
  if (!cover && fileOk(coverPath(slug))) cover = `/media/images/cover-${slug}.jpg`
  if (!banner && fileOk(bannerPath(slug))) banner = `/media/images/banner-${slug}.jpg`
  if (!cover) throw new Error('TMDB / 片库 / 源片均未找到可用海报')

  let updated = false
  const stamp = Date.now()
  if (cover) {
    const versioned = from === 'existing' ? cover : `${cover}?v=${stamp}`
    if (versioned !== drama.cover_url) {
      run('UPDATE dramas SET cover_url = ? WHERE id = ?', versioned, drama.id)
      updated = true
    }
    cover = versioned
  }
  if (banner && from !== 'existing') {
    const versioned = `${banner}?v=${stamp}`
    run(`UPDATE banners SET image = ? WHERE target_drama_id = ? AND image LIKE ?`,
      versioned, drama.id, `/media/images/banner-${slug}.jpg%`)
    banner = versioned
  }
  if (from !== 'existing') updated = true
  return { slug, cover, banner, from, updated }
}

/** 批量补齐封面/横幅：只处理缺图或图文件已丢失的剧。 */
export async function refreshArtwork({ limit = 50, only = [], force = false } = {}) {
  const rows = only.length
    ? all(`SELECT id, title, sub_title, cover_url, year, category FROM dramas WHERE id IN (${only.map(() => '?').join(',')})`, ...only)
    : all('SELECT id, title, sub_title, cover_url, year, category FROM dramas ORDER BY id LIMIT ?', limit)
  const details = []
  for (const row of rows) {
    try {
      const result = await ensureArtwork(row, { force })
      details.push({ id: row.id, title: row.title, ...result, ok: true })
      logInfo('artwork.drama', { id: row.id, title: row.title, from: result.from, cover: Boolean(result.cover), banner: Boolean(result.banner), updated: result.updated })
    } catch (error) {
      details.push({ id: row.id, title: row.title, ok: false, error: error.message })
      logWarn('artwork.drama.failed', { id: row.id, title: row.title, error })
    }
  }
  const summary = {
    total: details.length,
    updated: details.filter((item) => item.updated).length,
    failed: details.filter((item) => !item.ok).length,
    details,
  }
  logInfo('artwork.batch', { force, ...summary, details: undefined })
  return summary
}

/**
 * 用已有横幅给首页大图位（banners 表）补位，避免首页 hero 空着。
 * 只补到 limit 条，不动已有的（后台手配的优先级最高）。
 */
export function autofillBanners({ limit = 6 } = {}) {
  const existing = Number(all('SELECT COUNT(*) AS n FROM banners WHERE enabled = 1')[0]?.n ?? 0)
  if (existing >= limit) return { created: 0, total: existing, skipped: true }
  const rows = all(`SELECT id, title, sub_title FROM dramas
    WHERE cover_url IS NOT NULL AND cover_url <> '' AND status = 'published'
    ORDER BY score DESC, id DESC`)
  const takenTargets = new Set(all('SELECT target_drama_id FROM banners WHERE target_drama_id IS NOT NULL').map((row) => row.target_drama_id))
  // 同一张横幅图只上一次：同一部片子可能被导入成两条（不同 id、同 slug），
  // 只看 target_drama_id 会把它排两遍，hero 里出现一模一样的两张图。
  const takenImages = new Set(all("SELECT image FROM banners WHERE image IS NOT NULL AND image <> ''").map((row) => String(row.image)))
  let created = 0
  let sort = Number(all('SELECT COALESCE(MAX(sort), 0) AS s FROM banners')[0]?.s ?? 0)
  for (const row of rows) {
    if (existing + created >= limit) break
    if (takenTargets.has(row.id)) continue
    const entry = catalogEntryOf(row)
    const slug = String(entry?.slug ?? '').trim()
    if (!slug || !fileOk(bannerPath(slug))) continue
    const image = `/media/images/banner-${slug}.jpg`
    if (takenImages.has(image)) continue
    sort += 1
    run(`INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, 1)`,
      row.title, row.sub_title ?? '', image, row.id, sort)
    takenImages.add(image)
    created += 1
  }
  return { created, total: existing + created, skipped: false }
}
