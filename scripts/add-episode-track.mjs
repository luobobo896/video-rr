#!/usr/bin/env node
/**
 * 给已转码分集增加音轨或字幕：
 * node scripts/add-episode-track.mjs --episode 1 --kind audio --file voice.m4a \
 *   --language yue --edition original --label 粤语原声 [--source 蓝光] [--default]
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db, ROOT } from '../server/db.mjs'
import { createTrack, listEpisodeTracks, updateTrack } from '../server/tracks.mjs'

const FFMPEG = process.env.MH_FFMPEG ?? 'ffmpeg'
const HLS_DIR = process.env.MH_HLS_DIR ?? join(ROOT, 'storage', 'hls')
const argv = process.argv.slice(2)
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback = '') => {
  const index = argv.indexOf(flag)
  return index >= 0 ? String(argv[index + 1] ?? fallback) : fallback
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(-500)}`))
    })
  })
}

function hlsFile(pathname) {
  const match = String(pathname ?? '').match(/^\/media\/hls\/(.+)$/)
  return match ? join(HLS_DIR, ...match[1].split('/')) : null
}

function quote(value) {
  return `"${String(value ?? '').replace(/["\r\n]/g, ' ')}"`
}

function streamAttrs(line, hasAudio, hasSubtitle) {
  let next = line
  if (hasAudio) next = /AUDIO="[^"]*"/.test(next) ? next.replace(/AUDIO="[^"]*"/, 'AUDIO="audio"') : `${next},AUDIO="audio"`
  else next = next.replace(/,?AUDIO="[^"]*"/, '')
  if (hasSubtitle) next = /SUBTITLES="[^"]*"/.test(next) ? next.replace(/SUBTITLES="[^"]*"/, 'SUBTITLES="subs"') : `${next},SUBTITLES="subs"`
  else next = next.replace(/,?SUBTITLES="[^"]*"/, '')
  return next
}

export function rewriteMaster(source, tracks) {
  const lines = String(source).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const streams = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
    const uri = lines[index + 1]
    if (!uri || uri.startsWith('#')) continue
    streams.push([lines[index], uri])
    index += 1
  }
  if (!streams.length) throw new Error('master playlist 没有清晰度流')

  const audio = tracks.filter((track) => track.kind === 'audio')
  const subtitles = tracks.filter((track) => track.kind === 'subtitle')
  const media = []
  for (const track of audio) {
    media.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE=${quote(track.language)},NAME=${quote(track.label)},DEFAULT=${track.is_default ? 'YES' : 'NO'},AUTOSELECT=YES,URI=${quote(track.uri)}`)
  }
  for (const track of subtitles) {
    media.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE=${quote(track.language)},NAME=${quote(track.label)},DEFAULT=${track.is_default ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=NO,URI=${quote(track.uri)}`)
  }

  const out = ['#EXTM3U', '#EXT-X-VERSION:3', ...media]
  for (const [attrs, uri] of streams) out.push(streamAttrs(attrs, audio.length > 0, subtitles.length > 0), uri)
  return `${out.join('\n')}\n`
}

function relativeUri(uri, episodeId) {
  const prefix = `/media/hls/${episodeId}/`
  return String(uri).startsWith(prefix) ? String(uri).slice(prefix.length) : String(uri)
}

function masterTracks(episodeId, extra) {
  const existing = listEpisodeTracks(episodeId)
  const key = (track) => `${track.kind}:${String(track.language).toLowerCase()}:${track.edition}`
  const map = new Map(existing.map((track) => [key(track), track]))
  map.set(key(extra), extra)
  return [...map.values()].map((track) => ({ ...track, uri: relativeUri(track.uri, episodeId) }))
}

async function transcodeAudio(file, episodeId, edition) {
  const dir = join(HLS_DIR, String(episodeId), 'audio', edition)
  const temp = `${dir}.tmp-${Date.now()}`
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  try {
    await run(FFMPEG, [
      '-y', '-i', file, '-vn', '-map', '0:a:0',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(temp, 'seg_%03d.ts'),
      join(temp, 'index.m3u8'),
    ])
    if (!existsSync(join(temp, 'index.m3u8'))) throw new Error('音频 HLS 生成失败')
    rmSync(dir, { recursive: true, force: true })
    renameSync(temp, dir)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    throw error
  }
  return `/media/hls/${episodeId}/audio/${edition}/index.m3u8`
}

async function writeSubtitle(file, episodeId, language, edition, duration) {
  const name = `${String(language).replace(/[^A-Za-z0-9_-]/g, '-')}-${edition}`
  const dir = join(HLS_DIR, String(episodeId), 'subs', name)
  const temp = `${dir}.tmp-${Date.now()}`
  rmSync(temp, { recursive: true, force: true })
  mkdirSync(temp, { recursive: true })
  const target = join(temp, 'sub.vtt')
  try {
    if (extname(file).toLowerCase() === '.vtt') copyFileSync(file, target)
    else await run(FFMPEG, ['-y', '-i', file, '-c:s', 'webvtt', target])
    if (!existsSync(target)) throw new Error('字幕 WebVTT 生成失败')
    const seconds = Math.max(1, Math.ceil(Number(duration ?? 0)))
    writeFileSync(join(temp, 'index.m3u8'), [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${seconds}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      `#EXTINF:${seconds},`,
      'sub.vtt',
      '#EXT-X-ENDLIST',
      '',
    ].join('\n'), 'utf8')
    rmSync(dir, { recursive: true, force: true })
    renameSync(temp, dir)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    throw error
  }
  return `/media/hls/${episodeId}/subs/${name}/index.m3u8`
}

export async function addEpisodeTrack({
  episodeId,
  kind,
  file,
  language,
  edition = 'original',
  label,
  source = '',
  isDefault = false,
} = {}) {
  const id = Number(episodeId)
  const episode = db.prepare('SELECT id, hls_path, duration FROM episodes WHERE id = ?').get(id)
  if (!episode) throw new Error('分集不存在')
  if (!['audio', 'subtitle'].includes(kind)) throw new Error('kind 必须是 audio 或 subtitle')
  if (!file || !existsSync(file)) throw new Error(`文件不存在: ${file}`)
  if (!/^(und|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(String(language ?? ''))) throw new Error('language 需使用 BCP-47 格式')
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(String(edition ?? ''))) throw new Error('edition 只能使用小写字母、数字、点、下划线或短横线')

  const masterFile = episode.hls_path ? hlsFile(episode.hls_path) : join(HLS_DIR, String(id), 'index.m3u8')
  if (!masterFile || !existsSync(masterFile)) throw new Error('该集还没有 master playlist，请先完成视频转码')

  const current = listEpisodeTracks(id).filter((track) => track.kind === kind)
  const existing = current.find((track) => String(track.language).toLowerCase() === String(language).toLowerCase() && track.edition === edition)
  const nextDefault = Boolean(isDefault) || Boolean(existing && Number(existing.is_default) === 1) || current.length === 0
  const uri = kind === 'audio'
    ? await transcodeAudio(file, id, edition)
    : await writeSubtitle(file, id, language, edition, episode.duration)

  const saved = existing
    ? updateTrack(existing.id, { label, source, uri, isDefault: nextDefault })
    : createTrack({ episodeId: id, kind, language, edition, label, source, uri, isDefault: nextDefault })

  const master = rewriteMaster(readFileSync(masterFile, 'utf8'), masterTracks(id, saved))
  writeFileSync(masterFile, master, 'utf8')
  db.prepare('UPDATE episodes SET hls_path = ? WHERE id = ?').run(`/media/hls/${id}/index.m3u8`, id)
  return saved
}

async function main() {
  const track = await addEpisodeTrack({
    episodeId: valueOf('--episode'),
    kind: valueOf('--kind'),
    file: valueOf('--file'),
    language: valueOf('--language'),
    edition: valueOf('--edition', 'original'),
    label: valueOf('--label') || `${valueOf('--language')} ${valueOf('--edition', 'original')}`,
    source: valueOf('--source'),
    isDefault: has('--default'),
  })
  console.log(`已写入轨道 #${track.id} ${track.kind} ${track.language}/${track.edition} → ${track.uri}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
