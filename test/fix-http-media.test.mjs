import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 全部落在 mkdtemp 下：绝不碰真实 storage/ 与数据库
const root = mkdtempSync(join(tmpdir(), 'mh-fix-http-media-'))
process.env.MH_DB = join(root, 'app.db')
process.env.MH_SECRET = 'fix-http-media'
process.env.MH_REMOTE_CACHE = join(root, 'cache')
// 本文件的上游就是本机 mock 服务；SSRF 用例会显式关掉这个逃生阀
process.env.MH_REMOTE_ALLOW_PRIVATE = '1'

const proxy = await import('../server/stream-proxy.mjs')
const trial = await import('../server/trial-playlist.mjs')

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

const SEG = 'A'.repeat(512)

/** 假上游：唯一目的就是喂网关，不打外网 */
const hits = new Map()
let truncateArmed = true
const secretHits = { count: 0 }

const secretServer = createServer((req, res) => {
  secretHits.count += 1
  res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' })
  res.end('#EXTM3U\n#EXTINF:4,\nsecret.ts\n')
})
const secretPort = await listen(secretServer)

const M3U8 = { 'content-type': 'application/vnd.apple.mpegurl' }

const upstreamServer = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  hits.set(path, (hits.get(path) ?? 0) + 1)
  if (path === '/master.m3u8') {
    res.writeHead(200, M3U8)
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="zh",DEFAULT=YES,URI="v/audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"',
        'v/360.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="aud"',
        'v/720.m3u8',
        '',
      ].join('\n'),
    )
    return
  }
  if (/^\/v\/(720|360|audio)\.m3u8$/.test(path)) {
    res.writeHead(200, M3U8)
    res.end(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="/keys/k1.bin"',
        '#EXTINF:4.0,',
        's0.ts',
        '#EXTINF:4.0,',
        's1.ts',
        '#EXT-X-ENDLIST',
        '',
      ].join('\n'),
    )
    return
  }
  if (path === '/single.m3u8') {
    res.writeHead(200, M3U8)
    res.end(['#EXTM3U', '#EXTINF:4.0,', 's/0.ts', '#EXTINF:4.0,', 's/1.ts', '#EXT-X-ENDLIST', ''].join('\n'))
    return
  }
  if (path === '/gone.m3u8') {
    res.writeHead(200, M3U8)
    res.end(['#EXTM3U', '#EXTINF:4.0,', 'gone0.ts', '#EXT-X-ENDLIST', ''].join('\n'))
    return
  }
  if (path === '/trunc.m3u8') {
    res.writeHead(200, M3U8)
    res.end(['#EXTM3U', '#EXTINF:4.0,', 'trunc.ts', '#EXT-X-ENDLIST', ''].join('\n'))
    return
  }
  if (path === '/redirect.m3u8') {
    res.writeHead(302, { location: `http://127.0.0.1:${secretPort}/secret.m3u8` })
    res.end()
    return
  }
  if (path === '/trunc.ts' && truncateArmed) {
    // 声明 1000 字节、只发 10 字节就断开：正是 P0-4 里让网关崩进程的形态
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': '1000' })
    res.write('0123456789')
    res.socket?.destroy()
    return
  }
  if (path === '/trunc.ts' || path === '/s/0.ts' || path === '/s/1.ts' || /^\/v\/s\d\.ts$/.test(path)) {
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(SEG.length) })
    res.end(SEG)
    return
  }
  if (path === '/keys/k1.bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(Buffer.alloc(16, 7))
    return
  }
  res.writeHead(404)
  res.end()
})
const upstreamPort = await listen(upstreamServer)
const upstreamBase = `http://127.0.0.1:${upstreamPort}`

const SOURCES = new Map([
  [201, '/master.m3u8'],
  [202, '/single.m3u8'],
  [203, '/trunc.m3u8'],
  [204, '/redirect.m3u8'],
  [205, '/single.m3u8'],
  [206, '/gone.m3u8'],
])

