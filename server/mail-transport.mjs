/**
 * 邮件传输层（厂家无关）：SMTP（多认证方式）+ 通用 HTTP API。
 * 上层只给"通道配置 + 邮件内容"，这里负责真正投递。
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64')

export function encodeHeader(text) {
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${b64(text)}?=`
}

export function buildMime({ from, fromName, to, subject, text, html }) {
  const lines = [
    `From: ${encodeHeader(fromName || '')} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject || '')}`,
    'MIME-Version: 1.0',
    `Date: ${new Date().toUTCString()}`,
  ]
  if (html) {
    const boundary = `--=_${Math.random().toString(36).slice(2)}`
    lines.push(
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(text || '').replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(html).replace(/(.{76})/g, '$1\r\n'),
      `--${boundary}--`,
    )
  } else {
    lines.push(
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(text || '').replace(/(.{76})/g, '$1\r\n'),
    )
  }
  return lines.join('\r\n')
}

function readResponse(socket, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); socket.off('timeout', onTimeout) }
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\r\n').filter(Boolean)
      const last = lines[lines.length - 1] ?? ''
      if (/^\d{3} /.test(last)) { cleanup(); resolve({ code: Number(last.slice(0, 3)), text: buffer.trim() }) }
    }
    const onError = (error) => { cleanup(); reject(error) }
    const onTimeout = () => { cleanup(); reject(new Error(`SMTP 响应超时（${timeoutMs}ms）`)) }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.setTimeout(timeoutMs, onTimeout)
  })
}

async function command(socket, line, expect = [250, 235, 220, 221, 334, 354, 503]) {
  socket.write(`${line}\r\n`)
  const response = await readResponse(socket)
  if (!expect.includes(response.code)) {
    const isCredential = /^[A-Za-z0-9+/=]{8,}$/.test(line)
    throw new Error(`SMTP ${isCredential ? 'AUTH ***' : line.split(' ')[0]} 失败（${response.code}）：${response.text.replace(/\s+/g, ' ').slice(0, 160)}`)
  }
  return response
}

async function openSocket({ host, port, secure }) {
  const socket = secure
    ? tlsConnect({ host, port: Number(port), servername: host, rejectUnauthorized: false })
    : netConnect({ host, port: Number(port) })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
    socket.setTimeout(15000, () => reject(new Error(`连接 ${host}:${port} 超时`)))
  })
  return socket
}

function capabilitiesOf(ehloText) {
  return ehloText.toUpperCase()
}

async function authenticate(socket, { user, pass, creds, caps }) {
  const mode = creds?.mode ?? (creds?.accessToken ? 'xoauth2' : 'auto')
  if (mode === 'none' || (!user && !pass && !creds?.accessToken)) return 'none'

  if (mode === 'xoauth2' || (mode === 'auto' && creds?.accessToken && caps.includes('XOAUTH2'))) {
    if (!creds?.accessToken) throw new Error('缺少 access_token，无法 XOAUTH2 认证')
    socket.write(`AUTH XOAUTH2 ${b64(`user=${user}\x01auth=Bearer ${creds.accessToken}\x01\x01`)}\r\n`)
    const done = await readResponse(socket)
    if (done.code !== 235) throw new Error(`XOAUTH2 认证失败（${done.code}）：${done.text.replace(/\s+/g, ' ').slice(0, 140)}`)
    return 'xoauth2'
  }

  if (mode === 'plain' || (mode === 'auto' && caps.includes('PLAIN') && !caps.includes('LOGIN'))) {
    const response = await command(socket, `AUTH PLAIN ${b64(`\u0000${user}\u0000${pass}`)}`, [235, 334])
    if (response.code === 334) await command(socket, b64(`\u0000${user}\u0000${pass}`), [235])
    return 'plain'
  }

  const login = await command(socket, 'AUTH LOGIN', [334, 250, 235, 503])
  if (login.code === 334) {
    await command(socket, b64(user), [334])
    await command(socket, b64(pass), [235])
  }
  return 'login'
}

/** SMTP 投递。creds: { mode:'login'|'plain'|'xoauth2'|'auto'|'none', accessToken? } */
export async function smtpDeliver(config, message, creds = { mode: 'auto' }) {
  const { host, port } = config
  if (!host) throw new Error('SMTP 缺少 host')
  let socket = await openSocket(config)
  let caps = ''
  try {
    await readResponse(socket)
    let ehlo = await command(socket, `EHLO ${config.ehloName || 'yingchao.local'}`)
    caps = capabilitiesOf(ehlo.text)

    if (!config.secure) {
      const starttls = await command(socket, 'STARTTLS', [220, 250, 502, 503])
      if (starttls.code === 220) {
        const secureSocket = tlsConnect({ socket, servername: host, rejectUnauthorized: false })
        await new Promise((resolve, reject) => { secureSocket.once('secureConnect', resolve); secureSocket.once('error', reject) })
        socket = secureSocket
        ehlo = await command(socket, `EHLO ${config.ehloName || 'yingchao.local'}`)
        caps = capabilitiesOf(ehlo.text)
      }
    }

    const authMode = await authenticate(socket, { user: config.user, pass: config.pass, creds, caps })

    await command(socket, `MAIL FROM:<${config.from}>`, [250, 251])
    await command(socket, `RCPT TO:<${message.to}>`, [250, 251])
    await command(socket, 'DATA', [354])
    socket.write(`${buildMime({ ...config, ...message })}\r\n.\r\n`)
    const done = await readResponse(socket)
    socket.write('QUIT\r\n')
    socket.end()
    if (done.code !== 250) throw new Error(`SMTP 投递被拒（${done.code}）：${done.text.replace(/\s+/g, ' ').slice(0, 160)}`)
    return { delivered: true, transport: 'smtp', authMode }
  } catch (error) {
    try { socket.destroy() } catch { /* ignore */ }
    throw error
  }
}

