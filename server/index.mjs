/**
 * 影巢服务端入口：
 *   /            C 端（public/）
 *   /admin      后台（admin/）
 *   /api/*      C 端接口
 *   /admin/api/*后台接口（需 admin token）
 *   /media/hls/*HLS 切片（支持 Range）
 *   /live/*     反代 MediaMTX 的 HLS（直播）
 */
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, seedIfEmpty, ROOT } from './db.mjs'
import { handlePublic } from './api-public.mjs'
import { handleAdmin } from './api-admin.mjs'
import { HLS_DIR, UPLOAD_DIR } from './media.mjs'

mkdirSync(UPLOAD_DIR, { recursive: true })
mkdirSync(HLS_DIR, { recursive: true })

const seed = seedIfEmpty()
const PORT = Number(process.env.PORT ?? 8787)
const PUBLIC = join(ROOT, 'public')
const ADMIN = join(ROOT, 'admin')
const LIVE_HLS = `http://127.0.0.1:${process.env.MH_HLS_PORT ?? 8888}`

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) reject(new Error('body too large'))
    })
    req.on('end', () => resolvePromise(data))
    req.on('error', reject)
  })
}

/** 大文件上传：直接落地到 storage/uploads，返回临时路径。 */
function streamToUpload(req) {
  const temp = join(UPLOAD_DIR, `upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.part`)
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => { chunks.push(chunk); size += chunk.length })
    req.on('end', () => {
      try { writeFileSync(temp, Buffer.concat(chunks)); resolvePromise({ path: temp, size }) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

function serveFileWithRange(req, res, filePath) {
  const stat = statSync(filePath)
  const type = MIME[extname(filePath)] ?? 'application/octet-stream'
  const range = req.headers.range
  if (!range) {
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' })
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
  res.writeHead(200, { 'content-type': MIME[extname(safe)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(safe).pipe(res)
}

async function proxyLive(req, res, pathname) {
  const target = `${LIVE_HLS}${pathname}`
  try {
    const upstream = await fetch(target, { headers: { range: req.headers.range ?? '' } })
    const headers = {}
    for (const key of ['content-type', 'content-length', 'accept-ranges', 'content-range']) {
      const value = upstream.headers.get(key)
      if (value) headers[key] = value
    }
    res.writeHead(upstream.status, headers)
    const buffer = Buffer.from(await upstream.arrayBuffer())
    res.end(buffer)
  } catch (error) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`直播未启动或 MediaMTX 未运行：${String(error?.message ?? error)}`)
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname

  try {
    if (pathname.startsWith('/live/')) return await proxyLive(req, res, pathname)

    if (pathname.startsWith('/media/hls/')) {
      const filePath = join(HLS_DIR, pathname.replace('/media/hls/', ''))
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath)
    }

    if (pathname === '/media/uploads' || pathname.startsWith('/media/uploads/')) {
      const filePath = join(UPLOAD_DIR, pathname.replace('/media/uploads/', ''))
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath)
    }

    if (pathname.startsWith('/media/images/')) {
      const filePath = join(ROOT, 'storage', 'images', pathname.replace('/media/images/', ''))
      if (!existsSync(filePath)) { res.writeHead(404); res.end('404'); return }
      return serveFileWithRange(req, res, filePath)
    }

    if (pathname.startsWith('/admin/api/')) {
      const uploadMatch = /^\/admin\/api\/episodes\/(\d+)\/upload$/.exec(pathname)
      if (uploadMatch && req.method === 'POST') {
        const uploaded = await streamToUpload(req)
        return await handleAdmin(pathname, url, req, res, '', { uploadPath: uploaded.path, size: uploaded.size })
      }
      const raw = await readBody(req)
      return await handleAdmin(pathname, url, req, res, raw)
    }

    if (pathname.startsWith('/api/')) {
      const raw = await readBody(req)
      const handled = handlePublic(pathname, url, req, res, raw)
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: '0404', msg: `未知接口 ${pathname}`, data: {} }))
      }
      return
    }

    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      return serveStatic(ADMIN, pathname.replace(/^\/admin\/?/, '') || 'index.html', res)
    }

    return serveStatic(PUBLIC, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''), res)
  } catch (error) {
    console.error('[mh-clone]', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ code: '0500', msg: String(error?.message ?? error), data: {} }))
    } else {
      try { res.end() } catch { /* ignore */ }
    }
  }
})

server.listen(PORT, '127.0.0.1', () => {
  const stats = {
    dramas: db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n,
    episodes: db.prepare('SELECT COUNT(*) AS n FROM episodes').get().n,
  }
  console.log(`影巢已启动`)
  console.log(`  C 端      http://127.0.0.1:${PORT}/`)
  console.log(`  后台      http://127.0.0.1:${PORT}/admin   （admin / admin123）`)
  console.log(`  数据库    ${seed.seeded ? '已按种子初始化' : '沿用现有'}：${stats.dramas} 部剧 / ${stats.episodes} 集`)
})
