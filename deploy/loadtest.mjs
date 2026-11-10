/**
 * HLS 并发压测：模拟 N 个播放器持续拉 master/variant playlist + ts 切片。
 * 用法（建议在服务器本机跑，测服务端承载能力；真实带宽要靠外部多机压）：
 *   node deploy/loadtest.mjs --url http://127.0.0.1:8787/video/media/hls/193/index.m3u8 --concurrent 1000 --seconds 30
 */
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, item, index, list) => {
    if (item.startsWith('--')) acc.push([item.slice(2), list[index + 1] ?? 'true'])
    return acc
  }, []),
)

const TARGET = args.url ?? 'http://127.0.0.1:8787/video/media/hls/193/index.m3u8'
const CONCURRENCY = Number(args.concurrent ?? 1000)
const SECONDS = Number(args.seconds ?? 30)
const BASE = TARGET.slice(0, TARGET.lastIndexOf('/') + 1)

import { Agent, request } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'

const isHttps = TARGET.startsWith('https:')
const agent = isHttps
  ? new HttpsAgent({ keepAlive: true, maxSockets: CONCURRENCY + 50, maxFreeSockets: 256 })
  : new Agent({ keepAlive: true, maxSockets: CONCURRENCY + 50, maxFreeSockets: 256 })
const doRequest = isHttps ? httpsRequest : request

const metrics = { requests: 0, bytes: 0, errors: 0, latency: [], statuses: {} }
const deadline = Date.now() + SECONDS * 1000
let active = 0

function get(url) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    const req = doRequest(url, { agent, method: 'GET', headers: { 'user-agent': 'video-rr-loadtest' } }, (res) => {
      let size = 0
      res.on('data', (chunk) => { size += chunk.length })
      res.on('end', () => {
        metrics.requests += 1
        metrics.bytes += size
        metrics.statuses[res.statusCode] = (metrics.statuses[res.statusCode] ?? 0) + 1
        const ms = Number(process.hrtime.bigint() - started) / 1e6
        metrics.latency.push(ms)
        resolve({ ok: res.statusCode < 400, body: size, text: res.statusCode === 200 && url.endsWith('.m3u8') ? undefined : undefined })
      })
    })
    req.on('error', () => { metrics.errors += 1; resolve({ ok: false }) })
    req.setTimeout(15000, () => { req.destroy(); metrics.errors += 1; resolve({ ok: false }) })
    req.end()
  })
}

function parsePlaylist(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

async function viewer(id) {
  // 1) 拉 master，选 480p（带宽小、更接近 1000 并发的真实码率）
  const master = await getRaw(TARGET)
  let variantUrl = TARGET
  const lines = parsePlaylist(master)
  const variant = lines.find((line) => line.includes('480p')) ?? lines[0]
  if (variant) variantUrl = new URL(variant, BASE).toString()

  while (Date.now() < deadline) {
    const playlist = await getRaw(variantUrl)
    const segments = parsePlaylist(playlist)
    const tail = segments.slice(-2)
    for (const segment of tail) {
      if (Date.now() >= deadline) break
      await get(new URL(segment, variantUrl).toString())
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  void id
}

function getRaw(url) {
  return new Promise((resolve) => {
    const req = doRequest(url, { agent, method: 'GET', headers: { 'user-agent': 'video-rr-loadtest' } }, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        metrics.requests += 1
        metrics.statuses[res.statusCode] = (metrics.statuses[res.statusCode] ?? 0) + 1
        if (res.statusCode >= 400) metrics.errors += 1
        resolve(body)
      })
    })
    req.on('error', () => { metrics.errors += 1; resolve('') })
    req.end()
  })
}

console.log(`目标 ${TARGET}\n并发 ${CONCURRENCY} 路，持续 ${SECONDS}s，起点 ${new Date().toLocaleTimeString()}`)
const started = Date.now()
const viewers = Array.from({ length: CONCURRENCY }, (_, index) => viewer(index))
const timer = setInterval(() => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  process.stdout.write(`\r  ${elapsed}s  请求 ${metrics.requests}  ${(metrics.bytes / 1048576).toFixed(0)} MiB  错误 ${metrics.errors}  活跃 ${active}   `)
}, 1000)

await Promise.allSettled(viewers)
clearInterval(timer)
active = 0

metrics.latency.sort((a, b) => a - b)
const pick = (p) => metrics.latency[Math.min(metrics.latency.length - 1, Math.floor(metrics.latency.length * p))] ?? 0
const duration = (Date.now() - started) / 1000
console.log(`\n\n=== 结果 ===`)
console.log(`时长           ${duration.toFixed(1)}s`)
console.log(`请求总数       ${metrics.requests}（${(metrics.requests / duration).toFixed(0)} req/s）`)
console.log(`流量           ${(metrics.bytes / 1048576).toFixed(1)} MiB（${(metrics.bytes * 8 / duration / 1e6).toFixed(1)} Mbps）`)
console.log(`错误           ${metrics.errors}`)
console.log(`状态分布       ${JSON.stringify(metrics.statuses)}`)
console.log(`延迟 p50/p95   ${pick(0.5).toFixed(1)} / ${pick(0.95).toFixed(1)} ms`)
console.log(`\n提示：本测试跑在服务器本机（loopback），测的是 nginx/磁盘 的并发与吞吐；`)
console.log(`真实公网 1000 人还需算出口带宽：480p ≈ 0.85 Mbps/人 → 850 Mbps；720p ≈ 2.4 Mbps/人 → 2.4 Gbps。`)
process.exit(0)
