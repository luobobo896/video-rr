/** 账号与会话：scrypt 口令哈希 + HMAC 签名 token（无第三方依赖）。 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { db } from './db.mjs'

const SECRET = process.env.MH_SECRET ?? 'mh-clone-dev-secret-change-me'
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000

export function hashPassword(password, salt = randomBytes(8).toString('hex')) {
  const hash = scryptSync(String(password), salt, 32).toString('hex')
  return hash
}

export function verifyPassword(password, salt, expectedHash) {
  const actual = scryptSync(String(password), salt, 32)
  const expected = Buffer.from(expectedHash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

const b64 = (value) => Buffer.from(value).toString('base64url')

export function signToken(payload) {
  const body = b64(JSON.stringify(payload))
  const mac = createHmac('sha256', SECRET).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return undefined
  const [body, mac] = token.split('.')
  const expected = createHmac('sha256', SECRET).update(body).digest('base64url')
  if (mac !== expected) return undefined
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) return undefined
    // 会话必须仍在库中：改密 / 封号 / 主动登出后旧 token 立即失效
    const session = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(token)
    if (!session) return undefined
    if (Number(session.expires_at) < Date.now()) return undefined
    return payload
  } catch { return undefined }
}

export function issueToken(subjectId, role) {
  const payload = { sub: subjectId, role, exp: Date.now() + TOKEN_TTL_MS }
  const token = signToken(payload)
  db.prepare('INSERT OR REPLACE INTO sessions (token, subject_id, role, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, subjectId, role, payload.exp)
  return { token, expiresAt: payload.exp }
}

export function revokeToken(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/** 吊销某个账号的全部会话（改密 / 封号时调用）。 */
export function revokeSessions(subjectId, role) {
  const info = role
    ? db.prepare('DELETE FROM sessions WHERE subject_id = ? AND role = ?').run(subjectId, role)
    : db.prepare('DELETE FROM sessions WHERE subject_id = ?').run(subjectId)
  return Number(info?.changes ?? 0)
}

export function loginAdmin(username, password) {
  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username)
  if (!admin) return undefined
  if (!verifyPassword(password, admin.salt, admin.password_hash)) return undefined
  return issueToken(admin.id, 'admin')
}

export function loginUserByPhone(phone, nickname) {
  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone)
  if (!user) {
    const info = db.prepare('INSERT INTO users (phone, nickname) VALUES (?, ?)').run(phone, nickname ?? `用户${phone.slice(-4)}`)
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid))
  }
  return { user, ...issueToken(user.id, 'user') }
}

/* ---------------- 邮箱认证 ---------------- */

/** 口令强度：≥8 位，且同时包含字母与数字。 */
export function checkPasswordStrength(password) {
  const value = String(password ?? '')
  if (value.length < 8) return { ok: false, message: '密码至少 8 位' }
  if (!/[A-Za-z]/.test(value)) return { ok: false, message: '密码需包含字母' }
  if (!/\d/.test(value)) return { ok: false, message: '密码需包含数字' }
  return { ok: true }
}

/** 邮箱登录/注册一体：存在即登录，不存在自动建号。 */
export function loginByEmail(rawEmail, { nickname } = {}) {
  const email = String(rawEmail).trim().toLowerCase()
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  let created = false
  if (!user) {
    const fallback = email.split('@')[0].slice(0, 20) || '影巢用户'
    const info = db.prepare(`INSERT INTO users (email, nickname, email_verified_at, last_login_at)
      VALUES (?, ?, datetime('now'), datetime('now'))`).run(email, nickname ?? fallback)
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid))
    created = true
  } else {
    if (user.status === 'banned') {
      const error = new Error('账号已被禁用，请联系客服')
      error.code = 'user_banned'
      throw error
    }
    db.prepare("UPDATE users SET last_login_at = datetime('now'), email_verified_at = COALESCE(email_verified_at, datetime('now')) WHERE id = ?").run(user.id)
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)
  }
  return { user, created, ...issueToken(user.id, 'user') }
}

