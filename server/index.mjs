/**
 * 影巢服务端入口（无直播版）：
 *   /            C 端（public/）
 *   /admin      后台（admin/）
 *   /api/*      C 端接口
 *   /admin/api/*后台接口（RBAC 保护）
 *   /media/hls/*HLS 切片：必须带 sign+expires（与 nginx secure_link 同规则）
 */
import { createServer } from 'node:http'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { db, seedIfEmpty, ROOT, ensureSettings, ensurePaySafety, ensureUserSchema, ensureAdminSchema, ensureAdminCredentials, ensureLinkSecret, ensureOpsSchema, migrateCodesToNumeric, migratePayChannels, syncMenuCatalog } from './db.mjs'
import { cleanupCodes } from './otp.mjs'
import { handlePublic } from './api-public.mjs'
import { handleAdmin, preAuthorizeAdmin } from './api-admin.mjs'
import { HLS_DIR, UPLOAD_DIR } from './media.mjs'
import { processCommissionOutbox, processCommissionReversalOutbox } from './commerce.mjs'
import { PREVIEW_DIR } from './previews.mjs'
import { verifyLink } from './entitlements.mjs'
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

function serveFileWithRange(req, res, filePath, cacheControl = 'no-cache') {
  const stat = statSync(filePath)
  const type = MIME[extname(filePath)] ?? 'application/octet-stream'
  const range = req.headers.range
  if (!range) {
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': cacheControl })
    createReadStream(filePath).pipe(res)
    return
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  const start = match && match[1] !== '' ? Number(match[1]) : 0
  const end = match && match[2] !== '' ? Number(match[2]) : stat.size - 1
  if (start >= stat.size || end >= stat.size) {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` })
    res.end()
    return
  }
  res.writeHead(206, {
    'content-type': type,
    'content-range': `bytes ${start}-${end}/${stat.size}`,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
  })
  createReadStream(filePath, { start, end }).pipe(res)
}

function serveStatic(rootDir, pathname, res) {
  let relative
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, '') } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('400')
    return
  }
  const safe = resolveInside(rootDir, relative || 'index.html')
  if (!safe || !existsSync(safe) || !statSync(safe).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  createReadStream(safe).pipe(res)
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
<div class="row"><span>商品</span><span>会员 / 单片</span></div>
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
  const scope = /^\/media\/hls\/(\d+)\//.exec(mediaPath)?.[1]
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
      const mediaPath = original.replace(/^\/video/, '').split('?')[0]
      const { sign, expires } = linkCredentials(req, mediaPath, url)
      const ua = String(req.headers['user-agent'] ?? '')
      const ok = ALLOW_UNSIGNED || verifyLink(mediaPath, sign, expires, ua)
      res.writeHead(ok ? 204 : 403, { 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (pathname.startsWith('/media/hls/')) {
      const { sign, expires } = linkCredentials(req, pathname, url)
      if (!ALLOW_UNSIGNED && !verifyLink(pathname, sign, expires, String(req.headers['user-agent'] ?? ''))) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 播放链接无效或已过期')
        return
      }
      const relative = decodeURIComponent(pathname.replace('/media/hls/', ''))
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
      const relative = decodeURIComponent(pathname.replace('/media/previews/', ''))
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
})


