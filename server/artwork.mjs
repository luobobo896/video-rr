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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { db } from './db.mjs'

const exec = promisify(execFile)
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMG_DIR = join(ROOT, 'storage', 'images')
const SRC_DIR = join(ROOT, 'storage', 'sources')
const FFMPEG = process.env.MH_FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.MH_FFPROBE ?? 'ffprobe'

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
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`封面下载失败 HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length < 3000) throw new Error('封面下载内容过小')
  const tmp = `${target}.src`
  writeFileSync(tmp, buffer)
  // 统一裁成站内规格（竖版 480x720 / 横版 1600x900），避免前端比例错乱
  if (filter) await exec(FFMPEG, ['-y', '-i', tmp, '-frames:v', '1', '-vf', filter, '-q:v', '3', target])
  else await exec(FFMPEG, ['-y', '-i', tmp, '-frames:v', '1', '-q:v', '3', target])
  if (!fileOk(target)) throw new Error('封面转码失败')
  return statSync(target).size
}

/**
 * 确保一部剧有本地封面（必要时补横幅）。
 * @returns {Promise<{cover:string|null, banner:string|null, from:string, updated:boolean}>}
 */
export async function ensureArtwork(drama) {
  const entry = catalogEntryOf(drama)
  const slug = String(entry?.slug ?? '').trim() || `drama-${drama.id}`
  let from = 'existing'
  let cover = fileOk(coverPath(slug)) ? `/media/images/cover-${slug}.jpg` : null
  let banner = fileOk(bannerPath(slug)) ? `/media/images/banner-${slug}.jpg` : null

  if (!cover || !banner) {
    const source = sourceFileOf(slug)
    if (source) {
      if (!cover) {
        await grabFrame(source, 0.12, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'video'
      }
      if (!banner && entry?.banner !== false) {
        await grabFrame(source, 0.22, bannerPath(slug), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900')
        banner = `/media/images/banner-${slug}.jpg`
        from = 'video'
      }
    } else {
      const archiveId = archiveIdOf(entry?.source?.url)
      if (!archiveId) throw new Error('片库没有该剧的片源地址，无法取封面')
      const remote = `https://archive.org/services/img/${encodeURIComponent(archiveId)}`
      if (!cover) {
        await downloadRemote(remote, coverPath(slug), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
        cover = `/media/images/cover-${slug}.jpg`
        from = 'archive'
      }
      if (!banner && entry?.banner !== false) {
        // 竖版缩略图放大成横幅会糊，改用居中模糊底 + 原图叠加，够用作首页大图
        await downloadRemote(
          remote,
          bannerPath(slug),
          'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900,gblur=sigma=18',
        )
        banner = `/media/images/banner-${slug}.jpg`
        from = 'archive'
      }
    }
  }

  let updated = false
  if (cover && cover !== drama.cover_url) {
    run('UPDATE dramas SET cover_url = ? WHERE id = ?', cover, drama.id)
    updated = true
  }
  return { slug, cover, banner, from, updated }
}

/** 批量补齐封面/横幅：只处理缺图或图文件已丢失的剧。 */
export async function refreshArtwork({ limit = 50, only = [] } = {}) {
  const rows = only.length
    ? all(`SELECT id, title, cover_url FROM dramas WHERE id IN (${only.map(() => '?').join(',')})`, ...only)
    : all('SELECT id, title, cover_url FROM dramas ORDER BY id LIMIT ?', limit)
  const details = []
  for (const row of rows) {
    try {
      const result = await ensureArtwork(row)
      details.push({ id: row.id, title: row.title, ...result, ok: true })
    } catch (error) {
      details.push({ id: row.id, title: row.title, ok: false, error: error.message })
    }
  }
  return {
    total: details.length,
    updated: details.filter((item) => item.updated).length,
    failed: details.filter((item) => !item.ok).length,
    details,
  }
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
  let created = 0
  let sort = Number(all('SELECT COALESCE(MAX(sort), 0) AS s FROM banners')[0]?.s ?? 0)
  for (const row of rows) {
    if (existing + created >= limit) break
    if (takenTargets.has(row.id)) continue
    const entry = catalogEntryOf(row)
    const slug = String(entry?.slug ?? '').trim()
    if (!slug || !fileOk(bannerPath(slug))) continue
    sort += 1
    run(`INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, 1)`,
      row.title, row.sub_title ?? '', `/media/images/banner-${slug}.jpg`, row.id, sort)
    created += 1
  }
  return { created, total: existing + created, skipped: false }
}
