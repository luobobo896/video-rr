/**
 * 从 jable 影片页把「真视频源 + 封面/预览贴图」导入本站成人库。
 *
 * 为什么要开浏览器：站方整站在 Cloudflare managed challenge 后面，纯 HTTP 客户端
 * 只会拿到 "Just a moment..."。用本机 Edge 过掉挑战后，页面内联脚本里直接就有
 *   var hlsUrl  = 'https://<cdn>/hls/<token>/<exp>/<a>/<b>/<b>.m3u8'
 *   var vttUrl  = '.../thumbvtt.ts'
 * 拿到的就是可以直连播放的 m3u8（AES-128，key 与分片同目录）。
 *
 * 用法：
 *   node scripts/jable-import.mjs https://jable.tv/videos/mikr-134/
 *   node scripts/jable-import.mjs --page https://jable.tv/latest-updates/ --limit 12
 *   node scripts/jable-import.mjs --refresh          # 重新解析库中已有 jable 源（链接会过期）
 *   node scripts/jable-import.mjs --refresh --every 60   # 守护：每 60 分钟只刷快过期的
 *   node scripts/jable-import.mjs <url> --dry        # 只解析打印，不写库不落图
 *
 * 签名不可本地复现：hlsUrl 由服务端渲染，token 是带私钥的 16 字节摘要，改 exp 即 403。
 * 详见 docs/JABLE-IMPORT.md「为什么不能同步他的算法」。
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { db } from '../server/db.mjs'
import { parseVideoPage, parseVideoLinks, durationOfPlaylist, expiryOf, artworkUrls, scoreOfViews, slugOf } from '../server/jable.mjs'

const exec = promisify(execFile)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const IMG_DIR = join(ROOT, 'storage', 'images')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://jable.tv/'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

// 影片 URL 的 slug 就是番号（mikr-134 → MIKR-134），列表页就能判断是否已入库，
// 已存在的直接跳过，不用再开详情页解析，几百页批量时省掉绝大部分时间
const codeOfUrl = (url) => {
  const slug = /\/videos\/([a-z0-9_]+-\d+)\/?/i.exec(String(url ?? ''))?.[1] ?? ''
  return slug ? slug.toUpperCase().replace(/_/g, '-') : ''
}

const libraryHas = (code) =>
  Boolean(code) && Boolean(one('SELECT id FROM dramas WHERE is_adult = 1 AND sub_title LIKE ?', `${code} ·%`))

// ---------- 参数 ----------
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const consumed = new Set()
const valueOf = (name, fallback = '') => {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  if (hit) return hit.slice(name.length + 1)
  const at = argv.indexOf(name)
  const next = at >= 0 ? argv[at + 1] : ''
  if (next && !next.startsWith('--')) {
    consumed.add(at + 1)
    return next
  }
  return fallback
}
const listPageEarly = valueOf('--page')
const urls = argv.filter((a, i) => /^https?:\/\//.test(a) && !consumed.has(i))
const listPage = listPageEarly
const limit = Number(valueOf('--limit', '0')) || 0
const pageCount = Number(valueOf('--pages', '0')) || 0
const startPage = Number(valueOf('--start-page', '1')) || 1
const skipExisting = flags.has('--skip-existing')
const dry = flags.has('--dry')
const skipImages = flags.has('--no-images')
// 雪碧图单张 1.5MB，跑几千部会吃掉几个 GB 和大部分时间；只跳它，封面与 banner 照旧
const skipPreview = flags.has('--no-preview')
const refresh = flags.has('--refresh')
const scoreOnly = flags.has('--score-only')

// ---------- 浏览器 ----------
const CANDIDATES = [
  process.env.MH_EDGE,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)

function findBrowser() {
  const hit = CANDIDATES.find((p) => existsSync(p))
  if (!hit) throw new Error('没找到 Edge/Chrome，可用 MH_EDGE 指定可执行文件路径')
  return hit
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一个带 CDP 的浏览器，返回 { navigate(url) → html, close() }。串行复用同一个标签页。 */
async function openBrowser() {
  const bin = findBrowser()
  const port = 9400 + Math.floor(Math.random() * 200)
  const profile = mkdtempSync(join(tmpdir(), 'mh-jable-'))
  const child = spawn(bin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-dev-shm-usage',
    ...(process.env.MH_HEADLESS ? ['--headless=new'] : []),
    '--window-size=1280,900',
    'about:blank',
  ], { detached: true, stdio: 'ignore' })
  child.unref()

  let wsUrl = ''
  for (let i = 0; i < 60 && !wsUrl; i++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      wsUrl = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl ?? ''
    } catch {}
  }
  if (!wsUrl) throw new Error('浏览器没有暴露 CDP 端口')

  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id) }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++seq
    pending.set(id, { resolve })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await new Promise((resolve) => ws.addEventListener('open', resolve))
  await send('Page.enable')
  // 只拉 HTML/JS/CSS：图片、字体、视频分片对解析毫无用处，却会把 Cloudflare 的请求计数顶上去
  await send('Network.enable')
  await send('Network.setBlockedURLs', {
    urls: ['*.jpg', '*.jpeg', '*.png', '*.webp', '*.gif', '*.svg', '*.ico', '*.woff', '*.woff2', '*.ttf', '*.mp4', '*.ts', '*.m3u8'],
  })

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true })
    return res.result?.result?.value
  }

  return {
    async navigate(url, { wantHls = true } = {}) {
      await send('Page.navigate', { url })
      let html = ''
      let best = 0
      for (let i = 0; i < 60; i++) {
        await sleep(i < 8 ? 320 : 900)
        html = (await evaluate('document.documentElement.outerHTML')) ?? ''
        if (wantHls && /hlsUrl\s*=\s*'/.test(html)) return html
        // 列表页要等真的出现影片链接：Cloudflare 挑战页也有 4 万字符，只看长度会在挑战页上提前返回
        if (!wantHls && html.length === best && /\/videos\/[a-z0-9_]+-\d+\/?/.test(html)) return html
        best = html.length
      }
      return html
    },
    close() {
      try { ws.close() } catch {}
      try { child.kill() } catch {}
    },
  }
}

