/**
 * archive.org 刮削器（非成人片库补全）。
 *
 * 站点里的短片库（PLAYLET）全是成人内容，外层不能展示；外层要有人能播的片子，
 * 就得从公开馆藏里补。archive.org 的 advancedsearch 不需要密钥，metadata 接口能拿到
 * 文件清单，原生支持 Range，站内的远程片源代理（server/stream-proxy.mjs）可以直接转发。
 *
 * 一条 identifier = 一部片；一个 identifier 里多个视频文件 = 多集剧集（老剧合集常见）。
 * 解析逻辑都写成纯函数，测试不需要联网（test/archive.test.mjs）。
 */
import { logWarn } from './logger.mjs'

export const SEARCH_URL = 'https://archive.org/advancedsearch.php'
export const META_URL = 'https://archive.org/metadata'
export const DOWNLOAD_URL = 'https://archive.org/download'
export const THUMB_URL = 'https://archive.org/services/img'

/** 默认检索：电影馆藏里带授权声明（Public Domain / CC）的正片条目。 */
export const DEFAULT_QUERY = 'mediatype:movies AND licenseurl:*'

export const SEARCH_FIELDS = [
  'identifier', 'title', 'year', 'date', 'publicdate', 'description', 'subject',
  'licenseurl', 'downloads', 'collection', 'creator', 'language', 'runtime', 'country',
]

const UA = 'MH-Clone/1.0 (+content scraping; archive.org public collections)'

/** 可播容器按 docs/ARCHIVE-IMPORT.md:42 收：ogm 是 Ogg 封装的视频，mpeg/mpg 常是伴生预览片。 */
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|ogm|mkv|mov|avi)$/i
/** 这些 format 是封面、字幕、文本、种子之类的伴生文件，不是片源。 */
const NON_VIDEO = /(thumb|tile|spectrogram|waveform|djvu|pdf|text|json|xml|item image|metadata|album art|subtitle)/i
/**
 * 伴生文件还会混进「格式看起来正常」的名字里（archive.org 的 `_meta.mp4`、`_files.xml` 改名后的
 * `.mp4`、字幕被包成 mp4）。只看 format 挡不住，必须按文件名里的词元再排一遍。
 */
const COMPANION_NAME = /(^|[._\-\s])(meta|metadata|files|thumbs?|tiles?|spectrogram|waveform|djvu|pdf|torrent|srt|vtt|ass|ssa|sub|subs|idx|nfo|json|xml|txt|md5|sha1|sfv|log)([._\-\s]|$)/i
/** 同一个片子常同时有 h.264 / MPEG4 / Ogg 多份转码，按 format 挑一份。 */
const FORMAT_RANK = [
  [/h\.?264|mpeg4|512kb mpeg4|mpeg2/i, 3],
  [/matroska|webm|vp8|vp9|quicktime/i, 2],
  [/quicktime|avi|xvid|divx/i, 1],
]

/** archive.org 的字段可能是字符串、数组或带 HTML 的富文本，统一收敛成纯文本。 */
export function cleanText(value) {
  const raw = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value ?? '')
  if (!raw) return ''
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

export function yearOf(value) {
  const match = /(1[89]\d{2}|20\d{2})/.exec(String(value ?? ''))
  return match ? Number(match[0]) : null
}

const PLAUSIBLE_YEAR = (value) => {
  const year = Number(value)
  return Number.isFinite(year) && year >= 1890 && year <= new Date().getFullYear() ? year : null
}

/**
 * 片名里带年份时先取它（「My Man Godfrey (1936)」比馆藏上传年 2010 更可信）。
 * 其次按「发布/馆藏日期 → 年份字段」的优先序取第一个可信值：以前把全部候选取 min，
 * 元数据里随手写的版权年/上传年会把作品年份整体拉早。
 */
export function releaseYearOf({ title = '', metadata = {}, doc = {} } = {}) {
  for (const match of String(title ?? '').matchAll(/\((1[89]\d{2}|20\d{2})\)/g)) {
    const year = PLAUSIBLE_YEAR(match[1])
    if (year) return year
  }
  const ordered = [metadata.date, doc.date, metadata.publicdate, doc.publicdate, metadata.year, doc.year]
  for (const value of ordered) {
    const year = PLAUSIBLE_YEAR(yearOf(value))
    if (year) return year
  }
  return null
}

/** 片名里重复的「(1936) (2010)」全部剥掉：年份交给 year 字段，标题只留片名。 */
export function titleWithoutYear(value) {
  const cleaned = cleanText(value)
  const stripped = cleaned
    .replace(/\s*\((1[89]\d{2}|20\d{2})\)(?=\s*\((1[89]\d{2}|20\d{2})\)|\s*$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,\-–:]+$/, '')
    .trim()
  return stripped || cleaned
}

