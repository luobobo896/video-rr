/**
 * 开放影像海报墙：只读取已有封面/横幅的元数据，不下载视频，不产生播放切片。
 * 变体图片由 scripts/build-poster-wall.mjs 生成，命名固定，API 只返回实际存在的文件。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, ROOT } from './db.mjs'
import { catalogEntryOf } from './artwork.mjs'
import { adultVisibilitySql } from './content-visibility.mjs'

const IMG_DIR = join(ROOT, 'storage', 'images')

export const POSTER_VARIANT_ORDER = ['portrait', 'square', 'wide']

export const POSTER_VARIANTS = Object.freeze({
  portrait: {
    width: 360,
    height: 540,
    source: 'cover',
    filter: 'scale=360:540:force_original_aspect_ratio=increase,crop=360:540',
    label: '2:3',
  },
  square: {
    width: 480,
    height: 480,
    source: 'cover',
    filter: 'scale=480:480:force_original_aspect_ratio=increase,crop=480:480',
    label: '1:1',
  },
  wide: {
    width: 960,
    height: 540,
    source: 'banner',
    filter: 'scale=960:540:force_original_aspect_ratio=increase,crop=960:540',
    label: '16:9',
  },
})

const CC_LICENSE_URLS = {
  'CC BY 2.5': 'https://creativecommons.org/licenses/by/2.5/',
  'CC BY 3.0': 'https://creativecommons.org/licenses/by/3.0/',
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
}

const SOURCE_PAGE_OVERRIDES = {
  tos: 'https://mango.blender.org/',
  ed: 'https://orange.blender.org/',
  coffee: 'https://studio.blender.org/projects/coffee-run/pages/licensing/',
}

const archiveIdOf = (url) => {
  const match = /archive\.org\/(?:download|details|embed)\/([^/?#]+)/i.exec(String(url ?? ''))
  return match?.[1] ?? ''
}

export function posterFileName(slug, variantKey) {
  return `poster-${slug}-${variantKey}.jpg`
}

export function posterUrl(slug, variantKey) {
  return `/media/images/${posterFileName(slug, variantKey)}`
}

/** 片库授权信息；不臆造许可，缺字段时保留空值。 */
export function sourceInfoOf(drama) {
  const entry = catalogEntryOf(drama)
  if (!entry) return null
  const source = entry.source ?? {}
  const license = String(source.license ?? '').trim()
  const archiveId = archiveIdOf(source.url)
  const sourceUrl = SOURCE_PAGE_OVERRIDES[entry.slug]
    || (archiveId ? `https://archive.org/details/${encodeURIComponent(archiveId)}` : String(source.url ?? ''))
  return {
    slug: entry.slug,
    license,
    licenseKind: /^public domain$/i.test(license) ? 'public-domain' : 'open-license',
    licenseUrl: CC_LICENSE_URLS[license] ?? null,
    credit: String(source.credit ?? ''),
    sourceUrl,
    sourceFileUrl: String(source.url ?? ''),
    allowsDerivative: !/\bND\b|NoDerivatives/i.test(license),
  }
}

/** 可参与海报墙的剧集；只取有本地封面且授权允许改编的作品。 */
export function posterWallCandidates() {
  const rows = db.prepare(`SELECT id, title, sub_title, year, category, score, cover_url
    FROM dramas WHERE status = 'published' AND ${adultVisibilitySql('general', '')}
      AND cover_url IS NOT NULL AND cover_url <> ''
    ORDER BY score DESC, id ASC`).all()
  return rows.flatMap((drama) => {
    const source = sourceInfoOf(drama)
    if (!source?.allowsDerivative) return []
    const coverFile = join(IMG_DIR, `cover-${source.slug}.jpg`)
    if (!existsSync(coverFile)) return []
    return [{
      dramaId: drama.id,
      title: drama.title,
      subTitle: drama.sub_title ?? '',
      year: drama.year,
      category: drama.category,
      score: drama.score,
      coverUrl: drama.cover_url,
      coverFile,
      bannerFile: join(IMG_DIR, `banner-${source.slug}.jpg`),
      source,
    }]
  })
}

export function posterWallPayload() {
  const items = posterWallCandidates().map((candidate) => {
    const variants = POSTER_VARIANT_ORDER.flatMap((key) => {
      const spec = POSTER_VARIANTS[key]
      if (!existsSync(join(IMG_DIR, posterFileName(candidate.source.slug, key)))) return []
      return [{
        key,
        label: spec.label,
        width: spec.width,
        height: spec.height,
        url: posterUrl(candidate.source.slug, key),
      }]
    })
    if (!variants.length) return null
    return {
      dramaId: candidate.dramaId,
      title: candidate.title,
      subTitle: candidate.subTitle,
      year: candidate.year,
      category: candidate.category,
      score: candidate.score,
      coverUrl: candidate.coverUrl,
      license: candidate.source.license,
      licenseKind: candidate.source.licenseKind,
      licenseUrl: candidate.source.licenseUrl,
      credit: candidate.source.credit,
      sourceUrl: candidate.source.sourceUrl,
      variants,
    }
  }).filter(Boolean)

  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    variantsPerTitle: POSTER_VARIANT_ORDER.length,
    items,
  }
}
