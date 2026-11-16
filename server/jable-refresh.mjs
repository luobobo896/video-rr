/**
 * 直链保鲜：jable 的播放地址带签名，约 3 小时后失效。
 *
 * 库里 3000+ 部，靠定时任务全量重刷在时间上是不成立的（一轮要 8 小时，
 * 刷完最早的又过期了）。所以两条腿走路：
 *   1. cron 每 15 分钟刷「45 分钟内到期」的一批（deploy/cron.d/video-refresh）
 *   2. 谁要播、谁的票已经过期，就当场续一次（这个文件）
 *
 * 续期失败的常见原因是 Cloudflare 挑战，是概率性的：同一个页面重试一次往往就过。
 * 所以这里记住「刚失败过的片子」，5 分钟内不再为它反复开浏览器——否则用户每点一次
 * 播放都往 CF 上撞一次，只会让限流更久。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from './db.mjs'
import { expiryOf } from './jable.mjs'
import { logInfo, logWarn } from './logger.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'jable-import.mjs')
const REFRESH_AHEAD_MS = Number(process.env.MH_REFRESH_AHEAD_MS || 10 * 60 * 1000)
const REFRESH_TIMEOUT_MS = Number(process.env.MH_REFRESH_TIMEOUT_MS || 120 * 1000)
const FAIL_COOLDOWN_MS = Number(process.env.MH_REFRESH_COOLDOWN_MS || 5 * 60 * 1000)
// 按需续期用独立的锁和 profile：定时批次动辄跑十几分钟，共用一把锁会让用户永远等不到。
// 浏览器实例用同一个 profile 会互相抢，所以两边各留一份。
const REFRESH_LOCK = process.env.MH_REFRESH_LOCK || '/tmp/jable-refresh-ondemand.lock'
// flock -E：抢不到锁用这个退出码，和子进程自己的失败码区分开
const BUSY_EXIT = '99'
const REFRESH_PROFILE = process.env.MH_REFRESH_PROFILE || join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', '.jable-chrome-od')
// 同时只开两个浏览器：CF 认的是出口 IP 的总频率，不是单页频率
const MAX_CONCURRENT = Math.max(1, Number(process.env.MH_REFRESH_CONCURRENCY || 2))

let attempts = 0
const inflight = new Map()
const failing = new Map()
// failing 是"按剧 id 记冷却"，长期运行会随库里剧数增长；给个上限，超了就丢最早写入的条目。
const MAX_FAILING = Math.max(100, Number(process.env.MH_REFRESH_FAILING_MAX || 5000))

function rememberFailure(dramaId, value) {
  failing.delete(dramaId)
  failing.set(dramaId, value)
  while (failing.size > MAX_FAILING) failing.delete(failing.keys().next().value)
}
const waiting = []
let active = 0

/** 从直链里取签名到期时间戳（秒）；取不到返回 0。 */
// expiryOf 统一由 jable.mjs 提供：这里曾经自己写了一份正则，和导入侧漂移成
// `\d{9,}` vs `\d{9,11}`，同一个直链两边算出不同的过期时间。保留 re-export 是为了
// 不改 test/jable-refresh.test.mjs 与其它调用方的导入路径。
export { expiryOf }

/** sub_title 形如「MIKR-134 · 白川美玲」，取前面的番号（连字符和下划线都算）。 */
export const codeOf = (subTitle) => /^([A-Za-z0-9]+[-_]\d+)/.exec(String(subTitle ?? '').trim())?.[1] ?? ''

export const pageUrlOf = (code) => `https://jable.tv/videos/${String(code).toLowerCase().replace(/_/g, '-')}/`

/** 这一集的直链还剩多少毫秒（负数是已过期，0 表示解析不出过期时间）。 */
export function leftMsOf(remoteUrl) {
  const exp = expiryOf(remoteUrl)
  return exp ? exp * 1000 - Date.now() : -1
}

