/** C 端接口：内容、权益判定、播放令牌、套餐下单、支付回调、我的。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, getSetting, ROOT } from './db.mjs'
import {
  authOf, changeUserEmail, checkPasswordStrength, issueToken, loginByEmail, publicUser, revokeSessions, setUserPassword,
  updateProfile, verifyPassword,
} from './auth.mjs'
import { OtpError, normalizeEmail, sendCode, verifyCode } from './otp.mjs'
import {
  LINK_TTL, decideEpisodes, entitlementsOf, policyOf, priceInfo, resolveAccess, secureLink,
  signPayTicket, verifyPayTicket,
} from './entitlements.mjs'
import { recordEvent, recordPlay } from './analytics.mjs'
import { clientIpOf } from './ratelimit.mjs'
import { listTags, tagsOfDrama } from './tags.mjs'
import {
  CommerceError, createOrder, handleAlipayNotify, listOrders, markPaid, mockPay, paymentOptions, validateCoupon,
  buildSimulatedAlipayNotify, syncAlipayOrder, payUrlFor,
} from './commerce.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

/** 单次播放链接的最长有效期：覆盖整集时长，默认 2 小时（可用 MH_PLAY_TTL_MAX 调整）。 */
const PLAY_TTL_MAX = Math.max(LINK_TTL, Math.min(4 * 3600, Number(process.env.MH_PLAY_TTL_MAX ?? 7200) || 7200))

