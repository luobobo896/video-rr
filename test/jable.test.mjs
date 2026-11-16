import test from 'node:test'
import assert from 'node:assert/strict'
import { parseVideoPage, parseVideoLinks, durationOfPlaylist, expiryOf, parseThumbVtt, slugOf, artworkUrls } from '../server/jable.mjs'

const PAGE = `<!DOCTYPE html><html><head><title>x</title></head><body>
<section id="video-player" class="video-player">
  <video poster="https://assets-cdn.jable.tv/contents/videos_screenshots/63000/63332/preview.jpg" id="player"></video>
  <script>
    var hlsUrl = 'https://cdn-a.mushroomtrack.com/hls/TOKEN123/1794769762/63000/63332/63332.m3u8';
    var hasVtt = 1;
    var vttUrl = 'https://cdn-a.mushroomtrack.com/hls/TOKEN123/1794769762/63000/63332/thumbvtt.ts';
  </script>
  <script>var pageContext = { videoId: '63332' };</script>
</section>
<section class="video-info pb-3">
  <div class="info-header">
    <div class="header-left">
      <h4>MIKR-134 綺麗なお姉さん 白川美玲</h4>
      <h6>
        <svg><use xlink:href="#icon-clock"></use></svg>
        <span class="mr-3">10 小時前</span>
        <svg><use xlink:href="#icon-eye"></use></svg>
        <span class="mr-3">64 516</span>
        <div class="models">
          <a class="model" href="https://jable.tv/models/abc/"><span title="白川美玲">白</span></a>
        </div>
      </h6>
    </div>
    <div class="header-right">
      <span class="inactive-color">上市於 2026-11-12</span>
    </div>
  </div>
  <h5 class="tags h6-md">
    <a href="https://jable.tv/categories/pov/" class="cat">男友視角</a>
    <span class="separator">•</span>
    <a href="https://jable.tv/tags/girl/">少女</a>
    <a href="https://jable.tv/tags/pantyhose/">絲襪</a>
  </h5>
</section>
</body></html>`

test('影片页能解析出番号、直链、封面与女優', () => {
  const meta = parseVideoPage(PAGE, 'https://jable.tv/videos/mikr-134/')
  assert.equal(meta.code, 'MIKR-134')
  assert.equal(meta.videoId, '63332')
  assert.equal(meta.hlsUrl, 'https://cdn-a.mushroomtrack.com/hls/TOKEN123/1794769762/63000/63332/63332.m3u8')
  assert.equal(meta.vttUrl.endsWith('thumbvtt.ts'), true)
  assert.equal(meta.hasVtt, true)
  assert.equal(meta.coverUrl, 'https://assets-cdn.jable.tv/contents/videos_screenshots/63000/63332/preview.jpg')
  assert.deepEqual(meta.models, ['白川美玲'])
  assert.deepEqual(meta.categories, ['男友視角'])
  assert.deepEqual(meta.tags, ['少女', '絲襪'])
  assert.equal(meta.releaseDate, '2026-11-12')
  assert.equal(meta.views, 64516)
  assert.equal(meta.slug, 'jable-mikr-134')
})

test('站内标题不再重复番号，番号与女優进 sub_title', () => {
  const meta = parseVideoPage(PAGE, 'https://jable.tv/videos/mikr-134/')
  assert.equal(meta.titleBody, '綺麗なお姉さん 白川美玲')
  assert.equal(meta.subtitle, 'MIKR-134 · 白川美玲')
})

test('列表页取出的影片链接去重且保留顺序', () => {
  const list = `<a href="https://jable.tv/videos/a-1/">1</a>
    <a href="https://jable.tv/videos/b-2/">2</a>
    <a href="https://jable.tv/videos/a-1/">1 again</a>
    <a href="https://jable.tv/videos/c-3/?from=list">3</a>`
  assert.deepEqual(parseVideoLinks(list), [
    'https://jable.tv/videos/a-1/',
    'https://jable.tv/videos/b-2/',
    'https://jable.tv/videos/c-3/',
  ])
})

test('累加 EXTINF 得到整片时长', () => {
  const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:8
#EXTINF:7.240567,
633320.ts
#EXTINF:1.2012,
633321.ts
#EXTINF:4.738067,
633322.ts
#EXT-X-ENDLIST`
  assert.equal(durationOfPlaylist(playlist), 13.18)
})

test('从 hlsUrl 读出签名过期时刻，改 exp 即失效', () => {
  assert.equal(expiryOf('https://cdn-a.mushroomtrack.com/hls/TOKEN/1794769762/63000/63332/63332.m3u8'), 1794769762)
  assert.equal(expiryOf('https://example.com/plain.m3u8'), 0)
})

test('预览雪碧图 VTT 解析出每帧的坐标与时间', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:01:00.000
thumb.ts#xywh=0,0,213,120

00:01:00.000 --> 00:02:00.000
thumb.ts#xywh=213,0,213,120`
  const frames = parseThumbVtt(vtt)
  assert.equal(frames.length, 2)
  assert.deepEqual(frames[1], { start: 60, end: 120, x: 213, y: 0, width: 213, height: 120 })
})

test('页面没有 hlsUrl 时给出空直链而不是抛错', () => {
  const meta = parseVideoPage('<html><body>Just a moment...</body></html>', 'https://jable.tv/videos/x-1/')
  assert.equal(meta.hlsUrl, '')
  assert.equal(meta.code, '')
  assert.equal(meta.slug, '')
})

test('番号转 slug，素材地址按千位分档', () => {
  assert.equal(slugOf('MIKR-134'), 'jable-mikr-134')
  assert.equal(slugOf('ABC_123'), 'jable-abc-123')
  assert.equal(slugOf(''), '')
  assert.equal(artworkUrls('63332').cover, 'https://assets-cdn.jable.tv/contents/videos_screenshots/63000/63332/preview.jpg')
  assert.deepEqual(artworkUrls('bad'), {})
})
