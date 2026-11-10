/**
 * 素材镜像：把种子数据里指向原站 CDN 的封面/横幅下载到本地 storage/images，
 * 生成 data/images.json（原 URL → /media/images/xxx），供服务器替换。
 * 本地能访问原 CDN；HK 服务器访问被 403，所以素材必须随代码一起发布。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = 'C:/Users/hanson/Documents/deepseek-harness/default-workspace/mh-clone'
const IMAGES = join(ROOT, 'storage', 'images')
mkdirSync(IMAGES, { recursive: true })

const db = new DatabaseSync(join(ROOT, 'storage', 'app.db'))
const urls = new Map()

for (const row of db.prepare('SELECT id, cover_url FROM dramas').all()) {
  if (row.cover_url && /^https?:/.test(row.cover_url)) urls.set(row.cover_url, { kind: 'drama', id: row.id })
}
for (const row of db.prepare('SELECT id, image FROM banners').all()) {
  if (row.image && /^https?:/.test(row.image)) urls.set(row.image, { kind: 'banner', id: row.id })
}

const mapping = {}
let ok = 0
let failed = 0

for (const url of urls.keys()) {
  const name = `${createHash('sha1').update(url).digest('hex').slice(0, 16)}${(url.match(/\.(jpe?g|png|webp)$/i)?.[0] ?? '.jpg').toLowerCase()}`
  const target = join(IMAGES, name)
  if (existsSync(target) && mapping[url]) { ok++; continue }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://mh.yichengwlkj.com/' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length < 1024) throw new Error('too small')
    writeFileSync(target, buffer)
    mapping[url] = `/media/images/${name}`
    ok++
    process.stdout.write(`\r  ${ok + failed}/${urls.size} 已镜像 ${name.slice(0, 20)}…   `)
  } catch (error) {
    failed++
    console.log(`\n  失败 ${url.slice(0, 80)} -> ${error.message}`)
  }
}

writeFileSync(join(ROOT, 'data', 'images.json'), JSON.stringify(mapping, null, 2), 'utf8')
console.log(`\n完成：成功 ${ok}，失败 ${failed}；映射写入 data/images.json`)
