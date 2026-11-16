/**
 * 影巢服务端入口（无直播版）：
 *   /            C 端（public/）
 *   /admin      后台（admin/）
 *   /api/*      C 端接口
 *   /admin/api/*后台接口（RBAC 保护）
 *   /media/hls/*HLS 切片：必须带 sign+expires（与 nginx secure_link 同规则）
 */
import { createServer } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { db, seedIfEmpty, ROOT, ensureSettings, ensurePaySafety, ensureUserSchema, ensureAdminSchema, ensureAdminCredentials, ensureLinkSecret, ensureOpsSchema, migrateCodesToNumeric, migratePayChannels, syncMenuCatalog } from './db.mjs'
import { cleanupCodes } from './otp.mjs'
import { handlePublic } from './api-public.mjs'
import { handleAdmin, preAuthorizeAdmin } from './api-admin.mjs'
import { HLS_DIR, UPLOAD_DIR } from './media.mjs'
import { processCommissionOutbox, processCommissionReversalOutbox } from './commerce.mjs'
import { PREVIEW_DIR } from './previews.mjs'
import { verifyLink } from './entitlements.mjs'
import { handleRemoteRequest, parseRangeHeader, pipeFile } from './stream-proxy.mjs'
import { normalizePlaylistUri, stampPlaylist, truncatePlaylist } from './trial-playlist.mjs'
import { ensureFreshForPlay, staleOf, warmProfile } from './jable-refresh.mjs'
import { closeExpiredOrders, reconcile } from './commerce.mjs'
import { refreshAutoRanks } from './rank.mjs'
import { inspect, sweep } from './ratelimit.mjs'
import { connectRedis, redisStatus } from './redis.mjs'
import { logError, logInfo, logWarn, newRequestId } from './logger.mjs'
import { markCommissionsAvailable, reconcileWithdrawalCommissions, recordInviteClick } from './distribution.mjs'
import { rebuildContentStats, refreshContentRanks } from './content-stats.mjs'
import { resolveInside } from './path-safety.mjs'

/**
 * 站点子路径（如 /video）。nginx 会把前缀剥掉再反代，服务端渲染的支付页必须自己拼回去，
 * 否则 fetch('/api/pay/mock')、location.href='/#/me' 会跳到同域其它项目的根目录。
 */
const BASE_PATH = (process.env.MH_BASE_PATH ?? '').replace(/\/+$/, '')
import { scanOnce } from './usdt-watch.mjs'

/** 订单号只允许这几种字符，避免把路径片段直接插进 HTML/JS。 */
const ORDER_NO_RE = /^[A-Za-z0-9_-]{4,64}$/
const SIM_PAY_OPEN = () => process.env.MH_ALLOW_SIM_PAY === '1'
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

mkdirSync(UPLOAD_DIR, { recursive: true })
mkdirSync(HLS_DIR, { recursive: true })

ensureAdminSchema()      // 老库先补列，避免 seed 插入强制改密标记时缺列
const seed = seedIfEmpty()
ensureUserSchema()
ensureAdminSchema()
ensureSettings()
ensureAdminCredentials()   // 老库弱口令轮换（与 seed 解耦）
ensureOpsSchema()          // 标签层级 / 按集定价 / 榜单自动分 / 搜刮缓存（幂等补列补表）
reconcileWithdrawalCommissions()
const codeMigration = migrateCodesToNumeric()  // 套餐/优惠券英文编码迁成雪花数字码
ensureLinkSecret()         // 播放签名密钥自检
ensurePaySafety()          // 模拟支付渠道默认关闭 + USDT 确认数口径统一
syncMenuCatalog()
const channelMigration = migratePayChannels()
const PORT = Number(process.env.PORT ?? 8787)
const PUBLIC = join(ROOT, 'public')
const ADMIN = join(ROOT, 'admin')
const CLIENT_BUILD = join(ROOT, 'dist', 'client')
const ADMIN_BUILD = join(ROOT, 'dist', 'admin')
const CLIENT_ROOT = existsSync(join(CLIENT_BUILD, 'index.html')) ? CLIENT_BUILD : PUBLIC
const ADMIN_ROOT = existsSync(join(ADMIN_BUILD, 'index.html')) ? ADMIN_BUILD : ADMIN
const CLIENT_INDEX = CLIENT_ROOT === PUBLIC ? 'legacy.html' : 'index.html'
const ADMIN_INDEX = ADMIN_ROOT === ADMIN ? 'legacy.html' : 'index.html'
const ALLOW_UNSIGNED = process.env.MH_ALLOW_UNSIGNED === '1'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
}