const episodeOf = (id) => ({ id, remote_url: `${upstreamBase}${SOURCES.get(id)}`, remote_referer: `${upstreamBase}/` })

const gatewayServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const m = /^\/media\/remote\/(\d+)\/(.*)$/.exec(url.pathname)
  if (!m) {
    res.writeHead(404)
    res.end()
    return
  }
  const episodeId = Number(m[1])
  proxy
    .handleRemoteRequest(req, res, { episodeId, episode: episodeOf(episodeId), rest: decodeURIComponent(m[2]) })
    .catch(() => {
      try { res.destroy() } catch { /* 已经断了 */ }
    })
})
const gatewayPort = await listen(gatewayServer)
const mediaBase = `http://127.0.0.1:${gatewayPort}/media/remote`

const m3u8Names = (body) =>
  body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^seg\//, ''))

test('Range 后缀 bytes=-N 取最后 N 字节，而不是前 N 字节', () => {
  assert.deepEqual(proxy.parseRangeHeader('bytes=-100', 1000), { start: 900, end: 999 })
})

test('Range 起点越界判为 unsatisfiable，由调用方回 416 + bytes */size', () => {
  assert.equal(proxy.parseRangeHeader('bytes=1000-', 1000), 'unsatisfiable')
  assert.equal(proxy.parseRangeHeader('bytes=5000-6000', 1000), 'unsatisfiable')
})

test('Range 终点越界截断到 size-1，不再写出超出文件的 content-length', () => {
  assert.deepEqual(proxy.parseRangeHeader('bytes=0-99999', 1000), { start: 0, end: 999 })
})

test('Range start>end 判为 unsatisfiable，不会算出负长度', () => {
  assert.equal(proxy.parseRangeHeader('bytes=900-100', 1000), 'unsatisfiable')
})

test('Range 多段只服务第一段，非法头按全长处理', () => {
  assert.deepEqual(proxy.parseRangeHeader('bytes=0-9,20-29', 1000), { start: 0, end: 9 })
  assert.equal(proxy.parseRangeHeader('', 1000), null)
  assert.equal(proxy.parseRangeHeader('items=0-9', 1000), null)
})

