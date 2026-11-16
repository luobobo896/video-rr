/**
 * jable 直链体检：一眼看出「有多少片现在播不了」。
 *
 * 背景：jable 的 m3u8 带签名，约 3 小时后失效；过期后播放页只会拿到 502，
 * 前端表现为播放按钮是灰的（video 没有可播源）。cron 早已排了刷新任务，但
 * 2026-11-16 那次 crontab 末尾缺换行，整份文件被 cron 忽略，一天之内三千多条
 * 链接全部烂掉——没有任何监控能发现这件事，所以补上这个体检。
 *
 * 用法：
 *   node scripts/jable-health.mjs             # 只报告，超阈值时退出码 2
 *   node scripts/jable-health.mjs --fix       # 超阈值且没有刷新进程在跑时，拉起一轮全量刷新
 *   node scripts/jable-health.mjs --json      # 输出机器可读 JSON（写库/告警用）
 *
 * cron（每 10 分钟，见 deploy/cron.d/video-refresh）：
 *   3,13,23,33,43,53 * * * * root cd /opt/video-rr && /usr/bin/node scripts/jable-health.mjs --fix
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { expiryOf } from '../server/jable.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DB_PATH = process.env.MH_DB || join(ROOT, 'storage', 'app.db')
const REPORT = join(ROOT, 'storage', 'health', 'jable.json')
const LOG = process.env.MH_REFRESH_LOG || '/var/log/video-refresh.log'
const LOG_MAX_BYTES = 8 * 1024 * 1024
const LOG_KEEP_BYTES = 1024 * 1024

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const valueOf = (name, fallback = '') => {
  const hit = argv.find((a) => a.startsWith(`${name}=`))
  if (hit) return hit.slice(name.length + 1)
  const at = argv.indexOf(name)
  const next = at >= 0 ? argv[at + 1] : ''
  return next && !next.startsWith('--') ? next : fallback
}

const asJson = flags.has('--json')
const quiet = flags.has('--quiet')
const fix = flags.has('--fix')
// 超过这个条数就认为「用户已经在踩坑」，不只是噪声
const MAX_EXPIRED = Number(valueOf('--max-expired', '100')) || 100
// 20 分钟内到期的也计入风险：一轮刷新跑不完它们，播放时就会掉到过期
const SOON_SECONDS = Number(valueOf('--soon', '1200')) || 1200

const now = Math.floor(Date.now() / 1000)

/** 库里的 jable 源：只有这类链接才有签名过期问题，本地 HLS 不受影响。 */
function collect() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true })
  try {
    const rows = db.prepare(`SELECT e.id, e.remote_url AS remoteUrl, d.sub_title AS subTitle
      FROM episodes e JOIN dramas d ON d.id = e.drama_id
      WHERE e.remote_url LIKE '%/hls/%' AND e.remote_referer LIKE '%jable.tv%'`).all()
    // 源站已经 404 的番号（刷新时记进 jable-gone.json）：永远刷不回来，别算进过期率
    let goneCodes = new Set()
    try { goneCodes = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'storage', 'jable-gone.json'), 'utf8')))) } catch {}
    let expired = 0
    let soon = 0
    let unknown = 0
    let healthy = 0
    let goneCount = 0
    const samples = []
    for (const row of rows) {
      const exp = expiryOf(row.remoteUrl)
      const code = String(row.subTitle ?? '').split(' ·')[0]
      if (goneCodes.has(code)) { goneCount++; continue }
      if (!exp) { unknown++; continue }
      if (exp <= now) {
        expired++
        if (samples.length < 5) samples.push({ episodeId: row.id, code, expiredFor: now - exp })
      } else if (exp - now <= SOON_SECONDS) soon++
      else healthy++
    }
    return { total: rows.length, expired, soon, healthy, unknown, gone: goneCount, samples }
  } finally {
    db.close()
  }
}

/** 有没有刷新进程在跑：cron 与本脚本共用同一把 flock，这里只看进程名足够。 */
function refreshRunning() {
  if (process.platform !== 'linux') return false
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      let cmd = ''
      try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ') } catch { continue }
      if (cmd.includes('jable-import.mjs') && cmd.includes('--refresh')) return true
    }
  } catch {}
  return false
}

/** 日志不轮转会把 /var 顶满：超过 8MB 就只留最后 1MB。 */
function rotateLog() {
  try {
    if (!existsSync(LOG) || statSync(LOG).size < LOG_MAX_BYTES) return false
    const size = statSync(LOG).size
    const buffer = readFileSync(LOG)
    writeFileSync(LOG, buffer.subarray(size - LOG_KEEP_BYTES))
    return true
  } catch {
    return false
  }
}

function startRefresh() {
  const edge = process.env.MH_EDGE || '/usr/bin/chromium'
  // 与 cron 用同一把锁：再触发一次也只会串行，不会把 Cloudflare 打到挑战页
  // --max-left 200 是"快到期的都刷"，--limit 让这一轮大约一刻钟就收工，
  // 进程定期退出能把 chromium 的渲染进程一并回收，不然跑久了会堆到起不了新浏览器
  const command = `cd ${ROOT} && flock -n /tmp/jable-refresh.lock env MH_EDGE=${edge} xvfb-run -a node scripts/jable-import.mjs --refresh --max-left 200 --limit 420 >> ${LOG} 2>&1`
  const child = spawn('bash', ['-lc', command], { detached: true, stdio: 'ignore' })
  child.unref()
  return true
}

const stats = collect()
const running = refreshRunning()
const pct = stats.total ? Number(((stats.expired / stats.total) * 100).toFixed(2)) : 0
const alert = stats.expired > MAX_EXPIRED || (stats.total > 0 && pct >= 3)
const report = {
  at: new Date().toISOString(),
  ...stats,
  pct,
  refreshRunning: running,
  alert,
  threshold: { maxExpired: MAX_EXPIRED, soonSeconds: SOON_SECONDS },
}

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)
const rotated = rotateLog()

if (fix && alert && !running) {
  report.fixStarted = startRefresh()
  report.fixStartedAt = new Date().toISOString()
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`)
}

if (asJson) {
  console.log(JSON.stringify(report))
} else if (!quiet || alert) {
  const parts = [
    `jable 体检 ${new Date().toLocaleString('zh-CN')}`,
    `总 ${stats.total}`,
    `已过期 ${stats.expired}（${pct}%）`,
    `${Math.round(SOON_SECONDS / 60)} 分钟内到期 ${stats.soon}`,
    `健康 ${stats.healthy}`,
  ]
  if (stats.unknown) parts.push(`无法解析 ${stats.unknown}`)
  if (stats.gone) parts.push(`源站已下架 ${stats.gone}`)
  parts.push(running ? '刷新进行中' : '刷新空闲')
  if (report.fixStarted) parts.push('已拉起全量刷新')
  if (rotated) parts.push('日志已轮转')
  console.log(parts.join(' · '))
  if (alert) {
    console.log(`ALERT 过期 ${stats.expired} 条超过阈值（${MAX_EXPIRED} 条或 3%），播放会 502`)
    for (const s of stats.samples) console.log(`  · episode#${s.episodeId} ${s.code} 已过期 ${Math.round(s.expiredFor / 60)} 分钟`)
  }
}

process.exit(alert ? 2 : 0)
