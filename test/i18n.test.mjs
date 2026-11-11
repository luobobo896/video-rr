import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enumLabel, langFromRequest, localizedYearLabel, normalizeLang } from '../server/i18n.mjs'

test('语言识别与枚举映射支持中英文', () => {
  assert.equal(normalizeLang('en-US'), 'en')
  assert.equal(normalizeLang('zh-CN'), 'zh')
  assert.equal(langFromRequest({ headers: { 'x-mh-lang': 'en' } }), 'en')
  assert.equal(langFromRequest({ headers: { 'accept-language': 'zh-CN,zh;q=0.9' } }), 'zh')

  assert.equal(enumLabel('en', 'category', 'MOVIE'), 'Movies')
  assert.equal(enumLabel('zh', 'category', 'MOVIE'), '电影')
  assert.equal(enumLabel('en', 'orderStatus', 'paid'), 'Paid')
  assert.equal(enumLabel('zh', 'orderStatus', 'paid'), '已支付')
  assert.equal(enumLabel('en', 'currency', 'USD'), 'US Dollar')
  assert.equal(enumLabel('en', 'region', 'HK'), 'Hong Kong')
  assert.equal(localizedYearLabel('en', '90年代'), '1990s')
  assert.equal(localizedYearLabel('zh', '90年代'), '90年代')
})