const AREA_BY_LANGUAGE = {
  eng: '美国', en: '美国', english: '美国',
  fre: '法国', fra: '法国', french: '法国',
  ger: '德国', deu: '德国', german: '德国',
  jpn: '日本', ja: '日本', japanese: '日本',
  ita: '意大利', italian: '意大利',
  rus: '俄罗斯', russian: '俄罗斯',
  spa: '西班牙', spanish: '西班牙',
  chi: '中国', zho: '中国', cmn: '中国', chinese: '中国',
  hin: '印度', hindi: '印度',
  kor: '韩国', korean: '韩国',
}

/** 馆藏里 country 很少写，language 常写全称（English/German…）；按语言给个地区兜底，后台可再改。 */
export function areaOf(metadata = {}) {
  const country = cleanText(metadata.country ?? metadata.countries)
  if (country) return country.split(/[,;&/]/)[0].trim().slice(0, 20)
  const language = cleanText(metadata.language).toLowerCase()
  for (const token of language.split(/[,;&\s]+/)) {
    if (!token) continue
    if (AREA_BY_LANGUAGE[token]) return AREA_BY_LANGUAGE[token]
  }
  return ''
}

const baseNameOf = (name) => String(name ?? '').replace(/\.[a-z0-9]{2,5}$/i, '').trim()

/** archive.org 同一部片常同时挂 sex_madness.mp4 与 sex_madness_512kb.mp4 这类派生版，靠后缀区分。 */
const QUALITY_TOKEN = /(512kb|256kb|64kb|128kb|h\.?264|mpeg4|mpeg2|xvid|divx|ogg|ogv|webm|hd|sd|dvd|remaster(ed)?|restored|colorized)$/i

export function canonicalNameOf(name) {
  const raw = baseNameOf(name).toLowerCase()
  let key = raw.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
  let previous = ''
  while (key && key !== previous) {
    previous = key
    key = key.replace(QUALITY_TOKEN, '')
  }
  return key || raw
}

function formatRankOf(format) {
  const text = String(format ?? '')
  for (const [pattern, rank] of FORMAT_RANK) if (pattern.test(text)) return rank
  return 0
}

/** 文件清单 → 可播视频文件（同一部片的多份转码只留质量最高的一份），保持原顺序。 */
export function pickVideoFiles(files = []) {
  const chosen = new Map()
  for (const file of Array.isArray(files) ? files : []) {
    const name = String(file?.name ?? '').trim()
    if (!name || file.private) continue
    if (String(file.format ?? '').toLowerCase() === 'metadata') continue
    if (!VIDEO_EXT.test(name)) continue
    if (NON_VIDEO.test(String(file.format ?? ''))) continue
    // `_meta.mp4` 这类伴生文件的 format 是正常的 h.264，只能按文件名拦
    if (COMPANION_NAME.test(baseNameOf(name))) continue
    const size = Number(file.size ?? 0) || 0
    if (size > 0 && size < 512 * 1024) continue
    const mp4Bonus = /\.mp4$/i.test(name) ? 1 : 0
    const candidate = {
      name,
      size,
      format: String(file.format ?? ''),
      duration: Number(file.length ?? file.duration ?? 0) || 0,
      rank: formatRankOf(file.format) * 2 + mp4Bonus,
      order: Number(file.track ?? 0) || 0,
    }
    const key = canonicalNameOf(name)
    const before = chosen.get(key)
    if (!before || candidate.rank > before.rank || (candidate.rank === before.rank && candidate.size > before.size)) {
      chosen.set(key, candidate)
    }
  }
  return [...chosen.values()]
}

/**
 * 文件名里的集号线索。宁可返回 0（交给顺序编号），也不要从片名里的数字猜集号：
 * 「Rocky 2」「Chaplin-1915」都不是集号，所以只认带分隔符的 ep/e/part/disc 与第N集。
 */
