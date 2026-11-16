import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 独立临时库：绝不碰 storage/app.db；MH_SESSION_PRUNE 关掉，避免测试进程留下定时器
const dir = mkdtempSync(join(tmpdir(), 'mh-fix-core-db-'))
process.env.MH_DB = join(dir, 'app.db')
process.env.MH_SECRET = 'test-secret-fix-core-db'
process.env.MH_LINK_SECRET = 'test-link-secret-fix-core-db'
process.env.MH_ADMIN_INIT_PASSWORD = 'Admin#12345'
process.env.MH_SESSION_PRUNE = '0'

const dbModule = await import('../server/db.mjs')
const rankModule = await import('../server/rank.mjs')
const analyticsModule = await import('../server/analytics.mjs')
const statsModule = await import('../server/content-stats.mjs')
const ent = await import('../server/entitlements.mjs')
const trackModule = await import('../server/tracks.mjs')
const tagModule = await import('../server/tags.mjs')
const { ADULT_TAG_GROUPS } = await import('../server/adult-taxonomy.mjs')

const { db } = dbModule
const run = (sql, ...args) => db.prepare(sql).run(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)

let seq = 0

function insertDrama(overrides = {}) {
  seq += 1
  const info = run(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category,
      score, status, sort, content_type, is_adult, source_key, published_at)
    VALUES (?, '', '', '', ?, '中国大陆', ?, ?, ?, 0, ?, ?, ?, datetime('now'))`,
  overrides.title ?? `测试剧 ${seq}`,
  overrides.year ?? 2026,
  overrides.category ?? 'TV',
  overrides.score ?? 8,
  overrides.status ?? 'published',
  overrides.contentType ?? 'series',
  overrides.isAdult ?? 0,
  overrides.sourceKey ?? null)
  return Number(info.lastInsertRowid)
}

function insertUser() {
  seq += 1
  const info = run("INSERT INTO users (nickname, phone) VALUES (?, ?)", `测试用户${seq}`, `13${String(seq).padStart(9, '0')}`)
  return Number(info.lastInsertRowid)
}

function insertEpisode(dramaId) {
  const info = run("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, 1, '第 1 集', 600, 'ready')", dramaId)
  return Number(info.lastInsertRowid)
}

test('首页运营菜单只用单一权限码，历史复合串会被迁移刷掉', () => {
  const ops = one("SELECT perm_code FROM admin_menus WHERE route = '/ops'")
  assert.equal(ops.perm_code, 'ops.section.write')
  const compound = all("SELECT route, perm_code FROM admin_menus WHERE perm_code LIKE '%&%'")
  assert.deepEqual(compound, [])
  // 迁移幂等：库里残留的旧复合串必须在 syncMenuCatalog 后被刷成单一权限码
  run("UPDATE admin_menus SET perm_code = 'ops.banner.write&ops.section.write' WHERE route = '/ops'")
  dbModule.syncMenuCatalog()
  assert.equal(one("SELECT perm_code FROM admin_menus WHERE route = '/ops'").perm_code, 'ops.section.write')
  // 且该权限码真实存在于权限表，hasPermission 的精确匹配才可能命中
  assert.ok(one("SELECT code FROM permissions WHERE code = 'ops.section.write'"))
})

test('重复 source_key 的剧目去重保留最小 id，其余置空，唯一索引拦住再次插入', () => {
  // 模拟老库：先没有唯一索引，导入脚本「先查后插」留下了三份同 source_key 的剧
  run('DROP INDEX IF EXISTS idx_dramas_source_key_unique')
  const key = `test:source-${randomUUID()}`
  const first = insertDrama({ sourceKey: key })
  const second = insertDrama({ sourceKey: key })
  const third = insertDrama({ sourceKey: key })
  const repaired = dbModule.ensureDramaSourceKeyUnique()
  assert.equal(repaired.removed, 2)
  assert.equal(one('SELECT source_key AS k FROM dramas WHERE id = ?', first).k, key)
  assert.equal(one('SELECT source_key AS k FROM dramas WHERE id = ?', second).k, null)
  assert.equal(one('SELECT source_key AS k FROM dramas WHERE id = ?', third).k, null)
  // 幂等：再跑一次没有可清的重复，索引照旧存在
  assert.equal(dbModule.ensureDramaSourceKeyUnique().removed, 0)
  assert.ok(one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dramas_source_key_unique'"))
  assert.throws(() => insertDrama({ sourceKey: key }), /UNIQUE/i)
})

test('同一用户同一部剧的重复有效权益会去重，唯一索引拦住重复发放', () => {
  // 模拟老库：索引还不存在时客服重复发过权益
  run('DROP INDEX IF EXISTS idx_purchases_active_permanent')
  run('DROP INDEX IF EXISTS idx_purchases_active_rental')
  const dramaId = insertDrama()
  const userId = insertUser()
  const userId2 = insertUser()
  const base = run('INSERT INTO purchases (user_id, drama_id, kind, status) VALUES (?, ?, ?, ?)', userId, dramaId, 'single', 'active')
  run('INSERT INTO purchases (user_id, drama_id, kind, status) VALUES (?, ?, ?, ?)', userId, dramaId, 'single', 'active')
  assert.equal(dbModule.dedupeActivePurchases(), 1)
  assert.equal(one("SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND status = 'active'", userId).n, 1)
  assert.equal(one('SELECT status FROM purchases WHERE id = ?', Number(base.lastInsertRowid)).status, 'active')
  // 限时租赁按到期时刻区分：不同到期时间可以并存
  run("INSERT INTO purchases (user_id, drama_id, kind, expires_at, status) VALUES (?, ?, 'rental', datetime('now', '+3 days'), 'active')", userId2, dramaId)
  run("INSERT INTO purchases (user_id, drama_id, kind, expires_at, status) VALUES (?, ?, 'rental', datetime('now', '+7 days'), 'active')", userId2, dramaId)
  assert.equal(dbModule.ensurePurchaseUniqueIndexes().superseded, 0)
  assert.throws(() => run('INSERT INTO purchases (user_id, drama_id, kind, status) VALUES (?, ?, ?, ?)', userId, dramaId, 'single', 'active'), /UNIQUE/i)
  assert.equal(one("SELECT COUNT(*) AS n FROM purchases WHERE user_id = ? AND status = 'active'", userId2).n, 2)
})

test('过期会话被清理函数删除，未过期会话保留', () => {
  const expired = `expired-${randomUUID()}`
  const alive = `alive-${randomUUID()}`
  run("INSERT INTO sessions (token, subject_id, role, expires_at) VALUES (?, 1, 'user', ?)", expired, Date.now() - 60_000)
  run("INSERT INTO sessions (token, subject_id, role, expires_at) VALUES (?, 1, 'user', ?)", alive, Date.now() + 3_600_000)
  const before = one('SELECT COUNT(*) AS n FROM sessions').n
  assert.equal(dbModule.pruneExpiredSessions(), 1)
  assert.equal(one('SELECT COUNT(*) AS n FROM sessions').n, before - 1)
  assert.equal(one('SELECT COUNT(*) AS n FROM sessions WHERE token = ?', expired).n, 0)
  assert.equal(one('SELECT COUNT(*) AS n FROM sessions WHERE token = ?', alive).n, 1)
})

test('试看计量按主体与剧目累计，超出窗口的历史不计入', () => {
  const dramaA = insertDrama()
  const dramaB = insertDrama()
  const subject = `u:${randomUUID()}`
  assert.equal(dbModule.recordTrialUse({ subjectKind: 'user', subject, dramaId: dramaA, episodeId: 1, secondsUsed: 90 }), 90)
  dbModule.recordTrialUse({ subjectKind: 'user', subject, dramaId: dramaA, episodeId: 2, secondsUsed: 30 })
  assert.deepEqual(dbModule.trialBudget({ subjectKind: 'user', subject, dramaId: dramaA }), { usedSeconds: 120, windows: 2 })
  // 别的剧、别的主体都不串账
  assert.deepEqual(dbModule.trialBudget({ subjectKind: 'user', subject, dramaId: dramaB }), { usedSeconds: 0, windows: 0 })
  assert.deepEqual(dbModule.trialBudget({ subjectKind: 'visitor', subject }), { usedSeconds: 0, windows: 0 })
  // 48 小时前的用量不算在 24 小时窗口里，但 72 小时窗口要算
  run(`INSERT INTO trial_uses (subject_kind, subject, drama_id, episode_id, seconds_used, created_at)
    VALUES ('user', ?, NULL, NULL, 300, datetime('now', '-48 hours'))`, subject)
  assert.deepEqual(dbModule.trialBudget({ subjectKind: 'user', subject }), { usedSeconds: 0, windows: 0 })
  assert.deepEqual(dbModule.trialBudget({ subjectKind: 'user', subject, windowHours: 72 }), { usedSeconds: 300, windows: 1 })
  // 非法参数不落账
  assert.equal(dbModule.recordTrialUse({ subjectKind: '', subject, secondsUsed: 10 }), 0)
})

test('试看播放令牌被篡改或长度不符时校验失败且不抛异常', () => {
  const token = ent.signPlayToken({ episodeId: 1, dramaId: 2, userId: 3 }, 60)
  assert.equal(ent.verifyPlayToken(token).episodeId, 1)
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`
  assert.equal(ent.verifyPlayToken(tampered), undefined)
  const [body] = token.split('.')
  assert.equal(ent.verifyPlayToken(`${body}.x`), undefined)
  assert.equal(ent.verifyPlayToken(`${body}.`), undefined)
  assert.equal(ent.verifyPlayToken(body), undefined)
})

