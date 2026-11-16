/** 口令异步化 / 验证码一次性与限流 / RBAC 保护集 / 限流桶归一 回归测试。 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const dir = mkdtempSync(join(tmpdir(), 'mh-fix-auth-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_SECRET = 'fix-auth-secret'
process.env.MH_OTP_SECRET = 'fix-auth-otp-secret'
process.env.MH_OTP_TEST = '1'
process.env.NODE_ENV = 'test'

let db, auth, otp, rbac, rl, superAdminId

before(async () => {
  const module = await import('../server/db.mjs')
  db = module.db
  module.seedIfEmpty()
  module.ensureUserSchema()
  module.syncMenuCatalog()
  auth = await import('../server/auth.mjs')
  otp = await import('../server/otp.mjs')
  rbac = await import('../server/rbac.mjs')
  rl = await import('../server/ratelimit.mjs')
  superAdminId = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get().id
})

after(() => { try { db.close() } catch { /* ignore */ } })

const counter = { n: 0 }
const newEmail = () => `fixauth${Date.now()}${counter.n++}@example.com`
const sqlAgo = (seconds) => new Date(Date.now() - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ')
const insertSendLog = (email, purpose, ip, at) => db
  .prepare('INSERT INTO email_send_log (email, purpose, ip, sent_date, created_at) VALUES (?, ?, ?, ?, ?)')
  .run(email, purpose, ip, at.slice(0, 10), at)

/* ---------------- auth.mjs：异步 scrypt 与常量时间比较 ---------------- */

test('口令哈希：hashPassword 无 salt 时返回 Promise，落库串自描述 scrypt$cost$salt$hash', async () => {
  const pending = auth.hashPassword('fix-auth-pw-1')
  assert.ok(pending instanceof Promise, 'hashPassword 不传 salt 必须返回 Promise（异步 scrypt）')
  const stored = await pending
  assert.match(stored, /^scrypt\$16384\$[0-9a-f]{16}\$[0-9a-f]{64}$/)
  assert.ok(!stored.includes('fix-auth-pw-1'), '落库串不能含明文口令')
})

test('口令校验：两参异步 verifyPassword 认正确口令、拒错误口令与非法摘要', async () => {
  const stored = await auth.hashPassword('fix-auth-pw-2')
  assert.equal(await auth.verifyPassword('fix-auth-pw-2', stored), true)
  assert.equal(await auth.verifyPassword('fix-auth-pw-3', stored), false)
  assert.equal(await auth.verifyPassword('fix-auth-pw-2', 'garbage'), false)
  assert.equal(await auth.verifyPassword('fix-auth-pw-2', ''), false)
})

test('口令哈希：并发 20 次异步 scrypt 期间事件循环仍在跑定时器（不再整段阻塞）', async () => {
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 5)
  try {
    const started = Date.now()
    const hashes = await Promise.all(Array.from({ length: 20 }, (_, index) => auth.hashPassword(`concurrent-${index}`)))
    const elapsed = Date.now() - started
    assert.equal(new Set(hashes).size, 20, '每次哈希的随机 salt 必须不同')
    assert.ok(ticks >= 3, `20 次异步 scrypt 期间事件循环应至少触发 3 个 5ms 定时器，实际 ${ticks}，耗时 ${elapsed}ms`)
  } finally {
    clearInterval(timer)
  }
})

test('口令校验：历史同步三参形态与裸 hex 摘要仍能验通，非法入参一律 false', async () => {
  const salt = 'a1b2c3d4e5f60718'
  const syncHash = auth.hashPassword('fix-auth-pw-4', salt)
  assert.equal(typeof syncHash, 'string', '传 salt 的兼容形态保持同步返回，供 db.mjs 种子与脚本调用')
  assert.match(syncHash, /^scrypt\$16384\$/)
  assert.equal(auth.verifyPassword('fix-auth-pw-4', salt, syncHash), true)
  assert.equal(auth.verifyPassword('fix-auth-pw-5', salt, syncHash), false)
  assert.equal(auth.verifyPassword('fix-auth-pw-4', 'x', 'y'), false)

  const legacy = scryptSync('fix-auth-pw-4', salt, 32).toString('hex')
  assert.equal(auth.verifyPassword('fix-auth-pw-4', salt, legacy), true, '老库里 salt/hash 分列存储的裸 hex 摘要必须继续可校验')
  assert.equal(auth.verifyPassword('fix-auth-pw-9', salt, legacy), false)
  assert.equal(await auth.verifyPasswordAsync('fix-auth-pw-4', salt, legacy), true)
})

