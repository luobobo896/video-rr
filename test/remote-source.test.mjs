/**
 * 外部片源网关：清单重写、分片转发、伪装头与冷缓存。
 * 上游用本机 mock 服务模拟「必须带 Referer 才给流」的站点。
 */
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cacheDir = mkdtempSync(join(tmpdir(), 'mh-remote-'))
process.env.MH_REMOTE_CACHE = cacheDir
// 网关默认拒绝回源到内网（SSRF 防护）；本用例的上游就是本机 mock 服务，显式打开逃生阀
process.env.MH_REMOTE_ALLOW_PRIVATE = '1'
const { handleRemoteRequest, remoteSourceOf, rewritePlaylist, remotePlaybackPath } = await import('../server/stream-proxy.mjs')

let origin = ''
let hits = 0
let keyHits = 0
let warmHits = 0
let upstream
let gateway

before(async () => {
  upstream = createServer((req, res) => {
    hits += 1
    const referer = String(req.headers.referer ?? '')
    if (!referer.startsWith(origin)) {
      res.writeHead(403, { 'content-type': 'text/plain' })
      res.end('hotlink denied')
      return
    }
    if (req.url === '/play.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
          '#EXTINF:4.000,',
          'seg0.ts',
          '#EXTINF:4.000,',
          '/inner/seg1.ts?token=abc',
          '#EXT-X-ENDLIST',
          '',
        ].join('\n'),
      )
      return
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><script>window.player={file:"/play.m3u8"}</script></html>')
      return
    }
    if (req.url === '/key.bin') {
      keyHits += 1
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end('KEYMATERIAL')
      return
    }
    if (req.url === '/seg0.ts' || req.url === '/inner/seg1.ts?token=abc') {
      const range = req.headers.range
      if (range === 'bytes=0-2') {
        res.writeHead(206, { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-2/10' })
        res.end('TSD')
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end('TSDATA-142')
      return
    }
    if (req.url === '/movie.mp4') {
      const range = req.headers.range
      if (range) {
        const [from] = /bytes=(\d+)-/.exec(String(range))?.slice(1) ?? ['0']
        const body = 'FULLMP4'
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': `bytes ${from}-${Number(from) + 3}/8`,
          'content-length': '4',
        })
        res.end(body.slice(0, 4))
        return
      }
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '7' })
      res.end('FULLMP4')
      return
    }
    if (req.url === '/warm.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
      res.end(
        [
          '#EXTM3U',
          '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:4',
          '#EXTINF:4.000,',
          '/warm/a.ts',
          '#EXTINF:4.000,',
          '/warm/b.ts',
          '#EXTINF:4.000,',
          '/warm/c.ts',
          '#EXT-X-ENDLIST',
          '',
        ].join('\n'),
      )
      return
    }
    if (req.url.startsWith('/warm/')) {
      warmHits += 1
      res.writeHead(200, { 'content-type': 'video/mp2t' })
      res.end('WARMSEG')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${upstream.address().port}`

  gateway = createServer(async (req, res) => {
    const match = /^\/media\/remote\/(\d+)\/(.*)$/.exec(req.url ?? '')
    if (!match) {
      res.writeHead(404)
      res.end()
      return
    }
    const remoteUrl = req.headers['x-test-source'] ?? `${origin}/play.m3u8`
    const referer = req.headers['x-test-referer'] ?? `${origin}/`
    await handleRemoteRequest(req, res, {
      episodeId: Number(match[1]),
      episode: { id: Number(match[1]), remote_url: remoteUrl, remote_referer: referer },
      rest: match[2],
    })
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
})

after(() => {
  upstream?.close()
  gateway?.close()
  rmSync(cacheDir, { recursive: true, force: true })
})

const base = () => `http://127.0.0.1:${gateway.address().port}`

test('清单里每一条 URI 都被重写成本站 seg 路径', async () => {
  const res = await fetch(`${base()}/media/remote/1/index.m3u8`)
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /#EXTM3U/)
  assert.doesNotMatch(text, /seg0\.ts/)
  assert.doesNotMatch(text, /\/inner\/seg1/)
  assert.match(text, /URI="seg\/[0-9a-f]{20}\.(bin|key)"/)
  assert.match(text, /seg\/[0-9a-f]{20}\.ts/)
})

test('分片转发原样返回，且第二次命中冷缓存不再打上游', async () => {
  const playlist = await (await fetch(`${base()}/media/remote/2/index.m3u8`)).text()
  const tsName = playlist.split('\n').find((line) => line.startsWith('seg/') && line.endsWith('.ts'))
  const segUrl = `${base()}/media/remote/2/${tsName}`

  const first = await fetch(segUrl)
  assert.equal(first.status, 200)
  assert.equal(await first.text(), 'TSDATA-142')

  const before = hits
  const second = await fetch(segUrl)
  assert.equal(await second.text(), 'TSDATA-142')
  assert.equal(hits, before, '缓存命中后不应再请求上游')
})

test('Range 请求透传 206 与 content-range', async () => {
  const playlist = await (await fetch(`${base()}/media/remote/3/index.m3u8`)).text()
  const tsName = playlist.split('\n').find((line) => line.startsWith('seg/') && line.endsWith('.ts'))
  const res = await fetch(`${base()}/media/remote/3/${tsName}`, { headers: { range: 'bytes=0-2' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), 'bytes 0-2/10')
  assert.equal(await res.text(), 'TSD')
})

test('播放页自动抽出 m3u8', async () => {
  const res = await fetch(`${base()}/media/remote/4/index.m3u8`, { headers: { 'x-test-source': `${origin}/page` } })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /seg\/[0-9a-f]{20}\.ts/)
})

test('上游 403（直链签名过期）时网关报 503 + Retry-After，不把 HTML 当清单吐给播放器', async () => {
  const direct = remoteSourceOf({ remote_url: `${origin}/play.m3u8`, remote_referer: 'https://blocked.example/' })
  assert.equal(direct.referer, 'https://blocked.example/')
  const res = await fetch(`${base()}/media/remote/5/index.m3u8`, {
    headers: { 'x-test-source': `${origin}/play.m3u8`, 'x-test-referer': 'https://blocked.example/' },
  })
  // 票过期是临时状态：503 让播放器按 Retry-After 重试，而不是当成"片源坏了"
  assert.equal(res.status, 503)
  assert.equal(res.headers.get('retry-after'), '30')
  assert.match(await res.text(), /片源签名已过期/)
})

test('playbackPath 只对外部源生效，本地 HLS 不受影响', () => {
  assert.equal(remotePlaybackPath({ id: 9, remote_url: 'https://x.example/a.m3u8' }), '/media/remote/9/index.m3u8')
  assert.equal(remotePlaybackPath({ id: 9, hls_path: '/media/hls/9/index.m3u8' }), null)
})

test('直链文件源给 file.<ext> 入口，仍走同一套签名路径', () => {
  assert.equal(remotePlaybackPath({ id: 11, remote_url: 'https://x.example/movie.mp4' }), '/media/remote/11/file.mp4')
  assert.equal(remotePlaybackPath({ id: 11, remote_url: 'https://x.example/movie.MP4?x=1' }), '/media/remote/11/file.mp4')
  assert.equal(remotePlaybackPath({ id: 11, remote_url: 'https://x.example/clip.webm' }), '/media/remote/11/file.webm')
})

test('直链文件源整文件转发，Range 透传 206 与 content-range', async () => {
  const source = `${origin}/movie.mp4`
  const full = await fetch(`${base()}/media/remote/11/file.mp4`, { headers: { 'x-test-source': source } })
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'video/mp4')
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.equal(await full.text(), 'FULLMP4')

  const partial = await fetch(`${base()}/media/remote/11/file.mp4`, {
    headers: { 'x-test-source': source, range: 'bytes=0-3' },
  })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get('content-range'), 'bytes 0-3/8')
  assert.equal(await partial.text(), 'FULL')
})