/**
 * 直链是不是「真的过期了」。
 * 只有解析得出签名时间的源（jable 的 /hls/<token>/<exp>/）才谈得上过期；
 * `huangguo://12988/1`、archive.org 的 mp4 这类没有 exp 的源必须放行，
 * 否则一律被当成过期，整批片源会全变成「签名已过期」。
 */
export function staleOf(remoteUrl) {
  const exp = expiryOf(remoteUrl)
  return exp > 0 && exp * 1000 <= Date.now()
}

/** 只有 jable 的片源才需要这样续期；别的源原样放行。 */
export function needsRefresh(episode) {
  if (!episode?.remote_url || !String(episode.remote_url).includes('/hls/')) return false
  if (!String(episode.remote_referer ?? '').includes('jable.tv')) return false
  return leftMsOf(episode.remote_url) < REFRESH_AHEAD_MS
}

/** 正在被限流冷却的剧：返回剩余秒数，0 表示不在冷却。 */
export const cooldownLeftMs = (dramaId) => Math.max(0, (failing.get(dramaId)?.until ?? 0) - Date.now())

/** 连续失败次数：用来区分「暂时被 Cloudflare 拦了一下」和「源站真的没这部了」。 */
export const failureCountOf = (dramaId) => failing.get(dramaId)?.count ?? 0

async function withSlot(task) {
  if (active >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve))
  active++
  try {
    return await task()
  } finally {
    active--
    const next = waiting.shift()
    if (next) next()
  }
}

function runOnce(pageUrl, timeoutMs) {
  return new Promise((resolve) => {
    const viaXvfb = Boolean(process.env.MH_XVFB)
    // 用独立的锁：定时批次动辄跑十几分钟，跟它抢同一把锁会让用户永远等不到
    const script = viaXvfb
      ? ['xvfb-run', '-a', process.execPath, SCRIPT, pageUrl, '--no-images', '--no-preview']
      : [process.execPath, SCRIPT, pageUrl, '--no-images', '--no-preview']
    // -E 99：抢不到锁时用 99 退出，免得和子进程自己的 exit 1（抓页失败）混在一起。
    // 不加 -E 的话 flock 会把子进程的退出码原样透出，失败会被误判成「锁被占」。
    const child = spawn('flock', ['-n', '-E', BUSY_EXIT, REFRESH_LOCK, ...script], {
      env: { ...process.env, MH_CHROME_PROFILE: REFRESH_PROFILE },
      stdio: 'ignore',
    })
    // 超时不杀：冷启动要过 Cloudflare 挑战（40 秒级），杀掉就意味着用户下一次点还是从零开始。
    // 让它自己跑完，前端过几秒重试时票已经换好了；拖太久（45 秒）才兜底清理。
    let killTimer = null
    const timer = setTimeout(() => {
      resolve(-1)
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      }, 45 * 1000)
    }, timeoutMs)
    const done = (code) => {
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolve(code ?? -1)
    }
    child.on('error', () => done(-1))
    // 0 成功；99 是 flock 没抢到锁（另一个按需续期在跑）；其它都按失败算（含抓页失败 exit 1）
    child.on('exit', (code) => done(code))
  })
}

/** 轮询数据库等另一路续期把票换掉（同一集被连点、多个用户同时点）。 */
async function waitForRenewal(episodeId, before, budgetMs) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    const next = db.prepare('SELECT remote_url AS remoteUrl FROM episodes WHERE id = ?').get(episodeId)
    if (expiryOf(next?.remoteUrl) > before) return next.remoteUrl
  }
  return ''
}

/** 同一部片同时只刷一次；失败进入冷却，避免用户连点把 CF 惹毛。 */
function schedule(row, timeoutMs) {
  if (inflight.has(row.dramaId)) return inflight.get(row.dramaId)
  const task = withSlot(() => runOnce(pageUrlOf(codeOf(row.subTitle)), timeoutMs))
    .catch(() => -1)
    .finally(() => inflight.delete(row.dramaId))
  inflight.set(row.dramaId, task)
  return task
}

