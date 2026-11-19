/**
 * 前台/后台巡检用的临时管理员令牌（只在服务器本地执行，输出一次即作废）。
 * 用法：MH_DB=/opt/video-rr/storage/app.db node scripts/mint-admin-token.mjs admin
 */
import { db } from '../server/db.mjs'
import { issueToken } from '../server/auth.mjs'

const username = process.argv[2] ?? 'admin'
const admin = db.prepare('SELECT id, username FROM admins WHERE username = ?').get(username)
if (!admin) {
  console.error(`没有这个后台账号：${username}`)
  process.exit(1)
}
const token = issueToken(admin.id, 'admin')
console.log(JSON.stringify({ id: admin.id, username: admin.username, token: token.token, expiresAt: token.expiresAt }))
db.close?.()
