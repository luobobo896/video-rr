/**
 * 邮件通道管理（厂家无关）：
 * - 通道 = 一条独立配置（smtp / oauth2 / http / dev），可多条、按优先级回退
 * - 支持任意厂家：SMTP 参数化；OAuth2 用 tokenUrl/scope 参数化；HTTP 用 url/headers/body 模板参数化
 * - 内置常见厂家预设（Gmail / QQ / 163 / 阿里云 / 腾讯 / Outlook / Zoho / SendGrid / Mailgun / Resend…）
 */
import { randomUUID } from 'node:crypto'
import { getSetting, setSetting } from './db.mjs'
import { openSecret, sealSecret } from './secretbox.mjs'
import { httpDeliver, smtpDeliver, smtpVerify } from './mail-transport.mjs'

const tokenCache = new Map() // `${channelId}:${refreshToken}` → { token, expiresAt }

const seal = (value) => (value ? sealSecret({ value: String(value) }) : '')
const unseal = (value) => {
  if (!value) return ''
  if (!String(value).startsWith('v')) return String(value)
  try { return openSecret(value)?.value ?? '' } catch { return '' }
}

/** 常见厂家预设：选厂家自动填 host/port/加密/认证方式，只需再填账号与凭据 */
export const PRESETS = [
  { id: 'gmail', name: 'Gmail / Google Workspace', type: 'smtp', host: 'smtp.gmail.com', port: 465, secure: true, authMode: 'login', note: '需要「应用专用密码」（开启两步验证后生成），普通密码无效' },
  { id: 'outlook', name: 'Outlook / Hotmail / Live（OAuth2）', type: 'oauth2', host: 'smtp-mail.outlook.com', port: 587, secure: false, authMode: 'xoauth2', note: '微软只接受 OAuth2（XOAUTH2）或应用专用密码，密码认证必失败' },
  { id: 'outlook-apppass', name: 'Outlook / Hotmail（应用专用密码）', type: 'smtp', host: 'smtp-mail.outlook.com', port: 587, secure: false, authMode: 'login', note: '在 account.live.com/proofs/AppPassword 生成 16 位应用密码，用它当 SMTP 密码' },
  { id: 'qq', name: 'QQ 邮箱', type: 'smtp', host: 'smtp.qq.com', port: 465, secure: true, authMode: 'login', note: '在 QQ 邮箱设置里开启 SMTP 并使用「授权码」作为密码' },
  { id: 'qq-exmail', name: '腾讯企业邮', type: 'smtp', host: 'smtp.exmail.qq.com', port: 465, secure: true, authMode: 'login', note: '密码或客户端专用密码' },
  { id: '163', name: '网易 163', type: 'smtp', host: 'smtp.163.com', port: 465, secure: true, authMode: 'login', note: '需在设置中开启 SMTP 并使用「授权码」' },
  { id: '126', name: '网易 126', type: 'smtp', host: 'smtp.126.com', port: 465, secure: true, authMode: 'login', note: '同上，使用授权码' },
  { id: 'aliyun', name: '阿里云邮件推送', type: 'smtp', host: 'smtpdm.aliyun.com', port: 465, secure: true, authMode: 'login', note: '用户名=发信地址，密码=控制台设置的 SMTP 密码；需先验证发信域名' },
  { id: 'tencent-ses', name: '腾讯云 SES', type: 'smtp', host: 'smtp.qcloudmail.com', port: 465, secure: true, authMode: 'login', note: '发信地址需在控制台验证' },
  { id: 'zoho', name: 'Zoho Mail', type: 'smtp', host: 'smtp.zoho.com', port: 465, secure: true, authMode: 'login', note: '应用专用密码' },
  { id: 'mailcom', name: 'mail.com / GMX', type: 'smtp', host: 'smtp.mail.com', port: 465, secure: true, authMode: 'login', note: '需在网页端开启 POP3/IMAP 并使用应用密码' },
  { id: 'yandex', name: 'Yandex Mail', type: 'smtp', host: 'smtp.yandex.com', port: 465, secure: true, authMode: 'login', note: '需在设置里开启「应用密码」' },
  { id: 'sendgrid-smtp', name: 'SendGrid（SMTP）', type: 'smtp', host: 'smtp.sendgrid.net', port: 587, secure: false, authMode: 'login', note: '用户名固定为 apikey，密码为 API Key' },
  { id: 'mailgun-smtp', name: 'Mailgun（SMTP）', type: 'smtp', host: 'smtp.mailgun.org', port: 587, secure: false, authMode: 'login', note: '用户名形如 postmaster@你的域名' },
  { id: 'brevo', name: 'Brevo（SMTP）', type: 'smtp', host: 'smtp-relay.brevo.com', port: 587, secure: false, authMode: 'login', note: '用户名=登录邮箱，密码=SMTP Key' },
  { id: 'resend-http', name: 'Resend（HTTP API）', type: 'http', url: 'https://api.resend.com/emails', method: 'POST', headers: { authorization: 'Bearer {{apiKey}}', 'content-type': 'application/json' }, body: '{"from":"{{fromName}} <{{from}}>","to":["{{to}}"],"subject":"{{subject}}","text":"{{text}}"}', note: '免费 100 封/天，需在 Resend 验证发信域名或收件人' },
  { id: 'sendgrid-http', name: 'SendGrid（HTTP API）', type: 'http', url: 'https://api.sendgrid.com/v3/mail/send', method: 'POST', headers: { authorization: 'Bearer {{apiKey}}', 'content-type': 'application/json' }, body: '{"personalizations":[{"to":[{"email":"{{to}}"}]}],"from":{"email":"{{from}}","name":"{{fromName}}"},"subject":"{{subject}}","content":[{"type":"text/plain","value":"{{text}}"}]}', note: '需先完成 Single Sender 验证' },
  { id: 'custom-smtp', name: '自定义 SMTP', type: 'smtp', host: '', port: 465, secure: true, authMode: 'login', note: '任意厂家的 SMTP 服务器' },
  { id: 'custom-http', name: '自定义 HTTP API', type: 'http', url: '', method: 'POST', headers: { 'content-type': 'application/json' }, body: '', note: '用 {{apiKey}} {{from}} {{to}} {{subject}} {{text}} 占位' },
]

