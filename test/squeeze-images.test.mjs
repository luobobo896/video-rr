import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { squeezeImages } from '../scripts/squeeze-images.mjs'

const roots = []

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mh-squeeze-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'ignore' })
    child.on('error', () => reject(new Error('no-ffmpeg')))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
  })
}

/** 造一张指定宽度、体积明显偏大的 jpg（testsrc 加噪点，避免被压成几 KB）。 */
async function makeLargeJpg(path, width = 1600, height = 2400) {
  await ffmpeg([
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:duration=1`,
    '-frames:v', '1', '-q:v', '2', path,
  ])
}

async function hasFfmpeg() {
  try {
    await ffmpeg(['-version'])
    return true
  } catch {
    return false
  }
}

const FFMPEG = await hasFfmpeg()

test('squeezeImages 演练模式不改动原图', async (t) => {
  if (!FFMPEG) return t.skip('环境缺少 ffmpeg')
  const dir = makeDir()
  const file = join(dir, 'preview-a.jpg')
  await makeLargeJpg(file)
  const before = statSync(file).size
  const stats = await squeezeImages({ dir, glob: 'preview-*.jpg', apply: false, minBytes: 1, concurrency: 2 })
  assert.equal(stats.squeezed, 1)
  assert.equal(statSync(file).size, before)
  assert.equal(readdirSync(dir).length, 1)
})

test('squeezeImages 就地瘦身：文件名不变、体积变小、不留临时文件', async (t) => {
  if (!FFMPEG) return t.skip('环境缺少 ffmpeg')
  const dir = makeDir()
  const file = join(dir, 'preview-big.jpg')
  await makeLargeJpg(file)
  const before = statSync(file).size
  const stats = await squeezeImages({ dir, glob: 'preview-*.jpg', apply: true, minBytes: 1, maxWidth: 1280, concurrency: 2 })
  assert.equal(stats.squeezed, 1)
  assert.equal(stats.failed, 0)
  assert.ok(existsSync(file), '原文件名必须保留，否则数据库里的引用会 404')
  const after = statSync(file).size
  assert.ok(after < before * 0.8, `重压后应明显变小，实际 ${before} → ${after}`)
  const leftovers = readdirSync(dir).filter((name) => name.includes('.squeeze'))
  assert.deepEqual(leftovers, [])
})

test('squeezeImages 只动 glob 命中的文件', async (t) => {
  if (!FFMPEG) return t.skip('环境缺少 ffmpeg')
  const dir = makeDir()
  await makeLargeJpg(join(dir, 'preview-x.jpg'))
  const keep = join(dir, 'cover-keep.jpg')
  await makeLargeJpg(keep)
  writeFileSync(join(dir, 'notes.txt'), 'untouched')
  const before = statSync(keep).size
  const stats = await squeezeImages({ dir, glob: 'preview-*.jpg', apply: true, minBytes: 1, concurrency: 2 })
  assert.equal(stats.squeezed, 1)
  assert.equal(statSync(keep).size, before)
  assert.equal(statSync(join(dir, 'notes.txt')).size, 'untouched'.length)
})

test('squeezeImages 小于阈值的图直接跳过', async (t) => {
  if (!FFMPEG) return t.skip('环境缺少 ffmpeg')
  const dir = makeDir()
  const file = join(dir, 'preview-small.jpg')
  await makeLargeJpg(file, 320, 480)
  const before = statSync(file).size
  const stats = await squeezeImages({ dir, glob: 'preview-*.jpg', apply: true, minBytes: before + 1, concurrency: 1 })
  assert.equal(stats.squeezed, 0)
  assert.equal(stats.skipped, 1)
  assert.equal(statSync(file).size, before)
})

test('squeezeImages 目录不存在时抛出可读错误', async () => {
  const missing = join(tmpdir(), 'mh-squeeze-missing-dir')
  rmSync(missing, { recursive: true, force: true })
  mkdirSync(join(missing, '..'), { recursive: true })
  await assert.rejects(() => squeezeImages({ dir: missing, glob: '*.jpg' }), /ENOENT|no such file/i)
})
