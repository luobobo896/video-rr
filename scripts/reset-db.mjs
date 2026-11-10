/** 清库重建：删掉 SQLite 与转码产物，下次启动重新按种子初始化。 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('..', import.meta.url)))
for (const target of ['storage/app.db', 'storage/app.db-wal', 'storage/app.db-shm', 'storage/hls', 'storage/uploads']) {
  rmSync(join(ROOT, target), { recursive: true, force: true })
  console.log('removed', target)
}
console.log('完成：下次启动 node server/index.mjs 会重新建库并写入种子数据')
