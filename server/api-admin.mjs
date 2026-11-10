/** 后台接口：RBAC 保护 + 审计 + 内容/付费策略/套餐/优惠券/订单/退款/对账/权限。 */
import { randomBytes } from 'node:crypto'
import { db, genCode, getSetting, setSetting } from './db.mjs'
import { authOf, checkPasswordStrength, hashPassword, issueToken, loginAdmin, revokeSessions, verifyPassword } from './auth.mjs'
import { send } from './api-public.mjs'
import { hasPermission, listAdmins, listAudit, listPermissionCatalog, listRoles, loadPrincipal, menuTree, roleMenuBinding, setAdminRoles, updateRoleMenus } from './rbac.mjs'
import { audit } from './rbac.mjs'
import {
  commerceStats, createRefund, approveRefund, rejectRefund, reconcile, listOrders, closeExpiredOrders, markPaid,
  listChannels, upsertChannel, setChannelStatus, setDefaultChannel, deleteChannel, testChannel, paymentOptions, channelConfig,
} from './commerce.mjs'
import { enqueueEpisode, generateSample, probe, queueState } from './media.mjs'
import { policyOf, rulesOfDrama, setEpisodeRules } from './entitlements.mjs'
import {
  PRESETS, channelList, emailSettings, mailUnavailable, markTest, removeChannel, saveEmailSettings, upsertChannel as upsertMailChannel, verifyChannel,
} from './mail-channels.mjs'
import { pollDeviceFlow, startDeviceFlow } from './mailer-oauth.mjs'
import { analyticsReport } from './analytics.mjs'
import { createTag, deleteTag, listTags, setDramaTags, setTagStatus, tagTree, tagsOfDrama, updateTag } from './tags.mjs'
import { refreshAutoRanks, refreshRank, RANK_STRATEGIES } from './rank.mjs'
import { completenessOf, scrapeTitle } from './scrape.mjs'
import { clearLoginFailures, clientIpOf, guardStats, loginLockSeconds, noteLoginFailure } from './ratelimit.mjs'
import { issueAssistCode } from './otp.mjs'
import { usdtWatchStatus } from './usdt-watch.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const ipOf = (req) => clientIpOf(req)
const safeJson = (text) => { try { return JSON.parse(text) } catch { return null } }

const MISSING_LABEL = {
  title: '标题', category: '内容类型', coverUrl: '封面', year: '年份',
  area: '地区', score: '评分', accessMode: '付费模式',
}
const labelMissing = (keys) => keys.map((key) => MISSING_LABEL[key] ?? key).join('、')

/** 剧集上架前的必填校验：标题 / 内容类型 / 付费模式 / 封面 / 年份 / 地区 / 评分。 */
function dramaCompleteness(row) {
  const policy = row?.id ? policyOf(row.id) : null
  return completenessOf({
    title: row?.title,
    category: row?.category,
    coverUrl: row?.cover_url,
    year: row?.year,
    area: row?.area,
    score: row?.score,
    access: policy ? { mode: policy.access_mode } : null,
  })
}

/** 后台下拉选项与中文标签（前端不再自己维护一套翻译）。 */
export const ADMIN_OPTIONS = {
  categories: [
    { value: 'MOVIE', label: '电影' },
    { value: 'TV', label: '电视剧' },
    { value: 'PLAYLET', label: '短剧 / 漫剧' },
    { value: 'ANIME', label: '动漫' },
    { value: 'VARIETY', label: '综艺' },
    { value: 'DOCUMENTARY', label: '纪录片' },
  ],
  accessModes: [
    { value: 'free', label: '免费' },
    { value: 'subscription', label: '会员免费' },
    { value: 'paid', label: '单独收费' },
  ],
  ruleModes: [
    { value: 'free', label: '免费观看' },
    { value: 'vip', label: '需会员' },
    { value: 'single', label: '需单集购买' },
  ],
  dramaStatus: [
    { value: 'draft', label: '草稿 / 待补全' },
    { value: 'published', label: '已上架' },
    { value: 'offline', label: '已下架' },
  ],
  orderStatus: [
    { value: 'created', label: '待支付' },
    { value: 'pending', label: '支付确认中' },
    { value: 'paid', label: '已支付' },
    { value: 'fulfilled', label: '已完成' },
    { value: 'closed', label: '已关闭' },
    { value: 'failed', label: '支付失败' },
    { value: 'refunded', label: '已退款' },
    { value: 'refunding', label: '退款中' },
    { value: 'refund_pending', label: '退款待审' },
  ],
}
const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 2e6) req.destroy() })
  req.on('end', () => {
    if (!raw) return resolve({})
    try { resolve(JSON.parse(raw)) } catch { resolve({}) }
  })
})

