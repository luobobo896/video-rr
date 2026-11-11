/**
 * TMDB lookup adapted from Kodi's official movie scraper:
 * https://github.com/xbmc/metadata.themoviedb.org.python
 *
 * Kodi ships a public API key for the add-on. Deployments can override it with
 * TMDB_API_KEY (v3) or TMDB_READ_TOKEN (v4 bearer token).
 */
const KODI_FALLBACK_KEY = 'f090bb54758cabf231fb605d3e3e0468'
const API = 'https://api.themoviedb.org/3'
const IMAGE = 'https://image.tmdb.org/t/p'
const cache = new Map()
const CACHE_TTL = 30 * 60_000
import { logInfo, logWarn } from './logger.mjs'

const normalize = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/\b(s\d{1,2}e\d{1,3})\b/gi, '')
  .replace(/[\s·:：\-—()（）\[\]【】,，.。]/g, '')

const yearOf = (value) => {
  const match = /(19|20)\d{2}/.exec(String(value ?? ''))
  return match ? Number(match[0]) : null
}

const titleOf = (item) => item?.title ?? item?.name ?? ''
const originalOf = (item) => item?.original_title ?? item?.original_name ?? ''
const dateOf = (item) => item?.release_date ?? item?.first_air_date ?? ''

function queryCandidates(title, subTitle) {
  const values = [
    String(title ?? '').trim(),
    String(subTitle ?? '').split('·')[0].trim(),
    String(subTitle ?? '').replace(/\bS\d{1,2}E\d{1,3}\b.*/i, '').trim(),
  ]
  return [...new Set(values.filter((value) => value.length >= 2))]
}

async function request(path, params = {}) {
  const url = new URL(`${API}${path}`)
  const token = process.env.TMDB_READ_TOKEN
  const key = process.env.TMDB_API_KEY || KODI_FALLBACK_KEY
  if (!token) url.searchParams.set('api_key', key)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value))
  }
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'MH-Clone/1.0 (Kodi TMDB scraper compatible)',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(12_000),
  })
  if (!response.ok) {
    const error = new Error(`TMDB HTTP ${response.status}`)
    error.status = response.status
    throw error
  }
  return response.json()
}

function rankResult(item, candidates, year, category) {
  const titles = [titleOf(item), originalOf(item)].map(normalize)
  const wanted = candidates.map(normalize)
  let score = 0
  for (const title of titles) {
    if (wanted.some((candidate) => candidate && title === candidate)) score += 12
    else if (wanted.some((candidate) => candidate && (title.startsWith(candidate) || candidate.startsWith(title)))) score += 6
    else if (wanted.some((candidate) => candidate && title.includes(candidate))) score += 2
  }
  const itemYear = yearOf(dateOf(item))
  if (year && itemYear === Number(year)) score += 7
  else if (year && itemYear && Math.abs(itemYear - Number(year)) <= 1) score += 2
  const wantedType = category === 'TV' ? 'tv' : category === 'MOVIE' ? 'movie' : null
  if (wantedType && item.media_type === wantedType) score += 3
  if (item.poster_path) score += 1
  if (item.vote_count) score += Math.min(3, Math.log10(Number(item.vote_count) + 1))
  score += Math.min(3, Number(item.popularity ?? 0) / 40)
  return score
}

function chooseImage(images, fallbackPath, language = 'zh') {
  const list = (images ?? [])
    .filter((item) => item.file_path && !item.file_path.endsWith('.svg'))
    .sort((a, b) => {
      const langA = a.iso_639_1 === language ? 2 : a.iso_639_1 === 'en' ? 1 : 0
      const langB = b.iso_639_1 === language ? 2 : b.iso_639_1 === 'en' ? 1 : 0
      if (langA !== langB) return langB - langA
      if (Number(a.vote_average ?? 0) !== Number(b.vote_average ?? 0)) return Number(b.vote_average ?? 0) - Number(a.vote_average ?? 0)
      return Number(b.width ?? 0) - Number(a.width ?? 0)
    })
  return list[0]?.file_path ?? fallbackPath ?? null
}

function imageUrl(path, size) {
  return path ? `${IMAGE}/${size}${path}` : ''
}

function areaName(details) {
  const code = details.origin_country?.[0] ?? details.production_countries?.[0]?.iso_3166_1
  if (code) {
    try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) ?? code } catch { /* ignore */ }
  }
  return details.production_countries?.[0]?.name ?? ''
}

export async function findTmdb(title, { subTitle = '', year = null, category = '' } = {}) {
  const startedAt = Date.now()
  const candidates = queryCandidates(title, subTitle)
  if (!candidates.length) return null
  const cacheKey = `${normalize(title)}|${year ?? ''}|${category}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < CACHE_TTL) return cached.value

  const results = new Map()
  for (const query of candidates.slice(0, 2)) {
    try {
      const data = await request('/search/multi', { query, language: 'zh-CN', include_adult: false, page: 1 })
      for (const item of data.results ?? []) {
        if (!['movie', 'tv'].includes(item.media_type)) continue
        results.set(`${item.media_type}:${item.id}`, item)
      }
    } catch (error) {
      if (error.status === 401 || error.status === 403) break
    }
  }
  const hit = [...results.values()].sort((a, b) => rankResult(b, candidates, year, category) - rankResult(a, candidates, year, category))[0]
  if (!hit || rankResult(hit, candidates, year, category) < 4) {
    logWarn('scraper.tmdb.no_match', { query: title, subTitle, year, category, durationMs: Date.now() - startedAt })
    cache.set(cacheKey, { at: Date.now(), value: null })
    return null
  }

  let details
  try {
    details = await request(`/${hit.media_type}/${hit.id}`, {
      language: 'zh-CN',
      append_to_response: 'images,keywords,external_ids',
    })
  } catch {
    return null
  }
  if (!details?.id) return null
  if (!details.overview) {
    try {
      const fallback = await request(`/${hit.media_type}/${hit.id}`, { language: 'en-US' })
      details.overview = fallback.overview ?? ''
    } catch { /* ignore */ }
  }

  const images = details.images ?? {}
  const posterPath = chooseImage(images.posters, details.poster_path)
  const backdropPath = chooseImage(images.backdrops, details.backdrop_path, '')
  const genres = Array.isArray(details.genres) ? details.genres.map((item) => item.name) : []
  const keywords = details.keywords?.keywords ?? details.keywords?.results ?? []
  const tmdbYear = yearOf(dateOf(details))
  const value = {
    id: details.id,
    mediaType: hit.media_type,
    title: titleOf(details),
    originalTitle: originalOf(details),
    overview: details.overview ?? '',
    year: tmdbYear,
    area: areaName(details),
    score: details.vote_average ? Number(Number(details.vote_average).toFixed(1)) : null,
    tags: [...new Set([...genres, ...keywords.map((item) => item.name)])].filter(Boolean).slice(0, 8),
    posterUrl: imageUrl(posterPath, 'w780'),
    backdropUrl: imageUrl(backdropPath, 'w1280'),
    imdbId: details.imdb_id ?? details.external_ids?.imdb_id ?? null,
  }
  logInfo('scraper.tmdb.match', {
    query: title, year, category, tmdbId: value.id, mediaType: value.mediaType,
    title: value.title, score: value.score, hasPoster: Boolean(value.posterUrl),
    hasBackdrop: Boolean(value.backdropUrl), durationMs: Date.now() - startedAt,
  })
  cache.set(cacheKey, { at: Date.now(), value })
  return value
}
