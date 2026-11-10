/**
 * 自动搜刮器：按标题补全 封面 / 年份 / 地区 / 评分 / 简介 / 标签。
 * 三级来源，逐级兜底：
 *   1) 内置片源目录 data/catalog.json（离线可用，命中率最高的情况是我们自己导入的片）
 *   2) scrape_cache 表（上次搜刮成功的快照，含常见影视条目的人工补充）
 *   3) MH_SCRAPE_URL（可选外部元数据接口，GET ?title=xxx 返回同结构 JSON）
 * 全部失败时返回一份"可疑值 + 需人工确认"的草稿，不假装成功。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const CATEGORY_BY_HINT = [
  [/(动漫|动画|番剧|漫剧|ANIME|COMIC)/i, 'PLAYLET'],
  [/(纪录|DOCU)/i, 'MOVIE'],
  [/(综艺|VARIETY|SHOW)/i, 'VARIETY'],
  [/(剧|TV|SEASON|季)/i, 'TV'],
  [/(电影|片|FILM|MOVIE)/i, 'MOVIE'],
]

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

const normalize = (text) => String(text ?? '').toLowerCase().replace(/[\s·:：\-—()（）\[\]【】]/g, '')

function guessCategory(title) {
  for (const [pattern, category] of CATEGORY_BY_HINT) if (pattern.test(title)) return category
  return 'MOVIE'
}

function toPayload(entry, source) {
  return {
    title: entry.title,
    subTitle: entry.subTitle ?? '',
    description: entry.description ?? '',
    year: Number(entry.year ?? 0) || null,
    area: entry.area ?? '',
    category: entry.category ?? guessCategory(entry.title),
    score: entry.score === null || entry.score === undefined ? null : Number(entry.score),
    // catalog 里的 cover/banner 可能是布尔标记（banner: true 表示该片要生成横幅），只接受字符串地址
    coverUrl: typeof (entry.coverUrl ?? entry.cover) === 'string' ? (entry.coverUrl ?? entry.cover).trim() : '',
    bannerUrl: typeof (entry.bannerUrl ?? entry.banner) === 'string' ? (entry.bannerUrl ?? entry.banner).trim() : '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    episodes: entry.episodeCount ?? entry.episodes ?? null,
    access: entry.access ?? entry.policy ?? null,
    completeness: completenessOf(entry),
    source,
  }
}

/** 必填字段完成度：新建剧集向导据此决定能否「上架」。 */
export function completenessOf(entry) {
  const fields = {
    title: Boolean(String(entry?.title ?? '').trim()),
    category: Boolean(String(entry?.category ?? '').trim()),
    coverUrl: Boolean(String(entry?.coverUrl ?? entry?.cover ?? '').trim()),
    year: Number(entry?.year ?? 0) > 1900,
    area: Boolean(String(entry?.area ?? '').trim()),
    score: Number(entry?.score ?? 0) > 0,
    accessMode: Boolean((entry?.access?.mode ?? entry?.accessMode ?? '') || entry?.policy?.access_mode),
  }
  const missing = Object.entries(fields).filter(([, ok]) => !ok).map(([key]) => key)
  return { fields, missing, complete: missing.length === 0 }
}

/**
 * 内置片源目录里没有封面字段，但导入脚本会把封面/横幅抽到 storage/images/。
 * 命中这些本地素材时直接给出可用的站内地址，避免向导卡在「还缺：封面」。
 */
function localArtwork(entry) {
  const slug = String(entry?.slug ?? '').trim()
  if (!slug) return {}
  const cover = join(ROOT, 'storage/images', `cover-${slug}.jpg`)
  const banner = join(ROOT, 'storage/images', `banner-${slug}.jpg`)
  return {
    ...(existsSync(cover) ? { coverUrl: `/media/images/cover-${slug}.jpg` } : {}),
    ...(existsSync(banner) ? { bannerUrl: `/media/images/banner-${slug}.jpg` } : {}),
  }
}

function fromCatalog(title) {
  const key = normalize(title)
  if (!key) return null
  const rows = catalog()
  const exact = rows.find((row) => normalize(row.title) === key)
  if (exact) return toPayload({ ...exact, ...localArtwork(exact) }, 'catalog')
  const partial = rows.find((row) => normalize(row.title).includes(key) || key.includes(normalize(row.title)))
  return partial ? toPayload({ ...partial, ...localArtwork(partial) }, 'catalog') : null
}

function fromCache(title) {
  const key = normalize(title)
  const row = all('SELECT * FROM scrape_cache WHERE keyword = ?', key)[0]
  if (!row) return null
  try {
    return { ...JSON.parse(row.payload_json), source: row.source || 'cache' }
  } catch {
    return null
  }
}

async function fromRemote(title) {
  const base = process.env.MH_SCRAPE_URL
  if (!base) return null
  try {
    const url = new URL(base)
    url.searchParams.set('title', title)
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    const data = await response.json()
    const entry = data?.data ?? data
    if (!entry?.title) return null
    const payload = toPayload(entry, 'remote')
    cachePut(title, payload)
    return payload
  } catch {
    return null
  }
}

export function cachePut(title, payload) {
  const key = normalize(title)
  if (!key) return
  run(`INSERT INTO scrape_cache (keyword, payload_json, source) VALUES (?, ?, ?)
    ON CONFLICT(keyword) DO UPDATE SET payload_json = excluded.payload_json, source = excluded.source, created_at = datetime('now')`,
  key, JSON.stringify(payload), payload.source ?? 'manual')
}

/**
 * 搜刮一部剧的元数据。
 * @returns {Promise<{found:boolean, payload:object, suggestions:string[]}>}
 */
export async function scrapeTitle(title) {
  const value = String(title ?? '').trim()
  if (!value) throw Object.assign(new Error('请先填写标题'), { status: 400 })

  const remote = await fromRemote(value)
  if (remote) return { found: true, payload: remote, suggestions: suggest(value) }

  const cached = fromCache(value)
  if (cached) return { found: true, payload: toPayload(cached, cached.source ?? 'cache'), suggestions: suggest(value) }

  const local = fromCatalog(value)
  if (local) return { found: true, payload: local, suggestions: suggest(value) }

  const draft = toPayload({ title: value, category: guessCategory(value) }, 'draft')
  return { found: false, payload: draft, suggestions: suggest(value) }
}

/** 站内已有相似剧名，给向导做提示，避免重复建条目。 */
function suggest(title) {
  const key = normalize(title)
  if (!key) return []
  return all('SELECT id, title FROM dramas WHERE title LIKE ? ORDER BY id DESC LIMIT 5', `%${title.trim()}%`)
    .filter((row) => normalize(row.title).includes(key) || key.includes(normalize(row.title)))
    .map((row) => `${row.title}（#${row.id}）`)
}
