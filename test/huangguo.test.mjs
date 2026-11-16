import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
import {
  HG_IMAGE_KEY,
  HG_IMAGE_IV,
  decryptHuangguoImage,
  hgRefOf,
  isHuangguoRef,
  isImageBuffer,
  parseHuangguoList,
  parseHuangguoPage,
  parseHuangguoRef,
} from '../server/huangguo.mjs'
import { remoteSourceOf } from '../server/stream-proxy.mjs'

const PAGE_HTML = `<!doctype html><html><head><title>微信性爱系统</title></head><body>
<script id="videoInitialData" type="application/json">{"id":12166,"title":"微信性爱系统","description":"张漠利用系统潜入调查。","coverSrc":"https://pic.drleao.cn/x.jpg","posterSrc":"https://new2.drleao.cn/y.jpg","tags":["都市","系统"],"tagLinks":[{"name":"都市","url":"/tag/dushi/"}],"author":"陈霖","views":"1.2万","cdnApp":"150","cdnAuthKey":"k","cdnAuthValue":"v","tracking":{"drama_type_id":"3","drama_type_name":"AI短剧","total_episode":3},"trackingEpisodes":{"1":{"drama_duration":670,"video_id":12166},"2":{"drama_duration":536,"video_id":12166},"3":{"drama_duration":442,"video_id":12166}}}</script>
</body></html>`

test('短剧引用：huangguo:// 可往返解析', () => {
  const ref = hgRefOf(12166, 2)
  assert.equal(ref, 'huangguo://12166/2')
  assert.equal(isHuangguoRef(ref), true)
  assert.deepEqual(parseHuangguoRef(ref), { videoId: 12166, ep: 2 })
})

test('短剧引用：非短剧地址不被误判', () => {
  assert.equal(isHuangguoRef('https://jable.tv/videos/x/'), false)
  assert.equal(isHuangguoRef(''), false)
  assert.equal(parseHuangguoRef('huangguo://abc/1'), null)
})

test('详情页解析：集数、时长、封面与标签齐全', () => {
  const meta = parseHuangguoPage(PAGE_HTML, 'https://huangguoai.com/video/12166/')
  assert.equal(meta.videoId, 12166)
  assert.equal(meta.title, '微信性爱系统')
  assert.equal(meta.totalEpisodes, 3)
  assert.deepEqual(meta.episodeNos, [1, 2, 3])
  assert.equal(meta.episodeDurations[1], 670)
  assert.equal(meta.episodeDurations[3], 442)
  assert.equal(meta.cover, 'https://pic.drleao.cn/x.jpg')
  assert.deepEqual(meta.tags, ['都市', '系统'])
  assert.equal(meta.author, '陈霖')
  assert.equal(meta.cdnAuthValue, 'v')
})

test('详情页解析：缺少 videoInitialData 时返回 null', () => {
  assert.equal(parseHuangguoPage('<html><body>没有数据</body></html>'), null)
  assert.equal(parseHuangguoPage('<script id="videoInitialData">{bad json}</script>'), null)
})

test('列表页解析：链接去重且保持页面顺序', () => {
  const html = `
    <a href="/video/12166/">a</a>
    <a href="/video/13692/">b</a>
    <a href="/video/12166/">a2</a>
    <a href="/video/9001/?from=list">c</a>`
  assert.deepEqual(parseHuangguoList(html), [12166, 13692])
})

test('图片解密：AES-128-CBC 密文解出原始字节', () => {
  const plain = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(HG_IMAGE_KEY, 'utf8'), Buffer.from(HG_IMAGE_IV, 'utf8'))
  cipher.setAutoPadding(false)
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  const out = decryptHuangguoImage(encrypted)
  assert.deepEqual(out.subarray(0, plain.length), plain)
})

test('图片解密：已是明文或长度不对齐时原样返回', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])
  assert.equal(decryptHuangguoImage(jpeg), jpeg)
  const odd = Buffer.alloc(15, 7)
  assert.equal(decryptHuangguoImage(odd), odd)
})

test('图片识别：JPEG/PNG 判定为图片，密文判定为非图片', () => {
  assert.equal(isImageBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true)
  assert.equal(isImageBuffer(Buffer.from([0x89, 0x50, 0x4e, 0x47])), true)
  assert.equal(isImageBuffer(Buffer.from([0x09, 0x3d, 0xe3, 0xb1])), false)
})

test('片源解析：huangguo 引用带出 provider 与分集号', () => {
  const source = remoteSourceOf({ id: 1, remote_url: hgRefOf(12166, 3), remote_referer: 'https://huangguoai.com/' })
  assert.equal(source.provider, 'huangguo')
  assert.equal(source.videoId, 12166)
  assert.equal(source.ep, 3)
})

test('片源解析：普通 m3u8 地址不带 provider', () => {
  const source = remoteSourceOf({ id: 2, remote_url: 'https://cdn.example.com/a/index.m3u8' })
  assert.equal(source.provider, undefined)
  assert.equal(source.pageUrl, 'https://cdn.example.com/a/index.m3u8')
})