/** SMTP 半程自检：连接 + EHLO + AUTH，不发信。 */
export async function smtpVerify(config, creds = { mode: 'auto' }) {
  let socket
  try {
    socket = await openSocket(config)
    await readResponse(socket)
    let ehlo = await command(socket, `EHLO ${config.ehloName || 'yingchao.local'}`)
    let caps = capabilitiesOf(ehlo.text)
    if (!config.secure) {
      const starttls = await command(socket, 'STARTTLS', [220, 250, 502, 503])
      if (starttls.code === 220) {
        const secureSocket = tlsConnect({ socket, servername: config.host, rejectUnauthorized: false })
        await new Promise((resolve, reject) => { secureSocket.once('secureConnect', resolve); secureSocket.once('error', reject) })
        socket = secureSocket
        ehlo = await command(socket, `EHLO ${config.ehloName || 'yingchao.local'}`)
        caps = capabilitiesOf(ehlo.text)
      }
    }
    const authMode = await authenticate(socket, { user: config.user, pass: config.pass, creds, caps })
    socket.write('QUIT\r\n'); socket.end()
    return { ok: true, authMode, starttls: caps.includes('STARTTLS') }
  } catch (error) {
    try { socket?.destroy() } catch { /* ignore */ }
    return { ok: false, error: error.message }
  }
}

/** 通用 HTTP API 投递：URL / 方法 / 头 / body 全部来自通道配置（{{var}} 占位）。 */
export function renderTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), vars)
    return value == null ? '' : String(value)
  })
}

/** JSON 模板替换：值按 JSON 字符串转义（换行/引号不会破坏请求体） */
export function renderJsonTemplate(template, vars) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), vars)
    if (value == null) return ''
    return JSON.stringify(String(value)).slice(1, -1)
  })
}

function looksJson(body) {
  const trimmed = String(body ?? '').trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

export async function httpDeliver(channel, message) {
  const http = channel.http ?? {}
  if (!http.url) throw new Error('HTTP 通道缺少 url')
  const vars = {
    from: channel.from,
    fromName: channel.fromName,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html ?? '',
    apiKey: channel.apiKey ?? '',
    user: channel.user ?? '',
    timestamp: new Date().toISOString(),
  }
  const url = renderTemplate(http.url, vars)
  const headers = {}
  for (const [key, value] of Object.entries(http.headers ?? {})) headers[key] = renderTemplate(value, vars)
  if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'
  const body = http.method && http.method.toUpperCase() === 'GET'
    ? undefined
    : (looksJson(http.body) ? renderJsonTemplate(http.body, vars) : renderTemplate(http.body, vars))

  const response = await fetch(url, {
    method: (http.method ?? 'POST').toUpperCase(),
    headers,
    body,
    signal: AbortSignal.timeout(20000),
  })
  const text = await response.text()
  const okStatus = (http.successStatus ?? [200, 201, 202]).map(Number)
  if (!okStatus.includes(response.status)) {
    throw new Error(`HTTP 通道返回 ${response.status}：${text.slice(0, 200)}`)
  }
  return { delivered: true, transport: 'http', status: response.status }
}
