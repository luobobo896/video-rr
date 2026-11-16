/**
 * 跨平台进程锁：`--every` 常驻与计划任务重叠时，两个进程会各自拉起 Edge CDP
 * 抢同一个 MH_CHROME_PROFILE，表现是两边都抽不到页面、还互相把浏览器顶掉。
 *
 * 用 `open(lockPath, 'wx')` 原子创建 + 写入 pid；再次启动时读 pid 判存活，
 * 进程已死（断电/被 kill -9）才接管，接管后仍以 pid 匹配保护释放。
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

/** 抢锁失败专用退出码：deploy/cron.d/video-refresh 的 `flock -E 99` 也用它。 */
export const EXIT_LOCK_BUSY = 99

/**
 * pid 是否存活（`process.kill(pid, 0)` 不真的发信号）。
 * EPERM 代表进程存在但属于别的用户 —— 仍然算活着。
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 读锁文件里的 pid；读不到返回 0。 */
export function readLockPid(lockPath) {
  try {
    return Number.parseInt(String(readFileSync(lockPath, 'utf8')).trim(), 10) || 0
  } catch {
    return 0
  }
}

/** 锁文件内容（pid + 命令行，便于运维一眼看出是谁占着）。 */
export function lockPayload(pid = process.pid, label = '') {
  return `${pid}${label ? ` ${label}` : ''}\n`
}

/**
 * 尝试拿锁。
 * @param {string} lockPath
 * @param {{ pid?: number, label?: string }} [options]
 * @returns {{ ok: true, path: string, pid: number, released: boolean, stale: boolean, release: () => boolean }
 *          | { ok: false, path: string, holder: number, reason: 'running' | 'unreadable' }}
 */
export function acquireLock(lockPath, { pid = process.pid, label = '' } = {}) {
  const tryCreate = () => {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, lockPayload(pid, label))
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
  }

  let stale = false
  if (!tryCreate()) {
    const holder = readLockPid(lockPath)
    if (isPidAlive(holder) && holder !== pid) {
      return { ok: false, path: lockPath, holder, reason: 'running' }
    }
    // 持锁进程已不在：接管。先删再抢，抢不到说明别人抢先一步（那就当占用处理）。
    stale = holder !== pid
    try {
      unlinkSync(lockPath)
    } catch {
      /* 已被别人删掉，继续抢 */
    }
    if (!tryCreate()) {
      return { ok: false, path: lockPath, holder: readLockPid(lockPath), reason: 'running' }
    }
  }

  let released = false
  const release = () => {
    if (released) return false
    // 只删自己那把：接管场景下可能出现「自己已经释放、别人的锁在同名路径」。
    if (existsSync(lockPath) && readLockPid(lockPath) === pid) {
      try {
        unlinkSync(lockPath)
        released = true
      } catch {
        /* 并发释放，忽略 */
      }
    } else {
      released = true
    }
    return released
  }
  return { ok: true, path: lockPath, pid, released, stale, release }
}

/** 进程退出时自动释放锁（正常退出与未捕获异常都覆盖）。 */
export function releaseOnExit(lock) {
  if (!lock?.ok) return () => {}
  const handler = () => lock.release()
  process.once('exit', handler)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      lock.release()
      process.exit(0)
    })
  }
  return () => {
    process.removeListener('exit', handler)
    lock.release()
  }
}

/** 拿不到锁时的提示文案。 */
export function lockBusyMessage(lockPath, holder) {
  return [
    `已有另一个导入进程在跑（锁文件 ${lockPath}，pid ${holder || '未知'}）。`,
    '这次直接退出，避免两个 Edge CDP 抢同一个 MH_CHROME_PROFILE。',
    '确认对方已死可以手工删锁，或用 MH_LOCK=/tmp/xxx.lock 换一把锁。',
  ].join('\n')
}
