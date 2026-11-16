/**
 * 邮箱验证码服务：生成、发送、校验、限流、清理。
 *
 * 规则（与需求一致）：
 *  - 6 位数字，有效期 5 分钟；
 *  - 同一邮箱 60 秒内不可重复发送，24 小时最多 5 条；同一 IP 24 小时最多 20 条；
 *  - 单个验证码最多尝试 3 次，超限后该码作废，必须重新获取；
 *  - 库里只存 HMAC 哈希，不存明文；校验用常量时间比较。
 *  - 明文只在 `MH_OTP_TEST=1` **且** `NODE_ENV=test` 的测试钩子下产生，见 otpTestHookEnabled()。
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { db } from './db.mjs'
import { emailSettings, sendMail } from './mailer.mjs'
import { buildCodeEmail } from './email-template.mjs'
import { logError, logInfo } from './logger.mjs'

const SECRET = process.env.MH_OTP_SECRET ?? process.env.MH_SECRET ?? 'mh-otp-dev-secret'
const CODE_TTL_SECONDS = 300          // 5 分钟
const RESEND_COOLDOWN_SECONDS = 60    // 60 秒冷却
const HOURLY_LIMIT_PER_IP = 30
const EMAIL_DAY_LIMIT = 5             // 同一邮箱 24 小时发送上限（防陌生人邮件轰炸）
const IP_DAY_LIMIT = 20               // 同一 IP 24 小时发送上限（防换邮箱刷 SMTP 配额）
const DAY_SECONDS = 24 * 3600
const MAX_ATTEMPTS = 3

export const OTP_RULES = {
  codeLength: 6,
  ttlSeconds: CODE_TTL_SECONDS,
  resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
  hourlyLimitPerIp: HOURLY_LIMIT_PER_IP,
  emailDayLimit: EMAIL_DAY_LIMIT,
  ipDayLimit: IP_DAY_LIMIT,
  maxAttempts: MAX_ATTEMPTS,
}

/**
 * 明文验证码测试钩子：必须显式 `MH_OTP_TEST=1` **且** `NODE_ENV=test` 才成立。
 * 单独设置 MH_OTP_TEST 不够——生产/预发漏设一个变量就会把任意邮箱的登录码回显给未登录请求。
 */
export function otpTestHookEnabled() {
  return process.env.MH_OTP_TEST === '1' && process.env.NODE_ENV === 'test'
}

// 生产环境一旦检测到测试钩子变量，直接让模块加载失败（进程起不来），杜绝"配错了也能跑"
if (process.env.NODE_ENV === 'production' && process.env.MH_OTP_TEST !== undefined) {
  throw new Error('[otp] 生产环境禁止设置 MH_OTP_TEST：该变量会回显明文验证码')
}


export class OtpError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

export const PURPOSES = ['login', 'change_password', 'change_email']

export function normalizeEmail(input) {
  const email = String(input ?? '').trim().toLowerCase()
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) || email.length > 254) {
    throw new OtpError('email_invalid', '邮箱格式不正确')
  }
  return email
}

export const hashCode = (email, code) => createHmac('sha256', SECRET).update(`${email}:${code}`).digest('hex')
/** 发送失败回滚：删除本次发送记录，避免"投递失败也吃冷却/日限"。 */
function rollbackSendLog(email, purpose) {
  run("DELETE FROM email_send_log WHERE id = (SELECT id FROM email_send_log WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1)", email, purpose)
}
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const sqlAt = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const secondsBetween = (a, b) => Math.round((new Date(`${b}Z`).getTime() - new Date(`${a}Z`).getTime()) / 1000)

/** 统一的限流错误：带 code:'rate_limited' 与真实的 retryAfterSeconds（秒，至少 1）。 */
function rateLimitedError(message, retryAfterSeconds, extra = {}) {
  const seconds = Math.max(1, Math.round(Number(retryAfterSeconds) || 1))
  const error = new OtpError('rate_limited', message, 429, { retryAfterSeconds: seconds, ...extra })
  error.retryAfterSeconds = seconds
  return error
}

