/**
 * 邮件发送：多 Provider 可配置（smtp / resend / sendgrid / dev）。
 * 配置存 settings.email（口令与 API Key 均加密），后台「邮件设置」可改，保存即生效。
 */
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { getSetting } from './db.mjs'
import { openSecret, sealSecret } from './secretbox.mjs'
import { MS_SMTP, accessTokenFor, xoauth2String } from './mailer-oauth.mjs'

const env = process.env

const decrypt = (value) => {
  if (!value) return ''
  if (!String(value).startsWith('v')) return String(value)
  try { return openSecret(value)?.value ?? '' } catch { return '' }
}

export const encryptSecret = (value) => (value ? sealSecret({ value: String(value) }) : '')

/** 归一化配置（兼容旧版 settings.smtp 结构）。 */
export function emailConfig() {
  const stored = getSetting('email', undefined)
  const legacy = getSetting('smtp', {}) ?? {}
  const source = stored ?? {
    provider: legacy.enabled ? 'smtp' : 'dev',
    from: legacy.from,
    fromName: legacy.fromName,
    smtp: {
      host: legacy.host, port: legacy.port, secure: legacy.secure,
      user: legacy.user, pass: legacy.pass,
    },
    resend: {}, sendgrid: {},
  }
  const provider = source.provider ?? 'dev'
  const smtp = source.smtp ?? {}
  return {
    provider,
    from: source.from || smtp.user || '',
    fromName: source.fromName || '影巢',
    smtp: {
      host: smtp.host ?? '',
      port: Number(smtp.port ?? 465),
      secure: smtp.secure !== false,
      user: smtp.user ?? '',
      pass: decrypt(smtp.pass),
      passSet: Boolean(smtp.pass),
    },
    resend: { apiKey: decrypt(source.resend?.apiKey), keySet: Boolean(source.resend?.apiKey) },
    sendgrid: { apiKey: decrypt(source.sendgrid?.apiKey), keySet: Boolean(source.sendgrid?.apiKey) },
    microsoft: {
      clientId: source.microsoft?.clientId ?? '',
      refreshToken: decrypt(source.microsoft?.refreshToken),
      refreshTokenSet: Boolean(source.microsoft?.refreshToken),
      account: source.microsoft?.account ?? '',
    },
    env: provider === 'smtp' && env.MH_SMTP_HOST && !smtp.host
      ? { host: env.MH_SMTP_HOST, port: Number(env.MH_SMTP_PORT ?? 465), secure: (env.MH_SMTP_SECURE ?? '1') === '1', user: env.MH_SMTP_USER, pass: env.MH_SMTP_PASS }
      : null,
  }
}

/** 实际用于发信的 SMTP 参数（DB 优先，其次环境变量）。 */
export function smtpConfig() {
  const config = emailConfig()
  if (config.provider !== 'smtp') return undefined
  const smtp = config.smtp.host ? config.smtp : config.env
  if (!smtp?.host) return undefined
  return {
    host: smtp.host,
    port: Number(smtp.port ?? 465),
    secure: smtp.secure !== false,
    user: smtp.user ?? '',
    pass: smtp.pass ?? '',
    from: config.from || smtp.user,
    fromName: config.fromName,
    source: config.smtp.host ? 'database' : 'env',
  }
}

/** 是否处于"验证码只写日志"的开发模式。 */
export const isDevMail = () => emailConfig().provider === 'dev'

/** 把后台提交的表单落库（空值表示保持原值）。 */
export function saveEmailConfig(payload) {
  const current = emailConfig()
  const next = {
    provider: payload.provider ?? current.provider,
    from: String(payload.from ?? current.from ?? '').trim(),
    fromName: String(payload.fromName ?? current.fromName ?? '影巢').trim(),
    smtp: {
      host: String(payload.smtp?.host ?? current.smtp.host ?? '').trim(),
      port: Number(payload.smtp?.port ?? current.smtp.port ?? 465),
      secure: payload.smtp?.secure ?? current.smtp.secure,
      user: String(payload.smtp?.user ?? current.smtp.user ?? '').trim(),
      pass: payload.smtp?.pass ? encryptSecret(payload.smtp.pass) : (getSetting('email', {})?.smtp?.pass ?? ''),
    },
    resend: { apiKey: payload.resend?.apiKey ? encryptSecret(payload.resend.apiKey) : (getSetting('email', {})?.resend?.apiKey ?? '') },
    sendgrid: { apiKey: payload.sendgrid?.apiKey ? encryptSecret(payload.sendgrid.apiKey) : (getSetting('email', {})?.sendgrid?.apiKey ?? '') },
    microsoft: {
      clientId: String(payload.microsoft?.clientId ?? current.microsoft?.clientId ?? '').trim(),
      refreshToken: payload.microsoft?.refreshToken
        ? encryptSecret(payload.microsoft.refreshToken)
        : (getSetting('email', {})?.microsoft?.refreshToken ?? ''),
      account: String(payload.microsoft?.account ?? current.microsoft?.account ?? '').trim(),
    },
  }
  return next
}

