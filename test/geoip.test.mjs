import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-geoip-'))
process.env.MH_DB = join(dir, 'test.db')

let geoip
let db

before(async () => {
  geoip = await import('../server/geoip.mjs')
  ;({ db } = await import('../server/db.mjs'))
})

after(() => {
  try { db?.close() } catch { /* ignore */ }
  rmSync(dir, { recursive: true, force: true })
})

test('内网与保留地址不查外部接口', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.9', '172.16.5.5', '172.31.255.1', '169.254.1.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '']) {
    assert.equal(geoip.isPrivateIp(ip), true, ip)
  }
})

test('公网 IPv4 与 IPv6 判为外部地址', () => {
  for (const ip of ['141.147.83.73', '8.8.8.8', '111.92.242.53', '2001:4860:4860::8888']) {
    assert.equal(geoip.isPrivateIp(ip), false, ip)
  }
})

test('172.15 与 172.32 不属于私网段', () => {
  assert.equal(geoip.isPrivateIp('172.15.0.1'), false)
  assert.equal(geoip.isPrivateIp('172.32.0.1'), false)
})

test('地区串按 国家 · 省 · 市 拼接，重复段只留一次', () => {
  assert.equal(geoip.regionLabel({ country: '中国', region: '广东', city: '深圳' }), '中国 · 广东 · 深圳')
  assert.equal(geoip.regionLabel({ country: '香港', region: '香港', city: '' }), '香港')
  assert.equal(geoip.regionLabel({ country: '英国', region: '英格兰', city: '伦敦' }), '英国 · 英格兰 · 伦敦')
  assert.equal(geoip.regionLabel({ country: '', region: '', city: '' }), '')
  assert.equal(geoip.regionLabel({}), '')
  assert.equal(geoip.regionLabel(), '')
})

test('内网 IP 解析结果为「内网」，且不发网络请求', async () => {
  const regions = await geoip.resolveRegions(['127.0.0.1', '192.168.0.2', '127.0.0.1', ''])
  assert.equal(regions.get('127.0.0.1'), '内网')
  assert.equal(regions.get('192.168.0.2'), '内网')
  assert.equal(regions.size, 2)
})

test('空列表直接返回空 Map', async () => {
  const regions = await geoip.resolveRegions([])
  assert.equal(regions.size, 0)
  assert.equal((await geoip.resolveRegions(null)).size, 0)
})

test('MH_GEOIP=off 时不占用外部接口，公网 IP 返回空串', async () => {
  process.env.MH_GEOIP = 'off'
  try {
    geoip.clearGeoCache()
    const regions = await geoip.resolveRegions(['8.8.8.8'])
    assert.equal(regions.get('8.8.8.8'), '')
  } finally {
    delete process.env.MH_GEOIP
  }
})