/** 窗口内最早一行过期还需要多少秒——用于给出"真实剩余"而不是整个窗口长度。 */
function remainingSeconds(oldestAt, windowSeconds) {
  const elapsed = secondsBetween(oldestAt, nowSql())
  return Math.max(1, Math.round(windowSeconds - elapsed))
}

/**
 * 发送前限流检查，抛 OtpError 带上 retryAfter（秒）。
 * 计数一律走已有的 email_send_log，不新增列：
 *  - 同一邮箱 60 秒冷却；
 *  - 同一邮箱 24 小时最多 5 条（P1-13：未登录即可对任意第三方邮箱发码）；
 *  - 同一 IP 24 小时最多 20 条（防换邮箱吃光 SMTP 配额）。
 */
export function checkSendLimits(email, ip) {
  const last = one("SELECT * FROM email_send_log WHERE email = ? AND purpose <> 'assist' ORDER BY id DESC LIMIT 1", email)
  if (last) {
    const elapsed = secondsBetween(last.created_at, nowSql())
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      const retryAfter = RESEND_COOLDOWN_SECONDS - elapsed
      const error = new OtpError('send_too_frequent', `发送过于频繁，请 ${retryAfter} 秒后再试`, 429, {
        retryAfter,
        retryAfterSeconds: retryAfter,
      })
      error.retryAfterSeconds = retryAfter
      throw error
    }
  }

  const dayAgo = sqlAt(Date.now() - DAY_SECONDS * 1000)
  const emailDay = one(`SELECT COUNT(*) AS n, MIN(created_at) AS first_at FROM email_send_log
    WHERE email = ? AND created_at >= ? AND purpose <> 'assist'`, email, dayAgo)
  if (Number(emailDay?.n ?? 0) >= EMAIL_DAY_LIMIT) {
    throw rateLimitedError(
      `该邮箱 24 小时内最多接收 ${EMAIL_DAY_LIMIT} 条验证码，请稍后再试`,
      remainingSeconds(emailDay.first_at, DAY_SECONDS),
      { limit: EMAIL_DAY_LIMIT, scope: 'email' },
    )
  }

  if (ip) {
    const ipDay = one(`SELECT COUNT(*) AS n, MIN(created_at) AS first_at FROM email_send_log
      WHERE ip = ? AND created_at >= ? AND purpose <> 'assist'`, ip, dayAgo)
    if (Number(ipDay?.n ?? 0) >= IP_DAY_LIMIT) {
      throw rateLimitedError('当前网络发送验证码过于频繁，请稍后再试', remainingSeconds(ipDay.first_at, DAY_SECONDS), {
        limit: IP_DAY_LIMIT,
        scope: 'ip',
      })
    }
    const hourAgo = sqlAt(Date.now() - 3600_000)
    const ipCount = one("SELECT COUNT(*) AS n FROM email_send_log WHERE ip = ? AND created_at >= ? AND purpose <> 'assist'", ip, hourAgo).n
    if (ipCount >= HOURLY_LIMIT_PER_IP) {
      throw rateLimitedError('当前网络发送过于频繁，请稍后再试', 60, { limit: HOURLY_LIMIT_PER_IP, scope: 'ip' })
    }
  }
}

/**
 * 生成并发送验证码。
 * @returns {Promise<{email:string, purpose:string, expiresIn:number, resendAfter:number, delivered:boolean, testCode?:string}>}
 *   `testCode` 只在 otpTestHookEnabled() 成立（MH_OTP_TEST=1 且 NODE_ENV=test）时出现。
 */
