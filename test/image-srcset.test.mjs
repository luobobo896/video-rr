import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const apiJs = readFileSync(new URL('../public/src/api.js', import.meta.url), 'utf8')

/** api.js 依赖 window，测试里只截出纯函数的这一段来跑。 */
function loadImageHelpers() {
  const from = apiJs.indexOf('const IMAGE_VARIANT_RE')
  const to = apiJs.indexOf('export function hlsUrl')
  assert.ok(from > 0 && to > from, '找不到 imageVariant / imageSrcset 定义')
  const source = apiJs.slice(from, to).replace(/export /g, '')
  return new Function(`${source}
    return { imageVariant, imageSrcset }`)()
}

const { imageVariant, imageSrcset } = loadImageHelpers()

test('站内封面换成对应宽度的 WebP 变体，query 保留（缓存击穿用）', () => {
  assert.equal(
    imageVariant('/media/images/cover-tos.jpg?v=1794319099757', 320),
    '/media/images/variants/cover-tos-w320.webp?v=1794319099757',
  )
  assert.equal(
    imageVariant('/video/media/images/preview-jable-start-561.jpeg', 640),
    '/video/media/images/variants/preview-jable-start-561-w640.webp',
  )
  assert.equal(
    imageVariant('/media/images/cover-x.png', 1280),
    '/media/images/variants/cover-x-w1280.webp',
  )
})

test('非站内图、空值、非法宽度都原样返回，不拼出坏地址', () => {
  assert.equal(imageVariant('https://img.bwcgee.cn/a.jpg', 320), 'https://img.bwcgee.cn/a.jpg')
  assert.equal(imageVariant('/art/poster-scifi.jpg', 320), '/art/poster-scifi.jpg')
  assert.equal(imageVariant('', 320), '')
  assert.equal(imageVariant('/media/images/cover-x.jpg', 0), '/media/images/cover-x.jpg')
  assert.equal(imageVariant('/media/images/cover-x.jpg', 'big'), '/media/images/cover-x.jpg')
})

test('srcset 给出 320/640/1280 三档候选，非站内图返回空串交给浏览器用原图', () => {
  assert.equal(
    imageSrcset('/media/images/cover-tos.jpg', [320, 640, 1280]),
    '/media/images/variants/cover-tos-w320.webp 320w, /media/images/variants/cover-tos-w640.webp 640w, /media/images/variants/cover-tos-w1280.webp 1280w',
  )
  assert.equal(imageSrcset('https://img.bwcgee.cn/a.jpg'), '')
  assert.equal(imageSrcset(''), '')
})

test('卡片接上了 srcset/sizes，加载失败回退原图（静态断言）', () => {
  const filmArt = readFileSync(new URL('../public/src/components/FilmArt.vue', import.meta.url), 'utf8')
  assert.match(filmArt, /:srcset="displaySrcset \|\| undefined"/)
  assert.match(filmArt, /:sizes="displaySrcset \? coverSizes : undefined"/)
  assert.match(filmArt, /loading="lazy"/)
  assert.match(filmArt, /decoding="async"/)
  assert.match(filmArt, /@error="onCoverError"/)
})

test('封面到位前不留白：渐变占位上淡入，失败就退成占位图', () => {
  const filmArt = readFileSync(new URL('../public/src/components/FilmArt.vue', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../public/src/styles.css', import.meta.url), 'utf8')
  assert.match(filmArt, /:class="\['film-fallback', \{ 'is-loading': !coverLoaded, 'is-failed': coverFailed \}\]"/)
  assert.match(filmArt, /@load="coverLoaded = true"/)
  assert.match(filmArt, /coverFailed\.value = true/)
  assert.match(styles, /\.film-art img\.is-loading \{ opacity: 0; \}/)
  assert.match(styles, /\.film-art img\.is-failed \{ display: none; \}/)
  // hover 预览视频的 poster 也别再挂整张原图。
  assert.match(filmArt, /:poster="imageVariant\(film\.coverUrl, 640\) \|\| film\.coverUrl \|\| ''"/)
})

test('封面 404 时逐档回退：变体 → 原图 → 占位插画，不会停在裂图', () => {
  const filmArt = readFileSync(new URL('../public/src/components/FilmArt.vue', import.meta.url), 'utf8')
  // 回退链按宽度从窄到宽，最后一档是占位插画。
  assert.match(filmArt, /const FALLBACK_CHAIN = \['w320', 'w640', 'w1280', 'source', 'art'\]/)
  assert.match(filmArt, /fallbackStep\.value = next/)
  assert.match(filmArt, /@error="onCoverError"/)
  // 没有 coverUrl 的片子直接走 fallbackArt，不渲染空 src。
  assert.match(filmArt, /if \(step === 'art' \|\| !props\.film\?\.coverUrl\) return fallbackArt\(props\.film\)/)
})

// 只有「会比源图宽」的档才跳过；比源图窄的档照样缩出来，最宽档永远兜底。
test('变体生成：窄源图只在会放大的档跳过，最宽档与更窄档都产出', () => {
  const script = readFileSync(new URL('../scripts/build-image-variants.mjs', import.meta.url), 'utf8')
  assert.match(script, /const isWidest = width === widths\[widths\.length - 1\]/)
  assert.match(script, /const skipIfUpscale = sourceWidth && sourceWidth <= width \* 1\.05 && sourceWidth <= width/)
  assert.match(script, /if \(skipIfUpscale && !isWidest\) \{ stats\.skipped \+= 1; continue \}/)
})
