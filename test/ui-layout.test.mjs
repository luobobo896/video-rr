import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

// 侧栏是「图标 + 文字」的宽栏，不是纯图标轨道。124px 一栏会把中文标签折行，
// 再被 .nav-item 的 40px 定高裁掉——2026-11 的 C 端视觉回归就是这么来的。
// 这条用例把「宽度必须装得下最长标签」变成可执行断言，防止下一个人照着
// 文档里的旧数字往回改。
const SIDEBAR_PAD = 16 * 2 // .sidebar 左右内边距
const ITEM_PAD = 12 * 2 // .nav-item 左右内边距
const ICON = 18 // .nav-item .icon
const GAP = 10 // .nav-item gap
const FONT = 13 // .nav-item font-size

const longestLabel = () => {
  const shell = read('public/src/components/AppShell.vue')
  const labels = [...shell.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  // 侧栏项与底部导航共用同一批 label，取最长者
  return labels.reduce((best, cur) => (cur.length > best.length ? cur : best), '')
}

const sidebarWidth = (css, pattern) => {
  const hit = pattern.exec(css)
  return hit ? Number(hit[1]) : null
}

test('侧栏宽度装得下最长导航标签，不折行不裁切', () => {
  const css = read('public/src/styles.css')
  const base = sidebarWidth(css, /--sidebar:\s*(\d+)px/)
  assert.ok(base, 'styles.css 必须定义 --sidebar')
  const label = longestLabel()
  assert.ok(label.length >= 4, `应从 AppShell 读到中文标签，实际读到「${label}」`)
  const required = SIDEBAR_PAD + ITEM_PAD + ICON + GAP + label.length * FONT
  assert.ok(
    base >= required,
    `--sidebar ${base}px 装不下「${label}」（${label.length} 字）：需要 ≥ ${required}px`
  )
})

test('窄一档的侧栏宽度也装得下最长标签', () => {
  const css = read('public/src/styles.css')
  const narrow = sidebarWidth(css, /@media \(max-width: 1279px\):?[^{]*\{\s*:root\s*\{\s*--sidebar:\s*(\d+)px/s)
  assert.ok(narrow, '1024–1279 档必须单独收窄 --sidebar')
  const label = longestLabel()
  const required = SIDEBAR_PAD + ITEM_PAD + ICON + GAP + label.length * FONT
  assert.ok(narrow >= required, `窄档 --sidebar ${narrow}px 装不下「${label}」：需要 ≥ ${required}px`)
})

test('导航项单行显示：nowrap + 省略号，避免定高裁切', () => {
  const css = read('public/src/styles.css')
  assert.match(css, /\.nav-item \{[^}]*white-space:\s*nowrap/, '.nav-item 需要 white-space: nowrap')
  assert.match(css, /\.nav-item \.nav-text \{[^}]*text-overflow:\s*ellipsis/, '.nav-text 需要省略号兜底')
  const shell = read('public/src/components/AppShell.vue')
  assert.match(shell, /<span class="nav-text">\{\{ item\.label \}\}<\/span>/, '标签必须包在 .nav-text 里')
})

test('DESIGN.md 记录的侧栏宽度与 CSS 一致', () => {
  const css = read('public/src/styles.css')
  const base = sidebarWidth(css, /--sidebar:\s*(\d+)px/)
  const doc = read('DESIGN.md')
  assert.match(doc, /sidebar (\d+)px/, 'DESIGN.md 必须写明侧栏宽度')
  const documented = Number(/sidebar (\d+)px/.exec(doc)[1])
  assert.equal(documented, base, `DESIGN.md 写的是 ${documented}px，CSS 是 ${base}px`)
})
