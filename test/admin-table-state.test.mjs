import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pageNumbers, readHashQuery, writeHashQuery } from '../admin/table-state.js'

test('表格分页页码保留首尾并用省略号折叠', () => {
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3])
  assert.deepEqual(pageNumbers(5, 20), [1, '…', 4, 5, 6, '…', 20])
  assert.deepEqual(pageNumbers(19, 20), [1, '…', 16, 17, 18, 19, 20])
})

test('表格 URL 状态只保留非空值，并能从 hash 读回', () => {
  const previousLocation = globalThis.location
  const previousHistory = globalThis.history
  let written = ''
  globalThis.location = { hash: '#/users?q=abc&status=active' }
  globalThis.history = { replaceState(_state, _title, url) { written = url } }
  try {
    assert.deepEqual(readHashQuery(), { q: 'abc', status: 'active' })
    writeHashQuery('users', { page: '', pageSize: 20, q: 'abc', status: '', sort: 'email' })
    assert.deepEqual(Object.fromEntries(new URLSearchParams(written.split('?')[1])), {
      pageSize: '20',
      q: 'abc',
      sort: 'email',
    })
  } finally {
    globalThis.location = previousLocation
    globalThis.history = previousHistory
  }
})
