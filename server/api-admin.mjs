/** 后台接口：内容/运营/审核/用户订单/直播/转码，全部要求 admin token。 */
import { renameSync, unlinkSync } from 'node:fs'
import { db } from './db.mjs'
import { loginAdmin, authOf } from './auth.mjs'
import { envelope, fail, readJsonBody } from './api-public.mjs'
import { enqueueEpisode, generateSample, probe, queueState, UPLOAD_DIR } from './media.mjs'
import { liveState, startLive, stopLive, ensureStream, deleteStream } from './live.mjs'

const now = () => new Date().toISOString()

function send(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(payload)
  return true
}

const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

export async function handleAdmin(pathname, url, req, res, rawBody, context = {}) {
  const method = req.method ?? 'GET'
  const body = readJsonBody(rawBody)

  // 登录不需要 token
  if (pathname === '/admin/api/login' && method === 'POST') {
    const result = loginAdmin(String(body.username ?? ''), String(body.password ?? ''))
    if (!result) return send(res, fail('0401', '账号或密码不正确'), 401)
    return send(res, envelope({ ...result, username: body.username }))
  }

  const auth = authOf(req)
  if (!auth || auth.role !== 'admin') return send(res, fail('0401', '需要管理员登录'), 401)

  if (pathname === '/admin/api/me') return send(res, envelope({ role: 'admin', id: auth.sub }))

  if (pathname === '/admin/api/stats') {
    const countOf = (table, where = '') => one(`SELECT COUNT(*) AS n FROM ${table} ${where}`).n
    return send(res, envelope({
      dramas: countOf('dramas'),
      episodes: countOf('episodes'),
      readyEpisodes: countOf('episodes', "WHERE status = 'ready'"),
      pendingDanmu: countOf('danmus', "WHERE status = 'pending'"),
      pendingComments: countOf('comments', "WHERE status = 'pending'"),
      users: countOf('users'),
      orders: countOf('orders'),
      revenue: one('SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = \'paid\'').n,
      queue: queueState(),
      live: liveState(),
      updatedAt: now(),
    }))
  }

  /* ---------- 剧集 ---------- */
  if (pathname === '/admin/api/dramas' && method === 'GET') {
    const keyword = url.searchParams.get('keyword') ?? ''
    const rows = keyword
      ? all('SELECT * FROM dramas WHERE title LIKE ? ORDER BY id DESC LIMIT 100', `%${keyword}%`)
      : all('SELECT * FROM dramas ORDER BY id DESC LIMIT 100')
    return send(res, envelope({ list: rows.map((row) => ({
      ...row,
      episodeCount: one('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ?', row.id).n,
    })) }))
  }

  if (pathname === '/admin/api/dramas' && method === 'POST') {
    const info = run(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, score, fee_mode, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    body.title ?? '未命名', body.subTitle ?? '', body.coverUrl ?? '', body.description ?? '',
    Number(body.year ?? 2026), body.area ?? '', body.category ?? 'TV', Number(body.score ?? 8.0),
    body.feeMode ?? 'free', body.status ?? 'published')
    return send(res, envelope({ id: Number(info.lastInsertRowid) }))
  }

  const dramaMatch = /^\/admin\/api\/dramas\/(\d+)$/.exec(pathname)
  if (dramaMatch) {
    const id = Number(dramaMatch[1])
    if (method === 'PUT') {
      const current = one('SELECT * FROM dramas WHERE id = ?', id)
      if (!current) return send(res, fail('0001', '不存在'))
      run(`UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?, category = ?, score = ?, fee_mode = ?, status = ? WHERE id = ?`,
        body.title ?? current.title, body.subTitle ?? current.sub_title, body.coverUrl ?? current.cover_url,
        body.description ?? current.description, Number(body.year ?? current.year), body.area ?? current.area,
        body.category ?? current.category, Number(body.score ?? current.score), body.feeMode ?? current.fee_mode,
        body.status ?? current.status, id)
      return send(res, envelope({ ok: true }))
    }
    if (method === 'DELETE') {
      run('DELETE FROM dramas WHERE id = ?', id)
      return send(res, envelope({ ok: true }))
    }
    if (method === 'GET') {
      const drama = one('SELECT * FROM dramas WHERE id = ?', id)
      if (!drama) return send(res, fail('0001', '不存在'))
      const episodes = all('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no', id)
      return send(res, envelope({ drama, episodes }))
    }
  }

  const episodesMatch = /^\/admin\/api\/dramas\/(\d+)\/episodes$/.exec(pathname)
  if (episodesMatch) {
    const dramaId = Number(episodesMatch[1])
    if (method === 'GET') return send(res, envelope({ list: all('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no', dramaId) }))
    if (method === 'POST') {
      const no = Number(body.no ?? (one('SELECT COALESCE(MAX(no), 0) AS n FROM episodes WHERE drama_id = ?', dramaId).n + 1))
      const info = run('INSERT INTO episodes (drama_id, no, title, duration, vip, status) VALUES (?, ?, ?, ?, ?, ?)',
        dramaId, no, body.title ?? `第 ${no} 集`, Number(body.duration ?? 0), body.vip ? 1 : 0, 'ready')
      return send(res, envelope({ id: Number(info.lastInsertRowid) }))
    }
  }

  const episodeOp = /^\/admin\/api\/episodes\/(\d+)(?:\/(\w+))?$/.exec(pathname)
  if (episodeOp) {
    const episodeId = Number(episodeOp[1])
    const action = episodeOp[2]
    const episode = one('SELECT * FROM episodes WHERE id = ?', episodeId)
    if (!episode) return send(res, fail('0001', '分集不存在'))

    if (method === 'DELETE' && !action) {
      run('DELETE FROM episodes WHERE id = ?', episodeId)
      return send(res, envelope({ ok: true }))
    }

    if (action === 'upload' && method === 'POST') {
      if (!context.uploadPath) return send(res, fail('0400', '没有收到文件'))
      const target = `${UPLOAD_DIR}\\ep-${episodeId}-${Date.now()}.mp4`
      renameSync(context.uploadPath, target)
      const info = await probe(target)
      run('UPDATE episodes SET source_path = ?, duration = ? WHERE id = ?', target, info?.duration ?? episode.duration, episodeId)
      enqueueEpisode({ ...episode, source_path: target, duration: info?.duration ?? episode.duration })
      return send(res, envelope({ ok: true, source: target, probe: info, queue: queueState() }))
    }

    if (action === 'sample' && method === 'POST') {
      const seconds = Math.min(180, Math.max(10, Number(body.seconds ?? 30)))
      const source = await generateSample(seconds, `ep-${episodeId}`)
      const info = await probe(source)
      run('UPDATE episodes SET source_path = ?, duration = ? WHERE id = ?', source, info?.duration ?? seconds, episodeId)
      enqueueEpisode({ ...episode, source_path: source, duration: info?.duration ?? seconds })
      return send(res, envelope({ ok: true, source, probe: info, queue: queueState() }))
    }
  }

  if (pathname === '/admin/api/jobs') return send(res, envelope(queueState()))

  /* ---------- 首页运营 ---------- */
  if (pathname === '/admin/api/banners') {
    if (method === 'GET') return send(res, envelope({ list: all('SELECT * FROM banners ORDER BY sort') }))
    if (method === 'POST') {
      const info = run('INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, ?)',
        body.name ?? '', body.title ?? '', body.image ?? '', body.targetDramaId ?? null, Number(body.sort ?? 0), body.enabled === false ? 0 : 1)
      return send(res, envelope({ id: Number(info.lastInsertRowid) }))
    }
  }
  const bannerMatch = /^\/admin\/api\/banners\/(\d+)$/.exec(pathname)
  if (bannerMatch) {
    const id = Number(bannerMatch[1])
    if (method === 'PUT') {
      const current = one('SELECT * FROM banners WHERE id = ?', id)
      run('UPDATE banners SET name = ?, title = ?, image = ?, target_drama_id = ?, sort = ?, enabled = ? WHERE id = ?',
        body.name ?? current.name, body.title ?? current.title, body.image ?? current.image,
        body.targetDramaId ?? current.target_drama_id, Number(body.sort ?? current.sort),
        body.enabled === undefined ? current.enabled : (body.enabled ? 1 : 0), id)
      return send(res, envelope({ ok: true }))
    }
    if (method === 'DELETE') { run('DELETE FROM banners WHERE id = ?', id); return send(res, envelope({ ok: true })) }
  }

  if (pathname === '/admin/api/sections') {
    if (method === 'GET') {
      const sections = all('SELECT * FROM sections ORDER BY sort')
      return send(res, envelope({ list: sections.map((section) => ({
        ...section,
        items: all(`SELECT si.*, d.title, d.cover_url FROM section_items si JOIN dramas d ON d.id = si.drama_id WHERE si.section_id = ? ORDER BY si.sort`, section.id),
      })) }))
    }
    if (method === 'POST') {
      if (body.action === 'attach') {
        run('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, ?)',
          Number(body.sectionId), Number(body.dramaId), Number(body.sort ?? 0))
        return send(res, envelope({ ok: true }))
      }
      const info = run('INSERT INTO sections (title, sort, enabled) VALUES (?, ?, 1)', body.title ?? '新区块', Number(body.sort ?? 0))
      return send(res, envelope({ id: Number(info.lastInsertRowid) }))
    }
    if (method === 'DELETE') { run('DELETE FROM sections WHERE id = ?', Number(url.searchParams.get('id'))); return send(res, envelope({ ok: true })) }
  }

  /* ---------- 榜单 ---------- */
  if (pathname === '/admin/api/ranks') {
    if (method === 'GET') {
      return send(res, envelope({ list: all('SELECT * FROM rank_lists ORDER BY sort').map((list) => ({
        ...list,
        items: all('SELECT ri.*, d.title FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id WHERE ri.list_id = ? ORDER BY ri.rank_no', list.id),
      })) }))
    }
    if (method === 'POST') {
      if (body.action === 'attach') {
        run('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, ?)',
          Number(body.listId), Number(body.dramaId), Number(body.rankNo ?? 0))
        return send(res, envelope({ ok: true }))
      }
      const info = run('INSERT INTO rank_lists (name, type, sort) VALUES (?, ?, ?)', body.name ?? '新榜单', body.type ?? 'HOT', Number(body.sort ?? 0))
      return send(res, envelope({ id: Number(info.lastInsertRowid) }))
    }
  }

  /* ---------- 审核 ---------- */
  if (pathname === '/admin/api/comments') {
    const status = url.searchParams.get('status')
    const list = status
      ? all('SELECT * FROM comments WHERE status = ? ORDER BY id DESC LIMIT 200', status)
      : all('SELECT * FROM comments ORDER BY id DESC LIMIT 200')
    return send(res, envelope({ list }))
  }
  if (pathname === '/admin/api/danmus') {
    const status = url.searchParams.get('status')
    const list = status
      ? all('SELECT * FROM danmus WHERE status = ? ORDER BY id DESC LIMIT 200', status)
      : all('SELECT * FROM danmus ORDER BY id DESC LIMIT 200')
    return send(res, envelope({ list }))
  }
  const reviewMatch = /^\/admin\/api\/(comments|danmus)\/(\d+)\/(approve|reject)$/.exec(pathname)
  if (reviewMatch) {
    const [, table, id, action] = reviewMatch
    run(`UPDATE ${table} SET status = ? WHERE id = ?`, action === 'approve' ? 'approved' : 'rejected', Number(id))
    return send(res, envelope({ ok: true }))
  }

  /* ---------- 用户 / 订单 ---------- */
  if (pathname === '/admin/api/users') {
    return send(res, envelope({ list: all('SELECT * FROM users ORDER BY id DESC LIMIT 200') }))
  }
  if (pathname === '/admin/api/orders') {
    if (method === 'POST') {
      run('INSERT INTO orders (user_id, sku, amount, status) VALUES (?, ?, ?, ?)',
        Number(body.userId ?? 1), body.sku ?? 'vip-year', Number(body.amount ?? 88), 'pending')
      return send(res, envelope({ ok: true }))
    }
    const list = all('SELECT o.*, u.nickname FROM orders o LEFT JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 200')
    const revenue = one("SELECT COALESCE(SUM(amount), 0) AS n FROM orders WHERE status = 'paid'").n
    return send(res, envelope({ list, revenue }))
  }
  const payMatch = /^\/admin\/api\/orders\/(\d+)\/pay$/.exec(pathname)
  if (payMatch) {
    const id = Number(payMatch[1])
    const order = one('SELECT * FROM orders WHERE id = ?', id)
    if (!order) return send(res, fail('0001', '订单不存在'))
    run("UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?", id)
    if (order.user_id) run("UPDATE users SET is_vip = 1, vip_expire_at = datetime('now', '+365 days') WHERE id = ?", order.user_id)
    return send(res, envelope({ ok: true }))
  }

  /* ---------- 直播 ---------- */
  if (pathname === '/admin/api/live') {
    if (method === 'POST') {
      const action = body.action
      if (action === 'start') return send(res, envelope(startLive()))
      if (action === 'stop') return send(res, envelope(stopLive()))
      if (action === 'create') {
        const stream = ensureStream(body.name ?? '新直播频道', body.key ?? `live${Date.now()}`)
        return send(res, envelope({ stream, live: liveState() }))
      }
      if (action === 'delete') { deleteStream(Number(body.id)); return send(res, envelope({ ok: true })) }
      return send(res, fail('0400', '未知动作'))
    }
    return send(res, envelope(liveState()))
  }

  return send(res, fail('0404', `未知后台接口 ${method} ${pathname}`), 404)
}
