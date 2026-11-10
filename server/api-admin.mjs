/** 后台接口：RBAC 保护 + 审计 + 内容/付费策略/套餐/优惠券/订单/退款/对账/权限。 */
import { db, getSetting, setSetting } from './db.mjs'
import { authOf, loginAdmin } from './auth.mjs'
import { send } from './api-public.mjs'
import { hasPermission, listAdmins, listAudit, listPermissionCatalog, listRoles, loadPrincipal, menuTree, roleMenuBinding, setAdminRoles, updateRoleMenus } from './rbac.mjs'
import { audit } from './rbac.mjs'
import {
  commerceStats, createRefund, approveRefund, rejectRefund, reconcile, listOrders, closeExpiredOrders, markPaid,
  listChannels, upsertChannel, setChannelStatus, setDefaultChannel, deleteChannel, testChannel, paymentOptions, channelConfig,
} from './commerce.mjs'
import { enqueueEpisode, generateSample, probe, queueState } from './media.mjs'
import { policyOf } from './entitlements.mjs'
import {
  PRESETS, channelList, emailSettings, isDevMail, markTest, removeChannel, saveEmailSettings, upsertChannel as upsertMailChannel, verifyChannel,
} from './mail-channels.mjs'
import { pollDeviceFlow, startDeviceFlow } from './mailer-oauth.mjs'
import { analyticsReport } from './analytics.mjs'
import { createTag, deleteTag, listTags, setDramaTags, tagsOfDrama, updateTag } from './tags.mjs'
import { guardStats } from './ratelimit.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const ipOf = (req) => (req.socket?.remoteAddress ?? '').replace('::ffff:', '')
const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 2e6) req.destroy() })
  req.on('end', () => {
    if (!raw) return resolve({})
    try { resolve(JSON.parse(raw)) } catch { resolve({}) }
  })
})

const PERM = {
  login: null,
  me: null,
  stats: 'dashboard.read',
  dramas: 'content.drama.read',
  dramaWrite: 'content.drama.write',
  dramaPublish: 'content.drama.publish',
  dramaDelete: 'content.drama.delete',
  episodes: 'content.drama.read',
  episodeWrite: 'content.episode.write',
  policy: 'content.policy.write',
  plans: 'commerce.plan.write',
  coupons: 'commerce.coupon.write',
  orders: 'finance.order.read',
  orderConfirm: 'finance.order.confirm',
  tagRead: 'tag.read',
  tagWrite: 'tag.write',
  analytics: 'analytics.read',
  refundCreate: 'finance.refund.create',
  refundApprove: 'finance.refund.approve',
  reconcile: 'finance.reconcile.run',
  banners: 'ops.banner.write',
  sections: 'ops.section.write',
  ranks: 'ops.rank.write',
  review: 'content.review',
  users: 'user.read',
  userManage: 'user.manage',
  cs: 'cs.toolkit',
  roles: 'admin.read',
  rolesWrite: 'admin.write',
  payChannelRead: 'payment.channel.read',
  payChannelWrite: 'payment.channel.write',
  emailRead: 'email.read',
  emailWrite: 'email.write',
  audit: 'audit.read',
  analytics: 'analytics.read',
  paySettings: 'admin.write',
}

