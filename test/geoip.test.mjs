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

test('默认通道走 ipwho.is：HTTPS、免 key、单 IP GET，中文地区落库后只读缓存命中', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' })
    return { ok: true, status: 200, json: async () => ({ ip: '8.8.8.8', success: true, country: '美国', region: '加利福尼亚州', city: '圣荷西' }) }
  }
  process.env.MH_GEOIP = '1'
  delete process.env.MH_GEOIP_URL
  try {
    geoip.clearGeoCache()
    const regions = await geoip.resolveRegions(['8.8.8.8'])
    assert.equal(regions.get('8.8.8.8'), '美国 · 加利福尼亚州 · 圣荷西')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
    assert.match(calls[0].url, /^https:\/\/ipwho\.is\/8\.8\.8\.8\?lang=zh-CN$/)
    assert.equal(geoip.cachedRegions(['8.8.8.8']).get('8.8.8.8'), '美国 · 加利福尼亚州 · 圣荷西')
    assert.equal(calls.length, 1)
  } finally {
    globalThis.fetch = original
    delete process.env.MH_GEOIP
  }
})

test('ipwho.is 返回 success:false 时留空，不写库', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ip: '1.2.3.99', success: false, message: 'reserved range' }) })
  process.env.MH_GEOIP = '1'
  try {
    geoip.clearGeoCache()
    assert.equal((await geoip.resolveRegions(['1.2.3.99'])).get('1.2.3.99'), '')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ip_geo WHERE ip = ?').get('1.2.3.99').n, 0)
  } finally {
    globalThis.fetch = original
    delete process.env.MH_GEOIP
  }
})

test('自定义 MH_GEOIP_URL 仍走 POST 批量端点（ip-api 版式）', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, body: init.body })
    return { ok: true, status: 200, json: async () => ([{ status: 'success', query: '9.9.9.9', country: '澳大利亚', regionName: '新南威尔士', city: '悉尼' }]) }
  }
  process.env.MH_GEOIP = '1'
  process.env.MH_GEOIP_URL = 'https://geo.example.test/batch'
  try {
    geoip.clearGeoCache()
    db.prepare('DELETE FROM ip_geo WHERE ip = ?').run('9.9.9.9')
    assert.equal((await geoip.resolveRegions(['9.9.9.9'])).get('9.9.9.9'), '澳大利亚 · 新南威尔士 · 悉尼')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body, '["9.9.9.9"]')
  } finally {
    globalThis.fetch = original
    delete process.env.MH_GEOIP
    delete process.env.MH_GEOIP_URL
  }
})

test('cachedRegions 只读缓存：内网直标「内网」，未缓存的公网 IP 返回空串且不发请求', () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    throw new Error('cachedRegions 不该发请求')
  }
  try {
    geoip.clearGeoCache()
    const regions = geoip.cachedRegions(['10.0.0.9', '203.0.113.77'])
    assert.equal(regions.get('10.0.0.9'), '内网')
    assert.equal(regions.get('203.0.113.77'), '')
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = original
  }
})

test('归属地归一：繁体转简体，中英混写的同一行只留一种语言', () => {
  assert.equal(geoip.canonicalRegionLabel('中国 · 广西壮族自治区 · 南寧'), '中国 · 广西壮族自治区 · 南宁')
  assert.equal(geoip.canonicalRegionLabel('日本 · Tokyo · 东京'), '日本 · 东京')
  assert.equal(geoip.canonicalRegionLabel('美国 · 俄勒冈州 · Boardman'), '美国 · 俄勒冈州')
  assert.equal(geoip.canonicalRegionLabel('法国 · 法蘭西島大區 · 巴黎'), '法国 · 法兰西岛大区 · 巴黎')
  assert.equal(geoip.canonicalRegionLabel('内网'), '内网')
  assert.equal(geoip.canonicalRegionLabel(''), '')
})

test('地区合并键按「国家 · 城市」归组，省名口径不同也能并到一起', () => {
  assert.equal(geoip.regionMergeKey('法国 · 法兰西岛 · 巴黎'), geoip.regionMergeKey('法国 · 法兰西岛大区 · 巴黎'))
  assert.equal(geoip.regionMergeKey('日本 · 东京都 · 东京'), '日本 · 东京')
  assert.equal(geoip.regionMergeKey('香港 · Kowloon'), '香港 · Kowloon')
  assert.equal(geoip.regionMergeKey('内网'), '内网')
})

test('归属地清洗：括号补充、逗号缀省、市名重复省名都收掉', () => {
  assert.equal(
    geoip.canonicalRegionLabel('美国 · 爱荷华州 · 凱恩鎮区 (愛荷华州波特瓦特米县)'),
    '美国 · 爱荷华州 · 凯恩镇区'
  )
  assert.equal(
    geoip.canonicalRegionLabel('美国 · 新泽西州 · 西考克斯市，新泽西州'),
    '美国 · 新泽西州 · 西考克斯市'
  )
  assert.equal(geoip.canonicalRegionLabel('美国 · 哥伦比亚特区 · 华盛顿哥倫比亚特区'), '美国 · 哥伦比亚特区')
  assert.equal(geoip.canonicalRegionLabel('台湾 · 臺北市 · 臺北'), '台湾 · 台北市')
})

test('合并键忽略行政区后缀，东京与东京都并成一行', () => {
  assert.equal(geoip.regionMergeKey('日本 · 东京'), geoip.regionMergeKey('日本 · 东京都'))
  assert.equal(geoip.regionMergeKey('台湾 · 台北市'), geoip.regionMergeKey('台湾 · 台北'))
})