/** 大文件上传：流式落地（不把整个视频读进内存）。 */
function streamToUpload(req) {
  const temp = join(UPLOAD_DIR, `upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.part`)
  const limit = Number(process.env.MH_UPLOAD_MAX_BYTES ?? 2 * 1024 * 1024 * 1024)
  return new Promise((resolvePromise, reject) => {
    const out = createWriteStream(temp)
    let size = 0
    let failed = false
    const cleanup = (error) => {
      if (failed) return
      failed = true
      out.destroy()
      try { unlinkSync(temp) } catch { /* 临时文件可能还没创建 */ }
      reject(error)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        cleanup(Object.assign(new Error('文件超出上传上限'), { status: 413 }))
      }
    })
    req.pipe(out)
    out.on('error', cleanup)
    req.on('error', cleanup)
    out.on('finish', () => {
      if (failed) return
      if (!size) return cleanup(Object.assign(new Error('上传内容为空'), { status: 400 }))
      resolvePromise({ path: temp, size })
    })
  })
}

/**
 * URL 解码：畸形百分号编码（%zz、%E4%B8）不能把请求打进 catch 变成 500，
 * 解不开就按原串处理，交给后面的路径解析判 403/404。
 */
function safeDecode(value) {
  const raw = String(value ?? '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * nginx 传进来的 x-original-uri 带站点子路径（如 /video/media/hls/1/index.m3u8）。
 * 按配置的 MH_BASE_PATH 裁掉才是签名用的媒体路径；base path 为空时原样返回，
 * 不能像以前那样硬编码 /video，换子路径部署就整站播放签名 403。
 */
function stripBasePath(uri) {
  const value = String(uri ?? '')
  if (!BASE_PATH) return value
  if (value === BASE_PATH) return '/'
  if (value.startsWith(`${BASE_PATH}/`)) return value.slice(BASE_PATH.length)
  return value
}

function serveFileWithRange(req, res, filePath, cacheControl = 'no-cache') {
  const stat = statSync(filePath)
  const type = MIME[extname(filePath)] ?? 'application/octet-stream'
  const range = parseRangeHeader(req.headers.range, stat.size)
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}`, 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (!range) {
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': cacheControl })
    return pipeFile(res, filePath)
  }
  res.writeHead(206, {
    'content-type': type,
    'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
    'content-length': range.end - range.start + 1,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
  })
  return pipeFile(res, filePath, { start: range.start, end: range.end })
}

function serveStatic(rootDir, pathname, res) {
  const relative = safeDecode(pathname).replace(/^\/+/, '')
  const safe = resolveInside(rootDir, relative || 'index.html')
  if (!safe || !existsSync(safe) || !statSync(safe).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  return pipeFile(res, safe)
}

/** 试看清单/分片白名单：按 (集号, 秒数) 缓存 5 秒，避免每个分片请求都把清单重读一遍 */
const TRIAL_CACHE_TTL_MS = 5000
const TRIAL_ALLOWED = new Map()

function denyTrial(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(String(message))
}

/**
 * 剩余试看秒数。接口把秒数签进了 scope（`/media/trial/<id>/<sec>/`），所以 query 上的 sec
 * 是可信的：直接按它截断，播放过程中窗口不会随时间缩水（早期实现与 expires 取 min，
 * 结果看到第 100 秒时预算回落到几十秒，后面的分片突然 403）。
 * 没有 sec 的旧链接退回「expires 剩余秒数」。向下取 5 秒的整数倍，让同一窗口命中同一份缓存。
 */
function trialBudgetOf(url, expires) {
  const leftSeconds = Number(expires) - Math.floor(Date.now() / 1000)
  const signed = Math.trunc(Number(url.searchParams.get('sec') ?? NaN))
  const budget = Number.isFinite(signed) && signed > 0 ? Math.min(signed, 3600) : leftSeconds
  if (!Number.isFinite(budget) || budget <= 0) return 0
  return Math.floor(budget / 5) * 5
}

/**
 * 本地 HLS 目录里「试看窗口内可取的分片」集合。
 * 目录结构与 /media/hls/<id>/ 完全一致：master index.m3u8 → <rendition>/index.m3u8 → seg_xxx.ts。
 * master 与变体清单用同一份秒数预算各自截断，分片名带目录前缀，才能跟请求路径对上。
 */
function trialAllowedOf(episodeId, seconds) {
  const key = `${episodeId}:${seconds}`
  const hit = TRIAL_ALLOWED.get(key)
  if (hit && Date.now() - hit.at < TRIAL_CACHE_TTL_MS) return hit.allowed
  const root = join(HLS_DIR, String(episodeId))
  const allowed = new Set()
  const readManifest = (relPath, depth) => {
    const manifestPath = resolveInside(root, relPath)
    if (!manifestPath || !existsSync(manifestPath)) return
    let text = ''
    try {
      text = readFileSync(manifestPath, 'utf8')
    } catch {
      return
    }
    const cut = truncatePlaylist(text, { seconds })
    const dirPrefix = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : ''
    for (const rawUri of cut.allowed) {
      const full = `${dirPrefix}${normalizePlaylistUri(rawUri)}`
      allowed.add(full)
      if (/\.m3u8$/i.test(full) && depth > 0) readManifest(full, depth - 1)
    }
  }
  readManifest('index.m3u8', 1)
  if (TRIAL_ALLOWED.size > 128) TRIAL_ALLOWED.delete(TRIAL_ALLOWED.keys().next().value)
  TRIAL_ALLOWED.set(key, { allowed, at: Date.now() })
  return allowed
}

/**
 * GET /media/trial/<episodeId>/<name>
 * 公网接口给试看请求签的 scope 是 /media/trial/<episodeId>/<sec>/，与 /media/hls/ 的整集 scope 不同：
 * 秒数进签名，客户端改 sec 参数只会让整条链接失效；这里只放行「前 N 秒清单里出现过的分片」，
 * 其余一律 403，从服务端真正限制能拉多少内容。
 */
function serveTrialMedia(req, res, url, pathname) {
  const match = /^\/media\/trial\/(\d+)\/(.*)$/.exec(pathname)
  if (!match) {
    denyTrial(res, 403, '403 试看链接无效')
    return
  }
  const episodeId = Number(match[1])
  const name = safeDecode(match[2])
  if (!name || name.includes('..') || name.startsWith('/')) {
    denyTrial(res, 403, '403 非法路径')
    return
  }
  const cookies = cookiesOf(req)
  const sign = url.searchParams.get('sign') ?? cookies[`mh_link_${episodeId}`]
  const expires = url.searchParams.get('expires') ?? cookies[`mh_exp_${episodeId}`]
  // 秒数进 scope：签成 /media/trial/<id>/<sec>/ 后，改 query 里的 sec 会导致签名对不上
  const signedSeconds = Math.trunc(Number(url.searchParams.get('sec') ?? NaN))
  const secPart = Number.isFinite(signedSeconds) && signedSeconds > 0 ? `${signedSeconds}/` : ''
  const scope = `/media/trial/${episodeId}/${secPart}`
  const ok = ALLOW_UNSIGNED || verifyLink(scope, sign, expires, String(req.headers['user-agent'] ?? ''))
  if (!ok) {
    denyTrial(res, 403, '403 试看链接无效或已过期')
    return
  }
  const budget = trialBudgetOf(url, expires)
  const root = join(HLS_DIR, String(episodeId))
  const filePath = resolveInside(root, name)
  if (!filePath) {
    denyTrial(res, 403, '403 非法路径')
    return
  }
  if (/\.m3u8$/i.test(name)) {
    if (!existsSync(filePath)) {
      denyTrial(res, 404, '404')
      return
    }
    const cut = truncatePlaylist(readFileSync(filePath, 'utf8'), { seconds: budget })
    // 分片/子清单地址带上同一张票：播放器解析相对地址会丢掉页面 query，只靠 Cookie 在换码率时会漏
    const ticket = url.searchParams.toString()
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' })
    res.end(stampPlaylist(cut.text, ticket))
    return
  }
  if (!/\.(ts|m4s|mp4|aac|key)$/i.test(name)) {
    denyTrial(res, 403, '403 试看只提供清单与分片')
    return
  }
  if (budget <= 0 || !trialAllowedOf(episodeId, budget).has(name)) {
    denyTrial(res, 403, '403 试看已结束，购买后可看完整剧集')
    return
  }
  if (!existsSync(filePath)) {
    denyTrial(res, 404, '404')
    return
  }
  serveFileWithRange(req, res, filePath, 'private, max-age=60')
}


/** 模拟支付页（仅测试环境；生产关闭 mock 渠道后本页 404）。 */
function mockPayPage(outTradeNo, res) {
  const orderNo = escapeHtml(outTradeNo)
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>模拟支付 · 影巢</title>
<style>body{background:#0e0f13;color:#e8e8ee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:16px;padding:28px 32px;text-align:center;min-width:320px}
h1{font-size:18px;margin:0 0 8px}p{color:#9aa3b2;font-size:13px}
button{margin-top:16px;padding:12px 24px;border:0;border-radius:10px;background:linear-gradient(135deg,#ff7a59,#ff4d6d);color:#fff;font-size:15px;cursor:pointer}
</style></head><body><div class="card">
<h1>模拟支付（测试渠道）</h1><p>订单号 ${orderNo}</p>
<p>当前为测试支付通道，接入真实支付宝 / USDT 后自动下线</p>
<button id="pay">模拟支付成功</button>
<a id="back" href="${BASE_PATH}/#/me" style="display:none;margin-top:14px;color:#ff7a59;font-size:14px">返回站点查看订单</a>
<div id="result" style="margin-top:14px;font-size:13px;color:#4ade80"></div>
</div>
<script>
document.getElementById('pay').addEventListener('click', async () => {
  const ticket = new URLSearchParams(location.search).get('ticket') ?? ''
  const res = await fetch('${BASE_PATH}/api/pay/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outTradeNo: ${JSON.stringify(outTradeNo)}, ticket }) })
  const json = await res.json()
  document.getElementById('result').textContent = json.code === '0000' ? '支付成功，权益已到账，可回到站点观看' : ('失败：' + json.msg)
  if (json.code === '0000') document.getElementById('back').style.display = 'inline-block'
})
</script></body></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

/** 支付宝模拟收银台：未配置真实商户参数时使用；付款会走真实 RSA2 签名 + 验签。 */
function alipaySimPage(outTradeNo, res) {
  const order = db.prepare('SELECT * FROM orders WHERE out_trade_no = ?').get(outTradeNo)
  const amount = order ? Number(order.amount_cny).toFixed(2) : '0.00'
  const missing = order ? '' : '<p style="color:#ff8a8a">订单不存在或已过期</p>'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>支付宝收银台（模拟） · 影巢</title>
<style>
body{background:#f5f7fb;color:#1f2430;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(20,40,80,.12);padding:28px 32px;width:min(420px,92vw)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;color:#1677ff;margin-bottom:18px}
.logo{width:32px;height:32px;border-radius:8px;background:#1677ff;color:#fff;display:grid;place-items:center;font-size:16px}
.amount{font-size:34px;font-weight:700;margin:10px 0 4px}
.muted{color:#7b8496;font-size:13px}
.row{display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-bottom:1px dashed #e6eaf2}
button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:10px;background:#1677ff;color:#fff;font-size:16px;cursor:pointer}
button.ghost{background:#eef2f8;color:#4a5468;margin-top:10px}
#msg{margin-top:14px;font-size:13px;color:#12a05c;min-height:18px}
</style></head><body><div class="card">
<div class="brand"><span class="logo">支</span>支付宝 · 沙箱收银台</div>
${missing}
<div class="muted">订单号 ${escapeHtml(outTradeNo)}</div>
<div class="amount">¥ ${amount}</div>
<div class="row"><span>收款方</span><span>影巢（沙箱）</span></div>
<div class="row"><span>商品</span><span>会员 / 一次性</span></div>
<div class="row"><span>支付方式</span><span>余额宝（模拟）</span></div>
<button id="pay">确认付款</button>
<button class="ghost" id="cancel">取消并返回</button>
<div id="msg"></div>
<p class="muted" style="margin-top:16px">本页用于未接入真实商户前的联调：点击付款后，服务端用模拟私钥签名异步通知，再用对应公钥验签入账。</p>
</div>
<script>
document.getElementById('cancel').addEventListener('click', () => history.length > 1 ? history.back() : location.href = '${BASE_PATH}/')
document.getElementById('pay').addEventListener('click', async () => {
  const button = document.getElementById('pay')
  button.disabled = true
  button.textContent = '支付中…'
  const res = await fetch('${BASE_PATH}/api/pay/alipay-sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outTradeNo: ${JSON.stringify(outTradeNo)}, ticket: new URLSearchParams(location.search).get('ticket') ?? '' }) })
  const json = await res.json()
  if (json.code === '0000') {
    document.getElementById('msg').textContent = '支付成功，权益已到账，正在返回…'
    setTimeout(() => { location.href = '${BASE_PATH}/#/me' }, 1200)
  } else {
    document.getElementById('msg').style.color = '#d93025'
    document.getElementById('msg').textContent = '支付失败：' + json.msg
    button.disabled = false
    button.textContent = '确认付款'
  }
})
</script></body></html>`
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
}

function cookiesOf(req) {
  return Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((part) => {
    const [key, ...rest] = part.trim().split('=')
    return [key, rest.join('=')]
  }))
}

