import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchTrack } from '../public/track-match.js'

const audio = [
  { id: 1, language: 'yue', edition: 'original', label: '粤语原声', default: false },
  { id: 2, language: 'zh-Hans', edition: 'mandarin-dub', label: '国语配音', default: true },
  { id: 3, language: 'en', edition: 'original', label: 'English', default: false },
]
const subtitles = [
  { id: 4, language: 'zh-Hans', edition: 'official', label: '简体中文', default: false },
  { id: 5, language: 'en', edition: 'official', label: 'English', default: true },
]

test('显式语言+版本优先于默认项', () => {
  assert.equal(matchTrack(audio, { language: 'yue', edition: 'original' }, 'zh').id, 1)
})

test('同语言多版本按默认项选择，而不是误选第一条', () => {
  const tracks = [
    { id: 1, language: 'zh-Hans', edition: 'original', default: false },
    { id: 2, language: 'zh-Hans', edition: 'mandarin-dub', default: true },
  ]
  assert.equal(matchTrack(tracks, null, 'zh').id, 2)
})

test('无显式偏好时按语言匹配，其次默认，最后第一条音轨', () => {
  assert.equal(matchTrack(audio, null, 'en').id, 3)
  assert.equal(matchTrack(audio, null, 'ja').id, 2)
})

test('字幕无匹配时关闭，显式关闭保持关闭', () => {
  assert.equal(matchTrack(subtitles, null, 'ja', { subtitle: true }).id, 5)
  const noDefault = subtitles.map((track) => ({ ...track, default: false }))
  assert.equal(matchTrack(noDefault, null, 'ja', { subtitle: true }), null)
  assert.equal(matchTrack(subtitles, 'off', 'zh', { subtitle: true }), null)
  assert.equal(matchTrack(subtitles, null, 'zh', { subtitle: true }).id, 4)
})