export function send(res, data, code = '0000', msg = 'Success', status = 200) {
  const body = JSON.stringify({ requestId: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`, code, msg, data })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const fail = (res, code, msg, status = 400, extra = {}) => send(res, extra, code, msg, status)

/** 播放签名放 Cookie：HLS 播放器请求分片时不带 query，但会自动带 Cookie。 */
function setLinkCookies(res, link, ttl, req, scopeId) {
  const proto = String(req?.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  const secure = proto === 'https'
  const flags = `; Path=/; Max-Age=${ttl}; SameSite=Lax; HttpOnly${secure ? '; Secure' : ''}`
  const list = []
  // 按集分名：同一浏览器开两个标签播不同剧时，通用名会互相覆盖签名 → 先开的那个黑屏
  if (scopeId !== undefined && scopeId !== null) {
    list.push(`mh_link_${scopeId}=${link.sign}${flags}`, `mh_exp_${scopeId}=${link.expires}${flags}`)
  }
  list.push(`mh_link=${link.sign}${flags}`, `mh_exp=${link.expires}${flags}`)
  res.setHeader('set-cookie', list)
}

function cardOf(drama, userId, context = {}) {
  const policy = context.policy ?? policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0 }
  let access = policy.access_mode === 'paid' ? 'paid' : policy.access_mode === 'free' ? 'free' : 'subscription'
  if (userId && context.purchase && context.purchase.has(drama.id)) access = 'owned'
  else if (userId && context.subscription && access !== 'paid') access = 'subscribed'
  return {
    dramaId: drama.id,
    title: drama.title,
    subTitle: drama.sub_title,
    coverUrl: drama.cover_url || `/media/placeholder.svg?t=${encodeURIComponent(drama.title ?? '')}`,
    dramaType: drama.category,
    score: drama.score,
    year: drama.year,
    area: drama.area,
    access,
    accessMode: policy.access_mode,
    freeEpisodes: policy.free_episodes,
    trialSeconds: policy.trial_seconds,
    singlePrice: policy.single_price_cny,
  }
}

/** 资料完整度（个人中心引导用）。 */
function profileCompletion(user) {
  const fields = [
    ['avatar', '头像'], ['nickname', '昵称'], ['birthday', '生日'],
    ['gender', '性别'], ['bio', '个人简介'], ['password_hash', '登录密码'],
  ]
  const filled = fields.filter(([key]) => Boolean(user?.[key])).length
  return {
    filled,
    total: fields.length,
    percent: Math.round((filled / fields.length) * 100),
    missing: fields.filter(([key]) => !user?.[key]).map(([, label]) => label),
  }
}

/** 一次性取出用户的订阅与单片所有权，供列表批量判定。 */
function userContext(userId) {
  if (!userId) return { subscription: undefined, purchase: new Set() }
  const subscription = one(`SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active'
    AND datetime(valid_to) > datetime('now') ORDER BY datetime(valid_to) DESC LIMIT 1`, userId)
  const purchases = new Set(all(`SELECT drama_id FROM purchases WHERE user_id = ? AND status = 'active'
    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`, userId).map((row) => row.drama_id))
  return { subscription, purchase: purchases }
}

const readBody = (req) => new Promise((resolve) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 4e6) req.destroy() })
  req.on('end', () => {
    if (!raw) return resolve({})
    try { resolve(JSON.parse(raw)) } catch { resolve({}) }
  })
})

const clientIp = (req) => clientIpOf(req)

export async function handlePublic(pathname, url, req, res) {
  const auth = authOf(req)
  const userId = auth?.role === 'user' ? auth.sub : undefined
  const context = userContext(userId)
  const method = req.method

  /**
   * 登录门禁：浏览类接口公开（分享链接、搜索、榜单是免费流量入口），
   * 播放/权益/订单/个人中心必须登录。未登录用户看详情→点播放时才撞登录墙。
   */
  const OPEN_PATHS = new Set([
    '/api/constants', '/api/home', '/api/feed', '/api/auth/login', '/api/category', '/api/rank',
    '/api/search', '/api/tags', '/api/auth/email/send', '/api/auth/email/login', '/api/auth/email/password',
    '/api/track',
    // 模拟收银台在独立标签页，带不了 Bearer：靠一次性 HMAC 支付票据校验，见 mayPay()
    '/api/pay/mock', '/api/pay/alipay-sim',
  ])
  const OPEN_PREFIXES = ['/api/drama/', '/api/category/', '/api/tags/']
  // 只有支付宝服务端回调是公开的（自带 RSA2 验签）；其余回调一律留在内网/进程内
  const isOpen = OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((p) => pathname.startsWith(p)) || pathname === '/api/notify/alipay'
  if (!isOpen && !userId) {
    return fail(res, '0401', '登录后才可播放与查看个人内容', 401)
  }

  try {
    /* ---------- 基础 ---------- */
    if (pathname === '/api/constants') {
      const channels = paymentOptions('all')
      const live = channels.filter((channel) => channel.usable)
      const site = getSetting('site', {}) ?? {}
      // 会员价优先取在售套餐里的最低月价，避免运营忘配 settings.site 时收银台显示「元/月」
      const plan = all("SELECT price_cny, duration_days FROM plans WHERE status = 'active' ORDER BY price_cny ASC LIMIT 1")[0]
      const planMonthly = plan ? (Number(plan.price_cny) / Math.max(1, Number(plan.duration_days) / 30)).toFixed(2) : ''
      return send(res, {
        site: { name: '影巢' },
        supportEmail: process.env.MH_SUPPORT_EMAIL || site.supportEmail || '',
        vipPrice: site.vipPrice ?? (plan ? Number(plan.price_cny).toFixed(2) : ''),
        vipMonthlyPrice: planMonthly,
        vipUnit: site.vipUnit ?? '元/月',
        categories: [
          { code: 'TV', name: '电视剧' }, { code: 'MOVIE', name: '电影' },
          { code: 'PLAYLET', name: '短剧' }, { code: 'VARIETY', name: '综艺' },
        ],
        pay: {
          channels,
          alipay: live.some((channel) => channel.code === 'alipay'),
          usdt: live.some((channel) => channel.code === 'usdt'),
          mock: live.some((channel) => channel.code === 'mock'),
          usdtNetwork: 'TRC20',
          defaultChannel: live.find((channel) => channel.isDefault)?.code ?? live[0]?.code ?? null,
        },
        auth: {
          method: 'email',
          codeLength: 6,
          ttlSeconds: 300,
          resendSeconds: 60,
          maxAttempts: 3,
          passwordLogin: true,
        },
      })
    }

    if (pathname === '/api/home') {
      const banners = all('SELECT * FROM banners WHERE enabled = 1 ORDER BY sort').map((banner) => ({
        name: banner.name, title: banner.title, image: banner.image, targetDramaId: banner.target_drama_id,
      }))
      const sections = all('SELECT * FROM sections WHERE enabled = 1 ORDER BY sort').map((section) => ({
        id: section.id,
        title: section.title,
        items: all(`SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? AND d.status = 'published' ORDER BY si.sort LIMIT 30`, section.id)
          .map((drama) => cardOf(drama, userId, context)),
      }))
      const hot = all("SELECT title FROM dramas ORDER BY score DESC LIMIT 8").map((row) => row.title)
      return send(res, { banners, sections, hotwords: hot })
    }

    if (pathname === '/api/category') {
      const type = url.searchParams.get('type') ?? 'TV'
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1))
      const pageSize = Math.min(60, Number(url.searchParams.get('pageSize') ?? 24))
      const rows = all("SELECT * FROM dramas WHERE status = 'published' AND category = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        type, pageSize, (page - 1) * pageSize)
      const total = one("SELECT COUNT(*) AS n FROM dramas WHERE status = 'published' AND category = ?", type).n
      return send(res, { page, pageSize, total, list: rows.map((drama) => cardOf(drama, userId, context)) })
    }

    if (pathname === '/api/rank') {
      const type = url.searchParams.get('type') ?? 'HOT'
      const lists = all('SELECT name, type FROM rank_lists ORDER BY sort').map((row) => ({ name: row.name, type: row.type }))
      const list = one('SELECT * FROM rank_lists WHERE type = ? ORDER BY sort LIMIT 1', type)
      if (!list) return send(res, { type, listName: '', lists, items: [] })
      const items = all(`SELECT d.*, ri.rank_no FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id
        WHERE ri.list_id = ? ORDER BY ri.rank_no`, list.id)
        .map((drama) => ({ ...cardOf(drama, userId, context), rankNo: drama.rank_no }))
      return send(res, { type, listName: list.name, lists, items })
    }

    /* 「换一换」：按分区随机重排；无分区参数时全站随机 */
    if (pathname === '/api/feed') {
      const sectionId = Number(url.searchParams.get('section') ?? 0)
      if (sectionId) {
        const items = all(`SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? AND d.status = 'published' ORDER BY RANDOM() LIMIT 12`, sectionId)
          .map((drama) => cardOf(drama, userId, context))
        if (items.length > 1) return send(res, { sectionId, items })
      }
      const items = all("SELECT * FROM dramas WHERE status = 'published' ORDER BY RANDOM() LIMIT 12")
        .map((drama) => cardOf(drama, userId, context))
      return send(res, { sectionId, items })
    }

    if (pathname === '/api/search') {
      const keyword = (url.searchParams.get('keyword') ?? '').trim()
      const tagId = Number(url.searchParams.get('tag') ?? url.searchParams.get('tagId') ?? 0)
      const where = ["status = 'published'"]
      const params = []
      // 标签与关键词可以叠加：标签缩小集合，关键词在集合内再筛（原来两者互斥，搜标签名搜不到片）
      if (tagId) {
        where.push('id IN (SELECT drama_id FROM drama_tags WHERE tag_id = ?)')
        params.push(tagId)
      }
      if (keyword) {
        where.push('(title LIKE ? OR sub_title LIKE ? OR description LIKE ?)')
        params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
      }
      if (where.length === 1) return send(res, { keyword, tagId, total: 0, list: [] })
      const clause = where.join(' AND ')
      const total = one(`SELECT COUNT(*) AS n FROM dramas WHERE ${clause}`, ...params).n
      const rows = all(`SELECT * FROM dramas WHERE ${clause} ORDER BY score DESC LIMIT 60`, ...params)
      return send(res, { keyword, tagId, total, list: rows.map((drama) => cardOf(drama, userId, context)) })
    }

    if (pathname === '/api/tags') {
      return send(res, { list: listTags({ withCount: true }) })
    }

    /* ---------- 详情 / 权益 ---------- */
    if (pathname.startsWith('/api/drama/')) {
      const dramaId = Number(pathname.split('/')[3])
      const drama = one('SELECT * FROM dramas WHERE id = ?', dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)
      const policy = policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0, purchase_kind: 'single' }
      const episodes = all('SELECT id, no, title, duration, status, hls_path FROM episodes WHERE drama_id = ? ORDER BY no', drama.id)
      const purchase = context.purchase.has(drama.id) ? one(`SELECT * FROM purchases WHERE user_id = ? AND drama_id = ? AND status = 'active'
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) ORDER BY id DESC LIMIT 1`, userId, drama.id) : undefined
      const decided = decideEpisodes({ drama, policy, subscription: context.subscription, purchase, episodes })
      // 收藏态与观看进度：详情页要靠这两个字段渲染「✓ 已收藏」「继续观看第 N 集」，
      // 否则前端只能再打一次 /api/me，多一轮请求且首屏会闪。
      const favorite = userId ? one('SELECT 1 AS x FROM favorites WHERE user_id = ? AND drama_id = ?', userId, drama.id) : undefined
      const resume = userId ? one('SELECT episode_no, position, updated_at FROM history WHERE user_id = ? AND drama_id = ?', userId, drama.id) : undefined
      return send(res, {
        ...cardOf(drama, userId, context),
        description: drama.description,
        episodes: decided.map((episode) => ({
          id: episode.id, no: episode.no, title: episode.title, duration: episode.duration,
          status: episode.status, allow: episode.allow, source: episode.source,
          trialSeconds: episode.trialSeconds, price: episode.price,
        })),
        priceInfo: priceInfo(drama),
        tags: tagsOfDrama(drama.id).map((tag) => ({ id: tag.id, name: tag.name })),
        hasSubscription: Boolean(context.subscription),
        favorited: Boolean(favorite),
        resumeEpisodeNo: resume?.episode_no ?? null,
        resumePosition: resume?.position ?? null,
        resumeUpdatedAt: resume?.updated_at ?? null,
      })
    }

    if (pathname.startsWith('/api/access/')) {
      const [, , , dramaId, no] = pathname.split('/')
      return send(res, resolveAccess(userId, Number(dramaId), Number(no)))
    }

    /* ---------- 播放：签发短时链接 ---------- */
    if (pathname.startsWith('/api/play/')) {
      const [, , , dramaIdRaw, noRaw] = pathname.split('/')
      const dramaId = Number(dramaIdRaw)
      const no = Number(noRaw ?? 1)
      const drama = one('SELECT * FROM dramas WHERE id = ?', dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)
      const episode = one('SELECT * FROM episodes WHERE drama_id = ? AND no = ?', dramaId, no)
      if (!episode) return fail(res, '0404', '该集不存在', 404)
      if (!episode.hls_path || episode.status !== 'ready') {
        // 转码中/失败的集不能签发空链接：前端要能区分「还没好」和「没权限」
        return send(res, {
          dramaId, episodeId: episode.id, episodeStatus: episode.status, reason: 'episode_not_ready',
          message: episode.status === 'error' ? '该集片源处理失败，请稍后再试' : '该集片源正在处理中，请稍后再试',
        }, '0409', '该集片源尚未就绪', 409)
      }

      const access = resolveAccess(userId, dramaId, no)
      const trialWanted = url.searchParams.get('trial') === '1'
      if (!access.allow && access.trialSeconds > 0 && trialWanted) {
        // 试看：签名有效期必须覆盖试看时长，否则前端按 trialSeconds 截断前就先被 403 断流
        const trialHls = episode.hls_path ?? `/media/hls/${episode.id}/index.m3u8`
        const ua = req.headers['user-agent'] ?? ''
        const trialTtl = Math.min(PLAY_TTL_MAX, Math.max(120, Number(access.trialSeconds) + 60))
        const trialLink = episode.hls_path ? secureLink(trialHls, trialTtl, ua) : { url: null, sign: null, expires: 0 }
        if (episode.hls_path) setLinkCookies(res, trialLink, trialTtl, req, episode.id)
        recordPlay({ userId, dramaId, episodeId: episode.id, episodeNo: no, source: 'trial', ip: clientIp(req), ua: req.headers['user-agent'] })
        return send(res, {
          dramaId, title: drama.title, episodeId: episode.id, episodeStatus: episode.status,
          episode: { id: episode.id, no: episode.no, title: episode.title },
          source: 'trial', hls: episode.hls_path, expiresIn: trialTtl, trialSeconds: access.trialSeconds, danmu: [],
        })
      }
      if (!access.allow) {
        return send(res, {
          reason: access.reason,
          trialSeconds: access.trialSeconds ?? 0,
          price: access.price ?? 0,
          purchaseKind: access.purchaseKind ?? 'single',
          plans: access.plans ?? [],
          membership: access.membership ?? false,
        }, '0402', access.reason === 'single_purchase_required' ? '该片需单独购买' : '需要开通会员', 402)
      }
      const hlsPath = episode.hls_path ?? null
      const ua = req.headers['user-agent'] ?? ''
      // 有效期覆盖整集时长（否则 45 分钟一集在 5 分钟处断流），上限 MH_PLAY_TTL_MAX
      const duration = Number(episode.duration ?? 0)
      const playTtl = Math.min(PLAY_TTL_MAX, Math.max(LINK_TTL, duration > 0 ? duration + 300 : LINK_TTL))
      const link = hlsPath ? secureLink(hlsPath, playTtl, ua) : { url: null, sign: null, expires: 0 }
      if (hlsPath) setLinkCookies(res, link, playTtl, req, episode.id)
      recordPlay({ userId, dramaId, episodeId: episode.id, episodeNo: no, source: 'play', ip: clientIp(req), ua: req.headers['user-agent'] })
      const danmu = all("SELECT time_ms, content FROM danmus WHERE episode_id = ? AND status = 'approved' ORDER BY time_ms", episode.id)
      // 续播：该用户在该集的已看进度；连播：下一集集号（同剧存在即给）
      const resume = one('SELECT position FROM history WHERE user_id = ? AND drama_id = ? AND episode_no = ?', userId, dramaId, no)
      const nextEp = one('SELECT no FROM episodes WHERE drama_id = ? AND no > ? ORDER BY no LIMIT 1', dramaId, no)
      return send(res, {
        dramaId, title: drama.title, episodeId: episode.id, episodeStatus: episode.status,
        episode: { id: episode.id, no: episode.no, title: episode.title },
        source: access.source,
        hls: hlsPath,
        expiresIn: playTtl,
        trialSeconds: 0,
        resumePosition: Number(resume?.position ?? 0),
        nextEpisodeNo: nextEp ? nextEp.no : null,
        danmu: danmu.map((row) => ({ time: row.time_ms, text: row.content })),
      })
    }

    /* ---------- 套餐 / 优惠券 / 下单 ---------- */
    if (pathname === '/api/plans') {
      const plans = all("SELECT * FROM plans WHERE status = 'active' ORDER BY sort").map((plan) => ({
        id: plan.id, code: plan.code, name: plan.name, price: plan.price_cny,
        days: plan.duration_days, scope: plan.scope, description: plan.description,
      }))
      return send(res, { plans, currency: 'CNY' })
    }

    if (pathname === '/api/coupons/validate' && method === 'POST') {
      const body = await readBody(req)
      return send(res, validateCoupon(body.code, Number(body.amount ?? 0)))
    }

    if (pathname === '/api/orders' && method === 'POST') {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      const body = await readBody(req)
      // 不传 channel 时由后端按"场景默认渠道"解析（后台可切换默认渠道）
      const channel = body.channel ?? undefined
      const result = createOrder({
        userId,
        productType: body.productType === 'single' ? 'single' : 'subscription',
        planId: Number(body.planId ?? 0) || undefined,
        dramaId: Number(body.dramaId ?? 0) || undefined,
        channel,
        couponCode: body.couponCode,
      })
      // 模拟收银台是独立标签页，带不了 Bearer → 用一次性票据换取支付权限
      const simTicket = result.payUrl && result.simulated ? signPayTicket(result.order.out_trade_no) : null
      return send(res, {
        outTradeNo: result.order.out_trade_no,
        amount: result.order.amount_cny,
        channel: result.order.channel,
        status: result.order.status,
        expiresAt: result.order.expires_at,
        payUrl: simTicket ? `${result.payUrl}?ticket=${encodeURIComponent(simTicket)}` : result.payUrl,
        simulated: result.simulated ?? false,
        usdt: result.usdt ?? null,
      })
    }

    if (pathname === '/api/orders' && method === 'GET') {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      return send(res, { list: listOrders({ userId, limit: 50 }) })
    }

    if (pathname.startsWith('/api/orders/')) {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      const outTradeNo = pathname.split('/')[3]
      let order = one('SELECT * FROM orders WHERE out_trade_no = ? AND user_id = ?', outTradeNo, userId)
      if (!order) return fail(res, '0404', '订单不存在', 404)
      // 支付宝查单兜底：回调可能丢失，轮询时主动向渠道确认一次
      if (order.channel === 'alipay' && ['created', 'pending'].includes(order.status)) {
        const sync = await syncAlipayOrder(outTradeNo).catch(() => ({ synced: false }))
        if (sync.synced) order = one('SELECT * FROM orders WHERE id = ?', order.id)
      }
      const payable = payUrlFor(order)
      // 模拟收银台在独立标签页打开，拿不到 Bearer：给订单签一张短时票据放进 payUrl
      const simTicket = payable.payUrl && payable.simulated ? signPayTicket(order.out_trade_no) : null
      const payUrl = simTicket ? `${payable.payUrl}?ticket=${encodeURIComponent(simTicket)}` : payable.payUrl
      return send(res, {
        outTradeNo: order.out_trade_no, status: order.status, amount: order.amount_cny,
        channel: order.channel, paidAt: order.paid_at, expiresAt: order.expires_at,
        payUrl, simulated: Boolean(payable.simulated), payReason: payable.reason ?? null,
        usdt: order.usdt_amount ? {
          amount: order.usdt_amount, rate: order.usdt_rate, address: order.usdt_address, confirmations: order.usdt_confirmations,
        } : null,
      })
    }

    /* ---------- 支付回调 ---------- */
    if (pathname === '/api/notify/alipay' && method === 'POST') {
      const raw = await new Promise((resolve) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => resolve(body))
      })
      const params = Object.fromEntries(new URLSearchParams(raw))
      const result = handleAlipayNotify(params)
      return send(res, result)
    }

    /* USDT 只走进程内链上监听（usdt-watch.mjs），不提供公网回调入口 */

    /* 模拟支付：仅本地/联调可用（MH_ALLOW_SIM_PAY=1），只能是本人订单或用支付票据（sim 收银台在独立标签页，带不了 Bearer） */
    const simPayEnabled = process.env.MH_ALLOW_SIM_PAY === '1'
    const ownOrder = (outTradeNo) => {
      const row = one('SELECT id, user_id FROM orders WHERE out_trade_no = ?', String(outTradeNo ?? ''))
      if (!row) return false
      return Number(row.user_id) === Number(userId)
    }
    const mayPay = (body) => ownOrder(body.outTradeNo) || verifyPayTicket(body.outTradeNo, body.ticket)

    if (pathname === '/api/pay/mock' && method === 'POST') {
      if (!simPayEnabled) return fail(res, '0404', '接口不存在', 404)
      const body = await readBody(req)
      if (!mayPay(body)) return fail(res, '0403', '支付票据无效或已过期', 403)
      return send(res, mockPay(body.outTradeNo))
    }

    /* 支付宝模拟收银台：用真实 RSA2 签名通知 → 走同一套验签入账 */
    if (pathname.startsWith('/api/pay/alipay-sim') && method === 'POST') {
      if (!simPayEnabled) return fail(res, '0404', '接口不存在', 404)
      const body = await readBody(req)
      if (!mayPay(body)) return fail(res, '0403', '支付票据无效或已过期', 403)
      const { params } = buildSimulatedAlipayNotify(body.outTradeNo)
      const result = handleAlipayNotify(params, { simulator: true })
      return send(res, { ...result, simulated: true })
    }

    /* 消息中心：订单/权益/到期提醒 */
    if (pathname === '/api/me/messages') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const messages = []
      const subscription = one(`SELECT s.*, p.name AS plan_name FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = ? AND s.status = 'active' ORDER BY datetime(s.valid_to) DESC LIMIT 1`, userId)
      if (subscription) {
        const daysLeft = Math.ceil((new Date(`${subscription.valid_to}Z`).getTime() - Date.now()) / 86400000)
        messages.push({
          type: 'subscription', title: `会员${daysLeft >= 0 ? '生效中' : '已到期'}`,
          body: `${subscription.plan_name ?? '会员'}，有效期至 ${subscription.valid_to}${daysLeft <= 7 ? `（剩 ${daysLeft} 天，建议续费）` : ''}`,
          createdAt: subscription.created_at,
        })
      }
      const ORDER_STATUS_TEXT = {
        created: '待支付', pending: '支付确认中', paid: '已支付', fulfilled: '已完成',
        closed: '已关闭', failed: '支付失败', refunded: '已退款', refunding: '退款中', refund_pending: '退款待审',
      }
      for (const order of listOrders({ userId, limit: 5 })) {
        messages.push({
          type: 'order', title: `订单 ${order.out_trade_no}`,
          body: `${order.product_type === 'subscription' ? '会员订阅' : '单片购买'} ¥${Number(order.amount_cny).toFixed(2)} · ${ORDER_STATUS_TEXT[order.status] ?? order.status}`,
          createdAt: order.created_at,
        })
      }
      return send(res, { messages })
    }

    /* ---------- 邮箱验证码认证（登录/注册一体） ---------- */
    if (pathname === '/api/auth/email/send' && method === 'POST') {
      const body = await readBody(req)
      const result = await sendCode({
        email: body.email,
        purpose: 'login',
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      })
      return send(res, {
        email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter,
        delivered: result.delivered,
      })
    }

    if (pathname === '/api/auth/email/login' && method === 'POST') {
      const body = await readBody(req)
      verifyCode({ email: body.email, purpose: 'login', code: body.code })
      const result = loginByEmail(body.email, { nickname: body.nickname })
      return send(res, {
        token: result.token,
        expiresAt: result.expiresAt,
        created: result.created,
        user: publicUser(result.user),
      })
    }

    // 邮箱 + 密码登录：已经设置过密码的用户在邮件通道异常时仍可登录
    if (pathname === '/api/auth/email/password' && method === 'POST') {
      const body = await readBody(req)
      const email = normalizeEmail(body.email)
      const user = one('SELECT * FROM users WHERE email = ?', email)
      if (!user || !user.password_hash) return fail(res, '0401', '邮箱或密码不正确', 401)
      if (!verifyPassword(String(body.password ?? ''), user.password_salt, user.password_hash)) {
        return fail(res, '0401', '邮箱或密码不正确', 401)
      }
      if (user.status && user.status !== 'active') return fail(res, '0403', '账号已被停用', 403)
      const result = loginByEmail(email)
      return send(res, { token: result.token, expiresAt: result.expiresAt, created: false, user: publicUser(result.user) })
    }

    // 手机号登录已下线（系统统一走邮箱验证码）
    if (pathname === '/api/auth/login' && method === 'POST') {
      return fail(res, '0410', '系统已改为邮箱验证码登录，请使用 /api/auth/email/send', 410)
    }

    /* ---------- 修改密码 ---------- */
    if (pathname === '/api/auth/password/send' && method === 'POST') {
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      if (!user?.email) return fail(res, '0400', '当前账号未绑定邮箱', 400)
      const body = await readBody(req)
      const email = String(body.email ?? user.email).trim().toLowerCase()
      if (email !== user.email) return fail(res, '0403', '只能向注册邮箱发送验证码', 403)
      const result = await sendCode({ email, purpose: 'change_password', ip: clientIp(req), userAgent: req.headers['user-agent'] })
      return send(res, { email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter })
    }

    if (pathname === '/api/auth/password/change' && method === 'POST') {
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      const body = await readBody(req)
      if (String(body.email ?? '').trim().toLowerCase() !== user?.email) {
        return fail(res, '0403', '邮箱与当前账号不一致', 403)
      }
      // 先校验口令强度，再消费验证码：避免"密码不合规"把验证码浪费掉
      const strength = checkPasswordStrength(body.newPassword)
      if (!strength.ok) return fail(res, 'password_weak', strength.message, 400)
      verifyCode({ email: user.email, purpose: 'change_password', code: body.code })
      setUserPassword(userId, body.newPassword)
      // 改密后吊销该账号此前签发的全部会话，避免旧 token 继续可用
      revokeSessions(userId, 'user')
      const fresh = issueToken(userId, 'user')
      return send(res, { ok: true, message: '密码已更新，其他设备需重新登录', token: fresh.token, expiresAt: fresh.expiresAt })
    }

    /* ---------- 更换邮箱 ---------- */
    if (pathname === '/api/auth/email/send-change' && method === 'POST') {
      const body = await readBody(req)
      const newEmail = normalizeEmail(body.newEmail ?? body.email)
      const taken = one('SELECT id FROM users WHERE email = ? AND id != ?', newEmail, userId)
      if (taken) return fail(res, '0409', '该邮箱已被其他账号使用', 409)
      const result = await sendCode({ email: newEmail, purpose: 'change_email', ip: clientIp(req), userAgent: req.headers['user-agent'] })
      return send(res, { email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter })
    }

    if (pathname === '/api/auth/email/change' && method === 'POST') {
      const body = await readBody(req)
      const newEmail = normalizeEmail(body.newEmail ?? body.email)
      verifyCode({ email: newEmail, purpose: 'change_email', code: body.code })
      const updated = changeUserEmail(userId, newEmail)
      revokeSessions(userId, 'user')
      const fresh = issueToken(userId, 'user')
      return send(res, { ok: true, user: publicUser(updated), token: fresh.token, expiresAt: fresh.expiresAt })
    }

    /* ---------- 个人中心 ---------- */
    if (pathname === '/api/me/profile' && method === 'PUT') {
      const body = await readBody(req)
      const updated = updateProfile(userId, body)
      return send(res, { ok: true, user: publicUser(updated) })
    }

    if (pathname === '/api/me/avatar' && method === 'POST') {
      const body = await readBody(req)
      const dataUrl = String(body.dataUrl ?? '')
      const match = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      if (!match) return fail(res, '0400', '头像格式需为 PNG / JPEG / WebP', 400)
      const buffer = Buffer.from(match[3], 'base64')
      if (buffer.length > 1024 * 1024) return fail(res, '0413', '头像不能超过 1MB', 413)
      const ext = match[2] === 'jpeg' ? 'jpg' : match[2]
      const dir = join(ROOT, 'storage', 'images', 'avatars')
      mkdirSync(dir, { recursive: true })
      const name = `avatar-${userId}-${Date.now()}.${ext}`
      writeFileSync(join(dir, name), buffer)
      const avatar = `/media/images/avatars/${name}`
      const updated = updateProfile(userId, { avatar })
      return send(res, { ok: true, avatar, user: publicUser(updated) })
    }

    /* 弹幕：发送后进入待审，审核通过才展示 */
    if (pathname === '/api/danmu' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const episode = one('SELECT * FROM episodes WHERE id = ?', Number(body.episodeId))
      if (!episode) return fail(res, '0404', '分集不存在', 404)
      const content = String(body.content ?? '').trim().slice(0, 60)
      if (!content) return fail(res, '0400', '弹幕内容不能为空', 400)
      db.prepare("INSERT INTO danmus (episode_id, user_id, time_ms, content, status) VALUES (?, ?, ?, ?, 'pending')")
        .run(episode.id, userId, Math.max(0, Math.round(Number(body.timeMs ?? 0))), content)
      return send(res, { ok: true, status: 'pending', message: '已提交，审核通过后展示' })
    }

    /* 行为埋点：匿名的曝光/详情也收，用于算漏斗上游（只收白名单类型） */
    if (pathname === '/api/track' && method === 'POST') {
      const body = await readBody(req)
      const ok = recordEvent({
        type: body.type, userId, dramaId: body.dramaId, episodeId: body.episodeId,
        path: body.path ?? body.term, value: body.value, position: body.position, duration: body.duration,
        meta: body.meta, ip: clientIp(req), ua: req.headers['user-agent'],
      })
      return send(res, { ok })
    }

    if (pathname === '/api/me') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      const { subscription, purchases } = entitlementsOf(userId)
      const history = all(`SELECT h.*, d.title, d.cover_url FROM history h JOIN dramas d ON d.id = h.drama_id
        WHERE h.user_id = ? ORDER BY h.updated_at DESC LIMIT 12`, userId)
      const favorites = all(`SELECT d.* FROM favorites f JOIN dramas d ON d.id = f.drama_id WHERE f.user_id = ? ORDER BY f.created_at DESC`, userId)
      return send(res, {
        user: publicUser(user),
        subscription: subscription ? { planId: subscription.plan_id, scope: subscription.scope, validTo: subscription.valid_to } : null,
        purchases: purchases.map((row) => ({ dramaId: row.drama_id, title: row.title, kind: row.kind, expiresAt: row.expires_at })),
        history: history.map((row) => ({ dramaId: row.drama_id, episode: row.episode_no, position: row.position, title: row.title, coverUrl: row.cover_url })),
        favorites: favorites.map((drama) => cardOf(drama, userId, context)),
        completion: profileCompletion(user),
      })
    }

    if (pathname === '/api/me/history' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      db.prepare(`INSERT INTO history (user_id, drama_id, episode_no, position) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, drama_id) DO UPDATE SET episode_no = excluded.episode_no,
        position = excluded.position, updated_at = datetime('now')`)
        .run(userId, Number(body.seasonId ?? body.dramaId), Number(body.episode ?? 1), Number(body.position ?? 0))
      return send(res, { ok: true })
    }

    if (pathname === '/api/me/favorite' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const dramaId = Number(body.seasonId ?? body.dramaId)
      const existing = one('SELECT 1 AS x FROM favorites WHERE user_id = ? AND drama_id = ?', userId, dramaId)
      if (existing) db.prepare('DELETE FROM favorites WHERE user_id = ? AND drama_id = ?').run(userId, dramaId)
      else db.prepare('INSERT INTO favorites (user_id, drama_id) VALUES (?, ?)').run(userId, dramaId)
      return send(res, { favorited: !existing })
    }

    return fail(res, '0404', '接口不存在', 404)
  } catch (error) {
    if (error instanceof OtpError) return send(res, { ...error.extra }, error.code, error.message, error.status)
    if (error instanceof CommerceError) return fail(res, error.code, error.message, error.status)
    if (error?.code === 'password_weak' || error?.code === 'email_taken' || error?.code === 'user_banned' || error?.code === 'avatar_invalid') {
      return fail(res, error.code, error.message, 400)
    }
    console.error('[public]', error)
    return fail(res, '0500', '服务器错误', 500)
  }
}

export { markPaid }

