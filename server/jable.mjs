/**
 * jable 影片页解析（纯函数，不碰网络）。
 *
 * 站方把播放地址直接写在页面内联脚本里：
 *   var hlsUrl = 'https://<cdn>/hls/<token>/<exp>/<a>/<b>/<b>.m3u8';
 *   var vttUrl = '.../thumbvtt.ts';
 * 所以拿到页面就能取到真正的视频流地址，不需要去猜接口。
 *
 * 注意 hlsUrl 里的 <exp> 参与签名，改一个字符就 403：链接只在下发后的窗口期内有效，
 * 过期只能重新解析页面。调用方要把解析结果当成"有保鲜期的凭证"存。
 */

const clean = (value) => String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()

const firstMatch = (text, re) => {
  const hit = re.exec(text)
  return hit ? hit[1] : ''
}

/** 从 assets-cdn 的截图路径里拆出 contentsId 与 videoId：.../contents/videos_screenshots/63000/63332/preview.jpg */
function screenshotIds(url) {
  const hit = /videos_screenshots\/(\d+)\/(\d+)\//.exec(String(url ?? ''))
  return hit ? { contentsId: hit[1], videoId: hit[2] } : { contentsId: '', videoId: '' }
}

/** 封面 / 预览雪碧图的三个固定地址（同一 videoId 目录下）。 */
export function artworkUrls(videoId) {
  const id = String(videoId ?? '').trim()
  if (!/^\d+$/.test(id)) return {}
  // 站方按 1000 一档分目录：63332 → 63000
  const bucket = `${id.slice(0, Math.max(0, id.length - 3))}000`
  const base = `https://assets-cdn.jable.tv/contents/videos_screenshots/${bucket}/${id}`
  return { base, cover: `${base}/preview.jpg` }
}

/** 解析影片页，返回元数据 + 直链。字段缺失时留空字符串，不抛错。 */
export function parseVideoPage(html, pageUrl = '') {
  const text = String(html ?? '')
  const hlsUrl = firstMatch(text, /hlsUrl\s*=\s*'([^']+)'/)
  const vttUrl = firstMatch(text, /vttUrl\s*=\s*'([^']+)'/)
  const hasVtt = firstMatch(text, /hasVtt\s*=\s*(\d+)/) === '1'
  const poster = firstMatch(text, /<video[^>]+poster="([^"]+)"/)
  const pageVideoId = firstMatch(text, /videoId:\s*'(\d+)'/)
  const ids = screenshotIds(poster)
  const videoId = ids.videoId || pageVideoId

  const infoBlock = firstMatch(text, /(<section class="video-info[\s\S]*?<\/section>)/)
  const source = infoBlock || text
  const title = clean(firstMatch(source, /<h4>([\s\S]*?)<\/h4>/))
  const releaseDate = firstMatch(source, /上市於\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/)
  const views = Number(firstMatch(source, /#icon-eye[\s\S]{0,200}?<span class="mr-3">([\d ]+)<\/span>/).replace(/\s/g, '')) || 0
  const postedAgo = clean(firstMatch(source, /#icon-clock[\s\S]{0,200}?<span class="mr-3">([^<]+)<\/span>/))

  const models = [...source.matchAll(/<a class="model"[^>]*>[\s\S]*?title="([^"]+)"/g)].map((m) => clean(m[1])).filter(Boolean)
  const categories = [...source.matchAll(/<a href="https?:\/\/[^"]*\/categories\/[^"]*"\s+class="cat"[^>]*>([^<]+)<\/a>/g)].map((m) => clean(m[1])).filter(Boolean)
  const tags = [...source.matchAll(/<a href="https?:\/\/[^"]*\/tags\/[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) => clean(m[1])).filter(Boolean)

  const code = firstMatch(title, /^([A-Za-z0-9]+-\d+)/).toUpperCase()
  const titleBody = code ? clean(title.slice(title.indexOf(code) + code.length)) : title
  const slug = code ? slugOf(code) : (videoId ? `jable-${videoId}` : '')
  const art = artworkUrls(videoId)

  return {
    pageUrl: String(pageUrl ?? ''),
    contentsId: ids.contentsId,
    videoId,
    code,
    slug,
    title,
    // 站内 title 不重复番号：番号 + 女優放 sub_title
    titleBody: titleBody || title,
    subtitle: [code, ...models].filter(Boolean).join(' · '),
    models,
    categories,
    tags: [...new Set(tags)],
    releaseDate,
    views,
    postedAgo,
    poster,
    coverUrl: art.cover || poster,
    hlsUrl,
    vttUrl,
    hasVtt,
    duration: 0,
  }
}

/** MIKR-134 → jable-mikr-134（素材文件名与站内 slug 统一用它）。 */
export function slugOf(code) {
  const text = String(code ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return text ? `jable-${text}` : ''
}

/** 只要页面里的影片链接（列表页/首页用），去重后保持出现顺序。 */
export function parseVideoLinks(html) {
  const links = [...String(html ?? '').matchAll(/href="(https?:\/\/jable\.tv\/videos\/[a-z0-9_-]+\/?)(?:\?[^"]*)?"/gi)]
    .map((m) => m[1])
  return [...new Set(links)]
}

/** 累加 m3u8 里的 EXTINF，得到整片时长（秒）。上游不给时长字段时用它兜底。 */
export function durationOfPlaylist(text) {
  let total = 0
  for (const hit of String(text ?? '').matchAll(/#EXTINF:\s*([0-9.]+)/g)) total += Number(hit[1]) || 0
  return Math.round(total * 1000) / 1000
}

/** hlsUrl 的签名过期时刻：/hls/<token>/<exp>/... 里的 exp 是 unix 秒。 */
export function expiryOf(hlsUrl) {
  // 与 stream-proxy 的缓存键同一口径：10 位秒级时间戳为主，留足 9–13 位防未来变形
  const hit = /\/hls\/[^/]+\/(\d{9,13})\//.exec(String(hlsUrl ?? ''))
  return hit ? Number(hit[1]) : 0
}

/** 解析 Plyr 预览雪碧图的 VTT：返回每帧的雪碧图坐标。 */
/**
 * 站内播放量映射到 6.0–9.0 的评分。
 * jable 没有用户打分，只能用热度当质量信号；纯函数，便于测试。
 */
export function scoreOfViews(views) {
  const count = Number(String(views ?? '').replace(/[^\d]/g, '')) || 0
  if (count <= 0) return null
  const raw = 6 + Math.min(3, Math.max(0, (Math.log10(count + 1) - 3) * 1.15))
  return Number(raw.toFixed(1))
}

export function parseThumbVtt(text) {
  const body = String(text ?? '')
  const frames = []
  for (const hit of body.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})[\s\S]{0,120}?#xywh=(\d+),(\d+),(\d+),(\d+)/g)) {
    const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
    frames.push({
      start: toSec(hit[1], hit[2], hit[3], hit[4]),
      end: toSec(hit[5], hit[6], hit[7], hit[8]),
      x: Number(hit[9]), y: Number(hit[10]), width: Number(hit[11]), height: Number(hit[12]),
    })
  }
  return frames
}
