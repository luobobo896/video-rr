#!/usr/bin/env node
/**
 * 真实内容导入流水线：清空演示数据 → 下载 CC 授权影片 → 按集切片 → 双码率 HLS → 封面/横幅 → 标签/分区/榜单。
 *
 * 用法：
 *   node scripts/import-catalog.mjs --reset            只清空演示数据与媒体文件
 *   node scripts/import-catalog.mjs --build            清空并重建全部内容（默认）
 *   node scripts/import-catalog.mjs --build --only bbb,sintel
 *   node scripts/import-catalog.mjs --keep --only sintel --force   只重切指定剧（不动其它内容）
 *   node scripts/import-catalog.mjs --force            已完整时也重新下载/重切
 *   node scripts/import-catalog.mjs --check            只做一致性自检
 *   node scripts/import-catalog.mjs --list             打印清单
 *
 * 片源均为公开授权（见 data/catalog.json 的 license / credit 字段），下载后落 storage/sources，转码落 storage/hls/<episodeId>。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { db, ROOT } from '../server/db.mjs'

const FFMPEG = process.env.MH_FFMPEG ?? 'ffmpeg'
const FFPROBE = process.env.MH_FFPROBE ?? 'ffprobe'
const DATA = join(ROOT, 'data', 'catalog.json')
const SRC_DIR = join(ROOT, 'storage', 'sources')
const HLS_DIR = join(ROOT, 'storage', 'hls')
const UPLOAD_DIR = join(ROOT, 'storage', 'uploads')
const IMG_DIR = join(ROOT, 'storage', 'images')
for (const dir of [SRC_DIR, HLS_DIR, UPLOAD_DIR, IMG_DIR]) mkdirSync(dir, { recursive: true })

/** 清晰度阶梯：与 server/media.mjs 的 RENDITIONS 保持一致。 */
const LADDER = [
  { name: '720p', height: 720, vbitrate: '2200k', maxrate: '2400k', bufsize: '4800k', audio: '128k', bandwidth: 2_600_000 },
  { name: '480p', height: 480, vbitrate: '850k', maxrate: '950k', bufsize: '1900k', audio: '96k', bandwidth: 1_000_000 },
  { name: '360p', height: 360, vbitrate: '520k', maxrate: '600k', bufsize: '1200k', audio: '64k', bandwidth: 640_000 },
]

const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 ? String(argv[index + 1] ?? fallback) : fallback
}
const ONLY = valueOf('--only').split(',').map((item) => item.trim()).filter(Boolean)
const FORCE = has('--force')
const KEEP = has('--keep')

function stamp() {
  return new Date().toISOString().slice(11, 19)
}
function log(message) {
  console.log(`[${stamp()}] ${message}`)
}

function run(command, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true })
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      if (!onLine) return
      for (const line of String(chunk).split('\n')) if (line.trim()) onLine(line)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > 12000) stderr = stderr.slice(-6000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      const tail = stderr.split('\n').filter(Boolean).slice(-4).join(' | ')
      reject(new Error(`${command} 退出码 ${code}: ${tail}`))
    })
  })
}

function probeFile(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('error', () => resolve(undefined))
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out)
        const video = (parsed.streams ?? []).find((stream) => stream.codec_type === 'video')
        const audio = (parsed.streams ?? []).find((stream) => stream.codec_type === 'audio')
        resolve({
          duration: Number(parsed.format?.duration ?? 0),
          width: Number(video?.width ?? 0),
          height: Number(video?.height ?? 0),
          hasAudio: Boolean(audio),
        })
      } catch {
        resolve(undefined)
      }
    })
  })
}

function extOf(url) {
  const clean = url.split('?')[0]
  const match = /\.([a-z0-9]{2,5})$/i.exec(clean)
  return match ? match[1].toLowerCase() : 'mp4'
}

