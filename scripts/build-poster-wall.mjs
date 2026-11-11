#!/usr/bin/env node
/**
 * 从已有封面/横幅派生海报墙小图。
 *
 * 安全边界：
 *   - 不下载、不读取、不转码视频源，只处理 storage/images 中已有的封面/横幅；
 *   - 先写临时目录，体积超限或磁盘余量不足时整体放弃，不污染正式目录；
 *   - 默认跳过已存在文件，重复执行不新增占用。
 *
 * 用法：
 *   node scripts/build-poster-wall.mjs
 *   node scripts/build-poster-wall.mjs --force
 *   node scripts/build-poster-wall.mjs --check
 */
import { execFile } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync, unlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  POSTER_VARIANTS, POSTER_VARIANT_ORDER, posterFileName, posterWallCandidates,
} from '../server/poster-wall.mjs'

const exec = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const IMG_DIR = join(ROOT, 'storage', 'images')
const FFMPEG = process.env.MH_FFMPEG ?? 'ffmpeg'
const FORCE = process.argv.includes('--force')
const CHECK = process.argv.includes('--check')
const MAX_BYTES = Math.max(1, Number(process.env.MH_POSTER_MAX_MB ?? 32)) * 1024 * 1024
const RESERVE_BYTES = Math.max(0, Number(process.env.MH_POSTER_RESERVE_MB ?? 1024)) * 1024 * 1024

const mb = (bytes) => `${(Number(bytes) / 1024 / 1024).toFixed(2)} MB`

function freeBytes() {
  const stats = statfsSync(IMG_DIR)
  return Number(stats.bavail) * Number(stats.bsize)
}

function targetOf(candidate, variantKey) {
  return join(IMG_DIR, posterFileName(candidate.source.slug, variantKey))
}

function sourceOf(candidate, variantKey) {
  const spec = POSTER_VARIANTS[variantKey]
  if (spec.source === 'banner' && existsSync(candidate.bannerFile)) return candidate.bannerFile
  return candidate.coverFile
}

function summarizeCheck() {
  const candidates = posterWallCandidates()
  let missing = 0
  let totalBytes = 0
  for (const candidate of candidates) {
    for (const key of POSTER_VARIANT_ORDER) {
      const file = targetOf(candidate, key)
      if (!existsSync(file)) {
        missing += 1
        console.log(`  MISSING ${candidate.source.slug}/${key}`)
      } else {
        totalBytes += statSync(file).size
      }
    }
  }
  console.log(`海报墙：${candidates.length} 部，${POSTER_VARIANT_ORDER.length} 种画幅，现有 ${mb(totalBytes)}，缺失 ${missing} 张`)
  if (missing > 0) process.exitCode = 1
}

async function build() {
  if (CHECK) return summarizeCheck()

  mkdirSync(IMG_DIR, { recursive: true })
  const candidates = posterWallCandidates()
  if (!candidates.length) {
    console.log('没有可生成海报的开放授权内容（需要 catalog 匹配与本地封面）')
    return
  }

  const freeBefore = freeBytes()
  if (freeBefore < RESERVE_BYTES) {
    throw new Error(`磁盘余量不足：${mb(freeBefore)} < 保护线 ${mb(RESERVE_BYTES)}`)
  }

  const stage = join(IMG_DIR, `.poster-wall-stage-${process.pid}-${Date.now()}`)
  mkdirSync(stage, { recursive: true })
  let generated = 0
  let skipped = 0

  try {
    for (const candidate of candidates) {
      for (const key of POSTER_VARIANT_ORDER) {
        const target = targetOf(candidate, key)
        if (!FORCE && existsSync(target)) {
          skipped += 1
          continue
        }
        const source = sourceOf(candidate, key)
        const staged = join(stage, posterFileName(candidate.source.slug, key))
        try {
          await exec(FFMPEG, [
            '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
            '-i', source,
            '-frames:v', '1',
            '-vf', POSTER_VARIANTS[key].filter,
            '-q:v', '4',
            '-map_metadata', '-1',
            staged,
          ], { timeout: 60_000, windowsHide: true })
          const size = statSync(staged).size
          if (size < 3_000) throw new Error(`生成文件过小：${size} bytes`)
          generated += 1
          console.log(`  ${candidate.source.slug}/${key} ${mb(size)}`)
        } catch (error) {
          console.warn(`  跳过 ${candidate.source.slug}/${key}：${error.message}`)
        }
      }
    }

    const stagedFiles = readdirSync(stage)
    const stagedBytes = stagedFiles.reduce((sum, name) => sum + statSync(join(stage, name)).size, 0)
    if (stagedBytes > MAX_BYTES) {
      throw new Error(`本次产物 ${mb(stagedBytes)} 超过上限 ${mb(MAX_BYTES)}，已放弃写入`)
    }
    // 复制阶段会短暂占用两份空间；保护线按复制前可用量计算。
    if (freeBytes() - stagedBytes < RESERVE_BYTES) {
      throw new Error(`复制后可能低于磁盘保护线 ${mb(RESERVE_BYTES)}，已放弃写入`)
    }

    for (const name of stagedFiles) {
      const target = join(IMG_DIR, name)
      if (existsSync(target)) unlinkSync(target)
      copyFileSync(join(stage, name), target)
    }
    console.log(`海报墙生成完成：写入 ${generated} 张，跳过 ${skipped} 张，本次 ${mb(stagedBytes)}，当前余量 ${mb(freeBytes())}`)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

build().catch((error) => {
  console.error(`海报墙生成失败：${error.message}`)
  process.exitCode = 1
})