test('会话 token：签名被篡改、缺段、长度不符、无库中会话的 token 一律验签失败', () => {
  const { token } = auth.issueToken(superAdminId, 'admin')
  assert.equal(auth.verifyToken(token).sub, superAdminId)
  const [body, mac] = token.split('.')
  const flipped = `${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`
  assert.equal(auth.verifyToken(flipped), undefined, '改一个字节的 MAC 必须失败')
  assert.equal(auth.verifyToken(body), undefined, '缺少 MAC 段必须失败')
  assert.equal(auth.verifyToken(`${body}.`), undefined, '空 MAC 必须失败')
  assert.equal(auth.verifyToken(`${body}.${mac}x`), undefined, 'MAC 长度不符必须失败')
  assert.equal(auth.verifyToken(''), undefined)
  assert.equal(auth.verifyToken(undefined), undefined)
  assert.equal(
    auth.verifyToken(auth.signToken({ sub: 1, role: 'admin', exp: Date.now() + 60_000 })),
    undefined,
    '签名正确但库里没有会话（已登出/改密）必须失败',
  )
})

/* ---------------- otp.mjs：明文回显、一次性、并发、限流 ---------------- */

test('测试钩子：MH_OTP_TEST 只在 NODE_ENV=test 时回显 testCode', async () => {
  assert.equal(otp.otpTestHookEnabled(), true)
  const sent = await otp.sendCode({ email: newEmail(), purpose: 'login', ip: '203.0.113.10' })
  assert.match(sent.testCode, /^\d{6}$/)

  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = 'development'
  try {
    assert.equal(otp.otpTestHookEnabled(), false, 'NODE_ENV 不是 test 时测试钩子必须关闭')
    await assert.rejects(
      () => otp.sendCode({ email: newEmail(), purpose: 'login', ip: '203.0.113.11' }),
      (error) => {
        assert.ok(['mail_not_configured', 'mail_failed'].includes(error.code), `钩子关闭时必须走真实发信通道，实际错误码 ${error.code}`)
        return true
      },
    )
  } finally {
    process.env.NODE_ENV = prev
  }
})

test('测试钩子：生产环境设置 MH_OTP_TEST 时 otp 模块加载即失败（进程起不来）', () => {
  const target = pathToFileURL(join(process.cwd(), 'server/otp.mjs')).href
  const script = `import(${JSON.stringify(target)}).then(() => console.log('otp-loaded'))`
  const baseEnv = { ...process.env, NODE_ENV: 'production', MH_DB: join(dir, 'prod.db') }
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env,
  })

  for (const value of ['1', '0']) {
    const blocked = run({ ...baseEnv, MH_OTP_TEST: value })
    assert.notEqual(blocked.status, 0, `MH_OTP_TEST=${value} 在生产环境必须让模块加载失败`)
    assert.match(`${blocked.stdout}${blocked.stderr}`, /MH_OTP_TEST/)
  }

  const cleanEnv = { ...baseEnv }
  delete cleanEnv.MH_OTP_TEST
  const clean = run(cleanEnv)
  assert.equal(clean.status, 0, `生产环境不设 MH_OTP_TEST 时必须能正常加载：${clean.stderr}`)
  assert.match(clean.stdout, /otp-loaded/)
})

test('验证码并发：10 个并发错误猜测只消耗 3 次尝试额度，验证码随即作废', async () => {
  const email = newEmail()
  const sent = await otp.sendCode({ email, purpose: 'login', ip: '203.0.113.20' })
  const wrong = String((Number(sent.testCode) + 1) % 1_000_000).padStart(6, '0')

  const outcomes = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve()
    .then(() => otp.verifyCode({ email, purpose: 'login', code: wrong }))
    .then(() => 'ok', (error) => error.code)))

  assert.equal(outcomes.filter((code) => code === 'ok').length, 0, '错误码不可能兑换成功')
  const budgeted = outcomes.filter((code) => code === 'code_invalid' || code === 'code_locked').length
  assert.ok(budgeted <= 3, `10 个并发猜测最多消耗 3 次尝试额度，实际 ${budgeted}（${outcomes.join(',')}）`)

  const row = db.prepare('SELECT attempts, max_attempts, consumed_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email)
  assert.equal(row.attempts, 3, 'attempts 必须被原子自增封顶在 3，不能被并发放大到 10')
  assert.ok(row.consumed_at, '达到尝试上限后验证码必须立即作废')
  await assert.rejects(
    async () => otp.verifyCode({ email, purpose: 'login', code: sent.testCode }),
    (error) => error.code === 'code_not_found',
    '作废后连正确的码也不能再兑换',
  )
})

