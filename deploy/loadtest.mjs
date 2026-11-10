/**
 * HLS 并发压测：模拟 N 个播放器持续拉 playlist + ts 切片。
 * 用法（在服务器本机跑，测服务端承载）：
 *   node deploy/loadtest.mjs --url https://127.0.0.1/video/media/hls/1/index.m3u8 \
 *        --host hk.hsddns.com --insecure --concurrent 1000 --seconds 30
 */
import { Agent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'

const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const key = argv[i].slice(2)
  const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true'
  args[key] = value
  if (value !== 'true') i++
}

const TARGET = args.url ?? 'http://127.0.0.1:8787/media/hls/1/index.m3u8'
const CONCURRENCY = Number(args.concurrent ?? 1000)
const SECONDS = Number(args.seconds ?? 30)
const HOST = args.host
const INSECURE = args.insecure === 'true'
const BASE = TARGET.slice(0, TARGET.lastIndexOf('/') + 1)

const headers = { 'user-agent': 'video-rr-loadtest', connection: 'keep-alive' }
if (HOST) headers.host = HOST

const isHttps = TARGET.startsWith('https:')
const agent = isHttps
  ? new HttpsAgent({ keepAlive: true, maxSockets: CONCURRENCY + 100, maxFreeSockets: 512 })
  : new Agent({ keepAlive: true, maxSockets: CONCURRENCY + 100, maxFreeSockets: 512 })
const doRequest = isHttps ? httpsRequest : httpRequest
const tlsOptions = INSECURE ? { rejectUnauthorized: false } : {}

const metrics = { requests: 0, bytes: 0, errors: 0, latency: [], statuses: {}, active: 0, peak: 0, samples: [] }
const deadline = Date.now() + SECONDS * 1000

function fetchText(url) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    metrics.active += 1
    metrics.peak = Math.max(metrics.peak, metrics.active)
    const req = doRequest(url, { agent, method: 'GET', headers, ...tlsOptions }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => {
        metrics.active -= 1
        metrics.requests += 1
        metrics.statuses[res.statusCode] = (metrics.statuses[res.statusCode] ?? 0) + 1
        metrics.bytes += Buffer.byteLength(body)
        metrics.latency.push(Number(process.hrtime.bigint() - started) / 1e6)
        if (res.statusCode >= 400) metrics.errors += 1
        resolve(body)
      })
    })
    req.on('error', (error) => { metrics.active -= 1; metrics.errors += 1; if (metrics.samples.length < 5) metrics.samples.push(String(error.code) + ': ' + String(error.message).slice(0, 90)); resolve('') })
    req.setTimeout(20000, () => { req.destroy(); metrics.errors += 1; resolve('') })
    req.end()
  })
}

function fetchBinary(url) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint()
    metrics.active += 1
    metrics.peak = Math.max(metrics.peak, metrics.active)
    const req = doRequest(url, { agent, method: 'GET', headers, ...tlsOptions }, (res) => {
      let size = 0
      res.on('data', (chunk) => { size += chunk.length })
      res.on('end', () => {
        metrics.active -= 1
        metrics.requests += 1
        metrics.bytes += size
        metrics.statuses[res.statusCode] = (metrics.statuses[res.statusCode] ?? 0) + 1
        metrics.latency.push(Number(process.hrtime.bigint() - started) / 1e6)
        if (res.statusCode >= 400) metrics.errors += 1
        resolve(size)
      })
    })
    req.on('error', (error) => { metrics.active -= 1; metrics.errors += 1; if (metrics.samples.length < 5) metrics.samples.push(String(error.code) + ': ' + String(error.message).slice(0, 90)); resolve(0) })
    req.setTimeout(20000, () => { req.destroy(); metrics.errors += 1; resolve(0) })
    req.end()
  })
}

const playlistLines = (text) => String(text).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))

async function viewer() {
  const master = await fetchText(TARGET)
  const variants = playlistLines(master)
  const variant = variants.find((line) => line.includes('480p')) ?? variants[0]
  const variantUrl = variant ? new URL(variant, BASE).toString() : TARGET

  while (Date.now() < deadline) {
    const playlist = await fetchText(variantUrl)
    const segments = playlistLines(playlist).slice(-2)
    for (const segment of segments) {
      if (Date.now() >= deadline) break
      await fetchBinary(new URL(segment, variantUrl).toString())
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

console.log(`目标 ${TARGET}${HOST ? `（Host: ${HOST}）` : ''}`)
console.log(`并发 ${CONCURRENCY} 路，持续 ${SECONDS}s，开始 ${new Date().toLocaleTimeString()}`)
const started = Date.now()
const timer = setInterval(() => {
  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  process.stdout.write(`\r  ${elapsed}s 请求 ${metrics.requests}  ${(metrics.bytes / 1048576).toFixed(0)} MiB  错误 ${metrics.errors}  活跃 ${metrics.active}  `)
}, 1000)

await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => viewer()))
clearInterval(timer)

metrics.latency.sort((a, b) => a - b)
const pick = (p) => metrics.latency[Math.min(metrics.latency.length - 1, Math.floor(metrics.latency.length * p))] ?? 0
const duration = (Date.now() - started) / 1000

console.log('\n\n=== 结果 ===')
console.log(`时长          ${duration.toFixed(1)}s`)
console.log(`请求总数      ${metrics.requests}（${(metrics.requests / duration).toFixed(0)} req/s）`)
console.log(`流量          ${(metrics.bytes / 1048576).toFixed(1)} MiB（${((metrics.bytes * 8) / duration / 1e6).toFixed(1)} Mbps）`)
console.log(`峰值并发      ${metrics.peak}`)
console.log(`错误          ${metrics.errors}`)
console.log(`状态分布      ${JSON.stringify(metrics.statuses)}`)
console.log(`延迟 p50/p95  ${pick(0.5).toFixed(1)} / ${pick(0.95).toFixed(1)} ms`)
if (metrics.samples.length) console.log('错误样本      ' + JSON.stringify(metrics.samples))
console.log('\n说明：本测试在服务器本机（loopback）跑，测 nginx+TLS+磁盘 的并发与吞吐；')
console.log('公网 1000 人还要看出口带宽：480p ≈ 0.85 Mbps/人 → 850 Mbps；720p ≈ 2.4 Mbps/人 → 2.4 Gbps。')
process.exit(0)
