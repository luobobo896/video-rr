/** C 端接口：内容、权益判定、播放令牌、套餐下单、支付回调、我的。 */
import { db, getSetting } from './db.mjs'
import { authOf, loginUserByPhone } from './auth.mjs'
import {
  decideEpisodes, entitlementsOf, policyOf, priceInfo, resolveAccess, secureLink,
} from './entitlements.mjs'
import {
  CommerceError, createOrder, handleAlipayNotify, handleUsdtNotify, listOrders, markPaid, mockPay, paymentOptions, validateCoupon,
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
  req.on('data', (chunk) => { raw += chunk; if (raw.length > 1e6) req.destroy() })
  req.on('end', () => {
    if (!raw) return resolve({})
    try { resolve(JSON.parse(raw)) } catch { resolve({}) }
  })
})

export async function handlePublic(pathname, url, req, res) {
  const auth = authOf(req)
  const userId = auth?.role === 'user' ? auth.sub : undefined
  const context = userContext(userId)
  const method = req.method

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
      const channel = body.channel ?? (getSetting('pay', {}).mock?.enabled ? 'mock' : 'alipay')
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
      const order = one('SELECT * FROM orders WHERE out_trade_no = ? AND user_id = ?', outTradeNo, userId)
      if (!order) return fail(res, '0404', '订单不存在', 404)
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

    /* ---------- 登录 / 我的 ---------- */
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readBody(req)
      const phone = String(body.phone ?? '').trim()
      if (!/^1\d{10}$/.test(phone)) return fail(res, '0400', '手机号格式不正确')
      const result = loginUserByPhone(phone, body.nickname)
      return send(res, { token: result.token, expiresAt: result.expiresAt, user: { id: result.user.id, nickname: result.user.nickname, phone: result.user.phone } })
    }

    if (pathname === '/api/me') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const user = one('SELECT * FROM users WHERE id = ?', userId)
      const { subscription, purchases } = entitlementsOf(userId)
      const history = all(`SELECT h.*, d.title, d.cover_url FROM history h JOIN dramas d ON d.id = h.drama_id
        WHERE h.user_id = ? ORDER BY h.updated_at DESC LIMIT 12`, userId)
      const favorites = all(`SELECT d.* FROM favorites f JOIN dramas d ON d.id = f.drama_id WHERE f.user_id = ? ORDER BY f.created_at DESC`, userId)
      return send(res, {
        user: { id: user.id, nickname: user.nickname, phone: user.phone },
        subscription: subscription ? { planId: subscription.plan_id, scope: subscription.scope, validTo: subscription.valid_to } : null,
        purchases: purchases.map((row) => ({ dramaId: row.drama_id, title: row.title, kind: row.kind, expiresAt: row.expires_at })),
        history: history.map((row) => ({ dramaId: row.drama_id, episode: row.episode_no, position: row.position, title: row.title, coverUrl: row.cover_url })),
        favorites: favorites.map((drama) => cardOf(drama, userId, context)),
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
    if (error instanceof CommerceError) return fail(res, error.code, error.message, error.status)
    console.error('[public]', error)
    return fail(res, '0500', '服务器错误', 500)
  }
}

export { markPaid }