test('验证码一次性：正确码兑换一次后第二次报失效', async () => {
  const email = newEmail()
  const sent = await otp.sendCode({ email, purpose: 'login', ip: '203.0.113.21' })
  const ok = otp.verifyCode({ email, purpose: 'login', code: sent.testCode })
  assert.equal(ok.email, email)
  assert.ok(ok.consumedAt)
  await assert.rejects(
    async () => otp.verifyCode({ email, purpose: 'login', code: sent.testCode }),
    (error) => error.code === 'code_not_found',
  )
})

test('客服代发：purpose=cs_assist 原样落库，明文码只在显式索取且钩子成立时返回', () => {
  const email = newEmail()
  const silent = otp.issueAssistCode(email, { operator: 'cs01', purpose: 'cs_assist', withPlainCode: false })
  assert.equal(silent.code, undefined, 'otp 侧默认不下发明文码')
  assert.equal(silent.purpose, 'cs_assist')
  assert.equal(silent.operator, 'cs01')
  assert.equal(silent.maxAttempts, 3)

  const row = db.prepare('SELECT purpose, user_agent FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email)
  assert.equal(row.purpose, 'cs_assist', '客服代发必须落真实 purpose，不再伪装成用户自取的 login')
  assert.equal(row.user_agent, 'admin-assist:cs01')

  const withCode = otp.issueAssistCode(newEmail(), { operator: 'cs01', purpose: 'cs_assist', withPlainCode: true })
  assert.match(withCode.code, /^\d{6}$/)
  assert.throws(
    () => otp.issueAssistCode(newEmail(), { operator: 'cs01', purpose: 'purpose_invalid' }),
    (error) => error.code === 'purpose_invalid',
  )
})

test('客服代发：cs_assist 码可在登录入口兑换，codesForPurpose 按用途区分且不含摘要', () => {
  const email = newEmail()
  const issued = otp.issueAssistCode(email, { operator: 'cs02', purpose: 'cs_assist' })
  assert.match(issued.code, /^\d{6}$/)

  const rows = otp.codesForPurpose('cs_assist', { email, activeOnly: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].purpose, 'cs_assist')
  assert.equal(rows[0].code_hash, undefined, '查询能力不返回验证码摘要')

  const consumed = otp.verifyCode({ email, purpose: 'login', code: issued.code })
  assert.equal(consumed.purpose, 'cs_assist', '登录入口兑换后返回真实用途')
  assert.equal(otp.codesForPurpose('login', { email, activeOnly: true }).length, 0, '兑换后不再有可用码')
})

test('发送限流：同一邮箱 60 秒内重复发码被拒，返回真实剩余秒数', async () => {
  const email = newEmail()
  const first = await otp.sendCode({ email, purpose: 'login', ip: '203.0.113.30' })
  assert.match(first.testCode, /^\d{6}$/)
  await assert.rejects(
    () => otp.sendCode({ email, purpose: 'login', ip: '203.0.113.30' }),
    (error) => {
      assert.equal(error.code, 'send_too_frequent')
      assert.equal(error.status, 429)
      assert.ok(error.extra.retryAfter > 0 && error.extra.retryAfter <= 60)
      assert.ok(error.extra.retryAfterSeconds > 0 && error.extra.retryAfterSeconds <= 60)
      return true
    },
  )
})

test('发送限流：同一邮箱 24 小时内第 6 条被拒，retryAfterSeconds 是真实剩余而非整个窗口', async () => {
  const email = newEmail()
  for (const seconds of [86_390, 86_000, 85_000, 84_000, 83_000]) {
    insertSendLog(email, 'login', '203.0.113.31', sqlAgo(seconds))
  }
  await assert.rejects(
    () => otp.sendCode({ email, purpose: 'login', ip: '203.0.113.31' }),
    (error) => {
      assert.equal(error.code, 'rate_limited')
      assert.equal(error.status, 429)
      assert.equal(error.extra.scope, 'email')
      assert.ok(
        error.retryAfterSeconds >= 1 && error.retryAfterSeconds <= 60,
        `应给出最早一条的剩余时间（约 10 秒），而不是 86400 秒整窗，实际 ${error.retryAfterSeconds}`,
      )
      return true
    },
  )
})

test('发送限流：同一 IP 24 小时内 20 条上限被拒', async () => {
  const ip = '198.51.100.77'
  for (let index = 0; index < 20; index += 1) {
    insertSendLog(`bulk${index}${Date.now()}@example.com`, 'login', ip, sqlAgo(3600 + index))
  }
  await assert.rejects(
    () => otp.sendCode({ email: newEmail(), purpose: 'login', ip }),
    (error) => {
      assert.equal(error.code, 'rate_limited')
      assert.equal(error.extra.scope, 'ip')
      assert.ok(error.retryAfterSeconds > 60, `24 小时窗口的剩余时间应远大于 60 秒，实际 ${error.retryAfterSeconds}`)
      return true
    },
  )
})

/* ---------------- ratelimit.mjs：桶键归一与桶上限 ---------------- */

test('限流桶键：IPv4-mapped 折叠成 IPv4，IPv6 归并到 /64，非法值落 unknown', () => {
  const cases = [
    ['203.0.113.9', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['203.0.113.9:443', '203.0.113.9'],
    ['[2001:db8:abcd:1234::1]:443', '2001:db8:abcd:1234::/64'],
    ['2001:db8:abcd:1234:5678:9abc:def0:1234', '2001:db8:abcd:1234::/64'],
    ['2001:db8:abcd:9999::1', '2001:db8:abcd:9999::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['not-an-ip', 'unknown'],
    ['::ffff:999.1.1.1', 'unknown'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(rl.normalizeBucketKey(input), expected, `${String(input)} 应归一为 ${expected}`)
  }
  assert.equal(
    rl.normalizeBucketKey('2001:db8:abcd:1234::1'),
    rl.normalizeBucketKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff'),
    '同一 /64 内换源地址必须落在同一个桶里',
  )
})

test('限流桶：超过 20000 个不同 IP 后内存桶有界（LRU 淘汰）', async () => {
  const fakeReq = (ip) => ({
    socket: { remoteAddress: ip },
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) fix-auth-test' },
  })
  for (let index = 0; index < 20_002; index += 1) {
    const ip = `10.${(index >> 16) & 255}.${(index >> 8) & 255}.${index & 255}`
    await rl.inspect(fakeReq(ip), '/api/home', 'GET')
  }
  const stats = rl.bucketStats()
  assert.equal(stats.maxBuckets, 20_000)
  assert.equal(stats.buckets, 20_000, `超过上限后必须停止增长，实际 ${stats.buckets}`)

  await rl.inspect(fakeReq('10.0.0.1'), '/api/home', 'GET')
  await rl.inspect(fakeReq('10.0.0.2'), '/api/home', 'GET')
  assert.equal(rl.bucketStats().buckets, 20_000, '命中已有桶不应再增长')
})

/* ---------------- rbac.mjs：死代码、白名单、保护集 ---------------- */

test('RBAC 直通：permissions 表没有 * 行，超管直通由 super_admin 角色显式判定', () => {
  assert.equal(db.prepare("SELECT code FROM permissions WHERE code = '*'").get(), undefined, 'permissions 表不存在 * 行')
  const principal = rbac.loadPrincipal(superAdminId)
  assert.equal(principal.permissions.has('*'), false)
  assert.equal(rbac.hasPermission(principal, 'definitely.not.in.catalog'), true, '超管按角色判定直通')

  const csAdmin = rbac.createAdmin({
    username: `cs_${Date.now()}`,
    displayName: 'CS 客服',
    passwordHash: 'qa-hash',
    salt: 'qa-salt',
    roleCodes: ['cs'],
  }, superAdminId)
  const csPrincipal = rbac.loadPrincipal(csAdmin.id)
  assert.equal(rbac.hasPermission(csPrincipal, 'user.login.assist'), true)
  assert.equal(rbac.hasPermission(csPrincipal, 'admin.write'), false)
  assert.equal(rbac.hasPermission(csPrincipal, 'definitely.not.in.catalog'), false, '非超管没有直通')
})

test('RBAC 白名单：未知权限码直接拒绝（unknown_permission）', () => {
  const role = rbac.createRole({ code: `qa_w_${Date.now()}`, name: 'QA 白名单', description: '回归' })
  assert.throws(
    () => rbac.replaceRolePermissions(role.id, ['dashboard', 'not.a.real.permission'], superAdminId),
    (error) => {
      assert.equal(error.code, 'unknown_permission')
      assert.deepEqual(error.extra.unknown, ['not.a.real.permission'])
      return true
    },
  )
  assert.throws(
    () => rbac.updateRolePermissions(role.id, ['nope.nope']),
    (error) => error.code === 'unknown_permission',
    '旧名 updateRolePermissions 必须共享同一套校验',
  )
  assert.equal(rbac.listRoles().find((item) => item.id === role.id).permissions.length, 0, '被拒绝的写入不能落库')
})

test('RBAC 保护集：非超管既不能授予也不能收回 admin.write 等高危权限', () => {
  const role = rbac.createRole({ code: `qa_p_${Date.now()}`, name: 'QA 保护集', description: '回归' })

  assert.throws(
    () => rbac.replaceRolePermissions(role.id, ['dashboard', 'admin.write']),
    (error) => {
      assert.equal(error.code, 'protected_permission')
      assert.equal(error.status, 403)
      assert.deepEqual(error.extra.grants, ['admin.write'])
      return true
    },
    '持 admin.write 的账号不能给自己所在角色补上 admin.write',
  )

  const granted = rbac.replaceRolePermissions(role.id, ['dashboard', 'admin.write'], superAdminId)
  assert.ok(granted.permissions.includes('admin.write'))

  assert.throws(
    () => rbac.replaceRolePermissions(role.id, ['dashboard']),
    (error) => {
      assert.equal(error.code, 'protected_permission')
      assert.deepEqual(error.extra.revokes, ['admin.write'])
      return true
    },
    '非超管也不能反向收回高危权限（否则可以靠掏空对家角色完成接管）',
  )
})

test('RBAC 自锁：内置角色的权限集合不允许被清空', () => {
  const csRole = rbac.listRoles().find((role) => role.code === 'cs')
  assert.throws(
    () => rbac.replaceRolePermissions(csRole.id, [], superAdminId),
    (error) => {
      assert.equal(error.code, 'role_lockout')
      return true
    },
  )
  const narrowed = rbac.replaceRolePermissions(csRole.id, ['dashboard'], superAdminId)
  assert.deepEqual(narrowed.permissions, ['dashboard'], '内置角色可以收窄，只是不能被清空')
  rbac.replaceRolePermissions(
    csRole.id,
    ['cs.toolkit', 'cs.toolkit.grant', 'commerce.order', 'dashboard', 'finance.order.read', 'user.list', 'user.login.assist', 'user.read'],
    superAdminId,
  )
})

test('RBAC 角色分配：super_admin 的授予需超管主体，最后超管保护优先抛出', () => {
  assert.equal(rbac.activeAdminsOfRole('super_admin'), 1)
  const financeRole = rbac.listRoles().find((role) => role.code === 'finance')

  assert.throws(
    () => rbac.setAdminRoles(superAdminId, ['no_such_role'], superAdminId),
    (error) => error.code === 'unknown_role',
  )
  assert.throws(
    () => rbac.setAdminRoles(superAdminId, [financeRole.code]),
    /最后一个启用中的超级管理员/,
    '历史保护必须保持原有错误文案（其它测试依赖）',
  )
  assert.throws(
    () => rbac.setAdminRoles(superAdminId, [financeRole.code]),
    (error) => error.code === 'last_super_admin' && error.status === 400,
    '最后超管保护也要带可识别的 code，调用方不能只靠中文文案分支',
  )

  const normalAdmin = rbac.createAdmin({
    username: `ops_${Date.now()}`,
    displayName: '运营',
    passwordHash: 'qa-hash',
    salt: 'qa-salt',
    roleCodes: [financeRole.code],
  }, superAdminId)

  assert.throws(
    () => rbac.setAdminRoles(normalAdmin.id, ['super_admin']),
    (error) => {
      assert.equal(error.code, 'protected_role')
      assert.equal(error.status, 403)
      return true
    },
    '没有主体就只能分配普通角色',
  )
  rbac.setAdminRoles(normalAdmin.id, ['super_admin'], superAdminId)
  assert.equal(rbac.activeAdminsOfRole('super_admin'), 2)
})
