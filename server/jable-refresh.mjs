/**
 * 直链保鲜：jable 的播放地址带签名，约 3 小时后失效。
 *
 * 库里 3000+ 部，靠定时任务全量重刷在时间上是不成立的（一轮要 8 小时，
 * 刷完最早的又过期了）。所以改成「谁要播，谁续期」：
 *   - 还剩 10 分钟以上：照常用，顺手在后台排一次刷新
 *   - 已经不足 10 分钟：等它刷完再返回，用户多等几秒但一定播得了
 * 同一部并发只会刷一次。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'jable-import.mjs')
const REFRESH_AHEAD_MS = Number(process.env.MH_REFRESH_AHEAD_MS || 10 * 60 * 1000)
const REFRESH_TIMEOUT_MS = Number(process.env.MH_REFRESH_TIMEOUT_MS || 120 * 1000)

const inflight = new Map()

/** 从直链里取签名到期时间戳（秒）；取不到返回 0。 */
export const expiryOf = (url) => Number(/\/hls\/[^/]+\/(\d{9,})\//.exec(String(url ?? ''))?.[1] ?? 0)

/** sub_title 形如「MIKR-134 · 白川美玲」，取前面的番号（连字符和下划线都算）。 */
export const codeOf = (subTitle) => /^([A-Za-z0-9]+[-_]\d+)/.exec(String(subTitle ?? '').trim())?.[1] ?? ''

export const pageUrlOf = (code) => `https://jable.tv/videos/${String(code).toLowerCase().replace(/_/g, '-')}/`

/** 这一集的直链还剩多少毫秒（负数是已过期）。 */
export function leftMsOf(remoteUrl) {
  const exp = expiryOf(remoteUrl)
  return exp ? exp * 1000 - Date.now() : -1
}

/** 只有 jable 的片源才需要这样续期；别的源原样放行。 */
export function needsRefresh(episode) {
  if (!episode?.remote_url || !String(episode.remote_url).includes('/hls/')) return false
  if (!String(episode.remote_referer ?? '').includes('jable.tv')) return false
  return leftMsOf(episode.remote_url) < REFRESH_AHEAD_MS
}

function runOnce(pageUrl) {
  return new Promise((resolve) => {
    const viaXvfb = Boolean(process.env.MH_XVFB)
    const command = viaXvfb ? 'xvfb-run' : process.execPath
    const args = viaXvfb ? ['-a', process.execPath, SCRIPT, pageUrl] : [SCRIPT, pageUrl]
    const child = spawn(command, args, { env: process.env, stdio: 'ignore' })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false) }, REFRESH_TIMEOUT_MS)
    child.on('error', () => { clearTimeout(timer); resolve(false) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

/**
 * 确保这一集的直链是新的。
 * wait=false 时只要还没过期就不等（后台排队刷）；已过期或 wait=true 才会等。
 * 返回 { refreshed, leftMs }。
 */
export async function ensureFresh(episodeId, { wait = false } = {}) {
  const row = db.prepare(`SELECT d.id AS dramaId, d.sub_title AS subTitle, e.remote_url AS remoteUrl, e.remote_referer AS remoteReferer
    FROM episodes e JOIN dramas d ON d.id = e.drama_id WHERE e.id = ?`).get(episodeId)
  if (!row || !needsRefresh({ remote_url: row.remoteUrl, remote_referer: row.remoteReferer })) {
    return { refreshed: false, leftMs: leftMsOf(row?.remoteUrl) }
  }
  const expired = leftMsOf(row.remoteUrl) <= 0
  if (!wait && !expired) {
    // 还能用就别让用户等，后台刷好下次自然生效
    if (!inflight.has(row.dramaId)) {
      inflight.set(row.dramaId, runOnce(pageUrlOf(codeOf(row.subTitle))).finally(() => inflight.delete(row.dramaId)))
    }
    return { refreshed: false, leftMs: leftMsOf(row.remoteUrl) }
  }
  if (!inflight.has(row.dramaId)) {
    inflight.set(row.dramaId, runOnce(pageUrlOf(codeOf(row.subTitle))).finally(() => inflight.delete(row.dramaId)))
  }
  await inflight.get(row.dramaId)
  const next = db.prepare('SELECT remote_url AS remoteUrl FROM episodes WHERE id = ?').get(episodeId)
  return { refreshed: true, leftMs: leftMsOf(next?.remoteUrl) }
}

export const refreshStats = () => ({ inflight: inflight.size, aheadMs: REFRESH_AHEAD_MS })
