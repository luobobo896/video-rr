import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVariants, variantDirOf, variantNameOf } from '../scripts/build-image-variants.mjs'

const hasFfmpeg = (() => {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
      && spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
})()

function makeJpeg(path, width, height) {
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi',
    '-i', `color=c=#336699:s=${width}x${height},noise=alls=60:allf=t+u`,
    '-frames:v', '1', path,
  ])
}

test('变体文件名按宽度命名，放在 images/variants 下', () => {
  assert.equal(variantNameOf('cover-tos.jpg', 320), 'cover-tos-w320.webp')
  assert.equal(variantNameOf('preview-jable-start-561.jpeg', 640), 'preview-jable-start-561-w640.webp')
  assert.equal(variantDirOf('/tmp/pics'), join('/tmp/pics', 'variants'))
})

test('大图生成多个宽度变体且明显更小，二次运行跳过（幂等）', { skip: hasFfmpeg ? false : '本机没有 ffmpeg/ffprobe' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-variants-'))
  try {
    const source = join(dir, 'cover-demo.jpg')
    makeJpeg(source, 1200, 1800)
    const sourceSize = statSync(source).size

    const first = await buildVariants({ dir, widths: [320, 640], concurrency: 2 })
    assert.equal(first.generated, 2, '两个宽度都要生成')
    assert.equal(first.failed, 0)

    const w320 = join(dir, 'variants', 'cover-demo-w320.webp')
    const w640 = join(dir, 'variants', 'cover-demo-w640.webp')
    assert.ok(existsSync(w320) && existsSync(w640))
    assert.ok(statSync(w320).size < sourceSize / 2, '320 宽要小于源图一半')

    const second = await buildVariants({ dir, widths: [320, 640], concurrency: 2 })
    assert.equal(second.generated, 0, '已经生成过的不再重做')
    assert.equal(second.skipped, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// 最宽档永远产出（前端 srcset 的 1280 档靠它兜底），中间档仍按「不放大」跳过。
test('源图比目标宽度还窄时不放大，中间档跳过但最宽档兜底', { skip: hasFfmpeg ? false : '本机没有 ffmpeg/ffprobe' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-variants-small-'))
  try {
    makeJpeg(join(dir, 'thumb.jpg'), 300, 450)
    const stats = await buildVariants({ dir, widths: [320, 640], concurrency: 1 })
    assert.equal(stats.generated, 1, '最宽档 640 必须产出，否则 srcset 最后一档永远 404')
    assert.equal(stats.skipped, 1, '320 档比源图宽，跳过不放大')
    assert.equal(existsSync(join(dir, 'variants', 'thumb-w320.webp')), false)
    assert.equal(existsSync(join(dir, 'variants', 'thumb-w640.webp')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只演练时不落盘', { skip: hasFfmpeg ? false : '本机没有 ffmpeg/ffprobe' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-variants-dry-'))
  try {
    makeJpeg(join(dir, 'cover-x.jpg'), 900, 1350)
    const stats = await buildVariants({ dir, widths: [320], dryRun: true })
    assert.equal(stats.generated, 1)
    assert.equal(existsSync(join(dir, 'variants', 'cover-x-w320.webp')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('非图片文件不会进队列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mh-variants-nonimg-'))
  try {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'x')
    const stats = await buildVariants({ dir, widths: [320], dryRun: true })
    assert.equal(stats.generated + stats.skipped + stats.failed, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
