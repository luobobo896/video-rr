/**
 * server/api-public.mjs 安全修复回归测试。
 *
 * 关注点：试看计量（P0-1/P0-2）、验证码回显（P0-3）、登录失败计数（P1-4）、
 * 成人年龄凭证（P1-6）、readBody（P1-9）、搜索原型链与 LIKE 转义（P2-18）、
 * 回调体积上限（P1-8）、数值白名单（P2-17）。
 *
 * 隔离方式：mkdtemp 临时 MH_DB + 随机端口真实 HTTP 服务。绝不触碰 storage/app.db。
 */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

const WORK_DIR = mkdtempSync(join(tmpdir(), 'mh-api-public-'))
process.env.MH_DB = join(WORK_DIR, 'app.db')
process.env.NODE_ENV = 'test'
process.env.MH_OTP_TEST = '1'
delete process.env.MH_ALLOW_VISITOR_HEADER
delete process.env.MH_NOTIFY_MAX_BYTES

const { db } = await import('../server/db.mjs')
const { hashPassword } = await import('../server/auth.mjs')
const { handlePublic } = await import('../server/api-public.mjs')

const PASSWORD = 'Passw0rd!ok'
const PASSWORD_HASH = await hashPassword(PASSWORD)

function seedDrama({ title, category = 'TV', isAdult = 0, status = 'published', trialSeconds = 0, accessMode = 'paid', price = 9.9, episodes = 1 }) {
  const drama = db.prepare(`INSERT INTO dramas (title, category, is_adult, status, content_type, score, sort)
    VALUES (?, ?, ?, ?, 'series', 8.5, 0)`).run(title, category, isAdult, status)
  const dramaId = Number(drama.lastInsertRowid)
  db.prepare(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind)
    VALUES (?, ?, 0, ?, ?, 'single')`).run(dramaId, accessMode, trialSeconds, price)
  const episodeIds = []
  for (let no = 1; no <= episodes; no += 1) {
    const row = db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, hls_path, status)
      VALUES (?, ?, ?, 1800, ?, 'ready')`).run(dramaId, no, `第 ${no} 集`, `/media/hls/${dramaId}/index.m3u8`)
    episodeIds.push(Number(row.lastInsertRowid))
  }
  return { dramaId, episodeIds }
}

function seedUser(email, nickname = '测试用户') {
  const row = db.prepare(`INSERT INTO users (email, nickname, password_hash, email_verified_at)
    VALUES (?, ?, ?, datetime('now'))`).run(email, nickname, PASSWORD_HASH)
  return Number(row.lastInsertRowid)
}

const trial = seedDrama({ title: '试看测试剧', trialSeconds: 90 })
const visitorDrama = seedDrama({ title: '访客试看测试剧', trialSeconds: 90 })
const adultDrama = seedDrama({ title: '成人测试短剧', category: 'PLAYLET', isAdult: 1, trialSeconds: 0 })
const hiddenDrama = seedDrama({ title: '下架测试剧', status: 'hidden', trialSeconds: 0 })

const trialUserId = seedUser('trial-user@example.test')
seedUser('profile-user@example.test', '资料测试')
seedUser('lock-user@example.test', '锁定测试')

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  Promise.resolve(handlePublic(url.pathname, url, req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ code: '0500', msg: String(error?.message ?? error) }))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const PORT = server.address().port

after(() => {
  server.close()
  // Windows 下 SQLite 句柄关闭前删目录会 EPERM：先关连接再尽力清理，清理失败不影响测试结论
  try { db.close() } catch {}
  try { rmSync(WORK_DIR, { recursive: true, force: true }) } catch {}
})

/** 发起真实 HTTP 请求；body 为对象时自动 JSON 序列化，chunks 用于自定义分块写入。 */
function call(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': 'node-test', 'x-mh-lang': 'zh', ...(options.headers ?? {}) }
    const request = createRequest({ pathname, method: options.method ?? 'GET', headers }, resolve, reject)
    if (options.chunks) {
      let index = 0
      const writeNext = () => {
        if (index >= options.chunks.length) return request.end()
        request.write(options.chunks[index])
        index += 1
        setTimeout(writeNext, 20)
      }
      writeNext()
      return
    }
    if (options.body !== undefined) {
      if (Buffer.isBuffer(options.body)) {
        request.write(options.body)
      } else {
        const body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
        if (!headers['content-type']) headers['content-type'] = 'application/json'
        request.write(body)
      }
    }
    request.end()
  })
}

