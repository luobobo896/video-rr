/**
 * 把本地库里的成人片（含 jable 外部源）导出成 JSON，供 scripts/adult-migrate.mjs 推到生产。
 *
 * 用法：
 *   node scripts/adult-export.mjs                       # 写到 storage/adult-export.json
 *   node scripts/adult-export.mjs /tmp/adult.json       # 指定路径
 *   node scripts/adult-export.mjs --dry                 # 只统计，不写文件
 *   MH_DB=/path/app.db node scripts/adult-export.mjs    # 指定源库（相对路径按仓库根解析）
 *
 * 只导出 is_adult = 1 的条目；图片不在这里同步。
 *
 * 原子写：先写同目录临时文件再 rename —— 直接 writeFileSync 时，scp 恰好抓到写了一半
 * 的文件，生产侧 JSON.parse 会直接炸。`--dry` 不写任何文件（旧实现把 --dry 当成了
 * 输出文件名，于是在仓库根建了个叫 `--dry` 的文件）。
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { writeFileAtomicSync } from './lib/fsx.mjs'
import { describeDbTarget, repoRoot, resolveDbPath, resolveRepoPath } from './lib/repo.mjs'

const args = process.argv.slice(2)
const dry = args.includes('--dry')
const explicit = args.find((item) => !item.startsWith('--'))
const ROOT = repoRoot()
const out = explicit ? resolveRepoPath(explicit, ROOT) : resolveRepoPath('storage/adult-export.json', ROOT)

const DB_INFO = resolveDbPath(process.env)
console.log(describeDbTarget(DB_INFO))
if (!existsSync(DB_INFO.path)) {
  console.error(`源库不存在：${DB_INFO.path}`)
  console.error('（MH_DB 的相对路径按仓库根解析，而不再是当前目录）')
  process.exit(1)
}

const db = new DatabaseSync(DB_INFO.path, { readOnly: true })
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

const withSource = payload.filter((item) => item.episodes.some((ep) => ep.remote_url)).length
const noKey = payload.filter((item) => !String(item.drama.source_key ?? '').trim()).length
if (dry) {
  console.log(`[dry] 不写文件：本来会导出 ${payload.length} 部（其中 ${withSource} 部带外部源，${noKey} 部缺 source_key）→ ${out}`)
} else {
  const written = writeFileAtomicSync(out, JSON.stringify(payload, null, 1))
  console.log(`导出 ${payload.length} 部（其中 ${withSource} 部带外部源，${noKey} 部缺 source_key）→ ${written.path}`)
  if (noKey) console.log('  提示：缺 source_key 的条目在生产侧只能新增、无法幂等更新（adult-migrate 不再按标题认领）')
}
for (const item of payload) {
  const ep = item.episodes[0]
  const exp = Number(/\/hls\/[^/]+\/(\d+)\//.exec(ep?.remote_url ?? '')?.[1] ?? 0)
  const left = exp ? Math.round((exp * 1000 - Date.now()) / 60000) : -1
  console.log(` ${item.drama.sub_title} · 剧集 ${item.episodes.length} · 标签 ${item.tags.length} · 链接剩余 ${left} 分钟`)
}
