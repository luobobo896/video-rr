import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { createWriteStream, renameSync, unlinkSync } from 'node:fs'
import { BlockList, isIP } from 'node:net'
import { extname, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { UPLOAD_DIR } from './media.mjs'

const MAX_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 15 * 60_000
const ALLOWED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mkv', '.mov', '.webm', '.avi'])

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(network, prefix, 'ipv6')

const badRequest = (message, status = 400) => Object.assign(new Error(message), { status })

export function isBlockedAddress(address) {
  let value = String(address ?? '').trim()
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value)
  if (mapped) value = mapped[1]
  const family = isIP(value)
  if (!family) return true
  return blocked.check(value, family === 6 ? 'ipv6' : 'ipv4')
}

export async function assertPublicMediaUrl(value) {
  let target
  try {
    target = new URL(String(value ?? '').trim())
  } catch {
    throw badRequest('请输入有效的视频 URL')
  }
  if (!['http:', 'https:'].includes(target.protocol)) throw badRequest('只支持 HTTP(S) 视频直链')
  if (target.username || target.password) throw badRequest('URL 不能包含账号或密码')
  const hostname = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!hostname) throw badRequest('URL 缺少主机名')
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw badRequest('不允许导入本机或内网地址')
  }
  // shortcut: DNS 校验与实际连接之间仍可能重绑定；当前仅登录后的内容运营可调用，开放给低权限角色前应固定解析地址连接。
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch(() => {
      throw badRequest('无法解析视频 URL 的主机名')
    })
  if (!addresses.length || addresses.some((row) => isBlockedAddress(row.address))) {
    throw badRequest('不允许导入本机或内网地址')
  }
  target.hash = ''
  return target
}

function fileExtensionOf(target) {
  const ext = extname(target.pathname).toLowerCase()
  return ALLOWED_EXTENSIONS.has(ext) ? ext : '.mp4'
}

async function writeResponse(response, temp, maxBytes) {
  if (!response.body) throw badRequest('视频源没有响应内容', 502)
  let size = 0
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      if (size > maxBytes) return callback(badRequest('视频文件超出大小上限', 413))
      callback(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temp))
  if (!size) throw badRequest('视频源返回空内容', 502)
  return size
}

export async function downloadRemoteVideo(value, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes ?? process.env.MH_UPLOAD_MAX_BYTES) || 2 * 1024 * 1024 * 1024)
  let target = await assertPublicMediaUrl(value)
  let current = target.toString()
  let response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'user-agent': 'MH-Clone/1.0 (+media import)', accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.1' },
        })
      } catch {
        if (controller.signal.aborted) throw badRequest('视频源下载超时', 504)
        throw badRequest('无法连接视频源', 502)
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      if (!location) throw badRequest('视频源重定向缺少目标地址', 502)
      if (redirects === MAX_REDIRECTS) throw badRequest('视频源重定向次数过多', 502)
      target = await assertPublicMediaUrl(new URL(location, current).toString())
      current = target.toString()
    }

    if (!response?.ok) throw badRequest(`视频源返回 HTTP ${response?.status ?? '未知'}`, 502)
    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase()
    if (contentType.startsWith('text/') || contentType.includes('html')) {
      throw badRequest('URL 不是可直接下载的视频文件', 400)
    }
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    if (declaredSize > maxBytes) throw badRequest('视频文件超出大小上限', 413)

    const name = `import-${Date.now()}-${randomBytes(4).toString('hex')}${fileExtensionOf(target)}`
    const temp = join(UPLOAD_DIR, `${name}.part`)
    const output = join(UPLOAD_DIR, name)
    try {
      const size = await writeResponse(response, temp, maxBytes)
      renameSync(temp, output)
      return { path: output, size, contentType, sourceUrl: current }
    } catch (error) {
      try { unlinkSync(temp) } catch { /* 临时文件可能尚未创建 */ }
      if (controller.signal.aborted) throw badRequest('视频源下载超时', 504)
      if (Number(error?.status)) throw error
      throw badRequest('视频下载中断，请重试', 502)
    }
  } finally {
    clearTimeout(timeout)
  }
}
