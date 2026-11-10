/**
 * 通用 OAuth2 设备码授权（厂家无关）：
 * 任何提供 device code 端点的厂商（微软 / Google 部分场景 / 自定义）都能用。
 * 参数：deviceUrl / tokenUrl / clientId / scope / clientSecret(可选)
 */
export async function startDeviceFlow({ deviceUrl, clientId, scope, clientSecret }) {
  if (!deviceUrl) throw new Error('该通道未配置 deviceUrl（设备码端点）')
  if (!clientId) throw new Error('缺少 clientId')
  const body = new URLSearchParams({ client_id: clientId })
  if (scope) body.set('scope', scope)
  if (clientSecret) body.set('client_secret', clientSecret)

  const response = await fetch(deviceUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`设备码申请失败：${json.error ?? response.status} ${String(json.error_description ?? '').slice(0, 200)}`)
  }
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri ?? json.verification_url,
    verificationUriComplete: json.verification_uri_complete,
    expiresIn: json.expires_in,
    interval: json.interval ?? 5,
    message: json.message,
  }
}

export async function pollDeviceFlow({ tokenUrl, clientId, deviceCode, clientSecret, scope }) {
  if (!tokenUrl) throw new Error('该通道未配置 tokenUrl')
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: clientId,
    device_code: deviceCode,
  })
  if (clientSecret) body.set('client_secret', clientSecret)
  if (scope) body.set('scope', scope)

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(20000),
  })
  const json = await response.json().catch(() => ({}))
  if (response.ok) {
    return {
      done: true,
      refreshToken: json.refresh_token,
      accessToken: json.access_token,
      expiresIn: json.expires_in,
      account: json.id_token ? decodeAccount(json.id_token) : (json.account ?? ''),
    }
  }
  const pending = ['authorization_pending', 'slow_down'].includes(json.error)
  return { done: false, pending, error: json.error, description: json.error_description }
}

export function decodeAccount(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return payload.preferred_username || payload.email || payload.upn || payload.sub || ''
  } catch {
    return ''
  }
}
