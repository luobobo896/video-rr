/**
 * HLS master playlist 重写（从 add-episode-track.mjs 抽出来，便于单测）。
 *
 * 两个修正：
 *  1. 不再硬编码 `#EXT-X-VERSION:3` —— 原文件写的是几就保留几（新版 hls.js 与
 *     Safari 对 VERSION 的处理不同，擅自降版会把 fMP4 流的 EXT-X-MAP 判成非法）。
 *  2. 同一份 master 里只允许一条 `DEFAULT=YES`：多轨都被标成默认时，播放器行为
 *     取决于实现（Safari 选最后一条、hls.js 选第一条），用户听到的音轨会随机变。
 */

/** 取原文件里的 `#EXT-X-VERSION:n`，没有就返回 null。 */
export function masterVersionOf(source) {
  const match = String(source ?? '').match(/^#EXT-X-VERSION:(\d+)\s*$/m)
  return match ? Number(match[1]) : null
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

/**
 * 只保留一条默认轨：按传入顺序（音轨在前、字幕在后）取第一个标记为默认的轨。
 * @param {Array<{ is_default?: number | boolean }>} tracks
 */
export function pickDefaults(tracks) {
  const chosen = new Set()
  for (const track of tracks) {
    if (track?.is_default) {
      chosen.add(track)
      break
    }
  }
  return chosen
}

/**
 * 重写 master playlist，保留原有清晰度流并注入 EXT-X-MEDIA。
 * @param {string} source 原 master 文本
 * @param {Array<{ kind: string, language: string, label: string, is_default?: number | boolean, uri: string }>} tracks
 */
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
  const defaults = pickDefaults([...audio, ...subtitles])
  const media = []
  for (const track of audio) {
    media.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE=${quote(track.language)},NAME=${quote(track.label)},DEFAULT=${defaults.has(track) ? 'YES' : 'NO'},AUTOSELECT=YES,URI=${quote(track.uri)}`)
  }
  for (const track of subtitles) {
    media.push(`#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE=${quote(track.language)},NAME=${quote(track.label)},DEFAULT=${defaults.has(track) ? 'YES' : 'NO'},AUTOSELECT=YES,FORCED=NO,URI=${quote(track.uri)}`)
  }

  const version = masterVersionOf(source) ?? 3
  const out = ['#EXTM3U', `#EXT-X-VERSION:${version}`, ...media]
  for (const [attrs, uri] of streams) out.push(streamAttrs(attrs, audio.length > 0, subtitles.length > 0), uri)
  return `${out.join('\n')}\n`
}
