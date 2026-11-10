/** 用 data/images.json 把库里指向原站 CDN 的封面/横幅换成本地镜像路径。 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB = process.env.MH_DB ?? join(ROOT, 'storage', 'app.db')
const MAP_FILE = join(ROOT, 'data', 'images.json')

if (!existsSync(MAP_FILE)) {
  console.log('没有 data/images.json，跳过（先跑 scripts/mirror-images.mjs）')
  process.exit(0)
}
const mapping = JSON.parse(readFileSync(MAP_FILE, 'utf8'))
const db = new DatabaseSync(DB)

let dramas = 0
let banners = 0
const updateDrama = db.prepare('UPDATE dramas SET cover_url = ? WHERE cover_url = ?')
const updateBanner = db.prepare('UPDATE banners SET image = ? WHERE image = ?')

for (const [remote, local] of Object.entries(mapping)) {
  dramas += Number(updateDrama.run(local, remote).changes ?? 0)
  banners += Number(updateBanner.run(local, remote).changes ?? 0)
}

const remaining = db.prepare("SELECT COUNT(*) AS n FROM dramas WHERE cover_url LIKE 'http%'").get().n
console.log(`已替换：剧集封面 ${dramas} 行，Banner ${banners} 行；仍指向外部的剧集 ${remaining} 部`)
