import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-event-stats-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'

const { db } = await import('../server/db.mjs')
const { eventStats, eventStatsWindow, normalizeRange } = await import('../server/event-stats.mjs')

/** 北京时间 2026-11-17 16:50（UTC 08:50），离所有日历边界都远。 */
const NOW = Date.parse('2026-11-17T08:50:00Z')

function seedEvent(createdAt, {
  type = 'page_view', eventType = 1, eventOp = 1, visitorId = 'v1', userId = null, ip = null,
  path = '/', stayMs = null, code = null, device = null, os = null, action = null,
} = {}) {
  db.prepare(`INSERT INTO track_events
    (type, event_type, event_op, visitor_id, user_id, ip, path, event_code, stay_ms, device, os, action, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type, eventType, eventOp, visitorId, userId, ip, path, code, stayMs, device, os, action, createdAt)
}

db.exec('DELETE FROM track_events')
// 今天（北京 11-17）：00:10 跨 UTC 日界、09:00 点击、16:00 播放、16:20 离开
seedEvent('2026-11-16 16:10:00', { visitorId: 'v1', path: '/', stayMs: 4000, device: 'iPhone · Safari 17', os: 'iOS 17.2', action: '进入首页' })
seedEvent('2026-11-17 01:00:00', { visitorId: 'v1', path: '/detail/25', eventType: 2, type: 'click', action: '点击播放', code: 'click:play' })
seedEvent('2026-11-17 08:00:00', { visitorId: '', userId: 7, ip: '1.2.3.4', path: '/rank', eventType: 2, type: 'play_start', action: '开始播放' })
seedEvent('2026-11-17 08:20:00', { visitorId: '', ip: '5.6.7.8', path: '/vip', eventOp: 2, stayMs: 12000 })
// 昨天（北京 11-16）：10:00 进入、23:50 离开
seedEvent('2026-11-16 02:00:00', { visitorId: 'v2', path: '/search' })
seedEvent('2026-11-16 15:50:00', { visitorId: 'v2', path: '/vip', eventOp: 2, stayMs: 9000 })
// 前天（11-15）、8 天前（11-09）、20 天前（10-28）、31 天前（10-17）
seedEvent('2026-11-15 03:00:00', { visitorId: 'v3', path: '/help' })
seedEvent('2026-11-09 03:00:00', { visitorId: 'v4', path: '/category' })
seedEvent('2026-10-28 03:00:00', { visitorId: 'v5', path: '/category' })
seedEvent('2026-10-17 03:00:00', { visitorId: 'v6', path: '/old' })

test('区间边界按北京时间切日：今天从北京 0 点起算，跨 UTC 日界也算今天', () => {
  const today = eventStatsWindow('today', NOW)
  assert.equal(today.from, '2026-11-16 16:00:00')
  assert.equal(today.to, null)
  assert.equal(today.bucket, 'hour')

  const yesterday = eventStatsWindow('yesterday', NOW)
  assert.equal(yesterday.from, '2026-11-15 16:00:00')
  assert.equal(yesterday.to, '2026-11-16 16:00:00')

  assert.equal(eventStatsWindow('7d', NOW).from, '2026-11-10 16:00:00')
  assert.equal(eventStatsWindow('30d', NOW).from, '2026-10-18 16:00:00')
})

test('脏 range 回退到近 7 天，不抛错', () => {
  assert.equal(normalizeRange('abc'), '7d')
  assert.equal(normalizeRange(undefined), '7d')
  assert.equal(normalizeRange('today'), 'today')
  assert.equal(eventStatsWindow('nope', NOW).range, '7d')
})

test('今天/昨天/近 7 天/近 30 天分别只统计区间内的事件', () => {
  assert.equal(eventStats('today', NOW).totals.events, 4)
  assert.equal(eventStats('yesterday', NOW).totals.events, 2)
  assert.equal(eventStats('7d', NOW).totals.events, 7)
  assert.equal(eventStats('30d', NOW).totals.events, 9)
})

test('独立访客按 user_id → visitor_id → IP 去重：登录用户按账号算一个人，不再按设备/IP 拆开', () => {
  const today = eventStats('today', NOW).totals
  // v1（两条）、u:7（登录账号优先于匿名身份）、5.6.7.8（匿名兜底 IP）
  assert.equal(today.visitors, 3)
  assert.equal(today.users, 1)
  assert.equal(today.anonymous, 2)
  assert.equal(today.loggedEvents, 1)
  assert.equal(today.anonymousEvents, 3)
  assert.equal(today.eventsPerVisitor, 1.3)
})

test('趋势桶：今天按小时补到当前小时，昨天整天，7/30 天按天且空桶为 0', () => {
  const today = eventStats('today', NOW).trend
  assert.equal(today.length, 17)
  assert.equal(today[0].day, '2026-11-17 00:00')
  assert.equal(today[0].events, 1)
  assert.equal(today[9].events, 1)
  assert.equal(today[16].events, 2)

  const yesterday = eventStats('yesterday', NOW).trend
  assert.equal(yesterday.length, 24)
  assert.equal(yesterday[10].events, 1)
  assert.equal(yesterday[23].events, 1)

  const week = eventStats('7d', NOW).trend
  assert.equal(week.length, 7)
  assert.equal(week[0].day, '2026-11-11')
  assert.equal(week.reduce((sum, row) => sum + row.events, 0), 7)

  assert.equal(eventStats('30d', NOW).trend.length, 30)
})

test('概览指标覆盖页面进出、点击、播放、搜索与平均停留', () => {
  const totals = eventStats('today', NOW).totals
  assert.equal(totals.pageViews, 1)
  assert.equal(totals.pageExits, 1)
  assert.equal(totals.clicks, 2)
  assert.equal(totals.plays, 1)
  assert.equal(totals.searches, 0)
  assert.equal(totals.avgStayMs, 8000)

  const yesterday = eventStats('yesterday', NOW).totals
  assert.equal(yesterday.pageExits, 1)
  assert.equal(yesterday.avgStayMs, 9000)
})

test('环比取上一个等长区间：今天 16:50 对昨天同一时刻', () => {
  const stats = eventStats('today', NOW)
  // 昨天 00:00–16:50 只有 10:00 那条，23:50 那条在区间外
  assert.equal(stats.prevTotals.events, 1)
  assert.equal(eventStats('7d', NOW).prevTotals.events, 1)
})

test('排行榜与分布来自窗口内事件，不混入区间外数据', () => {
  const week = eventStats('7d', NOW)
  assert.equal(week.topPages[0].path, '/vip')
  assert.equal(week.topPages[0].n, 2)
  assert.equal(week.byType.find((row) => row.type === 'page_view').n, 5)
  assert.equal(week.topEvents.some((row) => row.code === 'click:play'), true)
  assert.equal(week.topActions.some((row) => row.action === '进入首页'), true)
  assert.equal(week.devices.some((row) => row.label === 'iPhone · Safari 17'), true)
  assert.equal(week.systems.some((row) => row.label === 'iOS 17.2'), true)
  assert.equal(week.topDramas.length, 0)

  const month = eventStats('30d', NOW)
  assert.equal(month.topPages.some((row) => row.path === '/old'), false)
})