test('按集定价的非法集数直接报错，不会落库成 NULL 变成无上限', () => {
  const dramaId = insertDrama()
  assert.throws(() => ent.setEpisodeRules(dramaId, [{ fromNo: 1, toNo: 'abc' }]), (error) => error.status === 400)
  assert.throws(() => ent.setEpisodeRules(dramaId, [{ fromNo: 'x', toNo: 3 }]), (error) => error.status === 400)
  assert.equal(one('SELECT COUNT(*) AS n FROM episode_price_rules WHERE drama_id = ?', dramaId).n, 0)
  // 合法值按整数落库；留空表示不设上限（显式省略，不是 NaN 折算）
  ent.setEpisodeRules(dramaId, [{ fromNo: 1, toNo: '3', mode: 'vip' }, { fromNo: 4, toNo: '', mode: 'free' }])
  const rules = ent.rulesOfDrama(dramaId)
  assert.deepEqual(rules.map((rule) => [Number(rule.from_no), rule.to_no === null ? null : Number(rule.to_no)]), [[1, 3], [4, null]])
})

test('指定 scope 的签名链接把 TTL 夹在 5 秒到上限之间，secureLink 行为不变', () => {
  const ua = 'Mozilla/5.0 (test)'
  const res = { setHeader() {}, req: { headers: { 'user-agent': ua } } }
  const short = ent.secureLinkScoped(res, '/media/trial/9/', 1)
  assert.equal(short.ttl, 5)
  assert.equal(short.scope, '/media/trial/9/')
  assert.ok(ent.verifyLink(short.scope, short.sign, short.expires, ua))
  const huge = ent.secureLinkScoped(res, '/media/trial/9/', 999999)
  assert.equal(huge.ttl, ent.PLAY_TTL_MAX)
  assert.throws(() => ent.secureLinkScoped(res, 'media/trial/9/', 60), (error) => error.status === 400)
  // 老接口照旧从 URI 推 scope
  const legacy = ent.secureLink('/media/hls/5/index.m3u8', 60, ua)
  assert.equal(legacy.scope, '/media/hls/5/')
  assert.ok(ent.verifyLink('/media/hls/5/index.m3u8', legacy.sign, legacy.expires, ua))
})