export function presetOf(id) {
  return PRESETS.find((preset) => preset.id === id)
}

export function newChannel(type = 'smtp', presetId) {
  const preset = presetOf(presetId)
  const channel = {
    id: randomUUID().slice(0, 8),
    name: preset?.name ?? (type === 'http' ? '新 HTTP 通道' : '新 SMTP 通道'),
    type,
    enabled: true,
    priority: 10,
    from: '',
    fromName: '影巢',
    smtp: { host: '', port: 465, secure: true, user: '', pass: '', authMode: 'login' },
    oauth2: { tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', deviceUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', clientId: '', clientSecret: '', scope: 'https://outlook.office.com/SMTP.Send offline_access', refreshToken: '', account: '' },
    http: { url: '', method: 'POST', headers: { 'content-type': 'application/json' }, body: '', successStatus: [200, 201, 202] },
    apiKey: '',
    lastTest: null,
  }
  if (preset) {
    if (preset.host) Object.assign(channel.smtp, { host: preset.host, port: preset.port, secure: preset.secure, authMode: preset.authMode })
    if (preset.type === 'http') {
      channel.type = type === 'smtp' ? 'http' : type
      Object.assign(channel.http, { url: preset.url, method: preset.method, headers: { ...preset.headers }, body: preset.body })
    }
    channel.presetId = preset.id
  }
  return channel
}