function b64(text) { return Buffer.from(text, 'utf8').toString('base64') }
function encodeHeader(text) {
  if (/^[\x20-\x7E]*$/.test(text)) return text
  return `=?UTF-8?B?${b64(text)}?=`
}

function buildMessage({ from, fromName, to, subject, text }) {
  return [
    `From: ${encodeHeader(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    `Date: ${new Date().toUTCString()}`,
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n')
}

function readResponse(socket, timeoutMs = 15000) {
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

async function command(socket, line, expect = [250, 235, 220, 221, 334, 354]) {
  socket.write(`${line}\r\n`)
  const response = await readResponse(socket)
  if (!expect.includes(response.code)) {
    // 凭据行是 base64，不能出现在错误里（避免口令经日志/接口泄露）
    const isCredential = /^[A-Za-z0-9+/=]{8,}$/.test(line)
    const label = isCredential ? 'AUTH ***' : line.split(' ')[0]
    throw new Error(`SMTP 命令失败（${label}，${response.code}）：${response.text.slice(0, 160)}`)
  }
  return response
}

async function openSocket(config) {
  const socket = config.secure
    ? tlsConnect({ host: config.host, port: config.port, servername: config.host, rejectUnauthorized: false })
    : netConnect({ host: config.host, port: config.port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('secureConnect', resolve)
    socket.once('error', reject)
    socket.setTimeout(12000, () => reject(new Error('SMTP 连接超时')))
  })
  return socket
}

async function smtpLogin(socket, config) {
  await readResponse(socket)
  await command(socket, `EHLO ${config.host}`)
  if (config.user && config.pass) {
    const auth = await command(socket, 'AUTH LOGIN', [334, 250, 235, 503])
    if (auth.code === 334) {
      await command(socket, b64(config.user), [334])
      await command(socket, b64(config.pass), [235])
    }
  }
}

async function smtpSend(config, { to, subject, text }, auth = { mode: 'login' }) {
  let socket = await openSocket(config)
  if (!config.secure) {
    await readResponse(socket)
    await command(socket, `EHLO ${config.host}`)
    await command(socket, 'STARTTLS', [220])
    const secureSocket = tlsConnect({ socket, servername: config.host, rejectUnauthorized: false })
    await new Promise((resolve, reject) => { secureSocket.once('secureConnect', resolve); secureSocket.once('error', reject) })
    socket = secureSocket
    await command(socket, `EHLO ${config.host}`)
  } else {
    await readResponse(socket)
    await command(socket, `EHLO ${config.host}`)
  }

  if (auth.mode === 'xoauth2') {
    socket.write(`AUTH XOAUTH2 ${xoauth2String(config.user, auth.accessToken)}\r\n`)
    const done = await readResponse(socket)
    if (done.code !== 235) throw new Error(`XOAUTH2 认证失败（${done.code}）：${done.text.replace(/\s+/g, ' ').slice(0, 160)}`)
  } else if (config.user && config.pass) {
    const login = await command(socket, 'AUTH LOGIN', [334, 250, 235, 503])
    if (login.code === 334) {
      await command(socket, b64(config.user), [334])
      await command(socket, b64(config.pass), [235])
    }
  }

  await command(socket, `MAIL FROM:<${config.from}>`, [250, 251])
  await command(socket, `RCPT TO:<${to}>`, [250, 251])
  await command(socket, 'DATA', [354])
  socket.write(`${buildMessage({ ...config, to, subject, text })}\r\n.\r\n`)
  const done = await readResponse(socket)
  socket.write('QUIT\r\n'); socket.end()
  if (done.code !== 250) throw new Error(`SMTP 发送失败：${done.text.slice(0, 200)}`)
  return { delivered: true, dev: false, provider: 'smtp' }
}

async function resendSend(config, { to, subject, text }) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.resend.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: `${config.fromName} <${config.from}>`, to: [to], subject, text }),
    signal: AbortSignal.timeout(15000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Resend 发送失败 ${response.status}：${body.slice(0, 200)}`)
  return { delivered: true, dev: false, provider: 'resend', id: JSON.parse(body || '{}').id }
}