export function setUserPassword(userId, password) {
  const strength = checkPasswordStrength(password)
  if (!strength.ok) {
    const error = new Error(strength.message)
    error.code = 'password_weak'
    throw error
  }
  const salt = randomBytes(8).toString('hex')
  const hash = hashPassword(password, salt)
  db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(hash, salt, userId)
  return { ok: true }
}

export function hasPassword(userId) {
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId)
  return Boolean(user?.password_hash)
}

export function changeUserEmail(userId, newEmail) {
  const email = String(newEmail).trim().toLowerCase()
  const taken = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email, userId)
  if (taken) {
    const error = new Error('该邮箱已被其他账号使用')
    error.code = 'email_taken'
    throw error
  }
  db.prepare("UPDATE users SET email = ?, email_verified_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(email, userId)
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
}

const PROFILE_FIELDS = {
  nickname: (value) => {
    const text = String(value ?? '').trim()
    if (text.length < 2 || text.length > 20) throw Object.assign(new Error('昵称需 2–20 个字符'), { code: 'nickname_invalid' })
    return text
  },
  avatar: (value) => {
    const text = String(value ?? '').trim()
    if (text && !/^\/media\/images\/avatars\/[a-zA-Z0-9._-]+$/.test(text)) {
      throw Object.assign(new Error('头像地址不合法'), { code: 'avatar_invalid' })
    }
    return text || null
  },
  birthday: (value) => {
    const text = String(value ?? '').trim()
    if (!text) return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(text))) {
      throw Object.assign(new Error('生日格式应为 YYYY-MM-DD'), { code: 'birthday_invalid' })
    }
    const year = Number(text.slice(0, 4))
    if (year < 1900 || year > new Date().getFullYear()) {
      throw Object.assign(new Error('生日年份不合法'), { code: 'birthday_invalid' })
    }
    return text
  },
  gender: (value) => {
    const text = String(value ?? '').trim()
    if (!text) return null
    if (!['male', 'female', 'other', 'secret'].includes(text)) {
      throw Object.assign(new Error('性别取值不合法'), { code: 'gender_invalid' })
    }
    return text
  },
  bio: (value) => {
    const text = String(value ?? '').trim()
    if (text.length > 120) throw Object.assign(new Error('个人简介最多 120 字'), { code: 'bio_invalid' })
    return text || null
  },
}

export function updateProfile(userId, patch) {
  const updates = {}
  for (const [key, validate] of Object.entries(PROFILE_FIELDS)) {
    if (patch[key] === undefined) continue
    updates[key] = validate(patch[key])
  }
  if (Object.keys(updates).length === 0) return db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
  const assignments = Object.keys(updates).map((key) => `${key} = ?`).join(', ')
  db.prepare(`UPDATE users SET ${assignments}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(updates), userId)
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
}

export function publicUser(user) {
  if (!user) return undefined
  return {
    id: user.id,
    email: user.email,
    nickname: user.nickname,
    avatar: user.avatar,
    birthday: user.birthday,
    gender: user.gender,
    bio: user.bio,
    hasPassword: Boolean(user.password_hash),
    status: user.status,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  }
}

/**
 * 校验 token 并确认账号仍然可登录（封禁即时生效）。
 * 之前只验签名+过期，封禁只拦登录入口，已发出的 token 还能用满 7 天。
 */
export function authOf(req) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) return undefined
  const payload = verifyToken(token)
  if (!payload) return undefined
  const id = Number(payload.sub)
  if (!id) return undefined
  if (payload.role === 'admin') {
    const admin = db.prepare('SELECT id, status FROM admins WHERE id = ?').get(id)
    if (!admin || admin.status !== 'active') return undefined
  } else {
    const user = db.prepare('SELECT id, status FROM users WHERE id = ?').get(id)
    if (!user || user.status !== 'active') return undefined
  }
  return { token, ...payload }
}