function createRequest({ pathname, method, headers }, resolve, reject) {
  const request = httpRequest({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (response) => {
    const chunks = []
    response.on('data', (chunk) => chunks.push(chunk))
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let json = null
      try { json = JSON.parse(text) } catch { json = null }
      resolve({
        status: response.statusCode,
        headers: response.headers,
        text,
        json,
        cookies: response.headers['set-cookie'] ?? [],
      })
    })
  })
  request.on('error', reject)
  return request
}

async function login(email) {
  const response = await call('/api/auth/email/password', { method: 'POST', body: { email, password: PASSWORD } })
  assert.equal(response.status, 200, `登录失败：${response.text}`)
  return response.json.data
}

function cookieOf(response, name) {
  const hit = response.cookies.find((item) => item.startsWith(`${name}=`))
  return hit ? hit.split(';')[0] : ''
}

test('登录用户同一部剧第二次试看即被限额，且签发试看专用短链', async () => {
  const { token } = await login('trial-user@example.test')
  const auth = { authorization: `Bearer ${token}` }
  const first = await call(`/api/play/${trial.dramaId}/1?trial=1`, { headers: auth })
  assert.equal(first.status, 200, first.text)
  const data = first.json.data
  assert.equal(data.source, 'trial')
  assert.equal(data.trialSeconds, 90)
  assert.match(data.hls, /^\/media\/trial\/\d+\/index\.m3u8\?/)
  assert.match(data.hls, /sec=90/)
  assert.ok(!data.hls.includes('/media/hls/'), '试看不得再签发整集目录的播放地址')
  assert.equal(data.trialBudget.windows, 1)

  const second = await call(`/api/play/${trial.dramaId}/1?trial=1`, { headers: auth })
  assert.equal(second.status, 402, second.text)
  assert.equal(second.json.data.code, 'trial_exhausted')
  const retryAfterSeconds = Number(second.json.data.retryAfterSeconds)
  assert.ok(retryAfterSeconds >= 4 && retryAfterSeconds <= 15, `retryAfterSeconds 越界：${retryAfterSeconds}`)

  // 登录态必须落库计量：一次授权一条，事后可审计
  const counted = db.prepare("SELECT COUNT(*) AS n FROM trial_uses WHERE subject_kind = 'user' AND subject = ? AND drama_id = ?")
    .get(String(trialUserId), trial.dramaId)
  assert.equal(counted.n, 1)
})

test('访客换 x-mh-visitor 头不能重置试看额度，且伪造 Cookie 会被当新访客', async () => {
  const first = await call(`/api/play/${visitorDrama.dramaId}/1?trial=1`, { headers: { 'x-mh-visitor': 'visitor-a' } })
  assert.equal(first.status, 200, first.text)
  const visitorCookie = cookieOf(first, 'mh_visitor')
  assert.ok(visitorCookie, '首次试看必须由服务端下发 mh_visitor Cookie')
  assert.match(first.cookies.join('\n'), /mh_visitor=[^;]+;.*HttpOnly/i)

  // 同一个 Cookie，额度必须共享
  const second = await call(`/api/play/${visitorDrama.dramaId}/1?trial=1`, {
    headers: { cookie: visitorCookie, 'x-mh-visitor': 'visitor-b' },
  })
  assert.equal(second.status, 402, second.text)
  assert.equal(second.json.data.code, 'trial_exhausted')

  // 伪造签名的 mh_visitor：不信任客户端原值，重新签发
  const forged = `mh_visitor=${encodeURIComponent(`v1.hacker.${'a'.repeat(32)}`)}`
  const forgedRetry = await call(`/api/play/${visitorDrama.dramaId}/1?trial=1`, { headers: { cookie: forged } })
  assert.equal(forgedRetry.status, 200, forgedRetry.text)
  const reissued = cookieOf(forgedRetry, 'mh_visitor')
  assert.ok(reissued && reissued !== forged, '伪造的访客 Cookie 必须被丢弃并重新签发')
})

