import assert from 'node:assert/strict'
import test from 'node:test'
import { scoreOfViews } from '../server/jable.mjs'
import { parseCount, scoreOf } from '../server/huangguo.mjs'

test('jable 评分：没有播放量时返回 null，不编造分数', () => {
  assert.equal(scoreOfViews(null), null)
  assert.equal(scoreOfViews(''), null)
  assert.equal(scoreOfViews('0'), null)
  assert.equal(scoreOfViews('播放量未知'), null)
})

test('jable 评分：千次播放是 6.0 底盘，十万级到 8.x，封顶 9.0', () => {
  assert.equal(scoreOfViews('1000'), 6)
  assert.equal(scoreOfViews('64 516'), 8.1)
  assert.equal(scoreOfViews('96668'), 8.3)
  assert.equal(scoreOfViews('100000000'), 9)
})

test('jable 评分：播放量越高分数不减，且落在 6.0–9.0', () => {
  const samples = ['1', '500', '3000', '20000', '150000', '2000000', '90000000']
  let previous = 0
  for (const sample of samples) {
    const score = scoreOfViews(sample)
    assert.ok(score >= 6 && score <= 9, `${sample} → ${score} 越界`)
    assert.ok(score >= previous, `${sample} 分数回退了`)
    previous = score
  }
})

test('短剧播放量解析：万、w、k、亿都能折算成数字', () => {
  assert.equal(parseCount('10.1w'), 101000)
  assert.equal(parseCount('246.7万'), 2467000)
  assert.equal(parseCount('3.8k'), 3800)
  assert.equal(parseCount('1.2亿'), 120000000)
  assert.equal(parseCount('160'), 160)
  assert.equal(parseCount(''), 0)
})

test('短剧评分：按播放/收藏/点赞折算，缺播放量返回 null', () => {
  assert.equal(scoreOf({}), null)
  assert.equal(scoreOf({ views: '0' }), null)
  const low = scoreOf({ views: '1000', likes: '1', collects: '0' })
  const high = scoreOf({ views: '246.7万', likes: '3.8k', collects: '1.6w' })
  assert.ok(low >= 6 && low <= 9.6, `低热 ${low} 越界`)
  assert.ok(high > low, `高热 ${high} 应高于低热 ${low}`)
  assert.ok(high <= 9.6, `高热 ${high} 越界`)
})
