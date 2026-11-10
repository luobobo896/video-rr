/** 榜单自动刷新：按用户行为（播放 / 收藏 / 成交）重算，locked=1 的人工条目保持不动。 */
import { db } from './db.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

/** 榜单类型 → 打分口径。窗口 30 天，权重越靠前的行为越"重"。 */
export const RANK_STRATEGIES = {
  HOT: {
    label: '热播榜',
    desc: '近 30 天播放量 + 完播 + 成交',
    sql: `SELECT d.id AS drama_id,
        SUM(CASE WHEN pe.source = 'play' THEN 1 ELSE 0 END) * 1.0
      + SUM(CASE WHEN te.type = 'play_end' THEN 1.0 ELSE 0 END) * 2.0
      + (SELECT COUNT(*) FROM favorites f WHERE f.drama_id = d.id) * 3.0
      + (SELECT COUNT(*) FROM orders o WHERE o.drama_id = d.id AND o.status IN ('paid','fulfilled')) * 5.0 AS score
      FROM dramas d
      LEFT JOIN play_events pe ON pe.drama_id = d.id AND pe.created_at >= datetime('now', '-30 days')
      LEFT JOIN track_events te ON te.drama_id = d.id AND te.type = 'play_end' AND te.created_at >= datetime('now', '-30 days')
      WHERE d.status = 'published'
      GROUP BY d.id HAVING score > 0 ORDER BY score DESC, d.id ASC`,
  },
  RISE: {
    label: '飙升榜',
    desc: '近 7 天播放对比前 7 天',
    sql: `SELECT d.id AS drama_id,
        (SELECT COUNT(*) FROM play_events pe WHERE pe.drama_id = d.id AND pe.created_at >= datetime('now', '-7 days')) * 1.0
      - (SELECT COUNT(*) FROM play_events pe WHERE pe.drama_id = d.id
          AND pe.created_at >= datetime('now', '-14 days') AND pe.created_at < datetime('now', '-7 days')) * 0.5 AS score
      FROM dramas d WHERE d.status = 'published'
      GROUP BY d.id HAVING score > 0 ORDER BY score DESC, d.id ASC`,
  },
  SEARCH: {
    label: '搜索榜',
    desc: '近 30 天搜索命中次数',
    sql: `SELECT te.drama_id AS drama_id, COUNT(*) * 1.0 AS score
      FROM track_events te JOIN dramas d ON d.id = te.drama_id
      WHERE te.type = 'search' AND te.created_at >= datetime('now', '-30 days') AND d.status = 'published'
      GROUP BY te.drama_id HAVING score > 0 ORDER BY score DESC, te.drama_id ASC`,
  },
  CLASSIC: {
    label: '口碑榜',
    desc: '站内评分 × 收藏量',
    sql: `SELECT d.id AS drama_id,
        COALESCE(d.score, 0) * 10.0 + (SELECT COUNT(*) FROM favorites f WHERE f.drama_id = d.id) * 2.0 AS score
      FROM dramas d WHERE d.status = 'published' AND COALESCE(d.score, 0) > 0
      ORDER BY score DESC, d.id ASC`,
  },
  // 以下四种是「抄参考站」补齐的榜：不需要新埋点，全部由现有表算得出来，
  // 保证空库也能排（评分/年份/收藏是静态字段，不依赖任何人先播过）。
  HIGHRATE: {
    label: '高分榜',
    desc: '站内评分（≥8.0）优先，同分看收藏',
    sql: `SELECT d.id AS drama_id,
        COALESCE(d.score, 0) * 10.0 + (SELECT COUNT(*) FROM favorites f WHERE f.drama_id = d.id) * 1.0 AS score
      FROM dramas d WHERE d.status = 'published' AND COALESCE(d.score, 0) >= 8.0
      ORDER BY COALESCE(d.score, 0) DESC, score DESC, d.id ASC`,
  },
  EXPECT: {
    label: '期待榜',
    desc: '未上架/未完结的片子按上架时间倒序（即将上线）',
    sql: `SELECT d.id AS drama_id, 100.0 - ABS(COALESCE(d.year, 2000) - 2030) AS score
      FROM dramas d WHERE d.status IN ('published', 'draft')
      ORDER BY COALESCE(d.year, 2000) DESC, d.id DESC LIMIT 20`,
  },
  QUARTER: {
    label: '季度榜',
    desc: '本季度新上架内容按播放量排序',
    sql: `SELECT d.id AS drama_id,
        (SELECT COUNT(*) FROM play_events pe WHERE pe.drama_id = d.id AND pe.created_at >= datetime('now', '-90 days')) * 1.0
      + COALESCE(d.score, 0) AS score
      FROM dramas d WHERE d.status = 'published' AND d.created_at >= datetime('now', '-90 days')
      ORDER BY score DESC, d.id ASC`,
  },
  HIDDEN: {
    label: '冷门佳作',
    desc: '评分高但播放量低（< 50 次）的内容',
    sql: `SELECT d.id AS drama_id, COALESCE(d.score, 0) * 10.0 AS score
      FROM dramas d
      WHERE d.status = 'published' AND COALESCE(d.score, 0) >= 7.0
        AND (SELECT COUNT(*) FROM play_events pe WHERE pe.drama_id = d.id) < 50
      ORDER BY COALESCE(d.score, 0) DESC, d.id ASC`,
  },
  PLAYLIST: {
    label: '短剧榜',
    desc: '短剧 / 漫剧按播放量',
    sql: `SELECT d.id AS drama_id,
        (SELECT COUNT(*) FROM play_events pe WHERE pe.drama_id = d.id) * 1.0 + COALESCE(d.score, 0) AS score
      FROM dramas d WHERE d.status = 'published' AND d.category = 'PLAYLET'
      ORDER BY score DESC, d.id ASC`,
  },
}

