import { logInfo, logWarn } from './logger.mjs'

const API = 'https://en.wikipedia.org/w/api.php'

async function json(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'MH-Clone/1.0 (metadata artwork fallback)' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Wikipedia HTTP ${response.status}`)
  return response.json()
}

export async function findWikipediaArtwork(title, { subTitle = '', year = null } = {}) {
  const startedAt = Date.now()
  const names = [...new Set([
    String(subTitle ?? '').split('·')[0].trim(),
    String(title ?? '').trim(),
  ].filter(Boolean))]
  for (const name of names) {
    const titles = [
      year ? `${name} (${year} film)` : '',
      `${name} (film)`,
      name,
    ].filter(Boolean)
    const pageUrl = new URL(API)
    pageUrl.searchParams.set('action', 'query')
    pageUrl.searchParams.set('format', 'json')
    pageUrl.searchParams.set('prop', 'pageimages|info')
    pageUrl.searchParams.set('inprop', 'url')
    pageUrl.searchParams.set('pithumbsize', '900')
    pageUrl.searchParams.set('redirects', '1')
    pageUrl.searchParams.set('titles', titles.join('|'))
    try {
      const pageData = await json(pageUrl)
      const pages = Object.values(pageData?.query?.pages ?? {})
      const page = pages.find((item) => item.thumbnail?.source)
      const image = page?.thumbnail?.source
      if (!image) continue
      const value = { page: page.fullurl ?? page.title ?? name, image, matchedTitle: page.title }
      logInfo('scraper.wikipedia.match', { query: name, ...value, durationMs: Date.now() - startedAt })
      return value
    } catch (error) {
      logWarn('scraper.wikipedia.failed', { query: name, error })
    }
  }
  logWarn('scraper.wikipedia.no_match', { title, subTitle, year, durationMs: Date.now() - startedAt })
  return null
}