test('期待榜只收已上架内容，草稿不会提前曝光', () => {
  const published = insertDrama({ year: 2026 })
  const draft = insertDrama({ year: 2026, status: 'draft' })
  const listInfo = run("INSERT INTO rank_lists (name, type, sort) VALUES ('期待榜测试', 'EXPECT', 0)")
  const listId = Number(listInfo.lastInsertRowid)
  rankModule.refreshRank(listId)
  const ids = all('SELECT drama_id FROM rank_items WHERE list_id = ?', listId).map((row) => Number(row.drama_id))
  assert.ok(ids.includes(published))
  assert.equal(ids.includes(draft), false)
})

test('天数参数非法时回落到默认值并夹在上下限内，报表不会 500', () => {
  assert.equal(analyticsModule.parseDays('abc'), 7)
  assert.equal(analyticsModule.parseDays('30'), 30)
  assert.equal(analyticsModule.parseDays(0), 7)
  assert.equal(analyticsModule.parseDays(9999), 365)
  assert.equal(analyticsModule.parseDays(-5, 3, 1, 30), 3)
  const report = analyticsModule.analyticsReport({ days: 'abc' })
  assert.equal(report.range.days, 7)
  assert.equal(analyticsModule.analyticsReport({ days: '30' }).range.days, 30)
})

