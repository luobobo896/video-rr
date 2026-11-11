/** 后台接口：RBAC 保护 + 审计 + 内容/付费策略/套餐/优惠券/订单/退款/对账/权限。 */
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { db, DEFAULT_ADMIN_MENUS, genCode, getSetting, setSetting } from './db.mjs'
import { adultMenuSettings, saveAdultMenuSettings } from './adult-menu.mjs'
import { authOf, checkPasswordStrength, hashPassword, issueToken, loginAdmin, revokeSessions, revokeToken, setUserPassword, verifyPassword } from './auth.mjs'
import { send } from './api-public.mjs'
import {
  createAdmin, createRole, deleteAdminById, deleteAdminMenu, deleteRole, hasPermission, listAdminMenus, listAdmins, listAudit,
  listPermissionCatalog, listRoles, loadPrincipal, menuTree, resetAdminMenus, roleMenuBinding, saveAdminMenu,
  saveAdminMenuGroup, setAdminPassword, setAdminRoles, updateAdminBasic, updateRole, updateRoleMenus, updateRolePermissions,
} from './rbac.mjs'
import { audit } from './rbac.mjs'
import {
  commerceStats, createRefund, approveRefund, rejectRefund, reconcile, listOrders, countOrders, getOrder, closeExpiredOrders, markPaid,
  listChannels, upsertChannel, setChannelStatus, setDefaultChannel, deleteChannel, testChannel, paymentOptions, channelConfig,
} from './commerce.mjs'
import { enqueueEpisode, generateSample, probe, queueState } from './media.mjs'
import { downloadRemoteVideo } from './media-import.mjs'
import { policyOf, rulesOfDrama, setEpisodeRules } from './entitlements.mjs'
import {
  PRESETS, channelList, emailSettings, mailUnavailable, markTest, removeChannel, saveEmailSettings, sendMail, upsertChannel as upsertMailChannel, verifyChannel,
} from './mail-channels.mjs'
import { pollDeviceFlow, startDeviceFlow } from './mailer-oauth.mjs'
import { analyticsReport } from './analytics.mjs'
import { buildCodeEmail, buildPasswordResetEmail } from './email-template.mjs'
import { logError, logInfo } from './logger.mjs'
import { createTag, deleteTag, listTags, setDramaTags, setTagStatus, tagTree, tagsOfDrama, updateTag } from './tags.mjs'
import { createTrack, deleteTrack, listEpisodeTracks, updateTrack } from './tracks.mjs'
import { refreshAutoRanks, refreshRank, RANK_STRATEGIES } from './rank.mjs'
import {
  analyticsChannelRows, listChannelDomains, listChannels as listAcquisitionChannels, listPromoCodes,
  upsertChannel as upsertAcquisitionChannel, upsertChannelDomain, upsertPromoCode,
} from './attribution.mjs'
import { contentAnalytics, contentRank, rebuildContentStats, refreshContentRanks } from './content-stats.mjs'
import {
  applyRiskAction, createSettlement, distributionAnalytics, distributionDashboard, getDistributionConfig, listCommissionRules,
  listCurrencies, listPayoutMethods,
  pageCommissions, pageRelations, pageSettlements, pageWithdrawals,
  markCommissionsAvailable, reviewSettlement, reviewWithdrawal, setDistributorStatus, teamTree,
  updateDistributionConfig, upsertCommissionRule, upsertCurrency, upsertPayoutMethod,
} from './distribution.mjs'
import { completenessOf, scrapeTitle } from './scrape.mjs'
import { autofillBanners, refreshArtwork } from './artwork.mjs'
import { clearLoginFailures, clientIpOf, guardStats, loginLockSeconds, noteLoginFailure } from './ratelimit.mjs'
import { issueAssistCode } from './otp.mjs'
import { usdtWatchStatus } from './usdt-watch.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)
const dramaDto = (row) => (row ? { ...row, isAdult: Boolean(row.is_adult) } : row)

const ipOf = (req) => clientIpOf(req)
const safeJson = (text) => { try { return JSON.parse(text) } catch { return null } }
const paging = (url, fallbackSize = 20) => {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
  const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get('pageSize') ?? fallbackSize) || fallbackSize))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

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

const POLICY_MODES = new Set(ADMIN_OPTIONS.accessModes.map((item) => item.value))
const DRAMA_STATUSES = new Set(ADMIN_OPTIONS.dramaStatus.map((item) => item.value))

function normalizePolicy(body = {}) {
  const accessMode = POLICY_MODES.has(body.accessMode) ? body.accessMode : 'subscription'
  return {
    accessMode,
    freeEpisodes: Math.max(0, Math.round(Number(body.freeEpisodes ?? 0) || 0)),
    trialSeconds: Math.max(0, Math.round(Number(body.trialSeconds ?? 0) || 0)),
    singlePrice: Math.max(0, Number(body.singlePrice ?? 0) || 0),
    purchaseKind: body.purchaseKind === 'rental' ? 'rental' : 'single',
    rentalHours: Math.max(1, Math.round(Number(body.rentalHours ?? 72) || 72)),
  }
}

function policyFromGroup(group) {
  return {
    accessMode: group.access_mode,
    freeEpisodes: Number(group.free_episodes ?? 0),
    trialSeconds: Number(group.trial_seconds ?? 0),
    singlePrice: Number(group.single_price_cny ?? 0),
    purchaseKind: group.purchase_kind,
    rentalHours: Number(group.rental_hours ?? 72),
  }
}

/** 剧集只保存组 ID；组字段同时写入策略表，供不回表的旧查询继续兼容。 */
function writePolicyGroup(group, clause, args = []) {
  const info = run(`INSERT INTO content_policies
    (drama_id, policy_group_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours, updated_at)
    SELECT id, ?, ?, ?, ?, ?, ?, ?, datetime('now') FROM dramas ${clause}
    ON CONFLICT(drama_id) DO UPDATE SET policy_group_id = excluded.policy_group_id,
      access_mode = excluded.access_mode, free_episodes = excluded.free_episodes,
      trial_seconds = excluded.trial_seconds, single_price_cny = excluded.single_price_cny,
      purchase_kind = excluded.purchase_kind, rental_hours = excluded.rental_hours, updated_at = datetime('now')`,
  group.id, group.access_mode, group.free_episodes, group.trial_seconds, group.single_price_cny,
  group.purchase_kind, group.rental_hours, ...args)
  return Number(info.changes ?? 0)
}

function temporaryPassword(length = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  for (;;) {
    const bytes = randomBytes(length)
    let value = ''
    for (let index = 0; index < length; index += 1) value += alphabet[bytes[index] % alphabet.length]
    if (/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) return value
  }
}

