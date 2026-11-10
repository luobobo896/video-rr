/**
 * 分类体系标准化：把站内 taxonomy 对齐参考站（人人视频 / pc-sort）的口径。
 *
 * 做三件事，全部幂等（可反复跑）：
 *   1. 榜单补齐到 9 个（热播/热搜/飙升/期待/经典/短剧/季度/高分/冷门佳作），全部 auto=1 每日自动重算；
 *   2. 标签补齐参考站的「类型」20 项与「特色」热门标签，一级挂载、按固定顺序排；
 *   3. 剧集分类归入 动漫 / 电影 / 短剧 / 综艺 / 纪录片（按 data/catalog.json），
 *      并把剧集已有的标签与「类型」标签对齐，让类型筛选有真实计数。
 *
 *   node scripts/normalize-taxonomy.mjs [--dry]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, ROOT } from '../server/db.mjs'

const DRY = process.argv.includes('--dry')
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => (DRY ? { changes: 0 } : db.prepare(sql).run(...args))

/** 榜单：参考站顶部的 9 个榜（顺序即 sort）。 */
const RANK_LISTS = [
  { type: 'HOT', name: '热播榜', sort: 0 },
  { type: 'SEARCH', name: '热搜榜', sort: 1 },
  { type: 'RISE', name: '飙升榜', sort: 2 },
  { type: 'EXPECT', name: '期待榜', sort: 3 },
  { type: 'CLASSIC', name: '经典榜', sort: 4 },
  { type: 'PLAYLIST', name: '短剧榜', sort: 5 },
  { type: 'QUARTER', name: '季度榜', sort: 6 },
  { type: 'HIGHRATE', name: '高分榜', sort: 7 },
  { type: 'HIDDEN', name: '冷门佳作', sort: 8 },
]

/** 类型：参考站「类型」一行的 20 项，全部作为一级标签（sort 200 起，排在运营标签之后）。 */
const GENRES = [
  '剧情', '喜剧', '动作', '冒险', '爱情', '动画', '歌舞', '医疗', '科幻', '奇幻',
  '悬疑', '惊悚', '犯罪', '传记', '历史', '战争', '灾难', '美食', '真人秀', '脱口秀',
]

/** 特色：参考站「标签」一行的热门标签（可运营增删，这里只铺底）。 */
const FEATURES = [
  '完结', '外冷内热', '漫改', '完美主义', '治愈', '宿敌', '奇幻爱情', '高能', '反转', '单元剧',
]

const REPORT = { ranksAdded: 0, tagsAdded: 0, dramasUpdated: 0, bindingsAdded: 0 }

function ensureRankLists() {
  for (const item of RANK_LISTS) {
    const exists = all('SELECT id FROM rank_lists WHERE type = ?', item.type)[0]
    if (exists) continue
    run('INSERT INTO rank_lists (name, type, sort, auto) VALUES (?, ?, ?, 1)', item.name, item.type, item.sort)
    REPORT.ranksAdded += 1
  }
}

function ensureTag(name, sort) {
  const exists = all('SELECT id FROM tags WHERE name = ?', name)[0]
  if (exists) return exists.id
  const info = run("INSERT INTO tags (name, sort, status) VALUES (?, ?, 'active')", name, sort)
  REPORT.tagsAdded += 1
  return Number(info.lastInsertRowid)
}

function ensureTags() {
  GENRES.forEach((name, index) => ensureTag(name, 200 + index))
  FEATURES.forEach((name, index) => ensureTag(name, 300 + index))
}

/**
 * 分类归入：catalog 里已经按参考站口径标好（ANIME/MOVIE/PLAYLET…），
 * 这里按标题匹配站内剧集改 category —— 只改不一致的，日志可见。
 */
function normalizeDramas() {
  const catalog = JSON.parse(readFileSync(join(ROOT, 'data/catalog.json'), 'utf8'))
  for (const entry of catalog.dramas ?? []) {
    const row = all('SELECT id, title, category FROM dramas WHERE title = ?', entry.title)[0]
    if (!row || !entry.category || row.category === entry.category) continue
    run('UPDATE dramas SET category = ? WHERE id = ?', entry.category, row.id)
    REPORT.dramasUpdated += 1
    console.log(`  分类：${row.title} ${row.category} → ${entry.category}`)
  }
}

/** 剧集标签 × 类型标签对齐：剧集已带某类型标签名就绑上对应的一级类型标签。 */
function alignGenreTags() {
  const genreIds = new Map(all('SELECT id, name FROM tags').map((tag) => [tag.name, tag.id]))
  const dramas = all("SELECT id FROM dramas WHERE status = 'published'")
  for (const drama of dramas) {
    const names = all('SELECT t.name FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.drama_id = ?', drama.id)
      .map((row) => row.name)
    for (const name of names) {
      const tagId = genreIds.get(name)
      if (!tagId) continue
      const bound = all('SELECT 1 AS x FROM drama_tags WHERE drama_id = ? AND tag_id = ?', drama.id, tagId)[0]
      if (bound) continue
      run('INSERT OR IGNORE INTO drama_tags (drama_id, tag_id) VALUES (?, ?)', drama.id, tagId)
      REPORT.bindingsAdded += 1
    }
  }
}

function main() {
  console.log(DRY ? '== 预览（--dry，不写库）==' : '== 执行 ==')
  ensureRankLists()
  ensureTags()
  normalizeDramas()
  alignGenreTags()
  console.log(
    `榜单新增 ${REPORT.ranksAdded} 个 / 标签新增 ${REPORT.tagsAdded} 个 / 剧集分类变更 ${REPORT.dramasUpdated} 部 / 类型绑定新增 ${REPORT.bindingsAdded} 条`,
  )
  const ranks = all('SELECT type, name FROM rank_lists ORDER BY sort')
  console.log(`榜单总数 ${ranks.length}：${ranks.map((row) => row.name).join('、')}`)
  const counts = all("SELECT category, COUNT(*) AS n FROM dramas WHERE status = 'published' GROUP BY category ORDER BY n DESC")
  console.log(`频道分布：${counts.map((row) => `${row.category} ${row.n}`).join(' / ') || '空'}`)
}

main()