// ---------- 素材 ----------
async function downloadTo(url, dest) {
  const response = await fetch(url, { headers: { referer: REFERER, 'user-agent': UA }, signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(dest, buffer)
  return buffer.length
}

/** 竖版封面裁一张 16:9 横幅，海报墙和详情页横幅都能用。 */
async function makeBanner(coverPath, bannerPath) {
  try {
    await exec(process.env.MH_FFMPEG ?? 'ffmpeg', [
      '-y', '-loglevel', 'error', '-i', coverPath,
      '-vf', 'scale=1600:900:force_original_aspect_ratio=increase,crop=1600:900',
      bannerPath,
    ], { timeout: 60000 })
    return true
  } catch {
    return false
  }
}

async function grabArtwork(meta) {
  mkdirSync(IMG_DIR, { recursive: true })
  const saved = {}
  const cover = join(IMG_DIR, `cover-${meta.slug}.jpg`)
  const banner = join(IMG_DIR, `banner-${meta.slug}.jpg`)
  const preview = join(IMG_DIR, `preview-${meta.slug}.jpg`)

  // 跨境下载最费时间：封面和雪碧图同时下，banner 等封面落地后与雪碧图并行转
  const coverTask = existsSync(cover)
    ? Promise.resolve()
    : downloadTo(meta.poster || artworkUrls(meta.videoId).cover, cover)
      .then((bytes) => { saved.coverBytes = bytes })
      .catch((error) => { saved.coverError = error.message })
  // 预览雪碧图（Plyr 的鼠标悬停逐帧图），和分片同目录，叫 thumb.ts
  const thumbUrl = meta.vttUrl ? meta.vttUrl.replace(/thumbvtt\.ts$/, 'thumb.ts') : ''
  const previewTask = (skipPreview && !existsSync(preview)) || existsSync(preview) || !thumbUrl
    ? Promise.resolve()
    : downloadTo(thumbUrl, preview)
      .then((bytes) => { saved.previewBytes = bytes })
      .catch((error) => { saved.previewError = error.message })

  await coverTask
  await Promise.all([previewTask, existsSync(banner) ? Promise.resolve() : makeBanner(cover, banner)])

  saved.cover = existsSync(cover) ? `/media/images/cover-${meta.slug}.jpg` : ''
  saved.banner = existsSync(banner) ? `/media/images/banner-${meta.slug}.jpg` : ''
  saved.preview = existsSync(preview) ? `/media/images/preview-${meta.slug}.jpg` : ''
  return saved
}

// ---------- 标签 ----------
const SIMPLIFY = { 絲: '丝', 襪: '袜', 癡: '痴', 腳: '脚', 麗: '丽', 愛: '爱', 媽: '妈', 護: '护', 褲: '裤', 網: '网', 機: '机', 場: '场', 點: '点', 實: '实', 寫: '写', 視: '视', 劇: '剧', 說: '说', 戀: '恋', 體: '体', 顏: '颜', 髮: '发', 門: '门', 開: '开', 關: '关', 學: '学', 員: '员', 業: '业', 裝: '装', 飾: '饰', 環: '环', 節: '节', 餘: '余', 嬰: '婴', 妝: '妆', 豔: '艳', 誘: '诱', 惑: '惑' }
const fold = (value) => String(value ?? '').replace(/[絲襪癡腳麗愛媽護褲網機場點實寫視劇說戀體顏髮門開關學員業裝飾環節餘嬰妝豔誘]/g, (c) => SIMPLIFY[c] ?? c).replace(/\s/g, '').toLowerCase()

function matchTag(name) {
  const exact = one("SELECT id FROM tags WHERE name = ? AND scope = 'adult'", name)
  if (exact) return exact.id
  const key = fold(name)
  if (!key) return 0
  const rows = all("SELECT id, name FROM tags WHERE scope = 'adult'")
  const byFold = rows.find((row) => fold(row.name) === key)
  if (byFold) return byFold.id
  const byPart = rows.find((row) => fold(row.name).includes(key) || key.includes(fold(row.name)))
  return byPart ? byPart.id : 0
}

function linkTags(dramaId, names) {
  let linked = 0
  for (const name of names) {
    const tagId = matchTag(name)
    if (!tagId) continue
    run('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)', dramaId, tagId)
    linked++
  }
  return linked
}

// ---------- 入库 ----------
function upsertDrama(meta, artwork) {
  // 兜底：解析失败时宁可抛错，也不要往库里写空标题条目
  if (!meta.titleBody && !meta.subtitle) throw new Error('标题与副标题都为空，拒绝入库')
  // 番号在 sub_title（`CODE · 女優`）里，title 是去掉番号的正文，查重不能用 title
  const existing = meta.code
    ? one(`SELECT * FROM dramas WHERE is_adult = 1 AND (sub_title LIKE ? OR title LIKE ?) ORDER BY id LIMIT 1`,
      `${meta.code}%`, `${meta.code}%`)
    : null
  const description = [
    meta.models.length ? `女優：${meta.models.join('、')}` : '',
    meta.categories.length ? `類別：${meta.categories.join('、')}` : '',
    meta.tags.length ? `標籤：${meta.tags.slice(0, 12).join('、')}` : '',
    `番號：${meta.code || '—'}`,
  ].filter(Boolean).join('\n')
  const year = Number(meta.releaseDate.slice(0, 4)) || null
  const coverUrl = artwork.cover || meta.coverUrl
  // 刷新轮次顺手把评分补上：页面已经拿到了，不额外发请求
  const score = scoreOfViews(meta.views)

  if (existing) {
    // 已由 jable-blurb 写过中文简介的条目，别用原始描述盖掉
    const keepBlurb = String(existing.description ?? '').startsWith('簡介：')
    run(`UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?,
      category = 'MOVIE', content_type = 'movie', is_adult = 1, release_date = ?, status = 'published',
      score = COALESCE(?, score),
      published_at = COALESCE(published_at, ?), updated_at = datetime('now')
      WHERE id = ?`,
    meta.titleBody, meta.subtitle, coverUrl, keepBlurb ? existing.description : description, year, '日本', meta.releaseDate || null, score, meta.releaseDate || null, existing.id)
    return { id: existing.id, created: false }
  }
  const info = run(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category,
    content_type, is_adult, release_date, status, published_at, sort, score)
    VALUES (?, ?, ?, ?, ?, '日本', 'MOVIE', 'movie', 1, ?, 'published', ?, 0, ?)`,
  meta.titleBody, meta.subtitle, coverUrl, description, year, meta.releaseDate || null, meta.releaseDate || null, score)
  return { id: Number(info.lastInsertRowid), created: true }
}

function upsertEpisode(dramaId, meta) {
  const keep = Number(one('SELECT COALESCE(MAX(duration), 0) d FROM episodes WHERE drama_id = ?', dramaId)?.d ?? 0)
  const duration = meta.duration || keep || 0
  run(`INSERT INTO episodes (drama_id, no, title, duration, remote_url, remote_referer, remote_ua, remote_cookie, status, progress)
    VALUES (?, 1, '正片', ?, ?, ?, ?, '', 'ready', 100)
    ON CONFLICT(drama_id, no) DO UPDATE SET
      remote_url = excluded.remote_url,
      remote_referer = excluded.remote_referer,
      remote_ua = excluded.remote_ua,
      duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE episodes.duration END,
      status = 'ready', error = NULL, progress = 100`,
  dramaId, duration, meta.hlsUrl, REFERER, UA)
  return one('SELECT id FROM episodes WHERE drama_id = ? AND no = 1', dramaId)?.id ?? 0
}

async function probeDuration(meta) {
  try {
    const response = await fetch(meta.hlsUrl, { headers: { referer: REFERER, 'user-agent': UA }, signal: AbortSignal.timeout(20000) })
    if (!response.ok) return 0
    return durationOfPlaylist(await response.text())
  } catch {
    return 0
  }
}

async function importOne(browser, url) {
  const html = await browser.navigate(url)
  if (!/hlsUrl\s*=\s*'/.test(html)) return { ok: false, url, reason: '页面没拿到 hlsUrl（挑战没过或页面改版）' }
  const meta = parseVideoPage(html, url)
  if (!meta.hlsUrl) return { ok: false, url, reason: '没有 hlsUrl' }
  // 素人片和改版页的标题里没有番号，用详情页 URL 的 slug 兜底：
  // 不然这类片一旦链接过期，refresh 再也认不回来
  if (!meta.code) {
    const fromUrl = /\/videos\/([a-z0-9]+-\d+)\/?$/i.exec(String(url))
    if (fromUrl) {
      meta.code = fromUrl[1].toUpperCase()
      meta.slug = slugOf(meta.code)
      meta.titleBody = meta.titleBody || meta.title || meta.code
      meta.subtitle = meta.subtitle || meta.code
    }
  }
  if (!meta.code) return { ok: false, url, reason: '标题里没有番号' }
  if (!meta.slug) return { ok: false, url, reason: '拿不到番号，无法生成 slug' }
  const expiry = expiryOf(meta.hlsUrl)

  if (dry) {
    meta.duration = await probeDuration(meta)
    return { ok: true, url, meta, expiry, dry: true }
  }

  // 时长探测和抓图互不依赖，合在一起等，跨境下载的等待时间就被时长探测盖住了
  const [duration, artwork] = await Promise.all([
    probeDuration(meta),
    skipImages ? Promise.resolve({}) : grabArtwork(meta)
  ])
  meta.duration = duration
  const drama = upsertDrama(meta, artwork)
  const episodeId = upsertEpisode(drama.id, meta)
  const tags = linkTags(drama.id, meta.tags)
  return { ok: true, url, meta, expiry, dramaId: drama.id, created: drama.created, episodeId, tags, artwork }
}

// ---------- 入口 ----------
function refreshTargets() {
  const targets = []
  // 番号存在 sub_title（`CODE · 女優`），title 已被去掉番号，别从 title 里找
  const pages = all(`SELECT DISTINCT d.id, d.sub_title, d.title, e.remote_url, e.id AS eid FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE e.remote_referer = ? OR e.remote_url LIKE '%mushroomtrack.com%'`, REFERER)
  for (const row of pages) {
    const code = /^([A-Za-z0-9_]+-\d+)/.exec(String(row.sub_title ?? ''))?.[1]
    if (!code) {
      console.log(`  跳过 ${row.title}：sub_title 里没有番号，无法反推 jable 地址`)
      continue
    }
    targets.push({ url: `https://jable.tv/videos/${code.toLowerCase().replace(/_/g, '-')}/`, expires: expiryOf(row.remote_url) })
  }
  // 先刷最早过期的：中途被打断时，剩下的至少还活着
  return targets.sort((a, b) => a.expires - b.expires)
}

// ---------- 评分补全（--score-only） ----------
/** 库内缺评分的 jable 片，按 sub_title 里的番号反推详情页地址。 */
function scoreTargets() {
  const rows = all(`SELECT d.id, d.sub_title, d.title FROM dramas d
     WHERE d.is_adult = 1 AND d.category = 'MOVIE' AND (d.score IS NULL OR d.score = '')
       AND EXISTS (SELECT 1 FROM episodes e WHERE e.drama_id = d.id AND (e.remote_referer = ? OR e.remote_url LIKE '%alonestreaming.com%' OR e.remote_url LIKE '%mushroomtrack.com%'))
     ORDER BY d.id`, REFERER)
  const list = []
  for (const row of rows) {
    const code = /^([A-Za-z0-9_]+-\d+)/.exec(String(row.sub_title ?? ''))?.[1]
    if (!code) continue
    list.push({ dramaId: row.id, title: row.title, url: `https://jable.tv/videos/${code.toLowerCase().replace(/_/g, '-')}/` })
  }
  return list
}


async function runScoreBatch(browser, list) {
  const update = db.prepare("UPDATE dramas SET score = ?, updated_at = datetime('now') WHERE id = ?")
  let ok = 0
  let failed = 0
  let skipped = 0
  for (const [index, item] of list.entries()) {
    const label = `[${index + 1}/${list.length}] ${item.url}`
    try {
      const html = await browser.navigate(item.url)
      if (!/hlsUrl\s*=\s*'/.test(html)) {
        failed++
        console.log(`${label}\n  ✗ 页面没拿到 hlsUrl（挑战没过或页面改版）`)
        continue
      }
      const meta = parseVideoPage(html, item.url)
      const score = scoreOfViews(meta.views)
      if (!score) {
        skipped++
        console.log(`${label}\n  · ${item.title.slice(0, 50)} 没有播放量，跳过`)
        continue
      }
      if (dry) {
        console.log(`${label}\n  · ${item.title.slice(0, 50)} 播放 ${meta.views} → ${score} 分（dry）`)
        ok++
        continue
      }
      update.run(score, item.dramaId)
      ok++
      console.log(`${label}\n  ✓ ${item.title.slice(0, 50)} 播放 ${meta.views} → ${score} 分`)
    } catch (error) {
      failed++
      console.log(`${label}\n  ✗ ${error.message}`)
    }
  }
  console.log(`\n完成：成功 ${ok}，跳过 ${skipped}，失败 ${failed}`)
}

async function runBatch(browser, list) {
  let ok = 0
  let failed = 0
  for (const [index, item] of list.entries()) {
    const url = typeof item === 'string' ? item : item.url
    const label = `[${index + 1}/${list.length}] ${url}`
    try {
      const result = await importOne(browser, url)
      if (!result.ok) {
        failed++
        console.log(`${label}\n  ✗ ${result.reason}`)
        continue
      }
      ok++
      const m = result.meta
      console.log(`${label}\n  ✓ ${m.code || '(无番号)'} ${m.title.slice(0, 60)}`)
      console.log(`    hls: ${m.hlsUrl}`)
      console.log(`    时长 ${Math.round(m.duration / 60)} 分钟 · 链接有效至 ${result.expiry ? new Date(result.expiry * 1000).toLocaleString('zh-CN') : '未知'}`)
      console.log(`    封面 ${result.artwork?.cover || m.coverUrl}${result.artwork?.preview ? ` · 预览图 ${result.artwork.preview}` : ''}`)
      if (!result.dry) console.log(`    入库 drama#${result.dramaId}${result.created ? '（新建）' : '（更新）'} · episode#${result.episodeId} · 关联标签 ${result.tags}`)
    } catch (error) {
      failed++
      console.log(`${label}\n  ✗ ${error.message}`)
    }
  }
  console.log(`\n完成：成功 ${ok}，失败 ${failed}`)
}

async function main() {
  const every = Number(valueOf('--every', '0')) || 0
  const browser = await openBrowser()
  try {
    if (scoreOnly) {
      const offset = Number(valueOf('--offset', '0')) || 0
      const all_ = scoreTargets()
      const list = offset > 0 ? all_.slice(offset) : all_
      const limited = limit > 0 ? list.slice(0, limit) : list
      console.log(`待补评分 ${limited.length} 部（库存 ${list.length}${dry ? '，dry-run' : ''}）`)
      if (limited.length) await runScoreBatch(browser, limited)
      return
    }
    let round = 0
    do {
      round++
      if (every) console.log(`\n=== 第 ${round} 轮 ${new Date().toLocaleString('zh-CN')} ===`)
      const targets = [...urls]
      if (listPage) {
        // --pages N：从列表页连续翻 N 页（jable 的分页是 /latest-updates/2/ 这种路径）
        const total = Math.max(1, pageCount)
        const collected = []
        let emptyStreak = 0
        for (let p = startPage; p < startPage + total; p++) {
          const url = p === 1 ? listPage : `${listPage.replace(/\/+$/, '')}/${p}/`
          let found = []
          // 连续快速翻页会被 Cloudflare 限流成挑战页：退避重试，别一页空了就整批放弃
          for (let attempt = 0; attempt < 3 && !found.length; attempt++) {
            const html = await browser.navigate(url, { wantHls: false })
            found = parseVideoLinks(html)
            if (found.length) break
            const wait = 8000 + attempt * 8000
            console.log(`  第 ${p} 页没内容（第 ${attempt + 1} 次），等 ${Math.round(wait / 1000)} 秒重试`)
            await sleep(wait)
          }
          console.log(`列表页 ${p}（第 ${p - startPage + 1}/${total} 页）拿到 ${found.length} 个链接`)
          if (!found.length) {
            emptyStreak += 1
            if (emptyStreak >= 3) {
              console.log('连续 3 页拿不到内容，停止翻页')
              break
            }
            continue
          }
          emptyStreak = 0
          collected.push(...found)
          await sleep(1200 + Math.floor(Math.random() * 1800))
        }
        let links = [...new Set(collected)]
        if (skipExisting) {
          const before = links.length
          links = links.filter((u) => !libraryHas(codeOfUrl(u)))
          console.log(`跳过库中已有 ${before - links.length} 个，剩 ${links.length} 个待导入`)
        }
        if (pageCount > 1) console.log(`列表页合计 ${links.length} 个影片链接（去重后）`)
        targets.push(...links)
      }
      if (refresh && !targets.length) {
        const all_ = refreshTargets()
        const now = Math.floor(Date.now() / 1000)
        // --max-left N：只刷剩余有效期不足 N 分钟的，库里几百条时别每次全刷
        const cut = (Number(valueOf('--max-left', '0')) || 30) * 60
        const expiring = all_.filter((t) => t.expires && t.expires - now < cut)
        console.log(`刷新模式：库中 ${all_.length} 条外部源，${expiring.length} 条 ${Math.round(cut / 60)} 分钟内到期`)
        // 长跑时只刷快过期的，省得每轮都把全库重解析一遍
        const useFiltered = Boolean(every || valueOf('--max-left', ''))
        if (useFiltered && !expiring.length) console.log('没有快过期的链接，本轮跳过')
        targets.push(...(useFiltered ? expiring : all_).map((t) => t))
      }
      const unique = [...new Map(targets.map((t) => [typeof t === 'string' ? t : t.url, t])).values()]
        .slice(0, limit || undefined)
      if (!unique.length) {
        console.log('没有要导入的地址。给一个影片页 URL，或用 --page <列表页> 批量抓。')
        if (!every) return
      }
      await runBatch(browser, unique)
      if (!every) return
      console.log(`\n${every} 分钟后开始下一轮（Ctrl+C 退出）`)
      await new Promise((r) => setTimeout(r, every * 60000))
    } while (true)
  } finally {
    browser.close()
  }
}

main().catch((error) => {
  console.error('导入失败：', error.message)
  process.exit(1)
})
