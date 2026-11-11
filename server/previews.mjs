import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
export const PREVIEW_DIR = join(ROOT, 'storage', 'previews')
mkdirSync(PREVIEW_DIR, { recursive: true })

export function previewPath(slug) {
  return join(PREVIEW_DIR, `preview-${slug}.mp4`)
}

export function previewUrlForCover(coverUrl) {
  const slug = /\/cover-([^/?.]+)\.jpg(?:\?.*)?$/i.exec(String(coverUrl ?? ''))?.[1]
  if (!slug) return null
  try {
    return existsSync(previewPath(slug)) && statSync(previewPath(slug)).size > 1000
      ? `/media/previews/preview-${slug}.mp4`
      : null
  } catch {
    return null
  }
}

export function generatePreview({ source, slug, at = 6, duration = 16, force = false, ffmpeg = process.env.MH_FFMPEG ?? 'ffmpeg' }) {
  const target = previewPath(slug)
  if (!force && existsSync(target) && statSync(target).size > 1000) {
    return Promise.resolve({ skipped: true, bytes: statSync(target).size, target })
  }
  const args = [
    '-y', '-ss', String(Math.max(0, at)), '-i', source, '-t', String(duration),
    '-vf', 'scale=960:540:force_original_aspect_ratio=increase,crop=960:540',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '29',
    '-maxrate', '1800k', '-bufsize', '3600k', '-r', '24',
    '-movflags', '+faststart', target,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 12000) stderr = stderr.slice(-6000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.split('\n').filter(Boolean).slice(-4).join(' | ')
        reject(new Error(`预览片生成失败（${code}）：${tail}`))
        return
      }
      if (!existsSync(target) || statSync(target).size < 1000) {
        reject(new Error('预览片生成失败：输出文件为空'))
        return
      }
      resolve({ skipped: false, bytes: statSync(target).size, target })
    })
  })
}
