/**
 * 微软邮箱（outlook.com / hotmail.com / live.com）OAuth2 发信：
 * - 设备码授权（device code）拿 refresh_token，无需 redirect URI / 客户端密钥
 * - 用 refresh_token 换 access_token（scope: https://outlook.office.com/SMTP.Send offline_access）
 * - SMTP 走 smtp-mail.outlook.com:587 STARTTLS + AUTH XOAUTH2
 */
const TENANT = 'consumers'
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`
const DEVICE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`
const SCOPE = 'https://outlook.office.com/SMTP.Send offline_access'

export const MS_SMTP = { host: 'smtp-mail.outlook.com', port: 587, secure: false }

const tokenCache = new Map() // refreshToken → { accessToken, expiresAt }

/** 第一步：请求设备码，返回给用户去浏览器输入 */
export async function startDeviceCode(clientId) {
  const res = await fetch(DEVICE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
    signal: AbortSignal.timeout(20000),
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`设备码申请失败：${body.error ?? res.status} ${body.error_description ?? ''}`.slice(0, 240))
  return {
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn: body.expires_in,
    interval: body.interval,
    deviceCode: body.device_code,
    message: body.message,
  }
}

/** 第二步：轮询换 token（authorization_pending 属正常，继续等） */
export async function pollDeviceCode(clientId, deviceCode) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    }),
    signal: AbortSignal.timeout(20000),
  })
  const body = await res.json()
  if (res.ok) {
    return {
      done: true,
      refreshToken: body.refresh_token,
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      account: body.id_token ? decodeAccount(body.id_token) : '',
    }
  }
  const pendingErrors = ['authorization_pending', 'slow_down']
  return { done: false, pending: pendingErrors.includes(body.error), error: body.error, description: body.error_description }
}

function decodeAccount(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return payload.preferred_username || payload.email || payload.upn || ''
  } catch {
    return ''
  }
}

/** refresh_token → access_token（带内存缓存，提前 60 秒过期） */
export async function accessTokenFor({ clientId, refreshToken }) {
  const cached = tokenCache.get(refreshToken)
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, scope: SCOPE }),
    signal: AbortSignal.timeout(20000),
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(`token 刷新失败：${body.error ?? res.status} ${String(body.error_description ?? '').slice(0, 180)}`)
  }
  tokenCache.set(refreshToken, { accessToken: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 })
  if (body.refresh_token && body.refresh_token !== refreshToken) tokenCache.set(body.refresh_token, tokenCache.get(refreshToken))
  return body.access_token
}

export function xoauth2String(user, accessToken) {
  return Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, 'utf8').toString('base64')
}