test('SSRF：loopback、私网、链路本地、元数据与十进制/十六进制变形一律拒绝', async () => {
  for (const url of [
    'http://127.0.0.1:8787/x.m3u8',
    'http://localhost/x.m3u8',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/x.m3u8',
    'http://192.168.1.9/x.m3u8',
    'http://172.16.5.5/x.m3u8',
    'http://0.0.0.0/x.m3u8',
    'http://[::1]/x.m3u8',
    'http://[fd00::1]/x.m3u8',
    'http://[fe80::1]/x.m3u8',
    'http://[::ffff:127.0.0.1]/x.m3u8',
    'http://2130706433/x.m3u8',
    'http://0x7f000001/x.m3u8',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(proxy.assertPublicUrl(url, { allowPrivate: false }), /拒绝|不支持/, url)
  }
})

test('SSRF：公网地址放行，172.16/172.32 边界不误伤', async () => {
  for (const url of ['http://8.8.8.8/x.m3u8', 'http://172.15.0.1/x.m3u8', 'http://172.32.0.1/x.m3u8']) {
    await proxy.assertPublicUrl(url, { allowPrivate: false })
  }
})

test('SSRF：上游 302 到内网不跟随，内网接口一次都没被打到', async () => {
  const before = secretHits.count
  const res = await fetch(`${mediaBase}/204/index.m3u8`)
  assert.equal(res.status, 502)
  assert.match(await res.text(), /拒绝/)
  assert.equal(secretHits.count, before, '内网 secret 接口不能被访问到')
})

test('缓存名去掉签名参数：换票后同一分片仍是同一个名字', () => {
  const a = proxy.canonicalCacheUrl('https://cdn.example/hls/TOK1/1794769762/63000/1.ts?exp=1794769762&token=aaa')
  const b = proxy.canonicalCacheUrl('https://cdn.example/hls/TOK2/1794799999/63000/1.ts?exp=1794799999&token=bbb')
  assert.equal(a, b)
  const first = proxy.rewritePlaylist('#EXTM3U\n#EXTINF:4,\n/seg/1.ts?exp=1&signature=x\n', 'https://cdn.example/a.m3u8', { segments: new Map() })
  const second = proxy.rewritePlaylist('#EXTM3U\n#EXTINF:4,\n/seg/1.ts?exp=2&signature=y\n', 'https://cdn.example/a.m3u8', { segments: new Map() })
  assert.equal(first, second)
})

test('变体清单：master → variant → 分片 全链路可播，子分片带目录前缀', async () => {
  const master = await (await fetch(`${mediaBase}/201/index.m3u8`)).text()
  const bare = m3u8Names(master)
  const media2 = /URI="seg\/([0-9a-f]{20}\.m3u8)"/.exec(master)?.[1]
  assert.equal(bare.length, 2, '两条码率变体')
  assert.ok(media2, 'EXT-X-MEDIA 的 URI 也要改写成子清单')
  const variants = [...bare, media2]
  for (const name of variants) assert.match(name, /^[0-9a-f]{20}\.m3u8$/)

  let played = false
  for (const name of variants) {
    const body = await (await fetch(`${mediaBase}/201/seg/${name}`)).text()
    assert.ok(body.includes('#EXTM3U'))
    // EXT-X-MEDIA / EXT-X-KEY 的 URI 也要按清单/密钥改写，且带上本变体前缀
    assert.match(body, new RegExp(`URI="seg/${name.replace(/\./g, '\\.')}/[0-9a-f]{20}\\.(key|mp4|bin)"`))
    const children = m3u8Names(body)
    assert.ok(children.length >= 2)
    for (const child of children) assert.ok(child.startsWith(`${name}/`), `${child} 应以 ${name}/ 开头`)
    const seg = await fetch(`${mediaBase}/201/seg/${children[0]}`)
    assert.equal(seg.status, 200)
    assert.equal((await seg.text()).length, SEG.length)
    played = true
  }
  assert.ok(played)
})

test('上游声明长度只发一半就断开：网关不崩、也不把半截当缓存', async () => {
  const list = await (await fetch(`${mediaBase}/203/index.m3u8`)).text()
  const name = m3u8Names(list)[0]
  await fetch(`${mediaBase}/203/seg/${name}`).then(
    (res) => res.text().catch(() => ''),
    () => '',
  )
  // 半截不能落盘成缓存：修好上游后重取必须是 200 且长度完整
  truncateArmed = false
  const ok = await fetch(`${mediaBase}/203/seg/${name}`)
  assert.equal(ok.status, 200)
  assert.equal((await ok.text()).length, SEG.length)
})

test('上游 404 与「签名过期」区分开：回 404 记 gone，不再反复换票', async () => {
  const list = await (await fetch(`${mediaBase}/206/index.m3u8`)).text()
  const name = m3u8Names(list)[0]
  const res = await fetch(`${mediaBase}/206/seg/${name}`)
  assert.equal(res.status, 404)
  assert.match(await res.text(), /上游已下架/)
  // 结论有短 TTL 缓存：第二次不再回源
  const before = hits.get('/gone0.ts') ?? 0
  await fetch(`${mediaBase}/206/seg/${name}`)
  assert.equal(hits.get('/gone0.ts') ?? 0, before, 'gone 结论命中缓存，不再打上游')
})

test('Range 后缀透传到缓存分片：bytes=-N 回最后的 N 字节', async () => {
  const list = await (await fetch(`${mediaBase}/205/index.m3u8`)).text()
  const name = m3u8Names(list)[0]
  await fetch(`${mediaBase}/205/seg/${name}`)
  const res = await fetch(`${mediaBase}/205/seg/${name}`, { headers: { range: 'bytes=-8' } })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes ${SEG.length - 8}-${SEG.length - 1}/${SEG.length}`)
  assert.equal((await res.text()).length, 8)
})

test('读文件失败（文件消失）只断当前连接，不炸进程', async () => {
  const crashServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t' })
    proxy.pipeFile(res, join(root, 'gone.ts'))
  })
  const port = await listen(crashServer)
  await fetch(`http://127.0.0.1:${port}/x.ts`).then(
    (res) => res.text().catch(() => ''),
    () => '',
  )
  const alive = await fetch(`${mediaBase}/202/index.m3u8`)
  assert.equal(alive.status, 200)
  crashServer.close()
})

