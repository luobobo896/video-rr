/** C 端接口：内容、权益判定、播放令牌、套餐下单、支付回调、我的。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, getSetting, ROOT } from './db.mjs'
import {
  authOf, changeUserEmail, checkPasswordStrength, loginByEmail, publicUser, setUserPassword, updateProfile,
} from './auth.mjs'
import { OtpError, normalizeEmail, sendCode, verifyCode } from './otp.mjs'
import { isDevMail } from './mailer.mjs'
import {
  decideEpisodes, entitlementsOf, policyOf, priceInfo, resolveAccess, secureLink,
} from './entitlements.mjs'
import {
  CommerceError, createOrder, handleAlipayNotify, handleUsdtNotify, listOrders, markPaid, mockPay, paymentOptions, validateCoupon,
  buildSimulatedAlipayNotify, syncAlipayOrder,
} from './commerce.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

export function send(res, data, code = '0000', msg = 'Success', status = 200) {
  const body = JSON.stringify({ requestId: `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`, code, msg, data })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const fail = (res, code, msg, status = 400, extra = {}) => send(res, extra, code, msg, status)

/** 播放签名放 Cookie：HLS 播放器请求分片时不带 query，但会自动带 Cookie。 */
function setLinkCookies(res, link, ttl) {
  res.setHeader('set-cookie', [
    `mh_link=${link.sign}; Path=/; Max-Age=${ttl}; SameSite=Lax`,
    `mh_exp=${link.expires}; Path=/; Max-Age=${ttl}; SameSite=Lax`,
  ])
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

const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '').split(',')[0].trim().replace('::ffff:', '')