/** 按媒体路径里的集号取签名：优先分集 Cookie，回退通用 Cookie（兼容老客户端/旧链接） */
function linkCredentials(req, mediaPath, url) {
  const cookies = cookiesOf(req)
  const scope = /^\/media\/(?:hls|remote)\/(\d+)\//.exec(mediaPath)?.[1]
  const scopedSign = scope ? cookies[`mh_link_${scope}`] : undefined
  const scopedExp = scope ? cookies[`mh_exp_${scope}`] : undefined
  return {
    sign: url.searchParams.get('sign') ?? scopedSign ?? cookies.mh_link,
    expires: url.searchParams.get('expires') ?? scopedExp ?? cookies.mh_exp,
  }
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now()
  const requestId = newRequestId()
  req.requestId = requestId
  res.setHeader('x-request-id', requestId)
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt
    const apiRequest = pathname.startsWith('/api/') || pathname.startsWith('/admin/api/') || pathname === '/media-auth'
    const slowMs = Number(process.env.MH_SLOW_MS ?? 800)
    if (!apiRequest && res.statusCode < 400 && durationMs < slowMs) return
    const fields = {
      requestId,
      method: req.method,
      path: pathname,
      status: res.statusCode,
      durationMs,
      ip: String(req.socket?.remoteAddress ?? ''),
      userAgent: String(req.headers['user-agent'] ?? ''),
      contentLength: res.getHeader('content-length') ?? null,
    }
    if (res.statusCode >= 500 || durationMs >= slowMs) logWarn('http.request', fields)
    else logInfo('http.request', fields)
  })

  try {
    // 反爬与限流（UA 黑名单 / 滑动窗口限流 / 内容枚举探测）
    const patrol = await inspect(req, pathname, req.method ?? 'GET')
    if (patrol.blocked) {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
      if (patrol.retryAfter) headers['retry-after'] = String(patrol.retryAfter)
      res.writeHead(patrol.status, headers)
      res.end(JSON.stringify({ code: patrol.reason, msg: patrol.status === 429 ? '请求过于频繁，请稍后再试' : '当前访问方式被拒绝', data: null }))
      return
    }

    // nginx auth_request：校验播放签名（Cookie 或 query），命中返回 204
    if (pathname === '/media-auth') {
      const original = String(req.headers['x-original-uri'] ?? '')
      const mediaPath = stripBasePath(original).split('?')[0]
      const { sign, expires } = linkCredentials(req, mediaPath, url)
      const ua = String(req.headers['user-agent'] ?? '')
      const ok = ALLOW_UNSIGNED || verifyLink(mediaPath, sign, expires, ua)
      res.writeHead(ok ? 204 : 403, { 'cache-control': 'no-store' })
      res.end()
      return
    }

    // 试看：清单按秒截断 + 分片白名单（scope 是 /media/trial/<episodeId>/）
    if (pathname.startsWith('/media/trial/')) {
      return serveTrialMedia(req, res, url, pathname)
    }

    if (pathname.startsWith('/media/hls/')) {
      const { sign, expires } = linkCredentials(req, pathname, url)
      if (!ALLOW_UNSIGNED && !verifyLink(pathname, sign, expires, String(req.headers['user-agent'] ?? ''))) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 播放链接无效或已过期')
        return
      }
      const relative = safeDecode(pathname.replace('/media/hls/', ''))
      // 归一化后再校验前缀，堵住 ..%2f 之类的穿越（签名本身不覆盖路径语义）
      const filePath = resolveInside(HLS_DIR, relative)
      if (!filePath) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 非法路径')
        return
      }
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath, 'private, max-age=60')
    }

    // 外部片源代理：清单重写 + 分片转发，签名规则与本地 HLS 完全一致
    if (pathname.startsWith('/media/remote/')) {
      const { sign, expires } = linkCredentials(req, pathname, url)
      if (!ALLOW_UNSIGNED && !verifyLink(pathname, sign, expires, String(req.headers['user-agent'] ?? ''))) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 播放链接无效或已过期')
        return
      }
      const match = /^\/media\/remote\/(\d+)\/(.*)$/.exec(pathname)
      if (!match) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('404')
        return
      }
      const episodeId = Number(match[1])
      const rest = match[2]
      let episode = db
        .prepare('SELECT id, drama_id, remote_url, remote_referer, remote_ua, remote_cookie FROM episodes WHERE id = ?')
        .get(episodeId)
      if (!episode) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('404 该集不存在')
        return
      }
      // 清单请求才判续期：直链签名有保鲜期，快过期了就在这里换一张新的票
      if (!rest || rest === 'index.m3u8') {
        try {
          const result = await ensureFreshForPlay(episodeId, { timeoutMs: 15000 })
          if (result.refreshed) {
            episode = db
              .prepare('SELECT id, drama_id, remote_url, remote_referer, remote_ua, remote_cookie FROM episodes WHERE id = ?')
              .get(episodeId)
          }
          // 票还是过期的：直接回 503 + Retry-After，hls.js 会按这个时间重试，
          // 比让它收到上游 410 再报"网络错误"清楚得多
          if (staleOf(episode?.remote_url)) {
            const wait = Math.max(4, Math.round((result?.cooldownMs ?? 0) / 1000) || 5)
            res.writeHead(503, {
              'content-type': 'text/plain; charset=utf-8',
              'cache-control': 'no-store',
              'retry-after': String(wait),
            })
            res.end(`503 片源签名已过期，正在自动续期，请 ${wait} 秒后重试`)
            return
          }
        } catch (error) {
          console.error('[refresh] 续期失败', episodeId, error.message)
        }
      }
      return handleRemoteRequest(req, res, { episodeId, episode, rest })
    }

    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' })
      res.end([
        'User-agent: *',
        'Disallow: /api/',
        'Disallow: /admin/',
        'Disallow: /media/',
        'Allow: /$',
        '',
      ].join('\n'))
      return
    }

    if (pathname === '/media/uploads' || pathname.startsWith('/media/uploads/')) {
      // 源片（mp4）永远不直出：播放一律走 HLS + 签名，避免付费墙被整片拖走
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end('403 源文件不对外提供')
      return
    }

    if (pathname === '/media/placeholder.svg') {
      const title = (url.searchParams.get('t') ?? '影巢').slice(0, 24)
      const hue = [...title].reduce((sum, ch) => sum + ch.codePointAt(0), 0) % 360
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue}, 40%, 22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360}, 45%, 12%)"/>
  </linearGradient></defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <text x="200" y="300" text-anchor="middle" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="26" fill="rgba(255,255,255,0.82)">${title.replace(/[<>&]/g, '')}</text>
  <text x="200" y="340" text-anchor="middle" font-family="sans-serif" font-size="13" fill="rgba(255,255,255,0.45)">暂无海报</text>
