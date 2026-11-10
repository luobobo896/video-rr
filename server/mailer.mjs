/**
 * 极简 SMTP 客户端（零依赖）：支持 587 STARTTLS / 465 隐式 TLS / AUTH LOGIN。
 * 未配置 SMTP 时进入开发模式：验证码只写日志，并可由调用方决定是否回显（MH_EMAIL_DEV=1）。
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

const env = process.env

export function smtpConfig() {
  const host = env.MH_SMTP_HOST
  if (!host) return undefined
  return {
    host,
    port: Number(env.MH_SMTP_PORT ?? 465),
    secure: (env.MH_SMTP_SECURE ?? (Number(env.MH_SMTP_PORT ?? 465) === 465 ? '1' : '0')) === '1',
    user: env.MH_SMTP_USER,
    pass: env.MH_SMTP_PASS,
    from: env.MH_SMTP_FROM ?? env.MH_SMTP_USER,
    fromName: env.MH_SMTP_FROM_NAME ?? '影巢',
  }
}

export const isDevMail = () => !smtpConfig()

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64')
}

function encodeHeader(text) {
  // 非 ASCII 用 RFC 2047 编码
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${b64(text)}?=`
}

function buildMessage({ from, fromName, to, subject, text }) {
  const lines = [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
  ]
  return lines.join('\r\n')
}

/** 读取 SMTP 响应：返回 { code, text }，支持多行响应。 */
function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\r\n').filter(Boolean)
      const last = lines[lines.length - 1] ?? ''
      if (/^\d{3} /.test(last)) {
        socket.off('data', onData)
        resolve({ code: Number(last.slice(0, 3)), text: buffer })
      }
    }
    socket.on('data', onData)
    socket.once('error', reject)
    socket.setTimeout(15000, () => reject(new Error('SMTP 读取超时')))
  })
}

async function command(socket, line, expect = [250, 235, 220, 221, 334, 354]) {
  socket.write(`${line}\r\n`)
  const response = await readResponse(socket)
  if (!expect.includes(response.code)) {
    throw new Error(`SMTP 命令失败（${line.split(' ')[0]}）：${response.text.trim().slice(0, 200)}`)
  }
  return response
}

export async function sendMail({ to, subject, text }) {
  const config = smtpConfig()
  if (!config) {
    console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`)
    return { delivered: false, dev: true }
  }

  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
    : netConnect({ host: config.host, port: config.port })

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
  })
  await readResponse(socket)                                   // 220
  await command(socket, `EHLO ${config.host}`)

  if (!config.secure) {
    await command(socket, 'STARTTLS', [220])
    const secureSocket = tlsConnect({ socket, servername: config.host })
    await new Promise((resolve, reject) => {
      secureSocket.once('secureConnect', resolve)
      secureSocket.once('error', reject)
    })
    await sendOver(secureSocket, config, to, subject, text)
    secureSocket.end()
    return { delivered: true, dev: false }
  }

  await sendOver(socket, config, to, subject, text)
  socket.end()
  return { delivered: true, dev: false }
}

async function sendOver(socket, config, to, subject, text) {
  await command(socket, `EHLO ${config.host}`)
  if (config.user && config.pass) {
    await command(socket, 'AUTH LOGIN', [334])
    await command(socket, b64(config.user), [334])
    await command(socket, b64(config.pass), [235])
  }
  await command(socket, `MAIL FROM:<${config.from}>`)
  await command(socket, `RCPT TO:<${to}>`, [250, 251])
  await command(socket, 'DATA', [354])
  socket.write(`${buildMessage({ from: config.from, fromName: config.fromName, to, subject, text })}\r\n.\r\n`)
  const response = await readResponse(socket)
  if (response.code !== 250) throw new Error(`SMTP 发送失败：${response.text.trim().slice(0, 200)}`)
  socket.write('QUIT\r\n')
}
