#!/usr/bin/env node
/**
 * 封面/剧照瘦身：把 storage/images 下的大图批量生成多个宽度的 WebP 变体。
 *
 * 线上现状（2026-11-17）：14950 张 jpg，平均 384KB，最大 2.9MB；片库一页 24 张卡片
 * 首屏就要下 9MB，跨境链路上百 KB/s 的速率意味着十几秒。这里按卡片/详情页实际需要的
 * 宽度出 webp（320/640/1280），把每张压到十几 KB，前端用 srcset 按需取。
 *
 * 用法：
 *   node scripts/build-image-variants.mjs                    # 全量补建
 *   node scripts/build-image-variants.mjs --dry-run --limit 20
 *   node scripts/build-image-variants.mjs --dir /tmp/pics --widths 320,640
 *
 * 幂等：变体比源图新就跳过；源图更小（≤ 目标宽 5%）不放大，直接不生成该宽度。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_WIDTHS = Object.freeze([320, 640, 1280])
export const VARIANT_DIR = 'variants'
const SOURCE_EXT = new Set(['.jpg', '.jpeg', '.png'])
const WEBP_QUALITY = 70

export function variantDirOf(dir) {
  return join(dir, VARIANT_DIR)
}

export function variantNameOf(file, width) {
  return `${file.slice(0, file.length - extname(file).length)}-w${width}.webp`
}

function run(command, args) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolveRun({ ok: false, stdout, stderr: String(error?.message ?? error) }))
    child.on('close', (code) => resolveRun({ ok: code === 0, stdout, stderr }))
  })
}

async function widthOf(path) {
  const result = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width', '-of', 'csv=p=0', path,
  ])
  const width = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(width) && width > 0 ? width : 0
}

async function convert(source, target, width) {
  return run('ffmpeg', [
    '-v', 'error', '-y', '-i', source,
    '-vf', `scale=${width}:-2:flags=lanczos`,
    '-c:v', 'libwebp', '-quality', String(WEBP_QUALITY), '-compression_level', '5',
    target,
  ])
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXT.has(extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
}

/**
 * @returns {{generated:number, skipped:number, failed:number, sourceBytes:number, variantBytes:number, failures:string[]}}
 */
export async function buildVariants({
  dir = resolve('storage/images'),
  widths = DEFAULT_WIDTHS,
  concurrency = Math.max(1, Math.min(8, availableParallelism?.() ?? 4)),
  limit = 0,
  dryRun = false,
  log = null,
} = {}) {
  const targetDir = variantDirOf(dir)
  const files = sourceFiles(dir)
  const picked = limit > 0 ? files.slice(0, limit) : files
  const stats = { generated: 0, skipped: 0, failed: 0, sourceBytes: 0, variantBytes: 0, failures: [] }
  if (!dryRun) mkdirSync(targetDir, { recursive: true })

  const queue = [...picked]
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift()
      if (!file) return
      const source = join(dir, file)
      const sourceStat = statSync(source)
      const sourceWidth = await widthOf(source)
      for (const width of widths) {
        // 源图本来就窄，放大只会更糊更占带宽；探不出宽度的（损坏或非常规格式）照常尝试，转换失败会记进 failed。
        if (sourceWidth && sourceWidth <= width * 1.05) { stats.skipped += 1; continue }
        const target = join(targetDir, variantNameOf(file, width))
        if (existsSync(target) && statSync(target).mtimeMs >= sourceStat.mtimeMs) { stats.skipped += 1; continue }
        if (dryRun) { stats.generated += 1; continue }
        // eslint-disable-next-line no-await-in-loop
        const result = await convert(source, target, width)
        if (result.ok && existsSync(target)) {
          stats.generated += 1
          stats.sourceBytes += sourceStat.size
          stats.variantBytes += statSync(target).size
        } else {
          stats.failed += 1
          if (stats.failures.length < 20) stats.failures.push(`${file}@${width}: ${result.stderr.slice(0, 160)}`)
        }
      }
      if (log && (stats.generated + stats.skipped) % 200 === 0) {
        log(`已处理 ${stats.generated + stats.skipped} 个变体，失败 ${stats.failed}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return stats
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const readFlag = (name, fallback = '') => {
    const withEquals = argv.find((item) => item.startsWith(`--${name}=`))
    if (withEquals) return withEquals.slice(name.length + 3)
    const at = argv.indexOf(`--${name}`)
    const next = argv[at + 1]
    return at >= 0 && next && !next.startsWith('--') ? next : fallback
  }
  const options = {
    dir: resolve(readFlag('dir', 'storage/images')),
    widths: readFlag('widths', DEFAULT_WIDTHS.join(',')).split(',').map((value) => Number.parseInt(value, 10)).filter((value) => value > 0),
    concurrency: Number.parseInt(readFlag('concurrency', '4'), 10) || 4,
    limit: Number.parseInt(readFlag('limit', '0'), 10) || 0,
    dryRun: argv.includes('--dry-run'),
    log: (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`),
  }
  console.log(`开始：${options.dir} 宽度 ${options.widths.join('/')} 并发 ${options.concurrency}${options.dryRun ? '（只演练）' : ''}`)
  const startedAt = Date.now()
  const stats = await buildVariants(options)
  const savedMb = ((stats.sourceBytes - stats.variantBytes) / 1048576).toFixed(1)
  console.log(`完成：生成 ${stats.generated} 跳过 ${stats.skipped} 失败 ${stats.failed}，用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
  if (stats.sourceBytes) console.log(`体积：源 ${(stats.sourceBytes / 1048576).toFixed(1)}MB → 变体 ${(stats.variantBytes / 1048576).toFixed(1)}MB，省 ${savedMb}MB`)
  for (const failure of stats.failures) console.error(`  失败 ${failure}`)
  if (stats.failed) process.exitCode = 1
}