</svg>`
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' })
      res.end(svg)
      return
    }

    if (pathname.startsWith('/media/images/')) {
      const filePath = resolveInside(join(ROOT, 'storage', 'images'), pathname.replace('/media/images/', ''))
      if (!filePath) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 非法路径')
        return
      }
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath, 'public, max-age=604800')
    }

    if (pathname.startsWith('/media/previews/')) {
      const relative = safeDecode(pathname.replace('/media/previews/', ''))
      const filePath = resolveInside(PREVIEW_DIR, relative)
      if (!filePath) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 非法路径')
        return
      }
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath, 'public, max-age=86400')
    }

    if (pathname.startsWith('/pay/mock/')) {
      const orderNo = pathname.split('/')[3] ?? ''
      if (!SIM_PAY_OPEN() || !ORDER_NO_RE.test(orderNo)) { res.writeHead(404); res.end('404'); return }
      return mockPayPage(orderNo, res)
    }

    if (pathname.startsWith('/pay/alipay-sim/')) {
      const orderNo = pathname.split('/')[3] ?? ''
      if (!SIM_PAY_OPEN() || !ORDER_NO_RE.test(orderNo)) { res.writeHead(404); res.end('404'); return }
      return alipaySimPage(orderNo, res)
    }

    if (pathname.startsWith('/i/')) {
      let code = ''
      try { code = decodeURIComponent(pathname.split('/')[2] ?? '') } catch { code = '' }
      try {
        if (code) recordInviteClick({
          code, visitorId: req.headers['x-mh-visitor'], ip: req.socket?.remoteAddress,
          ua: req.headers['user-agent'], referrer: req.headers.referer,
        })
      } catch (error) {
        logWarn('distribution.invite_click_rejected', { code, error })
      }
      const target = `${BASE_PATH}/?ref=${encodeURIComponent(code)}`
      res.writeHead(302, {
        location: target,
        'set-cookie': `mh_ref=${encodeURIComponent(code)}; Path=/; Max-Age=2592000; SameSite=Lax`,
      })
      res.end()
      return
    }

    if (pathname.startsWith('/admin/api/')) {
      const uploadMatch = /^\/admin\/api\/episodes\/(\d+)\/upload$/.exec(pathname)
      if (uploadMatch && req.method === 'POST') {
        // 先鉴权再落盘：否则匿名请求也能往 storage/uploads 写满上限（默认 2GB）
        const gate = preAuthorizeAdmin(req, 'content.episode.write')
        if (!gate.ok) {
          res.writeHead(gate.status, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
          res.end(JSON.stringify({ code: gate.code, msg: gate.msg, data: gate.data ?? {} }))
          return
        }
        const uploaded = await streamToUpload(req)
        return await handleAdmin(pathname, url, req, res, {}, { uploadPath: uploaded.path, uploadSize: uploaded.size })
      }
      return await handleAdmin(pathname, url, req, res)
    }

    if (pathname.startsWith('/api/')) {
      return await handlePublic(pathname, url, req, res)
    }

    if (pathname === '/admin') {
      // 少了尾斜杠会让页面里的 ./app.js 解析到站点根（/app.js 是 C 端脚本），必须重定向
      res.writeHead(301, { location: `${BASE_PATH}/admin/` })
      res.end()
      return
    }
    if (pathname.startsWith('/admin/')) {
      return serveStatic(ADMIN_ROOT, pathname.replace(/^\/admin\/?/, '') || ADMIN_INDEX, res)
    }

    return serveStatic(CLIENT_ROOT, pathname === '/' ? CLIENT_INDEX : pathname.replace(/^\//, ''), res)
  } catch (error) {
    if (error?.code && error?.status && !res.headersSent) {
      // 业务异常（CommerceError 等）：按语义返回 4xx，不吞成 500
      if (error.status === 413) res.setHeader('connection', 'close')
      res.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ code: error.code, msg: error.message, data: {} }))
      return
    }
    logError('http.exception', {
      requestId,
      method: req.method,
      path: pathname,
      status: Number(error?.status ?? 500),
      error,
    })
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ code: '0500', msg: '服务器错误', data: {} }))
    } else {
      try { res.end() } catch { /* ignore */ }
    }
  }
})

/**
 * 进程级兜底：一次读文件失败（构建时原子替换 dist、转码清理、管理员删集）不能让 Node
 * 直接退出——那会把所有在途请求一起带走，nginx 侧表现为整站 502。
 * 记录完整栈后停止接新请求，5 秒内没关完就强杀（卡住的连接不阻塞退出）。
 */
function fatalShutdown(event, error) {
  try {
    logError(event, { error, pid: process.pid })
  } catch {
    console.error(`[${event}]`, error?.stack ?? error)
  }
  const force = setTimeout(() => process.exit(1), 5000)
  force.unref?.()
  try {
    server.close(() => process.exit(1))
  } catch {
    process.exit(1)
  }
}

process.on('uncaughtException', (error) => fatalShutdown('process.uncaught_exception', error))
process.on('unhandledRejection', (reason) => fatalShutdown('process.unhandled_rejection', reason))

// 每分钟关掉超时未支付的订单
setInterval(() => {
  try { closeExpiredOrders() } catch (error) { console.error('[closeExpiredOrders]', error) }
}, 60_000).unref()
setInterval(() => {
  try { processCommissionOutbox() } catch (error) { logWarn('commerce.commission_outbox_retry_failed', { error }) }
  try { processCommissionReversalOutbox() } catch (error) { logWarn('commerce.commission_reversal_outbox_retry_failed', { error }) }
}, 60_000).unref()

setInterval(() => {
  try { sweep() } catch (error) { console.error('[ratelimit-sweep]', error) }
}, 120_000).unref()

// 每 10 分钟清理过期验证码与 30 天前的发送日志
setInterval(() => {
  try {
    const result = cleanupCodes()
    if (result.codes || result.logs) console.log('[otp-cleanup]', result)
  } catch (error) { console.error('[otp-cleanup]', error) }
}, 10 * 60_000).unref()

// 每 60 秒扫一次 TRC20 到账（未配置 usdt 收款地址时自动跳过）
setInterval(() => {
  scanOnce().catch((error) => console.error('[usdt-watch]', error.message))
}, 60_000).unref()

// 每 6 小时自动对账一次（此前只能人工点「对账」，渠道回调丢失后无人发现）
setInterval(async () => {
  try {
    const report = reconcile()
    const issues = Number(report.missingPayment ?? 0) + Number(report.orphanPayment ?? 0) + Number(report.stuckPaid ?? 0)
    if (issues > 0) console.warn('[reconcile] 发现差异', report)
    else console.log('[reconcile] 正常')
  } catch (error) {
    console.error('[reconcile]', error.message)
  }
}, 6 * 3600_000).unref()

// 榜单按用户行为自动更新：启动 60 秒后跑一次，之后每 6 小时一次（locked=1 的人工条目原位保留）
const runRankRefresh = () => {
  try {
    const results = refreshAutoRanks({ limit: 20 })
    const failed = results.filter((row) => row.error)
    if (failed.length) console.warn('[rank-refresh] 部分榜单失败', failed)
    else console.log(`[rank-refresh] ${results.length} 个自动榜单已更新`)
  } catch (error) {
    console.error('[rank-refresh]', error.message)
  }
}
setTimeout(runRankRefresh, 60_000).unref()
setInterval(runRankRefresh, 6 * 3600_000).unref()

const runGrowthStats = () => {
  try { rebuildContentStats({ days: 2 }) } catch (error) { logError('content.stats.task_failed', { error }) }
  try { markCommissionsAvailable() } catch (error) { logError('distribution.available.task_failed', { error }) }
}
const runContentRanks = () => {
  try {
    const results = refreshContentRanks()
    const failed = results.filter((row) => row.error)
    if (failed.length) console.warn('[content-ranks] 部分榜单失败', failed)
  } catch (error) {
    logError('content.ranks.task_failed', { error })
  }
}
setTimeout(() => { runGrowthStats(); runContentRanks() }, 60_000).unref()
setInterval(runGrowthStats, 5 * 60_000).unref()
setInterval(runContentRanks, 3600_000).unref()

connectRedis().catch(() => {})
// 复位上次进程中断的转码任务
{
  const stuck = db.prepare("UPDATE episodes SET status = 'pending', progress = 0 WHERE status IN ('transcoding', 'queued')").run()
  if (stuck.changes) console.log(`[media] 复位 ${stuck.changes} 个中断的转码任务`)
}

// 端口被占用时 listen 会发 error 事件：没有监听就是未捕获的 'error' 直接崩，连原因都没有
server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    console.error(`[启动失败] 端口 ${PORT} 已被占用：先停掉占用该端口的进程，或用 PORT=<其它端口> 重启`)
  } else if (error?.code === 'EACCES') {
    console.error(`[启动失败] 没有权限监听端口 ${PORT}（1024 以下端口需要管理员权限或能力位）`)
  } else {
    console.error('[启动失败]', error?.stack ?? error)
  }
  process.exit(1)
})

server.listen(PORT, '127.0.0.1', () => {
  const stats = {
    dramas: db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,
    episodes: db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,
    plans: db.prepare('SELECT COUNT(*) AS n FROM plans').get().n,
  }
  console.log('影巢已启动（无直播模块）')
  console.log(`  C 端      http://127.0.0.1:${PORT}/`)
  console.log(`  后台      http://127.0.0.1:${PORT}/admin   （账号见部署生成的管理员凭据文件）`)
  console.log(`  数据库    ${seed.seeded ? '已按种子初始化' : '沿用现有'}：${stats.dramas} 部剧 / ${stats.episodes} 集 / ${stats.plans} 个套餐`)
  if (codeMigration > 0) console.log(`  套餐/优惠券编码已迁移为数字码：${codeMigration} 条`)
  const rd = redisStatus()
  console.log(`  限流存储  ${rd.connected ? `Redis ${rd.url}` : '进程内内存（未连接 Redis）'}`)
  const debugFlags = ['MH_ALLOW_UNSIGNED', 'MH_OTP_TEST', 'MH_ALLOW_SIM_PAY', 'MH_ADMIN_INIT_PASSWORD', 'MH_SKIP_ADMIN_ROTATION']
    .filter((name) => process.env[name])
  if (debugFlags.length > 0) {
    console.warn(`  ⚠ 调试验证开关已开启：${debugFlags.join(', ')} —— 正式环境必须移除`)
  }
  const weakSecrets = ['MH_SECRET', 'MH_OTP_SECRET']
    .filter((name) => String(process.env[name] ?? '').length < 32)
  if (weakSecrets.length > 0) {
    console.warn(`  ⚠ 密钥过短或缺失：${weakSecrets.join(', ')}（建议 ≥32 位随机值）`)
  }

  // 预热按需续期用的浏览器 profile：冷 profile 第一次点击要重吃 Cloudflare 挑战（40 秒级），
  // 用户等不起。启动跑一次、之后每 20 分钟一次，让点开就能在 1～3 秒内换好票。
  const warm = () => warmProfile().catch(() => false)
  if (process.env.MH_WARM_PROFILE !== '0') {
    void warm()
    const timer = setInterval(warm, 20 * 60 * 1000)
    timer.unref?.()
  }
})