async function download(url, target, expectedBytes = 0) {
  if (existsSync(target)) {
    const size = statSync(target).size
    // 片源地址换了但文件名没变时会命中旧文件：必须比对 catalog 里声明的字节数
    const matches = expectedBytes > 0 ? Math.abs(size - expectedBytes) <= Math.max(1024, expectedBytes * 0.001) : size > 1_000_000
    if (size > 1_000_000 && matches) return { skipped: true, bytes: size, file: target }
    if (size > 1_000_000 && !matches) log(`  片源已变更（本地 ${(size / 1048576).toFixed(1)}MB ≠ 期望 ${(expectedBytes / 1048576).toFixed(1)}MB），重新下载`)
    rmSync(target, { force: true })
    rmSync(`${target}.part`, { force: true })
  }
  const part = `${target}.part`
  const timeout = Number(process.env.MH_DOWNLOAD_TIMEOUT ?? 1_800_000)
  const maxAttempts = Number(process.env.MH_DOWNLOAD_RETRY ?? 4)
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 断点续传：archive.org 对慢链路经常中途超时，残片必须保留下来接着下
    const resumeFrom = existsSync(part) ? statSync(part).size : 0
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        headers: resumeFrom > 0 ? { range: `bytes=${resumeFrom}-` } : {},
        signal: AbortSignal.timeout(timeout),
      })
      const resumed = response.status === 206
      if (response.status !== 200 && response.status !== 206) throw new Error(`下载失败 HTTP ${response.status}：${url}`)
      if (!response.body) throw new Error(`下载响应无内容：${url}`)
      const startAt = resumed ? resumeFrom : 0
      const remaining = Number(response.headers.get('content-length') ?? 0)
      const totalMb = remaining ? ((startAt + remaining) / 1048576).toFixed(1) : '?'
      if (resumed) log(`  续传 从 ${(startAt / 1048576).toFixed(1)}/${totalMb} MB 继续（第 ${attempt} 次）`)
      let received = startAt
      let lastTick = Date.now()
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length
          const now = Date.now()
          if (now - lastTick >= 5000) {
            lastTick = now
            log(`  下载 ${(received / 1048576).toFixed(1)}/${totalMb} MB`)
          }
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(part, { flags: resumed ? 'a' : 'w' }))
      const size = statSync(part).size
      if (size < 100_000) throw new Error(`下载内容过小（${size} 字节）：${url}`)
      if (expectedBytes > 0 && Math.abs(size - expectedBytes) > Math.max(1024, expectedBytes * 0.001)) {
        throw new Error(`下载不完整（${(size / 1048576).toFixed(1)}MB ≠ 期望 ${(expectedBytes / 1048576).toFixed(1)}MB）：${url}`)
      }
      renameSync(part, target)
      log(`  下载完成 ${(size / 1048576).toFixed(1)} MB`)
      return { skipped: false, bytes: size, file: target }
    } catch (error) {
      lastError = error
      const kept = existsSync(part) ? statSync(part).size : 0
      log(`  第 ${attempt} 次下载中断：${error.message}（已保留 ${(kept / 1048576).toFixed(1)}MB）`)
      if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 5000 * attempt))
    }
  }
  throw new Error(`下载多次失败（已尝试 ${maxAttempts} 次）：${lastError?.message ?? 'unknown'}`)
}

function pickRenditions(sourceHeight) {
  const fits = LADDER.filter((rendition) => rendition.height <= (Number(sourceHeight) || 720) + 8)
  const picked = fits.slice(0, 2)
  return picked.length > 0 ? picked : [LADDER[LADDER.length - 1]]
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    total += entry.isDirectory() ? dirSize(full) : statSync(full).size
  }
  return total
}

async function grabImage(source, at, target, filter) {
  await run(FFMPEG, ['-y', '-ss', String(Math.max(0, at)), '-i', source, '-frames:v', '1', '-vf', filter, '-q:v', '3', target])
  if (!existsSync(target) || statSync(target).size < 5000) throw new Error(`封面生成失败：${target}`)
  return statSync(target).size
}

