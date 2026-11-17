#!/usr/bin/env node
/**
 * 归属地缓存预热：把埋点表与访客表里出现过的 IP 一次性解析进 ip_geo。
 *
 * 用法：
 *   MH_GEOIP=1 node scripts/geoip-warm.mjs              # 只补缓存里没有的
 *   MH_GEOIP=1 node scripts/geoip-warm.mjs --refresh    # 全部重查（换接口/怀疑数据不准时）
 *   MH_GEOIP=1 node scripts/geoip-warm.mjs --limit 50 --dry
 *
 * 免费通道 ipwho.is 一次一个 IP、间隔 1.6s，500 个 IP 约 13 分钟，脚本要能挂着跑。
 */
import { db } from '../server/db.mjs'
import { cachedRegions, clearGeoCache, isPrivateIp, maskIp, resolveRegions } from '../server/geoip.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name, fallback) => {
  const hit = args.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const limit = Math.max(1, Number(valueOf('limit', 500)) || 500)
const dry = flag('dry')
const refresh = flag('refresh')

const rows = db.prepare(`SELECT ip, SUM(n) AS n FROM (
    SELECT ip, COUNT(*) AS n FROM track_events WHERE ip IS NOT NULL AND ip <> '' GROUP BY ip
    UNION ALL
    SELECT ip, COUNT(*) AS n FROM visitors WHERE ip IS NOT NULL AND ip <> '' GROUP BY ip
  ) GROUP BY ip ORDER BY n DESC`).all()

const targets = rows.map((row) => String(row.ip ?? '').trim()).filter(Boolean)
const privateIps = targets.filter((ip) => isPrivateIp(ip))
const known = refresh ? new Map() : cachedRegions(targets)
const pending = targets
  .filter((ip) => !isPrivateIp(ip) && (refresh || !known.get(ip)))
  .slice(0, limit)

console.log(`IP 总数 ${targets.length}｜内网 ${privateIps.length}｜已有归属地 ${targets.length - privateIps.length - pending.length}｜待解析 ${pending.length}`)
if (dry) {
  for (const ip of pending.slice(0, 20)) console.log(`  待解析 ${maskIp(ip)}`)
  process.exit(0)
}
if (!pending.length) {
  console.log('没有需要解析的 IP。')
  process.exit(0)
}
if (String(process.env.MH_GEOIP ?? '').trim() !== '1') {
  console.log('未开启 MH_GEOIP=1：不发外部请求，本次什么都不做。')
  process.exit(0)
}
// 重查要先清掉旧行与内存缓存：resolveRegions 命中未过期缓存就直接返回，不会再问接口
if (refresh) {
  const drop = db.prepare('DELETE FROM ip_geo WHERE ip = ?')
  for (const ip of pending) drop.run(ip)
  clearGeoCache()
  console.log(`已清除 ${pending.length} 条旧归属地缓存，开始重查。`)
}

const regions = await resolveRegions(pending)
let ok = 0
for (const ip of pending) if (regions.get(ip)) ok += 1
console.log(`解析完成：成功 ${ok}｜失败 ${pending.length - ok}`)
for (const ip of pending.slice(0, 10)) console.log(`  ${maskIp(ip)} → ${regions.get(ip) || '（空）'}`)
