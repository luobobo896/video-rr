import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-access-policy-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_LINK_SECRET = 'test-link-secret-0123456789'

let db
let dbModule
let entitlements
let userId

function createDrama({ title, category = 'PLAYLET', contentType = 'drama', episodes = 2 }) {
  const dramaId = Number(db.prepare(`INSERT INTO dramas (title, category, content_type, is_adult, status)
    VALUES (?, ?, ?, 0, 'published')`).run(title, category, contentType).lastInsertRowid)
  for (let no = 1; no <= episodes; no += 1) {
    db.prepare("INSERT INTO episodes (drama_id, no, title, duration, status) VALUES (?, ?, ?, 60, 'ready')")
      .run(dramaId, no, `第 ${no} 集`)
  }
  return dramaId
}

function setPolicy(dramaId, policy) {
  db.prepare(`INSERT INTO content_policies
    (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(drama_id) DO UPDATE SET access_mode = excluded.access_mode,
      free_episodes = excluded.free_episodes, trial_seconds = excluded.trial_seconds,
      single_price_cny = excluded.single_price_cny, purchase_kind = excluded.purchase_kind,
      rental_hours = excluded.rental_hours`).run(
    dramaId, policy.accessMode, policy.freeEpisodes ?? 0, policy.trialSeconds ?? 0,
    policy.singlePrice ?? 0, policy.purchaseKind ?? 'single', policy.rentalHours ?? 0)
}

before(async () => {
  dbModule = await import('../server/db.mjs')
  db = dbModule.db
  entitlements = await import('../server/entitlements.mjs')
  const planId = Number(db.prepare(`INSERT INTO plans (code, name, price_cny, duration_days, scope, status)
    VALUES ('test-month', '测试月卡', 25, 30, 'all', 'active')`).run().lastInsertRowid)
  userId = Number(db.prepare("INSERT INTO users (nickname, status) VALUES ('会员测试', 'active')").run().lastInsertRowid)
  db.prepare(`INSERT INTO subscriptions (user_id, plan_id, scope, valid_to, status)
    VALUES (?, ?, 'all', datetime('now', '+30 day'), 'active')`).run(userId, planId)
})

after(() => { try { db?.close() } catch { /* ignore */ } })

test('一次性收费内容不受会员管控，按集 VIP 规则也不能绕过', () => {
  const dramaId = createDrama({ title: '一次性剧集' })
  setPolicy(dramaId, { accessMode: 'paid', singlePrice: 9, purchaseKind: 'rental', rentalHours: 48 })
  db.prepare("INSERT INTO episode_price_rules (drama_id, from_no, mode) VALUES (?, 2, 'vip')").run(dramaId)

  const first = entitlements.resolveAccess(userId, dramaId, 1)
  assert.equal(first.allow, false)
  assert.equal(first.reason, 'single_purchase_required')
  assert.equal(first.price, 9)
  assert.equal(first.purchaseKind, 'rental')

  const vipRule = entitlements.resolveAccess(userId, dramaId, 2)
  assert.equal(vipRule.allow, false)
  assert.equal(vipRule.reason, 'single_purchase_required')
})

test('多集剧集首 N 集免费，会员也要为后续集数购买', () => {
  const dramaId = createDrama({ title: '首集免费剧集', episodes: 3 })
  setPolicy(dramaId, { accessMode: 'paid', freeEpisodes: 1, singlePrice: 6, purchaseKind: 'single' })

  assert.equal(entitlements.resolveAccess(null, dramaId, 1).source, 'free')
  const guestSecond = entitlements.resolveAccess(null, dramaId, 2)
  assert.equal(guestSecond.allow, false)
  assert.equal(guestSecond.reason, 'single_purchase_required')

  const memberSecond = entitlements.resolveAccess(userId, dramaId, 2)
  assert.equal(memberSecond.allow, false)
  assert.equal(memberSecond.reason, 'single_purchase_required')
})

test('电影没有首集免费：单集电影忽略 free_episodes', () => {
  const dramaId = createDrama({ title: '电影测试', category: 'MOVIE', contentType: 'movie', episodes: 1 })
  setPolicy(dramaId, { accessMode: 'paid', freeEpisodes: 3, singlePrice: 5, purchaseKind: 'single' })

  const guest = entitlements.resolveAccess(null, dramaId, 1)
  assert.equal(guest.allow, false)
  assert.equal(guest.reason, 'single_purchase_required')
})

test('会员免费内容不返回单片价格与售卖方式', () => {
  const dramaId = createDrama({ title: '会员免费剧集' })
  setPolicy(dramaId, {
    accessMode: 'subscription', freeEpisodes: 0, singlePrice: 12,
    purchaseKind: 'rental', rentalHours: 72,
  })

  const guest = entitlements.resolveAccess(null, dramaId, 1)
  assert.equal(guest.reason, 'subscription_required')
  assert.equal(guest.price, 0)
  assert.equal(guest.purchaseKind, null)

  const member = entitlements.resolveAccess(userId, dramaId, 1)
  assert.equal(member.allow, true)
  assert.equal(member.source, 'subscription')

  const info = entitlements.priceInfo({ id: dramaId })
  assert.equal(info.singlePrice, 0)
  assert.equal(info.purchaseKind, null)
  assert.equal(info.rentalHours, 0)
})

test('策略不变量清掉会员内容价格与电影首集免费', () => {
  const seriesId = createDrama({ title: '带遗留价格的会员剧集' })
  setPolicy(seriesId, {
    accessMode: 'subscription', singlePrice: 12, purchaseKind: 'rental', rentalHours: 72,
  })
  const movieId = createDrama({ title: '带遗留免费集的电影', category: 'MOVIE', contentType: 'movie', episodes: 1 })
  setPolicy(movieId, { accessMode: 'paid', freeEpisodes: 3, singlePrice: 5, purchaseKind: 'single' })

  dbModule.ensurePolicyInvariant()

  const series = db.prepare('SELECT * FROM content_policies WHERE drama_id = ?').get(seriesId)
  assert.equal(series.single_price_cny, 0)
  assert.equal(series.purchase_kind, 'single')
  assert.equal(series.rental_hours, 0)

  const movie = db.prepare('SELECT * FROM content_policies WHERE drama_id = ?').get(movieId)
  assert.equal(movie.free_episodes, 0)
  assert.equal(movie.single_price_cny, 5)
})
