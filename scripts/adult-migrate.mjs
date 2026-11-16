/**
 * 把 `scripts/adult-export` 产出的 JSON 写入目标库（另一台机器的生产库）。
 *
 * 用法：
 *   MH_DB=/opt/video-rr/storage/app.db node scripts/adult-migrate.mjs adult-export.json
 *   ... --mode subscription --trial 60     # 会员制 + 试看 60 秒
 *   ... --dry                              # 只报告将要做的写入
 *
 * 图片不在这里同步：用 scp/rsync 把 storage/images/cover-*.jpg 等推过去。
 * 已存在的条目按番号（sub_title）更新，不会重复建条。
 */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const MODE_DEFAULTS = { free: 0, subscription: 0, paid: 0 }

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'))
if (!file) {
  console.error('用法：node scripts/adult-migrate.mjs <adult-export.json> [--mode free|subscription|paid] [--trial 秒] [--dry]')
  process.exit(1)
}
const mode = flag('--mode', 'free')
if (!(mode in MODE_DEFAULTS)) {
  console.error(`--mode 只支持 ${Object.keys(MODE_DEFAULTS).join(' / ')}`)
  process.exit(1)
}
const trial = Number(flag('--trial', '0')) || 0
const dry = has('--dry')

const dbPath = process.env.MH_DB || 'storage/app.db'
const db = new DatabaseSync(dbPath)
const run = (sql, ...params) => db.prepare(sql).run(...params)
const one = (sql, ...params) => db.prepare(sql).get(...params)
const all = (sql, ...params) => db.prepare(sql).all(...params)
const cols = (t) => all(`PRAGMA table_info(${t})`).map((r) => r.name)

const ADULT_COLUMNS = [
  'title', 'sub_title', 'cover_url', 'description', 'year', 'area', 'category',
  'is_adult', 'release_date', 'score', 'status', 'sort', 'content_type', 'published_at',
  'source_key'
]
const EPISODE_COLUMNS = [
  'no', 'title', 'duration', 'remote_url', 'remote_referer', 'remote_ua',
  'remote_cookie', 'status', 'progress'
]
const POLICY_COLUMNS = ['access_mode', 'free_episodes', 'trial_seconds', 'single_price_cny', 'purchase_kind', 'rental_hours']

// 目标库可能是旧版本，先把外部片源四列补上（与 server/db.mjs 的 ensureOpsSchema 同义）
const episodeCols = cols('episodes')
for (const [name, ddl] of [
  ['remote_url', 'TEXT'],
  ['remote_referer', 'TEXT'],
  ['remote_ua', 'TEXT'],
  ['remote_cookie', 'TEXT']
]) {
  if (!episodeCols.includes(name)) run(`ALTER TABLE episodes ADD COLUMN ${name} ${ddl}`)
}
// 短剧按 source_key（huangguo:<id>）去重，旧库缺这一列时补上并建索引
if (!cols('dramas').includes('source_key')) {
  run('ALTER TABLE dramas ADD COLUMN source_key TEXT')
  run('CREATE INDEX IF NOT EXISTS idx_dramas_source_key ON dramas(source_key)')
}

const payload = JSON.parse(readFileSync(file, 'utf8'))
const dramaCols = cols('dramas')
const policyCols = cols('content_policies')
const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
let created = 0
let updated = 0
let tagLinks = 0
let staleEpisodes = 0
// 计数以库内实际增量为准：upsert 分支的 created/updated 会把并发或历史状态算错
const beforeCount = dry ? 0 : one('SELECT count(*) AS n FROM dramas WHERE is_adult = 1')?.n ?? 0

// 短剧的题材标签统一挂到「短劇」根分组下，前端短剧频道据此聚合题材筛选
const dramaRootId = (() => {
  const found = one("SELECT id FROM tags WHERE name = '短劇' AND scope = 'adult'")
  if (found) return found.id
  if (dry) return -1
  run("INSERT INTO tags (name, scope, sort, status) VALUES ('短劇', 'adult', 90, 'active')")
  return one("SELECT id FROM tags WHERE name = '短劇' AND scope = 'adult'").id
})()

const upsertTag = (name, scope, parentId = null) => {
  const found = one('SELECT id FROM tags WHERE name = ?', name)
  if (found) {
    // 老库里短剧标签是平铺的，这里顺手补上父子关系
    if (parentId && parentId > 0 && !dry) {
      run('UPDATE tags SET parent_id = ? WHERE id = ? AND (parent_id IS NULL OR parent_id = 0)', parentId, found.id)
    }
    return found.id
  }
  if (dry) return -1
  run(
    'INSERT INTO tags (name, scope, sort, status, parent_id) VALUES (?, ?, 0, \'active\', ?)',
    name,
    scope || 'adult',
    parentId && parentId > 0 ? parentId : null
  )
  return one('SELECT id FROM tags WHERE name = ?', name).id
}

