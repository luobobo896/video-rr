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

export function authOf(req) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : undefined
  if (!token) return undefined
  const payload = verifyToken(token)
  if (!payload) return undefined
  return { token, ...payload }
}
