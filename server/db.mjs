/**
 * SQLite 数据层（node:sqlite，零外部依赖）。
 * 表覆盖：账号、剧集/分集、首页运营、榜单、评论、弹幕、订单、历史收藏、直播、转码任务。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from './auth.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const DB_PATH = process.env.MH_DB ?? join(ROOT, 'storage', 'app.db')

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,
  nickname TEXT NOT NULL,
  avatar TEXT,
  is_vip INTEGER NOT NULL DEFAULT 0,
  vip_expire_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  subject_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS dramas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sub_title TEXT,
  cover_url TEXT,
  description TEXT,
  year INTEGER,
  area TEXT,
  category TEXT,
  score REAL,
  fee_mode TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'published',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  no INTEGER NOT NULL,
  title TEXT,
  duration REAL,
  vip INTEGER NOT NULL DEFAULT 0,
  source_path TEXT,
  hls_path TEXT,
  poster TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (drama_id, no)
);
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, title TEXT, image TEXT,
  target_drama_id INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS section_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rank_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, type TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rank_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES rank_lists(id) ON DELETE CASCADE,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  rank_no INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  drama_id INTEGER NOT NULL REFERENCES dramas(id) ON DELETE CASCADE,
  user_id INTEGER,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS danmus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  user_id INTEGER,
  time_ms INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  sku TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL,
  episode_no INTEGER NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, drama_id)
);
CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL,
  drama_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, drama_id)
);
CREATE TABLE IF NOT EXISTS live_streams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  stream_key TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`)

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n

/** 首次启动：从抓包种子建库，并生成演示账号/评论/弹幕/直播位。 */
export function seedIfEmpty() {
  if (count('dramas') > 0) return { seeded: false }

  const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'seed.json'), 'utf8'))
  const now = new Date().toISOString()

  const insertDrama = db.prepare(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, score, fee_mode, status, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`)
  const dramaIdByKey = new Map()
  const addDrama = (item, sort) => {
    const key = String(item.dramaId ?? item.title)
    if (dramaIdByKey.has(key)) return dramaIdByKey.get(key)
    const info = insertDrama.run(
      item.title ?? '未命名', item.subTitle ?? '', item.coverUrl ?? '',
      item.description ?? '本地种子数据：真实简介来自 /m-station/drama/intro',
      2026, item.area ?? '韩国', item.dramaType ?? 'TV', item.score ?? 8.5,
      item.feeMode === 'vip' ? 'vip' : 'free', sort,
    )
    const id = Number(info.lastInsertRowid)
    dramaIdByKey.set(key, id)
    return id
  }

  db.exec('BEGIN')
  try {
    let sort = 0
    for (const item of seed.searchResults ?? []) addDrama(item, sort++)
    for (const section of seed.sections ?? []) for (const item of section.items ?? []) addDrama(item, sort++)
    for (const banner of seed.banners ?? []) {
      if (banner.targetUrl) addDrama({ dramaId: banner.targetUrl, title: banner.title || banner.name, subTitle: banner.name, coverUrl: banner.image, dramaType: 'TV' }, sort++)
    }

    // 分集：详情数据里的集数优先，其余给 6 集
    const insertEpisode = db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, vip, status) VALUES (?, ?, ?, ?, ?, 'ready')`)
    for (const [, id] of dramaIdByKey) {
      const detailEpisodes = seed.detail && String(seed.detail.seasonId) === String(id) ? seed.detail.episodes : null
      const countEpisodes = detailEpisodes?.length ?? 6
      for (let no = 1; no <= countEpisodes; no++) {
        insertEpisode.run(id, no, `第 ${no} 集`, 2400 + no * 30, no > 1 ? 1 : 0)
      }
    }

    const insertBanner = db.prepare('INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, 1)')
    ;(seed.banners ?? []).forEach((banner, index) => {
      insertBanner.run(banner.name ?? '', banner.title ?? '', banner.image ?? '', dramaIdByKey.get(String(banner.targetUrl)) ?? null, index)
    })

    const insertSection = db.prepare('INSERT INTO sections (title, sort, enabled) VALUES (?, ?, 1)')
    const insertSectionItem = db.prepare('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, ?)')
    ;(seed.sections ?? []).forEach((section, index) => {
      const info = insertSection.run(section.title, index)
      const sectionId = Number(info.lastInsertRowid)
      ;(section.items ?? []).forEach((item, itemIndex) => {
        const dramaId = dramaIdByKey.get(String(item.dramaId))
        if (dramaId) insertSectionItem.run(sectionId, dramaId, itemIndex)
      })
    })

    const insertRankList = db.prepare('INSERT INTO rank_lists (name, type, sort) VALUES (?, ?, ?)')
    const insertRankItem = db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, ?)')
    const rankDefs = [['热播榜', 'HOT'], ['热搜榜', 'SEARCH'], ['飙升榜', 'RISE'], ['经典榜', 'CLASSIC']]
    const dramaIds = [...dramaIdByKey.values()]
    rankDefs.forEach(([name, type], listIndex) => {
      const info = insertRankList.run(name, type, listIndex)
      const listId = Number(info.lastInsertRowid)
      dramaIds.slice(listIndex * 2, listIndex * 2 + 10).forEach((dramaId, itemIndex) => insertRankItem.run(listId, dramaId, itemIndex + 1))
    })

    // 演示账号
    const salt = 'demo-salt'
    const admin = hashPassword('admin123', salt)
    db.prepare('INSERT INTO admins (username, password_hash, salt) VALUES (?, ?, ?)').run('admin', admin, salt)
    db.prepare('INSERT INTO users (phone, nickname, is_vip, vip_expire_at) VALUES (?, ?, 1, ?)').run('13800000000', '演示用户', '2027-01-01 00:00:00')

    // 演示评论 / 弹幕
    const firstDrama = dramaIds[0]
    db.prepare("INSERT INTO comments (drama_id, user_id, content, status) VALUES (?, 1, '追到第三集，节奏真不错', 'approved')").run(firstDrama)
    db.prepare("INSERT INTO comments (drama_id, user_id, content, status) VALUES (?, 1, '这段配乐有点出戏', 'pending')").run(firstDrama)
    const firstEpisode = db.prepare('SELECT id FROM episodes WHERE drama_id = ? ORDER BY no LIMIT 1').get(firstDrama)
    if (firstEpisode) {
      const insertDanmu = db.prepare('INSERT INTO danmus (episode_id, user_id, time_ms, content, status) VALUES (?, 1, ?, ?, ?)')
      for (const [time, text, status] of [[2000, '这剧真的上头', 'approved'], [6000, '前面高能', 'approved'], [9000, '广告位招租', 'pending'], [12000, '弹幕护体', 'approved']]) {
        insertDanmu.run(firstEpisode.id, time, text, status)
      }
    }

    db.prepare("INSERT INTO live_streams (name, stream_key, status) VALUES ('演示直播频道', 'demo', 'idle')").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('site', ?)").run(JSON.stringify({ name: '影巢', vipPrice: '7.3', vipUnit: '元/月' }))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { seeded: true, dramas: count('dramas'), episodes: count('episodes'), at: now }
}

export function getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  try { return JSON.parse(row.value) } catch { return row.value }
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}

export { DB_PATH, ROOT }
