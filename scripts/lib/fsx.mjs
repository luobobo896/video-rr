/**
 * 文件写入工具：原子写 + 可选备份。
 *
 * 事故背景：
 *  - adult-export 直接 writeFileSync 整份 JSON，scp 可能抓到写了一半的文件；
 *  - add-episode-track 原地重写 master m3u8，半截文件会让整集播放直接黑屏。
 * 统一做法：同目录写临时文件 → rename 覆盖（POSIX 同盘 rename 是原子的），
 * 需要回滚时先留一份 `.bak`。
 */
import { closeSync, copyFileSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 临时文件名：同目录 + 唯一后缀，避免跨盘 rename 失败（EXDEV）。 */
export function tempPathFor(target) {
  const token = `${process.pid}-${randomBytes(4).toString('hex')}`
  return join(dirname(target), `.${basename(target)}.${token}.tmp`)
}

/**
 * 原子写文本。
 * @param {string} target
 * @param {string | Buffer} data
 * @param {{ backup?: boolean }} [options]
 * @returns {{ path: string, backup: string }}
 */
export function writeFileAtomicSync(target, data, { backup = false } = {}) {
  const temp = tempPathFor(target)
  const handle = openSync(temp, 'w')
  try {
    writeSync(handle, data)
    // 先落盘再 rename，断电时不会留下「名字对内容空」的文件。
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  let backupPath = ''
  try {
    if (backup && existsSync(target)) {
      backupPath = `${target}.bak`
      // copy 而不是 rename：万一后续 rename 失败，原文件还在原处。
      copyFileSync(target, backupPath)
    }
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return { path: target, backup: backupPath }
}
