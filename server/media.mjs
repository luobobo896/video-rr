/**
 * 视频处理：上传落盘 → ffprobe 探测 → ffmpeg 转多码率 HLS（720p/480p + master）→ 进度回写。
 * 单进程串行队列（并发 1）；1000 并发播放靠 nginx 直接吐切片 + 可选 CDN，Node 不碰视频字节。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, ROOT } from './db.mjs'

export const UPLOAD_DIR = join(ROOT, 'storage', 'uploads')
export const HLS_DIR = join(ROOT, 'storage', 'hls')
const FFMPEG = process.env.MH_FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.MH_FFPROBE ?? 'ffprobe'

/** 清晰度阶梯：默认 480p 覆盖弱网，720p 给宽带用户。 */
export const RENDITIONS = [
  { name: '720p', height: 720, vbitrate: '2200k', maxrate: '2400k', bufsize: '4800k', audio: '128k', bandwidth: 2_600_000 },
  { name: '480p', height: 480, vbitrate: '850k', maxrate: '950k', bufsize: '1900k', audio: '96k', bandwidth: 1_000_000 },
]

mkdirSync(UPLOAD_DIR, { recursive: true })
mkdirSync(HLS_DIR, { recursive: true })

const queue = []
let running = false
const stats = { queued: 0, done: 0, failed: 0, current: null }

export function queueState() {
  return { ...stats, pending: queue.length, running, current: stats.current, pendingItems: queue.map((job) => ({ episodeId: job.episodeId, dramaId: job.dramaId, no: job.no })) }
}

export function probe(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out)
        const video = (parsed.streams ?? []).find((stream) => stream.codec_type === 'video')
        resolve({
          duration: Number(parsed.format?.duration ?? 0),
          width: video?.width ?? 0,
          height: video?.height ?? 0,
          codec: video?.codec_name ?? '',
          bitrate: Number(parsed.format?.bit_rate ?? 0),
        })
      } catch { resolve(undefined) }
    })
  })
}

function enqueue(job) {
  queue.push(job)
  stats.queued += 1
  pump()
}

async function pump() {
  if (running) return
  const job = queue.shift()
  if (!job) return
  running = true
  stats.current = { episodeId: job.episodeId, source: job.source, startedAt: new Date().toISOString() }
  try {
    await transcode(job)
    stats.done += 1
  } catch (error) {
    stats.failed += 1
    db.prepare('UPDATE episodes SET status = ?, error = ? WHERE id = ?').run('error', String(error?.message ?? error).slice(0, 500), job.episodeId)
  } finally {
    running = false
    stats.current = null
    if (queue.length > 0) setImmediate(pump)
  }
}

/** 转一档：单次 ffmpeg 调用，输出到 <outDir>/<name>/index.m3u8。 */
function transcodeRendition({ source, outDir, rendition, duration, onProgress }) {
  return new Promise((resolve, reject) => {
    mkdirSync(outDir, { recursive: true })
    const args = [
      '-y', '-i', source,
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-b:v', rendition.vbitrate, '-maxrate', rendition.maxrate, '-bufsize', rendition.bufsize,
      '-vf', `scale=-2:${rendition.height}`,
      '-c:a', 'aac', '-b:a', rendition.audio, '-ac', '2',
      '-g', '96', '-keyint_min', '96', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*4)',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', join(outDir, 'seg_%03d.ts'),
      '-progress', 'pipe:1', '-nostats',
      join(outDir, 'index.m3u8'),
    ]
    const child = spawn(FFMPEG, args, { windowsHide: true })
    let stderr = ''
    let lastPercent = -1
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        const match = /out_time_ms=(\d+)/.exec(line)
        if (!match || !duration) continue
        const percent = Math.min(99, Math.round((Number(match[1]) / 1_000_000 / duration) * 100))
        if (percent !== lastPercent) { lastPercent = percent; onProgress(percent) }
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 8000) stderr = stderr.slice(-4000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.split('\n').filter(Boolean).slice(-4).join(' | ')}`))
      const playlist = join(outDir, 'index.m3u8')
      if (!existsSync(playlist)) return reject(new Error('ffmpeg 未生成 playlist'))
      resolve({ playlist, size: statSync(playlist).size })
    })
  })
}

async function transcode({ episodeId, source, durationHint }) {
  const outDir = join(HLS_DIR, String(episodeId))
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  db.prepare("UPDATE episodes SET status = 'transcoding', progress = 0, error = NULL WHERE id = ?").run(episodeId)

  const total = RENDITIONS.length
  for (let index = 0; index < total; index++) {
    const rendition = RENDITIONS[index]
    await transcodeRendition({
      source,
      outDir: join(outDir, rendition.name),
      rendition,
      duration: durationHint,
      onProgress: (percent) => {
        const overall = Math.min(99, Math.round(((index + percent / 100) / total) * 100))
        db.prepare('UPDATE episodes SET progress = ? WHERE id = ?').run(overall, episodeId)
      },
    })
  }

  // master playlist：播放器按带宽自动选档
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const rendition of RENDITIONS) {
    const height = rendition.height
    const width = Math.round((height * 16) / 9)
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},RESOLUTION=${width}x${height},CODECS="avc1.4d401f,mp4a.40.2"`)
    lines.push(`${rendition.name}/index.m3u8`)
  }
  writeFileSync(join(outDir, 'index.m3u8'), lines.join('\n') + '\n', 'utf8')

  db.prepare("UPDATE episodes SET status = 'ready', progress = 100, hls_path = ?, error = NULL WHERE id = ?")
    .run(`/media/hls/${episodeId}/index.m3u8`, episodeId)
}

export function enqueueEpisode(episode) {
  db.prepare("UPDATE episodes SET source_path = ?, status = 'queued', progress = 0, error = NULL WHERE id = ?")
    .run(episode.source_path, episode.id)
  enqueue({ episodeId: episode.id, dramaId: episode.drama_id, no: episode.no, source: episode.source_path, durationHint: episode.duration ?? 0 })
}

export function generateSample(seconds = 30, label = 'sample') {
  const target = join(UPLOAD_DIR, `${label}-${Date.now()}.mp4`)
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', target,
    ]
    const child = spawn(FFMPEG, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(target) : reject(new Error(`生成示例失败: ${stderr.slice(-400)}`))))
  })
}