test('游客试看仅累计可见且正在推进的播放', async () => {
  const first = await call(`/api/play/${visitorDrama.dramaId}/1?trial=1`)
  assert.equal(first.status, 200, first.text)
  const session = first.json.data.viewSessionId
  const cookie = cookieOf(first, 'mh_visitor')
  const usage = () => db.prepare('SELECT seconds_used FROM trial_uses WHERE view_session_id = ?').get(session).seconds_used
  const beat = async (positionSeconds, playing, visible) => {
    db.prepare("UPDATE content_view_sessions SET last_heartbeat_at = datetime('now', '-4 seconds') WHERE id = ?").run(session)
    const result = await call(`/api/play/session/${session}/heartbeat`, {
      method: 'POST', headers: { cookie }, body: { positionSeconds, playing, visible },
    })
    assert.equal(result.status, 200, result.text)
  }
  assert.equal(usage(), 0)
  await beat(4, false, true)
  await beat(7, true, false)
  await beat(7, true, true)
  assert.equal(usage(), 0)
  await beat(10, true, true)
  assert.equal(usage(), 3)
})

test('验证码接口在测试钩子关闭时不回传 testCode', async () => {
  const previous = process.env.MH_OTP_TEST
  process.env.MH_OTP_TEST = '0'
  try {
    const response = await call('/api/auth/email/send', { method: 'POST', body: { email: 'no-hook@example.test' } })
    assert.equal(response.json?.data?.testCode, undefined)
    assert.ok(!response.text.includes('testCode'), '响应体不得包含 testCode 字段')
  } finally {
    process.env.MH_OTP_TEST = previous
  }
})

test('测试钩子开启时仅回环地址能看到 testCode', async () => {
  const local = await call('/api/auth/email/send', { method: 'POST', body: { email: 'hook-loopback@example.test' } })
  assert.equal(local.status, 200, local.text)
  assert.match(String(local.json.data.testCode), /^\d{6}$/)

  const remoteResponse = fakeResponse()
  const remoteRequest = Readable.from([Buffer.from(JSON.stringify({ email: 'hook-remote@example.test' }))])
  Object.assign(remoteRequest, {
    method: 'POST',
    headers: { 'user-agent': 'node-test' },
    socket: { remoteAddress: '203.0.113.9' },
  })
  await handlePublic('/api/auth/email/send', new URL('http://127.0.0.1/api/auth/email/send'), remoteRequest, remoteResponse)
  assert.equal(remoteResponse.statusCode, 200, remoteResponse.rawBody)
  assert.equal(remoteResponse.json.data.testCode, undefined)
})

test('生产模式下验证码响应 JSON 里没有 testCode 字段', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousHook = process.env.MH_OTP_TEST
  process.env.NODE_ENV = 'production'
  process.env.MH_OTP_TEST = '1'
  try {
    const response = await call('/api/auth/email/send', { method: 'POST', body: { email: 'prod-mode@example.test' } })
    assert.ok(!response.text.includes('testCode'), `生产模式响应不得含 testCode：${response.text}`)
    assert.equal(response.json?.data?.testCode, undefined)
  } finally {
    process.env.NODE_ENV = previousNodeEnv
    process.env.MH_OTP_TEST = previousHook
  }
})

test('成人列表未确认年龄凭证时返回 gated，确认后正常返回', async () => {
  const state = await call('/api/adult/state')
  assert.equal(state.status, 200)
  assert.equal(state.json.data.enabled, false)

  const gated = await call('/api/category?audience=adult')
  assert.equal(gated.status, 200, '门禁必须是 200，不能 403 把前端打崩')
  assert.equal(gated.json.data.gated, true)
  assert.deepEqual(gated.json.data.items, [])
  assert.equal(gated.json.data.total, 0)

  const confirm = await call('/api/adult/confirm', { method: 'POST' })
  assert.equal(confirm.status, 200)
  const adultCookie = cookieOf(confirm, 'mh_adult')
  assert.ok(adultCookie, '确认接口必须种 mh_adult Cookie')
  assert.match(confirm.cookies.join('\n'), /mh_adult=[^;]+;.*HttpOnly/i)

  const enabledState = await call('/api/adult/state', { headers: { cookie: adultCookie } })
  assert.equal(enabledState.json.data.enabled, true)

  const opened = await call('/api/category?audience=adult', { headers: { cookie: adultCookie } })
  assert.equal(opened.status, 200)
  assert.equal(opened.json.data.gated, false)
  assert.ok(opened.json.data.list.some((item) => item.title === '成人测试短剧'))
})

