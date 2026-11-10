/**
 * 数据层 v2：内容策略 / 套餐 / 权益 / 订单支付 / 退款 / 优惠券 / RBAC / 审计。
 * 直播相关表与代码已移除（无直播场景）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hashPassword } from './auth.mjs'
import { currentKeyVersion, maskConfig, sealSecret } from './secretbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..')
const DB_PATH = process.env.MH_DB ?? join(ROOT, 'storage', 'app.db')

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT,
  email TEXT,
  nickname TEXT NOT NULL,
  avatar TEXT,
  birthday TEXT,
  gender TEXT,
  bio TEXT,
  password_hash TEXT,
  password_salt TEXT,
  email_verified_at TEXT,
  last_login_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);

-- 邮箱验证码（登录 / 改密 / 换邮箱三用；只存哈希，不存明文）
CREATE TABLE IF NOT EXISTS email_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,                    -- login | change_password | change_email
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_codes(email, purpose, created_at DESC);

-- 发送频次统计（60 秒冷却 / 每日 20 条 / 每 IP 每小时上限）
CREATE TABLE IF NOT EXISTS email_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,
  ip TEXT,
  sent_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_send_lookup ON email_send_log(email, sent_date);
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
  domain TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'button',        -- dir 目录 | menu 菜单 | button 按钮
  parent_code TEXT,                            -- 树形父节点（NULL = 顶级目录）
  sort INTEGER NOT NULL DEFAULT 0,
  path TEXT,                                   -- 前端路由（menu 级使用）
  icon TEXT,
  visible INTEGER NOT NULL DEFAULT 1
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

-- ===== 支付渠道（多渠道路由 + 敏感配置加密）=====
CREATE TABLE IF NOT EXISTS pay_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_code TEXT NOT NULL,                              -- alipay | wechat | usdt | mock
  name TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT 'all',                       -- all | subscription | single
  env TEXT NOT NULL DEFAULT 'sandbox',                     -- sandbox | prod
  status TEXT NOT NULL DEFAULT 'disabled',                 -- enabled | disabled
  is_default INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,                   -- 数字越小越优先
  currency TEXT NOT NULL DEFAULT 'CNY',
  min_amount REAL NOT NULL DEFAULT 0,
  max_amount REAL NOT NULL DEFAULT 0,                      -- 0 = 不限
  config_cipher TEXT,                                      -- AES-256-GCM 密文（含 AppID/私钥等）
  config_preview TEXT,                                     -- 脱敏预览（可安全回显）
  key_version INTEGER NOT NULL DEFAULT 1,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (channel_code, env, scene)
);
CREATE INDEX IF NOT EXISTS idx_pay_default ON pay_channels(scene, status, is_default);
`)

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n

/** 权限点目录（`<域>.<对象>.<动作>`）。 */
/**
 * 菜单/权限树（RuoYi 风格：目录 dir → 菜单 menu → 按钮 button）。
 * code 既是菜单标识也是权限点：后端 @PreAuthorize 校验 button 级 code；
 * 角色绑定到"节点集合"，保存时自动补齐父级，保证树形结构完整。
 */
