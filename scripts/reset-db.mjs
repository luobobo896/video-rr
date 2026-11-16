/**
 * 清库重建：删掉 SQLite 与转码产物，下次启动重新按种子初始化。
 *
 * 这是不可逆操作，所以必须显式确认：
 *   node scripts/reset-db.mjs --yes
 *   MH_CONFIRM_RESET=1 node scripts/reset-db.mjs
 * 目标库路径与将被删除的目录会先打印出来（MH_DB 指到别处时也看得见）。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { confirmGate, confirmHint } from './lib/confirm.mjs'
import { assertRepoRoot, describeDbTarget, repoRoot, resolveDbPath } from './lib/repo.mjs'

const ROOT = repoRoot()
assertRepoRoot(ROOT)
const DB_INFO = resolveDbPath(process.env)

const TARGETS = [
  DB_INFO.path,
  `${DB_INFO.path}-wal`,
  `${DB_INFO.path}-shm`,
  `${DB_INFO.path}-journal`,
  join(ROOT, 'storage', 'hls'),
  join(ROOT, 'storage', 'uploads'),
  join(ROOT, 'storage', 'images'),
  join(ROOT, 'storage', 'remote-cache'),
]

const gate = confirmGate({ args: process.argv.slice(2), env: process.env })
if (!gate.ok) {
  console.log(describeDbTarget(DB_INFO))
  console.log('将删除：')
  for (const target of TARGETS) console.log(`  - ${target}`)
  console.error(confirmHint({ targets: TARGETS }))
  process.exitCode = 1
} else {
  for (const target of TARGETS) {
    rmSync(target, { recursive: true, force: true })
    console.log('removed', target)
  }
  console.log('完成：下次启动 node server/index.mjs 会重新建库并写入种子数据')
}
