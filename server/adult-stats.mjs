import { db } from './db.mjs'

const pad = (value) => String(value).padStart(2, '0')
const dbTime = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`

/** 今日/本周/本月按 Asia/Shanghai 的日历边界统计，数据库仍存 UTC。 */
export function adultStatsWindowStarts(now = Date.now()) {
  const offset = 8 * 3600_000
  const local = new Date(now + offset)
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()))
  const week = new Date(day)
  week.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  const month = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1))
  return {
    today: dbTime(new Date(day.getTime() - offset)),
    week: dbTime(new Date(week.getTime() - offset)),
    month: dbTime(new Date(month.getTime() - offset)),
  }
}

export function adultStatsFor(dramaIds) {
  const ids = [...new Set((dramaIds ?? []).map(Number).filter((id) => Number.isInteger(id) && id > 0))]
  const result = new Map()
  for (const id of ids) {
    result.set(id, { favoriteCount: 0, todayViews: 0, weekViews: 0, monthViews: 0, totalViews: 0 })
  }
  if (!ids.length) return result

  const marks = ids.map(() => '?').join(', ')
  const favorites = db.prepare(`SELECT drama_id, COUNT(*) AS n FROM favorites
    WHERE drama_id IN (${marks}) GROUP BY drama_id`).all(...ids)
  for (const row of favorites) result.get(Number(row.drama_id)).favoriteCount = Number(row.n ?? 0)

  const starts = adultStatsWindowStarts()
  const views = db.prepare(`SELECT drama_id, COUNT(*) AS total_views,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today_views,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS week_views,
      SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS month_views
    FROM play_events WHERE drama_id IN (${marks}) GROUP BY drama_id`)
    .all(starts.today, starts.week, starts.month, ...ids)
  for (const row of views) {
    const stats = result.get(Number(row.drama_id))
    stats.todayViews = Number(row.today_views ?? 0)
    stats.weekViews = Number(row.week_views ?? 0)
    stats.monthViews = Number(row.month_views ?? 0)
    stats.totalViews = Number(row.total_views ?? 0)
  }
  return result
}