db.exec('BEGIN')
try {
  for (const item of payload) {
    const source = item.drama
    const values = {}
    for (const key of ADULT_COLUMNS) if (dramaCols.includes(key) && source[key] !== undefined) values[key] = source[key]
    values.is_adult = 1

    // 外部源：带 source_key 的只能用 source_key 认领，绝不按标题回退
    // （短剧的 sub_title 是「AI成人短剧 · 作者」，同作者几十部会互相覆盖）
    const exists = source.source_key
      ? one('SELECT id FROM dramas WHERE source_key = ?', source.source_key)
      : one('SELECT id FROM dramas WHERE is_adult = 1 AND (sub_title = ? OR title = ?)', source.sub_title ?? '', source.title ?? '')
    let dramaId = exists?.id
    if (exists) {
      updated += 1
      if (!dry) {
        const sets = Object.keys(values).map((k) => `${k} = ?`).join(', ')
        run(`UPDATE dramas SET ${sets} WHERE id = ?`, ...Object.values(values), dramaId)
      }
    } else if (dry) {
      created += 1
      dramaId = -1
    } else {
      const keys = [...Object.keys(values), 'created_at', 'updated_at']
      const marks = keys.map(() => '?').join(', ')
      const info = run(
        `INSERT INTO dramas (${keys.join(', ')}) VALUES (${marks})`,
        ...Object.values(values), now, now
      )
      dramaId = Number(info.lastInsertRowid)
      created += 1
    }

    if (dramaId > 0) {
      for (const tag of item.tags ?? []) {
        const isPlaylet = source.category === 'PLAYLET'
        const tagId = upsertTag(tag.name, tag.scope, isPlaylet ? dramaRootId : null)
        if (tagId > 0) {
          if (!dry) run('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)', dramaId, tagId)
          tagLinks += 1
        }
      }

      for (const ep of item.episodes ?? []) {
        const ev = {}
        for (const key of EPISODE_COLUMNS) if (ep[key] !== undefined) ev[key] = ep[key]
        const keys = Object.keys(ev)
        if (dry) continue
        run(
          `INSERT INTO episodes (drama_id, ${keys.join(', ')}, created_at)
           VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
           ON CONFLICT(drama_id, no) DO UPDATE SET ${keys.filter((k) => k !== 'no').map((k) => `${k} = excluded.${k}`).join(', ')}`,
          dramaId, ...Object.values(ev), now
        )
      }

      // 源站删减过集数时，目标库里超出范围的老集要清掉，否则详情页会多出播不了的集
      const nos = (item.episodes ?? []).map((ep) => Number(ep.no)).filter((n) => Number.isInteger(n) && n > 0)
      if (!dry && nos.length) {
        const info = run(
          `DELETE FROM episodes WHERE drama_id = ? AND no NOT IN (${nos.map(() => '?').join(', ')})`,
          dramaId, ...nos
        )
        if (Number(info.changes) > 0) {
          staleEpisodes += Number(info.changes)
          console.log(`  清理残留集 ${info.changes} 条：${source.source_key ?? source.title}`)
        }
      }

      const policy = { drama_id: dramaId, access_mode: mode, free_episodes: 0, trial_seconds: trial, single_price_cny: 0, purchase_kind: 'buy', rental_hours: 0, updated_at: now }
      if (!dry) {
        const pk = Object.keys(policy).filter((k) => policyCols.includes(k))
        run(
          `INSERT INTO content_policies (${pk.join(', ')}) VALUES (${pk.map(() => '?').join(', ')})
           ON CONFLICT(drama_id) DO UPDATE SET ${pk.filter((k) => k !== 'drama_id').map((k) => `${k} = excluded.${k}`).join(', ')}`,
          ...pk.map((k) => policy[k])
        )
      }
    }
    console.log(`${dry ? '[dry] ' : ''}${source.sub_title ?? source.title} → drama#${dramaId} 剧集 ${(item.episodes ?? []).length} 标签 ${(item.tags ?? []).length}`)
  }
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}

console.log(`\n目标库：${dbPath}`)
const added = dry ? created : (one('SELECT count(*) AS n FROM dramas WHERE is_adult = 1')?.n ?? 0) - beforeCount
console.log(`新增 ${added} · 更新 ${created + updated - added} · 标签关联 ${tagLinks} · 清理残留集 ${staleEpisodes} · 策略 ${mode}${trial ? ` / 试看 ${trial}s` : ''}`)