test('readBody 跨块 UTF-8 不乱码', async () => {
  const { token } = await login('profile-user@example.test')
  const bio = '跨块中文🧪测试：蓝光花园'
  const payload = Buffer.from(JSON.stringify({ bio }), 'utf8')
  const splitAt = payload.indexOf(Buffer.from('跨', 'utf8')) + 1
  assert.ok(splitAt > 0)
  const response = await call('/api/me/profile', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    chunks: [payload.subarray(0, splitAt), payload.subarray(splitAt)],
  })
  assert.equal(response.status, 200, response.text)
  const me = await call('/api/me', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(me.json.data.user.bio, bio)
})

test('坏 JSON 请求体返回 400 而不是静默当成空对象', async () => {
  const { token } = await login('profile-user@example.test')
  const response = await call('/api/me/profile', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: '{"bio":"没写完',
  })
  assert.equal(response.status, 400, response.text)
  assert.equal(response.json.code, '0400')
})

test('搜索 keyword=constructor 不再 500，通配符按字面量转义', async () => {
  const prototypeKey = await call('/api/search?keyword=constructor')
  assert.equal(prototypeKey.status, 200, prototypeKey.text)
  assert.ok(Array.isArray(prototypeKey.json.data.list))

  const wildcard = await call('/api/search?keyword=%25')
  assert.equal(wildcard.status, 200, wildcard.text)
  assert.ok(Array.isArray(wildcard.json.data.list))

  const underscore = await call('/api/search?keyword=_')
  assert.equal(underscore.status, 200, underscore.text)
})

test('支付宝回调请求体超过上限返回 413', async () => {
  const response = await call('/api/notify/alipay', { method: 'POST', body: 'x'.repeat(70 * 1024) })
  assert.equal(response.status, 413, `${response.status} ${response.text.slice(0, 120)}`)
})

test('邮箱密码登录连续失败会锁定，正确口令仍可登录', async () => {
  const email = 'lock-user@example.test'
  let last = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await call('/api/auth/email/password', { method: 'POST', body: { email, password: 'wrong-password' } })
    assert.equal(last.status, 401, last.text)
  }
  const locked = await call('/api/auth/email/password', { method: 'POST', body: { email, password: PASSWORD } })
  assert.equal(locked.status, 429, locked.text)
  assert.equal(locked.json.data.code, 'login_locked')
  // 登录锁定沿用后台同一套 10 分钟锁（600s），不是试看/发码的秒级冷却
  const retryAfterSeconds = Number(locked.json.data.retryAfterSeconds)
  assert.ok(retryAfterSeconds >= 4, `retryAfterSeconds 越界：${retryAfterSeconds}`)
})

test('换邮箱缺少旧邮箱验证码或当前口令时给出明确错误码', async () => {
  const { token } = await login('trial-user@example.test')
  const auth = { authorization: `Bearer ${token}` }
  const noOldCode = await call('/api/auth/email/change', {
    method: 'POST',
    headers: auth,
    body: { newEmail: 'next@example.test', code: '123456' },
  })
  assert.equal(noOldCode.status, 400, noOldCode.text)
  assert.equal(noOldCode.json.code, 'old_code_required')

  const noPassword = await call('/api/auth/email/change', {
    method: 'POST',
    headers: auth,
    body: { newEmail: 'next@example.test', code: '123456', oldCode: '654321' },
  })
  assert.equal(noPassword.status, 400, noPassword.text)
  assert.equal(noPassword.json.code, 'password_required')
})

