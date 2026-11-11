/**
 * 将多集电影合并为单集正片：默认 dry-run，--apply 才写库。
 * 用法：node scripts/migrate-movie-episodes.mjs [--apply] [--movie <id>]
 */
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db, ROOT } from '../server/db.mjs'

const HLS_DIR = process.env.MH_HLS_DIR ?? join(ROOT, 'storage', 'hls')
const DB_PATH = process.env.MH_DB ?? join(ROOT, 'storage', 'app.db')
const APPLY = process.argv.includes('--apply')
const MOVIE_ARG = process.argv.indexOf('--movie')
const ONLY = MOVIE_ARG >= 0 ? Number(process.argv[MOVIE_ARG + 1]) : null

function hlsFile(pathname) {
  const match = String(pathname ?? '').match(/^\/media\/hls\/(.+)$/)
  return match ? join(HLS_DIR, ...match[1].split('/')) : null
}

function readLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

function parseMaster(file) {
  const lines = readLines(file)
  const renditions = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF')) continue
    const uri = lines[index + 1]
    if (!uri || uri.startsWith('#')) continue
    renditions.push({ attrs: lines[index], uri })
    index += 1
  }
  return renditions
}

function parseMedia(file) {
  const lines = readLines(file)
  const segments = []
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXTINF:')) continue
    const segment = lines[index + 1]
    if (!segment || segment.startsWith('#')) continue
    const duration = Number(lines[index].slice('#EXTINF:'.length).split(',')[0])
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`无效分片时长: ${file}`)
    segments.push({ duration, file: segment })
    index += 1
  }
  return segments
}

function prepareMovie(drama, episodes) {
  const first = episodes[0]
  if (Number(first.no) !== 1) throw new Error('缺少第 1 集')
  if (String(first.hls_path ?? '').includes('/merged/')) return null

  const masters = episodes.map((episode) => {
    const file = hlsFile(episode.hls_path)
    if (!file || !existsSync(file)) throw new Error(`第 ${episode.no} 集缺少 HLS: ${episode.hls_path ?? '—'}`)
    return { episode, file, renditions: parseMaster(file) }
  })
  if (!masters[0].renditions.length) throw new Error('master playlist 没有 rendition')

  const firstRenditionName = masters[0].renditions[0].uri.split('/')[0]
  const episodeDurations = masters.map((master) => {
    const match = master.renditions.find((item) => item.uri.split('/')[0] === firstRenditionName)
    if (!match) throw new Error(`第 ${master.episode.no} 集缺少 ${firstRenditionName} rendition`)
    const mediaFile = join(dirname(master.file), match.uri)
    return parseMedia(mediaFile).reduce((sum, segment) => sum + segment.duration, 0)
  })

  const renditions = masters[0].renditions.map((rendition) => {
    const name = rendition.uri.split('/')[0]
    const segments = []
    let total = 0
    for (const [masterIndex, master] of masters.entries()) {
      const match = master.renditions.find((item) => item.uri.split('/')[0] === name)
      if (!match) throw new Error(`第 ${master.episode.no} 集缺少 ${name} rendition`)
      const mediaFile = join(dirname(master.file), match.uri)
      if (!existsSync(mediaFile)) throw new Error(`缺少播放列表: ${mediaFile}`)
      const mediaSegments = parseMedia(mediaFile)
      if (!mediaSegments.length) throw new Error(`播放列表没有分片: ${mediaFile}`)
      for (const [segmentIndex, segment] of mediaSegments.entries()) {
        const source = join(dirname(mediaFile), segment.file)
        if (!existsSync(source)) throw new Error(`缺少分片: ${source}`)
        segments.push({
          source,
          duration: segment.duration,
          discontinuity: masterIndex > 0 && segmentIndex === 0,
        })
        total += segment.duration
      }
    }
    return { name, attrs: rendition.attrs, uri: rendition.uri, segments, total }
  })

  return {
    drama,
    episodes,
    firstEpisode: first,
    mergedPath: `/media/hls/${first.id}/merged/index.m3u8`,
    duration: renditions[0].total,
    episodeDurations,
    renditions,
  }
}