test('rewritePlaylist 对相对 URI 按清单所在目录解析', () => {
  const session = { segments: new Map() }
  const out = rewritePlaylist('#EXTM3U\nsub/a.ts\n', 'https://cdn.example/hls/main.m3u8', session)
  assert.match(out, /^seg\/[0-9a-f]{20}\.ts$/m)
  const entry = [...session.segments.values()][0]
  assert.equal(entry.url, 'https://cdn.example/hls/sub/a.ts')
})

test('AES key 命中内存缓存，第二次取 key 不再回源', async () => {
  const playlist = await (await fetch(`${base()}/media/remote/6/index.m3u8`)).text()
  const keyName = /URI="(seg\/[^"]+)"/.exec(playlist)?.[1]
  assert.ok(keyName, '清单里应重写出 KEY 的 URI')

  const keyUrl = `${base()}/media/remote/6/${keyName}`
  const first = await fetch(keyUrl)
  assert.equal(first.status, 200)
  assert.equal(await first.text(), 'KEYMATERIAL')

  const before = keyHits
  const second = await fetch(keyUrl)
  assert.equal(await second.text(), 'KEYMATERIAL')
  assert.equal(keyHits, before, 'key 命中内存缓存后不应再请求上游')
})

test('清单返回后自动预热开头分片到磁盘缓存', async () => {
  const before = warmHits
  const res = await fetch(`${base()}/media/remote/7/index.m3u8`, {
    headers: { 'x-test-source': `${origin}/warm.m3u8` },
  })
  assert.equal(res.status, 200)
  await res.text()

  for (let i = 0; i < 60 && warmHits === before; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(warmHits > before, '清单返回后应后台预热分片，供首个播放请求直接命中缓存')

  // 等预取队列排空，避免测试结束后上游已关闭
  await new Promise((resolve) => setTimeout(resolve, 300))
})