/**
 * 刷新一个榜单：锁定条目原位保留，其余按得分重排填充。
 * @returns {{ listId:number, type:string, kept:number, added:number, removed:number }}
 */
export function refreshRank(listId, { limit = 20 } = {}) {
  const list = all('SELECT * FROM rank_lists WHERE id = ?', Number(listId))[0]
  if (!list) throw Object.assign(new Error('榜单不存在'), { status: 404 })
  const strategy = RANK_STRATEGIES[list.type]
  if (!strategy) throw Object.assign(new Error(`未知榜单类型：${list.type}`), { status: 400 })

  const locked = all('SELECT * FROM rank_items WHERE list_id = ? AND locked = 1 ORDER BY rank_no', list.id)
  const lockedIds = new Set(locked.map((row) => row.drama_id))
  const scored = all(strategy.sql).filter((row) => !lockedIds.has(row.drama_id))

  const keepSlots = new Set(locked.map((row) => row.rank_no))
  const target = Math.max(limit, locked.length)
  const order = []
  let cursor = 0
  for (let slot = 1; slot <= target; slot += 1) {
    if (keepSlots.has(slot)) continue
    if (cursor >= scored.length) break
    order.push({ slot, row: scored[cursor] })
    cursor += 1
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    run('DELETE FROM rank_items WHERE list_id = ? AND locked = 0', list.id)
    const insert = db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no, locked, score) VALUES (?, ?, ?, 0, ?)')
    for (const item of order) insert.run(list.id, item.row.drama_id, item.slot, Number(item.row.score ?? 0))
    run("UPDATE rank_lists SET updated_at = datetime('now') WHERE id = ?", list.id)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  const after = all('SELECT * FROM rank_items WHERE list_id = ?', list.id).length
  return { listId: list.id, type: list.type, kept: locked.length, added: order.length, total: after }
}

export function refreshAutoRanks({ limit = 20 } = {}) {
  const lists = all('SELECT * FROM rank_lists WHERE COALESCE(auto, 1) = 1 ORDER BY sort')
  const results = []
  for (const list of lists) {
    try {
      results.push(refreshRank(list.id, { limit }))
    } catch (error) {
      results.push({ listId: list.id, type: list.type, error: error.message })
    }
  }
  return results
}