async function transcodeEpisode({ episodeId, source, start, length, sourceHeight }) {
  const outDir = join(HLS_DIR, String(episodeId))
  rmSync(outDir, { recursive: true, force: true })
  const renditions = pickRenditions(sourceHeight)
  for (const rendition of renditions) {
    const dir = join(outDir, rendition.name)
    mkdirSync(dir, { recursive: true })
    const args = [
      '-y', '-ss', String(Math.max(0, start)), '-t', String(length), '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-b:v', rendition.vbitrate, '-maxrate', rendition.maxrate, '-bufsize', rendition.bufsize,
      '-vf', `scale=-2:${rendition.height}`,
      '-c:a', 'aac', '-b:a', rendition.audio, '-ac', '2',
      '-g', '96', '-keyint_min', '96', '-sc_threshold', '0',
      '-force_key_frames', 'expr:gte(t,n_forced*4)',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', join(dir, 'seg_%03d.ts'),
      '-progress', 'pipe:1', '-nostats',
      join(dir, 'index.m3u8'),
    ]
    let lastPercent = -1
    await run(FFMPEG, args, {
      onLine: (line) => {
        const match = /out_time_ms=(\d+)/.exec(line)
        if (!match || !length) return
        const percent = Math.min(100, Math.round((Number(match[1]) / 1_000_000 / length) * 100))
        if (percent >= lastPercent + 25) {
          lastPercent = percent
          log(`      ${rendition.name} ${percent}%`)
        }
      },
    })
    if (!existsSync(join(dir, 'index.m3u8'))) throw new Error('ffmpeg 未生成 playlist')
  }

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const rendition of renditions) {
    const width = Math.round((rendition.height * 16) / 9)
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth},RESOLUTION=${width}x${rendition.height},CODECS="avc1.4d401f,mp4a.40.2"`)
    lines.push(`${rendition.name}/index.m3u8`)
  }
  writeFileSync(join(outDir, 'index.m3u8'), `${lines.join('\n')}\n`, 'utf8')

  const bytes = dirSize(outDir)
  db.prepare("UPDATE episodes SET status = 'ready', progress = 100, hls_path = ?, error = NULL, duration = ? WHERE id = ?")
    .run(`/media/hls/${episodeId}/index.m3u8`, Math.round(length * 10) / 10, episodeId)
  return { renditions: renditions.map((rendition) => rendition.name), bytes }
}

const DEMO_TABLES = [
  'coupon_redemptions', 'refunds', 'payments', 'orders', 'purchases', 'subscriptions',
  'history', 'favorites', 'comments', 'danmus',
  'rank_items', 'section_items', 'banners', 'sections', 'rank_lists',
  'drama_tags', 'tags', 'content_policies', 'episodes', 'dramas',
  'play_events', 'track_events', 'sessions', 'email_codes', 'email_send_log', 'users',
]

function tableNames() {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))
}

function resetDemo() {
  const existing = tableNames()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const table of DEMO_TABLES) if (existing.has(table)) db.exec(`DELETE FROM ${table}`)
    if (existing.has('sqlite_sequence')) db.exec("DELETE FROM sqlite_sequence WHERE name IN ('dramas','episodes','tags','sections','section_items','banners','rank_lists','rank_items','orders','users','comments','danmus')")
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  for (const dir of [HLS_DIR, UPLOAD_DIR]) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true })
  }
  for (const entry of readdirSync(IMG_DIR)) rmSync(join(IMG_DIR, entry), { force: true })
  log('已清空演示数据与媒体文件（管理员、套餐、支付/邮件设置保留）')
}

function upsertTag(name, sort) {
  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)
  if (existing) return existing.id
  const info = db.prepare("INSERT INTO tags (name, sort, status) VALUES (?, ?, 'active')").run(name, sort)
  return Number(info.lastInsertRowid)
}

async function buildOne(drama, index, segmentSeconds) {
  const url = drama.source?.url ?? ''
  if (!url) throw new Error(`${drama.slug} 缺少 source.url`)
  const target = join(SRC_DIR, `${drama.slug}.${extOf(url)}`)

  log(`[${index + 1}] ${drama.title}（${drama.slug}）`)
  const preexisting = db.prepare('SELECT id FROM dramas WHERE title = ?').get(drama.title)
  if (preexisting) {
    const ready = db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND hls_path IS NOT NULL").get(preexisting.id).n
    const total = db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ?').get(preexisting.id).n
    if (ready > 0 && ready === total && !FORCE) {
      log('  已存在且片源完整，跳过（换片源请加 --force）')
      return { dramaId: preexisting.id, skipped: true }
    }
    log(FORCE ? '  --force：删除旧记录与旧切片后重切' : '  已存在但片源不完整，先删除旧记录')
    for (const row of db.prepare('SELECT id FROM episodes WHERE drama_id = ?').all(preexisting.id)) {
      rmSync(join(HLS_DIR, String(row.id)), { recursive: true, force: true })
    }
    db.prepare('DELETE FROM dramas WHERE id = ?').run(preexisting.id)
  }

  const fetched = await download(url, target, Number(drama.source?.bytes ?? 0))
  log(`  ${fetched.skipped ? '复用已有片源' : '下载完成'} ${(fetched.bytes / 1048576).toFixed(1)} MB`)
  const info = await probeFile(target)
  if (!info || !info.duration) throw new Error(`${drama.slug} 无法解析视频信息`)
  log(`  时长 ${Math.round(info.duration)}s，分辨率 ${info.width}x${info.height}${info.hasAudio ? '' : '（无音轨）'}`)

  const coverFile = `cover-${drama.slug}.jpg`
  const coverBytes = await grabImage(target, info.duration * 0.12, join(IMG_DIR, coverFile), 'scale=480:720:force_original_aspect_ratio=increase,crop=480:720')
  let bannerPath = ''
  if (drama.banner) {
    const bannerFile = `banner-${drama.slug}.jpg`
    await grabImage(target, info.duration * 0.22, join(IMG_DIR, bannerFile), 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900')
    bannerPath = `/media/images/${bannerFile}`
  }
  log(`  封面 ${(coverBytes / 1024).toFixed(0)} KB${bannerPath ? '，横幅已生成' : ''}`)

  const insertDrama = db.prepare(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, score, status, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`)
  const dramaInfo = insertDrama.run(
    drama.title, drama.subTitle ?? '', `/media/images/${coverFile}`, drama.description ?? '',
    drama.year ?? null, drama.area ?? '', drama.category ?? 'TV', drama.score ?? 8.5, index,
  )
  const dramaId = Number(dramaInfo.lastInsertRowid)

  const access = drama.access ?? {}
  db.prepare(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, ?, ?, ?, ?, 'single', 72)`).run(
    dramaId, access.mode ?? 'subscription', access.freeEpisodes ?? 0, access.trialSeconds ?? 0, access.singlePrice ?? 0,
  )

  for (const [tagIndex, name] of (drama.tags ?? []).entries()) {
    const tagId = upsertTag(name, 100 + tagIndex)
    db.prepare('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)').run(dramaId, tagId)
  }

  const count = Math.max(1, Number(drama.episodeCount ?? Math.round(info.duration / segmentSeconds)))
  const slice = info.duration / count
  log(`  切分为 ${count} 集（每集约 ${Math.round(slice)}s）`)

  for (let no = 1; no <= count; no++) {
    const start = (no - 1) * slice
    const length = no === count ? info.duration - start : slice
    const title = count === 1 ? '正片' : `第 ${no} 集`
    const episodeInfo = db.prepare("INSERT INTO episodes (drama_id, no, title, duration, source_path, status, progress) VALUES (?, ?, ?, ?, ?, 'pending', 0)")
      .run(dramaId, no, title, Math.round(length * 10) / 10, target)
    const episodeId = Number(episodeInfo.lastInsertRowid)
    log(`    第 ${no}/${count} 集 → episode #${episodeId}`)
    const result = await transcodeEpisode({ episodeId, source: target, start, length, sourceHeight: info.height })
    log(`      ${result.renditions.join(' + ')}，${(result.bytes / 1048576).toFixed(2)} MB`)
  }

  return { dramaId, bannerPath, skipped: false }
}

