/** 账号与会话：scrypt 口令哈希 + HMAC 签名 token（无第三方依赖）。 */
import { createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { db } from './db.mjs'

const SECRET = process.env.MH_SECRET ?? 'mh-clone-dev-secret-change-me'
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000
// scrypt 默认参数（N=16384, r=8, p=1）与成本写进摘要串，将来调参不影响老数据校验
const SCRYPT_COST = 16384
const SCRYPT_KEYLEN = 32
const HASH_PREFIX = 'scrypt'
const scryptAsync = promisify(scrypt)

/** 定时安全比较：长度不等直接 false，等长才走 timingSafeEqual（避免抛异常泄露长度）。 */
function safeEqualBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** 同上，用于 MAC / 摘要这类文本比较。 */
function safeEqualText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return safeEqualBytes(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function scryptOptions(cost) {
  return cost === SCRYPT_COST ? undefined : { N: cost }
}

/** 自描述摘要：scrypt$<cost>$<salt>$<hexhash>，salt 跟着哈希走，不再依赖单独的 salt 列。 */
function encodeHash(salt, key) {
  return `${HASH_PREFIX}$${SCRYPT_COST}$${salt}$${Buffer.from(key).toString('hex')}`
}

/**
 * 解析存储的摘要：
 * - 新格式 `scrypt$cost$salt$hex` 自带 salt；
 * - 历史数据是裸 hex 摘要，必须由调用方补 salt（第二个参数），否则无法校验。
 */
function parseStoredHash(stored, fallbackSalt) {
  const text = String(stored ?? '')
  if (!text) return undefined
  if (text.startsWith(`${HASH_PREFIX}$`)) {
    const parts = text.split('$')
    if (parts.length !== 4) return undefined
    const cost = Number(parts[1])
    const salt = parts[2]
    const hex = parts[3]
    if (!Number.isInteger(cost) || cost < 1024 || !salt || !/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined
    const hash = Buffer.from(hex, 'hex')
    if (hash.length !== SCRYPT_KEYLEN) return undefined
    return { cost, salt, hash }
  }
  if (fallbackSalt === undefined || fallbackSalt === null || fallbackSalt === '') return undefined
  if (!/^[0-9a-f]+$/i.test(text) || text.length % 2 !== 0) return undefined
  const hash = Buffer.from(text, 'hex')
  if (hash.length !== SCRYPT_KEYLEN) return undefined
  return { cost: SCRYPT_COST, salt: String(fallbackSalt), hash }
}

function verifyParsed(parsed, password) {
  const keylen = parsed.hash.length || SCRYPT_KEYLEN
  const key = scryptSync(String(password), parsed.salt, keylen, scryptOptions(parsed.cost))
  return safeEqualBytes(key, parsed.hash)
}

function verifyParsedAsync(parsed, password) {
  const keylen = parsed.hash.length || SCRYPT_KEYLEN
  return scryptAsync(String(password), parsed.salt, keylen, scryptOptions(parsed.cost))
    .then((key) => safeEqualBytes(Buffer.from(key), parsed.hash))
}

/**
 * 口令哈希。
 * - `hashPassword(password)` → `Promise<string>`：走异步 scrypt，不占用事件循环（新代码一律用这个）。
 * - `hashPassword(password, salt)` → `string`：同步兼容形态，只服务仍然同步的种子/脚本调用
 *   （server/db.mjs 的 seedIfEmpty / ensureAdminCredentials、scripts/reset-admin-password.mjs）。
 *   这些调用点改成 `await` 之后必须删掉这条同步分支。
 */
export function hashPassword(password, salt) {
  if (salt === undefined) {
    const asyncSalt = randomBytes(8).toString('hex')
    return scryptAsync(String(password), asyncSalt, SCRYPT_KEYLEN, scryptOptions(SCRYPT_COST))
      .then((key) => encodeHash(asyncSalt, key))
  }
  return encodeHash(String(salt), scryptSync(String(password), String(salt), SCRYPT_KEYLEN, scryptOptions(SCRYPT_COST)))
}

/**
 * 口令校验。
 * - `verifyPassword(password, stored)` → `Promise<boolean>`：契约形态，异步 scrypt。
 * - `verifyPassword(password, salt, storedHash)` → `boolean`：历史三参形态，同步返回；
 *   仍被 api-public/api-admin/auth 内部未 await 的调用点使用，迁移到 await 后删除。
 * 两条路径都用 timingSafeEqual（先比长度）。
 */
export function verifyPassword(password, second, third) {
  if (third === undefined) {
    const parsed = parseStoredHash(second)
    if (!parsed) return Promise.resolve(false)
    return verifyParsedAsync(parsed, password)
  }
  const parsed = parseStoredHash(third, second)
  if (!parsed) return false
  return verifyParsed(parsed, password)
}

/**
 * 历史数据（salt 与摘要在两列里）的异步校验：迁移期给 api-public / api-admin 的登录、改密接口用，
 * 避免 scryptSync 卡住事件循环。`hash` 已是新格式时会被优先解析，salt 参数可忽略。
 */
export function verifyPasswordAsync(password, salt, hash) {
  const parsed = parseStoredHash(hash, salt)
  if (!parsed) return Promise.resolve(false)
  return verifyParsedAsync(parsed, password)
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
  // MAC 必须定时安全比较（长度不等直接失败），`!==` 会被逐字节计时差异泄露签名前缀
  if (!safeEqualText(mac, expected)) return undefined
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) return undefined
    // 会话必须仍在库中：改密 / 封号 / 主动登出后旧 token 立即失效
    const session = db.prepare('SELECT token, expires_at FROM sessions WHERE token = ?').get(token)
    if (!session) return undefined
    // 库里取回的行再按字节比一次，避免任何按前缀命中的宽松比较
    if (!safeEqualText(session.token, token)) return undefined
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
