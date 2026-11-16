import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-track-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'

const { db } = await import('../server/db.mjs')
const { parseUa, eventTypeOf, eventOpOf, recordEvent } = await import('../server/analytics.mjs')

const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1'
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
const UA_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0'

const lastEvent = () => db.prepare('SELECT * FROM track_events ORDER BY id DESC LIMIT 1').get()

test('parseUa 从 iPhone UA 认出 iOS 与 Safari', () => {
  const { device, os } = parseUa(UA_IPHONE)
  assert.equal(os, 'iOS 17.2')
  assert.match(device, /iPhone/)
  assert.match(device, /Safari 17/)
})

test('parseUa 从 Android UA 认出机型与 Chrome', () => {
  const { device, os } = parseUa(UA_ANDROID)
  assert.equal(os, 'Android 13')
  assert.equal(device, 'SM-G991B · Chrome 131')
})

test('parseUa 从 Windows UA 认出桌面与 Edge', () => {
  const { device, os } = parseUa(UA_WINDOWS)
  assert.equal(os, 'Windows 10/11')
  assert.equal(device, 'Desktop · Edge 131')
})

test('parseUa 对空 UA 返回空串，不抛错', () => {
  assert.deepEqual(parseUa(''), { device: '', os: '' })
  assert.deepEqual(parseUa(undefined), { device: '', os: '' })
})

test('事件类型与操作的推导符合 0/1/2 约定', () => {
  assert.equal(eventTypeOf('page_view'), 1)
  assert.equal(eventTypeOf('detail_view'), 1)
  assert.equal(eventTypeOf('click'), 2)
  assert.equal(eventTypeOf('episode_click'), 2)
  assert.equal(eventTypeOf('order_created'), 0)
  assert.equal(eventOpOf('page_view'), 1)
  assert.equal(eventOpOf('play_end'), 2)
  assert.equal(eventOpOf('trial_end'), 2)
  assert.equal(eventOpOf('order_created'), 0)
})

test('recordEvent 补齐账号、设备、系统、页面地址、停留与事件 code', () => {
  const userId = Number(
    db.prepare("INSERT INTO users (email, nickname, status) VALUES ('fan@example.com', '影迷', 'active')").run()
      .lastInsertRowid,
  )
  const ok = recordEvent({
    type: 'page_view',
    userId,
    path: '/adult',
    pageUrl: 'https://example.com/video/#/adult?page=2',
    eventCode: 'page:/adult',
    action: '进入成人频道',
    description: '停留 12.3 秒',
    stayMs: 12300,
    ip: '203.0.113.9',
    ua: UA_ANDROID,
  })
  assert.equal(ok, true)
  const row = lastEvent()
  assert.equal(row.type, 'page_view')
  assert.equal(row.user_id, userId)
  assert.equal(row.account, 'fan@example.com')
  assert.equal(row.device, 'SM-G991B · Chrome 131')
  assert.equal(row.os, 'Android 13')
  assert.equal(row.page_url, 'https://example.com/video/#/adult?page=2')
  assert.equal(row.event_code, 'page:/adult')
  assert.equal(row.event_type, 1)
  assert.equal(row.event_op, 1)
  assert.equal(row.action, '进入成人频道')
  assert.equal(row.description, '停留 12.3 秒')
  assert.equal(row.stay_ms, 12300)
  assert.equal(row.ip, '203.0.113.9')
})

test('recordEvent 的 eventType/eventOp 显式值优先于推导', () => {
  recordEvent({ type: 'click', eventType: 0, eventOp: 2, eventCode: 'btn:x', action: '点了按钮' })
  const row = lastEvent()
  assert.equal(row.event_type, 0)
  assert.equal(row.event_op, 2)
  assert.equal(row.event_code, 'btn:x')
})

test('游客点击也落库：账号为空、event_code 缺省等于事件名', () => {
  recordEvent({ type: 'click', action: '点击封面', ua: UA_IPHONE })
  const row = lastEvent()
  assert.equal(row.account, '')
  assert.equal(row.user_id, null)
  assert.equal(row.event_code, 'click')
  assert.equal(row.event_type, 2)
  assert.equal(row.stay_ms, null)
})

test('未知事件名不写入', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM track_events').get().n
  assert.equal(recordEvent({ type: 'not_a_real_event' }), false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM track_events').get().n, before)
})