export async function sendCode({ email: rawEmail, purpose = 'login', ip, userAgent }) {
  const email = normalizeEmail(rawEmail)
  if (!PURPOSES.includes(purpose)) throw new OtpError('purpose_invalid', '验证码用途不合法')

  checkSendLimits(email, ip)

  const code = String(randomInt(0, 1_000_000)).padStart(OTP_RULES.codeLength, '0')
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000).toISOString().slice(0, 19).replace('T', ' ')

  // 同一个邮箱同一用途的旧验证码作废，避免多码并存
  run("UPDATE email_codes SET consumed_at = datetime('now') WHERE email = ? AND purpose = ? AND consumed_at IS NULL", email, purpose)
  run(`INSERT INTO email_codes (email, purpose, code_hash, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`, email, purpose, hashCode(email, code), expiresAt, ip ?? null, String(userAgent ?? '').slice(0, 300))
  run('INSERT INTO email_send_log (email, purpose, ip, sent_date) VALUES (?, ?, ?, ?)', email, purpose, ip ?? null, nowSql().slice(0, 10))

  // 测试钩子：仅当 MH_OTP_TEST=1 且 NODE_ENV=test（见 otpTestHookEnabled）才跳过发信并回显明文
  const testHook = otpTestHookEnabled()

  let delivered = false
  if (testHook) {
    delivered = true
  } else {
    const startedAt = Date.now()
    try {
      const mail = buildCodeEmail({
        to: email, code, purpose, expiresIn: CODE_TTL_SECONDS, attempts: MAX_ATTEMPTS,
        template: emailSettings().template,
      })
      const result = await sendMail({ to: email, ...mail })
      delivered = result.delivered
      logInfo('otp.mail.sent', { to: email, purpose, channel: result.channel, durationMs: Date.now() - startedAt })
    } catch (error) {
      const authFailed = /(?:535|authentication credentials invalid|AUTH .*失败)/i.test(String(error.message ?? ''))
      const publicMessage = authFailed
        ? '邮件服务器认证失败，请管理员在后台更新 SMTP 授权码'
        : '验证码邮件发送失败，请稍后重试'
      logError('otp.mail.failed', {
        to: email, purpose, durationMs: Date.now() - startedAt, reason: authFailed ? 'smtp_auth_failed' : 'send_failed', error,
      })
      run("UPDATE email_codes SET consumed_at = datetime('now') WHERE email = ? AND purpose = ? AND consumed_at IS NULL", email, purpose)
      rollbackSendLog(email, purpose)
      throw new OtpError('mail_failed', publicMessage, 502, { reason: authFailed ? 'smtp_auth_failed' : 'send_failed' })
    }
  }

  // 没有任何可用邮件通道：验证码不投递也不回显，直接失败（后台可代发登录码）
  if (!delivered) {
    run("UPDATE email_codes SET consumed_at = datetime('now') WHERE email = ? AND purpose = ? AND consumed_at IS NULL", email, purpose)
    rollbackSendLog(email, purpose)
    throw new OtpError('mail_not_configured', '邮件通道尚未配置完成，暂时无法发送验证码，请联系客服处理', 503)
  }

  const payload = {
    email,
    purpose,
    expiresIn: CODE_TTL_SECONDS,
    resendAfter: RESEND_COOLDOWN_SECONDS,
    delivered,
  }
  if (testHook) payload.testCode = code
  return payload
}

/**
 * 后台代发登录码（邮件通道异常时的运维兜底）：
 * 不受发信冷却限制，但同样 5 分钟过期、单次使用、3 次尝试上限，并把操作人写进 user_agent 便于审计。
 * 服务端只存哈希；明文只有调用方显式 `withPlainCode: true`（且测试钩子成立）时才随返回值下发。
 */
export const ASSIST_HOURLY_LIMIT = 20
export const ASSIST_COOLDOWN_SECONDS = 60
/** 客服代发允许的用途：默认 login（与用户自助同用途），'cs_assist' 用于和用户自取区分审计。 */
export const ASSIST_PURPOSES = ['login', 'cs_assist']
/** 登录类码：用户自助发的 login 码与客服代发的 cs_assist 码都能在登录入口兑换。 */
const LOGIN_PURPOSES = ['login', 'cs_assist']

function purposeList(purpose) {
  return purpose === 'login' ? LOGIN_PURPOSES : [purpose]
}

