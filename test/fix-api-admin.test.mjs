import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 全流程落在 mkdtemp 的临时库上，绝不碰 storage/app.db
const root = mkdtempSync(join(tmpdir(), 'mh-fix-api-admin-'))
process.env.MH_DB = join(root, 'app.db')
process.env.MH_SECRET = 'fix-api-admin'
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
// 默认关掉 OTP 测试钩子与明文开关：先验证「不带明文」是默认行为
delete process.env.MH_OTP_TEST
delete process.env.MH_CS_ASSIST_PLAINTEXT

const dbModule = await import('../server/db.mjs')
const db = dbModule.db
dbModule.seedIfEmpty()
const auth = await import('../server/auth.mjs')
const adminApi = await import('../server/api-admin.mjs')

let server
let base

const PERMISSIONS = {
  readOnlyFinance: ['finance.order.read', 'dashboard.read'],
  csMenuOnly: ['cs.toolkit', 'user.login.assist', 'user.read'],
  csGrant: ['cs.toolkit.grant', 'user.read'],
  delegator: ['system.admin', 'admin.read', 'admin.write'],
  roleEditor: ['admin.write', 'admin.read'],
  contentOps: [
    'content.drama.read', 'content.drama.write', 'content.drama.publish',
    'content.episode.write', 'content.policy.write', 'ops.banner.write', 'ops.section.write',
    'analytics.read', 'tag.read', 'tag.write',
  ],
}

const actors = {}
let userId
let dramaId
let planId

