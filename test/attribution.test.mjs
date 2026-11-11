import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-attribution-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_ADMIN_INIT_PASSWORD = 'admin123'
process.env.MH_LINK_SECRET = 'test-link-secret'
process.env.MH_SECRET = 'test-secret'
process.env.MH_ALLOW_SIM_PAY = '1'

let db, attr, commerce

before(async () => {
  const dbModule = await import('../server/db.mjs')
  db = dbModule.db
  dbModule.seedIfEmpty()
  dbModule.migratePayChannels()
  db.prepare("UPDATE pay_channels SET status='enabled', is_default=1 WHERE channel_code='mock'").run()
  attr = await import('../server/attribution.mjs')
  commerce = await import('../server/commerce.mjs')
})

after(() => { try { db.close() } catch { /* ignore */ } })

const newUser = () => Number(db.prepare("INSERT INTO users (email,nickname) VALUES (?, 'attr')")
  .run(`attr-${Date.now()}-${Math.random()}@example.com`).lastInsertRowid)

test('推广码优先于域名，首次归因不会被直接访问覆盖', () => {
  const channel = attr.upsertChannel({ channelCode: 'attr_ad', channelName: '归因广告', channelType: 'paid_ad' })
  const other = attr.upsertChannel({ channelCode: 'attr_kol', channelName: '达人', channelType: 'kol' })
  attr.upsertChannelDomain({ channelId: channel.id, host: 'attr.example.com', pathPrefix: '/' })
  attr.upsertPromoCode({ code: 'ATTR10', channelId: other.id, purpose: 'acquisition' })

  const visitor = `attr-visitor-${Date.now()}`
  const domainTouch = attr.recordTouch({ visitorId: visitor, host: 'attr.example.com', pathname: '/' })
  assert.equal(domainTouch.channelId, channel.id)
  assert.equal(domainTouch.matchRule, 'domain')

  const promoVisitor = `attr-promo-${Date.now()}`
  const promoTouch = attr.recordTouch({ visitorId: promoVisitor, promoCode: 'ATTR10', host: 'attr.example.com', pathname: '/' })
  assert.equal(promoTouch.channelId, other.id)
  assert.equal(promoTouch.promoCode, 'ATTR10')
  assert.equal(promoTouch.matchRule, 'promo_code')

  const direct = attr.recordTouch({ visitorId: visitor, host: 'other.example.com', pathname: '/' })
  assert.equal(direct.matchRule, 'direct')
  const visitorRow = db.prepare('SELECT first_channel_id FROM visitors WHERE id = ?').get(visitor)
  assert.equal(visitorRow.first_channel_id, channel.id)
})

test('用户注册绑定首次归因，订单写入完整快照', () => {
  const channel = attr.upsertChannel({ channelCode: 'order_ad', channelName: '订单广告', channelType: 'paid_ad' })
  attr.upsertChannelDomain({ channelId: channel.id, host: 'order.example.com', pathPrefix: '/landing' })
  const visitor = `order-visitor-${Date.now()}`
  attr.recordTouch({ visitorId: visitor, host: 'order.example.com', pathname: '/landing/a' })
  const userId = newUser()
  const bound = attr.bindUserAcquisition({ userId, visitorId: visitor })
  assert.equal(bound.first_channel_id, channel.id)

  const created = commerce.createOrder({ userId, visitorId: visitor, productType: 'subscription', planId: 1, channel: 'mock' })
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(created.order.id)
  assert.equal(order.acquisition_channel_id, channel.id)
  assert.equal(order.acquisition_channel_type, 'paid_ad')
  assert.ok(order.first_enter_at)
  assert.ok(order.attributed_at)
  assert.equal(order.attribution_model, 'first_touch')
})

test('渠道分析按订单归因快照聚合支付金额', () => {
  const report = attr.analyticsChannelRows({ days: 7 })
  assert.ok(report.rows.length >= 2)
  assert.ok(report.rows.some((row) => row.channelType === 'paid_ad'))
  assert.ok(report.totals.createdOrders >= 1)
})

test('末次归因切换只影响新订单快照', () => {
  const first = attr.upsertChannel({ channelCode: 'last_a', channelName: '首次渠道', channelType: 'paid_ad' })
  const last = attr.upsertChannel({ channelCode: 'last_b', channelName: '末次渠道', channelType: 'kol' })
  attr.upsertChannelDomain({ channelId: first.id, host: 'last-a.example.com', pathPrefix: '/' })
  attr.upsertChannelDomain({ channelId: last.id, host: 'last-b.example.com', pathPrefix: '/' })
  const visitor = `last-visitor-${Date.now()}`
  attr.recordTouch({ visitorId: visitor, host: 'last-a.example.com', pathname: '/' })
  const userId = newUser()
  attr.bindUserAcquisition({ userId, visitorId: visitor })
  attr.recordTouch({ visitorId: visitor, userId, host: 'last-b.example.com', pathname: '/' })
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('attribution', ?)")
    .run(JSON.stringify({ model: 'last_touch', windowDays: 30 }))
  try {
    const snapshot = attr.getOrderAttribution({ userId, visitorId: visitor })
    assert.equal(snapshot.channelId, last.id)
    assert.equal(snapshot.attributionModel, 'last_touch')
  } finally {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('attribution', ?)")
      .run(JSON.stringify({ model: 'first_touch', windowDays: 30 }))
  }
})

test('超过归因窗口的触达不绑定为账号渠道', () => {
  const channel = attr.upsertChannel({ channelCode: 'expired_ad', channelName: '过期广告', channelType: 'paid_ad' })
  attr.upsertChannelDomain({ channelId: channel.id, host: 'expired.example.com', pathPrefix: '/' })
  const visitor = `expired-visitor-${Date.now()}`
  attr.recordTouch({ visitorId: visitor, host: 'expired.example.com', pathname: '/' })
  db.prepare("UPDATE visitors SET first_enter_at = datetime('now','-31 days') WHERE id = ?").run(visitor)
  const userId = newUser()
  const bound = attr.bindUserAcquisition({ userId, visitorId: visitor })
  const direct = db.prepare("SELECT id FROM channels WHERE channel_code = 'direct'").get()
  assert.equal(bound.first_channel_id, direct.id)
})
