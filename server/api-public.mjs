/** C 端接口：形状对齐原站（{requestId,code,msg,data}），数据来自 SQLite。 */
import { db, getSetting } from './db.mjs'
import { authOf, loginUserByPhone } from './auth.mjs'

export const envelope = (data, msg = 'Success') => JSON.stringify({
  requestId: Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32),
  code: '0000',
  msg,
  recordsTotal: null,
  data,
})

export const fail = (code, msg) => JSON.stringify({ code, msg, data: {} })

const toCard = (row) => ({
  dramaId: row.id,
  title: row.title,
  subTitle: row.sub_title,
  coverUrl: row.cover_url,
  dramaType: row.category,
  score: row.score,
  feeMode: row.fee_mode,
  badge: row.fee_mode === 'vip' ? 'VIP' : '',
  labels: [],
})

export function readJsonBody(raw) {
  try { return raw ? JSON.parse(raw) : {} } catch { return {} }
}

export function handlePublic(pathname, url, req, res, rawBody) {
  const send = (payload, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
    return true
  }
  const method = req.method ?? 'GET'
  const auth = authOf(req)

  if (pathname === '/api/constants') return send(envelope({ ...(getSetting('site', {})), icp: '本地演示' }))

  if (pathname === '/api/home') {
    const banners = db.prepare('SELECT * FROM banners WHERE enabled = 1 ORDER BY sort').all()
    const sections = db.prepare('SELECT * FROM sections WHERE enabled = 1 ORDER BY sort').all().map((section) => ({
      id: `sec${section.id}`,
      title: section.title,
      items: db.prepare(`
        SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
        WHERE si.section_id = ? AND d.status = 'published' ORDER BY si.sort LIMIT 12`).all(section.id).map(toCard),
    }))
    const hotSearch = db.prepare('SELECT title FROM dramas ORDER BY score DESC LIMIT 8').all().map((row) => row.title)
    return send(envelope({
      banners: banners.map((banner) => ({ id: banner.id, name: banner.name, title: banner.title, image: banner.image, targetUrl: banner.target_drama_id, type: 'season' })),
      sections,
      hotSearch,
    }))
  }

  if (pathname === '/api/category') {
    const type = url.searchParams.get('type') ?? 'ALL'
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
    const pageSize = Math.min(60, Math.max(1, Number(url.searchParams.get('pageSize') ?? 24)))
    const where = type === 'ALL' ? '' : 'AND category = ?'
    const args = type === 'ALL' ? [] : [type]
    const total = db.prepare(`SELECT COUNT(*) AS n FROM dramas WHERE status = 'published' ${where}`).get(...args).n
    const content = db.prepare(`SELECT * FROM dramas WHERE status = 'published' ${where} ORDER BY sort, id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize).map(toCard)
    return send(envelope({ total, currentPage: page, pageSize, isEnd: page * pageSize >= total, end: page * pageSize >= total, content }))
  }

  if (pathname === '/api/rank') {
    const type = url.searchParams.get('type')
    const lists = db.prepare('SELECT * FROM rank_lists ORDER BY sort').all()
    const active = lists.find((list) => list.type === type) ?? lists[0]
    const items = active
      ? db.prepare(`SELECT d.*, ri.rank_no FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id WHERE ri.list_id = ? ORDER BY ri.rank_no`).all(active.id)
      : []
    return send(envelope({
      containerList: lists.map((list) => ({ id: list.id, name: list.name, topList: [{ id: list.id, name: '全部', type: list.type }] })),
      activeType: active?.type,
      list: items.map((item) => ({ ...toCard(item), rankNo: item.rank_no })),
    }))
  }

  if (pathname === '/api/search') {
    const keyword = (url.searchParams.get('keyword') ?? '').trim()
    const rows = keyword === ''
      ? db.prepare("SELECT * FROM dramas WHERE status = 'published' ORDER BY sort LIMIT 12").all()
      : db.prepare("SELECT * FROM dramas WHERE status = 'published' AND (title LIKE ? OR sub_title LIKE ?) ORDER BY score DESC LIMIT 30").all(`%${keyword}%`, `%${keyword}%`)
    return send(envelope({ keyword, total: rows.length, currentPage: 1, isEnd: true, end: true, content: rows.map(toCard) }))
  }

  if (pathname.startsWith('/api/drama/')) {
    const id = Number(pathname.split('/').pop())
    const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(id)
    if (!drama) return send(fail('0001', '剧集不存在'))
    const episodes = db.prepare('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no').all(id)
    return send(envelope({
      ...toCard(drama),
      seasonId: drama.id,
      description: drama.description,
      year: drama.year,
      area: drama.area,
      category: drama.category,
      actors: [],
      episodes: episodes.map((episode) => ({
        id: episode.id,
        no: episode.no,
        title: episode.title,
        duration: episode.duration,
        vip: Boolean(episode.vip),
        status: episode.status,
        hls: episode.hls_path,
      })),
    }))
  }

  if (pathname.startsWith('/api/play/')) {
    const [, , , idRaw, noRaw] = pathname.split('/')
    const dramaId = Number(idRaw)
    const no = Number(noRaw ?? 1)
    const drama = db.prepare('SELECT * FROM dramas WHERE id = ?').get(dramaId)
    const episode = db.prepare('SELECT * FROM episodes WHERE drama_id = ? AND no = ?').get(dramaId, no)
    if (!drama || !episode) return send(fail('0001', '分集不存在'))
    if (episode.vip && !auth) return send(fail('0401', '该集为 VIP 专享，请先登录/开通'))
    const danmu = db.prepare("SELECT * FROM danmus WHERE episode_id = ? AND status = 'approved' ORDER BY time_ms").all(episode.id)
      .map((row) => ({ time: row.time_ms, text: row.content }))
    return send(envelope({
      seasonId: drama.id,
      title: drama.title,
      episode: { id: episode.id, no: episode.no, title: episode.title, status: episode.status, hls: episode.hls_path, vip: Boolean(episode.vip) },
      hls: episode.hls_path,
      danmu,
    }))
  }

  if (pathname === '/api/live') {
    const streams = db.prepare('SELECT * FROM live_streams ORDER BY id').all()
    return send(envelope({
      streams: streams.map((stream) => ({
        id: stream.id,
        name: stream.name,
        key: stream.stream_key,
        status: stream.status,
        rtmp: `rtmp://127.0.0.1:${process.env.MH_RTMP_PORT ?? 1935}/live/${stream.stream_key}`,
        hls: `/live/${stream.stream_key}/index.m3u8`,
      })),
    }))
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = readJsonBody(rawBody)
    const phone = String(body.phone ?? '').trim()
    if (!/^1\d{10}$/.test(phone)) return send(fail('0400', '手机号格式不正确'))
    const result = loginUserByPhone(phone, body.nickname)
    return send(envelope({ token: result.token, expiresAt: result.expiresAt, user: result.user }))
  }

  if (pathname === '/api/auth/me') {
    if (!auth || auth.role !== 'user') return send(fail('0401', '未登录'))
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(auth.sub)
    return send(envelope({ user }))
  }

  if (pathname === '/api/me') {
    if (!auth) return send(envelope({ history: [], favorites: [] }))
    const history = db.prepare(`
      SELECT h.*, d.title, d.cover_url FROM history h JOIN dramas d ON d.id = h.drama_id
      WHERE h.user_id = ? ORDER BY h.updated_at DESC LIMIT 30`).all(auth.sub)
      .map((row) => ({ dramaId: row.drama_id, title: row.title, coverUrl: row.cover_url, episode: row.episode_no, position: row.position }))
    const favorites = db.prepare(`
      SELECT d.* FROM favorites f JOIN dramas d ON d.id = f.drama_id WHERE f.user_id = ? ORDER BY f.created_at DESC`).all(auth.sub).map(toCard)
    return send(envelope({ history, favorites }))
  }

  if (pathname === '/api/me/history' && method === 'POST') {
    if (!auth) return send(fail('0401', '未登录'))
    const body = readJsonBody(rawBody)
    const dramaId = Number(body.seasonId ?? body.dramaId)
    const episodeNo = Number(body.episode ?? 1)
    const position = Number(body.position ?? 0)
    if (!dramaId) return send(fail('0400', '缺少 seasonId'))
    db.prepare(`INSERT INTO history (user_id, drama_id, episode_no, position, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, drama_id) DO UPDATE SET episode_no = excluded.episode_no, position = excluded.position, updated_at = excluded.updated_at`)
      .run(auth.sub, dramaId, episodeNo, position)
    return send(envelope({ ok: true }))
  }

  if (pathname === '/api/me/favorite' && method === 'POST') {
    if (!auth) return send(fail('0401', '未登录'))
    const body = readJsonBody(rawBody)
    const dramaId = Number(body.seasonId ?? body.dramaId)
    if (!dramaId) return send(fail('0400', '缺少 seasonId'))
    const existing = db.prepare('SELECT 1 AS hit FROM favorites WHERE user_id = ? AND drama_id = ?').get(auth.sub, dramaId)
    if (existing) db.prepare('DELETE FROM favorites WHERE user_id = ? AND drama_id = ?').run(auth.sub, dramaId)
    else db.prepare('INSERT INTO favorites (user_id, drama_id) VALUES (?, ?)').run(auth.sub, dramaId)
    return send(envelope({ ok: true, favorited: !existing }))
  }

  return false
}