const makeRole = (code, name, codes) => {
  const info = db.prepare('INSERT INTO roles (code, name, is_system) VALUES (?, ?, 0)').run(code, name)
  const roleId = Number(info.lastInsertRowid)
  const link = db.prepare('INSERT INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
  for (const item of codes) link.run(roleId, item)
  return roleId
}

const makeAdmin = (username, roleIds) => {
  const salt = 'fixadminsalt'
  const hash = auth.hashPassword('Passw0rd!2345', salt)
  const info = db.prepare(`INSERT INTO admins (username, password_hash, salt, display_name, status, must_change_password)
    VALUES (?, ?, ?, ?, 'active', 0)`).run(username, hash, salt, username)
  const adminId = Number(info.lastInsertRowid)
  const link = db.prepare('INSERT INTO admin_roles (admin_id, role_id) VALUES (?, ?)')
  for (const roleId of roleIds) link.run(adminId, roleId)
  return { id: adminId, token: auth.issueToken(adminId, 'admin').token }
}

const call = async (method, path, { body, token } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json()
  return { status: response.status, ...payload }
}

before(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname.endsWith('/upload')) {
        req.resume()
        return await adminApi.handleAdmin(url.pathname, url, req, res, {}, { uploadPath: join(root, 'invalid-upload.part') })
      }
      await adminApi.handleAdmin(url.pathname, url, req, res)
    } catch (error) {
      res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: error.code, msg: error.message }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`

  const seeded = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get()
  db.prepare('UPDATE admins SET must_change_password = 0 WHERE id = ?').run(seeded.id)
  actors.root = { id: seeded.id, token: auth.issueToken(seeded.id, 'admin').token }

  actors.financeReadOnly = makeAdmin('finance_readonly', [makeRole('finance_readonly', '只读财务', PERMISSIONS.readOnlyFinance)])
  actors.csMenuOnly = makeAdmin('cs_menu_only', [makeRole('cs_menu_only', '客服工具箱', PERMISSIONS.csMenuOnly)])
  actors.csGrant = makeAdmin('cs_grant', [makeRole('cs_grant', '客服补发', PERMISSIONS.csGrant)])
  actors.delegator = makeAdmin('delegator', [makeRole('delegator', '建号委派人', PERMISSIONS.delegator)])
  actors.roleEditor = makeAdmin('role_editor', [makeRole('role_editor', '角色编辑', PERMISSIONS.roleEditor)])
  actors.contentOps = makeAdmin('content_ops_x', [makeRole('content_ops_x', '内容运营', PERMISSIONS.contentOps)])

  const user = db.prepare("INSERT INTO users (email, nickname, status) VALUES ('cs@example.com', '客服测试用户', 'active')").run()
  userId = Number(user.lastInsertRowid)
  const drama = db.prepare("INSERT INTO dramas (title, category, status, is_adult) VALUES ('鉴权回归剧', 'MOVIE', 'draft', 0)").run()
  dramaId = Number(drama.lastInsertRowid)
  const plan = db.prepare("INSERT INTO plans (code, name, price_cny, duration_days, scope, sort, status) VALUES ('900001', '回归套餐', 9.9, 30, 'all', 0, 'active')").run()
  planId = Number(plan.lastInsertRowid)
})

test('后台拒绝非法 JSON，且不创建默认榜单', async () => {
  const count = () => db.prepare('SELECT COUNT(*) AS total FROM rank_lists').get().total
  const before = count()
  const response = await fetch(`${base}/admin/api/ranks`, {
    method: 'POST', headers: { authorization: `Bearer ${actors.root.token}`, 'content-type': 'application/json' }, body: '{',
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, '0400')
  assert.equal(count(), before)
})

test('无效视频上传不修改分集并清除临时文件', async () => {
  const episode = db.prepare("INSERT INTO episodes (drama_id, no, title, status) VALUES (?, 90, '上传校验', 'pending') RETURNING id").get(dramaId)
  const path = join(root, 'invalid-upload.part')
  writeFileSync(path, '不是视频')
  const result = await call('POST', `/admin/api/episodes/${episode.id}/upload`, { token: actors.root.token })
  assert.equal(result.status, 400)
  const row = db.prepare('SELECT status, source_path FROM episodes WHERE id = ?').get(episode.id)
  assert.equal(row.status, 'pending')
  assert.equal(row.source_path, null)
  assert.equal(existsSync(path), false)
})

test('旧支付配置接口停用，升级清理明文但保留原渠道和审计记录', async () => {
  dbModule.migratePayChannels()
  const before = db.prepare("SELECT config_cipher FROM pay_channels WHERE channel_code = 'alipay'").get().config_cipher
  const sentinel = 'fixture-key-not-a-real-secret'
  dbModule.setSetting('pay', { alipay: { privateKey: sentinel, refundEnabled: false } })
  const audit = db.prepare("INSERT INTO audit_logs (actor_type, action, before_json, after_json) VALUES ('admin', 'admin.pay.settings', ?, ?) RETURNING id").get(sentinel, sentinel)
  const legacy = await call('GET', '/admin/api/pay-settings', { token: actors.root.token })
  assert.equal(legacy.status, 410)
  assert.ok(!JSON.stringify(legacy).includes(sentinel))
  const write = await call('PUT', '/admin/api/pay-settings', { token: actors.root.token, body: { pay: {} } })
  assert.equal(write.status, 410)
  dbModule.migratePayChannels()
  assert.ok(!JSON.stringify(dbModule.getSetting('pay')).includes(sentinel))
  assert.equal(db.prepare("SELECT config_cipher FROM pay_channels WHERE channel_code = 'alipay'").get().config_cipher, before)
  const auditRow = db.prepare('SELECT before_json, after_json FROM audit_logs WHERE id = ?').get(audit.id)
  assert.equal(auditRow.before_json, null)
  assert.equal(auditRow.after_json, null)
})

after(() => {
  server?.close()
  db.close()
  rmSync(root, { recursive: true, force: true })
})

test('后台选项接口不带 token 返回 401', async () => {
  const result = await call('GET', '/admin/api/options')
  assert.equal(result.status, 401)
  assert.equal(result.code, '0401')
})

test('后台选项接口有内容读权限时正常返回字典', async () => {
  const result = await call('GET', '/admin/api/options', { token: actors.contentOps.token })
  assert.equal(result.status, 200, result.msg)
  assert.ok(Array.isArray(result.data.dramaStatus))
})

test('非超管修改角色权限时写入 system.admin 被拒 403', async () => {
  const target = db.prepare("SELECT id FROM roles WHERE code = 'content_ops_x'").get()
  const result = await call('PUT', `/admin/api/roles/${target.id}`, {
    token: actors.roleEditor.token,
    body: { permissions: ['content.drama.read', 'system.admin'] },
  })
  assert.equal(result.status, 403, result.msg)
  assert.equal(result.data.error, 'protected_permission')
})

test('非超管修改角色权限时写入未知权限码被拒 400', async () => {
  const target = db.prepare("SELECT id FROM roles WHERE code = 'content_ops_x'").get()
  const result = await call('PUT', `/admin/api/roles/${target.id}`, {
    token: actors.roleEditor.token,
    body: { permissions: ['not.a.real.permission'] },
  })
  assert.equal(result.status, 400, result.msg)
  assert.equal(result.data.error, 'unknown_permission')
})

test('非超管建号时授予 super_admin 被拒 403', async () => {
  const result = await call('POST', '/admin/api/admins', {
    token: actors.delegator.token,
    body: { username: 'escalated', password: 'Passw0rd!2345', roles: ['super_admin'] },
  })
  assert.equal(result.status, 403, result.msg)
  assert.equal(result.data.error, 'protected_role')
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM admins WHERE username = 'escalated'").get().n, 0)
})

test('只有 cs.toolkit 而没有 cs.toolkit.grant 的客服账号补发权益被拒 403', async () => {
  const result = await call('POST', '/admin/api/cs/grant', {
    token: actors.csMenuOnly.token,
    body: { userId, dramaId, kind: 'single' },
  })
  assert.equal(result.status, 403, result.msg)
  assert.equal(result.data.required, 'cs.toolkit.grant')
})

test('补发权益的 days 越界或非法一律 400，不再静默算进 valid_to', async () => {
  for (const days of [36500, -1, 'abc', 0, 1.5]) {
    const result = await call('POST', '/admin/api/cs/grant', {
      token: actors.csGrant.token,
      body: { userId, kind: 'subscription', planId, days },
    })
    assert.equal(result.status, 400, `days=${days} 应被拒：${result.msg}`)
    assert.match(result.msg, /1–3650/)
  }
  const subscriptions = db.prepare('SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?').get(userId).n
  assert.equal(subscriptions, 0, '被拒的请求不该留下订阅记录')
})

test('补发权益拒绝不存在的用户与不存在的剧 404', async () => {
  const noUser = await call('POST', '/admin/api/cs/grant', {
    token: actors.csGrant.token,
    body: { userId: 999999, dramaId, kind: 'single' },
  })
  assert.equal(noUser.status, 404, noUser.msg)
  const noDrama = await call('POST', '/admin/api/cs/grant', {
    token: actors.csGrant.token,
    body: { userId, dramaId: 999999, kind: 'single' },
  })
  assert.equal(noDrama.status, 404, noDrama.msg)
})

test('补发权益同一部剧第二次返回 alreadyOwned 而不是再插一条', async () => {
  const first = await call('POST', '/admin/api/cs/grant', {
    token: actors.csGrant.token,
    body: { userId, dramaId, kind: 'single' },
  })
  assert.equal(first.status, 200, first.msg)
  assert.equal(first.data.alreadyOwned, false)
  const second = await call('POST', '/admin/api/cs/grant', {
    token: actors.csGrant.token,
    body: { userId, dramaId, kind: 'single' },
  })
  assert.equal(second.status, 200, second.msg)
  assert.equal(second.data.alreadyOwned, true)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND drama_id = ? AND status = 'active'").get(userId, dramaId).n, 1)
})

test('只读财务调用 close-expired 返回 403（写操作不能挂在读权限上）', async () => {
  const result = await call('POST', '/admin/api/close-expired', { token: actors.financeReadOnly.token, body: {} })
  assert.equal(result.status, 403, result.msg)
  assert.equal(result.data.required, 'finance.order.confirm')
})

test('改剧状态用了白名单外的值被拒 400', async () => {
  const result = await call('PUT', `/admin/api/dramas/${dramaId}`, {
    token: actors.contentOps.token,
    body: { status: 'Published' },
  })
  assert.equal(result.status, 400, result.msg)
  assert.match(result.msg, /状态不合法/)
  assert.equal(db.prepare('SELECT status FROM dramas WHERE id = ?').get(dramaId).status, 'draft')
})

test('删不存在的分集返回 404 而不是假成功', async () => {
  const result = await call('DELETE', `/admin/api/episodes/999999`, { token: actors.contentOps.token })
  assert.equal(result.status, 404, result.msg)
})

test('改不存在的 Banner 返回 404 而不是 500', async () => {
  const result = await call('PUT', '/admin/api/banners/999999', {
    token: actors.contentOps.token,
    body: { name: '不存在的 banner' },
  })
  assert.equal(result.status, 404, result.msg)
})

test('往楼层里挂不存在的剧返回 404', async () => {
  const section = db.prepare("INSERT INTO sections (title, sort) VALUES ('回归楼层', 0)").run()
  const sectionId = Number(section.lastInsertRowid)
  const missingDrama = await call('POST', '/admin/api/sections', {
    token: actors.contentOps.token,
    body: { action: 'attach', sectionId, dramaId: 999999 },
  })
  assert.equal(missingDrama.status, 404, missingDrama.msg)
  const missingSection = await call('POST', '/admin/api/sections', {
    token: actors.contentOps.token,
    body: { action: 'attach', sectionId: 999999, dramaId },
  })
  assert.equal(missingSection.status, 404, missingSection.msg)
})

test('analytics 的 days 传 abc 不再触发 500', async () => {
  const result = await call('GET', '/admin/api/analytics?days=abc', { token: actors.root.token })
  assert.equal(result.status, 200, result.msg)
  assert.equal(result.code, '0000')
})

test('安全事件接口的 limit 传 abc 不会变成不限量', async () => {
  db.prepare("INSERT INTO security_events (kind, detail) VALUES ('regression', 'limit test')").run()
  const result = await call('GET', '/admin/api/security?limit=abc', { token: actors.root.token })
  assert.equal(result.status, 200, result.msg)
  assert.ok(Array.isArray(result.data.events))
  assert.ok(result.data.events.length <= 200)
})

test('客服代发登录码默认不返回明文，并写下 security_events 审计', async () => {
  const result = await call('POST', `/admin/api/users/${userId}/login-code`, {
    token: actors.csMenuOnly.token,
    body: {},
  })
  assert.equal(result.status, 200, result.msg)
  assert.equal(result.data.code, undefined, '默认响应里不得出现明文登录码')
  assert.equal(result.data.purpose, 'cs_assist')
  const event = db.prepare("SELECT * FROM security_events WHERE kind = 'cs_assist_login_code' ORDER BY id DESC LIMIT 1").get()
  assert.ok(event, '必须留一条 security_events')
  const detail = JSON.parse(event.detail)
  assert.equal(detail.plaintext, false)
  assert.equal(detail.userId, userId)
  assert.equal(detail.purpose, 'cs_assist')
})

test('明文开关打开后才返回登录码，且验证码用途落库为 cs_assist', async () => {
  // otp 对同一邮箱有 60 秒限流，这里另起一个用户，避免撞上一条用例
  const other = db.prepare("INSERT INTO users (email, nickname, status) VALUES ('cs2@example.com', '客服测试用户二', 'active')").run()
  const otherId = Number(other.lastInsertRowid)
  // 只有显式打开 MH_CS_ASSIST_PLAINTEXT=1（或 otp 测试钩子）才把明文交给调用方
  process.env.MH_CS_ASSIST_PLAINTEXT = '1'
  const result = await call('POST', `/admin/api/users/${otherId}/login-code`, {
    token: actors.csMenuOnly.token,
    body: {},
  })
  delete process.env.MH_CS_ASSIST_PLAINTEXT
  assert.equal(result.status, 200, result.msg)
  assert.equal(result.data.purpose, 'cs_assist')
  assert.match(String(result.data.code ?? ''), /^\d{6}$/, '打开开关后才允许带明文码')
  const row = db.prepare("SELECT purpose FROM email_codes WHERE email = 'cs2@example.com' ORDER BY id DESC LIMIT 1").get()
  assert.equal(row?.purpose, 'cs_assist', '落库用途必须是 cs_assist，不能混成 login')
  const event = db.prepare("SELECT detail FROM security_events WHERE kind = 'cs_assist_login_code' ORDER BY id DESC LIMIT 1").get()
  assert.equal(JSON.parse(event.detail).plaintext, true)
})

test('新增分集在同一剧里重复集号返回 409，且不留半截数据', async () => {
  const series = db.prepare("INSERT INTO dramas (title, category, status, is_adult) VALUES ('集号回归剧', 'TV', 'draft', 0)").run()
  const seriesId = Number(series.lastInsertRowid)
  const first = await call('POST', `/admin/api/dramas/${seriesId}/episodes`, {
    token: actors.contentOps.token,
    body: { no: 1, title: '第一集' },
  })
  assert.equal(first.status, 200, first.msg)
  const second = await call('POST', `/admin/api/dramas/${seriesId}/episodes`, {
    token: actors.contentOps.token,
    body: { no: 1, title: '重复第一集' },
  })
  assert.equal(second.status, 409, second.msg)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND no = 1').get(seriesId).n, 1)
})

test('后台剧集列表的查询次数与页大小无关（不再 N+1）', async () => {
  const insert = db.prepare("INSERT INTO dramas (title, category, status, is_adult) VALUES (?, 'MOVIE', 'draft', 0)")
  for (let index = 0; index < 40; index += 1) insert.run(`批量回归剧 ${index}`)
  const realPrepare = db.prepare.bind(db)
  let queries = 0
  db.prepare = (sql) => { queries += 1; return realPrepare(sql) }
  try {
    const result = await call('GET', '/admin/api/dramas?pageSize=50', { token: actors.contentOps.token })
    assert.equal(result.status, 200, result.msg)
    assert.ok(result.data.list.length >= 40)
  } finally {
    db.prepare = realPrepare
  }
  assert.ok(queries < 30, `一页 50 行只应触发少量查询，实际 ${queries} 条`)
})

test('提权接口与写操作没有再挂在 .read 权限上（静态扫描）', () => {
  const source = readFileSync(new URL('../server/api-admin.mjs', import.meta.url), 'utf8').split('\n')
  // 这两个是「探测连通性 / 渲染预览」，没有持久化副作用，允许用读权限
  const allowed = ['pay-channels', 'test', 'email-template/preview']
  const offenders = []
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index]
    const match = /method === '(POST|PUT|DELETE|PATCH)'/.exec(line)
    if (!match) continue
    const window = source.slice(index, index + 14).join('\n')
    const guards = [...window.matchAll(/guard\((PERM\.\w+|'[\w.]+')\)/g)].map((item) => item[1])
    if (!guards.length) continue
    const guard = guards[0]
    const code = /^'/.test(guard) ? guard.slice(1, -1) : null
    const isRead = code ? code.endsWith('.read') : /Read$/.test(guard)
    if (!isRead) continue
    const signature = source.slice(index, index + 3).join(' ')
    if (allowed.some((item) => signature.includes(item))) continue
    offenders.push(`${index + 1}: ${line.trim().slice(0, 80)} guard=${guard}`)
  }
  assert.deepEqual(offenders, [], `写操作挂在读权限上：\n${offenders.join('\n')}`)
})
