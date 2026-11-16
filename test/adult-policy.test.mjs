import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-adult-policy-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_LINK_SECRET = 'test-link-secret-0123456789'

let db
let dbModule
let entitlements

before(async () => {
  dbModule = await import('../server/db.mjs')
  db = dbModule.db
  entitlements = await import('../server/entitlements.mjs')
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('成人内容已有显式策略时不覆盖（导入脚本的 --mode 不会被重启纠回）', () => {
  const dramaId = Number(db.prepare("INSERT INTO dramas (title, category, is_adult, status) VALUES ('成人策略测试', 'MOVIE', 1, 'published')").run().lastInsertRowid)
  db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, 1, '第 1 集', 60, 'ready')").run(dramaId)
  db.prepare(`INSERT INTO content_policies
    (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, 'free', 3, 300, 12, 'rental', 72)`).run(dramaId)

  assert.equal(entitlements.resolveAccess(null, dramaId, 1).allow, true)

  dbModule.ensureAdultPolicyInvariant()

  // 显式配置属于运营/导入脚本的意图，缺口补齐只补「一条策略都没有」的内容
  const policy = db.prepare(`SELECT access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours
    FROM content_policies WHERE drama_id = ?`).get(dramaId)
  assert.deepEqual({ ...policy }, {
    access_mode: 'free', free_episodes: 3, trial_seconds: 300,
    single_price_cny: 12, purchase_kind: 'rental', rental_hours: 72,
  })

  const guest = entitlements.resolveAccess(null, dramaId, 1)
  assert.equal(guest.allow, true)
})

test('成人内容缺失策略时按默认口径补齐（会员专享、无免费集、无试看）', () => {
  const dramaId = Number(db.prepare("INSERT INTO dramas (title, category, is_adult, status) VALUES ('成人策略缺口测试', 'MOVIE', 1, 'published')").run().lastInsertRowid)
  db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, 1, '第 1 集', 60, 'ready')").run(dramaId)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_policies WHERE drama_id = ?').get(dramaId).n, 0)

  dbModule.ensureAdultPolicyInvariant()

  const policy = db.prepare(`SELECT access_mode, free_episodes, trial_seconds, single_price_cny
    FROM content_policies WHERE drama_id = ?`).get(dramaId)
  assert.deepEqual({ ...policy }, {
    access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0,
  })
  assert.equal(entitlements.resolveAccess(null, dramaId, 1).allow, false)
})

test('成人内容缺失策略时补齐，且按集付费规则被清空', () => {
  const dramaId = Number(db.prepare("INSERT INTO dramas (title, category, is_adult, status) VALUES ('成人策略补行测试', 'PLAYLET', 1, 'published')").run().lastInsertRowid)
  db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, 1, '第 1 集', 60, 'ready')").run(dramaId)
  db.prepare("INSERT INTO episode_price_rules (drama_id, from_no, mode, price_cny) VALUES (?, 1, 'single', 6)").run(dramaId)

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM content_policies WHERE drama_id = ?').get(dramaId).n, 0)

  assert.equal(dbModule.applyAdultPolicy(dramaId), true)

  const policy = db.prepare('SELECT access_mode, free_episodes, trial_seconds FROM content_policies WHERE drama_id = ?').get(dramaId)
  assert.deepEqual({ ...policy }, { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0 })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM episode_price_rules WHERE drama_id = ?').get(dramaId).n, 0)
})

test('非成人内容不受成人策略影响', () => {
  const dramaId = Number(db.prepare("INSERT INTO dramas (title, category, is_adult, status) VALUES ('普通内容', 'TV', 0, 'published')").run().lastInsertRowid)
  db.prepare(`INSERT INTO content_policies
    (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, 'subscription', 1, 0, 0, 'single', 72)`).run(dramaId)

  assert.equal(dbModule.applyAdultPolicy(dramaId), false)
  const policy = db.prepare('SELECT access_mode, free_episodes FROM content_policies WHERE drama_id = ?').get(dramaId)
  assert.deepEqual({ ...policy }, { access_mode: 'subscription', free_episodes: 1 })
})
