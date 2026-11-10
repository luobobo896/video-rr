/**
 * 极简 Redis 客户端（零依赖，RESP2 协议）。
 *
 * 只做限流/计数需要的几条命令，够用即止：
 *   cmd('PING') / cmd('INCR', key) / cmd('ZADD', key, score, member) ...
 *
 * 配置：MH_REDIS_URL=redis://[:password@]host:port[/db]
 * 未配置或连接失败时 ready() 返回 false，调用方自动退回进程内内存实现。
 */
import { createConnection } from 'node:net'

const URL_TEXT = process.env.MH_REDIS_URL ?? ''
const CONFIG = parseUrl(URL_TEXT)

let socket = null
let buffer = Buffer.alloc(0)
let queue = []
let ready = false
let connecting = null
let failures = 0
let nextRetryAt = 0
let lastError = ''

function parseUrl(text) {
  if (!text) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'redis:') return null
    return {
      host: url.hostname || '127.0.0.1',
      port: Number(url.port || 6379),
      password: url.password ? decodeURIComponent(url.password) : '',
      db: url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) : 0,
      keyPrefix: url.searchParams.get('prefix') ?? 'mh:',
    }
  } catch {
    return null
  }
}

function encode(args) {
  const parts = [`*${args.length}\r\n`]
  for (const arg of args) {
    const text = String(arg)
    parts.push(`$${Buffer.byteLength(text)}\r\n${text}\r\n`)
  }
  return Buffer.from(parts.join(''), 'utf8')
}

/** 解析一个完整回复；数据不足返回 null。 */
function parse(bufferIn) {
  if (bufferIn.length === 0) return null
  const marker = String.fromCharCode(bufferIn[0])
  const lineEnd = bufferIn.indexOf('\r\n')
  if (lineEnd === -1) return null
  const line = bufferIn.subarray(1, lineEnd).toString('utf8')
  const rest = bufferIn.subarray(lineEnd + 2)

  if (marker === '+') return { value: line, rest }
  if (marker === '-') return { value: { error: line }, rest }
  if (marker === ':') return { value: Number(line), rest }
  if (marker === '$') {
    const size = Number(line)
    if (size === -1) return { value: null, rest }
    if (rest.length < size + 2) return null
    return { value: rest.subarray(0, size).toString('utf8'), rest: rest.subarray(size + 2) }
  }
  if (marker === '*') {
    const count = Number(line)
    if (count === -1) return { value: null, rest }
    let cursor = rest
    const items = []
    for (let index = 0; index < count; index += 1) {
      const parsed = parse(cursor)
      if (!parsed) return null
      items.push(parsed.value)
      cursor = parsed.rest
    }
    return { value: items, rest: cursor }
  }
  return { value: null, rest }
}

function flush() {
  while (buffer.length > 0 && queue.length > 0) {
    const parsed = parse(buffer)
    if (!parsed) break
    buffer = parsed.rest
    const job = queue.shift()
    const value = parsed.value
    if (value && typeof value === 'object' && value.error) job.reject(new Error(value.error))
    else job.resolve(value)
  }
}

function attach(sock) {
  sock.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    flush()
  })
  sock.on('error', (error) => {
    lastError = error.message
    teardown()
  })
  sock.on('close', () => {
    teardown()
  })
  sock.setNoDelay(true)
  sock.setKeepAlive(true, 30_000)
}

function teardown() {
  ready = false
  failures += 1
  nextRetryAt = Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures, 5))
  const pending = queue
  queue = []
  for (const job of pending) job.reject(new Error('redis connection lost'))
  if (socket) {
    try { socket.destroy() } catch { /* ignore */ }
  }
  socket = null
  buffer = Buffer.alloc(0)
  connecting = null
}

async function connect() {
  if (!CONFIG) return null
  if (ready) return socket
  if (connecting) return connecting
  if (Date.now() < nextRetryAt) return null

  connecting = new Promise((resolve) => {
    const sock = createConnection({ host: CONFIG.host, port: CONFIG.port })
    attach(sock)
    const timer = setTimeout(() => {
      lastError = 'connect timeout'
      try { sock.destroy() } catch { /* ignore */ }
      resolve(null)
    }, 2000)

    sock.once('connect', async () => {
      clearTimeout(timer)
      socket = sock
      try {
        if (CONFIG.password) await raw('AUTH', CONFIG.password)
        if (CONFIG.db) await raw('SELECT', CONFIG.db)
        await raw('PING')
        ready = true
        failures = 0
        lastError = ''
        console.log(`[redis] connected ${CONFIG.host}:${CONFIG.port}/${CONFIG.db}`)
      } catch (error) {
        lastError = error.message
        teardown()
      }
      resolve(ready ? socket : null)
    })

    sock.once('error', (error) => {
      clearTimeout(timer)
      lastError = error.message
      resolve(null)
    })
  }).finally(() => { connecting = null })

  return connecting
}

/** 发一条命令（内部使用，不触发自动重连）。 */
function raw(...args) {
  return new Promise((resolve, reject) => {
    if (!socket) { reject(new Error('redis not connected')); return }
    queue.push({ resolve, reject })
    socket.write(encode(args))
  })
}

/** 对外命令入口：连接不可用会尝试建立一次连接。 */
export async function cmd(...args) {
  if (!CONFIG) return null
  if (!ready) {
    await connect()
    if (!ready) return null
  }
  try {
    const value = await raw(...args)
    if (value && typeof value === 'object' && value.error) throw new Error(value.error)
    return value
  } catch (error) {
    lastError = error.message
    return null
  }
}

/** 批量命令（非事务，顺序发送），用于 ZSET 滑动窗口。 */
export async function pipeline(list) {
  if (!CONFIG) return null
  if (!ready) {
    await connect()
    if (!ready) return null
  }
  const results = []
  for (const args of list) {
    results.push(await cmd(...args))
  }
  return results
}

export function key(name) {
  return `${CONFIG?.keyPrefix ?? 'mh:'}${name}`
}

export function redisReady() {
  return Boolean(CONFIG) && ready
}

export function redisStatus() {
  return {
    configured: Boolean(CONFIG),
    connected: Boolean(CONFIG) && ready,
    url: CONFIG ? `${CONFIG.host}:${CONFIG.port}/${CONFIG.db}` : null,
    lastError: lastError || null,
    pendingCommands: queue.length,
  }
}

/** 启动时调用一次；Redis 不可用也只是降级，不影响启动。 */
export async function connectRedis() {
  if (!CONFIG) return false
  await connect()
  return ready
}

export function closeRedis() {
  if (socket) {
    try { socket.end() } catch { /* ignore */ }
  }
  socket = null
  ready = false
}