async function sendgridSend(config, { to, subject, text }) {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.sendgrid.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.from, name: config.fromName },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`SendGrid 发送失败 ${response.status}：${body.slice(0, 200)}`)
  }
  return { delivered: true, dev: false, provider: 'sendgrid' }
}

export async function sendMail({ to, subject, text }) {
  const config = emailConfig()
  if (config.provider === 'microsoft') {
    const ms = config.microsoft
    if (!ms.clientId || !ms.refreshToken) throw new Error('微软 OAuth2 未完成授权（缺少 clientId 或 refresh_token）')
    const from = config.from || ms.account
    const accessToken = await accessTokenFor({ clientId: ms.clientId, refreshToken: ms.refreshToken })
    return smtpSend(
      { ...MS_SMTP, user: from, from, fromName: config.fromName, source: 'microsoft-oauth2' },
      { to, subject, text },
      { mode: 'xoauth2', accessToken },
    )
  }
  if (config.provider === 'resend' && config.resend.apiKey) return resendSend(config, { to, subject, text })
  if (config.provider === 'sendgrid' && config.sendgrid.apiKey) return sendgridSend(config, { to, subject, text })
  if (config.provider === 'smtp') {
    const smtp = smtpConfig()
    if (!smtp) throw new Error('SMTP 未配置完整（host / user / 口令）')
    return smtpSend(smtp, { to, subject, text })
  }
  console.log(`[mail:dev] to=${to} subject=${subject}\n${text}`)
  return { delivered: false, dev: true, provider: 'dev' }
}

/** 连接/凭据自检（不发信）。 */
export async function verifySmtp() {
  const config = emailConfig()
  if (config.provider === 'microsoft') {
    try {
      const ms = config.microsoft
      if (!ms.clientId) return { ok: false, provider: 'microsoft', error: '缺少 clientId（需先注册 Azure 应用）' }
      if (!ms.refreshToken) return { ok: false, provider: 'microsoft', error: '尚未完成设备码授权（无 refresh_token）' }
      const accessToken = await accessTokenFor({ clientId: ms.clientId, refreshToken: ms.refreshToken })
      const user = config.from || ms.account
      let socket
      try {
        socket = await openSocket(MS_SMTP)
        await readResponse(socket)
        await command(socket, `EHLO ${MS_SMTP.host}`)
        await command(socket, 'STARTTLS', [220])
        const secure = tlsConnect({ socket, servername: MS_SMTP.host, rejectUnauthorized: false })
        await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject) })
        socket = secure
        await command(socket, `EHLO ${MS_SMTP.host}`)
        socket.write(`AUTH XOAUTH2 ${xoauth2String(user, accessToken)}\r\n`)
        const done = await readResponse(socket)
        socket.write('QUIT\r\n'); socket.end()
        if (done.code !== 235) return { ok: false, provider: 'microsoft', error: `XOAUTH2 ${done.code}：${done.text.replace(/\s+/g, ' ').slice(0, 140)}` }
        return { ok: true, provider: 'microsoft', host: MS_SMTP.host, port: MS_SMTP.port, account: user }
      } catch (error) {
        try { socket?.destroy() } catch { /* ignore */ }
        return { ok: false, provider: 'microsoft', error: error.message }
      }
    } catch (error) {
      return { ok: false, provider: 'microsoft', error: error.message }
    }
  }
  if (config.provider !== 'smtp') return { ok: true, provider: config.provider, note: 'HTTP API 渠道，发送时校验 Key' }
  const smtp = smtpConfig()
  if (!smtp) return { ok: false, provider: 'smtp', error: 'SMTP 未配置完整' }
  let socket
  try {
    socket = await openSocket(smtp)
    await smtpLogin(socket, smtp)
    socket.write('QUIT\r\n'); socket.end()
    return { ok: true, provider: 'smtp', host: smtp.host, port: smtp.port, source: smtp.source }
  } catch (error) {
    try { socket?.destroy() } catch { /* ignore */ }
    return { ok: false, provider: 'smtp', host: smtp.host, port: smtp.port, error: error.message }
  }
}