export const MENU_TREE = [
  { code: 'dashboard', name: '概览', type: 'menu', parent: null, sort: 10, path: '/dashboard', icon: '📊' },

  { code: 'dir:content', name: '内容管理', type: 'dir', parent: null, sort: 20, path: '/content', icon: '🎬' },
  { code: 'content.drama', name: '剧集管理', type: 'menu', parent: 'dir:content', sort: 10, path: '/dramas', icon: '📺' },
  { code: 'content.drama.read', name: '查看剧集', type: 'button', parent: 'content.drama', sort: 10 },
  { code: 'content.drama.write', name: '新建/编辑剧集', type: 'button', parent: 'content.drama', sort: 20 },
  { code: 'content.drama.publish', name: '上架/下架', type: 'button', parent: 'content.drama', sort: 30 },
  { code: 'content.drama.delete', name: '删除剧集', type: 'button', parent: 'content.drama', sort: 40 },
  { code: 'content.episode', name: '分集与视频', type: 'menu', parent: 'dir:content', sort: 20, path: '/episodes', icon: '🎞️' },
  { code: 'content.episode.write', name: '管理分集与上传', type: 'button', parent: 'content.episode', sort: 10 },
  { code: 'content.policy', name: '付费策略', type: 'menu', parent: 'dir:content', sort: 30, path: '/policies', icon: '💳' },
  { code: 'content.policy.write', name: '编辑付费策略', type: 'button', parent: 'content.policy', sort: 10 },
  { code: 'content.review', name: '内容审核', type: 'menu', parent: 'dir:content', sort: 40, path: '/review', icon: '🛡️' },
  { code: 'content.review.write', name: '审核弹幕/评论', type: 'button', parent: 'content.review', sort: 10 },

  { code: 'dir:commerce', name: '交易管理', type: 'dir', parent: null, sort: 30, path: '/commerce', icon: '💰' },
  { code: 'commerce.plan', name: '套餐定价', type: 'menu', parent: 'dir:commerce', sort: 10, path: '/plans', icon: '🏷️' },
  { code: 'commerce.plan.write', name: '管理套餐', type: 'button', parent: 'commerce.plan', sort: 10 },
  { code: 'commerce.coupon', name: '优惠券', type: 'menu', parent: 'dir:commerce', sort: 20, path: '/coupons', icon: '🎟️' },
  { code: 'commerce.coupon.write', name: '管理优惠券', type: 'button', parent: 'commerce.coupon', sort: 10 },
  { code: 'commerce.order', name: '订单', type: 'menu', parent: 'dir:commerce', sort: 30, path: '/orders', icon: '🧾' },
  { code: 'finance.order.read', name: '查看订单', type: 'button', parent: 'commerce.order', sort: 10 },
  { code: 'commerce.refund', name: '退款审核', type: 'menu', parent: 'dir:commerce', sort: 40, path: '/refunds', icon: '↩️' },
  { code: 'finance.refund.create', name: '发起退款', type: 'button', parent: 'commerce.refund', sort: 10 },
  { code: 'finance.refund.approve', name: '审批退款（双人复核）', type: 'button', parent: 'commerce.refund', sort: 20 },
  { code: 'commerce.reconcile', name: '对账', type: 'menu', parent: 'dir:commerce', sort: 50, path: '/reconcile', icon: '⚖️' },
  { code: 'finance.reconcile.run', name: '执行对账', type: 'button', parent: 'commerce.reconcile', sort: 10 },

  { code: 'dir:ops', name: '运营中心', type: 'dir', parent: null, sort: 40, path: '/ops', icon: '🎯' },
  { code: 'ops.banner', name: 'Banner', type: 'menu', parent: 'dir:ops', sort: 10, path: '/ops', icon: '🖼️' },
  { code: 'ops.banner.write', name: '管理 Banner', type: 'button', parent: 'ops.banner', sort: 10 },
  { code: 'ops.section', name: '首页楼层', type: 'menu', parent: 'dir:ops', sort: 20, path: '/sections', icon: '🧱' },
  { code: 'ops.section.write', name: '管理首页楼层', type: 'button', parent: 'ops.section', sort: 10 },
  { code: 'ops.rank', name: '榜单', type: 'menu', parent: 'dir:ops', sort: 30, path: '/ranks', icon: '🏆' },
  { code: 'ops.rank.write', name: '管理榜单', type: 'button', parent: 'ops.rank', sort: 10 },

  { code: 'dir:user', name: '用户中心', type: 'dir', parent: null, sort: 50, path: '/user', icon: '👤' },
  { code: 'user.list', name: '用户管理', type: 'menu', parent: 'dir:user', sort: 10, path: '/users', icon: '👥' },
  { code: 'user.read', name: '查看用户', type: 'button', parent: 'user.list', sort: 10 },
  { code: 'user.manage', name: '禁用/解禁用户', type: 'button', parent: 'user.list', sort: 20 },
  { code: 'cs.toolkit', name: '客服工具', type: 'menu', parent: 'dir:user', sort: 20, path: '/cs', icon: '🎧' },
  { code: 'cs.toolkit.grant', name: '补发权益', type: 'button', parent: 'cs.toolkit', sort: 10 },

  { code: 'dir:system', name: '系统管理', type: 'dir', parent: null, sort: 60, path: '/system', icon: '⚙️' },
  { code: 'system.role', name: '角色权限', type: 'menu', parent: 'dir:system', sort: 10, path: '/roles', icon: '🔐' },
  { code: 'admin.read', name: '查看角色/管理员', type: 'button', parent: 'system.role', sort: 10 },
  { code: 'admin.write', name: '管理角色/管理员', type: 'button', parent: 'system.role', sort: 20 },
  { code: 'system.audit', name: '审计日志', type: 'menu', parent: 'dir:system', sort: 20, path: '/audit', icon: '📜' },
  { code: 'audit.read', name: '查看审计日志', type: 'button', parent: 'system.audit', sort: 10 },
  { code: 'system.paychannel', name: '支付渠道', type: 'menu', parent: 'dir:system', sort: 30, path: '/pay', icon: '💳' },
  { code: 'payment.channel.read', name: '查看支付渠道', type: 'button', parent: 'system.paychannel', sort: 10 },
  { code: 'payment.channel.write', name: '管理支付渠道（含密钥）', type: 'button', parent: 'system.paychannel', sort: 20 },
  { code: 'system.email', name: '邮件设置', type: 'menu', parent: 'dir:system', sort: 35, path: '/email', icon: '✉️' },
  { code: 'email.read', name: '查看邮件配置', type: 'button', parent: 'system.email', sort: 10 },
  { code: 'email.write', name: '修改邮件配置（含口令）', type: 'button', parent: 'system.email', sort: 20 },
  { code: 'system.analytics', name: '经营数据', type: 'menu', parent: 'dir:system', sort: 40, path: '/analytics', icon: '📈' },
  { code: 'analytics.read', name: '查看经营数据', type: 'button', parent: 'system.analytics', sort: 10 },
]