export async function handlePublic(pathname, url, req, res) {
  const auth = authOf(req)
  const userId = auth?.role === 'user' ? auth.sub : undefined
  const context = userContext(userId)
  const method = req.method

  /**
   * 登录门禁（新需求）：未登录只能看首页。
   * 例外：常量、首页、登录、支付回调（渠道服务器直接调，没有用户 token）。
   */
  const OPEN_PATHS = new Set(['/api/constants', '/api/home', '/api/auth/login', '/api/auth/email/send', '/api/auth/email/login'])
  const isOpen = OPEN_PATHS.has(pathname)
    || pathname.startsWith('/api/notify/')
    || pathname === '/api/pay/mock'
    || pathname.startsWith('/api/pay/alipay-sim')
  if (!isOpen && !userId) {
    return fail(res, '0401', '请先登录后再浏览和播放', 401)
  }

  try {
    /* ---------- 基础 ---------- */
    if (pathname === '/api/constants') {
      const channels = paymentOptions('all')
      return send(res, {
        site: { name: '影巢' },
        categories: [
          { code: 'TV', name: '电视剧' }, { code: 'MOVIE', name: '电影' },
          { code: 'PLAYLET', name: '短剧' }, { code: 'ANIME', name: '动漫' },
        ],
        pay: {
          channels,
          alipay: channels.some((channel) => channel.code === 'alipay'),
          usdt: channels.some((channel) => channel.code === 'usdt'),
          mock: channels.some((channel) => channel.code === 'mock'),
          usdtNetwork: channels.find((channel) => channel.code === 'usdt')?.currency === 'USDT' ? 'TRC20' : 'TRC20',
          defaultChannel: channels.find((channel) => channel.isDefault)?.code ?? channels[0]?.code ?? null,
        },
        auth: {
          method: 'email',
          codeLength: 6,
          ttlSeconds: 300,
          resendSeconds: 60,
          maxAttempts: 3,
          devCode: process.env.MH_EMAIL_DEV === '1' && isDevMail(),
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
          WHERE si.section_id = ? AND d.status = 'published' ORDER BY si.sort`, section.id)
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
      const list = one('SELECT * FROM rank_lists WHERE type = ? ORDER BY sort LIMIT 1', type)
      if (!list) return send(res, { listName: '', items: [] })
      const items = all(`SELECT d.*, ri.rank_no FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id
        WHERE ri.list_id = ? ORDER BY ri.rank_no`, list.id)
        .map((drama) => ({ ...cardOf(drama, userId, context), rankNo: drama.rank_no }))
      return send(res, { listName: list.name, items })
    }

    if (pathname === '/api/search') {
      const keyword = (url.searchParams.get('keyword') ?? '').trim()
      if (!keyword) return send(res, { keyword, total: 0, list: [] })
      const rows = all(`SELECT * FROM dramas WHERE status = 'published'
        AND (title LIKE ? OR sub_title LIKE ? OR description LIKE ?) ORDER BY score DESC LIMIT 30`,
      `%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
      return send(res, { keyword, total: rows.length, list: rows.map((drama) => cardOf(drama, userId, context)) })
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
      return send(res, {
        ...cardOf(drama, userId, context),
        description: drama.description,
        episodes: decided.map((episode) => ({
          id: episode.id, no: episode.no, title: episode.title, duration: episode.duration,
          status: episode.status, allow: episode.allow, source: episode.source,
          trialSeconds: episode.trialSeconds, price: episode.price,
        })),
        priceInfo: priceInfo(drama),
        hasSubscription: Boolean(context.subscription),
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

      const access = resolveAccess(userId, dramaId, no)
      const trialWanted = url.searchParams.get('trial') === '1'
      if (!access.allow && access.trialSeconds > 0 && trialWanted) {
        // 试看：仍签发短时链接，但前端按 trialSeconds 截断（服务端记录审计）
        const trialHls = episode.hls_path ?? `/media/hls/${episode.id}/index.m3u8`
        const trialLink = episode.hls_path ? secureLink(trialHls, 180) : { url: null, sign: null, expires: 0 }
        if (episode.hls_path) setLinkCookies(res, trialLink, 180)
        return send(res, {
          dramaId, title: drama.title, episode: { id: episode.id, no: episode.no, title: episode.title },
          source: 'trial', hls: episode.hls_path, expiresIn: 180, trialSeconds: access.trialSeconds, danmu: [],
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
      const link = hlsPath ? secureLink(hlsPath, 600) : { url: null, sign: null, expires: 0 }
      if (hlsPath) setLinkCookies(res, link, 600)
      const danmu = all("SELECT time_ms, content FROM danmus WHERE episode_id = ? AND status = 'approved' ORDER BY time_ms", episode.id)
      return send(res, {
        dramaId, title: drama.title, episode: { id: episode.id, no: episode.no, title: episode.title },
        source: access.source,
        hls: hlsPath,
        expiresIn: 600,
        trialSeconds: 0,
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
      return send(res, {
        outTradeNo: result.order.out_trade_no,
        amount: result.order.amount_cny,
        channel: result.order.channel,
        status: result.order.status,
        expiresAt: result.order.expires_at,
        payUrl: result.payUrl,
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
      return send(res, {
        outTradeNo: order.out_trade_no, status: order.status, amount: order.amount_cny,
        channel: order.channel, paidAt: order.paid_at, usdt: order.usdt_amount ? {
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

    if (pathname === '/api/notify/usdt' && method === 'POST') {
      const body = await readBody(req)
      return send(res, handleUsdtNotify({
        outTradeNo: body.outTradeNo, txid: body.txid, amount: body.amount, confirmations: body.confirmations,
      }))
    }

    if (pathname === '/api/pay/mock' && method === 'POST') {
      const body = await readBody(req)
      return send(res, mockPay(body.outTradeNo))
    }

    /* 支付宝模拟收银台：用真实 RSA2 签名通知 → 走同一套验签入账 */
    if (pathname.startsWith('/api/pay/alipay-sim') && method === 'POST') {
      const body = await readBody(req)
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
      for (const order of listOrders({ userId, limit: 5 })) {
        messages.push({
          type: 'order', title: `订单 ${order.out_trade_no}`,
          body: `${order.product_type === 'subscription' ? '会员订阅' : '单片购买'} ¥${Number(order.amount_cny).toFixed(2)} · ${order.status}`,
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
        delivered: result.delivered, devCode: result.devCode,
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
      return send(res, { email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter, devCode: result.devCode })
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
      return send(res, { ok: true, message: '密码已更新，请牢记新密码' })
    }

    /* ---------- 更换邮箱 ---------- */
    if (pathname === '/api/auth/email/send-change' && method === 'POST') {
      const body = await readBody(req)
      const newEmail = normalizeEmail(body.newEmail ?? body.email)
      const taken = one('SELECT id FROM users WHERE email = ? AND id != ?', newEmail, userId)
      if (taken) return fail(res, '0409', '该邮箱已被其他账号使用', 409)
      const result = await sendCode({ email: newEmail, purpose: 'change_email', ip: clientIp(req), userAgent: req.headers['user-agent'] })
      return send(res, { email: result.email, expiresIn: result.expiresIn, resendAfter: result.resendAfter, devCode: result.devCode })
    }

    if (pathname === '/api/auth/email/change' && method === 'POST') {
      const body = await readBody(req)
      const newEmail = normalizeEmail(body.newEmail ?? body.email)
      verifyCode({ email: newEmail, purpose: 'change_email', code: body.code })
      const updated = changeUserEmail(userId, newEmail)
      return send(res, { ok: true, user: publicUser(updated) })
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
