#!/usr/bin/env node
/**
 * 原图就地瘦身：把超宽/超大 JPEG 重编码到目标最大宽度，文件名不变（引用不用改）。
 *
 * 线上 3746 个 preview-*.jpg 占了 4.1GB（平均 1.1MB，最大 2.9MB），都是抓取生成的成品帧，
 * 展示尺寸远小于原始分辨率。这里按最大宽度 1280、质量 72 重编码后原子替换，
 * 省下的空间留给封面 WebP 变体（头像/卡片只需要几十 KB）。
 *
 * 用法：
 *   node scripts/squeeze-images.mjs --glob "preview-*.jpg" --dry-run
 *   node scripts/squeeze-images.mjs --glob "preview-*.jpg" --apply
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_MAX_WIDTH = 1280
const DEFAULT_QUALITY = 4 // ffmpeg -q:v，2 最好 31 最差

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

async function probeWidth(path) {
  const result = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width', '-of', 'csv=p=0', path,
  ])
  const width = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(width) && width > 0 ? width : 0
}

/** 把一张图重编码到 target，成功返回 true（target 已经是最终文件）。 */
async function reencode(source, target, { maxWidth, quality }) {
  const result = await run('ffmpeg', [
    '-v', 'error', '-y', '-i', source,
    '-vf', `scale='min(${maxWidth},iw)':-2:flags=lanczos`,
    '-q:v', String(quality),
    target,
  ])
  return result.ok && existsSync(target) && statSync(target).size > 0
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/**
 * @returns {{squeezed:number, skipped:number, failed:number, before:number, after:number, failures:string[]}}
 */
export async function squeezeImages({
  dir = resolve('storage/images'),
  glob = '*.jpg',
  maxWidth = DEFAULT_MAX_WIDTH,
  quality = DEFAULT_QUALITY,
  minBytes = 300000,
  concurrency = Math.max(1, Math.min(8, availableParallelism?.() ?? 4)),
  apply = false,
  limit = 0,
  log = null,
} = {}) {
  const matcher = globToRegExp(glob)
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && matcher.test(entry.name))
    .map((entry) => entry.name)
  const picked = limit > 0 ? files.slice(0, limit) : files
  const stats = { squeezed: 0, skipped: 0, failed: 0, before: 0, after: 0, failures: [] }
  const queue = [...picked]

  const worker = async () => {
    while (queue.length) {
      const file = queue.shift()
      if (!file) return
      const path = join(dir, file)
      const before = statSync(path)
      if (before.size < minBytes) { stats.skipped += 1; continue }
      const width = await probeWidth(path)
      // 宽度已经在目标以内且体积不大，就别重新压一遍白掉质量。
      if (width && width <= maxWidth && before.size < minBytes * 2) { stats.skipped += 1; continue }
      if (!apply) { stats.squeezed += 1; stats.before += before.size; stats.after += Math.round(before.size * 0.12); continue }
      const temp = `${path}.squeeze.jpg`
      await reencode(path, temp, { maxWidth, quality })
      if (!existsSync(temp) || statSync(temp).size === 0 || statSync(temp).size >= before.size) {
        rmSync(temp, { force: true })
        stats.skipped += 1
        continue
      }
      const after = statSync(temp).size
      renameSync(temp, path)
      stats.squeezed += 1
      stats.before += before.size
      stats.after += after
      if (log && stats.squeezed % 200 === 0) log(`已重压 ${stats.squeezed} 张，省 ${((stats.before - stats.after) / 1048576).toFixed(0)}MB`)
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
    glob: readFlag('glob', '*.jpg'),
    maxWidth: Number.parseInt(readFlag('max-width', String(DEFAULT_MAX_WIDTH)), 10) || DEFAULT_MAX_WIDTH,
    quality: Number.parseInt(readFlag('quality', String(DEFAULT_QUALITY)), 10) || DEFAULT_QUALITY,
    minBytes: Number.parseInt(readFlag('min-bytes', '300000'), 10) || 300000,
    concurrency: Number.parseInt(readFlag('concurrency', '4'), 10) || 4,
    limit: Number.parseInt(readFlag('limit', '0'), 10) || 0,
    apply: argv.includes('--apply'),
    log: (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`),
  }
  console.log(`开始：${options.dir} 匹配 ${options.glob} 最大宽 ${options.maxWidth} 质量 ${options.quality}${options.apply ? '' : '（只演练）'}`)
  const startedAt = Date.now()
  const stats = await squeezeImages(options)
  console.log(`完成：重压 ${stats.squeezed} 跳过 ${stats.skipped} 失败 ${stats.failed}，用时 ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
  if (stats.before) {
    console.log(`体积：${(stats.before / 1073741824).toFixed(2)}GB → ${(stats.after / 1073741824).toFixed(2)}GB，省 ${((stats.before - stats.after) / 1073741824).toFixed(2)}GB`)
  }
  for (const failure of stats.failures) console.error(`  失败 ${failure}`)
}
