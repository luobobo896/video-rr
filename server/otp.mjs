/**
 * 邮箱验证码服务：生成、发送、校验、限流、清理。
 *
 * 规则（与需求一致）：
 *  - 6 位数字，有效期 5 分钟；
 *  - 同一邮箱 60 秒内不可重复发送；
 *  - 同一邮箱每日最多 20 条；同一 IP 每小时最多 30 条（防刷补充）；
 *  - 单个验证码最多尝试 3 次，超限后该码作废，必须重新获取；
 *  - 库里只存 HMAC 哈希，不存明文；校验用常量时间比较。
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { db } from './db.mjs'
import { isDevMail, sendMail } from './mailer.mjs'

const SECRET = process.env.MH_OTP_SECRET ?? process.env.MH_SECRET ?? 'mh-otp-dev-secret'
const CODE_TTL_SECONDS = 300          // 5 分钟
const RESEND_COOLDOWN_SECONDS = 60    // 60 秒冷却
const DAILY_LIMIT_PER_EMAIL = 20
const HOURLY_LIMIT_PER_IP = 30
const MAX_ATTEMPTS = 3

export const OTP_RULES = {
  codeLength: 6,
  ttlSeconds: CODE_TTL_SECONDS,
  resendCooldownSeconds: RESEND_COOLDOWN_SECONDS,
  dailyLimitPerEmail: DAILY_LIMIT_PER_EMAIL,
  hourlyLimitPerIp: HOURLY_LIMIT_PER_IP,
  maxAttempts: MAX_ATTEMPTS,
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
const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const secondsBetween = (a, b) => Math.round((new Date(`${b}Z`).getTime() - new Date(`${a}Z`).getTime()) / 1000)

/** 发送前限流检查，抛 OtpError 带上 retryAfter。 */
export function checkSendLimits(email, ip) {
  const last = one('SELECT * FROM email_send_log WHERE email = ? ORDER BY id DESC LIMIT 1', email)
  if (last) {
    const elapsed = secondsBetween(last.created_at, nowSql())
    if (elapsed < RESEND_COOLDOWN_SECONDS) {
      throw new OtpError('send_too_frequent', `发送过于频繁，请 ${RESEND_COOLDOWN_SECONDS - elapsed} 秒后再试`, 429, {
        retryAfter: RESEND_COOLDOWN_SECONDS - elapsed,
      })
    }
  }
  const today = nowSql().slice(0, 10)
  const todayCount = one('SELECT COUNT(*) AS n FROM email_send_log WHERE email = ? AND sent_date = ?', email, today).n
  if (todayCount >= DAILY_LIMIT_PER_EMAIL) {
    throw new OtpError('daily_limit', `该邮箱今日发送已达上限（${DAILY_LIMIT_PER_EMAIL} 次），请明天再试`, 429, {
      dailyLimit: DAILY_LIMIT_PER_EMAIL,
    })
  }
  if (ip) {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    const ipCount = one('SELECT COUNT(*) AS n FROM email_send_log WHERE ip = ? AND created_at >= ?', ip, hourAgo).n
    if (ipCount >= HOURLY_LIMIT_PER_IP) {
      throw new OtpError('ip_limit', '当前网络发送过于频繁，请稍后再试', 429)
    }
  }
}

/**
 * 生成并发送验证码。
 * @returns {Promise<{email:string, expiresIn:number, devCode?:string}>}
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

  const subjectMap = {
    login: '影巢 · 登录验证码',
    change_password: '影巢 · 修改密码验证码',
    change_email: '影巢 · 更换邮箱验证码',
  }
  const text = [
    '您好，',
    '',
    `您正在${purpose === 'login' ? '登录影巢' : purpose === 'change_password' ? '修改密码' : '更换绑定邮箱'}，验证码：`,
    '',
    `    ${code}`,
    '',
    `验证码 ${CODE_TTL_SECONDS / 60} 分钟内有效，最多尝试 ${MAX_ATTEMPTS} 次。`,
    '如非本人操作，请忽略本邮件。',
    '',
    '—— 影巢',
  ].join('\r\n')

  let delivered = false
  try {
    const result = await sendMail({ to: email, subject: subjectMap[purpose], text })
    delivered = result.delivered
  } catch (error) {
    console.error('[otp] 邮件发送失败', email, error.message)
    throw new OtpError('mail_failed', '验证码邮件发送失败，请稍后重试', 502)
  }

  return {
    email,
    purpose,
    expiresIn: CODE_TTL_SECONDS,
    resendAfter: RESEND_COOLDOWN_SECONDS,
    delivered,
    // 只有「显式开发模式 + 未配置 SMTP」才回显验证码；一旦配好发信，验证码只进邮箱
    devCode: process.env.MH_EMAIL_DEV === '1' && isDevMail() ? code : undefined,
  }
}

/**
 * 校验验证码：成功即消费；失败累计 attempts，达到上限后作废。
 */
export function verifyCode({ email: rawEmail, purpose = 'login', code }) {
  const email = normalizeEmail(rawEmail)
  const input = String(code ?? '').trim()
  if (!/^\d{6}$/.test(input)) throw new OtpError('code_format_invalid', '验证码应为 6 位数字')

  const record = one(`SELECT * FROM email_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL
    ORDER BY id DESC LIMIT 1`, email, purpose)
  if (!record) throw new OtpError('code_not_found', '验证码已失效，请重新获取')
  if (record.attempts >= record.max_attempts) {
    throw new OtpError('code_locked', '验证码尝试次数过多，请重新获取', 429)
  }
  if (secondsBetween(nowSql(), record.expires_at) <= 0) {
    run("UPDATE email_codes SET consumed_at = datetime('now') WHERE id = ?", record.id)
    throw new OtpError('code_expired', '验证码已过期，请重新获取', 410)
  }

  const expected = Buffer.from(record.code_hash, 'hex')
  const actual = Buffer.from(hashCode(email, input), 'hex')
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual)

  if (!ok) {
    const attempts = record.attempts + 1
    run('UPDATE email_codes SET attempts = ? WHERE id = ?', attempts, record.id)
    if (attempts >= record.max_attempts) {
      run("UPDATE email_codes SET consumed_at = datetime('now') WHERE id = ?", record.id)
      throw new OtpError('code_locked', '验证码错误次数过多，已作废，请重新获取', 429, { attempts })
    }
    throw new OtpError('code_invalid', `验证码错误，还可尝试 ${record.max_attempts - attempts} 次`, 400, { attempts })
  }

  run("UPDATE email_codes SET consumed_at = datetime('now') WHERE id = ?", record.id)
  return { email, purpose, consumedAt: nowSql() }
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