test('营收按净额统计：部分退款只算剩余金额', () => {
  const userId = insertUser()
  const insertOrder = (status, amount, refunded = 0) => run(`INSERT INTO orders
    (out_trade_no, user_id, product_type, amount_cny, channel, status, refunded_amount, paid_at)
    VALUES (?, ?, 'single', ?, 'mock', ?, ?, datetime('now'))`,
  `T-${randomUUID()}`, userId, amount, status, refunded)
  insertOrder('paid', 100, 0)
  insertOrder('refunded', 100, 40)
  insertOrder('closed', 50, 0)
  const report = analyticsModule.analyticsReport({ days: 1 })
  assert.equal(report.money.revenue, 160)
  assert.equal(report.money.aov, 80)
  assert.equal(report.ordersByDay.reduce((sum, row) => sum + Number(row.revenue), 0), 160)
  assert.equal(report.byChannel[0].revenue, 160)
})

test('伪造的播放位置不计完播，正常推进到结尾才算完播', () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const userId = insertUser()
  const spoof = statsModule.startViewSession({ userId, contentId: dramaId, episodeId, duration: 600 })
  const spoofBeat = statsModule.applyHeartbeat({
    sessionId: spoof.id, userId, positionSeconds: 1e9, durationSeconds: 600, playing: true, visible: true, playbackRate: 1,
  })
  assert.equal(spoofBeat.completed, false)
  const spoofRow = one('SELECT completed, max_position_seconds AS pos FROM content_view_sessions WHERE id = ?', spoof.id)
  assert.equal(spoofRow.completed, 0)
  assert.ok(Number(spoofRow.pos) <= 600)
  const normal = statsModule.startViewSession({ userId, contentId: dramaId, episodeId, duration: 600 })
  const done = statsModule.applyHeartbeat({
    sessionId: normal.id, userId, positionSeconds: 590, durationSeconds: 600, playing: true, visible: true, playbackRate: 1,
  })
  assert.equal(done.completed, true)
})

test('内容分析默认按页取数，总数不受分页影响，平均时长按总时长算', () => {
  // 用独立 category 圈定样本，避免把前面用例造的剧算进合计
  const category = 'FIXDBTEST'
  for (let index = 0; index < 3; index += 1) {
    const dramaId = insertDrama({ category })
    run(`INSERT INTO content_view_sessions
      (id, viewer_key, content_id, content_type, source, duration_seconds, effective_seconds,
        max_position_seconds, status, is_valid, completed, started_at)
      VALUES (?, ?, ?, 'series', 'play', 100, ?, 100, 'ended', 1, 0, datetime('now'))`,
    randomUUID(), `v:${randomUUID()}`, dramaId, 30 + index * 30)
  }
  const paged = statsModule.contentAnalytics({ days: 7, category, limit: 1 })
  assert.equal(paged.page.limit, 1)
  assert.equal(paged.rows.length, 1)
  assert.equal(paged.total, 3)
  assert.equal(paged.page.hasMore, true)
  const clamped = statsModule.contentAnalytics({ days: 7, category, limit: 500 })
  assert.equal(clamped.page.limit, 200)
  assert.equal(clamped.rows.length, 3)
  assert.equal(clamped.totals.viewCount, 3)
  assert.equal(clamped.totals.watchSeconds, 180)
  assert.equal(clamped.totals.avgWatchSeconds, 60)
  // 再造一部长剧把「先按剧求均值再平均」的口径差异放大：正确口径 = 1080 / 4
  const longDrama = insertDrama({ category })
  run(`INSERT INTO content_view_sessions
    (id, viewer_key, content_id, content_type, source, duration_seconds, effective_seconds,
      max_position_seconds, status, is_valid, completed, started_at)
    VALUES (?, ?, ?, 'series', 'play', 900, 900, 900, 'ended', 1, 1, datetime('now'))`,
  randomUUID(), `v:${randomUUID()}`, longDrama)
  const again = statsModule.contentAnalytics({ days: 7, category })
  assert.equal(again.totals.viewCount, 4)
  assert.equal(again.totals.watchSeconds, 1080)
  assert.equal(again.totals.avgWatchSeconds, 270)
  assert.equal(again.page.limit, 50)
})