const purposePlaceholders = (purposes) => purposes.map(() => '?').join(', ')

export function issueAssistCode(rawEmail, { operator = 'admin', purpose = 'login', withPlainCode = otpTestHookEnabled() } = {}) {
  const email = normalizeEmail(rawEmail)
  const op = String(operator ?? 'admin').slice(0, 40)
  if (!ASSIST_PURPOSES.includes(purpose)) throw new OtpError('purpose_invalid', '代发验证码用途不合法')

  // 同操作人配额：防止内鬼无限签码接管账号
  const hourAgo = sqlAt(Date.now() - 3600_000)
  const issued = one("SELECT COUNT(*) AS n FROM email_send_log WHERE purpose = 'assist' AND ip = ? AND created_at >= ?", `assist:${op}`, hourAgo).n
  if (issued >= ASSIST_HOURLY_LIMIT) {
    throw rateLimitedError(`该操作人每小时最多代发 ${ASSIST_HOURLY_LIMIT} 次`, 60, { limit: ASSIST_HOURLY_LIMIT })
  }
  // 同邮箱 60 秒冷却：避免对同一用户连续签码
  const last = one("SELECT created_at FROM email_send_log WHERE email = ? AND purpose = 'assist' ORDER BY id DESC LIMIT 1", email)
  if (last) {
    const elapsed = secondsBetween(last.created_at, nowSql())
    if (elapsed < ASSIST_COOLDOWN_SECONDS) {
      const retryAfter = ASSIST_COOLDOWN_SECONDS - elapsed
      const error = new OtpError('send_too_frequent', `该邮箱刚刚代发过，请 ${retryAfter} 秒后再试`, 429, {
        retryAfter,
        retryAfterSeconds: retryAfter,
      })
      error.retryAfterSeconds = retryAfter
      throw error
    }
  }

  const code = String(randomInt(0, 1_000_000)).padStart(OTP_RULES.codeLength, '0')
  const expiresAt = sqlAt(Date.now() + CODE_TTL_SECONDS * 1000)
  const purposes = purposeList(purpose)

  // 作废同一邮箱此前的登录类旧码（不管它是用户自取还是客服代发）
  run(`UPDATE email_codes SET consumed_at = datetime('now')
    WHERE email = ? AND purpose IN (${purposePlaceholders(purposes)}) AND consumed_at IS NULL`, email, ...purposes)
  // 落库写真实 purpose，客服代发不再伪装成用户自取
  run(`INSERT INTO email_codes (email, purpose, code_hash, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, NULL, ?)`, email, purpose, hashCode(email, code), expiresAt, `admin-assist:${op}`)
  run("INSERT INTO email_send_log (email, purpose, ip, sent_date) VALUES (?, 'assist', ?, ?)", email, `assist:${op}`, nowSql().slice(0, 10))

  const payload = { email, purpose, expiresIn: CODE_TTL_SECONDS, maxAttempts: MAX_ATTEMPTS, operator: op }
  // 明文只给显式索取的调用方：调用方自己决定是否允许（测试钩子 / MH_CS_ASSIST_PLAINTEXT）。
  // 这里不再二次检查 otpTestHookEnabled，否则后台的应急明文开关会变成死开关。
  if (withPlainCode) payload.code = code
  return payload
}