test('不存在的第 0 集不会因为首集免费被判为可看', async () => {
  const { token } = await login('trial-user@example.test')
  const response = await call(`/api/access/${trial.dramaId}/0`, { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200, response.text)
  assert.equal(response.status, 200)
  assert.equal(response.json.data.allow, false)
  assert.equal(response.json.data.reason, 'invalid_episode')
})

test('弹幕与观看历史会校验剧集存在且已发布', async () => {
  const { token } = await login('profile-user@example.test')
  const auth = { authorization: `Bearer ${token}` }
  const danmu = await call('/api/danmu', {
    method: 'POST',
    headers: auth,
    body: { episodeId: hiddenDrama.episodeIds[0], timeMs: 1000, content: '测试弹幕' },
  })
  assert.equal(danmu.status, 404, danmu.text)

  const history = await call('/api/me/history', {
    method: 'POST',
    headers: auth,
    body: { dramaId: 999999, episode: 1, position: 10 },
  })
  assert.equal(history.status, 404, history.text)
})

test('分类接口缺省 pageSize 为 24，且单请求 SQL 条数不超过 8', async () => {
  const original = db.prepare.bind(db)
  let statements = 0
  db.prepare = (sql) => { statements += 1; return original(sql) }
  try {
    const response = await call('/api/category')
    assert.equal(response.status, 200, response.text)
    assert.equal(response.json.data.pageSize, 24, '缺省 pageSize 不能被 Number(null)=0 夹成 1')
    assert.equal(response.json.data.list.length, Math.min(24, response.json.data.total))
    assert.ok(statements <= 8, `分类接口单请求 SQL 条数过多：${statements}`)
  } finally {
    db.prepare = original
  }
})

test('榜单历史快照里未上架的剧不再下发', async () => {
  const list = db.prepare("INSERT INTO rank_lists (name, type, sort) VALUES ('回归测试榜', 'REGTEST', 99)").run()
  const visible = seedDrama({ title: '榜单可见剧' })
  db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, 1)').run(Number(list.lastInsertRowid), visible.dramaId)
  db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, 2)').run(Number(list.lastInsertRowid), hiddenDrama.dramaId)

  const response = await call('/api/rank?type=REGTEST')
  assert.equal(response.status, 200, response.text)
  const titles = response.json.data.items.map((item) => item.title)
  assert.ok(titles.includes('榜单可见剧'))
  assert.ok(!titles.includes('下架测试剧'), '下架剧的榜单项不能泄漏')
})

test('消息中心把已过期订阅标成已到期，剩余天数不会出现负数', async () => {
  const plan = db.prepare("INSERT INTO plans (code, name, price_cny, duration_days, scope) VALUES ('regtest-plan', '回归测试套餐', 9.9, 30, 'all')").run()
  const user = db.prepare("SELECT id FROM users WHERE email = 'profile-user@example.test'").get()
  db.prepare(`INSERT INTO subscriptions (user_id, plan_id, scope, valid_from, valid_to, status)
    VALUES (?, ?, 'all', datetime('now', '-60 days'), datetime('now', '-30 days'), 'active')`)
    .run(user.id, Number(plan.lastInsertRowid))
  const { token } = await login('profile-user@example.test')
  const response = await call('/api/me/messages', { headers: { authorization: `Bearer ${token}` } })
  assert.equal(response.status, 200, response.text)
  const message = response.json.data.messages.find((item) => item.type === 'subscription')
  assert.ok(message, '应有会员提醒')
  assert.equal(message.status, 'expired')
  assert.equal(message.daysLeft, 0)
  assert.ok(!String(message.body).includes('-30'), '过期提醒不能显示负天数')
})

test('头像上传按魔数校验，伪装成 PNG 的文本会被拒绝', async () => {
  const { token } = await login('profile-user@example.test')
  const response = await call('/api/me/avatar', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
    body: Buffer.from('this is definitely not a png'),
  })
  assert.equal(response.status, 400, response.text)
  assert.match(response.text, /PNG|JPEG|WebP/)
})

test('搜索埋点同一访客同关键词 10 分钟只记一次', async () => {
  const trialResponse = await call(`/api/play/${visitorDrama.dramaId}/1?trial=1`)
  const visitorCookie = cookieOf(trialResponse, 'mh_visitor')
  assert.ok(visitorCookie)
  const headers = { cookie: visitorCookie }
  const first = await call('/api/track', { method: 'POST', headers, body: { type: 'search', term: '回归测试关键词' } })
  assert.equal(first.status, 200, first.text)
  const second = await call('/api/track', { method: 'POST', headers, body: { type: 'search', term: '回归测试关键词' } })
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json.data.deduped, true)
  const counted = db.prepare("SELECT COUNT(*) AS n FROM track_events WHERE type = 'search'").get()
  assert.equal(counted.n, 1)
})

function fakeResponse() {
  const headers = new Map()
  return {
    statusCode: 0,
    rawBody: '',
    headers,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value) },
    getHeader(name) { return headers.get(String(name).toLowerCase()) },
    writeHead(status, extra) {
      this.statusCode = status
      for (const [name, value] of Object.entries(extra ?? {})) headers.set(String(name).toLowerCase(), value)
    },
    end(chunk) { this.rawBody += chunk ?? '' },
    get json() {
      try { return JSON.parse(this.rawBody) } catch { return null }
    },
  }
}