/** 老配置（单 provider）→ 通道数组，只迁移一次。 */
function migrateLegacy(legacy) {
  const channels = []
  const mk = (type, fields) => ({ ...newChannel(type), ...fields, priority: (channels.length + 1) * 10 })

  if (legacy.smtp?.host) {
    channels.push(mk('smtp', {
      name: `SMTP · ${legacy.smtp.host}`,
      from: legacy.from ?? legacy.smtp.user ?? '',
      fromName: legacy.fromName ?? '影巢',
      smtp: {
        host: legacy.smtp.host, port: legacy.smtp.port ?? 465, secure: legacy.smtp.secure !== false,
        user: legacy.smtp.user ?? '', pass: legacy.smtp.pass ?? '', authMode: 'login',
      },
    }))
  }
  if (legacy.microsoft?.clientId) {
    channels.push(mk('oauth2', {
      name: '微软 OAuth2',
      from: legacy.from ?? legacy.microsoft.account ?? '',
      fromName: legacy.fromName ?? '影巢',
      smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, user: legacy.microsoft.account ?? legacy.from ?? '', pass: '', authMode: 'xoauth2' },
      oauth2: {
        ...newChannel('oauth2').oauth2,
        clientId: legacy.microsoft.clientId,
        refreshToken: legacy.microsoft.refreshToken ?? '',
        account: legacy.microsoft.account ?? '',
      },
    }))
  }
  if (legacy.resend?.apiKey) {
    channels.push(mk('http', {
      name: 'Resend',
      http: { ...presetOf('resend-http') && { url: presetOf('resend-http').url, method: 'POST', headers: { ...presetOf('resend-http').headers }, body: presetOf('resend-http').body, successStatus: [200, 201, 202] } },
      apiKey: legacy.resend.apiKey,
    }))
  }
  if (legacy.sendgrid?.apiKey) {
    channels.push(mk('http', {
      name: 'SendGrid',
      http: { url: presetOf('sendgrid-http').url, method: 'POST', headers: { ...presetOf('sendgrid-http').headers }, body: presetOf('sendgrid-http').body, successStatus: [200, 201, 202] },
      apiKey: legacy.sendgrid.apiKey,
    }))
  }
  return channels
}

/** 读取当前邮件配置（含通道数组），必要时把老结构迁移过来。 */
export function emailSettings() {
  const stored = getSetting('email', undefined)
  const legacy = getSetting('smtp', {}) ?? {}

  if (!stored || !Array.isArray(stored.channels)) {
    const channels = stored ? migrateLegacy(stored) : migrateLegacy(legacy)
    const next = {
      channels,
      from: stored?.from ?? legacy.from ?? '',
      fromName: stored?.fromName ?? legacy.fromName ?? '影巢',
      strict: stored?.strict ?? false,
      migratedFrom: stored ? 'single-provider' : 'smtp-settings',
    }
    setSetting('email', next)
    return next
  }
  return stored
}

export function saveEmailSettings(patch) {
  const current = emailSettings()
  const next = { ...current, ...patch }
  if (!Array.isArray(next.channels)) next.channels = current.channels
  setSetting('email', next)
  return next
}

/** 把一条通道的敏感字段解密，得到可直接投递的运行时对象 */
function runtime(channel) {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    enabled: channel.enabled !== false,
    priority: Number(channel.priority ?? 100),
    from: channel.from || channel.smtp?.user || channel.oauth2?.account || '',
    fromName: channel.fromName || emailSettings().fromName || '影巢',
    smtp: {
      host: channel.smtp?.host ?? '',
      port: Number(channel.smtp?.port ?? 465),
      secure: channel.smtp?.secure !== false,
      user: channel.smtp?.user ?? '',
      pass: unseal(channel.smtp?.pass),
      authMode: channel.smtp?.authMode ?? 'auto',
    },
    oauth2: {
      tokenUrl: channel.oauth2?.tokenUrl ?? '',
      deviceUrl: channel.oauth2?.deviceUrl ?? '',
      clientId: channel.oauth2?.clientId ?? '',
      clientSecret: unseal(channel.oauth2?.clientSecret),
      scope: channel.oauth2?.scope ?? '',
      refreshToken: unseal(channel.oauth2?.refreshToken),
      account: channel.oauth2?.account ?? '',
    },
    http: {
      url: channel.http?.url ?? '',
      method: channel.http?.method ?? 'POST',
      headers: channel.http?.headers ?? {},
      body: channel.http?.body ?? '',
      successStatus: channel.http?.successStatus ?? [200, 201, 202],
    },
    apiKey: unseal(channel.apiKey),
  }
}

