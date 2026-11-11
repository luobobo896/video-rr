import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { resolveInside } from '../server/path-safety.mjs'

test('静态文件路径不能逃逸到根目录外', () => {
  const root = resolve('storage', 'images')
  assert.equal(resolveInside(root, 'cover.jpg'), resolve(root, 'cover.jpg'))
  assert.equal(resolveInside(root, '../secret.txt'), null)
  assert.equal(resolveInside(root, '/etc/passwd'), null)
})

test('静态文件路径允许根目录本身用于索引文件解析', () => {
  const root = resolve('public')
  assert.equal(resolveInside(root, ''), root)
})