const WEAK_ADMIN_PASSWORDS = new Set(['admin123', 'admin', '12345678', 'password', '123456789', 'qwerty123', 'admin1234'])
const WEAK_ADMIN_PATTERN = /(password|qwerty|asdfgh|123456|654321|888888|abc123|iloveyou|letmein|welcome)/i

/** 后台口令策略：>=8 位，含字母与数字，不得包含用户名，不得是常见弱口令。 */
export function checkAdminPassword(password, username) {
  const value = String(password ?? '')
  if (value.length < 8) return { ok: false, message: '后台密码至少 8 位' }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return { ok: false, message: '后台密码需同时包含字母和数字' }
  if (username && value.toLowerCase().includes(String(username).toLowerCase())) return { ok: false, message: '密码不能包含用户名' }
  if (WEAK_ADMIN_PASSWORDS.has(value.toLowerCase()) || WEAK_ADMIN_PATTERN.test(value)) return { ok: false, message: '该密码过于常见，请更换' }
  if (/^(.)\1+$/.test(value) || /(.)\1{5,}/.test(value) || new Set(value).size < 4) return { ok: false, message: '密码重复字符过多，请更换' }
  return { ok: true }
}

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
  tags: 'tag.read',
  tagRead: 'tag.read',
  tagWrite: 'tag.write',
  events: 'ops.events.read',
  adminAccounts: 'system.admin',
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
  userAssist: 'user.login.assist',
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

/**
 * 上传类接口的前置鉴权：必须在把请求体写进磁盘之前调用，
 * 否则匿名请求也能往 storage/uploads 写 2GB 垃圾文件。
 */
export function preAuthorizeAdmin(req, perm) {
  const auth = authOf(req)
  const principal = auth?.role === 'admin' ? loadPrincipal(Number(auth.sub)) : undefined
  if (!principal) return { ok: false, code: '0401', msg: '需要管理员登录', status: 401 }
  if (principal.admin.must_change_password) {
    return { ok: false, code: '0403', msg: '请先修改初始密码', status: 403, data: { required: 'password_change' } }
  }
  if (perm && !hasPermission(principal, perm)) {
    audit({ actorId: principal.admin.id, actorName: principal.admin.username, action: 'rbac.denied', targetType: 'permission', targetId: perm, ip: clientIpOf(req), result: 'denied' })
    return { ok: false, code: '0403', msg: '无权限执行该操作', status: 403, data: { required: perm } }
  }
  return { ok: true, principal }
}