test('试看清单按秒截断：只留前 N 秒分片，KEY 与 ENDLIST 保持完整', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-KEY:METHOD=AES-128,URI="k.key"',
    '#EXTINF:4.0,',
    'a0.ts',
    '#EXTINF:4.0,',
    'a1.ts',
    '#EXTINF:4.0,',
    'a2.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')
  const cut = trial.truncatePlaylist(media, { seconds: 8 })
  assert.equal([...cut.allowed].join(','), 'a0.ts,a1.ts')
  assert.equal(cut.text.match(/#EXTINF/g).length, 2, '不能留下没有 URI 的 EXTINF')
  assert.ok(cut.text.includes('#EXT-X-KEY:METHOD=AES-128,URI="k.key"'))
  assert.ok(cut.text.trimEnd().endsWith('#EXT-X-ENDLIST'))
  assert.ok(!cut.text.includes('a2.ts'))
})

test('试看预算为 0 时不给任何分片，但清单头与收尾仍然合法', () => {
  const media = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXTINF:4.0,', 'a0.ts', '#EXT-X-ENDLIST', ''].join('\n')
  const cut = trial.truncatePlaylist(media, { seconds: 0 })
  assert.equal(cut.allowed.size, 0)
  assert.ok(cut.text.includes('#EXT-X-TARGETDURATION:4'))
  assert.ok(!cut.text.includes('a0.ts'))
  assert.ok(cut.text.includes('#EXT-X-ENDLIST'))
})

test('主清单不按秒截断：变体 URI 全部保留，供播放器自行选码率', () => {
  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000', 'v/360.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2400000', 'v/720.m3u8', ''].join('\n')
  const cut = trial.truncatePlaylist(master, { seconds: 5 })
  assert.deepEqual([...cut.allowed], ['v/360.m3u8', 'v/720.m3u8'])
  assert.ok(cut.text.includes('v/720.m3u8'))
})

test('远端清单带 sec= 时同样截断，超预算分片请求回 403', async () => {
  const full = await (await fetch(`${mediaBase}/202/index.m3u8`)).text()
  const all = m3u8Names(full)
  assert.equal(all.length, 2)
  const limited = await (await fetch(`${mediaBase}/202/index.m3u8?sec=4`)).text()
  const kept = m3u8Names(limited)
  assert.equal(kept.length, 1, '4 秒只给第一段')
  const inside = await fetch(`${mediaBase}/202/seg/${kept[0]}`)
  assert.equal(inside.status, 200)
  assert.equal((await inside.text()).length, SEG.length)
  const outside = await fetch(`${mediaBase}/202/seg/${all[1]}`)
  assert.equal(outside.status, 403, '试看窗口外的分片必须 403，不能靠前端自觉')
})

test('expiryOf 只有一份实现：jable-refresh 直接复用 jable.mjs 的', async () => {
  const jable = await import('../server/jable.mjs')
  const refresh = await import('../server/jable-refresh.mjs')
  assert.equal(refresh.expiryOf, jable.expiryOf)
  assert.equal(jable.expiryOf('https://cdn-a.mushroomtrack.com/hls/T/179476976212/63000/63332/63332.m3u8'), 179476976212)
  assert.equal(jable.expiryOf('https://x/y/z.m3u8'), 0)
})