/**
 * 同一个番号在库里可能有多条剧（历史导入留下了 194 组重复）。
 * 按番号刷新时，新票只会写进其中一条，其余几条永远换不到——点进去就是无限「续期中」。
 * 所以刷新完统一做一次「按番号借票」：谁手里有比我们新的票，就抄给这一集。
 */
function adoptFresherTicket(episodeId, subTitle, before) {
  const code = codeOf(subTitle)
  if (!code) return ''
  const like = `${code.toUpperCase().replace(/_/g, '-')}%`
  const siblings = db.prepare(`SELECT e.id, e.remote_url AS remoteUrl FROM episodes e JOIN dramas d ON d.id = e.drama_id
    WHERE upper(replace(d.sub_title, '_', '-')) LIKE ? AND e.remote_url LIKE '%/hls/%'`).all(like)
  let best = null
  for (const s of siblings) {
    const exp = expiryOf(s.remoteUrl)
    if (exp <= before) continue
    if (!best || exp > best.exp) best = { id: s.id, remoteUrl: s.remoteUrl, exp }
  }
  if (!best) return ''
  if (best.id !== episodeId) db.prepare('UPDATE episodes SET remote_url = ? WHERE id = ?').run(best.remoteUrl, episodeId)
  return best.remoteUrl
}

/** 失败冷却逐级加长：偶尔被 CF 拦一下别一棍子打死，真下架了才退到 5 分钟。 */
const cooldownFor = (count) => (count <= 1 ? 60 * 1000 : count === 2 ? 3 * 60 * 1000 : FAIL_COOLDOWN_MS)

/** 真正去换票：冷却、并发、抢锁、结果判定都在这里。 */
async function renew(row, episodeId, timeoutMs) {
  const before = expiryOf(row.remoteUrl)
  attempts++
  if (cooldownLeftMs(row.dramaId) > 0) {
    // 刚失败过：不再开浏览器，直接把现状告诉调用方，让前端提示"稍后重试"
    return {
      refreshed: false, ok: false, leftMs: leftMsOf(row.remoteUrl),
      cooldownMs: cooldownLeftMs(row.dramaId), failureCount: failureCountOf(row.dramaId),
    }
  }
  const code = await schedule(row, timeoutMs)
  if (String(code) === BUSY_EXIT) {
    // 另一个按需续期正占着锁：稍微等一下它，别让用户白等一轮
    const renewed = await waitForRenewal(episodeId, before, 3000)
    if (renewed) return { refreshed: true, ok: true, leftMs: leftMsOf(renewed) }
    return { refreshed: false, ok: false, busy: true, leftMs: leftMsOf(row.remoteUrl), failureCount: failureCountOf(row.dramaId) }
  }
  // 超时（-1）不算失败：子进程还在后台跑（冷启动要过 CF 挑战），前端几秒后自动重试就拿到了。
  // 让请求在这里多等只会把播放页卡住，所以直接告诉前端「续期中」。
  if (code === -1) {
    // 后台子进程跑完后会把票写进这个番号的某一条剧里：过 25 秒回来抄一次，
    // 这样即使前端重试时票还没好，等它真好了这次也能自动跑通。
    const timer = setTimeout(() => adoptFresherTicket(episodeId, row.subTitle, before), 25000)
    timer.unref?.()
    return { refreshed: false, ok: false, pending: true, leftMs: leftMsOf(row.remoteUrl), failureCount: failureCountOf(row.dramaId) }
  }
  const own = db.prepare('SELECT remote_url AS remoteUrl FROM episodes WHERE id = ?').get(episodeId)
  let current = expiryOf(own?.remoteUrl) > before ? own.remoteUrl : ''
  if (!current) current = adoptFresherTicket(episodeId, row.subTitle, before)
  const ok = expiryOf(current) > before && leftMsOf(current) > 0
  if (ok) {
    failing.delete(row.dramaId)
    logInfo('jable.refresh_ok', { episodeId, leftMs: leftMsOf(current) })
  } else {
    const prev = failureCountOf(row.dramaId)
    rememberFailure(row.dramaId, { until: Date.now() + cooldownFor(prev + 1), count: prev + 1 })
    // 只记番号与阈值，别把带签名的直链写进日志
    logWarn('jable.refresh_failed', { episodeId, code, attempt: prev + 1, cooldownMs: cooldownFor(prev + 1) })
  }
  return { refreshed: true, ok, leftMs: leftMsOf(current || own?.remoteUrl), failureCount: failureCountOf(row.dramaId) }
}

