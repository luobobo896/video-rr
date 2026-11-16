import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (relative) => readFileSync(join(ROOT, relative))

const ART = [
  'logo-mark.png', 'logo-wide.png',
  'hero-scifi.jpg', 'hero-period.jpg', 'hero-suspense.jpg',
  'poster-scifi.jpg', 'poster-period.jpg', 'poster-suspense.jpg', 'poster-romance.jpg',
  'poster-animation.jpg', 'poster-documentary.jpg', 'poster-comedy.jpg', 'poster-action.jpg',
  'category-movie.jpg', 'category-tv.jpg', 'category-anime.jpg', 'category-variety.jpg',
  'login-bg.jpg', 'empty-404.jpg'
]

test('品牌素材：19 张插画与 logo 都在 public/art 下，且体积合理', () => {
  for (const name of ART) {
    const path = join(ROOT, 'public/art', name)
    assert.ok(existsSync(path), `public/art/${name} 缺失`)
    assert.ok(statSync(path).size > 5 * 1024, `public/art/${name} 体积异常`)
  }
  const mark = read('public/art/logo-mark.png')
  assert.equal(mark.subarray(1, 4).toString('ascii'), 'PNG', 'logo-mark 应为 PNG')
  assert.deepEqual([mark.readUInt32BE(16), mark.readUInt32BE(20)], [256, 256], 'logo-mark 应为 256×256')
  for (const name of ART.filter((item) => item.endsWith('.jpg'))) {
    const data = read(`public/art/${name}`)
    assert.deepEqual([...data.subarray(0, 3)], [0xff, 0xd8, 0xff], `${name} 应为 JPEG`)
  }
})

test('构建脚本把 art 目录复制到 dist/client，否则线上 404', () => {
  const script = readFileSync(join(ROOT, 'scripts/copy-frontend-assets.mjs'), 'utf8')
  assert.match(script, /for \(const dir of \['icons', 'brand', 'art', 'vendor'\]\)/)
})

test('页面确实引用这些素材：品牌 logo、空态插画、登录背景、无封面兜底', () => {
  const shell = read('public/src/components/AppShell.vue').toString('utf8')
  assert.match(shell, /brand-mark--logo/)
  assert.match(shell, /\.\/art\/logo-mark\.png/)

  const app = read('public/src/App.vue').toString('utf8')
  assert.match(app, /empty-art/)
  assert.match(app, /\.\/art\/empty-404\.jpg/)

  const login = read('public/src/pages/c/LoginPage.vue').toString('utf8')
  assert.match(login, /login-bg/)
  assert.match(login, /\.\/art\/login-bg\.jpg/)

  const filmArt = read('public/src/components/FilmArt.vue').toString('utf8')
  assert.match(filmArt, /film-fallback/)
  assert.match(filmArt, /FALLBACK_ART/)
  assert.match(filmArt, /poster-scifi/)
})
