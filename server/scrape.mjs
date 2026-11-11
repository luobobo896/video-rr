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
import { findTmdb } from './tmdb.mjs'

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
  const result = {
    ...(existsSync(cover) ? { coverUrl: `/media/images/cover-${slug}.jpg` } : {}),
    ...(existsSync(banner) ? { bannerUrl: `/media/images/banner-${slug}.jpg` } : {}),
  }
  // 本地还没抽图时，先用片源方的缩略图让向导能看到海报；后台「一键搜刮」会把它本地化
  if (!result.coverUrl) {
    const match = /archive\.org\/(?:download|details|embed)\/([^/?#]+)/i.exec(String(entry?.source?.url ?? ''))
    if (match) result.coverUrl = `https://archive.org/services/img/${match[1]}`
  }
  return result
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

async function fromTmdb(title) {
  const hit = await findTmdb(title).catch(() => null)
  if (!hit) return null
  const payload = toPayload({
    title: hit.title || title,
    subTitle: [hit.originalTitle, hit.year].filter(Boolean).join(' · '),
    description: hit.overview,
    year: hit.year,
    area: hit.area,
    category: hit.mediaType === 'tv' ? 'TV' : 'MOVIE',
    score: hit.score,
    coverUrl: hit.posterUrl,
    bannerUrl: hit.backdropUrl,
    tags: hit.tags,
  }, 'tmdb')
  payload.tmdb = { id: hit.id, type: hit.mediaType, imdbId: hit.imdbId }
  cachePut(title, payload)
  return payload
}

/**
 * 真实外部搜刮：archive.org 公开检索（无需密钥）。
 * 用户填电影名 → 拿到海报（services/img）、年份、简介、题材标签，
 * 片源地址也一并带出，后台「一键导入」可以直接建剧。
 */
async function fromArchive(title) {
  if (process.env.MH_SCRAPE_ARCHIVE === '0') return null
  const query = `title:(${String(title).replace(/[":()\[\]]/g, ' ')}) AND mediatype:(movies)`
  const url = new URL('https://archive.org/advancedsearch.php')
  url.searchParams.set('q', query)
  for (const field of ['identifier', 'title', 'year', 'description', 'subject', 'licenseurl', 'downloads', 'collection']) url.searchParams.append('fl[]', field)
  url.searchParams.set('rows', '5')
  url.searchParams.set('page', '1')
  url.searchParams.set('output', 'json')
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { 'user-agent': 'MH-Clone/1.0 (+content import)' } })
    if (!response.ok) return null
    const data = await response.json()
    const docs = (data?.response?.docs ?? []).filter((doc) => String(doc.identifier ?? '').trim())
    if (!docs.length) return null
    // 同一标题在 archive.org 常有用户搬运版（B 站切片、合集、低画质转录）。
    // 按「标题贴合度 + 是否正片馆藏 + 授权声明 + 标题长度」打分，取最像正片的一条。
    const key = normalize(title)
    const scoreOf = (doc) => {
      const docTitle = String(doc.title ?? '')
      const docKey = normalize(docTitle)
      const collections = String(doc.collection ?? '').toLowerCase()
      let score = 0
      if (docKey === key) score += 6
      else if (docKey.startsWith(key)) score += 4
      else if (docKey.includes(key)) score += 2
      if (/feature_films|moviesandfilms|classic_tv|film_noir/.test(collections)) score += 3
      if (doc.licenseurl) score += 2
      if (docTitle.length > 60) score -= 3
      if (/bilibili|BV[0-9A-Za-z]{8,}|合集|切片|搬运|reaction/i.test(docTitle)) score -= 8
      if (/bilibili/.test(collections)) score -= 8
      return score
    }
    const hit = docs.slice().sort((a, b) => scoreOf(b) - scoreOf(a))[0]
    // 宁缺勿滥：标题不以检索词开头、也不在正片馆藏里的结果（多是被改名的搬运切片）
    // 一律视为没搜到，让向导退回草稿，避免建出「【励志】阿甘正传… P1」这种条目。
    const hitKey = normalize(String(hit.title ?? ''))
    const hitCollections = String(hit.collection ?? '').toLowerCase()
    const eligible = hitKey === key || hitKey.startsWith(key) || /feature_films|moviesandfilms/.test(hitCollections)
    if (scoreOf(hit) < 2 || !eligible) return null
    const identifier = String(hit.identifier)
    const subject = Array.isArray(hit.subject) ? hit.subject : String(hit.subject ?? '').split(/[;,]/)
    const payload = toPayload({
      title: String(hit.title ?? title).replace(/\s*:\s*$/, '').slice(0, 80),
      description: String(Array.isArray(hit.description) ? hit.description[0] : hit.description ?? '').replace(/<[^>]+>/g, ' ').slice(0, 400),
      year: Number(String(hit.year ?? '').slice(0, 4)) || null,
      area: '',
      category: guessCategory(String(hit.title ?? title)),
      score: null,
      coverUrl: `https://archive.org/services/img/${identifier}`,
      tags: subject.map((item) => String(item).trim()).filter(Boolean).slice(0, 8),
    }, 'archive')
    payload.remote = { identifier, sourceUrl: `https://archive.org/download/${identifier}/`, licenseUrl: hit.licenseurl ?? null }
    cachePut(title, payload)
    return payload
  } catch {
    return null
  }
}

async function fromRemote(title) {
  const base = process.env.MH_SCRAPE_URL
  if (!base) return fromArchive(title)
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

  const local = fromCatalog(value)
  if (local) return { found: true, payload: local, suggestions: suggest(value) }

  const tmdb = await fromTmdb(value)
  if (tmdb) return { found: true, payload: tmdb, suggestions: suggest(value) }

  const cached = fromCache(value)
  if (cached) return { found: true, payload: toPayload(cached, cached.source ?? 'cache'), suggestions: suggest(value) }

  const remote = await fromRemote(value)
  if (remote) return { found: true, payload: remote, suggestions: suggest(value) }

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
