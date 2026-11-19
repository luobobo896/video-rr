/**
 * 试看端到端回归（P0-1/P0-2 的服务端边界）：
 * 起一个真进程跑 server/index.mjs，验证 /media/trial/ 只会放出「清单里前 N 秒」的分片，
 * 改 sec、换分片、累加额度都必须被拒。单元测试覆盖不了这段，因为它依赖 HTTP 层与 HLS 目录。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-trial-http-'))
const hlsDir = join(dir, 'hls')
const uploadDir = join(dir, 'uploads')
mkdirSync(hlsDir, { recursive: true })
mkdirSync(uploadDir, { recursive: true })

process.env.MH_DB = join(dir, 'test.db')
process.env.MH_HLS_DIR = hlsDir
process.env.MH_UPLOAD_DIR = uploadDir
process.env.MH_SECRET = 'trial-http-secret-0123456789abcdef'
process.env.MH_OTP_SECRET = 'trial-http-otp-0123456789abcdef'
process.env.MH_LINK_SECRET = 'trial-http-link-0123456789abcdef'

let db
let child
let base
let episodeId
let dramaId

const SEGMENT_SECONDS = 6
const SEGMENT_COUNT = 10

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 访客身份是服务端签发的 Cookie：不带上就会每次都被当成新访客，试看额度永远用不完 */
const jar = new Map()
let trialLink

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

async function get(path) {
  const headers = { 'user-agent': 'trial-http-test' }
  const cookies = cookieHeader()
  if (cookies) headers.cookie = cookies
  const response = await fetch(`${base}${path}`, { headers })
  // 逐条合并：某个响应只回发 mh_link_* 时不能把上一条 mh_visitor 一起丢掉
  for (const item of response.headers.getSetCookie?.() ?? []) {
    const [pair] = item.split(';')
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, text, json, headers: response.headers }
}

async function waitForServer(deadlineMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${base}/api/home`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch { /* 还在启动 */ }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('服务端 15 秒内没有启动')
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dramaId = Number(db.prepare("INSERT INTO dramas (title, category, status) VALUES ('试看端到端剧', 'TV', 'published')").run().lastInsertRowid)
  db.prepare(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, 'paid', 0, 300, 6, 'single', 72)`).run(dramaId)
  episodeId = Number(db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, status, hls_path)
    VALUES (?, 1, '第 1 集', ?, 'ready', ?)`)
    .run(dramaId, SEGMENT_SECONDS * SEGMENT_COUNT, `/media/hls/${dramaId}/index.m3u8`).lastInsertRowid)
  // 清单：10 个 6 秒分片，访客只能拿到前 15 秒（3 个分片）
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', '#EXT-X-MEDIA-SEQUENCE:0']
  for (let i = 1; i <= SEGMENT_COUNT; i += 1) {
    lines.push(`#EXTINF:${SEGMENT_SECONDS}.0,`, `seg_${String(i).padStart(3, '0')}.ts`)
  }
  lines.push('#EXT-X-ENDLIST')
  const episodeDir = join(hlsDir, String(episodeId))
  mkdirSync(episodeDir, { recursive: true })
  writeFileSync(join(episodeDir, 'index.m3u8'), `${lines.join('\n')}\n`)
  for (let i = 1; i <= SEGMENT_COUNT; i += 1) {
    writeFileSync(join(episodeDir, `seg_${String(i).padStart(3, '0')}.ts`), Buffer.alloc(188, i))
  }

  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    if (/level":"error"/.test(text)) process.stderr.write(`[server] ${text}`)
  })
  await waitForServer()
})

after(() => {
  if (child && !child.killed) child.kill('SIGKILL')
  try { db?.close() } catch { /* ignore */ }
})

test('访客试看：签发 /media/trial 链接且只放出窗口内的分片', async () => {
  const play = await get(`/api/play/${dramaId}/1?trial=1`)
  assert.equal(play.status, 200, play.text)
  const link = String(play.json?.data?.hls ?? '')
  trialLink = link
  assert.match(link, new RegExp(`^/media/trial/${episodeId}/index\\.m3u8\\?sign=`), '试看必须走 /media/trial 专用链接')
  const grantSeconds = Number(play.json.data.trialSeconds)
  assert.ok(grantSeconds > 0 && grantSeconds <= 15, `访客单次试看应封顶 15 秒，实际 ${grantSeconds}`)

  const playlist = await get(link)
  assert.equal(playlist.status, 200, playlist.text)
  assert.match(playlist.text, /^#EXTM3U\n/, '#EXTM3U 必须是清单第一行，否则播放器直接判非法')
  assert.match(playlist.text, /#EXT-X-ENDLIST/, '截断后的清单必须以 ENDLIST 收尾')
  // 分片地址会被贴上票据，这里按「行首是 seg_xxx.ts」匹配，忽略后面的 query
  const segments = [...playlist.text.matchAll(/^(seg_\d+\.ts)(\?.*)?$/gm)].map((match) => match[1])
  const expected = Math.ceil(grantSeconds / SEGMENT_SECONDS)
  assert.equal(segments.length, expected, `应只保留前 ${expected} 个分片，实际 ${segments.length}`)
  assert.ok(segments.includes('seg_001.ts'))
  assert.ok(!segments.includes(`seg_${String(SEGMENT_COUNT).padStart(3, '0')}.ts`), '窗口外的分片不能出现在清单里')

  // 清单里的分片地址必须自带票据：播放器解析相对地址会丢页面 query
  const firstLine = playlist.text.split('\n').find((line) => line.startsWith('seg_001.ts')) ?? ''
  assert.match(firstLine, /seg_001\.ts\?.*sign=/, '分片地址需要带上下发的票据')

  const firstSegment = await get(`/media/trial/${episodeId}/${firstLine}`)
  assert.equal(firstSegment.status, 200, '窗口内分片必须可放行')
  assert.equal(firstSegment.text.length, 188)
})

test('试看：改 sec、越界分片、缺票都必须 403', async () => {
  const url = new URL(trialLink, base)
  const params = url.searchParams

  const tampered = new URLSearchParams(params)
  tampered.set('sec', String(Number(params.get('sec')) + 300))
  const bumped = await get(`/media/trial/${episodeId}/index.m3u8?${tampered}`)
  assert.equal(bumped.status, 403, '把 sec 改大等于伪造成更长的试看窗口')

  const beyond = await get(`/media/trial/${episodeId}/seg_${String(SEGMENT_COUNT).padStart(3, '0')}.ts?${params}`)
  assert.equal(beyond.status, 403, '窗口外的分片必须拒绝')

  const noTicket = await get(`/media/trial/${episodeId}/seg_001.ts`)
  assert.equal(noTicket.status, 403, '没有票据不能直接拉分片')

  const otherEpisode = await get(`/media/trial/${episodeId + 1000}/index.m3u8?${params}`)
  assert.equal(otherEpisode.status, 403, '票只能用于签发它的那一集')
})

test('试看额度用尽后返回 402 trial_exhausted，不再签发新链接', async () => {
  const last = await get(`/api/play/${dramaId}/1?trial=1`)
  assert.equal(last.status, 402, last.text)
  assert.equal(last.json?.data?.reason, 'trial_exhausted')
  assert.ok(Number(last.json?.data?.retryAfterSeconds) >= 1, '要给前端一个可重试的秒数')
})
