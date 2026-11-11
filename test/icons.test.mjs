import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pngSize = (path) => {
  const data = readFileSync(path)
  assert.equal(data.subarray(1, 4).toString('ascii'), 'PNG')
  return [data.readUInt32BE(16), data.readUInt32BE(20)]
}

test('网站图标：favicon、Apple、PWA、Windows 全套尺寸齐全', () => {
  const expected = new Map([
    ['public/icons/favicon-16x16.png', [16, 16]],
    ['public/icons/favicon-32x32.png', [32, 32]],
    ['public/icons/icon-64x64.png', [64, 64]],
    ['public/icons/icon-180x180.png', [180, 180]],
    ['public/icons/icon-192x192.png', [192, 192]],
    ['public/icons/icon-512x512.png', [512, 512]],
    ['public/icons/icon-maskable-512.png', [512, 512]],
    ['public/icons/icon-1024.png', [1024, 1024]],
    ['public/icons/mstile-310x150.png', [310, 150]],
  ])
  for (const [relative, size] of expected) {
    const path = join(ROOT, relative)
    assert.ok(existsSync(path), `${relative} 缺失`)
    assert.deepEqual(pngSize(path), size, `${relative} 尺寸不正确`)
  }
  for (const relative of ['public/favicon.ico', 'admin/favicon.ico', 'public/apple-touch-icon.png', 'admin/apple-touch-icon.png']) {
    assert.ok(existsSync(join(ROOT, relative)), `${relative} 缺失`)
  }
})

test('站点与后台均声明 manifest，manifest 图标路径全部存在', () => {
  const pages = [
    ['public/index.html', 'public/site.webmanifest'],
    ['admin/index.html', 'admin/admin.webmanifest'],
  ]
  for (const [pagePath, manifestPath] of pages) {
    const html = readFileSync(join(ROOT, pagePath), 'utf8')
    assert.match(html, /rel="manifest"/)
    assert.match(html, /apple-touch-icon/)
    const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath), 'utf8'))
    assert.equal(manifest.display, 'standalone')
    for (const icon of manifest.icons) {
      const asset = join(ROOT, manifestPath, '..', icon.src)
      assert.ok(existsSync(asset), `${manifestPath} 引用的 ${icon.src} 不存在`)
    }
  }
})
