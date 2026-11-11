/** 付费策略组：新建剧集直接选组、单剧改派、选中批量分配、改组实时生效。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-policy-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'test-secret'
process.env.MH_CONFIG_KEYS = `1:${Buffer.alloc(32, 5).toString('base64')}`
process.env.MH_CONFIG_KEY_VERSION = '1'

let db, api, auth, token

function fakeResponse() {
  const headers = new Map()
  return {
    headersSent: false,
    status: 0,
    rawBody: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)) },
    getHeader(name) { return headers.get(String(name).toLowerCase()) },
    writeHead(status, values = {}) {
      this.status = status
      this.headersSent = true
      for (const [name, value] of Object.entries(values)) headers.set(String(name).toLowerCase(), String(value))
    },
    end(body = '') {
      this.rawBody = String(body)
      this.headersSent = true
    },
    json() { return JSON.parse(this.rawBody) },
  }
}

async function call(method, path, body) {
  const res = fakeResponse()
  const req = {
    method,
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'node-test' },
    socket: { remoteAddress: '127.0.0.1' },
  }
  await api.handleAdmin(path, new URL(`http://localhost${path}`), req, res, body)
  return { status: res.status, ...res.json() }
}

async function createDrama(title, category, policyGroupId) {
  const result = await call('POST', '/admin/api/dramas', {
    title,
    category,
    coverUrl: `/media/images/cover-${title}.jpg`,
    year: 2026,
    area: '中国大陆',
    score: 8.1,
    policyGroupId,
  })
  assert.equal(result.code, '0000', result.msg)
  return Number(result.data.drama.id)
}

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dbModule.ensureOpsSchema()
  api = await import('../server/api-admin.mjs')
  auth = await import('../server/auth.mjs')
  const admin = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(admin.id)
  token = auth.issueToken(admin.id, 'admin').token
})

after(() => { try { db.close() } catch { /* ignore */ } })

test('策略组列表包含内置组与未分组计数', async () => {
  const result = await call('GET', '/admin/api/policy-groups')
  assert.equal(result.code, '0000')
  assert.ok(result.data.groups.length >= 3)
  assert.equal(typeof result.data.ungrouped, 'number')
})

test('新建剧集直接绑定策略组，生效值来自组而不是逐剧字段', async () => {
  const groups = (await call('GET', '/admin/api/policy-groups')).data.groups
  const paid = groups.find((group) => group.name === '单片付费')
  const dramaId = await createDrama(`策略组新剧${Date.now()}`, 'MOVIE', paid.id)
  const detail = await call('GET', `/admin/api/dramas/${dramaId}`)
  assert.equal(detail.code, '0000')
  assert.equal(detail.data.policy.policy_group_id, paid.id)
  assert.equal(detail.data.policy.access_mode, 'paid')
  assert.equal(detail.data.policy.single_price_cny, Number(paid.single_price_cny))
})

test('选中多部剧可一次批量分配，改组后所有剧实时生效', async () => {
  const groups = (await call('GET', '/admin/api/policy-groups')).data.groups
  const membership = groups.find((group) => group.name === '会员免费')
  const first = await createDrama(`批量A${Date.now()}`, 'TV', membership.id)
  const second = await createDrama(`批量B${Date.now()}`, 'TV', membership.id)

  const preview = await call('POST', `/admin/api/policy-groups/${membership.id}/assign`, {
    dramaIds: [first, second],
    dryRun: true,
  })
  assert.equal(preview.code, '0000')
  assert.equal(preview.data.matched, 2)

  const applied = await call('POST', `/admin/api/policy-groups/${membership.id}/assign`, {
    dramaIds: [first, second],
  })
  assert.equal(applied.code, '0000')
  assert.equal(applied.data.updated, 2)

  db.prepare("UPDATE policy_groups SET access_mode = 'free', free_episodes = 0 WHERE id = ?").run(membership.id)
  for (const id of [first, second]) {
    const detail = await call('GET', `/admin/api/dramas/${id}`)
    assert.equal(detail.data.policy.policy_group_id, membership.id)
    assert.equal(detail.data.policy.access_mode, 'free')
    assert.equal(detail.data.policy.free_episodes, 0)
  }
})

test('筛选批量分配与无目标校验', async () => {
  const groups = (await call('GET', '/admin/api/policy-groups')).data.groups
  const free = groups.find((group) => group.name === '免费公开')
  const title = `筛选批量${Date.now()}`
  await createDrama(title, 'DOCUMENTARY', free.id)

  const preview = await call('POST', `/admin/api/policy-groups/${free.id}/assign`, {
    filters: { keyword: title, category: 'all', status: 'all' },
    dryRun: true,
  })
  assert.equal(preview.code, '0000')
  assert.equal(preview.data.matched, 1)

  const invalid = await call('POST', `/admin/api/policy-groups/${free.id}/assign`, {})
  assert.equal(invalid.status, 400)
  assert.equal(invalid.code, '0400')
})
