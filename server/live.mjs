/**
 * 直播推流：托管 MediaMTX（RTMP 入流 → HLS 出流）。
 * 推流地址 rtmp://127.0.0.1:1935/live/<key>，播放地址 http://127.0.0.1:8888/live/<key>/index.m3u8
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { db, ROOT } from './db.mjs'

const TOOLS = join(ROOT, 'storage', 'tools')
const BIN = join(TOOLS, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx')
const CONFIG = join(TOOLS, 'mediamtx.yml')
const RTMP_PORT = Number(process.env.MH_RTMP_PORT ?? 1935)
const HLS_PORT = Number(process.env.MH_HLS_PORT ?? 8888)

let child
let lastError

export function liveState() {
  return {
    installed: existsSync(BIN),
    managedBySystemd: MANAGED,
    running: MANAGED ? true : Boolean(child && child.exitCode === null),
    pid: child?.pid,
    lastError,
    rtmpPort: RTMP_PORT,
    hlsPort: HLS_PORT,
    rtmpBase: `rtmp://127.0.0.1:${RTMP_PORT}/live`,
    hlsBase: `http://127.0.0.1:${HLS_PORT}/live`,
    streams: db.prepare('SELECT * FROM live_streams ORDER BY id').all(),
  }
}

// Linux 下 MediaMTX 由 systemd 托管，后台的启停按钮只做提示
const MANAGED = process.platform !== 'win32'

export function startLive() {
  if (MANAGED) {
    lastError = 'Linux 由 systemd 托管（mediamtx.service），无需在后台启停'
    return liveState()
  }
  if (child && child.exitCode === null) return liveState()
  if (!existsSync(BIN)) {
    lastError = `缺少 MediaMTX：${BIN}（见 docs/LIVE.md 的下载步骤）`
    return liveState()
  }
  child = spawn(BIN, [CONFIG], { cwd: TOOLS, windowsHide: true, env: { ...process.env, MTX_RTMPADDRESS: `:${RTMP_PORT}`, MTX_HLSADDRESS: `:${HLS_PORT}` } })
  lastError = undefined
  let buffer = ''
  child.stdout.on('data', (chunk) => { buffer += chunk; if (buffer.length > 20000) buffer = buffer.slice(-8000) })
  child.stderr.on('data', (chunk) => { buffer += chunk; if (buffer.length > 20000) buffer = buffer.slice(-8000) })
  child.on('close', (code) => { lastError = `MediaMTX 退出（code ${code}）：${buffer.split('\n').filter(Boolean).slice(-3).join(' | ')}`; child = undefined })
  db.prepare("UPDATE live_streams SET status = 'active'").run()
  return liveState()
}

export function stopLive() {
  if (MANAGED) return liveState()
  if (child && child.exitCode === null) {
    try { child.kill('SIGKILL') } catch { /* 已退出 */ }
  }
  child = undefined
  db.prepare("UPDATE live_streams SET status = 'idle'").run()
  return liveState()
}

export function ensureStream(name, key) {
  const existing = db.prepare('SELECT * FROM live_streams WHERE stream_key = ?').get(key)
  if (existing) return existing
  const info = db.prepare('INSERT INTO live_streams (name, stream_key, status) VALUES (?, ?, ?)').run(name, key, 'idle')
  return db.prepare('SELECT * FROM live_streams WHERE id = ?').get(Number(info.lastInsertRowid))
}

export function deleteStream(id) {
  db.prepare('DELETE FROM live_streams WHERE id = ?').run(id)
}
