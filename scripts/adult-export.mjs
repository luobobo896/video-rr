/**
 * 把本地库里的成人片（含 jable 外部源）导出成 JSON，供 scripts/adult-migrate.mjs 推到生产。
 *
 * 用法：
 *   node scripts/adult-export.mjs                       # 写到 storage/adult-export.json
 *   node scripts/adult-export.mjs /tmp/adult.json       # 指定路径
 *   MH_DB=/path/app.db node scripts/adult-export.mjs    # 指定源库
 *
 * 只导出 is_adult = 1 的条目；图片不在这里同步。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const out = process.argv[2] || 'storage/adult-export.json'
const db = new DatabaseSync(process.env.MH_DB || 'storage/app.db', { readOnly: true })
const all = (sql, ...params) => db.prepare(sql).all(...params)
const one = (sql, ...params) => db.prepare(sql).get(...params)

const dramas = all('SELECT * FROM dramas WHERE is_adult = 1 ORDER BY id')
const payload = dramas.map((drama) => ({
  drama,
  episodes: all('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no', drama.id),
  tags: all(
    'SELECT t.name, t.scope FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.drama_id = ?',
    drama.id
  ),
  policy: one('SELECT * FROM content_policies WHERE drama_id = ?', drama.id) ?? null
}))

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(payload, null, 1))
const withSource = payload.filter((item) => item.episodes.some((ep) => ep.remote_url)).length
console.log(`导出 ${payload.length} 部（其中 ${withSource} 部带外部源）→ ${out}`)
for (const item of payload) {
  const ep = item.episodes[0]
  const exp = Number(/\/hls\/[^/]+\/(\d+)\//.exec(ep?.remote_url ?? '')?.[1] ?? 0)
  const left = exp ? Math.round((exp * 1000 - Date.now()) / 60000) : -1
  console.log(` ${item.drama.sub_title} · 剧集 ${item.episodes.length} · 标签 ${item.tags.length} · 链接剩余 ${left} 分钟`)
}
