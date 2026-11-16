/**
 * 试看签名与清单改写的回归：
 * 1) 秒数进 scope，改 query 里的 sec 必须让签名失效（否则客户端能把 15 秒改成 3600 秒）；
 * 2) 分片/子清单 URI 必须带上票（播放器会丢掉页面 query，只靠 Cookie 在换码率时会漏）；
 * 3) 截断只保留窗口内的分片，EXT-X-KEY / EXT-X-MAP 这类标签要跟着保留。
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'mh-trial-'))
process.env.MH_DB = join(dir, 'test.db')
process.env.MH_SECRET = 'test-secret'
process.env.MH_LINK_SECRET = 'link-secret'
process.env.MH_LINK_TTL = '300'

let entitlements, trial
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'

before(async () => {
  entitlements = await import('../server/entitlements.mjs')
  trial = await import('../server/trial-playlist.mjs')
})

after(() => {
  delete process.env.MH_DB
})

test('试看 scope 含秒数：同一张票换 sec 校验不通过', () => {
  const link = entitlements.secureLinkScoped(null, '/media/trial/603/45/', 50, UA)
  assert.equal(entitlements.verifyLink('/media/trial/603/45/', link.sign, link.expires, UA), true)
  assert.equal(entitlements.verifyLink('/media/trial/603/3600/', link.sign, link.expires, UA), false)
  assert.equal(entitlements.verifyLink('/media/trial/603/', link.sign, link.expires, UA), false)
  // 别的集也不行
  assert.equal(entitlements.verifyLink('/media/trial/604/45/', link.sign, link.expires, UA), false)
  // UA 绑定仍然生效
  assert.equal(entitlements.verifyLink('/media/trial/603/45/', link.sign, link.expires, 'curl/8.4.0'), false)
})

test('linkScope 对试看秒数形态保持原样，对普通路径仍收窄到集目录', () => {
  assert.equal(entitlements.linkScope('/media/trial/603/45/'), '/media/trial/603/45/')
  assert.equal(entitlements.linkScope('/media/trial/603/index.m3u8'), '/media/trial/603/')
  assert.equal(entitlements.linkScope('/media/hls/12/720p/seg_001.ts'), '/media/hls/12/')
})

test('stampPlaylist 给普通 URI 与 URI="..." 属性都追加签名参数', () => {
  const source = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
    '#EXTINF:4.0,',
    'seg_001.ts',
    '#EXTINF:4.0,',
    './seg_002.ts?x=1',
    '#EXT-X-ENDLIST',
  ].join('\n')
  const out = trial.stampPlaylist(source, 'sign=abc&expires=123&sec=45')
  assert.match(out, /URI="key\.bin\?sign=abc&expires=123&sec=45"/)
  assert.match(out, /^seg_001\.ts\?sign=abc&expires=123&sec=45$/m)
  // 已有 query 的用 & 连接，不产生第二个 ?
  assert.match(out, /^\.\/seg_002\.ts\?x=1&sign=abc&expires=123&sec=45$/m)
  assert.equal((out.match(/\?/g) ?? []).length, 3)
})

test('截断 + 改写：只有窗口内的分片留下，且每片都能带票取到', () => {
  const source = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:4.0,',
    'seg_001.ts',
    '#EXTINF:4.0,',
    'seg_002.ts',
    '#EXTINF:4.0,',
    'seg_003.ts',
    '#EXT-X-ENDLIST',
  ].join('\n')
  const cut = trial.truncatePlaylist(source, { seconds: 8 })
  assert.deepEqual([...cut.allowed], ['seg_001.ts', 'seg_002.ts'])
  const out = trial.stampPlaylist(cut.text, 'sign=s&expires=1&sec=8')
  assert.match(out, /URI="init\.mp4\?sign=s&expires=1&sec=8"/)
  assert.match(out, /seg_002\.ts\?sign=s&expires=1&sec=8/)
  assert.doesNotMatch(out, /seg_003\.ts/)
  assert.match(out, /#EXT-X-ENDLIST/)
})