export async function handleAdmin(pathname, url, req, res, rawBody, opts = {}) {
  const method = req.method
  const body = rawBody !== undefined ? rawBody : (['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {})
  const seg = pathname.replace('/admin/api/', '').split('/').filter(Boolean)

  if (pathname === '/admin/api/login' && method === 'POST') {
    const username = String(body.username ?? '').trim()
    const ip = clientIpOf(req)
    // 先校验口令：口令正确一律放行，锁定只惩罚错误尝试（避免攻击者锁死账号）
    const result = loginAdmin(username, String(body.password ?? ''))
    if (!result) {
      const locked = await loginLockSeconds(username, ip)
      if (locked > 0) {
        audit({ actorType: 'admin', actorName: username, action: 'admin.login.locked', ip, result: 'denied' })
        res.setHeader('retry-after', String(locked))
        return send(res, { retryAfter: locked }, '0429', `登录失败次数过多，请 ${locked} 秒后再试`, 429)
      }
      const left = await noteLoginFailure(username, ip)
      audit({ actorType: 'admin', actorName: username, action: 'admin.login.failed', ip, result: 'denied' })
      return send(res, { attemptsLeft: left }, '0401',
        left > 0 ? `账号或密码错误，还可尝试 ${left} 次` : '账号或密码错误，已锁定 10 分钟', 401)
    }
    await clearLoginFailures(username, ip)
    const principal = loadPrincipal(Number(result.token ? JSON.parse(Buffer.from(result.token.split('.')[0], 'base64url').toString()).sub : 0))
    audit({ actorType: 'admin', actorId: principal?.admin?.id, actorName: principal?.admin?.username, action: 'admin.login', ip: ipOf(req) })
    return send(res, {
      token: result.token, expiresAt: result.expiresAt,
      roles: principal?.roles?.map((role) => role.code) ?? [],
      mustChangePassword: Boolean(principal?.admin?.must_change_password),
    })
  }

  const auth = authOf(req)
  const principal = auth?.role === 'admin' ? loadPrincipal(Number(auth.sub)) : undefined
  if (!principal) return send(res, {}, '0401', '需要管理员登录', 401)

  // 强制改密：未改初始口令前，除「读自己」与「改密」外一律拒绝
  if (principal.admin.must_change_password
    && pathname !== '/admin/api/me'
    && pathname !== '/admin/api/password') {
    return send(res, { required: 'password_change' }, '0403', '请先修改初始密码', 403)
  }

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
      mustChangePassword: Boolean(principal.admin.must_change_password),
    })
  }

  /* ---------- 管理员自助改密（强口令，不启用 2FA） ---------- */
  if (pathname === '/admin/api/password' && method === 'POST') {
    const admin = one('SELECT * FROM admins WHERE id = ?', principal.admin.id)
    if (!verifyPassword(String(body.oldPassword ?? ''), admin.salt, admin.password_hash)) {
      log('admin.password.change', 'admin', admin.id, null, { ok: false, reason: 'old_password_wrong' })
      return send(res, {}, '0401', '当前密码不正确', 401)
    }
    const next = String(body.newPassword ?? '')
    const strength = checkAdminPassword(next, admin.username)
    if (!strength.ok) return send(res, {}, 'password_weak', strength.message, 400)
    if (verifyPassword(next, admin.salt, admin.password_hash)) {
      return send(res, {}, 'password_same', '新密码不能与当前密码相同', 400)
    }
    const salt = randomBytes(8).toString('hex')
    run("UPDATE admins SET password_hash = ?, salt = ?, must_change_password = 0, password_updated_at = datetime('now') WHERE id = ?",
      hashPassword(next, salt), salt, admin.id)
    log('admin.password.change', 'admin', admin.id, null, { ok: true })
    // 改密后吊销该管理员全部旧会话，并下发一枚新 token（当前会话无缝续用）
    revokeSessions(admin.id, 'admin')
    const fresh = issueToken(admin.id, 'admin')
    return send(res, { ok: true, message: '密码已更新，其他设备需重新登录', token: fresh.token, expiresAt: fresh.expiresAt })
  }

  if (pathname === '/admin/api/stats') {
    if (!guard(PERM.stats)) return deny(PERM.stats)
    // 概览只讲"平台资产与内容健康度"：剧集/集数/可播/用户/待审/转码队列/邮件通道。
    // 收款、订阅、退款等经营口径统一放 /admin/api/analytics，避免运营看概览时被营收噪音分散。
    return send(res, {
      dramas: one('SELECT COUNT(*) AS n FROM dramas').n,
      publishedDramas: one("SELECT COUNT(*) AS n FROM dramas WHERE status = 'published'").n,
      draftDramas: one("SELECT COUNT(*) AS n FROM dramas WHERE status <> 'published'").n,
      episodes: one('SELECT COUNT(*) AS n FROM episodes').n,
      readyEpisodes: one("SELECT COUNT(*) AS n FROM episodes WHERE status = 'ready' AND hls_path IS NOT NULL").n,
      tags: one("SELECT COUNT(*) AS n FROM tags WHERE status = 'active'").n,
      users: one('SELECT COUNT(*) AS n FROM users').n,
      activeUsers7d: one("SELECT COUNT(DISTINCT user_id) AS n FROM play_events WHERE created_at >= datetime('now','-7 days')").n,
      pendingDanmu: one("SELECT COUNT(*) AS n FROM danmus WHERE status = 'pending'").n,
      pendingComments: one("SELECT COUNT(*) AS n FROM comments WHERE status = 'pending'").n,
      queue: queueState(),
      mailReady: !mailUnavailable(),
      categories: all(`SELECT category, COUNT(*) AS n FROM dramas GROUP BY category ORDER BY n DESC`)
        .map((row) => ({ ...row, label: ADMIN_OPTIONS.categories.find((item) => item.value === row.category)?.label ?? row.category })),
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
        readyEpisodes: one("SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND status = 'ready' AND hls_path IS NOT NULL", drama.id).n,
        policy: policyOf(drama.id) ?? null,
        completeness: dramaCompleteness(drama),
      })),
      options: ADMIN_OPTIONS,
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
    const title = String(body.title ?? '').trim()
    if (!title) return send(res, {}, '0400', '请先填写剧集标题', 400)
    const wanted = body.status === 'published' ? 'published' : 'draft'
    const info = run(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, score, status, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    title, body.subTitle ?? '', body.coverUrl ?? '', body.description ?? '',
    Number(body.year ?? 0) || 0, body.area ?? '', body.category ?? '', Number(body.score ?? 0) || 0, 'draft', Number(body.sort ?? 0))
    const dramaId = Number(info.lastInsertRowid)
    run(`INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, dramaId, body.accessMode ?? 'subscription', Number(body.freeEpisodes ?? 1),
    Number(body.trialSeconds ?? 0), Number(body.singlePrice ?? 0), body.purchaseKind ?? 'single', Number(body.rentalHours ?? 72))
    if (Array.isArray(body.tagIds) && body.tagIds.length) setDramaTags(dramaId, body.tagIds)
    const created = one('SELECT * FROM dramas WHERE id = ?', dramaId)
    const check = dramaCompleteness(created)
    let statusNote = ''
    if (wanted === 'published') {
      if (check.complete) {
        run("UPDATE dramas SET status = 'published' WHERE id = ?", dramaId)
        statusNote = '已上架'
      } else {
        statusNote = `信息未补全（${labelMissing(check.missing)}），已保存为草稿`
      }
    }
    log('content.drama.create', 'drama', dramaId, null, { title, wanted, missing: check.missing })
    return send(res, { drama: one('SELECT * FROM dramas WHERE id = ?', dramaId), completeness: check, statusNote })
  }

  if (seg[0] === 'dramas' && seg[1] && seg.length === 2 && method === 'PUT') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    const dramaId = Number(seg[1])
    const before = one('SELECT * FROM dramas WHERE id = ?', dramaId)
    if (!before) return send(res, {}, '0404', '剧集不存在', 404)
    const nextStatus = body.status ?? before.status
    // 上架是独立权限 + 必须过资料完整性校验（否则编辑口可以绕过发布口的检查）
    if (nextStatus === 'published' && before.status !== 'published') {
      if (!guard(PERM.dramaPublish)) return deny(PERM.dramaPublish)
      const check = dramaCompleteness({
        ...before,
        title: body.title ?? before.title,
        category: body.category ?? before.category,
        cover_url: body.coverUrl ?? before.cover_url,
        year: Number(body.year ?? before.year),
        area: body.area ?? before.area,
        score: Number(body.score ?? before.score),
      })
      if (!check.complete) {
        return send(res, { completeness: check, fields: Object.keys(check.fields).filter((key) => !check.fields[key]), missing: check.missing },
          '0400', `以下信息未补全，无法上架：${labelMissing(check.missing)}`, 400)
      }
    }
    run(`UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?, category = ?, score = ?, status = ?, sort = ?
      WHERE id = ?`,
    body.title ?? before.title, body.subTitle ?? before.sub_title, body.coverUrl ?? before.cover_url,
    body.description ?? before.description, Number(body.year ?? before.year), body.area ?? before.area,
    body.category ?? before.category, Number(body.score ?? before.score), nextStatus,
    Number(body.sort ?? before.sort), dramaId)
    log('content.drama.update', 'drama', dramaId, before, { ...body, status: nextStatus })
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
    const before = one('SELECT * FROM dramas WHERE id = ?', dramaId)
    if (!before) return send(res, {}, '0404', '剧集不存在', 404)
    const status = body.status === 'published' ? 'published' : 'draft'
    if (status === 'published') {
      const check = dramaCompleteness(before)
      if (!check.complete) {
        return send(res, { missing: check.missing, fields: check.fields }, '0400',
          `以下信息未补全，无法上架：${labelMissing(check.missing)}`, 400)
      }
    }
    run('UPDATE dramas SET status = ? WHERE id = ?', status, dramaId)
    log('content.drama.publish', 'drama', dramaId, { status: before.status }, { status }, body.reason)
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

  /* ---------- 按集定价规则（VIP 免费 + 最后两集单独收费） ---------- */
  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'pricing-rules' && method === 'GET') {
    if (!guard(PERM.dramas)) return deny(PERM.dramas)
    const dramaId = Number(seg[1])
    const policy = policyOf(dramaId) ?? {}
    const episodes = all('SELECT no, title FROM episodes WHERE drama_id = ? ORDER BY no', dramaId)
    return send(res, {
      rules: rulesOfDrama(dramaId),
      episodeCount: episodes.length,
      lastNo: episodes.length ? Number(episodes[episodes.length - 1].no) : 0,
      defaults: {
        accessMode: policy.access_mode ?? 'subscription',
        freeEpisodes: Number(policy.free_episodes ?? 0),
        trialSeconds: Number(policy.trial_seconds ?? 0),
        singlePrice: Number(policy.single_price_cny ?? 0),
      },
    })
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'pricing-rules' && method === 'PUT') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const dramaId = Number(seg[1])
    if (!one('SELECT id FROM dramas WHERE id = ?', dramaId)) return send(res, {}, '0404', '剧集不存在', 404)
    const before = rulesOfDrama(dramaId)
    let rules
    try {
      rules = setEpisodeRules(dramaId, body?.rules ?? [])
    } catch (error) {
      return send(res, {}, '0400', error.message ?? '规则校验失败', 400)
    }
    log('content.pricing.rules', 'drama', dramaId, before, rules)
    return send(res, { rules })
  }

  /* ---------- 自动搜刮 ---------- */
  if (seg[0] === 'scrape' && method === 'GET') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    try {
      return send(res, await scrapeTitle(url.searchParams.get('title') ?? ''))
    } catch (error) {
      return send(res, {}, '0400', error.message ?? '搜刮失败', error.status ?? 400)
    }
  }

  /* ---------- 下拉选项 ---------- */
  if (seg[0] === 'options' && method === 'GET') {
    return send(res, ADMIN_OPTIONS)
  }

  /* ---------- 埋点数据 ---------- */
  if (seg[0] === 'events' && method === 'GET') {
    if (!guard(PERM.events)) return deny(PERM.events)
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)))
    const type = url.searchParams.get('type')
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
    const pageSize = Math.min(100, Math.max(10, Number(url.searchParams.get('pageSize') ?? 20)))
    const since = `-${days} days`
    const where = ["te.created_at >= datetime('now', ?)"]
    const args = [since]
    if (type) { where.push('te.type = ?'); args.push(type) }
    const clause = where.join(' AND ')
    const total = one(`SELECT COUNT(*) AS n FROM track_events te WHERE ${clause}`, ...args).n
    const list = all(`SELECT te.*, d.title AS dramaTitle, u.email AS userEmail
      FROM track_events te
      LEFT JOIN dramas d ON d.id = te.drama_id
      LEFT JOIN users u ON u.id = te.user_id
      WHERE ${clause} ORDER BY te.id DESC LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize)
    return send(res, {
      total, page, pageSize,
      byType: all(`SELECT te.type, COUNT(*) AS n FROM track_events te WHERE ${clause} GROUP BY te.type ORDER BY n DESC`, ...args),
      byDay: all(`SELECT date(te.created_at) AS day, te.type, COUNT(*) AS n FROM track_events te
        WHERE ${clause} GROUP BY day, te.type ORDER BY day DESC`, ...args),
      list: list.map((row) => ({ ...row, meta: row.meta_json ? safeJson(row.meta_json) : null })),
    })
  }

  /* ---------- 榜单刷新 ---------- */
  if (seg[0] === 'ranks' && seg[1] === 'refresh' && method === 'POST') {
    if (!guard(PERM.ranks)) return deny(PERM.ranks)
    const all_ = refreshAutoRanks({ limit: Number(body?.limit ?? 20) })
    log('ops.rank.refresh', 'rank', null, null, all_)
    return send(res, { results: all_, strategies: RANK_STRATEGIES })
  }

  if (seg[0] === 'ranks' && seg[1] && seg[2] === 'refresh' && method === 'POST') {
    if (!guard(PERM.ranks)) return deny(PERM.ranks)
    try {
      const result = refreshRank(Number(seg[1]), { limit: Number(body?.limit ?? 20) })
      log('ops.rank.refresh', 'rank', Number(seg[1]), null, result)
      return send(res, result)
    } catch (error) {
      return send(res, {}, '0400', error.message ?? '刷新失败', error.status ?? 400)
    }
  }

  if (seg[0] === 'ranks' && seg[1] && seg[2] === 'lock' && method === 'POST') {
    if (!guard(PERM.ranks)) return deny(PERM.ranks)
    const listId = Number(seg[1])
    const dramaId = Number(body?.dramaId)
    const locked = body?.locked === false ? 0 : 1
    const row = one('SELECT * FROM rank_items WHERE list_id = ? AND drama_id = ?', listId, dramaId)
    if (!row) return send(res, {}, '0404', '该榜单里没有这部剧', 404)
    run('UPDATE rank_items SET locked = ? WHERE id = ?', locked, row.id)
    log('ops.rank.lock', 'rank', listId, { locked: row.locked }, { locked, dramaId })
    return send(res, { locked: Boolean(locked) })
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
    // 编码由服务端生成（雪花风格纯数字，12 位以上），不接受人工输入，避免重复与英文码。
    const info = run('INSERT INTO plans (code, name, price_cny, duration_days, scope, description, sort, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      genCode(''), body.name ?? '新套餐', Number(body.price ?? 0), Number(body.days ?? 30),
      body.scope ?? 'all', body.description ?? '', Number(body.sort ?? 0), body.status ?? 'active')
    log('commerce.plan.create', 'plan', Number(info.lastInsertRowid), null, { ...body, code: 'auto' })
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
    const explicit = String(body.code ?? '').trim().toUpperCase()
    const code = explicit || genCode('')
    const info = run(`INSERT INTO coupons (code, name, discount_type, discount_value, min_amount, total, valid_from, valid_to, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    code, body.name ?? '优惠券', body.discountType ?? 'amount',
    Number(body.discountValue ?? 0), Number(body.minAmount ?? 0), Number(body.total ?? 0),
    body.validFrom ?? null, body.validTo ?? null, body.status ?? 'active')
    log('commerce.coupon.create', 'coupon', Number(info.lastInsertRowid), null, { ...body, code })
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
    run('DELETE FROM section_items WHERE section_id = ?', Number(seg[1]))
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
      list: all(`SELECT u.id, u.email, u.nickname, u.avatar, u.birthday, u.gender, u.bio,
        u.status, u.email_verified_at, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
        (SELECT COALESCE(SUM(amount_cny),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','fulfilled')) AS paid_total,
        (SELECT datetime(valid_to) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' ORDER BY datetime(valid_to) DESC LIMIT 1) AS vip_until
        FROM users u ORDER BY u.id DESC LIMIT 200`).map((row) => ({ ...row, kind: 'user', kindLabel: 'C 端用户' })),
    })
  }
  if (seg[0] === 'users' && seg[1] && seg[2] === 'status' && method === 'POST') {
    if (!guard(PERM.userManage)) return deny(PERM.userManage)
    const nextStatus = body.status === 'banned' ? 'banned' : 'active'
    run('UPDATE users SET status = ? WHERE id = ?', nextStatus, Number(seg[1]))
    // 封禁必须立刻断掉已发出的 token（7 天有效期内否则继续可用）
    const revoked = nextStatus === 'banned' ? await revokeSessions(Number(seg[1]), 'user') : 0
    log('user.status.update', 'user', seg[1], null, { status: nextStatus, revokedSessions: revoked }, body.reason)
    return send(res, { ok: true, revokedSessions: revoked })
  }
  // 邮件通道异常时的运维兜底：给指定用户签发一次性登录码（明文只返回这一次，写审计）
  if (seg[0] === 'users' && seg[1] && seg[2] === 'login-code' && method === 'POST') {
    if (!guard(PERM.userAssist)) return deny(PERM.userAssist)
    const user = one('SELECT * FROM users WHERE id = ?', Number(seg[1]))
    if (!user) return send(res, {}, '0404', '用户不存在', 404)
    if (!user.email) return send(res, {}, '0400', '该用户未绑定邮箱', 400)
    const result = issueAssistCode(user.email, { operator: principal.admin.username })
    log('user.login.code.issue', 'user', user.id, null, { email: result.email, expiresIn: result.expiresIn }, body.reason)
    return send(res, { ...result, nickname: user.nickname, userId: user.id })
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
    return send(res, {
      list: listAdmins().map((admin) => ({
        ...admin,
        kind: 'admin',
        kindLabel: 'B 端账号',
        lastAuditAt: one('SELECT created_at FROM audit_logs WHERE actor_id = ? ORDER BY id DESC LIMIT 1', admin.id)?.created_at ?? null,
      })),
      users: one('SELECT COUNT(*) AS n FROM users').n,
    })
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
      mailMissing: mailUnavailable(),
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

  /* ---------------- 经营数据（播放 / 用户 / 订单 / 订阅 / 收款） ---------------- */
  if (pathname === '/admin/api/analytics' && method === 'GET') {
    if (!guard(PERM.analytics)) return deny(PERM.analytics)
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7)))
    // 收款/订阅/退款这些经营口径归到这里，概览页不再显示支付数据。
    return send(res, {
      ...analyticsReport({ days }),
      commerce: commerceStats(),
      pay: (() => {
        const pay = getSetting('pay', {})
        return { alipay: Boolean(pay.alipay?.enabled), usdt: Boolean(pay.usdt?.enabled), mock: Boolean(pay.mock?.enabled) }
      })(),
    })
  }

  /* ---------------- 风控 / 安全事件 ---------------- */
  if (pathname === '/admin/api/security' && method === 'GET') {
    if (!guard(PERM.audit)) return deny(PERM.audit)
    const events = all("SELECT * FROM security_events ORDER BY id DESC LIMIT ?", Math.min(200, Number(url.searchParams.get('limit') ?? 50)))
    return send(res, { ...guardStats(), usdtWatch: usdtWatchStatus(), events })
  }

  /* ---------------- 标签管理 ---------------- */
  if (pathname === '/admin/api/tags' && method === 'GET') {
    if (!guard(PERM.tagRead)) return deny(PERM.tagRead)
    const page = url.searchParams.get('page')
    const includeDisabled = url.searchParams.get('includeDisabled') === '1'
    const keyword = url.searchParams.get('keyword') ?? ''
    const level = url.searchParams.get('level') ?? 'all'
    const paged = page ? listTags({ withCount: true, includeDisabled, page: Number(page), pageSize: Number(url.searchParams.get('pageSize') ?? 20), keyword, level }) : null
    const list = paged ? paged.list : listTags({ withCount: true, includeDisabled, keyword, level })
    return send(res, {
      list,
      total: paged ? paged.total : list.length,
      page: paged ? paged.page : 1,
      pageSize: paged ? paged.pageSize : list.length,
      tree: tagTree({ includeDisabled: true, withCount: true }),
    })
  }

  if (pathname === '/admin/api/tags' && method === 'POST') {
    if (!guard(PERM.tagWrite)) return deny(PERM.tagWrite)
    const tag = body?.id ? updateTag(body.id, body) : createTag(body ?? {})
    log('admin.tag.save', 'tag', tag.id, null, { name: tag.name, parentId: tag.parent_id ?? null })
    return send(res, { tag })
  }

  if (/^\/admin\/api\/tags\/\d+\/status$/.test(pathname) && method === 'POST') {
    if (!guard(PERM.tagWrite)) return deny(PERM.tagWrite)
    const id = Number(pathname.split('/')[4])
    const enabled = body?.enabled !== false && body?.status !== 'disabled'
    const tag = setTagStatus(id, enabled)
    log('admin.tag.status', 'tag', id, null, { enabled })
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






