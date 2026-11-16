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

test('成人内容免费策略会被纠正为会员专享、无免费集、无试看', () => {
  const dramaId = Number(db.prepare("INSERT INTO dramas (title, category, is_adult, status) VALUES ('成人策略测试', 'MOVIE', 1, 'published')").run().lastInsertRowid)
  db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, 1, '第 1 集', 60, 'ready')").run(dramaId)
  db.prepare(`INSERT INTO content_policies
    (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, 'free', 3, 300, 12, 'rental', 72)`).run(dramaId)

  assert.equal(entitlements.resolveAccess(null, dramaId, 1).allow, true)

  dbModule.ensureAdultPolicyInvariant()

  const policy = db.prepare(`SELECT access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours
    FROM content_policies WHERE drama_id = ?`).get(dramaId)
  assert.deepEqual({ ...policy }, {
    access_mode: 'subscription', free_episodes: 0, trial_seconds: 0,
    single_price_cny: 0, purchase_kind: 'single', rental_hours: 0,
  })

  const guest = entitlements.resolveAccess(null, dramaId, 1)
  assert.equal(guest.allow, false)
  assert.equal(guest.reason, 'subscription_required')
  assert.equal(guest.trialSeconds, 0)
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