async function build() {
  const catalog = JSON.parse(readFileSync(DATA, 'utf8'))
  const segmentSeconds = Number(catalog.segmentSeconds ?? 90)
  const list = catalog.dramas.filter((drama) => ONLY.length === 0 || ONLY.includes(drama.slug))
  if (list.length === 0) throw new Error('清单为空，检查 --only 参数')

  const idOf = new Map()
  const banners = []
  for (const [index, drama] of list.entries()) {
    const result = await buildOne(drama, index, segmentSeconds)
    idOf.set(drama.slug, result.dramaId)
    if (result.bannerPath) banners.push({ drama, path: result.bannerPath })
  }

  const reindex = db.prepare('SELECT id, title FROM dramas ORDER BY sort, id').all()
  for (const drama of catalog.dramas) {
    const row = reindex.find((item) => item.title === drama.title)
    if (row) idOf.set(drama.slug, row.id)
  }

  let sectionCount = 0
  const hasSections = db.prepare('SELECT COUNT(*) AS n FROM sections').get().n > 0
  for (const [index, section] of (KEEP && hasSections ? [] : catalog.sections ?? []).entries()) {
    const info = db.prepare('INSERT INTO sections (title, sort, enabled) VALUES (?, ?, 1)').run(section.title, index)
    const sectionId = Number(info.lastInsertRowid)
    for (const [itemIndex, slug] of (section.slugs ?? []).entries()) {
      const dramaId = idOf.get(slug)
      if (!dramaId) continue
      db.prepare('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, ?)').run(sectionId, dramaId, itemIndex)
      sectionCount += 1
    }
  }

  let rankCount = 0
  const hasRanks = db.prepare('SELECT COUNT(*) AS n FROM rank_lists').get().n > 0
  for (const [listIndex, list] of (KEEP && hasRanks ? [] : catalog.ranks ?? []).entries()) {
    const info = db.prepare('INSERT INTO rank_lists (name, type, sort) VALUES (?, ?, ?)').run(list.name, list.type, listIndex)
    const listId = Number(info.lastInsertRowid)
    for (const [itemIndex, slug] of (list.slugs ?? []).entries()) {
      const dramaId = idOf.get(slug)
      if (!dramaId) continue
      db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, ?)').run(listId, dramaId, itemIndex + 1)
      rankCount += 1
    }
  }

  const hasBanners = db.prepare('SELECT COUNT(*) AS n FROM banners').get().n > 0
  for (const [index, item] of (KEEP && hasBanners ? [] : banners).entries()) {
    db.prepare('INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(item.drama.title, item.drama.subTitle ?? item.drama.title, item.path, idOf.get(item.drama.slug) ?? null, index)
  }

  log(`分区 ${sectionCount} 条、榜单 ${rankCount} 条、横幅 ${banners.length} 条`)
  return { dramas: list.length }
}

