/**
 * 试看清单截断（纯函数，不碰网络/磁盘）。
 *
 * 付费集的试看如果只签一个「整集目录」的播放权、再由前端按 trialSeconds 截断播放，
 * 服务端其实没有限制任何东西：直接 curl 分片就能把整集拖走。所以试看请求拿到的是
 * 「只含前 N 秒分片」的清单，分片请求再核对一次白名单（见 server/index.mjs 的
 * /media/trial/<episodeId>/ 路由）。
 *
 * 约定：
 *   - 按 #EXTINF 累加到 seconds 截止，超出预算的分片连同它的 EXTINF 一起丢弃
 *     （清单里留下没有 URI 的 EXTINF 会被 hls.js 判成非法清单）；
 *   - #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 等标签随所在分片一起保留：试看片段一样需要
 *     解密与 init 段，少一行就整段解不出来；
 *   - #EXT-X-ENDLIST 保留（VOD 清单少了它，播放器会当成直播，试看结束反而卡住）；
 *   - 返回的 allowed 是「清单里仍然可取的 URI 原文」，供分片白名单校验用。
 */

const EXTINF_RE = /^#EXTINF:\s*([0-9.]+)/i
/**
 * 媒体分片之前就该出现的清单头标签：即使一分钟都不给也要留着，否则播放器读不懂清单。
 * #EXTM3U 必须排在第一行（HLS 规范），漏进 pending 会让它跟着第一个分片一起挪到文件中间。
 */
const HEADER_TAG_RE = /^#EXTM3U$|^#EXT-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|DISCONTINUITY-SEQUENCE|PLAYLIST-TYPE|INDEPENDENT-SEGMENTS|START|I-FRAMES-ONLY)/i

/** 清单内 URI 的比较口径：去空白、去 ./ 前缀（编码差异由调用方协商）。 */
export function normalizePlaylistUri(uri) {
  return String(uri ?? '').trim().replace(/^\.\//, '')
}

/** 主清单（没有 #EXTINF）不按秒截断：它只列子清单，秒数由真正的媒体清单决定 */
function keepWholePlaylist(source) {
  const out = []
  const allowed = new Set()
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    out.push(line)
    if (!line.startsWith('#')) allowed.add(normalizePlaylistUri(line))
  }
  return { text: out.length ? `${ensureHeader(out).join('\n')}\n` : '', allowed }
}

/**
 * 给清单里每个 URI 追加上签名参数。
 * 播放器解析相对分片地址时会丢掉页面的 query，只靠 Cookie 传票在暖机/换码率时容易漏，
 * 所以直接把 `sign/expires/sec` 贴到每条 URI（含 EXT-X-KEY / EXT-X-MAP 的 URI 属性）上。
 */
export function stampPlaylist(text, query) {
  const q = String(query ?? '').replace(/^[?&]+/, '')
  const source = String(text ?? '')
  if (!q) return source
  const add = (uri) => (uri.includes('?') ? `${uri}&${q}` : `${uri}?${q}`)
  const out = []
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    out.push(line.startsWith('#') ? line.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${add(uri)}"`) : add(line))
  }
  return out.length ? `${out.join('\n')}\n` : ''
}

/**
 * @param {string} text 清单原文
 * @param {{ seconds?: number }} options seconds = 试看秒数（0 表示一分钟都不给）
 * @returns {{ text: string, allowed: Set<string> }}
 */
export function truncatePlaylist(text, { seconds = 0 } = {}) {
  const source = String(text ?? '')
  if (!/^#EXTINF:/im.test(source)) return keepWholePlaylist(source)
  const budget = Math.max(0, Number(seconds) || 0)
  const lines = source.split(/\r?\n/)
  const out = []
  const pending = []
  const allowed = new Set()
  let used = 0
  let duration = 0
  let reachedSegments = false
  let hasEndlist = false

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (/^#EXT-X-ENDLIST/i.test(line)) {
        hasEndlist = true
        continue
      }
      if (!reachedSegments && HEADER_TAG_RE.test(line)) {
        out.push(line)
        continue
      }
      pending.push(line)
      const extinf = EXTINF_RE.exec(line)
      if (extinf) {
        duration = Number(extinf[1]) || 0
        reachedSegments = true
      }
      continue
    }
    // 预算用完：这条分片与它的标签一起丢掉
    if (used >= budget) {
      pending.length = 0
      duration = 0
      continue
    }
    for (const tag of pending) out.push(tag)
    pending.length = 0
    out.push(line)
    allowed.add(normalizePlaylistUri(line))
    used += duration
    duration = 0
  }

  if (hasEndlist) out.push('#EXT-X-ENDLIST')
  return { text: out.length ? `${ensureHeader(out).join('\n')}\n` : '', allowed }
}

/** #EXTM3U 必须是第一行：源清单里位置不对时也修正过来。 */
function ensureHeader(lines) {
  const index = lines.findIndex((line) => /^#EXTM3U$/i.test(line))
  if (index === 0) return lines
  if (index > 0) {
    const copy = lines.slice()
    copy.splice(index, 1)
    return ['#EXTM3U', ...copy]
  }
  return ['#EXTM3U', ...lines]
}
