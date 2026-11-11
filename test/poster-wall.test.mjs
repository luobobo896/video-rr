import test from 'node:test'
import assert from 'node:assert/strict'
import { POSTER_VARIANTS, posterFileName, sourceInfoOf } from '../server/poster-wall.mjs'

test('海报变体尺寸固定为三档小图', () => {
  assert.deepEqual(Object.keys(POSTER_VARIANTS), ['portrait', 'square', 'wide'])
  assert.equal(POSTER_VARIANTS.portrait.width, 360)
  assert.equal(POSTER_VARIANTS.square.height, 480)
  assert.equal(POSTER_VARIANTS.wide.width, 960)
  assert.equal(posterFileName('sintel', 'portrait'), 'poster-sintel-portrait.jpg')
})

test('开放影片带许可、署名和可追溯来源', () => {
  const sintel = sourceInfoOf({ title: '辛特尔' })
  assert.equal(sintel.slug, 'sintel')
  assert.equal(sintel.license, 'CC BY 3.0')
  assert.equal(sintel.licenseUrl, 'https://creativecommons.org/licenses/by/3.0/')
  assert.equal(sintel.sourceUrl, 'https://archive.org/details/Sintel')
  assert.equal(sintel.allowsDerivative, true)
  assert.match(sintel.credit, /Blender Foundation/)
})

test('Coffee Run 使用 Blender 官方许可页，避免误传 ND', () => {
  const coffee = sourceInfoOf({ title: '咖啡跑' })
  assert.equal(coffee.license, 'CC BY 4.0')
  assert.equal(coffee.sourceUrl, 'https://studio.blender.org/projects/coffee-run/pages/licensing/')
  assert.equal(coffee.allowsDerivative, true)
})

test('公有领域条目不伪装成 CC BY', () => {
  const bananas = sourceInfoOf({ title: '关于香蕉' })
  assert.equal(bananas.licenseKind, 'public-domain')
  assert.equal(bananas.licenseUrl, null)
  assert.equal(bananas.sourceUrl, 'https://archive.org/details/AboutBan1935')
})