const NUMBER_PATTERNS = [
  { season: true, re: /(?:^|[^\d])s(\d{1,2})[\s._-]*e(\d{1,3})(?:[^\d]|$)/i },
  { re: /(?:^|[\s._\-[(_])(?:episode|ep|e)[\s._-]*(\d{1,3})(?:[^\d]|$)/i },
  { re: /第\s*(\d{1,3})\s*[集话話]/ },
  { re: /(?:^|[\s._\-[(_])(?:part|pt|cd|disc|disk)[\s._-]*(\d{1,3})(?:[^\d]|$)/i },
]

/** 文件名里能读出来的集号；读不出来返回 0，交给调用方按顺序编号。 */
export function episodeNumberIn(name) {
  const text = String(name ?? '')
  for (const pattern of NUMBER_PATTERNS) {
    const hit = pattern.re.exec(text)
    if (!hit) continue
    if (pattern.season) {
      const season = Number(hit[1]) || 1
      const episode = Number(hit[2]) || 0
      if (episode > 0) return season > 1 ? season * 1000 + episode : episode
      continue
    }
    const value = Number(hit[1]) || 0
    if (value > 0) return value
  }
  return 0
}

/** 自然排序：Track 1, Track 2, …, Track 10（不要按字符串排成 1, 10, 2）。 */
function naturalCompare(a, b) {
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' })
}

/**
 * 视频文件 → 剧集列表。文件名里的集号优先，读不到就按自然顺序补号；
 * 集号冲突时往后挪，保证 (drama_id, no) 唯一。
 */
export function groupEpisodes(files = [], identifier = '') {
  const list = pickVideoFiles(files)
    .map((file, index) => ({
      ...file,
      detected: episodeNumberIn(file.name),
      sequence: index,
    }))
    .sort((a, b) => {
      if (a.detected && b.detected && a.detected !== b.detected) return a.detected - b.detected
      if (Boolean(a.detected) !== Boolean(b.detected)) return a.detected ? -1 : 1
      return naturalCompare(a.name, b.name)
    })

  const used = new Set()
  let cursor = 0
  return list.map((file) => {
    cursor += 1
    let no = file.detected || cursor
    while (used.has(no)) no += 1
    used.add(no)
    return {
      no,
      title: baseNameOf(file.name).slice(0, 80),
      duration: file.duration,
      bytes: file.size,
      source: file.name,
      remoteUrl: identifier
        ? `${DOWNLOAD_URL}/${identifier}/${encodeURIComponent(file.name).replace(/%2F/g, '/')}`
        : '',
    }
  })
}

export function categoryOf({ collection = '', category = '' } = {}) {
  const wanted = String(category ?? '').trim().toUpperCase()
  if (['MOVIE', 'TV', 'ANIME', 'VARIETY', 'PLAYLET'].includes(wanted)) {
    // 短剧一律不从这里进来：外层要的就是「除了短剧」的内容
    return wanted === 'PLAYLET' ? 'MOVIE' : wanted
  }
  const collections = (Array.isArray(collection) ? collection.join(' ') : String(collection ?? '')).toLowerCase()
  if (/classic_tv|television|tv_archive|old_time_radio/.test(collections)) return 'TV'
  return 'MOVIE'
}

/**
 * 公开馆藏里混着大量 60 年代 exploit / nudist 片，标题一看就不适合放外层。
 * 这些照旧入库，但打上成人标记：外层过滤掉，只出现在需要 18+ 确认的专区里。
 */
const ADULT_HINT = /\b(porn|xxx|hardcore|hentai|erotic|erotica|nudis?t|nudity|naked|sexploitation|orgy|striptease|burlesque girl|sex)\b/i

export function adultHintOf({ title = '', subject = [], description = '' } = {}) {
  const text = [title, ...(Array.isArray(subject) ? subject : [subject]), String(description).slice(0, 300)].join(' ')
  return ADULT_HINT.test(text)
}

const CONTENT_TYPE_BY_CATEGORY = { MOVIE: 'movie', TV: 'series', ANIME: 'comic_drama', VARIETY: 'series' }
export const contentTypeOf = (category) => CONTENT_TYPE_BY_CATEGORY[category] ?? 'movie'

/**
 * 一条 archive.org 记录 → 站内剧目草稿（不含 id）。
 * 纯函数：只吃 doc / metadata / files，方便单测和 --dry 预览。
 */
export function buildDrama({ identifier, metadata = {}, files = [], doc = {}, category = '' } = {}) {
  const id = String(identifier ?? metadata.identifier ?? doc.identifier ?? '').trim()
  if (!id) throw new Error('缺少 identifier')
  const episodes = groupEpisodes(files, id)
  if (!episodes.length) return null

  const rawTitle = cleanText(metadata.title ?? doc.title).replace(/\s*[:\-–]\s*$/, '')
  const title = (titleWithoutYear(rawTitle) || id).slice(0, 120)
  const collection = metadata.collection ?? doc.collection ?? ''
  const resolvedCategory = categoryOf({ collection, category })
  const creator = cleanText(metadata.creator ?? doc.creator)
  const year = releaseYearOf({ title: rawTitle, metadata, doc })
  const subjects = (Array.isArray(metadata.subject) ? metadata.subject : String(metadata.subject ?? '').split(/[;,]/))
    .map((item) => cleanText(item))
    .filter((item) => item && item.length <= 24)
  const tags = [...new Set(subjects)].slice(0, 8)
  const cleaned = cleanText(metadata.description ?? doc.description)
  // 馆藏简介经常是空的，详情页不能只剩标题：给一段可读的兜底文案
  const description = (cleaned || [
    `archive.org 公开馆藏收录的 ${resolvedCategory === 'TV' ? '剧集' : '影片'}`,
    year ? `，${year} 年` : '',
    tags.length ? `，关键词：${tags.slice(0, 4).join('、')}` : '',
    '。',
  ].join('')).slice(0, 800)
  const totalSeconds = episodes.reduce((sum, item) => sum + (item.duration || 0), 0)

  return {
    identifier: id,
    sourceKey: `archive:${id}`,
    title,
    subTitle: [creator, year ? String(year) : ''].filter(Boolean).join(' · ').slice(0, 120),
    description,
    year: year ?? null,
    area: areaOf(metadata),
    category: resolvedCategory,
    contentType: contentTypeOf(resolvedCategory),
    adult: adultHintOf({ title, subject: tags, description }),
    score: null,
    coverUrl: `${THUMB_URL}/${id}`,
    licenseUrl: cleanText(metadata.licenseurl ?? doc.licenseurl) || null,
    tags,
    downloads: Number(doc.downloads ?? 0) || 0,
    durationSeconds: Math.round(totalSeconds),
    episodes,
  }
}

/** 检索式：给了 query 就用 query，否则按馆藏/年份拼。 */
export function buildQuery({ query = '', collection = '', yearFrom = 0, yearTo = 0, licenseOnly = true } = {}) {
  const parts = []
  if (String(query ?? '').trim()) parts.push(`(${String(query).trim()})`)
  else {
    parts.push('mediatype:movies')
    if (licenseOnly) parts.push('licenseurl:*')
  }
  const collections = String(collection ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  for (const name of collections) parts.push(`collection:${name}`)
  if (Number(yearFrom) > 0) parts.push(`year:[${Number(yearFrom)} TO ${Number(yearTo) > 0 ? Number(yearTo) : 2100}]`)
  return parts.join(' AND ')
}

export function searchUrl({ query = '', collection = '', yearFrom = 0, yearTo = 0, licenseOnly = true, rows = 25, page = 1, sort = 'downloads desc' } = {}) {
  const url = new URL(SEARCH_URL)
  url.searchParams.set('q', buildQuery({ query, collection, yearFrom, yearTo, licenseOnly }))
  for (const field of SEARCH_FIELDS) url.searchParams.append('fl[]', field)
  url.searchParams.set('rows', String(Math.min(200, Math.max(1, Number(rows) || 25))))
  url.searchParams.set('page', String(Math.max(1, Number(page) || 1)))
  if (sort) url.searchParams.set('sort[]', sort)
  url.searchParams.set('output', 'json')
  return url
}

async function getJson(url, timeout = 20000) {
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(timeout) })
  if (!response.ok) {
    logWarn('archive.fetch_failed', { host: url.host, status: response.status, path: url.pathname })
    throw new Error(`archive.org HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch (error) {
    // 刮削最怕"拿到 200 但不是 JSON"（维护页/限流页），记下来才好判断是脚本还是源站问题
    logWarn('archive.body_invalid', { host: url.host, path: url.pathname, message: error?.message ?? 'invalid json' })
    throw error
  }
}

export async function searchArchive(options = {}) {
  const data = await getJson(searchUrl(options))
  const docs = data?.response?.docs ?? []
  return {
    total: Number(data?.response?.numFound ?? 0) || 0,
    docs: docs.filter((doc) => String(doc?.identifier ?? '').trim()),
  }
}

export async function fetchArchiveItem(identifier) {
  const data = await getJson(`${META_URL}/${encodeURIComponent(identifier)}`)
  if (!data || data.is_dark) return null
  return { metadata: data.metadata ?? {}, files: data.files ?? [] }
}

/** 搜索结果 → 可入库草稿（没有文件清单时只给元数据，用来 --dry 看效果）。 */
export function draftFromDoc(doc = {}) {
  return buildDrama({ identifier: doc.identifier, metadata: doc, files: [{ name: `${doc.identifier}.mp4`, size: 1, format: 'h.264' }], doc })
}