/** 兼容旧代码：扁平权限点列表（仅按钮/菜单，不含目录）。 */
export const PERMISSIONS = MENU_TREE.filter((node) => node.type !== 'dir')
  .map((node) => [node.code, node.name, node.parent ?? node.code.split('.')[0]])

/** 角色默认菜单集合（自动补齐父级，见 expandWithAncestors）。 */
export const ROLES = [
  ['super_admin', '超级管理员', '拥有全部权限（含密钥与退款审批）', MENU_TREE.map((node) => node.code)],
  ['content_ops', '内容运营', '剧集/分集/付费策略/审核', [
    'dashboard', 'content.drama', 'content.drama.read', 'content.drama.write', 'content.drama.publish',
    'content.episode', 'content.episode.write', 'content.policy', 'content.policy.write',
    'content.review', 'content.review.write',
  ]],
  ['finance', '财务', '订单、退款、对账、经营数据', [
    'dashboard', 'commerce.order', 'finance.order.read', 'commerce.refund',
    'finance.refund.create', 'finance.refund.approve', 'commerce.reconcile', 'finance.reconcile.run',
    'system.analytics', 'analytics.read',
  ]],
  ['cs', '客服', '查单、补发权益、用户查看', [
    'dashboard', 'commerce.order', 'finance.order.read', 'user.list', 'user.read', 'cs.toolkit', 'cs.toolkit.grant',
  ]],
  ['auditor', '审核员', '内容审核 + 审计只读', [
    'dashboard', 'content.review', 'content.review.write', 'system.audit', 'audit.read', 'content.drama', 'content.drama.read',
  ]],
  ['analyst', '数据分析', '只读经营数据', [
    'dashboard', 'system.analytics', 'analytics.read', 'commerce.order', 'finance.order.read',
  ]],
]