export async function handleAdmin(pathname, url, req, res, rawBody, opts = {}) {
  const method = req.method
  const body = rawBody !== undefined ? rawBody : (['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {})
  const seg = pathname.replace('/admin/api/', '').split('/').filter(Boolean)

  if (pathname === '/admin/api/login' && method === 'POST') {
    const result = loginAdmin(String(body.username ?? ''), String(body.password ?? ''))
    if (!result) {
      audit({ actorType: 'admin', actorName: body.username, action: 'admin.login.failed', ip: ipOf(req), result: 'denied' })
      return send(res, {}, '0401', '账号或密码错误', 401)
    }
    const principal = loadPrincipal(Number(result.token ? JSON.parse(Buffer.from(result.token.split('.')[0], 'base64url').toString()).sub : 0))
    audit({ actorType: 'admin', actorId: principal?.admin?.id, actorName: principal?.admin?.username, action: 'admin.login', ip: ipOf(req) })
    return send(res, { token: result.token, expiresAt: result.expiresAt, roles: principal?.roles?.map((role) => role.code) ?? [] })
  }

  const auth = authOf(req)
  const principal = auth?.role === 'admin' ? loadPrincipal(Number(auth.sub)) : undefined
  if (!principal) return send(res, {}, '0401', '需要管理员登录', 401)

  const deny = (perm) => {
    audit({ actorId: principal.admin.id, actorName: principal.admin.username, action: 'rbac.denied', targetType: 'permission', targetId: perm, ip: ipOf(req), result: 'denied' })
    return send(res, { required: perm }, '0403', '无权限执行该操作', 403)
  }
  const guard = (perm) => (!perm || hasPermission(principal, perm) ? true : false)
  const log = (action, targetType, targetId, before, after, reason) => audit({
    actorId: principal.admin.id, actorName: principal.admin.username,
    action, targetType, targetId, before, after, reason, ip: ipOf(req),
  })

  /* ---------- 会话/概览 ---------- */
  if (pathname === '/admin/api/me') {
    return send(res, {
      admin: { id: principal.admin.id, username: principal.admin.username, displayName: principal.admin.display_name },
      roles: principal.roles.map((role) => ({ code: role.code, name: role.name })),
      permissions: [...principal.permissions],
    })
  }

  if (pathname === '/admin/api/stats') {
    if (!guard(PERM.stats)) return deny(PERM.stats)
    return send(res, {
      dramas: one('SELECT COUNT(*) AS n FROM dramas').n,
      episodes: one('SELECT COUNT(*) AS n FROM episodes').n,
      readyEpisodes: one("SELECT COUNT(*) AS n FROM episodes WHERE status = 'ready'").n,
      users: one('SELECT COUNT(*) AS n FROM users').n,
      pendingDanmu: one("SELECT COUNT(*) AS n FROM danmus WHERE status = 'pending'").n,
      pendingComments: one("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").n,
      queue: queueState(),
      commerce: commerceStats(),
      mailReady: !isDevMail(),
      pay: (() => {
        const pay = getSetting('pay', {})
        return { alipay: Boolean(pay.alipay?.enabled), usdt: Boolean(pay.usdt?.enabled), mock: Boolean(pay.mock?.enabled) }
      })(),
    })
  }

  /* ---------- 剧集 ---------- */
  if (seg[0] === 'dramas' && seg.length === 1 && method === 'GET') {
    if (!guard(PERM.dramas)) return deny(PERM.dramas)
    const keyword = url.searchParams.get('keyword')
    const rows = keyword
      ? all('SELECT * FROM dramas WHERE title LIKE ? ORDER BY id DESC', `%${keyword}%`)
      : all('SELECT * FROM dramas ORDER BY id DESC')
    return send(res, {
      list: rows.map((drama) => ({
        ...drama,
        episodeCount: one('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ?', drama.id).n,
        policy: policyOf(drama.id) ?? null,
      })),
    })
  }

  if (seg[0] === 'dramas' && seg[1] && seg.length === 2 && method === 'GET') {
    if (!guard(PERM.dramas)) return deny(PERM.dramas)
    const drama = one('SELECT * FROM dramas WHERE id = ?', Number(seg[1]))
    if (!drama) return send(res, {}, '0404', '剧集不存在', 404)
    return send(res, {
      drama: { ...drama, tags: tagsOfDrama(drama.id).map((tag) => ({ id: tag.id, name: tag.name })) },
      policy: policyOf(drama.id) ?? null,
      episodes: all('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no', drama.id),
    })
  }

  if (seg[0] === 'dramas' && seg.length === 1 && method === 'POST') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    const info = run(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, score, status, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    body.title ?? '未命名', body.subTitle ?? '', body.coverUrl ?? '', body.description ?? '',
    Number(body.year ?? 2026), body.area ?? '', body.category ?? 'TV', Number(body.score ?? 8), body.status ?? 'draft', Number(body.sort ?? 0))
    const dramaId = Number(info.lastInsertRowid)
    run(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, dramaId, body.accessMode ?? 'subscription', Number(body.freeEpisodes ?? 1),
    Number(body.trialSeconds ?? 0), Number(body.singlePrice ?? 0), body.purchaseKind ?? 'single', Number(body.rentalHours ?? 72))
    log('content.drama.create', 'drama', dramaId, null, body)
    return send(res, one('SELECT * FROM dramas WHERE id = ?', dramaId))
  }

  if (seg[0] === 'dramas' && seg[1] && seg.length === 2 && method === 'PUT') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    const dramaId = Number(seg[1])
    const before = one('SELECT * FROM dramas WHERE id = ?', dramaId)
    if (!before) return send(res, {}, '0404', '剧集不存在', 404)
    run(`UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?, category = ?, score = ?, status = ?, sort = ?
      WHERE id = ?`,
    body.title ?? before.title, body.subTitle ?? before.sub_title, body.coverUrl ?? before.cover_url,
    body.description ?? before.description, Number(body.year ?? before.year), body.area ?? before.area,
    body.category ?? before.category, Number(body.score ?? before.score), body.status ?? before.status,
    Number(body.sort ?? before.sort), dramaId)
    log('content.drama.update', 'drama', dramaId, before, body)
    return send(res, one('SELECT * FROM dramas WHERE id = ?', dramaId))
  }

  if (seg[0] === 'dramas' && seg[1] && seg.length === 2 && method === 'DELETE') {
    if (!guard(PERM.dramaDelete)) return deny(PERM.dramaDelete)
    const dramaId = Number(seg[1])
    const before = one('SELECT * FROM dramas WHERE id = ?', dramaId)
    if (!before) return send(res, {}, '0404', '剧集不存在', 404)
    if (!body.reason) return send(res, {}, '0400', '删除需填写原因', 400)
    run('DELETE FROM dramas WHERE id = ?', dramaId)
    log('content.drama.delete', 'drama', dramaId, before, null, body.reason)
    return send(res, { deleted: true })
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'publish' && method === 'POST') {
    if (!guard(PERM.dramaPublish)) return deny(PERM.dramaPublish)
    const dramaId = Number(seg[1])
    const before = one('SELECT status FROM dramas WHERE id = ?', dramaId)
    const status = body.status === 'published' ? 'published' : 'draft'
    run('UPDATE dramas SET status = ? WHERE id = ?', status, dramaId)
    log('content.drama.publish', 'drama', dramaId, before, { status }, body.reason)
    return send(res, { status })
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'episodes' && method === 'GET') {
    if (!guard(PERM.episodes)) return deny(PERM.episodes)
    return send(res, { list: all('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no', Number(seg[1])) })
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'episodes' && method === 'POST') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    const dramaId = Number(seg[1])
    const nextNo = Number(one('SELECT COALESCE(MAX(no),0) + 1 AS n FROM episodes WHERE drama_id = ?', dramaId).n)
    const info = run("INSERT INTO episodes (drama_id, no, title, status) VALUES (?, ?, ?, 'ready')",
      dramaId, Number(body.no ?? nextNo), body.title ?? `第 ${nextNo} 集`)
    log('content.episode.create', 'episode', Number(info.lastInsertRowid), null, { dramaId, no: body.no ?? nextNo })
    return send(res, one('SELECT * FROM episodes WHERE id = ?', Number(info.lastInsertRowid)))
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'policy' && method === 'GET') {
    if (!guard(PERM.dramas)) return deny(PERM.dramas)
    return send(res, policyOf(Number(seg[1])) ?? {})
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'policy' && method === 'PUT') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const dramaId = Number(seg[1])
    const before = policyOf(dramaId)
    run(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(drama_id) DO UPDATE SET access_mode = excluded.access_mode, free_episodes = excluded.free_episodes,
        trial_seconds = excluded.trial_seconds, single_price_cny = excluded.single_price_cny,
        purchase_kind = excluded.purchase_kind, rental_hours = excluded.rental_hours, updated_at = datetime('now')`,
    dramaId, body.accessMode ?? 'subscription', Number(body.freeEpisodes ?? 0), Number(body.trialSeconds ?? 0),
    Number(body.singlePrice ?? 0), body.purchaseKind ?? 'single', Number(body.rentalHours ?? 72))
    log('content.policy.update', 'drama', dramaId, before, body)
    return send(res, policyOf(dramaId))
  }

  if (seg[0] === 'episodes' && seg[1] && method === 'DELETE') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    const before = one('SELECT * FROM episodes WHERE id = ?', Number(seg[1]))
    run('DELETE FROM episodes WHERE id = ?', Number(seg[1]))
    log('content.episode.delete', 'episode', seg[1], before, null, body.reason)
    return send(res, { deleted: true })
  }

  if (seg[0] === 'episodes' && seg[1] && seg[2] === 'upload' && method === 'POST') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    const episode = one('SELECT * FROM episodes WHERE id = ?', Number(seg[1]))
    if (!episode) return send(res, {}, '0404', '分集不存在', 404)
    if (!opts.uploadPath) return send(res, {}, '0400', '未收到上传文件', 400)
    const info = await probe(opts.uploadPath)
    run('UPDATE episodes SET duration = ?, source_path = ? WHERE id = ?', info?.duration ?? 0, opts.uploadPath, episode.id)
    enqueueEpisode({ ...episode, source_path: opts.uploadPath, duration: info?.duration ?? 0 })
    log('content.episode.upload', 'episode', episode.id, null, { size: opts.uploadSize, probe: info })
    return send(res, { ok: true, probe: info, queue: queueState() })
  }

  if (seg[0] === 'episodes' && seg[1] && seg[2] === 'sample' && method === 'POST') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    const episode = one('SELECT * FROM episodes WHERE id = ?', Number(seg[1]))
    if (!episode) return send(res, {}, '0404', '分集不存在', 404)
    const file = await generateSample(Number(body.seconds ?? 20), `ep-${episode.id}`)
    const info = await probe(file)
    run('UPDATE episodes SET duration = ?, source_path = ? WHERE id = ?', info?.duration ?? 0, file, episode.id)
    enqueueEpisode({ ...episode, source_path: file, duration: info?.duration ?? 0 })
    log('content.episode.sample', 'episode', episode.id, null, { file })
    return send(res, { ok: true, source: file, probe: info, queue: queueState() })
  }

  if (pathname === '/admin/api/jobs' && method === 'GET') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    return send(res, queueState())
  }

  /* ---------- 套餐 ---------- */
  if (seg[0] === 'plans' && method === 'GET') {
    if (!guard(PERM.plans)) return deny(PERM.plans)
    return send(res, { list: all('SELECT * FROM plans ORDER BY sort, id') })
  }
  if (seg[0] === 'plans' && method === 'POST') {
    if (!guard(PERM.plans)) return deny(PERM.plans)
    const info = run('INSERT INTO plans (code, name, price_cny, duration_days, scope, description, sort, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      body.code ?? `plan-${Date.now()}`, body.name ?? '新套餐', Number(body.price ?? 0), Number(body.days ?? 30),
      body.scope ?? 'all', body.description ?? '', Number(body.sort ?? 0), body.status ?? 'active')
    log('commerce.plan.create', 'plan', Number(info.lastInsertRowid), null, body)
    return send(res, one('SELECT * FROM plans WHERE id = ?', Number(info.lastInsertRowid)))
  }
  if (seg[0] === 'plans' && seg[1] && method === 'PUT') {
    if (!guard(PERM.plans)) return deny(PERM.plans)
    const before = one('SELECT * FROM plans WHERE id = ?', Number(seg[1]))
    if (!before) return send(res, {}, '0404', '套餐不存在', 404)
    run('UPDATE plans SET name = ?, price_cny = ?, duration_days = ?, scope = ?, description = ?, sort = ?, status = ? WHERE id = ?',
      body.name ?? before.name, Number(body.price ?? before.price_cny), Number(body.days ?? before.duration_days),
      body.scope ?? before.scope, body.description ?? before.description, Number(body.sort ?? before.sort),
      body.status ?? before.status, Number(seg[1]))
    log('commerce.plan.update', 'plan', seg[1], before, body)
    return send(res, one('SELECT * FROM plans WHERE id = ?', Number(seg[1])))
  }

  /* ---------- 优惠券 ---------- */
  if (seg[0] === 'coupons' && method === 'GET') {
    if (!guard(PERM.coupons)) return deny(PERM.coupons)
    return send(res, { list: all('SELECT * FROM coupons ORDER BY id DESC') })
  }
  if (seg[0] === 'coupons' && method === 'POST') {
    if (!guard(PERM.coupons)) return deny(PERM.coupons)
    const info = run(`INSERT INTO coupons (code, name, discount_type, discount_value, min_amount, total, valid_from, valid_to, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    String(body.code ?? '').toUpperCase(), body.name ?? '优惠券', body.discountType ?? 'amount',
    Number(body.discountValue ?? 0), Number(body.minAmount ?? 0), Number(body.total ?? 0),
    body.validFrom ?? null, body.validTo ?? null, body.status ?? 'active')
    log('commerce.coupon.create', 'coupon', Number(info.lastInsertRowid), null, body)
    return send(res, one('SELECT * FROM coupons WHERE id = ?', Number(info.lastInsertRowid)))
  }
  if (seg[0] === 'coupons' && seg[1] && method === 'PUT') {
    if (!guard(PERM.coupons)) return deny(PERM.coupons)
    const before = one('SELECT * FROM coupons WHERE id = ?', Number(seg[1]))
    if (!before) return send(res, {}, '0404', '优惠券不存在', 404)
    run('UPDATE coupons SET status = ?, valid_to = ?, total = ? WHERE id = ?',
      body.status ?? before.status, body.validTo ?? before.valid_to, Number(body.total ?? before.total), Number(seg[1]))
    log('commerce.coupon.update', 'coupon', seg[1], before, body)
    return send(res, one('SELECT * FROM coupons WHERE id = ?', Number(seg[1])))
  }

  /* ---------- 订单 / 退款 / 对账 ---------- */
  if (pathname === '/admin/api/orders' && method === 'GET') {
    if (!guard(PERM.orders)) return deny(PERM.orders)
    return send(res, { list: listOrders({ status: url.searchParams.get('status') ?? undefined, limit: Number(url.searchParams.get('limit') ?? 100) }) })
  }

  if (pathname === '/admin/api/refunds' && method === 'GET') {
    if (!guard(PERM.orders)) return deny(PERM.orders)
    return send(res, { list: all(`SELECT r.*, o.out_trade_no, o.amount_cny, o.channel, u.nickname
      FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN users u ON u.id = o.user_id ORDER BY r.id DESC LIMIT 100`) })
  }

  if (pathname === '/admin/api/refunds' && method === 'POST') {
    if (!guard(PERM.refundCreate)) return deny(PERM.refundCreate)
    if (!body.reason) return send(res, {}, '0400', '退款原因必填', 400)
    const refund = createRefund({ orderId: Number(body.orderId), amount: body.amount, reason: body.reason, operatorId: principal.admin.id })
    log('finance.refund.create', 'refund', refund.id, null, refund, body.reason)
    return send(res, refund)
  }

  if (seg[0] === 'refunds' && seg[1] && (seg[2] === 'approve' || seg[2] === 'reject') && method === 'POST') {
    if (!guard(PERM.refundApprove)) return deny(PERM.refundApprove)
    if (seg[2] === 'approve') {
      const result = approveRefund({ refundId: Number(seg[1]), approverId: principal.admin.id })
      log('finance.refund.approve', 'refund', seg[1], null, result, body.reason)
      return send(res, result)
    }
    const result = rejectRefund({ refundId: Number(seg[1]), approverId: principal.admin.id, reason: body.reason })
    log('finance.refund.reject', 'refund', seg[1], null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/reconcile' && method === 'POST') {
    if (!guard(PERM.reconcile)) return deny(PERM.reconcile)
    const result = reconcile()
    log('finance.reconcile.run', 'reconcile', null, null, result)
    return send(res, result)
  }

  if (pathname === '/admin/api/close-expired' && method === 'POST') {
    if (!guard(PERM.orders)) return deny(PERM.orders)
    const closed = closeExpiredOrders()
    log('finance.order.closeExpired', 'order', null, null, { closed })
    return send(res, { closed })
  }

  /* ---------- 运营位 ---------- */
  if (seg[0] === 'banners' && method === 'GET') {
    if (!guard(PERM.banners)) return deny(PERM.banners)
    return send(res, { list: all('SELECT b.*, d.title AS drama_title FROM banners b LEFT JOIN dramas d ON d.id = b.target_drama_id ORDER BY b.sort') })
  }
  if (seg[0] === 'banners' && method === 'POST') {
    if (!guard(PERM.banners)) return deny(PERM.banners)
    const info = run('INSERT INTO banners (name, title, image, target_drama_id, sort, enabled) VALUES (?, ?, ?, ?, ?, ?)',
      body.name ?? '', body.title ?? '', body.image ?? '', Number(body.targetDramaId ?? 0) || null, Number(body.sort ?? 0), body.enabled === false ? 0 : 1)
    log('ops.banner.create', 'banner', Number(info.lastInsertRowid), null, body)
    return send(res, { id: Number(info.lastInsertRowid) })
  }
  if (seg[0] === 'banners' && seg[1] && method === 'PUT') {
    if (!guard(PERM.banners)) return deny(PERM.banners)
    const before = one('SELECT * FROM banners WHERE id = ?', Number(seg[1]))
    run('UPDATE banners SET name = ?, title = ?, image = ?, target_drama_id = ?, sort = ?, enabled = ? WHERE id = ?',
      body.name ?? before.name, body.title ?? before.title, body.image ?? before.image,
      Number(body.targetDramaId ?? before.target_drama_id) || null, Number(body.sort ?? before.sort),
      body.enabled === undefined ? before.enabled : (body.enabled ? 1 : 0), Number(seg[1]))
    log('ops.banner.update', 'banner', seg[1], before, body)
    return send(res, { ok: true })
  }
  if (seg[0] === 'banners' && seg[1] && method === 'DELETE') {
    if (!guard(PERM.banners)) return deny(PERM.banners)
    const before = one('SELECT * FROM banners WHERE id = ?', Number(seg[1]))
    run('DELETE FROM banners WHERE id = ?', Number(seg[1]))
    log('ops.banner.delete', 'banner', seg[1], before, null, body.reason)
    return send(res, { deleted: true })
  }

  if (seg[0] === 'sections' && method === 'GET') {
    if (!guard(PERM.sections)) return deny(PERM.sections)
    return send(res, {
      list: all('SELECT * FROM sections ORDER BY sort').map((section) => ({
        ...section,
        items: all(`SELECT si.id, si.drama_id, si.sort, d.title FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? ORDER BY si.sort`, section.id),
      })),
    })
  }
  if (seg[0] === 'sections' && method === 'POST') {
    if (!guard(PERM.sections)) return deny(PERM.sections)
    if (body.action === 'attach') {
      run('INSERT INTO section_items (section_id, drama_id, sort) VALUES (?, ?, ?)',
        Number(body.sectionId), Number(body.dramaId), Number(body.sort ?? 0))
      log('ops.section.attach', 'section', body.sectionId, null, body)
      return send(res, { ok: true })
    }
    const info = run('INSERT INTO sections (title, sort, enabled) VALUES (?, ?, 1)', body.title ?? '新楼层', Number(body.sort ?? 0))
    log('ops.section.create', 'section', Number(info.lastInsertRowid), null, body)
    return send(res, { id: Number(info.lastInsertRowid) })
  }
  if (seg[0] === 'sections' && seg[1] && method === 'DELETE') {
    if (!guard(PERM.sections)) return deny(PERM.sections)
    run('DELETE FROM sections WHERE id = ?', Number(seg[1]))
    log('ops.section.delete', 'section', seg[1], null, null, body.reason)
    return send(res, { deleted: true })
  }

  if (seg[0] === 'ranks' && method === 'GET') {
    if (!guard(PERM.ranks)) return deny(PERM.ranks)
    return send(res, {
      list: all('SELECT * FROM rank_lists ORDER BY sort').map((list) => ({
        ...list,
        items: all('SELECT ri.*, d.title FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id WHERE ri.list_id = ? ORDER BY ri.rank_no', list.id),
      })),
    })
  }
  if (seg[0] === 'ranks' && method === 'POST') {
    if (!guard(PERM.ranks)) return deny(PERM.ranks)
    if (body.action === 'attach') {
      run('INSERT INTO rank_items (list_id, drama_id, rank_no) VALUES (?, ?, ?)',
        Number(body.listId), Number(body.dramaId), Number(body.rankNo ?? 0))
      log('ops.rank.attach', 'rank', body.listId, null, body)
      return send(res, { ok: true })
    }
    const info = run('INSERT INTO rank_lists (name, type, sort) VALUES (?, ?, ?)', body.name ?? '新榜单', body.type ?? 'HOT', Number(body.sort ?? 0))
    log('ops.rank.create', 'rank', Number(info.lastInsertRowid), null, body)
    return send(res, { id: Number(info.lastInsertRowid) })
  }

  /* ---------- 审核 ---------- */
  if (seg[0] === 'danmus' && method === 'GET') {
    if (!guard(PERM.review)) return deny(PERM.review)
    return send(res, { list: all(`SELECT dm.*, d.title FROM danmus dm JOIN episodes e ON e.id = dm.episode_id
      JOIN dramas d ON d.id = e.drama_id WHERE dm.status = ? ORDER BY dm.id DESC LIMIT 100`, url.searchParams.get('status') ?? 'pending') })
  }
  if (seg[0] === 'danmus' && seg[1] && method === 'POST') {
    if (!guard(PERM.review)) return deny(PERM.review)
    const status = seg[2] === 'approve' ? 'approved' : 'rejected'
    run('UPDATE danmus SET status = ? WHERE id = ?', status, Number(seg[1]))
    log('content.danmu.review', 'danmu', seg[1], null, { status })
    return send(res, { status })
  }
  if (seg[0] === 'comments' && method === 'GET') {
    if (!guard(PERM.review)) return deny(PERM.review)
    return send(res, { list: all(`SELECT c.*, d.title FROM comments c JOIN dramas d ON d.id = c.drama_id
      WHERE c.status = ? ORDER BY c.id DESC LIMIT 100`, url.searchParams.get('status') ?? 'pending') })
  }
  if (seg[0] === 'comments' && seg[1] && method === 'POST') {
    if (!guard(PERM.review)) return deny(PERM.review)
    const status = seg[2] === 'approve' ? 'approved' : 'rejected'
    run('UPDATE comments SET status = ? WHERE id = ?', status, Number(seg[1]))
    log('content.comment.review', 'comment', seg[1], null, { status })
    return send(res, { status })
  }

  /* ---------- 用户 / 客服 ---------- */
  if (pathname === '/admin/api/users' && method === 'GET') {
    if (!guard(PERM.users)) return deny(PERM.users)
    return send(res, {
      list: all(`SELECT u.*,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
        (SELECT COALESCE(SUM(amount_cny),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','fulfilled')) AS paid_total,
        (SELECT datetime(valid_to) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' ORDER BY datetime(valid_to) DESC LIMIT 1) AS vip_until
        FROM users u ORDER BY u.id DESC LIMIT 200`),
    })
  }
  if (seg[0] === 'users' && seg[1] && seg[2] === 'status' && method === 'POST') {
    if (!guard(PERM.userManage)) return deny(PERM.userManage)
    run('UPDATE users SET status = ? WHERE id = ?', body.status === 'banned' ? 'banned' : 'active', Number(seg[1]))
    log('user.status.update', 'user', seg[1], null, { status: body.status }, body.reason)
    return send(res, { ok: true })
  }
  if (pathname === '/admin/api/cs/grant' && method === 'POST') {
    if (!guard(PERM.cs)) return deny(PERM.cs)
    const userId = Number(body.userId)
    if (!userId) return send(res, {}, '0400', 'userId 必填', 400)
    if (body.kind === 'subscription') {
      const plan = one('SELECT * FROM plans WHERE id = ?', Number(body.planId))
      if (!plan) return send(res, {}, '0404', '套餐不存在', 404)
      const validTo = new Date(Date.now() + Number(body.days ?? plan.duration_days) * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
      run(`INSERT INTO subscriptions (user_id, plan_id, order_id, scope, valid_to, status) VALUES (?, ?, NULL, ?, ?, 'active')`,
        userId, plan.id, plan.scope ?? 'all', validTo)
    } else {
      run(`INSERT INTO purchases (user_id, drama_id, order_id, kind, status) VALUES (?, ?, NULL, 'single', 'active')`,
        userId, Number(body.dramaId))
    }
    log('cs.grant.entitlement', 'user', userId, null, body, body.reason)
    return send(res, { ok: true })
  }

  /* ---------- RBAC ---------- */
  if (pathname === '/admin/api/menus' && method === 'GET') {
    if (!guard(PERM.roles)) return deny(PERM.roles)
    return send(res, { tree: menuTree(), flat: listPermissionCatalog() })
  }

  if (seg[0] === 'roles' && seg[1] && seg[2] === 'menus' && method === 'GET') {
    if (!guard(PERM.roles)) return deny(PERM.roles)
    return send(res, roleMenuBinding(seg[1]))
  }

  if (seg[0] === 'roles' && seg[1] && seg[2] === 'menus' && method === 'PUT') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const before = roleMenuBinding(seg[1]).checked
    const updated = updateRoleMenus(seg[1], body.codes ?? body.permissions ?? [])
    log('admin.role.menus', 'role', seg[1], before, updated)
    return send(res, updated)
  }

  if (pathname === '/admin/api/roles' && method === 'GET') {
    if (!guard(PERM.roles)) return deny(PERM.roles)
    return send(res, { roles: listRoles(), permissions: listPermissionCatalog() })
  }
  if (seg[0] === 'roles' && seg[1] && method === 'PUT') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const before = listRoles().find((role) => role.id === Number(seg[1]))
    const updated = updateRolePermissions(Number(seg[1]), body.permissions ?? [])
    log('admin.role.update', 'role', seg[1], before, updated)
    return send(res, updated)
  }
  if (pathname === '/admin/api/admins' && method === 'GET') {
    if (!guard(PERM.roles)) return deny(PERM.roles)
    return send(res, { list: listAdmins() })
  }
  if (seg[0] === 'admins' && seg[1] && seg[2] === 'roles' && method === 'PUT') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const updated = setAdminRoles(Number(seg[1]), body.roles ?? [])
    log('admin.roles.update', 'admin', seg[1], null, body)
    return send(res, updated)
  }
  if (pathname === '/admin/api/audit' && method === 'GET') {
    if (!guard(PERM.audit)) return deny(PERM.audit)
    return send(res, { list: listAudit({ limit: Number(url.searchParams.get('limit') ?? 100), action: url.searchParams.get('action') ?? undefined }) })
  }

  /* ---------- 支付配置 ---------- */
  /* ---------- 支付渠道 ---------- */
  if (pathname === '/admin/api/pay-channels' && method === 'GET') {
    if (!guard(PERM.payChannelRead)) return deny(PERM.payChannelRead)
    return send(res, {
      list: listChannels(),
      options: paymentOptions('all'),
      keyVersion: (await import('./secretbox.mjs')).currentKeyVersion(),
      keyVersions: (await import('./secretbox.mjs')).keyVersions(),
    })
  }

  if (pathname === '/admin/api/pay-channels' && method === 'POST') {
    if (!guard(PERM.payChannelWrite)) return deny(PERM.payChannelWrite)
    const channel = upsertChannel(body)
    log('payment.channel.create', 'pay_channel', channel.id, null, { ...body, config: Object.keys(body.config ?? {}) })
    return send(res, { id: channel.id })
  }

  if (seg[0] === 'pay-channels' && seg[1] && seg.length === 2 && method === 'PUT') {
    if (!guard(PERM.payChannelWrite)) return deny(PERM.payChannelWrite)
    const channel = upsertChannel(body, Number(seg[1]))
    log('payment.channel.update', 'pay_channel', seg[1], null, { ...body, config: Object.keys(body.config ?? {}) })
    return send(res, { id: channel.id })
  }

  if (seg[0] === 'pay-channels' && seg[1] && seg[2] === 'status' && method === 'POST') {
    if (!guard(PERM.payChannelWrite)) return deny(PERM.payChannelWrite)
    const channel = setChannelStatus({ channelId: seg[1], status: body.status })
    log('payment.channel.status', 'pay_channel', seg[1], null, { status: channel.status }, body.reason)
    return send(res, { status: channel.status })
  }

  if (seg[0] === 'pay-channels' && seg[1] && seg[2] === 'default' && method === 'POST') {
    if (!guard(PERM.payChannelWrite)) return deny(PERM.payChannelWrite)
    const channel = setDefaultChannel({ channelId: seg[1] })
    log('payment.channel.setDefault', 'pay_channel', seg[1], null, { scene: channel.scene }, body.reason)
    return send(res, { id: channel.id, scene: channel.scene, isDefault: true })
  }

  if (seg[0] === 'pay-channels' && seg[1] && seg[2] === 'test' && method === 'POST') {
    if (!guard(PERM.payChannelRead)) return deny(PERM.payChannelRead)
    const result = testChannel({ channelId: seg[1] })
    log('payment.channel.test', 'pay_channel', seg[1], null, result)
    return send(res, result)
  }

  if (seg[0] === 'pay-channels' && seg[1] && seg.length === 2 && method === 'DELETE') {
    if (!guard(PERM.payChannelWrite)) return deny(PERM.payChannelWrite)
    const result = deleteChannel({ channelId: seg[1] })
    log('payment.channel.delete', 'pay_channel', seg[1], null, null, body.reason)
    return send(res, result)
  }

  /* ---------------- 邮件通道（厂家无关，可多条按优先级回退） ---------------- */
  if (pathname === '/admin/api/email-channels' && method === 'GET') {
    if (!guard(PERM.emailRead)) return deny(PERM.emailRead)
    const settings = emailSettings()
    return send(res, {
      channels: channelList(),
      presets: PRESETS,
      from: settings.from ?? '',
      fromName: settings.fromName ?? '影巢',
      devMode: isDevMail(),
    })
  }

  if (pathname === '/admin/api/email-channels' && method === 'POST') {
    if (!guard(PERM.emailWrite)) return deny(PERM.emailWrite)
    const channel = upsertMailChannel(body ?? {})
    log('admin.email.channel.save', 'email_channel', channel.id, null, { type: channel.type, name: channel.name })
    return send(res, { ok: true, channel: channelList().find((item) => item.id === channel.id) })
  }

  if (pathname.startsWith('/admin/api/email-channels/') && method === 'DELETE') {
    if (!guard(PERM.emailWrite)) return deny(PERM.emailWrite)
    removeChannel(pathname.split('/').pop())
    log('admin.email.channel.remove', 'email_channel', pathname.split('/').pop(), null, null)
    return send(res, { ok: true })
  }

  if (pathname === '/admin/api/email-settings' && method === 'PUT') {
    if (!guard(PERM.emailWrite)) return deny(PERM.emailWrite)
    const settings = saveEmailSettings({ from: String(body?.from ?? '').trim(), fromName: String(body?.fromName ?? '').trim() })
    return send(res, { ok: true, from: settings.from, fromName: settings.fromName })
  }

  if (/^\/admin\/api\/email-channels\/[\w-]+\/test$/.test(pathname) && method === 'POST') {
    if (!guard(PERM.emailRead)) return deny(PERM.emailRead)
    const id = pathname.split('/')[4]
    const channel = channelList().find((item) => item.id === id)
    if (!channel) return send(res, {}, '0404', '通道不存在', 404)
    const to = String(body?.to ?? channel.from ?? '').trim()
    if (!to) return send(res, {}, '0400', '请填写收件邮箱', 400)
    try {
      const result = await verifyChannel(id, { sendTo: to })
      if (result.ok === false) {
        markTest(id, { ok: false, message: result.error ?? '连接失败' })
        log('admin.email.channel.test', 'email_channel', id, null, { to, ok: false, error: result.error })
        return send(res, { ...result }, '0502', result.error ?? '连接失败', 502)
      }
      markTest(id, { ok: true, message: result.note ?? '测试邮件已发送' })
      log('admin.email.channel.test', 'email_channel', id, null, { to, ok: true })
      return send(res, { ...result, to, channel: channel.name })
    } catch (error) {
      markTest(id, { ok: false, message: error.message })
      log('admin.email.channel.test', 'email_channel', id, null, { to, ok: false, error: error.message })
      return send(res, { error: error.message }, '0502', error.message, 502)
    }
  }

  if (/^\/admin\/api\/email-channels\/[\w-]+\/oauth\/start$/.test(pathname) && method === 'POST') {
    if (!guard(PERM.emailWrite)) return deny(PERM.emailWrite)
    const id = pathname.split('/')[4]
    const channel = emailSettings().channels.find((item) => item.id === id)
    if (!channel) return send(res, {}, '0404', '通道不存在', 404)
    try {
      const started = await startDeviceFlow({
        deviceUrl: channel.oauth2?.deviceUrl,
        clientId: channel.oauth2?.clientId,
        scope: channel.oauth2?.scope,
      })
      return send(res, started)
    } catch (error) {
      return send(res, { error: error.message }, '0502', error.message, 502)
    }
  }

  if (/^\/admin\/api\/email-channels\/[\w-]+\/oauth\/poll$/.test(pathname) && method === 'POST') {
    if (!guard(PERM.emailWrite)) return deny(PERM.emailWrite)
    const id = pathname.split('/')[4]
    const channel = emailSettings().channels.find((item) => item.id === id)
    if (!channel) return send(res, {}, '0404', '通道不存在', 404)
    try {
      const result = await pollDeviceFlow({
        tokenUrl: channel.oauth2?.tokenUrl,
        clientId: channel.oauth2?.clientId,
        deviceCode: String(body?.deviceCode ?? ''),
        scope: channel.oauth2?.scope,
      })
      if (!result.done) {
        if (result.pending) return send(res, { pending: true, error: result.error })
        return send(res, { pending: false, error: result.error, description: result.description }, '0400', result.description || result.error || '授权失败', 400)
      }
      upsertMailChannel({ id, oauth2: { refreshToken: result.refreshToken, account: result.account }, from: channel.from || result.account, enabled: true })
      log('admin.email.channel.oauth', 'email_channel', id, null, { account: result.account })
      return send(res, { ok: true, account: result.account })
    } catch (error) {
      return send(res, { error: error.message }, '0502', error.message, 502)
    }
  }

  /* ---------------- 经营数据（播放/用户/订单/订阅多维） ---------------- */
  if (pathname === '/admin/api/analytics' && method === 'GET') {
    if (!guard(PERM.analytics)) return deny(PERM.analytics)
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)))
    return send(res, analyticsReport({ days }))
  }

  /* ---------------- 风控 / 安全事件 ---------------- */
  if (pathname === '/admin/api/security' && method === 'GET') {
    if (!guard(PERM.audit)) return deny(PERM.audit)
    const events = all("SELECT * FROM security_events ORDER BY id DESC LIMIT ?", Math.min(200, Number(url.searchParams.get('limit') ?? 50)))
    return send(res, { ...guardStats(), events })
  }

  /* ---------------- 标签管理 ---------------- */
  if (pathname === '/admin/api/tags' && method === 'GET') {
    if (!guard(PERM.tagRead)) return deny(PERM.tagRead)
    return send(res, { list: listTags({ withCount: true }) })
  }

  if (pathname === '/admin/api/tags' && method === 'POST') {
    if (!guard(PERM.tagWrite)) return deny(PERM.tagWrite)
    const tag = body?.id ? updateTag(body.id, body) : createTag(body ?? {})
    log('admin.tag.save', 'tag', tag.id, null, { name: tag.name })
    return send(res, { tag })
  }

  if (pathname === '/admin/api/tags' && method === 'DELETE') {
    if (!guard(PERM.tagWrite)) return deny(PERM.tagWrite)
    const id = Number(url.searchParams.get('id') ?? 0)
    if (!id) return send(res, {}, '0400', '缺少 id', 400)
    deleteTag(id)
    log('admin.tag.delete', 'tag', id, null, null)
    return send(res, { ok: true })
  }

  if (/^\/admin\/api\/dramas\/\d+\/tags$/.test(pathname) && method === 'POST') {
    if (!guard(PERM.tagWrite)) return deny(PERM.tagWrite)
    const dramaId = Number(pathname.split('/')[4])
    const tags = setDramaTags(dramaId, body?.tagIds ?? [])
    log('admin.drama.tags', 'drama', dramaId, null, { tagIds: tags.map((tag) => tag.id) })
    return send(res, { tags: tags.map((tag) => ({ id: tag.id, name: tag.name })) })
  }

  /* ---------------- 订单：USDT 人工确认到账 / 补单 ---------------- */
  if (/^\/admin\/api\/orders\/\d+\/confirm$/.test(pathname) && method === 'POST') {
    if (!guard(PERM.orderConfirm)) return deny(PERM.orderConfirm)
    const orderId = Number(pathname.split('/')[4])
    const order = one('SELECT * FROM orders WHERE id = ?', orderId)
    if (!order) return send(res, {}, '0404', '订单不存在', 404)
    if (['paid', 'fulfilled'].includes(order.status)) return send(res, { ok: true, already: true })
    try {
      const result = markPaid({
        orderId,
        channel: order.channel,
        channelTxnId: String(body?.txid ?? `manual-${order.id}-${Date.now()}`),
        amount: order.amount_cny,
        raw: { operator: principal.admin.username, note: body?.note ?? '' },
      })
      log('admin.order.confirm', 'order', orderId, { status: order.status }, { status: 'paid', txn: body?.txid ?? 'manual' })
      return send(res, { ok: true, order: result.order })
    } catch (error) {
      return send(res, { error: error.message }, error.code ?? '0400', error.message, error.status ?? 400)
    }
  }

  if (pathname === '/admin/api/pay-settings' && method === 'GET') {
    if (!guard(PERM.paySettings)) return deny(PERM.paySettings)
    const pay = getSetting('pay', {})
    return send(res, {
      pay,
      usdtRate: getSetting('site', {}).usdtRate ?? 7.2,
    })
  }
  if (pathname === '/admin/api/pay-settings' && method === 'PUT') {
    if (!guard(PERM.paySettings)) return deny(PERM.paySettings)
    const before = getSetting('pay', {})
    setSetting('pay', body.pay ?? before)
    if (body.usdtRate) setSetting('site', { ...getSetting('site', {}), usdtRate: Number(body.usdtRate) })
    log('admin.pay.settings', 'settings', 'pay', before, body.pay)
    return send(res, { ok: true })
  }

  return send(res, {}, '0404', '接口不存在', 404)
}




