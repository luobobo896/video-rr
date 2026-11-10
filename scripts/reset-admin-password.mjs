#!/usr/bin/env node
/**
 * 重置后台账号口令（运维用）
 *
 *   node scripts/reset-admin-password.mjs <用户名> [新口令]
 *
 * 不给新口令时自动生成 16 位随机口令并打印；重置后该账号下次登录会被强制改密。
 * 用于：初始凭据文件丢失、人员离职、口令泄露。
 */
import { randomBytes } from 'node:crypto'
import { db, ensureAdminSchema } from '../server/db.mjs'
import { hashPassword } from '../server/auth.mjs'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
function randomPassword(length = 16) {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length]
  // 保证同时含字母与数字
  if (!/[A-Za-z]/.test(out) || !/[0-9]/.test(out)) return randomPassword(length)
  return out
}

const username = process.argv[2]
if (!username) {
  console.error('用法：node scripts/reset-admin-password.mjs <用户名> [新口令]')
  process.exit(1)
}

ensureAdminSchema() // 老库补列（must_change_password / password_updated_at）
const row = db.prepare('SELECT id, username, display_name FROM admins WHERE username = ?').get(username)
if (!row) {
  console.error(`账号不存在：${username}`)
  const all = db.prepare('SELECT username FROM admins ORDER BY id').all()
  console.error(`现有账号：${all.map((item) => item.username).join(' / ')}`)
  process.exit(1)
}

const password = process.argv[3] || randomPassword()
if (password.length < 12) {
  console.error('口令至少 12 位（后台策略要求含字母与数字）')
  process.exit(1)
}
const salt = randomBytes(16).toString('hex')
db.prepare('UPDATE admins SET password_hash = ?, salt = ?, must_change_password = 1, password_updated_at = ? WHERE id = ?')
  .run(hashPassword(password, salt), salt, new Date().toISOString(), row.id)

console.log(`已重置 ${row.username}（${row.display_name ?? ''}）`)
console.log(`新口令：${password}`)
console.log('下次登录会被要求立即修改。')
