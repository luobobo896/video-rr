#!/usr/bin/env node
/**
 * 为首页悬停/hero 自动播放生成 16:9 静音预览片。
 *
 * 用法：
 *   node scripts/generate-previews.mjs
 *   node scripts/generate-previews.mjs --only sintel,coffee
 *   node scripts/generate-previews.mjs --force --duration 20
 */
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePreview, previewPath } from '../server/previews.mjs'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8'))
const argv = process.argv.slice(2)
const valueOf = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 ? String(argv[index + 1] ?? fallback) : fallback
}
const only = new Set(valueOf('--only').split(',').map((slug) => slug.trim()).filter(Boolean))
const force = argv.includes('--force')
const duration = Math.max(6, Math.min(30, Number(valueOf('--duration', '16')) || 16))

function sourceOf(drama) {
  const url = String(drama.source?.url ?? '')
  const extension = extname(new URL(url).pathname).toLowerCase() || '.mp4'
  const local = join(ROOT, 'storage', 'sources', `${drama.slug}${extension}`)
  return existsSync(local) ? local : url
}

let failed = 0
let created = 0
for (const drama of catalog.dramas) {
  if (only.size > 0 && !only.has(drama.slug)) continue
  if (!drama.source?.url) continue
  const total = Number(drama.source.duration ?? 0)
  const at = total > 30 ? Math.min(60, Math.max(4, total * 0.18)) : 4
  try {
    const result = await generatePreview({
      source: sourceOf(drama),
      slug: drama.slug,
      at,
      duration,
      force,
    })
    if (!result.skipped) created += 1
    console.log(`${result.skipped ? '跳过' : '生成'} ${drama.slug} → ${previewPath(drama.slug)}（${(result.bytes / 1024 / 1024).toFixed(2)} MB）`)
  } catch (error) {
    failed += 1
    console.error(`失败 ${drama.slug}：${error.message}`)
  }
}

console.log(`完成：新增 ${created} 个，失败 ${failed} 个`)
if (failed > 0) process.exitCode = 1