function applyMovie(plan) {
  const mergedDir = join(HLS_DIR, String(plan.firstEpisode.id), 'merged')
  rmSync(mergedDir, { recursive: true, force: true })
  mkdirSync(mergedDir, { recursive: true })

  for (const rendition of plan.renditions) {
    const dir = join(mergedDir, rendition.name)
    mkdirSync(dir, { recursive: true })
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...rendition.segments.map((segment) => segment.duration)))}`,
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ]
    rendition.segments.forEach((segment, index) => {
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
      const name = `seg_${String(index).padStart(3, '0')}.ts`
      const target = join(dir, name)
      try {
        linkSync(segment.source, target)
      } catch {
        copyFileSync(segment.source, target)
      }
      lines.push(`#EXTINF:${segment.duration.toFixed(3)},`, name)
    })
    lines.push('#EXT-X-ENDLIST')
    writeFileSync(join(dir, 'index.m3u8'), `${lines.join('\n')}\n`, 'utf8')
  }

  const masterLines = ['#EXTM3U', '#EXT-X-VERSION:3']
  for (const rendition of plan.renditions) masterLines.push(rendition.attrs, rendition.uri)
  writeFileSync(join(mergedDir, 'index.m3u8'), `${masterLines.join('\n')}\n`, 'utf8')

  const offsets = new Map()
  let offset = 0
  for (const [index, episode] of plan.episodes.entries()) {
    offsets.set(Number(episode.no), offset)
    offset += plan.episodeDurations[index] ?? Number(episode.duration ?? 0)
  }

  db.exec('BEGIN')
  try {
    db.prepare("UPDATE episodes SET hls_path = ?, duration = ?, title = '正片', status = 'ready', progress = 100, error = NULL WHERE id = ?")
      .run(plan.mergedPath, Math.round(plan.duration * 10) / 10, plan.firstEpisode.id)
    db.prepare("UPDATE episodes SET status = 'merged', hls_path = NULL WHERE drama_id = ? AND no > ?")
      .run(plan.drama.id, plan.firstEpisode.no)
    db.prepare('UPDATE content_policies SET free_episodes = 0 WHERE drama_id = ? AND free_episodes > 0').run(plan.drama.id)

    for (const row of db.prepare('SELECT id, episode_no, position FROM history WHERE drama_id = ? AND episode_no > ?')
      .all(plan.drama.id, plan.firstEpisode.no)) {
      const position = Number(row.position ?? 0) + (offsets.get(Number(row.episode_no)) ?? 0)
      db.prepare('UPDATE history SET episode_no = ?, position = ? WHERE id = ?')
        .run(plan.firstEpisode.no, Math.min(plan.duration, Math.max(0, position)), row.id)
    }

    const episodeIds = plan.episodes.slice(1).map((episode) => episode.id)
    if (episodeIds.length) {
      const placeholders = episodeIds.map(() => '?').join(',')
      for (const row of db.prepare(`SELECT id, episode_id, time_ms FROM danmus WHERE episode_id IN (${placeholders})`).all(...episodeIds)) {
        const episode = plan.episodes.find((item) => item.id === Number(row.episode_id))
        const time = Number(row.time_ms ?? 0) + Math.round((offsets.get(Number(episode.no)) ?? 0) * 1000)
        db.prepare('UPDATE danmus SET episode_id = ?, time_ms = ? WHERE id = ?')
          .run(plan.firstEpisode.id, Math.min(Math.round(plan.duration * 1000), time), row.id)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    rmSync(mergedDir, { recursive: true, force: true })
    throw error
  }
}

function backupDatabase() {
  const dir = join(dirname(DB_PATH), 'backup')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `movie-merge-${stamp}.db`)
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
  return target
}

export function mergeMovieEpisodes({ apply = false, only = null } = {}) {
  const movies = db.prepare("SELECT * FROM dramas WHERE category = 'MOVIE' ORDER BY id").all()
    .filter((drama) => only === null || Number(drama.id) === only)
  const ready = []
  const errors = []

  for (const drama of movies) {
    const episodes = db.prepare('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no').all(drama.id)
    if (episodes.length <= 1) continue
    try {
      const plan = prepareMovie(drama, episodes)
      if (plan) ready.push(plan)
    } catch (error) {
      errors.push({ drama, error: error.message })
    }
  }

  let backup = null
  if (apply && ready.length) backup = backupDatabase()
  if (apply) for (const plan of ready) applyMovie(plan)
  return { ready, errors, backup, applied: apply }
}

function main() {
  const result = mergeMovieEpisodes({ apply: APPLY, only: ONLY })
  if (!result.ready.length && !result.errors.length) {
    console.log('没有需要迁移的多集电影')
    return
  }
  for (const plan of result.ready) {
    console.log(`${result.applied ? '已迁移' : '将迁移'} #${plan.drama.id} ${plan.drama.title}: ${plan.episodes.length} 集 -> 1 个正片，${Math.round(plan.duration)}s`)
  }
  for (const item of result.errors) {
    console.error(`跳过 #${item.drama.id} ${item.drama.title}: ${item.error}`)
  }
  if (result.backup) console.log(`数据库备份: ${result.backup}`)
  if (!result.applied) console.log('dry-run：未写库。确认后加 --apply。')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