test('生成内容榜中途失败整段回滚，不留下只有 run 没有快照的半截榜单', () => {
  const dramaId = insertDrama()
  run(`INSERT INTO content_view_sessions
    (id, viewer_key, content_id, content_type, source, duration_seconds, effective_seconds,
      max_position_seconds, status, is_valid, completed, started_at)
    VALUES (?, ?, ?, 'series', 'play', 100, 100, 100, 'ended', 1, 0, datetime('now'))`,
  randomUUID(), `v:${randomUUID()}`, dramaId)
  const first = statsModule.buildContentRank({ rankType: 'hot', days: 7, limit: 5 })
  assert.ok(first.runId > 0)
  assert.equal(one('SELECT COUNT(*) AS n FROM content_rank_snapshots WHERE run_id = ?', first.runId).n, first.items.length)
  const runsBefore = one('SELECT COUNT(*) AS n FROM content_rank_runs').n
  run(`CREATE TRIGGER test_block_snapshots BEFORE INSERT ON content_rank_snapshots
    BEGIN SELECT RAISE(ABORT, 'snapshot blocked'); END`)
  try {
    assert.throws(() => statsModule.buildContentRank({ rankType: 'hot', days: 7, limit: 5 }), /snapshot blocked/)
  } finally {
    run('DROP TRIGGER IF EXISTS test_block_snapshots')
  }
  assert.equal(one('SELECT COUNT(*) AS n FROM content_rank_runs').n, runsBefore)
})

test('改轨道类型时旧类型组的默认标记一起清掉', () => {
  const dramaId = insertDrama()
  const episodeId = insertEpisode(dramaId)
  const subtitle = trackModule.createTrack({ episodeId, kind: 'subtitle', language: 'zh', label: '中文字幕', uri: '/media/sub/1.vtt', isDefault: true })
  const audio = trackModule.createTrack({ episodeId, kind: 'audio', language: 'zh', label: '国语', uri: '/media/audio/1.m3u8', isDefault: true })
  trackModule.updateTrack(audio.id, { kind: 'subtitle', language: 'en', label: '英文字幕', uri: '/media/sub/2.vtt', isDefault: true })
  assert.equal(Number(one('SELECT is_default AS d FROM episode_tracks WHERE id = ?', subtitle.id).d), 0)
  assert.equal(Number(one('SELECT is_default AS d FROM episode_tracks WHERE id = ?', audio.id).d), 1)
  const groups = all('SELECT kind, COUNT(*) AS n FROM episode_tracks WHERE episode_id = ? AND is_default = 1 GROUP BY kind', episodeId)
  assert.deepEqual(groups.map((row) => [row.kind, Number(row.n)]), [['subtitle', 1]])
})

test('标签分页参数非法时回落到第一页，不会把 NaN 拼进 SQL', () => {
  dbModule.ensureTag('分页测试标签甲')
  dbModule.ensureTag('分页测试标签乙')
  const broken = tagModule.listTags({ page: 'abc', pageSize: 'x' })
  assert.equal(broken.page, 1)
  assert.equal(broken.pageSize, 20)
  const second = tagModule.listTags({ page: '2', pageSize: '1' })
  assert.equal(second.page, 2)
  assert.equal(second.pageSize, 1)
  assert.equal(second.list.length, 1)
})

