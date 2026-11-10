/** Redis 客户端：协议正确性 + 未配置时降级。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'

let server, port, redis
const sockets = new Set()

/** 极简 RESP2 服务端：只支持本测试用到的命令。 */
function startFakeRedis() {
  return new Promise((resolve) => {
    const store = new Map()
    const socketServer = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        while (buffer.length > 0) {
          const parsed = takeCommand(buffer)
          if (!parsed) break
          buffer = buffer.slice(parsed.size)
          const [command, ...args] = parsed.args
          const verb = String(command ?? '').toUpperCase()
          const key = args[0]
          if (verb === 'PING') socket.write('+PONG\r\n')
          else if (verb === 'AUTH' || verb === 'SELECT') socket.write('+OK\r\n')
          else if (verb === 'SET') { store.set(key, args[1]); socket.write('+OK\r\n') }
          else if (verb === 'GET') {
            const value = store.get(key)
            socket.write(value === undefined ? '$-1\r\n' : `$${Buffer.byteLength(String(value))}\r\n${value}\r\n`)
          } else if (verb === 'INCR') {
            const next = Number(store.get(key) ?? 0) + 1
            store.set(key, String(next))
            socket.write(`:${next}\r\n`)
          } else if (verb === 'ZADD' || verb === 'SADD' || verb === 'DEL') socket.write(':1\r\n')
          else if (verb === 'ZCARD' || verb === 'SCARD') socket.write(':0\r\n')
          else if (verb === 'ZREMRANGEBYSCORE' || verb === 'PEXPIRE' || verb === 'EXPIRE') socket.write(':0\r\n')
          else socket.write('+OK\r\n')
        }
      })
    })
    socketServer.listen(0, '127.0.0.1', () => resolve({ socketServer, port: socketServer.address().port }))
  })
}

/** 解析一条 RESP 数组命令，未收全返回 null。 */
function takeCommand(buffer) {
  if (!buffer.startsWith('*')) return null
  const head = buffer.indexOf('\r\n')
  if (head < 0) return null
  const argc = Number(buffer.slice(1, head))
  let index = head + 2
  const args = []
  for (let i = 0; i < argc; i += 1) {
    if (buffer[index] !== '$') return null
    const end = buffer.indexOf('\r\n', index)
    if (end < 0) return null
    const length = Number(buffer.slice(index + 1, end))
    const start = end + 2
    if (buffer.length < start + length + 2) return null
    args.push(buffer.slice(start, start + length))
    index = start + length + 2
  }
  return { args, size: index }
}

before(async () => {
  const started = await startFakeRedis()
  server = started.socketServer
  port = started.port
  process.env.MH_REDIS_URL = `redis://127.0.0.1:${port}/0`
  redis = await import('../server/redis.mjs')
})

after(async () => {
  try { await redis.closeRedis() } catch { /* ignore */ }
  for (const socket of sockets) { try { socket.destroy() } catch { /* ignore */ } }
  sockets.clear()
  try { server.close() } catch { /* ignore */ }
})

test('连接与 PING', async () => {
  const connected = await redis.connectRedis()
  assert.equal(connected, true)
  assert.equal(await redis.cmd('PING'), 'PONG')
  assert.equal(redis.redisReady(), true)
})

test('SET / GET 往返，key 带前缀', async () => {
  await redis.cmd('SET', redis.key('demo'), 'v1')
  assert.equal(await redis.cmd('GET', redis.key('demo')), 'v1')
  assert.match(redis.key('demo'), /^mh:demo$/)
})

test('pipeline 批量执行返回数组', async () => {
  const result = await redis.pipeline([['PING'], ['SET', redis.key('p1'), 'a'], ['GET', redis.key('p1')]])
  assert.ok(Array.isArray(result))
  assert.equal(result[0], 'PONG')
  assert.equal(result[2], 'a')
})

test('未配置时返回 null 而不是抛错', async () => {
  process.env.MH_REDIS_URL = ''
  const mod = await import(`../server/redis.mjs?none=${Date.now()}`)
  assert.equal(await mod.connectRedis(), false)
  assert.equal(await mod.cmd('PING'), null)
})