function rowOf(episodeId) {
  return db.prepare(`SELECT d.id AS dramaId, d.sub_title AS subTitle, e.remote_url AS remoteUrl, e.remote_referer AS remoteReferer
    FROM episodes e JOIN dramas d ON d.id = e.drama_id WHERE e.id = ?`).get(episodeId)
}

/**
 * 确保这一集的直链是新的。
 * wait=false 时只要还没过期就不等（后台排队刷）；已过期或 wait=true 才会等。
 * 返回 { refreshed, ok, leftMs }：ok=false 表示刷过了但票没变新（多半被 CF 挡了）。
 */
export async function ensureFresh(episodeId, { wait = false, timeoutMs = REFRESH_TIMEOUT_MS } = {}) {
  const row = rowOf(episodeId)
  if (!row || !needsRefresh({ remote_url: row.remoteUrl, remote_referer: row.remoteReferer })) {
    return { refreshed: false, ok: true, leftMs: leftMsOf(row?.remoteUrl) }
  }
  if (!wait && leftMsOf(row.remoteUrl) > 0) {
    // 还能用就别让用户等，后台刷好下次自然生效
    if (cooldownLeftMs(row.dramaId) === 0) schedule(row, timeoutMs)
    return { refreshed: false, ok: true, leftMs: leftMsOf(row.remoteUrl) }
  }
  return renew(row, episodeId, timeoutMs)
}

/**
 * 用户点开某一集时用：**只有票真过期了才换**，没过期一次都不刷。
 *
 * 和 ensureFresh 的区别是不看「10 分钟内到期」那个提前量——票还能用的时候，
 * 用户点进去就该立刻开播，不该为了几分钟后的过期先让他等一次换票。
 */
export async function ensureFreshForPlay(episodeId, { timeoutMs = REFRESH_TIMEOUT_MS } = {}) {
  const row = rowOf(episodeId)
  if (!row || !staleOf(row.remoteUrl)) {
    return { refreshed: false, ok: true, leftMs: leftMsOf(row?.remoteUrl) }
  }
  return renew(row, episodeId, timeoutMs)
}

export const refreshStats = () => ({ inflight: inflight.size, attempts, aheadMs: REFRESH_AHEAD_MS, failing: failing.size, maxConcurrent: MAX_CONCURRENT })

/**
 * 把按需续期用的浏览器 profile 预热一下（过一遍首页拿 cf_clearance）。
 * 冷 profile 的第一次点击要重吃 Cloudflare 挑战（40 秒级），前端等不起；
 * 服务端启动时跑一次、之后每 20 分钟一次，用户点开基本都能 1～3 秒换好。
 */
export function warmProfile() {
  return new Promise((resolve) => {
    if (inflight.has('__warm__')) return resolve(false)
    const viaXvfb = Boolean(process.env.MH_XVFB)
    const base = [process.execPath, SCRIPT, '--warm']
    const script = viaXvfb ? ['xvfb-run', '-a', ...base] : base
    const child = spawn('flock', ['-n', '-E', BUSY_EXIT, REFRESH_LOCK, ...script], {
      env: { ...process.env, MH_CHROME_PROFILE: REFRESH_PROFILE },
      stdio: 'ignore',
    })
    inflight.set('__warm__', true)
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } resolve(false) }, 90 * 1000)
    const done = (ok) => { clearTimeout(timer); inflight.delete('__warm__'); resolve(ok) }
    child.on('error', () => done(false))
    child.on('exit', (code) => done(code === 0))
  })
}