test('geoip 默认不外发：未设 MH_GEOIP 时不解析公网 IP、也不发请求', async () => {
  const geoip = await import('../server/geoip.mjs')
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('测试里不允许外发')
  }
  try {
    delete process.env.MH_GEOIP
    const empty = geoip.resolveRegions(['8.8.8.8'])
    assert.equal(empty.get?.('8.8.8.8') ?? '', '')
    process.env.MH_GEOIP = '1'
    process.env.MH_GEOIP_URL = 'http://insecure.example/batch'
    const insecure = geoip.resolveRegions(['8.8.8.8'])
    assert.equal(insecure.get?.('8.8.8.8') ?? '', '', '非 https 端点一律不外发')
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.MH_GEOIP
    delete process.env.MH_GEOIP_URL
  }
})

test('geoip 日志里的 IP 打码：v4 只留前两段，v6 只留前两组', async () => {
  const geoip = await import('../server/geoip.mjs')
  assert.equal(geoip.maskIp('141.147.83.73'), '141.147.x.x')
  assert.equal(geoip.maskIp('127.0.0.1'), '127.0.x.x')
  const masked = geoip.maskIp('2001:4860:4860::8888')
  assert.ok(!masked.includes('::8888'), masked)
  assert.ok(masked.startsWith('2001:4860'), masked)
})

test('huangguo 图片密钥可由 MH_HUANGGUO_IMG_KEY 提供，不再只能写死在源码里', async () => {
  process.env.MH_HUANGGUO_IMG_KEY = '0011223344556677'
  try {
    const hg = await import(`../server/huangguo.mjs?key=${Date.now()}`)
    assert.equal(hg.HG_IMAGE_KEY, '0011223344556677')
  } finally {
    delete process.env.MH_HUANGGUO_IMG_KEY
  }
})

test('archive 只收文档列出的视频格式：ogm 收、mpeg/mpg 与 _meta 伴生文件排除', async () => {
  const archive = await import('../server/archive.mjs')
  const video = (name, format = 'h.264') => ({ name, format, size: 9_000_000, length: '3600' })
  const picked = archive.pickVideoFiles([
    video('reel.ogm', 'Ogg Video'),
    video('movie.mpeg', 'MPEG2'),
    video('movie.mpg', 'MPEG1'),
    video('movie_meta.mp4'),
    video('movie.mp4'),
  ])
  assert.deepEqual(picked.map((file) => file.name).sort(), ['movie.mp4', 'reel.ogm'])
})

test('archive 发行年不再取最小值：标题年份优先，其次 metadata.date', async () => {
  const archive = await import('../server/archive.mjs')
  assert.equal(archive.releaseYearOf({ title: 'Some Movie', metadata: { date: '2020-01-01', year: '1998' } }), 2020)
  assert.equal(archive.releaseYearOf({ title: 'My Man Godfrey (1936)', metadata: { date: '2005-01-01', year: '2010' } }), 1936)
})

test('缓存清扫：过期文件按 TTL 删除，容量超限按 LRU 删最旧', () => {
  const cacheDir = process.env.MH_REMOTE_CACHE
  mkdirSync(join(cacheDir, 'ab'), { recursive: true })
  const oldFile = join(cacheDir, 'ab', 'old.ts')
  const newFile = join(cacheDir, 'ab', 'new.ts')
  writeFileSync(oldFile, Buffer.alloc(2048, 1))
  writeFileSync(newFile, Buffer.alloc(2048, 2))
  const past = new Date(Date.now() - 60 * 60 * 1000)
  utimesSync(oldFile, past, past)

  process.env.MH_REMOTE_CACHE_TTL = '1000'
  proxy.sweepRemoteCache({ force: true })
  assert.equal(existsSync(oldFile), false, '超过 TTL 的文件要删掉')
  assert.equal(existsSync(newFile), true)

  process.env.MH_REMOTE_CACHE_MAX_MB = '0'
  proxy.sweepRemoteCache({ force: true })
  assert.equal(readdirSync(join(cacheDir, 'ab')).length, 0, '容量超限时连新鲜文件也要淘汰')
  delete process.env.MH_REMOTE_CACHE_TTL
  delete process.env.MH_REMOTE_CACHE_MAX_MB
})

test.after(() => {
  gatewayServer.close()
  upstreamServer.close()
  secretServer.close()
})
