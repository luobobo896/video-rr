/** RBAC 树形菜单 + 支付渠道加密/默认切换 回归测试。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-rbac-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'
process.env.MH_CONFIG_KEYS = `1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.MH_CONFIG_KEY_VERSION = '1'
process.env.MH_ALLOW_SIM_PAY = '1'

let db, seedIfEmpty, syncMenuCatalog, migratePayChannels, rbac, commerce, secretbox, menuApi

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  seedIfEmpty = module.seedIfEmpty
  syncMenuCatalog = module.syncMenuCatalog
  migratePayChannels = module.migratePayChannels
  menuApi = module
  seedIfEmpty()
  syncMenuCatalog()
  migratePayChannels()
  rbac = await import('../server/rbac.mjs')
  commerce = await import('../server/commerce.mjs')
  secretbox = await import('../server/secretbox.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

test('菜单树：目录 → 菜单 → 按钮 三层完整', () => {
  const tree = rbac.menuTree()
  assert.ok(tree.length >= 5)
  const content = tree.find((node) => node.code === 'dir:content')
  assert.ok(content && content.type === 'dir')
  const drama = content.children.find((node) => node.code === 'content.drama')
  assert.equal(drama.type, 'menu')
  assert.equal(drama.path, '/dramas')
  assert.ok(drama.children.some((node) => node.code === 'content.drama.write' && node.type === 'button'))
})

test('分销分析与配置对财务角色可见', () => {
  const routes = db.prepare("SELECT route, perm_code FROM admin_menus WHERE route LIKE '/distribution%' ORDER BY route").all()
  assert.deepEqual(routes.map((row) => row.route), ['/distribution', '/distribution-config'])
  const finance = db.prepare("SELECT id FROM roles WHERE code = 'finance'").get()
  const permissions = new Set(db.prepare('SELECT permission_code FROM role_permissions WHERE role_id = ?').all(finance.id)
    .map((row) => row.permission_code))
  assert.equal(permissions.has('growth.distribution.read'), true)
  assert.equal(permissions.has('growth.distribution.write'), true)
  assert.equal(db.prepare("SELECT value FROM settings WHERE key = 'growth.roleSyncVersion'").get().value, '2')
})

test('后台用户管理菜单：历史名称迁移为用户管理', () => {
  menuApi.ensureOpsSchema()
  db.prepare("UPDATE admin_menus SET label = '管理员账号' WHERE route = '/admins'").run()
  menuApi.ensureOpsSchema()
  const row = db.prepare("SELECT label FROM admin_menus WHERE route = '/admins'").get()
  assert.equal(row.label, '用户管理')
})

test('出厂菜单权限与页面读接口一致', () => {
  menuApi.ensureOpsSchema()
  const rows = db.prepare("SELECT route, perm_code FROM admin_menus WHERE route IN ('/policies','/ops','/refunds')").all()
  const byRoute = Object.fromEntries(rows.map((row) => [row.route, row.perm_code]))
  assert.equal(byRoute['/policies'], 'content.policy.write')
  assert.equal(byRoute['/ops'], 'ops.banner.write&ops.section.write')
  assert.equal(byRoute['/refunds'], 'finance.order.read')
})

test('角色管理 / 用户管理为独立菜单，权限在角色弹窗内分配', () => {
  menuApi.ensureOpsSchema()
  const rows = db.prepare("SELECT label, route FROM admin_menus WHERE route IN ('/roles','/permissions','/admins') ORDER BY sort").all()
  const byRoute = Object.fromEntries(rows.map((row) => [row.route, row.label]))
  assert.equal(byRoute['/roles'], '角色管理')
  assert.equal(byRoute['/permissions'], undefined)
  assert.equal(byRoute['/admins'], '用户管理')
  assert.equal(rbac.listPermissionCatalog().some((item) => item.code === 'system.permission'), false)
})

test('菜单分组修改会同步组内全部子菜单', () => {
  const route = `/qa-group-${Date.now()}`
  db.prepare(`INSERT INTO admin_menus (group_key, group_label, group_sort, label, route, perm_code, sort, visible, is_system)
    VALUES ('qa_group', 'QA', 99, 'QA 菜单', ?, NULL, 10, 1, 0)`).run(route)
  const result = rbac.saveAdminMenuGroup('qa_group', { groupKey: 'qa_group_2', groupLabel: 'QA 分组', groupSort: 88 })
  const row = db.prepare('SELECT group_key, group_label, group_sort FROM admin_menus WHERE route = ?').get(route)
  assert.equal(result.items, 1)
  assert.equal(row.group_key, 'qa_group_2')
  assert.equal(row.group_label, 'QA 分组')
  assert.equal(row.group_sort, 88)
  db.prepare('DELETE FROM admin_menus WHERE route = ?').run(route)
})

test('单条菜单保存拒绝 HTML 分组键', () => {
  assert.throws(
    () => rbac.saveAdminMenu({
      label: 'XSS QA',
      route: `/xss-qa-${Date.now()}`,
      groupKey: '"><img src=x onerror=alert(1)>',
    }),
    /分组键只能使用/,
  )
})

test('隐藏菜单只影响侧栏展示，仍保留给直接路由解析', () => {
  const route = `/hidden-qa-${Date.now()}`
  db.prepare(`INSERT INTO admin_menus (group_key, group_label, group_sort, label, route, perm_code, sort, visible, is_system)
    VALUES ('overview', '数据概览', 1, '隐藏 QA', ?, 'dashboard.read', 999, 0, 0)`).run(route)
  const allRoutes = rbac.listAdminMenus({ includeHidden: true })
    .flatMap((group) => group.items.map((item) => item.route))
  const visibleRoutes = rbac.listAdminMenus({ includeHidden: false })
    .flatMap((group) => group.items.map((item) => item.route))
  assert.ok(allRoutes.includes(route))
  assert.ok(!visibleRoutes.includes(route))
  db.prepare('DELETE FROM admin_menus WHERE route = ?').run(route)
})

test('首页 banner 失效目标会按封面 slug 自动修复', () => {
  const dramaId = Number(db.prepare("INSERT INTO dramas (title, cover_url, status) VALUES ('Banner QA', '/media/images/cover-banner-qa.jpg', 'published')").run().lastInsertRowid)
  const drama = db.prepare('SELECT id, cover_url FROM dramas WHERE id = ?').get(dramaId)
  const slug = /cover-([^/?.]+)\.jpg/.exec(drama.cover_url)?.[1]
  assert.equal(slug, 'banner-qa')
  const info = db.prepare("INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES ('修复测试', '', ?, 999999, 99, 1)")
    .run(`/media/images/banner-${slug}.jpg`)
  menuApi.ensureOpsSchema()
  const fixed = db.prepare('SELECT target_drama_id FROM banners WHERE id = ?').get(Number(info.lastInsertRowid))
  assert.equal(fixed.target_drama_id, drama.id)
})

test('C 端密码管理权限已纳入权限目录', () => {
  assert.ok(rbac.listPermissionCatalog().some((item) => item.code === 'user.password'))
})

test('内容统计重算使用独立写权限，只读分析师不能触发重算', () => {
  assert.ok(rbac.listPermissionCatalog().some((item) => item.code === 'growth.content.write'))
  const role = db.prepare("SELECT id FROM roles WHERE code = 'content_ops'").get()
  const permissions = new Set(db.prepare('SELECT permission_code FROM role_permissions WHERE role_id = ?').all(role.id)
    .map((row) => row.permission_code))
  assert.equal(permissions.has('growth.content.write'), true)
})

test('角色保存：只传叶子节点会自动补齐父级', () => {
  const role = db.prepare("SELECT id FROM roles WHERE code = 'content_ops'").get()
  const result = rbac.updateRoleMenus(role.id, ['content.drama.write'])
  assert.ok(result.checked.includes('content.drama'))
  assert.ok(result.checked.includes('dir:content'))
  assert.ok(!result.checked.includes('finance.refund.approve'))
})

test('角色保存：未知 code 被丢弃', () => {
  const role = db.prepare("SELECT id FROM roles WHERE code = 'cs'").get()
  const result = rbac.updateRoleMenus(role.id, ['finance.order.read', 'not.exist'])
  assert.ok(result.checked.includes('finance.order.read'))
  assert.ok(!result.checked.includes('not.exist'))
})

test('角色 CRUD：自定义角色可增删改，内置和在用角色受保护', () => {
  const code = `qa_${Date.now()}`
  const role = rbac.createRole({ code, name: 'QA 自定义角色', description: '用于回归测试' })
  assert.equal(role.code, code)
  assert.equal(role.is_system, 0)
  assert.deepEqual(role.permissions, [])

  const updated = rbac.updateRole(role.id, { name: 'QA 角色已更新', description: '更新说明' })
  assert.equal(updated.name, 'QA 角色已更新')
  assert.equal(updated.description, '更新说明')

  const system = db.prepare("SELECT id FROM roles WHERE code = 'super_admin'").get()
  assert.throws(() => rbac.deleteRole(system.id), /内置角色不能删除/)

  const admin = rbac.createAdmin({
    username: `qa_${Date.now()}`,
    displayName: 'QA 临时账号',
    passwordHash: 'qa-hash',
    salt: 'qa-salt',
    roleCodes: [code],
  })
  assert.throws(() => rbac.deleteRole(role.id), /仍分配/)

  rbac.deleteAdminById(admin.id)
  const deleted = rbac.deleteRole(role.id)
  assert.equal(deleted.code, code)
  assert.equal(db.prepare('SELECT id FROM roles WHERE id = ?').get(role.id), undefined)
})

test('直达角色分配接口也不能摘掉最后一个超级管理员', () => {
  const superAdmin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  assert.throws(
    () => rbac.setAdminRoles(superAdmin.id, ['finance']),
    /最后一个启用中的超级管理员/,
  )
})

test('敏感配置：加密后可解密，篡改会失败，回显脱敏', () => {
  const config = { appId: '2021000000', privateKey: '-----BEGIN PRIVATE KEY-----abc', publicKey: 'pub', notifyUrl: 'https://x/notify' }
  const cipher = secretbox.sealSecret(config)
  assert.match(cipher, /^v1:/)
  assert.deepEqual(secretbox.openSecret(cipher), config)

  const tampered = cipher.slice(0, -2) + (cipher.endsWith('AA') ? 'BB' : 'AA')
  assert.throws(() => secretbox.openSecret(tampered))

  const masked = secretbox.maskConfig(config)
  assert.ok(!String(masked.privateKey).includes('BEGIN PRIVATE KEY'))
  assert.ok(masked.privateKey.endsWith('（已加密）'))
  assert.equal(masked.notifyUrl, config.notifyUrl)
})

test('渠道初始化：三个渠道，唯一默认', () => {
  const rows = db.prepare('SELECT * FROM pay_channels').all()
  assert.equal(rows.length, 3)
  assert.equal(rows.filter((row) => row.is_default === 1).length, 1)
  const alipay = rows.find((row) => row.channel_code === 'alipay')
  assert.ok(alipay.config_cipher.startsWith('v1:'))
  assert.doesNotThrow(() => JSON.parse(alipay.config_preview))
})

test('默认渠道切换：同场景唯一，停用后自动取消默认', () => {
  const usdt = db.prepare("SELECT * FROM pay_channels WHERE channel_code='usdt'").get()
  commerce.setDefaultChannel({ channelId: usdt.id })
  let rows = db.prepare("SELECT * FROM pay_channels WHERE scene = 'all'").all()
  assert.equal(rows.filter((row) => row.is_default === 1).length, 1)
  assert.equal(rows.find((row) => row.is_default === 1).channel_code, 'usdt')

  commerce.setChannelStatus({ channelId: usdt.id, status: 'disabled' })
  rows = db.prepare('SELECT * FROM pay_channels').all()
  assert.equal(rows.filter((row) => row.is_default === 1).length, 0)
})

test('渠道选择：金额区间与显式指定', () => {
  const mock = db.prepare("SELECT * FROM pay_channels WHERE channel_code='mock'").get()
  commerce.setChannelStatus({ channelId: mock.id, status: 'enabled' })
  commerce.setDefaultChannel({ channelId: mock.id })

  const byDefault = commerce.resolveChannel({ scene: 'subscription', amount: 25 })
  assert.equal(byDefault.channel_code, 'mock')

  db.prepare('UPDATE pay_channels SET max_amount = 10 WHERE id = ?').run(mock.id)
  const outside = commerce.resolveChannel({ scene: 'subscription', amount: 25 })
  assert.equal(outside, undefined)

  db.prepare('UPDATE pay_channels SET max_amount = 0 WHERE id = ?').run(mock.id)
  const explicit = commerce.resolveChannel({ scene: 'subscription', channelCode: 'mock', amount: 25 })
  assert.equal(explicit.channel_code, 'mock')
})

test('渠道更新：不传敏感字段时保留原值', () => {
  const alipay = db.prepare("SELECT * FROM pay_channels WHERE channel_code='alipay'").get()
  commerce.upsertChannel({ name: '支付宝（改名）' }, alipay.id)
  const after = db.prepare('SELECT * FROM pay_channels WHERE id = ?').get(alipay.id)
  assert.equal(after.name, '支付宝（改名）')
  assert.equal(after.config_cipher, alipay.config_cipher)
})

test('渠道测试接口：缺少必填项时返回缺失列表', () => {
  const usdt = db.prepare("SELECT * FROM pay_channels WHERE channel_code='usdt'").get()
  const result = commerce.testChannel({ channelId: usdt.id })
  assert.equal(typeof result.ok, 'boolean')
  assert.ok(Array.isArray(result.missing))
})

test('菜单树构建：父节点缺失时不丢节点（升级容错）', () => {
  const tree = menuApi.buildMenuTree(['content.drama.write'])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].code, 'content.drama.write')
})
