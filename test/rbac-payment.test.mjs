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
