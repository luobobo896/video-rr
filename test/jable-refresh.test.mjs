import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-jr-'))
process.env.MH_DB = join(dir, 'test.db')

const { expiryOf, codeOf, pageUrlOf, leftMsOf, needsRefresh } = await import('../server/jable-refresh.mjs')
const { db } = await import('../server/db.mjs')

test.after(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const HLS = (exp) => `https://abc.mushroomtrack.com/hls/Y1oH4Dp1lgD3/` + exp + '/1/2/2.m3u8'

test('从直链里取出签名到期时间戳', () => {
  assert.equal(expiryOf(HLS('1794769762')), 1794769762)
  assert.equal(expiryOf('https://x/y/z.m3u8'), 0)
  assert.equal(expiryOf(null), 0)
})

test('从副标题里取番号，下划线也算', () => {
  assert.equal(codeOf('MIKR-134 · 白川美玲'), 'MIKR-134')
  assert.equal(codeOf('ABC_123 · 某某'), 'ABC_123')
  assert.equal(codeOf('没有番号的标题'), '')
  assert.equal(codeOf(null), '')
})

test('番号拼详情页地址时统一小写并把下划线换成连字符', () => {
  assert.equal(pageUrlOf('MIKR-134'), 'https://jable.tv/videos/mikr-134/')
  assert.equal(pageUrlOf('ABC_123'), 'https://jable.tv/videos/abc-123/')
})

test('剩余时间按到期时刻算，过期是负数', () => {
  const future = Math.floor(Date.now() / 1000) + 3600
  assert.ok(leftMsOf(HLS(String(future))) > 3500 * 1000)
  const past = Math.floor(Date.now() / 1000) - 60
  assert.ok(leftMsOf(HLS(String(past))) < 0)
  assert.equal(leftMsOf(''), -1)
})

test('只剩几分钟的 jable 直链需要续期', () => {
  const soon = Math.floor(Date.now() / 1000) + 300
  assert.equal(needsRefresh({ remote_url: HLS(String(soon)), remote_referer: 'https://jable.tv/' }), true)
})

test('还有三小时的直链不用动', () => {
  const later = Math.floor(Date.now() / 1000) + 3 * 3600
  assert.equal(needsRefresh({ remote_url: HLS(String(later)), remote_referer: 'https://jable.tv/' }), false)
})

test('短剧的 huangguo 引用不走这条路', () => {
  assert.equal(needsRefresh({ remote_url: 'huangguo://12166/1', remote_referer: 'https://jable.tv/' }), false)
})

test('不是 jable 的直链即使快过期也不管', () => {
  const soon = Math.floor(Date.now() / 1000) + 60
  assert.equal(needsRefresh({ remote_url: HLS(String(soon)), remote_referer: 'https://example.com/' }), false)
})
