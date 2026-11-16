/**
 * 把 `scripts/adult-export` 产出的 JSON 写入目标库（另一台机器的生产库）。
 *
 * 用法：
 *   MH_DB=/opt/video-rr/storage/app.db node scripts/adult-migrate.mjs adult-export.json
 *   ... --mode subscription --trial 60     # 会员制 + 试看 60 秒（默认 subscription，可用 MH_ADULT_MODE 覆盖）
 *   ... --dry                              # 只报告将要执行的 DDL 与写入，不写库
 *
 * 图片不在这里同步：用 scp/rsync 把 storage/images/cover-*.jpg 等推过去。
 *
 * 去重与清理（P0-6：曾经把同作者的短剧互相覆盖、还把集数清光）：
 *   - 带 source_key 的条目**只**按 source_key 认领，绝不按标题/副标题回退；
 *   - 不带 source_key 的条目一律 INSERT 新行（永不复用标题命中的旧行）；
 *   - 清理「源站已删掉的集」必须同时满足：导出集号非空、本剧不是无 key 插入的、
 *     导出集数 ≥ 库内原有集数 —— 否则一条 export 就能把 40 集的剧删成 1 集。
 *
 * 事务：DDL（补 remote_* / source_key 列、建索引）与数据写在同一事务里，
 * 失败整体回滚；`--dry` 只打印将执行的 DDL，连库都不改一个字。
 */
import { existsSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { ADULT_MODE_USAGE, resolveAdultMode } from './lib/adult-mode.mjs'
import { shouldPruneEpisodes } from './lib/import-guards.mjs'
import { describeDbTarget, resolveDbPath } from './lib/repo.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback
}
const has = (name) => args.includes(name)

const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'))
if (!file) {
  console.error(`用法：node scripts/adult-migrate.mjs <adult-export.json> [--mode ${ADULT_MODE_USAGE}] [--trial 秒] [--dry]`)
  process.exit(1)
}
// 默认值的唯一来源在 scripts/lib/adult-mode.mjs，别在这里再写一份字面量
const modeResult = resolveAdultMode({ flag: flag('--mode', ''), env: process.env })
if (!modeResult.ok) {
  console.error(modeResult.message)
  process.exit(1)
}
const mode = modeResult.mode
const trial = Number(flag('--trial', '0')) || 0
const dry = has('--dry')

// 库路径以仓库根为基准解析：旧代码 `MH_DB || 'storage/app.db'` 是相对 cwd 的，
// 换个目录跑就会新建一个空库并往里写，看起来成功、线上却没变。
const DB_INFO = resolveDbPath(process.env)
console.log(describeDbTarget(DB_INFO))
if (!existsSync(DB_INFO.path)) {
  console.error(`目标库不存在：${DB_INFO.path}`)
  console.error('（MH_DB 的相对路径按仓库根解析，而不再是当前目录；请确认路径或先初始化库）')
  process.exit(1)
}
if (!existsSync(file)) {
  console.error(`导出文件不存在：${file}`)
  process.exit(1)
}