const BY_CODE = new Map(MENU_TREE.map((node) => [node.code, node]))
export const menuNode = (code) => BY_CODE.get(code)

/** 补齐父级：角色保存时不允许出现"孤儿按钮"。 */
export function expandWithAncestors(codes) {
  const result = new Set()
  for (const code of codes) {
    let node = BY_CODE.get(code)
    while (node) {
      result.add(node.code)
      node = node.parent ? BY_CODE.get(node.parent) : undefined
    }
  }
  return [...result]
}

/** 组装嵌套树（前端 el-tree 直接可用）。 */
export function buildMenuTree(codes) {
  const allowed = codes ? new Set(codes) : null
  const nodes = MENU_TREE.filter((node) => !allowed || allowed.has(node.code))
    .sort((a, b) => a.sort - b.sort)
    .map((node) => ({ ...node, children: [] }))
  const index = new Map(nodes.map((node) => [node.code, node]))
  const roots = []
  for (const node of nodes) {
    const parent = node.parent ? index.get(node.parent) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function seedIfEmpty() {
  if (count('dramas') > 0) return { seeded: false }

  // 菜单/权限树 + 角色
  const insertPerm = db.prepare(`INSERT OR IGNORE INTO permissions (code, name, domain, type, parent_code, sort, path, icon, visible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
  for (const node of MENU_TREE) {
    insertPerm.run(node.code, node.name, node.parent ?? node.code.split('.')[0], node.type, node.parent ?? null, node.sort ?? 0, node.path ?? null, node.icon ?? null)
  }
  const insertRole = db.prepare('INSERT OR IGNORE INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 1)')
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
  for (const [code, name, description, perms] of ROLES) {
    insertRole.run(code, name, description)
    const role = db.prepare('SELECT id FROM roles WHERE code = ?').get(code)
    for (const menuCode of expandWithAncestors(perms)) insertRolePerm.run(role.id, menuCode)
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
    db.prepare("INSERT INTO settings (key, value) VALUES ('smtp', ?)").run(JSON.stringify({
      enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', fromName: '影巢',
    }))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { seeded: true, dramas: count('dramas'), episodes: count('episodes') }
}

/**
 * 老库升级：users 增加邮箱/口令/资料字段。
 */
export function ensureUserSchema() {
  const columns = db.prepare('PRAGMA table_info(users)').all().map((row) => row.name)
  const additions = [
    ['email', 'TEXT'],
    ['avatar', 'TEXT'],
    ['birthday', 'TEXT'],
    ['gender', 'TEXT'],
    ['bio', 'TEXT'],
    ['password_hash', 'TEXT'],
    ['password_salt', 'TEXT'],
    ['email_verified_at', 'TEXT'],
    ['last_login_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ]
  for (const [name, ddl] of additions) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`)
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uk_users_email ON users(email) WHERE email IS NOT NULL')
}

/**
 * 老库结构升级：permissions 从扁平权限点扩成树形节点（SQLite 只能逐列 ADD COLUMN）。
 */
export function ensureMenuSchema() {
  const columns = db.prepare('PRAGMA table_info(permissions)').all().map((row) => row.name)
  const additions = [
    ['type', "TEXT NOT NULL DEFAULT 'button'"],
    ['parent_code', 'TEXT'],
    ['sort', 'INTEGER NOT NULL DEFAULT 0'],
    ['path', 'TEXT'],
    ['icon', 'TEXT'],
    ['visible', 'INTEGER NOT NULL DEFAULT 1'],
  ]
  for (const [name, ddl] of additions) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE permissions ADD COLUMN ${name} ${ddl}`)
  }
}

/**
 * 目录/菜单/权限同步（幂等）：老库启动时补齐树形节点，不依赖重新建库。
 */
export function syncMenuCatalog() {
  ensureMenuSchema()
  const insert = db.prepare(`INSERT INTO permissions (code, name, domain, type, parent_code, sort, path, icon, visible)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(code) DO UPDATE SET name = excluded.name, type = excluded.type,
      parent_code = excluded.parent_code, sort = excluded.sort, path = excluded.path, icon = excluded.icon`)
  for (const node of MENU_TREE) {
    insert.run(node.code, node.name, node.parent ?? node.code.split('.')[0], node.type, node.parent ?? null, node.sort ?? 0, node.path ?? null, node.icon ?? null)
  }
  // 老库里角色的按钮权限补齐父级菜单，避免树形渲染时父节点缺失
  const roles = db.prepare('SELECT id, code FROM roles').all()
  const current = db.prepare('SELECT permission_code FROM role_permissions WHERE role_id = ?')
  const insertRolePerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
  for (const role of roles) {
    if (role.code === 'super_admin') {
      // 超管始终拥有全部菜单/按钮（含后续新增）
      for (const node of MENU_TREE) insertRolePerm.run(role.id, node.code)
      continue
    }
    const codes = current.all(role.id).map((row) => row.permission_code)
    for (const code of expandWithAncestors(codes)) insertRolePerm.run(role.id, code)
  }
}

/**
 * 支付渠道迁移：把旧的 settings.pay JSON 拆成多行渠道记录（含加密后的密钥）。
 * 幂等：pay_channels 已有数据则跳过。
 */
export function migratePayChannels() {
  if (count('pay_channels') > 0) return { migrated: false }
  const pay = getSetting('pay', {}) ?? {}
  const site = getSetting('site', {}) ?? {}
  const rows = [
    {
      channel_code: 'alipay', name: '支付宝', scene: 'all', env: 'sandbox',
      status: pay.alipay?.enabled ? 'enabled' : 'disabled', priority: 10, currency: 'CNY',
      config: {
        appId: pay.alipay?.appId ?? '',
        privateKey: pay.alipay?.privateKey ?? '',
        publicKey: pay.alipay?.publicKey ?? '',
        gateway: pay.alipay?.gateway ?? 'https://openapi.alipay.com/gateway.do',
        notifyUrl: pay.alipay?.notifyUrl ?? '',
        refundEnabled: Boolean(pay.alipay?.refundEnabled),
      },
    },
    {
      channel_code: 'usdt', name: 'USDT（TRC20）', scene: 'all', env: 'sandbox',
      status: pay.usdt?.enabled ? 'enabled' : 'disabled', priority: 20, currency: 'USDT',
      config: {
        walletAddress: pay.usdt?.address ?? '',
        network: pay.usdt?.network ?? 'TRC20',
        minConfirmations: pay.usdt?.minConfirmations ?? 19,
        rate: site.usdtRate ?? 7.2,
      },
    },
    {
      channel_code: 'mock', name: '模拟支付（演示）', scene: 'all', env: 'sandbox',
      status: pay.mock?.enabled ? 'enabled' : 'disabled', priority: 99, currency: 'CNY',
      config: {},
    },
  ]
  const insert = db.prepare(`INSERT INTO pay_channels
    (channel_code, name, scene, env, status, is_default, priority, currency, config_cipher, config_preview, key_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  db.exec('BEGIN')
  try {
    let firstEnabled = true
    for (const row of rows) {
      const isDefault = row.status === 'enabled' && firstEnabled ? 1 : 0
      if (isDefault) firstEnabled = false
      insert.run(row.channel_code, row.name, row.scene, row.env, row.status, isDefault, row.priority, row.currency,
        sealSecret(row.config), JSON.stringify(maskConfig(row.config)), currentKeyVersion())
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { migrated: true, channels: rows.length }
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

/** 补齐缺失的默认设置行（老库升级用）。 */
export function ensureSettings() {
  const defaults = {
    smtp: { enabled: false, host: '', port: 465, secure: true, user: '', pass: '', from: '', fromName: '影巢' },
  }
  for (const [key, value] of Object.entries(defaults)) {
    const row = db.prepare('SELECT 1 AS x FROM settings WHERE key = ?').get(key)
    if (!row) setSetting(key, value)
  }
}

export { DB_PATH }