test('同一订单只允许一笔待处理退款，历史多笔时先体检跳过而不是抛死', () => {
  const userId = insertUser()
  const orderId = Number(run(`INSERT INTO orders (out_trade_no, user_id, product_type, amount_cny, status)
    VALUES (?, ?, 'single', 10, 'paid')`, `T-${randomUUID()}`, userId).lastInsertRowid)
  run("INSERT INTO refunds (order_id, amount, reason, status) VALUES (?, 10, '测试', 'pending')", orderId)
  assert.throws(() => run("INSERT INTO refunds (order_id, amount, reason, status) VALUES (?, 10, '重复', 'pending')", orderId), /UNIQUE/i)
  // 已拒绝的退款不占位：可以再提一笔
  run("UPDATE refunds SET status = 'rejected' WHERE order_id = ?", orderId)
  run("INSERT INTO refunds (order_id, amount, reason, status) VALUES (?, 10, '第二次', 'pending')", orderId)
  // 模拟老库：索引缺失 + 同一订单两笔 pending → 只体检告警，不建索引也不抛
  run('DROP INDEX IF EXISTS ux_refunds_order_pending')
  run("UPDATE refunds SET status = 'pending' WHERE order_id = ?", orderId)
  const healed = dbModule.ensureRefundPendingUnique()
  assert.equal(healed.skipped, true)
  assert.ok(healed.duplicates >= 1)
  assert.equal(one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_refunds_order_pending'"), undefined)
  // 人工清理后重建成功
  run('DELETE FROM refunds WHERE order_id = ? AND id NOT IN (SELECT MIN(id) FROM refunds WHERE order_id = ?)', orderId, orderId)
  assert.equal(dbModule.ensureRefundPendingUnique().skipped, false)
  assert.ok(one("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ux_refunds_order_pending'"))
})

test('每位用户每张券限用一次：重复核销被唯一索引拦住，老库重复只告警', () => {
  const userId = insertUser()
  const couponId = Number(run(`INSERT INTO coupons (code, name, discount_type, discount_value)
    VALUES (?, '测试券', 'amount', 5)`, `C-${randomUUID().slice(0, 8)}`).lastInsertRowid)
  run('INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES (?, ?, 1)', couponId, userId)
  assert.throws(() => run('INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES (?, ?, 2)', couponId, userId), /UNIQUE/i)
  run('DROP INDEX IF EXISTS ux_coupon_redemptions_user')
  run('INSERT INTO coupon_redemptions (coupon_id, user_id, order_id) VALUES (?, ?, 3)', couponId, userId)
  const healed = dbModule.ensureCouponRedemptionUnique()
  assert.equal(healed.skipped, true)
  assert.equal(healed.duplicates, 1)
})

test('试看链接的 scope 覆盖 /media/trial/<集>/，相邻集之间不能互相通用', () => {
  const ua = 'UA-trial-603'
  const res = { setHeader() {}, req: { headers: { 'user-agent': ua } } }
  const link = ent.secureLinkScoped(res, '/media/trial/603/', 120)
  assert.equal(link.scope, '/media/trial/603/')
  assert.ok(ent.verifyLink('/media/trial/603/index.m3u8', link.sign, link.expires, ua))
  assert.equal(ent.verifyLink('/media/trial/604/index.m3u8', link.sign, link.expires, ua), false)
})

test('成人策略不变量只补缺失策略，不覆盖显式配置', () => {
  const explicit = insertDrama({ isAdult: 1, category: 'PLAYLET' })
  run(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, 'free', 3, 0, 0, 'single', 0)`, explicit)
  const missing = insertDrama({ isAdult: 1, category: 'PLAYLET' })
  dbModule.ensureAdultPolicyInvariant()
  const kept = one('SELECT access_mode, free_episodes FROM content_policies WHERE drama_id = ?', explicit)
  assert.equal(kept.access_mode, 'free')
  assert.equal(Number(kept.free_episodes), 3)
  const filled = one('SELECT access_mode, free_episodes, trial_seconds FROM content_policies WHERE drama_id = ?', missing)
  assert.equal(filled.access_mode, 'subscription')
  assert.equal(Number(filled.free_episodes), 0)
  assert.equal(Number(filled.trial_seconds), 0)
})

test('同名标签写入复用已有行，成人标签种子不会因跨域重名中断', () => {
  const name = `重名标签-${randomUUID().slice(0, 8)}`
  const general = dbModule.ensureTag(name, { scope: 'general' })
  const again = dbModule.ensureTag(name, { scope: 'adult' })
  assert.equal(again.id, general.id)
  assert.equal(again.scope, 'general')
  // 成人种子：已存在同名 general 标签时复用而不是撞全局唯一约束
  const groupName = ADULT_TAG_GROUPS[0].name
  run("UPDATE tags SET scope = 'general' WHERE name = ?", groupName)
  run("DELETE FROM settings WHERE key = 'adult.tagSeedVersion'")
  assert.doesNotThrow(() => dbModule.ensureAdultTagSeed())
  assert.equal(one('SELECT scope FROM tags WHERE name = ?', groupName).scope, 'general')
})