const db = new DatabaseSync(DB_INFO.path)
const run = (sql, ...params) => db.prepare(sql).run(...params)
const one = (sql, ...params) => db.prepare(sql).get(...params)
const all = (sql, ...params) => db.prepare(sql).all(...params)
const cols = (t) => all(`PRAGMA table_info(${t})`).map((r) => r.name)
// 直链形如 https://<cdn>/hls/<token>/<EXP>/<a>/<b>/<b>.m3u8，EXP 是秒级时间戳
const expiryOfUrl = (url) => Number(/\/hls\/[^/]+\/(\d{9,})\//.exec(String(url ?? ''))?.[1] ?? 0)

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

// 目标库可能是旧版本，先把外部片源四列与 source_key 补上（与 server/db.mjs 的 ensureOpsSchema 同义）。
// 这里只**算出** DDL，真正执行放回下面的事务里：--dry 不写、失败要能整体回滚。
const plannedDdl = []
{
  const episodeCols = cols('episodes')
  for (const name of ['remote_url', 'remote_referer', 'remote_ua', 'remote_cookie']) {
    if (!episodeCols.includes(name)) plannedDdl.push(`ALTER TABLE episodes ADD COLUMN ${name} TEXT`)
  }
  if (!cols('dramas').includes('source_key')) plannedDdl.push('ALTER TABLE dramas ADD COLUMN source_key TEXT')
  const indexRow = one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dramas_source_key'")
  if (!indexRow) plannedDdl.push('CREATE INDEX IF NOT EXISTS idx_dramas_source_key ON dramas(source_key)')
}

const payload = JSON.parse(readFileSync(file, 'utf8'))
const policyCols = cols('content_policies')
const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
let created = 0
let updated = 0
let tagLinks = 0
let staleEpisodes = 0
let unclaimed = 0
// 计数以库内实际增量为准：upsert 分支的 created/updated 会把并发或历史状态算错
const beforeCount = dry ? 0 : one('SELECT count(*) AS n FROM dramas WHERE is_adult = 1')?.n ?? 0

if (dry) {
  console.log('\n[dry] 将执行 DDL：')
  if (!plannedDdl.length) console.log('  （无，结构已是最新）')
  for (const sql of plannedDdl) console.log(`  ${sql}`)
}

/** 逐条写入（dry 时只累加计数并打印）。返回失败条数，供退出码使用。 */
function applyPayload(dramaCols) {
  let failures = 0
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

  for (const item of payload) {
    const source = item.drama ?? {}
    try {
      const values = {}
      for (const key of ADULT_COLUMNS) if (dramaCols.includes(key) && source[key] !== undefined) values[key] = source[key]
      values.is_adult = 1

      // 外部源：带 source_key 的只能用 source_key 认领，绝不按标题回退
      // （短剧的 sub_title 是「AI成人短剧 · 作者」，同作者几十部会互相覆盖）
      const sourceKey = String(source.source_key ?? '').trim()
      if (!sourceKey) unclaimed += 1
      // dry 模式下 source_key 列可能还不存在（DDL 只在真实运行里执行），此时必然认领不到
      const canMatchKey = dramaCols.includes('source_key')
      const exists = sourceKey && canMatchKey ? one('SELECT id FROM dramas WHERE source_key = ?', sourceKey) : null
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
        // 清理判断要用「写集之前」的库内集数，否则刚补进来的集会把下限抬高
        const dbNosBefore = dry ? [] : all('SELECT no FROM episodes WHERE drama_id = ?', dramaId).map((row) => Number(row.no))

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
          // 直链是带保鲜期的签名：本地和生产谁刷得晚用谁的，别拿快过期的盖掉新鲜的
          if (ev.remote_url) {
            const current = one('SELECT remote_url FROM episodes WHERE drama_id = ? AND no = ?', dramaId, ev.no)
            if (expiryOfUrl(current?.remote_url) > expiryOfUrl(ev.remote_url)) ev.remote_url = current.remote_url
          }
          const updateCols = keys.filter((k) => k !== 'no')
          run(
            `INSERT INTO episodes (drama_id, ${keys.join(', ')}, created_at)
             VALUES (?, ${keys.map(() => '?').join(', ')}, ?)
             ON CONFLICT(drama_id, no) DO ${updateCols.length ? `UPDATE SET ${updateCols.map((k) => `${k} = excluded.${k}`).join(', ')}` : 'NOTHING'}`,
            dramaId, ...Object.values(ev), now
          )
        }

        // 源站删减过集数时，目标库里超出范围的老集要清掉，否则详情页会多出播不了的集。
        // 但必须有下限，见 shouldPruneEpisodes 的三条前置条件。
        const exportedNos = (item.episodes ?? []).map((ep) => Number(ep.no)).filter((n) => Number.isInteger(n) && n > 0)
        if (!dry && shouldPruneEpisodes({ exportedNos, dbNos: dbNosBefore, claimedByTitle: !sourceKey })) {
          const info = run(
            `DELETE FROM episodes WHERE drama_id = ? AND no NOT IN (${exportedNos.map(() => '?').join(', ')})`,
            dramaId, ...exportedNos
          )
          if (Number(info.changes) > 0) {
            staleEpisodes += Number(info.changes)
            console.log(`  清理残留集 ${info.changes} 条：${sourceKey || source.title}`)
          }
        } else if (!dry && exportedNos.length) {
          console.log(`  跳过残留集清理：导出 ${exportedNos.length} 集 / 库内 ${dbNosBefore.length} 集${sourceKey ? '' : '（无 source_key）'}`)
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
      console.log(`${dry ? '[dry] ' : ''}${source.sub_title ?? source.title} → drama#${dramaId} 剧集 ${(item.episodes ?? []).length} 标签 ${(item.tags ?? []).length}${sourceKey ? '' : '（无 source_key，按新条目插入）'}`)
    } catch (error) {
      failures += 1
      console.error(`  ✗ ${source.sub_title ?? source.title ?? '(无标题)'}：${error.message}`)
      throw error
    }
  }
  return failures
}

let dramaCols
if (dry) {
  // dry 时不动结构，但要按「DDL 生效后」的列集算 values，避免低估将写入的字段
  dramaCols = cols('dramas')
  if (!dramaCols.includes('source_key')) dramaCols = [...dramaCols, 'source_key']
  applyPayload(dramaCols)
} else {
  // DDL 与数据写在同一事务里：SQLite 支持 DDL 事务，失败能一起回滚
  db.exec('BEGIN')
  try {
    for (const sql of plannedDdl) db.exec(sql)
    dramaCols = cols('dramas')
    applyPayload(dramaCols)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

const added = dry ? created : (one('SELECT count(*) AS n FROM dramas WHERE is_adult = 1')?.n ?? 0) - beforeCount
console.log(`\n${dry ? '[dry] ' : ''}新增 ${added} · 更新 ${created + updated - added} · 标签关联 ${tagLinks} · 清理残留集 ${staleEpisodes} · 无 key 条目 ${unclaimed} · 策略 ${mode}${trial ? ` / 试看 ${trial}s` : ''}`)