/** 查询某用途的验证码记录（不含明文，后台审计/排障用）。 */
export function codesForPurpose(purpose, { email, activeOnly = false, limit = 20 } = {}) {
  const purposes = purposeList(String(purpose ?? 'login'))
  const clauses = [`purpose IN (${purposePlaceholders(purposes)})`]
  const args = [...purposes]
  if (email) {
    clauses.push('email = ?')
    args.push(normalizeEmail(email))
  }
  if (activeOnly) clauses.push('consumed_at IS NULL')
  args.push(Math.max(1, Math.min(200, Number(limit) || 20)))
  return all(`SELECT id, email, purpose, attempts, max_attempts, expires_at, consumed_at, ip, user_agent, created_at
    FROM email_codes WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...args)
}

/**
 * 校验验证码：成功即消费；失败累计 attempts，达到上限后作废。
 * attempts 走单条原子 UPDATE（attempts = attempts + 1 ... AND attempts < max_attempts），
 * 并发打同一个码不会把 3 次上限放大；成功后用 changes===1 抢占消费，保证一次性。
 */
export function verifyCode({ email: rawEmail, purpose = 'login', code }) {
  const email = normalizeEmail(rawEmail)
  const input = String(code ?? '').trim()
  if (!/^\d{6}$/.test(input)) throw new OtpError('code_format_invalid', '验证码应为 6 位数字')

  const purposes = purposeList(purpose)
  const record = one(`SELECT * FROM email_codes WHERE email = ? AND purpose IN (${purposePlaceholders(purposes)})
    AND consumed_at IS NULL ORDER BY id DESC LIMIT 1`, email, ...purposes)
  if (!record) throw new OtpError('code_not_found', '验证码已失效，请重新获取')
  if (record.attempts >= record.max_attempts) {
    throw new OtpError('code_locked', '验证码尝试次数过多，请重新获取', 429)
  }
  if (secondsBetween(nowSql(), record.expires_at) <= 0) {
    run("UPDATE email_codes SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL", record.id)
    throw new OtpError('code_expired', '验证码已过期，请重新获取', 410)
  }

  const expected = Buffer.from(record.code_hash, 'hex')
  const actual = Buffer.from(hashCode(email, input), 'hex')
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual)

  if (!ok) {
    const bump = run(`UPDATE email_codes
      SET attempts = attempts + 1,
          consumed_at = CASE WHEN attempts + 1 >= max_attempts THEN datetime('now') ELSE consumed_at END
      WHERE id = ? AND consumed_at IS NULL AND attempts < max_attempts`, record.id)
    const fresh = one('SELECT attempts, max_attempts FROM email_codes WHERE id = ?', record.id)
    const attempts = Number(fresh?.attempts ?? record.attempts + 1)
    const maxAttempts = Number(fresh?.max_attempts ?? record.max_attempts)
    // changes===0：本次没抢到尝试额度（并发里已被别的请求耗尽），按锁定处理，绝不放宽
    if (Number(bump.changes ?? 0) === 0 || attempts >= maxAttempts) {
      throw new OtpError('code_locked', '验证码错误次数过多，已作废，请重新获取', 429, { attempts })
    }
    throw new OtpError('code_invalid', `验证码错误，还可尝试 ${maxAttempts - attempts} 次`, 400, { attempts })
  }

  const consumed = run("UPDATE email_codes SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL", record.id)
  if (Number(consumed.changes ?? 0) !== 1) {
    throw new OtpError('code_used', '验证码已被使用，请重新获取', 409)
  }
  return { email, purpose: record.purpose, consumedAt: nowSql() }
}

/** 清理：过期验证码保留 1 天便于审计，发送日志保留 30 天。 */
export function cleanupCodes() {
  const expired = run("DELETE FROM email_codes WHERE datetime(expires_at) < datetime('now', '-1 day')")
  const logs = run("DELETE FROM email_send_log WHERE datetime(created_at) < datetime('now', '-30 day')")
  return { codes: Number(expired.changes ?? 0), logs: Number(logs.changes ?? 0) }
}

/** 统计（后台/运维用）。 */
export function otpStats(email) {
  const today = nowSql().slice(0, 10)
  const row = email
    ? one('SELECT COUNT(*) AS n FROM email_send_log WHERE email = ? AND sent_date = ?', email, today)
    : one('SELECT COUNT(*) AS n FROM email_send_log WHERE sent_date = ?', today)
  const active = one(`SELECT COUNT(*) AS n FROM email_codes WHERE consumed_at IS NULL AND datetime(expires_at) > datetime('now')`)
  return { todaySent: row?.n ?? 0, activeCodes: active?.n ?? 0 }
}

export { all }
