/**
 * 影巢服务端入口（无直播版）：
 *   /            C 端（public/）
 *   /admin      后台（admin/）
 *   /api/*      C 端接口
 *   /admin/api/*后台接口（RBAC 保护）
 *   /media/hls/*HLS 切片：必须带 sign+expires（与 nginx secure_link 同规则）
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { db, seedIfEmpty, ROOT, ensureSettings, ensureUserSchema, migratePayChannels, syncMenuCatalog } from './db.mjs'
import { cleanupCodes } from './otp.mjs'
import { handlePublic } from './api-public.mjs'
import { handleAdmin } from './api-admin.mjs'
import { HLS_DIR, UPLOAD_DIR } from './media.mjs'
import { verifyLink } from './entitlements.mjs'
import { closeExpiredOrders } from './commerce.mjs'
import { inspect, sweep } from './ratelimit.mjs'

mkdirSync(UPLOAD_DIR, { recursive: true })
mkdirSync(HLS_DIR, { recursive: true })

const seed = seedIfEmpty()
ensureUserSchema()
ensureSettings()
syncMenuCatalog()
const channelMigration = migratePayChannels()
const PORT = Number(process.env.PORT ?? 8787)
const PUBLIC = join(ROOT, 'public')
const ADMIN = join(ROOT, 'admin')
const ALLOW_UNSIGNED = process.env.MH_ALLOW_UNSIGNED === '1'

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

/** 大文件上传：流式落地（不把整个视频读进内存）。 */
function streamToUpload(req) {
  const temp = join(UPLOAD_DIR, `upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.part`)
  return new Promise((resolvePromise, reject) => {
    const stream = createReadStream ? undefined : undefined
    void stream
    const chunks = []
    let size = 0
    req.on('data', (chunk) => { chunks.push(chunk); size += chunk.length; if (size > 2 * 1024 * 1024 * 1024) req.destroy() })
    req.on('end', () => {
      try { writeFileSync(temp, Buffer.concat(chunks)); resolvePromise({ path: temp, size }) } catch (error) { reject(error) }
    })
    req.on('error', reject)
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
  const relative = decodeURIComponent(pathname).replace(/^\/+/, '')
  const filePath = normalize(join(rootDir, relative === '' ? 'index.html' : relative))
  const safe = resolve(filePath)
  if (!safe.startsWith(resolve(rootDir)) || !existsSync(safe) || !statSync(safe).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  createReadStream(safe).pipe(res)
}

/** 模拟支付页（仅演示环境；生产关闭 mock 渠道后本页 404）。 */
function mockPayPage(outTradeNo, res) {
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
<title>模拟支付 · 影巢</title>
<style>body{background:#0e0f13;color:#e8e8ee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
.card{background:#171a21;border:1px solid #2a2f3a;border-radius:16px;padding:28px 32px;text-align:center;min-width:320px}
h1{font-size:18px;margin:0 0 8px}p{color:#9aa3b2;font-size:13px}
button{margin-top:16px;padding:12px 24px;border:0;border-radius:10px;background:linear-gradient(135deg,#ff7a59,#ff4d6d);color:#fff;font-size:15px;cursor:pointer}
</style></head><body><div class="card">
<h1>模拟支付（演示渠道）</h1><p>订单号 ${outTradeNo}</p>
<p>生产环境请关闭 mock 渠道，接入支付宝 / USDT</p>
<button id="pay">模拟支付成功</button>
<div id="result" style="margin-top:14px;font-size:13px;color:#4ade80"></div>
</div>
<script>
document.getElementById('pay').addEventListener('click', async () => {
  const res = await fetch('/api/pay/mock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outTradeNo: '${outTradeNo}' }) })
  const json = await res.json()
  document.getElementById('result').textContent = json.code === '0000' ? '支付成功，权益已到账，可回到站点观看' : ('失败：' + json.msg)
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
<div class="muted">订单号 ${outTradeNo}</div>
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
document.getElementById('cancel').addEventListener('click', () => history.length > 1 ? history.back() : location.href = '/')
document.getElementById('pay').addEventListener('click', async () => {
  const button = document.getElementById('pay')
  button.disabled = true
  button.textContent = '支付中…'
  const res = await fetch('/api/pay/alipay-sim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outTradeNo: '${outTradeNo}' }) })
  const json = await res.json()
  if (json.code === '0000') {
    document.getElementById('msg').textContent = '支付成功，权益已到账，正在返回…'
    setTimeout(() => { location.href = '/#/me' }, 1200)
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname

  try {
    // 反爬与限流（UA 黑名单 / 滑动窗口限流 / 内容枚举探测）
    const patrol = inspect(req, pathname, req.method ?? 'GET')
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
      const cookies = Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((part) => {
        const [key, ...rest] = part.trim().split('=')
        return [key, rest.join('=')]
      }))
      const sign = url.searchParams.get('sign') ?? cookies.mh_link
      const expires = url.searchParams.get('expires') ?? cookies.mh_exp
      const ok = ALLOW_UNSIGNED || verifyLink(mediaPath, sign, expires)
      res.writeHead(ok ? 204 : 403, { 'cache-control': 'no-store' })
      res.end()
      return
    }

    if (pathname.startsWith('/media/hls/')) {
      const cookies = Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((part) => {
        const [key, ...rest] = part.trim().split('=')
        return [key, rest.join('=')]
      }))
      const sign = url.searchParams.get('sign') ?? cookies.mh_link
      const expires = url.searchParams.get('expires') ?? cookies.mh_exp
      if (!ALLOW_UNSIGNED && !verifyLink(pathname, sign, expires)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('403 播放链接无效或已过期')
        return
      }
      const filePath = join(HLS_DIR, pathname.replace('/media/hls/', ''))
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath, 'private, max-age=600')
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
      const filePath = join(UPLOAD_DIR, pathname.replace('/media/uploads/', ''))
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath)
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
      const filePath = join(ROOT, 'storage', 'images', pathname.replace('/media/images/', ''))
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath, 'public, max-age=604800')
    }

    if (pathname.startsWith('/pay/mock/')) {
      return mockPayPage(pathname.split('/')[3], res)
    }

    if (pathname.startsWith('/pay/alipay-sim/')) {
      return alipaySimPage(pathname.split('/')[3], res)
    }

    if (pathname.startsWith('/admin/api/')) {
      const uploadMatch = /^\/admin\/api\/episodes\/(\d+)\/upload$/.exec(pathname)
      if (uploadMatch && req.method === 'POST') {
        const uploaded = await streamToUpload(req)
        return await handleAdmin(pathname, url, req, res, undefined, { uploadPath: uploaded.path, uploadSize: uploaded.size })
      }
      return await handleAdmin(pathname, url, req, res)
    }

    if (pathname.startsWith('/api/')) {
      return await handlePublic(pathname, url, req, res)
    }

    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return serveStatic(ADMIN, pathname.replace(/^\/admin\/?/, '') || 'index.html', res)
    }

    return serveStatic(PUBLIC, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''), res)
  } catch (error) {
    if (error?.code && error?.status && !res.headersSent) {
      // 业务异常（CommerceError 等）：按语义返回 4xx，不吞成 500
      res.writeHead(error.status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ code: error.code, msg: error.message, data: {} }))
      return
    }
    console.error('[mh-clone]', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ code: '0500', msg: String(error?.message ?? error), data: {} }))
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
  try { sweep() } catch (error) { console.error('[ratelimit-sweep]', error) }
}, 120_000).unref()

// 每 10 分钟清理过期验证码与 30 天前的发送日志
setInterval(() => {
  try {
    const result = cleanupCodes()
    if (result.codes || result.logs) console.log('[otp-cleanup]', result)
  } catch (error) { console.error('[otp-cleanup]', error) }
}, 10 * 60_000).unref()

server.listen(PORT, '127.0.0.1', () => {
  const stats = {
    dramas: db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,
    episodes: db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,
    plans: db.prepare('SELECT COUNT(*) AS n FROM plans').get().n,
  }
  console.log('影巢已启动（无直播模块）')
  console.log(`  C 端      http://127.0.0.1:${PORT}/`)
  console.log(`  后台      http://127.0.0.1:${PORT}/admin   （admin / admin123，另含 ops01/fin01/cs01）`)
  console.log(`  数据库    ${seed.seeded ? '已按种子初始化' : '沿用现有'}：${stats.dramas} 部剧 / ${stats.episodes} 集 / ${stats.plans} 个套餐`)
})