export function channelList() {
  const settings = emailSettings()
  return settings.channels.map((channel) => {
    const rt = runtime(channel)
    return {
      id: rt.id, name: rt.name, type: rt.type, enabled: rt.enabled, priority: rt.priority,
      from: rt.from, fromName: rt.fromName,
      smtp: { host: rt.smtp.host, port: rt.smtp.port, secure: rt.smtp.secure, user: rt.smtp.user, passSet: Boolean(rt.smtp.pass), authMode: rt.smtp.authMode },
      oauth2: { clientId: rt.oauth2.clientId, scope: rt.oauth2.scope, account: rt.oauth2.account, refreshTokenSet: Boolean(rt.oauth2.refreshToken), tokenUrl: rt.oauth2.tokenUrl, deviceUrl: rt.oauth2.deviceUrl, clientSecretSet: Boolean(rt.oauth2.clientSecret) },
      http: { url: rt.http.url, method: rt.http.method, headers: rt.http.headers, body: rt.http.body, apiKeySet: Boolean(rt.apiKey) },
      lastTest: channel.lastTest ?? null,
    }
  })
}

export function upsertChannel(input) {
  const settings = emailSettings()
  const index = settings.channels.findIndex((channel) => channel.id === input.id)
  const base = index >= 0 ? settings.channels[index] : newChannel(input.type ?? 'smtp')
  const next = { ...base }
  for (const key of ['name', 'type', 'enabled', 'priority', 'from', 'fromName']) {
    if (input[key] !== undefined) next[key] = input[key]
  }
  next.priority = Number(next.priority ?? 100)
  if (input.smtp) {
    next.smtp = { ...base.smtp, ...input.smtp }
    if (input.smtp.pass) next.smtp.pass = seal(input.smtp.pass)
  }
  if (input.oauth2) {
    next.oauth2 = { ...base.oauth2, ...input.oauth2 }
    if (input.oauth2.refreshToken) next.oauth2.refreshToken = seal(input.oauth2.refreshToken)
    if (input.oauth2.clientSecret) next.oauth2.clientSecret = seal(input.oauth2.clientSecret)
  }
  if (input.http) next.http = { ...base.http, ...input.http, successStatus: input.http.successStatus ?? base.http.successStatus }
  if (input.apiKey) next.apiKey = seal(input.apiKey)
  if (input.presetId) next.presetId = input.presetId

  const channels = [...settings.channels]
  if (index >= 0) channels[index] = next
  else channels.push(next)
  saveEmailSettings({ channels })
  return next
}

export function removeChannel(id) {
  const settings = emailSettings()
  saveEmailSettings({ channels: settings.channels.filter((channel) => channel.id !== id) })
}

export function markTest(id, result) {
  const settings = emailSettings()
  const index = settings.channels.findIndex((channel) => channel.id === id)
  if (index < 0) return
  const channels = [...settings.channels]
  channels[index] = { ...channels[index], lastTest: { at: new Date().toISOString(), ok: Boolean(result.ok), message: String(result.message ?? '').slice(0, 240) } }
  saveEmailSettings({ channels })
}

/** OAuth2：refresh_token → access_token（按通道缓存） */
async function accessTokenOf(rt) {
  const cacheKey = `${rt.id}:${rt.oauth2.refreshToken.slice(-12)}`
  const cached = tokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token
  if (!rt.oauth2.tokenUrl || !rt.oauth2.clientId || !rt.oauth2.refreshToken) {
    throw new Error('OAuth2 通道缺少 tokenUrl / clientId / refresh_token')
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: rt.oauth2.clientId,
    refresh_token: rt.oauth2.refreshToken,
  })
  if (rt.oauth2.scope) body.set('scope', rt.oauth2.scope)
  if (rt.oauth2.clientSecret) body.set('client_secret', rt.oauth2.clientSecret)

  const response = await fetch(rt.oauth2.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`token 刷新失败：${json.error ?? response.status} ${String(json.error_description ?? '').slice(0, 160)}`)
  tokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 })
  return json.access_token
}

