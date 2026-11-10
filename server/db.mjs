/**
 * 数据层 v2：内容策略 / 套餐 / 权益 / 订单支付 / 退款 / 优惠券 / RBAC / 审计。
 * 直播相关表与代码已移除（无直播场景）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from './auth.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
const DB_PATH = process.env.MH_DB ?? join(ROOT, 'storage', 'app.db')

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,
  nickname TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  subject_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 后台账号与 RBAC =====
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  display_name TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS permissions (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL REFERENCES permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_code)
);
CREATE TABLE IF NOT EXISTS admin_roles (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (admin_id, role_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  ip TEXT,
  result TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- ===== 内容 =====
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
  source_path TEXT,
  hls_path TEXT,
  status TEXT NOT NULL DEFAULT 'ready',
  progress INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (drama_id, no)
);
-- 内容级付费策略（免费集数 / 试看秒数 / 单片价格）
CREATE TABLE IF NOT EXISTS content_policies (
  drama_id INTEGER PRIMARY KEY REFERENCES dramas(id) ON DELETE CASCADE,
  access_mode TEXT NOT NULL DEFAULT 'subscription',   -- free | subscription | paid
  free_episodes INTEGER NOT NULL DEFAULT 0,
  trial_seconds INTEGER NOT NULL DEFAULT 0,
  single_price_cny REAL NOT NULL DEFAULT 0,
  purchase_kind TEXT NOT NULL DEFAULT 'single',        -- single | rental
  rental_hours INTEGER NOT NULL DEFAULT 72,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== 商业化 =====
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  price_cny REAL NOT NULL,
  duration_days INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',                   -- all | category:TV 等
  description TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  discount_type TEXT NOT NULL,                          -- amount | percent
  discount_value REAL NOT NULL,
  min_amount REAL NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,                     -- 0 = 不限
  used INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  out_trade_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_type TEXT NOT NULL,                           -- subscription | single
  plan_id INTEGER,
  drama_id INTEGER,
  amount_cny REAL NOT NULL,
  coupon_id INTEGER,
  currency TEXT NOT NULL DEFAULT 'CNY',
  channel TEXT NOT NULL DEFAULT 'mock',                 -- alipay | usdt | mock
  status TEXT NOT NULL DEFAULT 'created',               -- created|pending|paid|fulfilled|closed|refunding|refunded
  pay_url TEXT,
  channel_txn_id TEXT,
  usdt_amount REAL,
  usdt_rate REAL,
  usdt_address TEXT,
  usdt_confirmations INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  paid_at TEXT,
  fulfilled_at TEXT,
  refunded_amount REAL NOT NULL DEFAULT 0,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  channel_txn_id TEXT UNIQUE NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'CNY',
  verified INTEGER NOT NULL DEFAULT 1,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  operator_id INTEGER,
  approver_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',               -- pending | approved | rejected | done
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id INTEGER NOT NULL REFERENCES coupons(id),
  user_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (coupon_id, order_id)
);
-- 订阅权益（一次订阅一条，scope 决定能看什么）
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  order_id INTEGER,
  scope TEXT NOT NULL DEFAULT 'all',
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',               -- active | expired | revoked
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 单片所有权（买断/租赁）
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  drama_id INTEGER NOT NULL REFERENCES dramas(id),
  order_id INTEGER,
  kind TEXT NOT NULL DEFAULT 'single',
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

-- ===== 运营 =====
CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, title TEXT, image TEXT,
  target_drama_id INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
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
  user_id INTEGER, content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS danmus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  user_id INTEGER, time_ms INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`)

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n

/** 权限点目录（`<域>.<对象>.<动作>`）。 */
export const PERMISSIONS = [
  ['dashboard.read', '查看概览', 'dashboard'],
  ['content.drama.read', '查看剧集', 'content'],
  ['content.drama.write', '新建/编辑剧集', 'content'],
  ['content.drama.publish', '上架/下架剧集', 'content'],
  ['content.drama.delete', '删除剧集', 'content'],
  ['content.episode.write', '管理分集与上传', 'content'],
  ['content.policy.write', '编辑付费策略', 'content'],
  ['content.review', '审核弹幕/评论', 'content'],
  ['commerce.plan.write', '管理套餐', 'commerce'],
  ['commerce.coupon.write', '管理优惠券', 'commerce'],
  ['finance.order.read', '查看订单', 'finance'],
  ['finance.refund.create', '发起退款', 'finance'],
  ['finance.refund.approve', '审批退款（双人复核）', 'finance'],
  ['finance.reconcile.run', '执行对账', 'finance'],
  ['ops.banner.write', '管理 Banner', 'ops'],
  ['ops.section.write', '管理首页楼层', 'ops'],
  ['ops.rank.write', '管理榜单', 'ops'],
  ['user.read', '查看用户', 'user'],
  ['user.manage', '禁用/解禁用户', 'user'],
  ['cs.toolkit', '客服工具（补发权益/查单）', 'cs'],
  ['admin.read', '查看管理员与角色', 'admin'],
  ['admin.write', '管理管理员与角色', 'admin'],
  ['audit.read', '查看审计日志', 'audit'],
  ['analytics.read', '查看经营数据', 'analytics'],
]