function check() {
  const rows = db.prepare(`SELECT d.id, d.title, COUNT(e.id) AS episodes,
      SUM(CASE WHEN e.hls_path IS NOT NULL AND e.status = 'ready' THEN 1 ELSE 0 END) AS playable
    FROM dramas d LEFT JOIN episodes e ON e.drama_id = d.id GROUP BY d.id ORDER BY d.id`).all()
  let broken = 0
  for (const row of rows) {
    const episodes = db.prepare('SELECT id, no, hls_path, status FROM episodes WHERE drama_id = ? ORDER BY no').all(row.id)
    for (const episode of episodes) {
      const playlist = episode.hls_path ? join(HLS_DIR, String(episode.id), 'index.m3u8') : null
      if (!playlist || !existsSync(playlist)) {
        broken += 1
        log(`  ✗ ${row.title} 第 ${episode.no} 集缺 playlist（${episode.status}）`)
        continue
      }
      const text = readFileSync(playlist, 'utf8')
      for (const rendition of text.matchAll(/^(\w+)\/index\.m3u8$/gm)) {
        const sub = join(HLS_DIR, String(episode.id), rendition[1], 'index.m3u8')
        if (!existsSync(sub)) { broken += 1; log(`  ✗ ${row.title} 第 ${episode.no} 集缺 ${rendition[1]} 播放列表`) }
        else if (!/\.ts/.test(readFileSync(sub, 'utf8'))) { broken += 1; log(`  ✗ ${row.title} 第 ${episode.no} 集 ${rendition[1]} 无切片`) }
      }
    }
    log(`  ${row.title}: ${row.playable}/${row.episodes} 集有片源`)
  }
  const totals = {
    dramas: db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,
    episodes: db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,
    playable: db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE hls_path IS NOT NULL AND status = 'ready'").get().n,
    tags: db.prepare('SELECT COUNT(*) AS n FROM tags').get().n,
    dramaTags: db.prepare('SELECT COUNT(*) AS n FROM drama_tags').get().n,
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    orders: db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,
    hlsMB: (dirSize(HLS_DIR) / 1048576).toFixed(1),
  }
  log(`汇总：${JSON.stringify(totals)}`)
  if (broken > 0) {
    log(`自检失败：${broken} 处缺片`)
    process.exitCode = 1
  } else {
    log('自检通过：所有剧集均可播放')
  }
}

async function main() {
  if (has('--list')) {
    const catalog = JSON.parse(readFileSync(DATA, 'utf8'))
    for (const drama of catalog.dramas) {
      log(`${drama.slug.padEnd(12)} ${drama.title} · ${drama.category} · ${drama.episodeCount} 集 · ${drama.source.license}`)
    }
    return
  }
  if (has('--check')) return check()
  if (KEEP) {
    if (ONLY.length === 0) throw new Error('--keep 需要配合 --only <slug,...> 使用')
    await build()
    check()
    return
  }
  if (has('--reset') || has('--build') || argv.length === 0) {
    if (has('--reset') && !has('--build')) return resetDemo()
    resetDemo()
    await build()
    check()
  }
}

main().catch((error) => {
  const cause = error?.cause ? `（${error.cause.code ?? error.cause.message ?? error.cause}）` : ''
  console.error('[失败]', (error?.message ?? String(error)) + cause)
  if (error?.stack && process.env.MH_DEBUG) console.error(error.stack)
  process.exitCode = 1
})