function dramaFilters(input = {}) {
  const keyword = String(input.keyword ?? input.q ?? '').trim()
  const category = String(input.category ?? '').trim()
  const status = String(input.status ?? '').trim()
  const where = []
  const args = []
  if (keyword) {
    where.push('(COALESCE(title, \'\') LIKE ? OR COALESCE(sub_title, \'\') LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (category && category !== 'all') {
    where.push('category = ?')
    args.push(category)
  }
  if (status && status !== 'all' && DRAMA_STATUSES.has(status)) {
    where.push('status = ?')
    args.push(status)
  }
  return { keyword, category, status, clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args }
}
const readBody = (req, limit = 2e6) => new Promise((resolve, reject) => {
  let raw = ''
  let bytes = 0
  let settled = false
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    fn(value)
  }
  req.on('data', (chunk) => {
    bytes += chunk.length
    raw += chunk
    if (bytes > limit) {
      const error = Object.assign(new Error('请求体过大'), { code: '0413', status: 413 })
      finish(reject, error)
      req.pause()
    }
  })
  req.on('end', () => {
    if (!raw) return finish(resolve, {})
    try { finish(resolve, JSON.parse(raw)) } catch { finish(resolve, {}) }
  })
  req.on('error', (error) => finish(reject, error))
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
  userPassword: 'user.password',
  userAssist: 'user.login.assist',
  cs: 'cs.toolkit',
  roles: 'admin.read',
  rolesWrite: 'admin.write',
  menus: 'system.menu',
  menusWrite: 'system.menu.write',
  payChannelRead: 'payment.channel.read',
  payChannelWrite: 'payment.channel.write',
  emailRead: 'email.read',
  emailWrite: 'email.write',
  audit: 'audit.read',
  analytics: 'analytics.read',
  paySettings: 'admin.write',
  channelRead: 'growth.channel.read',
  channelWrite: 'growth.channel.write',
  contentStats: 'growth.content.read',
  contentStatsWrite: 'growth.content.write',
  distributionRead: 'growth.distribution.read',
  distributionWrite: 'growth.distribution.write',
  distributionSettle: 'growth.distribution.settle',
  distributionRisk: 'growth.distribution.risk',
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

  if (pathname === '/admin/api/logout' && method === 'POST') {
    if (auth?.token) revokeToken(auth.token)
    return send(res, { ok: true })
  }

  // 强制改密：未改初始口令前，除「读自己」与「改密」外一律拒绝
  if (principal.admin.must_change_password
    && pathname !== '/admin/api/me'
    && pathname !== '/admin/api/password') {
    return send(res, { required: 'password_change' }, '0403', '请先修改初始密码', 403)
  }

  /**
 * 把带 status 的业务异常转成响应信封（rbac.mjs 抛的 400/404/409 都走这里，
 * 否则统一落到外层 catch 变成 0500，前端分不清「参数错」和「服务炸了」）。
 */
const fail = (res, error, fallback = '操作失败') => {
  const status = Number(error?.status) || 500
  const code = status === 400 ? '0400'
    : status === 401 ? '0401'
      : status === 403 ? '0403'
        : status === 404 ? '0404'
          : status === 409 ? '0409'
            : status === 413 ? '0413'
              : status === 502 ? '0502'
                : status === 504 ? '0504' : '0500'
  return send(res, {}, code, error?.message ?? fallback, status)
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
  const trackResult = (res, fn) => {
    try {
      return fn()
    } catch (error) {
      return fail(res, error)
    }
  }

  /* ---------- 会话/概览 ---------- */
  if (pathname === '/admin/api/me') {
    // 下发给当前账号有权限的全部菜单；visible=false 的项只从侧栏隐藏，
    // 仍保留在前端路由表里，避免隐藏菜单后直接访问被错误送回概览。
    const menus = listAdminMenus({ includeHidden: true })
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.permCode || hasPermission(principal, item.permCode)),
      }))
      .filter((group) => group.items.length)
    return send(res, {
      admin: { id: principal.admin.id, username: principal.admin.username, displayName: principal.admin.display_name },
      roles: principal.roles.map((role) => ({ code: role.code, name: role.name })),
      permissions: [...principal.permissions],
      mustChangePassword: Boolean(principal.admin.must_change_password),
      menus,
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
    const viewerExpr = `COALESCE(NULLIF(visitor_id, ''), CASE WHEN user_id IS NOT NULL THEN 'u:' || user_id ELSE 'ip:' || COALESCE(ip, '') END)`
    const playRows = all(`SELECT date(created_at) AS day, COUNT(*) AS plays,
        COUNT(DISTINCT ${viewerExpr}) AS viewers
      FROM play_events WHERE created_at >= datetime('now', '-6 days') GROUP BY day`)
    const userRows = all(`SELECT date(created_at) AS day, COUNT(*) AS users
      FROM users WHERE created_at >= datetime('now', '-6 days') GROUP BY day`)
    const playMap = new Map(playRows.map((row) => [row.day, row]))
    const userMap = new Map(userRows.map((row) => [row.day, row.users]))
    const activity = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(Date.now() - (6 - index) * 86400_000).toISOString().slice(0, 10)
      return { day, plays: Number(playMap.get(day)?.plays ?? 0), viewers: Number(playMap.get(day)?.viewers ?? 0), users: Number(userMap.get(day) ?? 0) }
    })
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
      activity,
      mailReady: !mailUnavailable(),
      categories: all(`SELECT category, COUNT(*) AS n FROM dramas GROUP BY category ORDER BY n DESC`)
        .map((row) => ({ ...row, label: ADMIN_OPTIONS.categories.find((item) => item.value === row.category)?.label ?? row.category })),
    })
  }

  /* ---------- 增长：渠道 / 内容统计 / 多级分销 ---------- */
  if (pathname === '/admin/api/channels' && method === 'GET') {
    if (!guard(PERM.channelRead)) return deny(PERM.channelRead)
    return send(res, {
      channels: listAcquisitionChannels(),
      domains: listChannelDomains(),
      promoCodes: listPromoCodes(),
    })
  }

  if (pathname === '/admin/api/channels/analytics' && method === 'GET') {
    if (!guard(PERM.channelRead)) return deny(PERM.channelRead)
    return send(res, analyticsChannelRows({
      days: Number(url.searchParams.get('days') ?? 7),
      channelId: Number(url.searchParams.get('channelId') ?? 0) || undefined,
    }))
  }

  if (pathname === '/admin/api/attribution/config' && method === 'GET') {
    if (!guard(PERM.channelRead)) return deny(PERM.channelRead)
    return send(res, getSetting('attribution', { model: 'first_touch', windowDays: 30 }))
  }

  if (pathname === '/admin/api/attribution/config' && method === 'POST') {
    if (!guard(PERM.channelWrite)) return deny(PERM.channelWrite)
    const next = {
      model: body.model === 'last_touch' ? 'last_touch' : 'first_touch',
      windowDays: Math.max(1, Math.min(180, Number(body.windowDays ?? 30) || 30)),
    }
    setSetting('attribution', next)
    log('growth.attribution.config', 'attribution_config', 'default', null, next, body.reason)
    return send(res, next)
  }

  if (pathname === '/admin/api/channels' && method === 'POST') {
    if (!guard(PERM.channelWrite)) return deny(PERM.channelWrite)
    const action = String(body.action ?? 'channel')
    const result = action === 'domain' ? upsertChannelDomain(body)
      : action === 'promo' ? upsertPromoCode(body) : upsertAcquisitionChannel(body)
    log('growth.channel.upsert', action, result.id, null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/content-stats' && method === 'GET') {
    if (!guard(PERM.contentStats)) return deny(PERM.contentStats)
    return send(res, contentAnalytics({
      days: Number(url.searchParams.get('days') ?? 7),
      contentType: url.searchParams.get('contentType') ?? 'all',
      category: url.searchParams.get('category') ?? 'all',
      contentId: Number(url.searchParams.get('contentId') ?? 0) || undefined,
    }))
  }

  if (pathname === '/admin/api/content-ranks' && method === 'GET') {
    if (!guard(PERM.contentStats)) return deny(PERM.contentStats)
    return send(res, contentRank({
      rankType: url.searchParams.get('type') ?? 'hot',
      contentType: url.searchParams.get('contentType') ?? 'all',
    }))
  }

  if (pathname === '/admin/api/content-stats/refresh' && method === 'POST') {
    if (!guard(PERM.contentStatsWrite)) return deny(PERM.contentStatsWrite)
    const stats = rebuildContentStats({ days: Number(body.days ?? 7) })
    const ranks = refreshContentRanks()
    log('growth.content.refresh', 'content_stats', null, null, { stats, ranks: ranks.length }, body.reason)
    return send(res, { stats, ranks })
  }

  if (pathname === '/admin/api/distribution/config' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, { config: getDistributionConfig(), rules: listCommissionRules() })
  }

  if (pathname === '/admin/api/distribution/config' && method === 'POST') {
    if (!guard(PERM.distributionWrite)) return deny(PERM.distributionWrite)
    const result = updateDistributionConfig(body, principal.admin.id)
    log('growth.distribution.config', 'distribution_config', 'default', null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/distribution/rules' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, { list: listCommissionRules() })
  }

  if (pathname === '/admin/api/distribution/rules' && method === 'POST') {
    if (!guard(PERM.distributionWrite)) return deny(PERM.distributionWrite)
    const result = upsertCommissionRule(body)
    log('growth.distribution.rule', 'commission_rule', result.id, null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/distribution/overview' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, distributionAnalytics({ days: Number(url.searchParams.get('days') ?? 7) }))
  }

  if (pathname === '/admin/api/distribution/dashboard' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, distributionDashboard({ days: Number(url.searchParams.get('days') ?? 30) }))
  }

  if (pathname === '/admin/api/distribution/payout-config' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, {
      currencies: listCurrencies({ enabledOnly: false }),
      methods: listPayoutMethods({ enabledOnly: false }),
    })
  }

  if (pathname === '/admin/api/distribution/currencies' && method === 'POST') {
    if (!guard(PERM.distributionWrite)) return deny(PERM.distributionWrite)
    const result = upsertCurrency(body)
    log('growth.distribution.currency', 'currency', result.code, null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/distribution/payout-methods' && method === 'POST') {
    if (!guard(PERM.distributionWrite)) return deny(PERM.distributionWrite)
    const result = upsertPayoutMethod(body)
    log('growth.distribution.payout_method', 'payout_method', result.code, null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/distribution/withdrawals' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, pageWithdrawals({
      status: url.searchParams.get('status') || undefined,
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    }))
  }

  if (seg[0] === 'distribution' && seg[1] === 'withdrawals' && seg[2] && seg[3] && method === 'POST') {
    if (!guard(PERM.distributionSettle)) return deny(PERM.distributionSettle)
    if (!['approve', 'pay', 'reject'].includes(seg[3])) return send(res, {}, '0404', '提现动作不存在', 404)
    const result = reviewWithdrawal({
      withdrawalId: Number(seg[2]), action: seg[3], reviewerId: principal.admin.id,
      payoutRef: body.payoutRef,
    })
    log(`growth.distribution.withdrawal.${seg[3]}`, 'withdrawal', seg[2], null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/distribution/relations' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, pageRelations({
      ancestorUserId: Number(url.searchParams.get('ancestorUserId') ?? 0) || undefined,
      depth: Number(url.searchParams.get('depth') ?? 0) || undefined,
      status: url.searchParams.get('status') || undefined,
      riskStatus: url.searchParams.get('riskStatus') || undefined,
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    }))
  }

  if (pathname === '/admin/api/distribution/tree' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    const rootUserId = Number(url.searchParams.get('rootUserId') ?? 0)
    if (!rootUserId) return send(res, {}, '0400', 'rootUserId 必填', 400)
    return send(res, { list: teamTree({ rootUserId, maxDepth: Number(url.searchParams.get('maxDepth') ?? 3) }) })
  }

  if (pathname === '/admin/api/distribution/commissions' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, pageCommissions({
      distributorUserId: Number(url.searchParams.get('distributorUserId') ?? 0) || undefined,
      commissionLevel: Number(url.searchParams.get('commissionLevel') ?? 0) || undefined,
      status: url.searchParams.get('status') || undefined,
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    }))
  }

  if (pathname === '/admin/api/distribution/settlements' && method === 'GET') {
    if (!guard(PERM.distributionRead)) return deny(PERM.distributionRead)
    return send(res, pageSettlements({
      distributorUserId: Number(url.searchParams.get('distributorUserId') ?? 0) || undefined,
      status: url.searchParams.get('status') || undefined,
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    }))
  }

  if (pathname === '/admin/api/distribution/settlements' && method === 'POST') {
    if (!guard(PERM.distributionSettle)) return deny(PERM.distributionSettle)
    const result = createSettlement({
      distributorUserId: Number(body.distributorUserId),
      periodStart: body.periodStart,
      periodEnd: body.periodEnd,
      createdBy: principal.admin.id,
    })
    log('growth.distribution.settlement.create', 'settlement', result.id, null, result, body.reason)
    return send(res, result)
  }

  if (seg[0] === 'distribution' && seg[1] === 'settlements' && seg[2] && seg[3] && method === 'POST') {
    if (!guard(PERM.distributionSettle)) return deny(PERM.distributionSettle)
    const action = seg[3]
    if (!['approve', 'pay', 'reject'].includes(action)) return send(res, {}, '0404', '结算动作不存在', 404)
    const result = reviewSettlement({
      settlementId: Number(seg[2]), action, reviewerId: principal.admin.id,
      payoutRef: body.payoutRef, reason: body.reason,
    })
    log(`growth.distribution.settlement.${action}`, 'settlement', seg[2], null, result, body.reason)
    return send(res, result)
  }

  if (seg[0] === 'distribution' && seg[1] === 'relations' && seg[2] && seg[3] === 'risk' && method === 'POST') {
    if (!guard(PERM.distributionRisk)) return deny(PERM.distributionRisk)
    const result = applyRiskAction({
      relationId: Number(seg[2]), action: body.action, reason: body.reason, operatorId: principal.admin.id,
    })
    log('growth.distribution.risk', 'distribution_relation', seg[2], null, result, body.reason)
    return send(res, result)
  }

  if (seg[0] === 'distribution' && seg[1] === 'distributors' && seg[2] && seg[3] === 'status' && method === 'POST') {
    if (!guard(PERM.distributionWrite)) return deny(PERM.distributionWrite)
    const result = setDistributorStatus(Number(seg[2]), body.status)
    log('growth.distribution.distributor.status', 'user', seg[2], null, result, body.reason)
    return send(res, result)
  }

  if (pathname === '/admin/api/distribution/availability/run' && method === 'POST') {
    if (!guard(PERM.distributionSettle)) return deny(PERM.distributionSettle)
    const count = markCommissionsAvailable()
    log('growth.distribution.availability.run', 'commission', null, null, { count }, body.reason)
    return send(res, { count })
  }

  /* ---------- 剧集 ---------- */
  if (pathname === '/admin/api/adult-menu') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    if (method === 'GET') return send(res, adultMenuSettings())
    if (method === 'PUT') {
      const before = adultMenuSettings()
      try {
        const saved = saveAdultMenuSettings(body)
        log('content.adultMenu.update', 'settings', 'adultMenu', before, saved)
        return send(res, saved)
      } catch (error) {
        return fail(res, error, '保存成人菜单失败')
      }
    }
  }

  if (seg[0] === 'dramas' && seg.length === 1 && method === 'GET') {
    if (!guard(PERM.dramas)) return deny(PERM.dramas)
    const { page, pageSize } = paging(url, 20)
    const filters = dramaFilters({
      keyword: url.searchParams.get('keyword'),
      category: url.searchParams.get('category'),
      status: url.searchParams.get('status'),
    })
    const total = Number(one(`SELECT COUNT(*) AS n FROM dramas ${filters.clause}`, ...filters.args)?.n ?? 0)
    const pages = Math.max(1, Math.ceil(total / pageSize))
    const safePage = Math.min(page, pages)
    const offset = (safePage - 1) * pageSize
    const rows = all(`SELECT * FROM dramas ${filters.clause} ORDER BY id DESC LIMIT ? OFFSET ?`, ...filters.args, pageSize, offset)
    return send(res, {
      list: rows.map((drama) => ({
        ...drama,
        isAdult: Boolean(drama.is_adult),
        episodeCount: one('SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ?', drama.id).n,
        readyEpisodes: one("SELECT COUNT(*) AS n FROM episodes WHERE drama_id = ? AND status = 'ready' AND hls_path IS NOT NULL", drama.id).n,
        policy: policyOf(drama.id) ?? null,
        completeness: dramaCompleteness(drama),
      })),
      options: ADMIN_OPTIONS,
      total,
      page: safePage,
      pageSize,
      pages,
      policyGroups: all('SELECT id, name, description, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours FROM policy_groups ORDER BY id'),
      categoryCounts: all(`SELECT category, COUNT(*) AS n FROM dramas GROUP BY category ORDER BY n DESC`),
      statusCounts: all(`SELECT status, COUNT(*) AS n FROM dramas GROUP BY status ORDER BY n DESC`),
      policyCounts: all(`SELECT COALESCE(g.access_mode, p.access_mode, 'subscription') AS mode, COUNT(*) AS n
        FROM dramas d LEFT JOIN content_policies p ON p.drama_id = d.id
        LEFT JOIN policy_groups g ON g.id = p.policy_group_id
        GROUP BY COALESCE(g.access_mode, p.access_mode, 'subscription') ORDER BY n DESC`),
    })
  }

  if (pathname === '/admin/api/policy-groups' && method === 'GET') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const groups = all(`SELECT g.*,
        (SELECT COUNT(*) FROM content_policies p WHERE p.policy_group_id = g.id) AS assigned
      FROM policy_groups g ORDER BY g.id`)
    const total = one('SELECT COUNT(*) AS n FROM dramas').n
    const ungrouped = one(`SELECT COUNT(*) AS n FROM dramas d
      LEFT JOIN content_policies p ON p.drama_id = d.id
      WHERE p.policy_group_id IS NULL`).n
    return send(res, { groups, options: ADMIN_OPTIONS, total, ungrouped })
  }

  if (pathname === '/admin/api/policy-groups' && method === 'POST') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const name = String(body?.name ?? '').trim()
    if (!name) return send(res, {}, '0400', '策略组名称必填', 400)
    if (one('SELECT id FROM policy_groups WHERE name = ?', name)) return send(res, {}, '0409', '策略组名称已存在', 409)
    const policy = normalizePolicy(body)
    const info = run(`INSERT INTO policy_groups
      (name, description, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    name, String(body?.description ?? '').trim(), policy.accessMode, policy.freeEpisodes,
    policy.trialSeconds, policy.singlePrice, policy.purchaseKind, policy.rentalHours)
    log('content.policyGroup.create', 'policy_group', Number(info.lastInsertRowid), null, { name, ...policy })
    return send(res, { id: Number(info.lastInsertRowid) })
  }

  if (seg[0] === 'policy-groups' && seg[1] && seg.length === 2 && method === 'PUT') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const id = Number(seg[1])
    const before = one('SELECT * FROM policy_groups WHERE id = ?', id)
    if (!before) return send(res, {}, '0404', '策略组不存在', 404)
    const name = String(body?.name ?? '').trim()
    if (!name) return send(res, {}, '0400', '策略组名称必填', 400)
    if (one('SELECT id FROM policy_groups WHERE name = ? AND id <> ?', name, id)) return send(res, {}, '0409', '策略组名称已存在', 409)
    const policy = normalizePolicy(body)
    run(`UPDATE policy_groups SET name = ?, description = ?, access_mode = ?, free_episodes = ?,
      trial_seconds = ?, single_price_cny = ?, purchase_kind = ?, rental_hours = ?, updated_at = datetime('now')
      WHERE id = ?`, name, String(body?.description ?? '').trim(), policy.accessMode, policy.freeEpisodes,
    policy.trialSeconds, policy.singlePrice, policy.purchaseKind, policy.rentalHours, id)
    log('content.policyGroup.update', 'policy_group', id, before, { name, ...policy })
    return send(res, { id })
  }

  if (seg[0] === 'policy-groups' && seg[1] && seg.length === 2 && method === 'DELETE') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const id = Number(seg[1])
    const before = one('SELECT * FROM policy_groups WHERE id = ?', id)
    if (!before) return send(res, {}, '0404', '策略组不存在', 404)
    const assigned = one('SELECT COUNT(*) AS n FROM content_policies WHERE policy_group_id = ?', id).n
    if (assigned) return send(res, { assigned }, '0409', `该组仍有 ${assigned} 部剧集，请先重新分配`, 409)
    run('DELETE FROM policy_groups WHERE id = ?', id)
    log('content.policyGroup.delete', 'policy_group', id, before, null, body?.reason)
    return send(res, { deleted: true })
  }

  if (seg[0] === 'policy-groups' && seg[1] && seg[2] === 'assign' && method === 'POST') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const group = one('SELECT * FROM policy_groups WHERE id = ?', Number(seg[1]))
    if (!group) return send(res, {}, '0404', '策略组不存在', 404)
    let clause
    let args
    let filters = null
    let dramaIds = null
    if (Object.prototype.hasOwnProperty.call(body ?? {}, 'dramaIds')) {
      if (!Array.isArray(body.dramaIds)) return send(res, {}, '0400', 'dramaIds 必须是剧集 ID 数组', 400)
      dramaIds = [...new Set(body.dramaIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))]
      if (!dramaIds.length) return send(res, {}, '0400', '请至少选择一部剧集', 400)
      if (dramaIds.length > 500) return send(res, {}, '0400', '单次最多分配 500 部剧集', 400)
      clause = `WHERE id IN (${dramaIds.map(() => '?').join(', ')})`
      args = dramaIds
    } else {
      filters = dramaFilters(body?.filters ?? {})
      if (!filters.keyword && (!filters.category || filters.category === 'all') && (!filters.status || filters.status === 'all')) {
        return send(res, {}, '0400', '批量分配至少选择一个分组条件', 400)
      }
      clause = filters.clause
      args = filters.args
    }
    const matched = Number(one(`SELECT COUNT(*) AS n FROM dramas ${clause}`, ...args)?.n ?? 0)
    const sample = all(`SELECT id, title FROM dramas ${clause} ORDER BY id DESC LIMIT 5`, ...args)
    if (body?.dryRun) return send(res, { dryRun: true, matched, sample, filters, dramaIds, group })
    if (!matched) return send(res, { dryRun: false, matched: 0, updated: 0, sample: [], filters, group })
    const updated = writePolicyGroup(group, clause, args)
    log('content.policyGroup.assign', 'policy_group', group.id, filters ?? { dramaIds }, { matched, updated })
    return send(res, { dryRun: false, matched, updated, sample, filters, dramaIds, group })
  }

  if (seg[0] === 'dramas' && seg[1] && seg.length === 2 && method === 'GET') {
    if (!guard(PERM.dramas)) return deny(PERM.dramas)
    const drama = one('SELECT * FROM dramas WHERE id = ?', Number(seg[1]))
    if (!drama) return send(res, {}, '0404', '剧集不存在', 404)
    return send(res, {
      drama: { ...dramaDto(drama), tags: tagsOfDrama(drama.id).map((tag) => ({ id: tag.id, name: tag.name })) },
      policy: policyOf(drama.id) ?? null,
      episodes: all('SELECT * FROM episodes WHERE drama_id = ? ORDER BY no', drama.id),
    })
  }

  if (seg[0] === 'dramas' && seg.length === 1 && method === 'POST') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    const title = String(body.title ?? '').trim()
    if (!title) return send(res, {}, '0400', '请先填写剧集标题', 400)
    const policyGroupId = Number(body.policyGroupId ?? 0) || null
    const policyGroup = policyGroupId ? one('SELECT * FROM policy_groups WHERE id = ?', policyGroupId) : null
    if (policyGroupId && !policyGroup) return send(res, {}, '0404', '付费策略组不存在', 404)
    const policy = policyGroup ? policyFromGroup(policyGroup) : normalizePolicy({ freeEpisodes: 1, ...body })
    const wanted = body.status === 'published' ? 'published' : 'draft'
    const contentType = ['series', 'movie', 'comic_drama'].includes(body.contentType)
      ? body.contentType
      : (body.category === 'MOVIE' ? 'movie' : body.category === 'ANIME' ? 'comic_drama' : 'series')
    const info = run(`INSERT INTO dramas (title, sub_title, cover_url, description, year, area, category, is_adult, score, status, sort, content_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    title, body.subTitle ?? '', body.coverUrl ?? '', body.description ?? '',
    Number(body.year ?? 0) || 0, body.area ?? '', body.category ?? '', body.isAdult ? 1 : 0, Number(body.score ?? 0) || 0,
    'draft', Number(body.sort ?? 0), contentType)
    const dramaId = Number(info.lastInsertRowid)
    run(`INSERT INTO content_policies
      (drama_id, policy_group_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, dramaId, policyGroup?.id ?? null, policy.accessMode, policy.freeEpisodes,
    policy.trialSeconds, policy.singlePrice, policy.purchaseKind, policy.rentalHours)
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
    log('content.drama.create', 'drama', dramaId, null, { title, wanted, isAdult: Boolean(body.isAdult), policyGroupId: policyGroup?.id ?? null, missing: check.missing })
    return send(res, { drama: dramaDto(one('SELECT * FROM dramas WHERE id = ?', dramaId)), completeness: check, statusNote })
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
    const contentType = ['series', 'movie', 'comic_drama'].includes(body.contentType)
      ? body.contentType
      : before.content_type ?? (body.category === 'MOVIE' ? 'movie' : body.category === 'ANIME' ? 'comic_drama' : 'series')
    const isAdult = body.isAdult === undefined ? before.is_adult : (body.isAdult ? 1 : 0)
    run(`UPDATE dramas SET title = ?, sub_title = ?, cover_url = ?, description = ?, year = ?, area = ?, category = ?, is_adult = ?, score = ?, status = ?, sort = ?, content_type = ?,
      published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, datetime('now')) ELSE published_at END
      WHERE id = ?`,
    body.title ?? before.title, body.subTitle ?? before.sub_title, body.coverUrl ?? before.cover_url,
    body.description ?? before.description, Number(body.year ?? before.year), body.area ?? before.area,
    body.category ?? before.category, isAdult, Number(body.score ?? before.score), nextStatus,
    Number(body.sort ?? before.sort), contentType, nextStatus, dramaId)
    log('content.drama.update', 'drama', dramaId, before, { ...body, status: nextStatus })
    return send(res, dramaDto(one('SELECT * FROM dramas WHERE id = ?', dramaId)))
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
    run(`UPDATE dramas SET status = ?,
      published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, datetime('now')) ELSE published_at END
      WHERE id = ?`, status, status, dramaId)
    log('content.drama.publish', 'drama', dramaId, { status: before.status }, { status }, body.reason)
    return send(res, { status })
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'episodes' && method === 'GET') {
    if (!guard(PERM.episodes)) return deny(PERM.episodes)
    const drama = one('SELECT category FROM dramas WHERE id = ?', Number(seg[1]))
    return send(res, {
      category: drama?.category ?? null,
      list: all("SELECT * FROM episodes WHERE drama_id = ? AND status != 'merged' ORDER BY no", Number(seg[1])),
    })
  }

  if (seg[0] === 'dramas' && seg[1] && seg[2] === 'episodes' && method === 'POST') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    const dramaId = Number(seg[1])
    const drama = one('SELECT category FROM dramas WHERE id = ?', dramaId)
    if (!drama) return send(res, {}, '0404', '剧集不存在', 404)
    if (drama.category === 'MOVIE' && one('SELECT id FROM episodes WHERE drama_id = ? LIMIT 1', dramaId)) {
      return send(res, {}, '0400', '电影只能有一个正片', 400)
    }
    const nextNo = Number(one('SELECT COALESCE(MAX(no),0) + 1 AS n FROM episodes WHERE drama_id = ?', dramaId).n)
    const title = body.title ?? (drama.category === 'MOVIE' ? '正片' : `第 ${nextNo} 集`)
    const info = run("INSERT INTO episodes (drama_id, no, title, status) VALUES (?, ?, ?, 'ready')",
      dramaId, Number(body.no ?? nextNo), title)
    log('content.episode.create', 'episode', Number(info.lastInsertRowid), null, { dramaId, no: body.no ?? nextNo })
    return send(res, one('SELECT * FROM episodes WHERE id = ?', Number(info.lastInsertRowid)))
  }

  if (seg[0] === 'episodes' && seg[1] && seg[2] === 'tracks' && method === 'GET') {
    if (!guard(PERM.episodes)) return deny(PERM.episodes)
    return trackResult(res, () => send(res, { list: listEpisodeTracks(Number(seg[1])) }))
  }

  if (seg[0] === 'episodes' && seg[1] && seg[2] === 'tracks' && method === 'POST') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    return trackResult(res, () => {
      const track = createTrack({ episodeId: Number(seg[1]), ...body })
      log('content.track.create', 'episode_track', track.id, null, body)
      return send(res, track)
    })
  }

  if (seg[0] === 'tracks' && seg[1] && method === 'PUT') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    return trackResult(res, () => {
      const before = one('SELECT * FROM episode_tracks WHERE id = ?', Number(seg[1]))
      const track = updateTrack(Number(seg[1]), body)
      log('content.track.update', 'episode_track', track.id, before, body)
      return send(res, track)
    })
  }

  if (seg[0] === 'tracks' && seg[1] && method === 'DELETE') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    return trackResult(res, () => {
      const before = deleteTrack(Number(seg[1]))
      log('content.track.delete', 'episode_track', before.id, before, null, body.reason)
      return send(res, { deleted: true })
    })
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

  /* ---------- 素材搜刮：封面 / 横幅 / 首页大图 ---------- */
  if (seg[0] === 'artwork' && seg[1] === 'refresh' && method === 'POST') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    try {
      const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Boolean) : []
      const result = await refreshArtwork({ only: ids, limit: Math.min(200, Number(body?.limit) || 100), force: Boolean(body?.force) })
      const banners = autofillBanners({ limit: Number(body?.bannerLimit) || 6 })
      log('content.artwork.refresh', 'drama', ids.length === 1 ? ids[0] : null, null, {
        updated: result.updated, failed: result.failed, banners: banners.created,
      })
      return send(res, { ...result, banners })
    } catch (error) {
      return send(res, {}, '0400', error.message ?? '搜刮素材失败', error.status ?? 400)
    }
  }

  if (seg[0] === 'banners' && seg[1] === 'autofill' && method === 'POST') {
    if (!guard(PERM.dramaWrite)) return deny(PERM.dramaWrite)
    const result = autofillBanners({ limit: Math.min(10, Number(body?.limit) || 6) })
    log('content.banner.autofill', 'banner', null, null, result)
    return send(res, result)
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
    const visitors = Number(one(`SELECT COUNT(DISTINCT visitor_id) AS n FROM track_events
      WHERE created_at >= datetime('now', ?) AND visitor_id IS NOT NULL`, since)?.n ?? 0)
    return send(res, {
      total, page, pageSize, visitors,
      byType: all(`SELECT te.type, COUNT(*) AS n FROM track_events te WHERE ${clause} GROUP BY te.type ORDER BY n DESC`, ...args),
      byDay: all(`SELECT date(te.created_at) AS day, COUNT(*) AS n FROM track_events te
        WHERE te.created_at >= datetime('now', ?) GROUP BY day ORDER BY day`, since),
      list: list.map((row) => {
        const { meta_json: metaJson, ...rest } = row
        return { ...rest, meta: metaJson ? safeJson(metaJson) : null }
      }),
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
    if (!one('SELECT id FROM dramas WHERE id = ?', dramaId)) return send(res, {}, '0404', '剧集不存在', 404)
    const before = policyOf(dramaId)
    const groupId = Number(body?.policyGroupId ?? 0) || null
    const group = groupId ? one('SELECT * FROM policy_groups WHERE id = ?', groupId) : null
    if (groupId && !group) return send(res, {}, '0404', '策略组不存在', 404)
    let policy
    if (group) {
      writePolicyGroup(group, 'WHERE id = ?', [dramaId])
      policy = policyFromGroup(group)
    } else {
      policy = normalizePolicy(body)
      run(`INSERT INTO content_policies
        (drama_id, policy_group_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours, updated_at)
        VALUES (?, NULL, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(drama_id) DO UPDATE SET policy_group_id = NULL,
          access_mode = excluded.access_mode, free_episodes = excluded.free_episodes,
          trial_seconds = excluded.trial_seconds, single_price_cny = excluded.single_price_cny,
          purchase_kind = excluded.purchase_kind, rental_hours = excluded.rental_hours, updated_at = datetime('now')`,
      dramaId, policy.accessMode, policy.freeEpisodes, policy.trialSeconds,
      policy.singlePrice, policy.purchaseKind, policy.rentalHours)
    }
    log('content.policy.update', 'drama', dramaId, before, { policyGroupId: groupId, ...policy })
    return send(res, policyOf(dramaId))
  }

  if (pathname === '/admin/api/policies/bulk' && method === 'POST') {
    if (!guard(PERM.policy)) return deny(PERM.policy)
    const policy = normalizePolicy(body?.policy ?? {})
    const filters = dramaFilters(body?.filters ?? {})
    if (!filters.keyword && (!filters.category || filters.category === 'all') && (!filters.status || filters.status === 'all')) {
      return send(res, {}, '0400', '批量设置至少选择一个分组条件（内容类型 / 上架状态 / 关键词）', 400)
    }
    const matched = Number(one(`SELECT COUNT(*) AS n FROM dramas ${filters.clause}`, ...filters.args)?.n ?? 0)
    const sample = all(`SELECT id, title FROM dramas ${filters.clause} ORDER BY id DESC LIMIT 5`, ...filters.args)
    if (body?.dryRun) return send(res, { dryRun: true, matched, sample, filters, policy })
    if (!matched) return send(res, { dryRun: false, matched: 0, updated: 0, sample: [], filters, policy })
    const result = run(`INSERT INTO content_policies
      (drama_id, policy_group_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind, rental_hours, updated_at)
      SELECT id, NULL, ?, ?, ?, ?, ?, ?, datetime('now') FROM dramas ${filters.clause}
      ON CONFLICT(drama_id) DO UPDATE SET policy_group_id = NULL, access_mode = excluded.access_mode, free_episodes = excluded.free_episodes,
        trial_seconds = excluded.trial_seconds, single_price_cny = excluded.single_price_cny,
        purchase_kind = excluded.purchase_kind, rental_hours = excluded.rental_hours, updated_at = datetime('now')`,
    policy.accessMode, policy.freeEpisodes, policy.trialSeconds, policy.singlePrice,
    policy.purchaseKind, policy.rentalHours, ...filters.args)
    log('content.policy.bulk', 'drama', null, filters, { ...policy, matched })
    return send(res, { dryRun: false, matched, updated: Number(result.changes ?? matched), sample, filters, policy })
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

  if (seg[0] === 'episodes' && seg[1] && seg[2] === 'import-url' && method === 'POST') {
    if (!guard(PERM.episodeWrite)) return deny(PERM.episodeWrite)
    const episode = one('SELECT * FROM episodes WHERE id = ?', Number(seg[1]))
    if (!episode) return send(res, {}, '0404', '分集不存在', 404)
    let download
    try {
      download = await downloadRemoteVideo(body.url)
    } catch (error) {
      return fail(res, error, 'URL 导入失败')
    }
    const info = await probe(download.path)
    if (!info?.width || !info?.height || !info?.duration) {
      try { unlinkSync(download.path) } catch { /* ignore */ }
      return send(res, {}, '0400', 'URL 内容不是可识别的视频文件', 400)
    }
    run('UPDATE episodes SET duration = ?, source_path = ? WHERE id = ?', info.duration, download.path, episode.id)
    enqueueEpisode({ ...episode, source_path: download.path, duration: info.duration })
    const host = (() => { try { return new URL(download.sourceUrl).host } catch { return '' } })()
    log('content.episode.importUrl', 'episode', episode.id, null, {
      host, size: download.size, probe: info, contentType: download.contentType,
    })
    return send(res, { ok: true, source: download.path, probe: info, queue: queueState() })
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
    const { page, pageSize, offset } = paging(url, 20)
    const status = url.searchParams.get('status') || undefined
    const q = url.searchParams.get('q') || undefined
    return send(res, {
      list: listOrders({ status, q, limit: pageSize, offset }),
      page, pageSize, total: countOrders({ status, q }),
    })
  }

  const orderDetail = pathname.match(/^\/admin\/api\/orders\/(\d+)$/)
  if (orderDetail && method === 'GET') {
    if (!guard(PERM.orders)) return deny(PERM.orders)
    const order = getOrder(Number(orderDetail[1]))
    if (!order) return send(res, {}, '0404', '订单不存在', 404)
    const refunds = all("SELECT * FROM refunds WHERE order_id = ? ORDER BY id DESC", order.id)
    return send(res, { order, refunds })
  }

  if (pathname === '/admin/api/refunds' && method === 'GET') {
    if (!guard(PERM.orders)) return deny(PERM.orders)
    const { page, pageSize, offset } = paging(url, 20)
    const total = Number(one('SELECT COUNT(*) AS n FROM refunds')?.n ?? 0)
    return send(res, {
      list: all(`SELECT r.*, o.out_trade_no, o.amount_cny, o.channel, u.nickname
        FROM refunds r JOIN orders o ON o.id = r.order_id LEFT JOIN users u ON u.id = o.user_id
        ORDER BY r.id DESC LIMIT ? OFFSET ?`, pageSize, offset),
      page, pageSize, total,
    })
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
    const { page, pageSize, offset } = paging(url, 20)
    const status = url.searchParams.get('status') ?? 'pending'
    const total = Number(one('SELECT COUNT(*) AS n FROM danmus WHERE status = ?', status)?.n ?? 0)
    return send(res, {
      list: all(`SELECT dm.*, d.title FROM danmus dm JOIN episodes e ON e.id = dm.episode_id
        JOIN dramas d ON d.id = e.drama_id WHERE dm.status = ? ORDER BY dm.id DESC LIMIT ? OFFSET ?`, status, pageSize, offset),
      page, pageSize, total,
    })
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
    const { page, pageSize, offset } = paging(url, 20)
    const status = url.searchParams.get('status') ?? 'pending'
    const total = Number(one('SELECT COUNT(*) AS n FROM comments WHERE status = ?', status)?.n ?? 0)
    return send(res, {
      list: all(`SELECT c.*, d.title FROM comments c JOIN dramas d ON d.id = c.drama_id
        WHERE c.status = ? ORDER BY c.id DESC LIMIT ? OFFSET ?`, status, pageSize, offset),
      page, pageSize, total,
    })
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
    const { page, pageSize, offset } = paging(url, 20)
    const total = Number(one('SELECT COUNT(*) AS n FROM users')?.n ?? 0)
    return send(res, {
      page, pageSize, total,
      list: all(`SELECT u.id, u.email, u.nickname, u.avatar, u.birthday, u.gender, u.bio,
        u.status, u.email_verified_at, u.created_at, u.last_login_at,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count,
        (SELECT COALESCE(SUM(amount_cny),0) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid','fulfilled')) AS paid_total,
        (SELECT datetime(valid_to) FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' ORDER BY datetime(valid_to) DESC LIMIT 1) AS vip_until
        FROM users u ORDER BY u.id DESC LIMIT ? OFFSET ?`, pageSize, offset)
        .map((row) => ({ ...row, kind: 'user', kindLabel: 'C 端用户' })),
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
  if (seg[0] === 'users' && seg[1] && seg[2] === 'password' && method === 'POST') {
    if (!guard(PERM.userPassword)) return deny(PERM.userPassword)
    const user = one('SELECT * FROM users WHERE id = ?', Number(seg[1]))
    if (!user) return send(res, {}, '0404', '用户不存在', 404)
    const mode = body?.mode === 'reset' ? 'reset' : 'set'
    const password = mode === 'reset' ? temporaryPassword() : String(body?.password ?? '')
    const strength = checkPasswordStrength(password)
    if (!strength.ok) return send(res, {}, '0400', strength.message, 400)
    if (mode === 'reset' && !user.email) return send(res, {}, '0400', '该用户未绑定邮箱，无法发送重置邮件', 400)
    setUserPassword(user.id, password)
    const revoked = revokeSessions(user.id, 'user')
    if (mode === 'reset') {
      try {
        const mail = buildPasswordResetEmail({ to: user.email, password, template: emailSettings().template })
        const delivered = await sendMail({ to: user.email, ...mail })
        if (!delivered.delivered) throw new Error('邮件通道未投递')
        log('user.password.reset', 'user', user.id, null, { revokedSessions: revoked, delivered: true }, body?.reason)
        logInfo('user.password.reset.sent', { userId: user.id, to: user.email, channel: delivered.channel })
        return send(res, { ok: true, mode, email: user.email, delivered: true, revokedSessions: revoked })
      } catch (error) {
        run('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?', user.password_hash, user.password_salt, user.id)
        logError('user.password.reset.failed', { userId: user.id, to: user.email, error })
        return send(res, { error: error.message }, '0502', `密码重置邮件发送失败：${error.message}`, 502)
      }
    }
    log('user.password.set', 'user', user.id, null, { revokedSessions: revoked }, body?.reason)
    return send(res, { ok: true, mode, revokedSessions: revoked })
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
    if (!guard(PERM.roles) && !guard(PERM.adminAccounts)) return deny(PERM.roles)
    return send(res, { roles: listRoles(), permissions: listPermissionCatalog() })
  }
  if (pathname === '/admin/api/roles' && method === 'POST') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const created = createRole(body)
    log('admin.role.create', 'role', created.id, null, created)
    return send(res, created)
  }
  if (seg[0] === 'roles' && seg[1] && method === 'PUT') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const before = listRoles().find((role) => role.id === Number(seg[1]))
    const updated = Array.isArray(body.permissions)
      ? updateRolePermissions(Number(seg[1]), body.permissions)
      : updateRole(Number(seg[1]), body)
    log('admin.role.update', 'role', seg[1], before, updated)
    return send(res, updated)
  }
  if (seg[0] === 'roles' && seg[1] && seg.length === 2 && method === 'DELETE') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const before = listRoles().find((role) => role.id === Number(seg[1]))
    const deleted = deleteRole(Number(seg[1]))
    log('admin.role.delete', 'role', seg[1], before, deleted)
    return send(res, deleted)
  }
  if (pathname === '/admin/api/admins' && method === 'GET') {
    if (!guard(PERM.roles) && !guard(PERM.adminAccounts)) return deny(PERM.roles)
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

  /* ---------- 后台账号：新增 / 编辑 / 停用 / 重置口令 / 删除 ---------- */
  if (pathname === '/admin/api/admins' && method === 'POST') {
    if (!guard(PERM.adminAccounts)) return deny(PERM.adminAccounts)
    const username = String(body.username ?? '').trim()
    const password = String(body.password ?? '')
    const check = checkAdminPassword(password, username)
    if (!check.ok) return send(res, {}, '0400', check.message, 400)
    const roleCodes = (Array.isArray(body.roles) ? body.roles : []).map(String)
    if (!roleCodes.length) return send(res, {}, '0400', '请至少分配一个角色', 400)
    const salt = randomBytes(8).toString('hex')
    let admin
    try {
      admin = createAdmin({
        username,
        displayName: body.displayName,
        passwordHash: hashPassword(password, salt),
        salt,
        roleCodes: roleCodes.filter((code) => one('SELECT id FROM roles WHERE code = ?', code)),
        mustChange: body.mustChange === false ? 0 : 1,
      })
    } catch (error) {
      return fail(res, error, '新建后台账号失败')
    }
    log('admin.create', 'admin', admin.id, null, { username: admin.username, roles: roleCodes })
    return send(res, admin)
  }

  if (seg[0] === 'admins' && seg[1] && seg.length === 2 && method === 'PUT') {
    if (!guard(PERM.adminAccounts)) return deny(PERM.adminAccounts)
    const before = listAdmins().find((item) => item.id === Number(seg[1]))
    if (!before) return send(res, {}, '0404', '管理员不存在', 404)
    let updated
    try {
      updated = updateAdminBasic(Number(seg[1]), {
        displayName: body.displayName,
        status: body.status,
        roleCodes: Array.isArray(body.roles) ? body.roles.filter((code) => one('SELECT id FROM roles WHERE code = ?', code)) : undefined,
      })
    } catch (error) {
      return fail(res, error, '保存失败')
    }
    if (body.status === 'disabled') await revokeSessions(Number(seg[1]), 'admin')
    log('admin.update', 'admin', seg[1], before, { displayName: updated.display_name, status: updated.status, roles: (updated.roles ?? []).map((r) => r.code) })
    return send(res, updated)
  }

  if (seg[0] === 'admins' && seg[1] && seg[2] === 'password' && method === 'POST') {
    if (!guard(PERM.adminAccounts)) return deny(PERM.adminAccounts)
    const target = one('SELECT * FROM admins WHERE id = ?', Number(seg[1]))
    if (!target) return send(res, {}, '0404', '管理员不存在', 404)
    const password = String(body.password ?? '')
    const check = checkAdminPassword(password, target.username)
    if (!check.ok) return send(res, {}, '0400', check.message, 400)
    const salt = randomBytes(8).toString('hex')
    setAdminPassword(Number(seg[1]), hashPassword(password, salt), salt, { mustChange: body.mustChange === false ? 0 : 1 })
    const revoked = await revokeSessions(Number(seg[1]), 'admin')
    log('admin.password.reset', 'admin', seg[1], null, { revokedSessions: revoked })
    return send(res, { ok: true, revokedSessions: revoked })
  }

  if (seg[0] === 'admins' && seg[1] && seg.length === 2 && method === 'DELETE') {
    if (!guard(PERM.adminAccounts)) return deny(PERM.adminAccounts)
    if (Number(seg[1]) === principal.admin.id) return send(res, {}, '0400', '不能删除当前登录的账号', 400)
    let result
    try {
      result = deleteAdminById(Number(seg[1]))
    } catch (error) {
      return fail(res, error, '删除失败')
    }
    log('admin.delete', 'admin', seg[1], { username: result.username }, null, body.reason)
    return send(res, result)
  }

  /* ---------- 后台菜单（与角色权限独立） ---------- */
  if (pathname === '/admin/api/admin-menus' && method === 'GET') {
    if (!guard(PERM.menus)) return deny(PERM.menus)
    const perms = listPermissionCatalog().filter((item) => item.type !== 'dir')
    return send(res, {
      groups: listAdminMenus(),
      permissions: perms.map((item) => ({ code: item.code, name: item.name, type: item.type, path: item.path })),
    })
  }

  if (pathname === '/admin/api/admin-menus' && method === 'POST') {
    if (!guard(PERM.menusWrite)) return deny(PERM.menusWrite)
    let result
    try {
      result = saveAdminMenu(body)
    } catch (error) {
      return fail(res, error, '保存菜单失败')
    }
    log('menu.create', 'admin_menu', result.id, null, body)
    return send(res, result)
  }

  if (seg[0] === 'admin-menus' && seg[1] === 'reset' && method === 'POST') {
    if (!guard(PERM.menusWrite)) return deny(PERM.menusWrite)
    const groups = resetAdminMenus(DEFAULT_ADMIN_MENUS)
    log('menu.reset', 'admin_menu', null, null, { groups: groups.length })
    return send(res, { groups })
  }

  if (seg[0] === 'admin-menus' && seg[1] && method === 'PUT') {
    if (!guard(PERM.menusWrite)) return deny(PERM.menusWrite)
    let result
    try {
      result = saveAdminMenu(body, Number(seg[1]))
    } catch (error) {
      return fail(res, error, '保存菜单失败')
    }
    log('menu.update', 'admin_menu', seg[1], result.before ?? null, body)
    return send(res, result)
  }

  if (seg[0] === 'admin-menu-groups' && seg[1] && method === 'PUT') {
    if (!guard(PERM.menusWrite)) return deny(PERM.menusWrite)
    let result
    try {
      result = saveAdminMenuGroup(decodeURIComponent(seg[1]), body)
    } catch (error) {
      return fail(res, error, '保存菜单分组失败')
    }
    log('menu.group.update', 'admin_menu_group', decodeURIComponent(seg[1]), null, result)
    return send(res, result)
  }

  if (seg[0] === 'admin-menus' && seg[1] && method === 'DELETE') {
    if (!guard(PERM.menusWrite)) return deny(PERM.menusWrite)
    let result
    try {
      result = deleteAdminMenu(Number(seg[1]))
    } catch (error) {
      return fail(res, error, '删除菜单失败')
    }
    log('menu.delete', 'admin_menu', seg[1], null, null, body.reason)
    return send(res, result)
  }
  if (seg[0] === 'admins' && seg[1] && seg[2] === 'roles' && method === 'PUT') {
    if (!guard(PERM.rolesWrite)) return deny(PERM.rolesWrite)
    const updated = setAdminRoles(Number(seg[1]), body.roles ?? [])
    log('admin.roles.update', 'admin', seg[1], null, body)
    return send(res, updated)
  }
  if (pathname === '/admin/api/audit' && method === 'GET') {
    if (!guard(PERM.audit)) return deny(PERM.audit)
    const { page, pageSize, offset } = paging(url, 20)
    const action = url.searchParams.get('action') ?? undefined
    const total = action
      ? Number(one('SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE ?', `%${action}%`)?.n ?? 0)
      : Number(one('SELECT COUNT(*) AS n FROM audit_logs')?.n ?? 0)
    return send(res, {
      list: listAudit({ limit: pageSize, offset, action }),
      page, pageSize, total,
    })
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
      template: settings.template,
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
    const settings = saveEmailSettings({
      from: String(body?.from ?? '').trim(),
      fromName: String(body?.fromName ?? '').trim(),
      template: body?.template,
    })
    log('admin.email.template.save', 'email_settings', null, null, { template: settings.template })
    return send(res, { ok: true, from: settings.from, fromName: settings.fromName, template: settings.template })
  }

  if (pathname === '/admin/api/email-template/preview' && method === 'POST') {
    if (!guard(PERM.emailRead)) return deny(PERM.emailRead)
    const mail = buildCodeEmail({
      to: 'preview@example.com',
      code: '123456',
      purpose: 'login',
      expiresIn: 300,
      attempts: 3,
      template: body?.template,
    })
    return send(res, { subject: mail.subject, html: mail.html, text: mail.text })
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