async function deliverWith(rt, message) {
  if (rt.type === 'http') return httpDeliver(rt, message)
  if (rt.type === 'oauth2') {
    const accessToken = await accessTokenOf(rt)
    return smtpDeliver({ ...rt.smtp, from: rt.from || rt.oauth2.account, fromName: rt.fromName, pass: '' }, message, { mode: 'xoauth2', accessToken })
  }
  return smtpDeliver({ ...rt.smtp, from: rt.from || rt.smtp.user, fromName: rt.fromName }, message, { mode: rt.smtp.authMode })
}

export function mailUnavailable() {
  const channels = channelList().filter((channel) => channel.enabled && channel.type !== 'dev')
  return channels.length === 0
}

/** 按优先级依次尝试，任一成功即返回；全失败时抛出汇总错误 */
export async function sendMail(message) {
  const settings = emailSettings()
  const ordered = settings.channels
    .map(runtime)
    .filter((channel) => channel.enabled && channel.type !== 'dev')
    .sort((a, b) => a.priority - b.priority)

  if (ordered.length === 0) {
    console.warn(`[mail:no-channel] to=${message.to} subject=${message.subject}（未配置可用通道，邮件未投递）`)
    return { delivered: false, reason: 'no_channel' }
  }

  const failures = []
  for (const rt of ordered) {
    try {
      const result = await deliverWith(rt, message)
      markTest(rt.id, { ok: true, message: `发送成功（${new Date().toLocaleString('zh-CN')}）` })
      return { ...result, channel: rt.name || rt.id }
    } catch (error) {
      failures.push(`${rt.name || rt.id}: ${error.message}`)
      markTest(rt.id, { ok: false, message: error.message })
    }
  }
  throw new Error(`所有邮件通道均失败 → ${failures.join(' ； ')}`.slice(0, 600))
}

/** 单通道自检 */
export async function verifyChannel(id, { sendTo } = {}) {
  const channel = emailSettings().channels.find((item) => item.id === id)
  if (!channel) throw new Error('通道不存在')
  const rt = runtime(channel)
  if (rt.type === 'http') {
    if (sendTo) {
      const result = await httpDeliver(rt, { to: sendTo, subject: '影巢 · 通道测试', text: `HTTP 通道可用。\n时间：${new Date().toLocaleString('zh-CN')}` })
      return { ok: true, transport: 'http', result }
    }
    return { ok: true, transport: 'http', note: 'HTTP 通道需实际发送验证，已跳过连接测试' }
  }
  if (rt.type === 'oauth2') {
    const accessToken = await accessTokenOf(rt)
    const smtpCheck = await smtpVerify(
      { ...rt.smtp, from: rt.from || rt.oauth2.account, fromName: rt.fromName, pass: '' },
      { mode: 'xoauth2', accessToken },
    )
    if (!smtpCheck.ok) return { ok: false, error: smtpCheck.error }
    if (sendTo) {
      await smtpDeliver({ ...rt.smtp, from: rt.from || rt.oauth2.account, fromName: rt.fromName, pass: '' }, {
        to: sendTo, subject: '影巢 · 通道测试', text: `OAuth2 通道可用。\n时间：${new Date().toLocaleString('zh-CN')}`,
      }, { mode: 'xoauth2', accessToken })
    }
    return { ok: true, transport: 'oauth2', authMode: smtpCheck.authMode }
  }
  const check = await smtpVerify({ ...rt.smtp, from: rt.from || rt.smtp.user, fromName: rt.fromName }, { mode: rt.smtp.authMode })
  if (!check.ok) return { ok: false, error: check.error }
  if (sendTo) {
    await smtpDeliver({ ...rt.smtp, from: rt.from || rt.smtp.user, fromName: rt.fromName }, {
      to: sendTo, subject: '影巢 · 通道测试', text: `SMTP 通道可用（${check.authMode}）。\n时间：${new Date().toLocaleString('zh-CN')}`,
    }, { mode: rt.smtp.authMode })
  }
  return { ok: true, transport: 'smtp', authMode: check.authMode }
}

export function defaultEmailSettings() {
  return { channels: [], from: '', fromName: '影巢', strict: false }
}