export const ROLES = [
  ['super_admin', '超级管理员', '拥有全部权限（含审批退款）', PERMISSIONS.map((p) => p[0])],
  ['content_ops', '内容运营', '剧集/分集/付费策略/审核', [
    'dashboard.read', 'content.drama.read', 'content.drama.write', 'content.drama.publish',
    'content.episode.write', 'content.policy.write', 'content.review',
  ]],
  ['finance', '财务', '订单、退款、对账', ['dashboard.read', 'finance.order.read', 'finance.refund.create', 'finance.refund.approve', 'finance.reconcile.run', 'analytics.read']],
  ['cs', '客服', '查单、补发权益、禁言用户', ['dashboard.read', 'finance.order.read', 'user.read', 'cs.toolkit']],
  ['auditor', '审核员', '内容审核与只读', ['dashboard.read', 'content.review', 'audit.read', 'content.drama.read']],
  ['analyst', '数据分析', '只读经营数据', ['dashboard.read', 'analytics.read', 'finance.order.read']],
]

export function seedIfEmpty() {
  if (count('dramas') > 0) return { seeded: false }

  // 权限与角色
  const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (code, name, domain) VALUES (?, ?, ?)')
  for (const [code, name, domain] of PERMISSIONS) insertPerm.run(code, name, domain)
  const insertRole = db.prepare('INSERT OR IGNORE INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 1)')
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
  for (const [code, name, description, perms] of ROLES) {
    insertRole.run(code, name, description)
    const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(code)
    for (const perm of perms) insertRolePerm.run(role.id, perm)
  }

  // 管理员：admin 超管；其余为演示角色
  const salt = 'demo-salt'
  const insertAdmin = db.prepare('INSERT OR IGNORE INTO admins (username, password_hash, salt, display_name) VALUES (?, ?, ?, ?)')
  const admins = [
    ['admin', '超级管理员'],
    ['ops01', '内容运营小王'],
    ['fin01', '财务小李'],
    ['cs01', '客服小张'],
  ]
  for (const [username, displayName] of admins) insertAdmin.run(username, hashPassword('admin123', salt), salt, displayName)
  const insertAdminRole = db.prepare('INSERT OR IGNORE INTO admin_roles (admin_id, role_id) VALUES (?, ?)')
  const roleOf = (code) => db.prepare('SELECT id FROM roles WHERE code = ?').get(code).id
  insertAdminRole.run(db.prepare("SELECT id FROM admins WHERE username = 'admin'").get().id, roleOf('super_admin'))
  insertAdminRole.run(db.prepare("SELECT id FROM admins WHERE username = 'ops01'").get().id, roleOf('content_ops'))
  insertAdminRole.run(db.prepare("SELECT id FROM admins WHERE username = 'fin01'").get().id, roleOf('finance'))
  insertAdminRole.run(db.prepare("SELECT id FROM admins WHERE username = 'cs01'").get().id, roleOf('cs'))

  // 种子内容
  const seed = JSON.parse(readFileSync(join(ROOT, 'data', 'seed.json'), 'utf8'))
  const insertDrama = db.prepare(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, score, status, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`)
  const ids = new Map()
  const addDrama = (item, sort) => {
    const key = String(item.dramaId ?? item.title)
    if (ids.has(key)) return ids.get(key)
    const info = insertDrama.run(item.title ?? '未命名', item.subTitle ?? '', item.coverUrl ?? '',
      item.description ?? '', 2026, item.area ?? '韩国', item.dramaType ?? 'TV', item.score ?? 8.5, sort)
    const id = Number(info.lastInsertRowid)
    ids.set(key, id)
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

    const insertEpisode = db.prepare(`INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, ?, ?, ?, 'ready')`)
    const insertPolicy = db.prepare(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const dramaRows = db.prepare('SELECT id, category FROM dramas ORDER BY id').all()
    for (const [index, row] of dramaRows.entries()) {
      const isMovie = row.category === 'MOVIE'
      const episodeCount = isMovie ? 1 : 24
      for (let no = 1; no <= episodeCount; no++) insertEpisode.run(row.id, no, `第 ${no} 集`, 2400 + no * 30)
      // 付费策略：电影=单片付费(前 6 分钟试看)；剧集=订阅，首集免费；每 7 部里挑 1 部做高价值单片
      const premium = isMovie && index % 3 === 0
      if (premium) insertPolicy.run(row.id, 'paid', 0, 360, 12, 'single', 72)
      else if (isMovie) insertPolicy.run(row.id, 'subscription', 0, 360, 0, 'single', 72)
      else insertPolicy.run(row.id, 'subscription', 1, 0, 0, 'single', 72)
    }

    // 套餐
    const insertPlan = db.prepare('INSERT INTO plans (code, name, price_cny, duration_days, scope, description, sort) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insertPlan.run('vip-month', '月卡会员', 25, 30, 'all', '全站剧集免费看（不含单片付费内容）', 1)
    insertPlan.run('vip-quarter', '季卡会员', 68, 90, 'all', '全站剧集免费看，折合 22.7 元/月', 2)
    insertPlan.run('vip-year', '年卡会员', 238, 365, 'all', '全站剧集免费看，折合 19.8 元/月', 3)

    // 优惠券
    const insertCoupon = db.prepare('INSERT INTO coupons (code, name, discount_type, discount_value, min_amount, total, valid_to) VALUES (?, ?, ?, ?, ?, ?, ?)')
    insertCoupon.run('WELCOME10', '新人立减 10 元', 'amount', 10, 25, 1000, '2027-12-31')
    insertCoupon.run('VIP15', '会员 85 折', 'percent', 15, 50, 500, '2027-12-31')

    // 运营位
    const insertBanner = db.prepare('INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, 1)')
    ;(seed.banners ?? []).forEach((banner, index) => insertBanner.run(banner.name ?? '', banner.title ?? '', banner.image ?? '', ids.get(String(banner.targetUrl)) ?? null, index))
    const insertSection = db.prepare('INSERT INTO sections (title, sort, enabled) VALUES (?, ?, 1)')
    const insertSectionItem = db.prepare('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, ?)')
    ;(seed.sections ?? []).forEach((section, index) => {
      const info = insertSection.run(section.title, index)
      const sectionId = Number(info.lastInsertRowid)
      ;(section.items ?? []).forEach((item, itemIndex) => {
        const dramaId = ids.get(String(item.dramaId))
        if (dramaId) insertSectionItem.run(sectionId, dramaId, itemIndex)
      })
    })
    const insertRankList = db.prepare('INSERT INTO rank_lists (name, type, sort) VALUES (?, ?, ?)')
    const insertRankItem = db.prepare('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, ?)')
    const dramaIds = [...ids.values()]
    ;[['热播榜', 'HOT'], ['热搜榜', 'SEARCH'], ['飙升榜', 'RISE'], ['经典榜', 'CLASSIC']].forEach(([name, type], listIndex) => {
      const info = insertRankList.run(name, type, listIndex)
      const listId = Number(info.lastInsertRowid)
      dramaIds.slice(listIndex * 2, listIndex * 2 + 10).forEach((dramaId, itemIndex) => insertRankItem.run(listId, dramaId, itemIndex + 1))
    })

    // 演示用户 + 评论/弹幕
    db.prepare("INSERT INTO users (phone, nickname) VALUES ('13800000000', '演示用户')").run()
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

    db.prepare("INSERT INTO settings (key, value) VALUES ('site', ?)").run(JSON.stringify({ name: '影巢', currency: 'CNY', usdtRate: 7.2, linkSecret: process.env.MH_LINK_SECRET ?? 'dev-link-secret' }))
    db.prepare("INSERT INTO settings (key, value) VALUES ('pay', ?)").run(JSON.stringify({ alipay: { enabled: false }, usdt: { enabled: true, network: 'TRC20', address: 'TDemoAddressForLocalTesting', minConfirmations: 19 }, mock: { enabled: true } }))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { seeded: true, dramas: count('dramas'), episodes: count('episodes') }
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

export { DB_PATH }
