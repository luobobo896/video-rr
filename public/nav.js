export const NAV_MAIN = [
  ['精选', '#/home'],
  ['分类', '#/category/ALL'],
  ['电影', '#/category/MOVIE'],
  ['电视剧', '#/category/TV'],
  ['短剧', '#/category/PLAYLET'],
  ['动漫', '#/category/ANIME'],
  ['纪录片', '#/category/DOCUMENTARY'],
  ['即将上线', '#/category/ALL?sort=upcoming'],
  ['片单广场', '#/playlists'],
  ['海报墙', '#/posters'],
]

export const NAV_MOBILE = [
  ['精选', '#/home'],
  ['分类', '#/category/ALL'],
  ['海报墙', '#/posters'],
  ['榜单', '#/rank'],
  ['我的', '#/me'],
]

const MOBILE_LABELS_EN = {
  '#/home': 'Home',
  '#/category/ALL': 'Browse',
  '#/posters': 'Wall',
  '#/rank': 'Ranks',
  '#/me': 'Me',
}

export const mobileNavLabel = (label, href, lang) => (
  lang === 'en' ? (MOBILE_LABELS_EN[href] ?? label) : label
)

export function navIsActive(href, hash) {
  const normalizePath = (value) => {
    const path = String(value ?? '').split('?')[0]
    return !path || path === '#' || path === '#/' ? '#/home' : path
  }
  const [hrefPath, hrefQuery] = String(href ?? '').split('?')
  if (!hrefPath) return false
  if (normalizePath(hrefPath) !== normalizePath(hash)) return false
  if (normalizePath(hrefPath) === '#/me' && !hrefQuery) return true
  if (normalizePath(hrefPath) === '#/rank' && !hrefQuery) return true
  if (normalizePath(hrefPath) === '#/content-rank' && !hrefQuery) return true
  if (normalizePath(hrefPath) === '#/adult' && !hrefQuery) return true
  const hrefParams = new URLSearchParams(hrefQuery ?? '')
  const currentParams = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '')
  if ([...hrefParams.keys()].length === 0) return [...currentParams.keys()].length === 0
  for (const [key, value] of hrefParams) {
    const current = currentParams.get(key)
    if (key === 'type') {
      if ((current ?? 'HOT') !== value) return false
      continue
    }
    if ((current ?? '') !== value) return false
  }
  return true
}
