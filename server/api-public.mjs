/** C 端接口：内容、权益判定、播放令牌、套餐下单、支付回调、我的。 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { db, getSetting, ROOT } from './db.mjs'
import { adultMenuSettings } from './adult-menu.mjs'
import { adultVisibilitySql } from './content-visibility.mjs'
import { adultStatsFor } from './adult-stats.mjs'
import {
  authOf, changeUserEmail, checkPasswordStrength, issueToken, loginByEmail, publicUser, revokeSessions, revokeToken, setUserPassword,
  updateProfile, verifyPassword,
} from './auth.mjs'
import { OtpError, normalizeEmail, sendCode, verifyCode } from './otp.mjs'
import {
  LINK_TTL, decideEpisodes, entitlementsOf, policyOf, priceInfo, resolveAccess, rulesOfDrama, secureLink,
  signPayTicket, verifyPayTicket,
} from './entitlements.mjs'
import { publicTracksOf, saveUserTrackPreference, userTrackPreferences } from './tracks.mjs'
import { isClientTrackType, recordEvent, recordPlay } from './analytics.mjs'
import { bindUserAcquisition, recordTouch } from './attribution.mjs'
import {
  applyDistributor, bindReferral, createWithdrawalRequest, detectCurrency, distributionSummary,
  getOrCreateReferralCode, listCurrencies, listWithdrawals, payoutOptions, recordInviteClick,
} from './distribution.mjs'
import {
  CONTENT_RANK_TYPES, applyHeartbeat, contentRank, recordClick, startViewSession, toggleFavorite,
} from './content-stats.mjs'
import { clientIpOf } from './ratelimit.mjs'
import { logError, logWarn } from './logger.mjs'
import { listTags, tagsOfDrama } from './tags.mjs'
import { previewUrlForCover } from './previews.mjs'
import { posterWallPayload } from './poster-wall.mjs'
import { enumLabel, langFromRequest, localizedYearLabel, normalizeLang } from './i18n.mjs'
import {
  CommerceError, createOrder, handleAlipayNotify, listOrders, markPaid, mockPay, orderDto, paymentOptions, validateCoupon,
  buildSimulatedAlipayNotify, syncAlipayOrder, payUrlFor,
} from './commerce.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

/** 单次播放链接的最长有效期：覆盖整集时长，默认 2 小时（可用 MH_PLAY_TTL_MAX 调整）。 */
const PLAY_TTL_MAX = Math.max(LINK_TTL, Math.min(4 * 3600, Number(process.env.MH_PLAY_TTL_MAX ?? 7200) || 7200))

/* ---------- 「全部分类」筛选taxonomy：固定枚举，空库也有完整分类树 ---------- */
export const CATEGORY_CHANNELS = [
  { value: 'ALL', label: '全部' },
  { value: 'TV', label: '电视剧' },
  { value: 'MOVIE', label: '电影' },
  { value: 'PLAYLET', label: '短剧' },
  { value: 'ANIME', label: '动漫' },
  { value: 'VARIETY', label: '综艺' },
  { value: 'DOCUMENTARY', label: '纪录片' },
]
export const CATEGORY_SORTS = [
  { value: 'hot', label: '最热' },
  { value: 'new', label: '最新' },
  { value: 'score', label: '好评' },
  { value: 'discuss', label: '讨论最多' },
  { value: 'upcoming', label: '即将上线' },
]
/** 地区按 area 文本匹配；negate 的「其他」= 不属于任何已知地区 */
export const CATEGORY_REGIONS = [
  { value: 'US', label: '美国', areas: ['美国'] },
  { value: 'UK', label: '英国', areas: ['英国'] },
  { value: 'KR', label: '韩国', areas: ['韩国'] },
  { value: 'JP', label: '日本', areas: ['日本'] },
  { value: 'TH', label: '泰国', areas: ['泰国'] },
  { value: 'CN', label: '内地', areas: ['内地', '中国大陆', '中国'] },
  { value: 'HK', label: '中国香港', areas: ['中国香港', '香港'] },
  { value: 'TW', label: '中国台湾', areas: ['中国台湾', '台湾'] },
  { value: 'OTHER', label: '其他', areas: [], negate: true },
]
/** 类型按标签名匹配（值即标签名，一级标签会带上其子标签） */
export const CATEGORY_GENRES = [
  '剧情', '喜剧', '动作', '冒险', '爱情', '动画', '歌舞', '医疗', '科幻', '奇幻',
  '悬疑', '惊悚', '犯罪', '传记', '历史', '战争', '灾难', '美食', '真人秀', '脱口秀',
]
const CURRENT_YEAR = new Date().getFullYear() + 1
export const CATEGORY_YEARS = [
  { value: String(CURRENT_YEAR), label: String(CURRENT_YEAR), from: CURRENT_YEAR, to: CURRENT_YEAR },
  { value: String(CURRENT_YEAR - 1), label: String(CURRENT_YEAR - 1), from: CURRENT_YEAR - 1, to: CURRENT_YEAR - 1 },
  { value: String(CURRENT_YEAR - 2), label: String(CURRENT_YEAR - 2), from: CURRENT_YEAR - 2, to: CURRENT_YEAR - 2 },
  { value: String(CURRENT_YEAR - 3), label: String(CURRENT_YEAR - 3), from: CURRENT_YEAR - 3, to: CURRENT_YEAR - 3 },
  { value: String(CURRENT_YEAR - 4), label: String(CURRENT_YEAR - 4), from: CURRENT_YEAR - 4, to: CURRENT_YEAR - 4 },
  { value: String(CURRENT_YEAR - 5), label: String(CURRENT_YEAR - 5), from: CURRENT_YEAR - 5, to: CURRENT_YEAR - 5 },
  { value: '2011-2020', label: '2011—2020', from: 2011, to: 2020 },
  { value: '2000-2010', label: '2000—2010', from: 2000, to: 2010 },
  { value: '1990s', label: '90年代', from: 1990, to: 1999 },
  { value: '1980s', label: '80年代', from: 1980, to: 1989 },
]

export function send(res, data, code = '0000', msg = 'Success', status = 200, cacheControl = 'no-store') {
  const requestId = String(res.getHeader?.('x-request-id') ?? `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`)
  if (code !== '0000') logWarn('http.api_error', { requestId, code, msg, status })
  const body = JSON.stringify({ requestId, code, msg, data })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl })
  res.end(body)
}

/** 公开聚合接口允许浏览器短缓存：返回箭头时不用再等一个来回，10 秒内的内容变化对观众无感。
 *  private：这些响应里带登录态字段（owned/access），不能被共享缓存复用。 */
const PUBLIC_CACHE = 'private, max-age=10, stale-while-revalidate=30'
const sendPublic = (res, data) => send(res, data, '0000', 'Success', 200, PUBLIC_CACHE)

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
  const lang = context.lang ?? 'zh'
  return {
    dramaId: drama.id,
    title: drama.title,
    subTitle: drama.sub_title,
    coverUrl: drama.cover_url || `/media/placeholder.svg?t=${encodeURIComponent(drama.title ?? '')}`,
    dramaType: drama.category,
    dramaTypeLabel: enumLabel(lang, 'category', drama.category),
    isAdult: Boolean(drama.is_adult),
    releaseDate: drama.release_date ?? null,
    updatedAt: drama.updated_at ?? null,
    stats: drama.adult_stats ?? null,
    score: drama.score,
    year: drama.year,
    area: drama.area,
    areaLabel: enumLabel(lang, 'area', drama.area, drama.area),
    access,
    accessLabel: enumLabel(lang, 'access', access),
    accessMode: policy.access_mode,
    freeEpisodes: policy.free_episodes,
    trialSeconds: policy.trial_seconds,
    singlePrice: policy.single_price_cny,
    playCount: Number(drama.play_count ?? 0),
    previewUrl: previewUrlForCover(drama.cover_url),
    // 参考站海报左上角有「最新上线 / 独播 / 正在热播」角标：这里只发可判定的「最新上线」
    // （created_at 是 datetime('now') 的 UTC 文本，直接按字符串比较即可，30 天内算新）
    isNew: String(drama.created_at ?? '') >= new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' '),
  }
}

/** 批量补播放量（列表排序与"最多播放"筛选要用，避免 N+1）。 */
function withPlayCounts(rows) {
  if (!rows.length) return rows
  const ids = rows.map((row) => row.id)
  const marks = ids.map(() => '?').join(',')
  const counts = new Map(all(`SELECT drama_id, COUNT(*) AS n FROM play_events WHERE drama_id IN (${marks}) GROUP BY drama_id`, ...ids)
    .map((row) => [row.drama_id, Number(row.n)]))
  return rows.map((row) => ({ ...row, play_count: counts.get(row.id) ?? 0 }))
}

function wideArtworkForCover(coverUrl) {
  const slug = /\/cover-([^/?.]+)\.jpg(?:\?.*)?$/i.exec(String(coverUrl ?? ''))?.[1]
  if (!slug) return null
  return existsSync(join(ROOT, 'storage', 'images', `banner-${slug}.jpg`))
    ? `/media/images/banner-${slug}.jpg`
    : null
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

const readBody = (req, limit = 4e6) => new Promise((resolve, reject) => {
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

const readRawBody = (req, limit = 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  let settled = false
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    fn(value)
  }
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > limit) {
      finish(reject, Object.assign(new Error('头像不能超过 1MB'), { code: '0413', status: 413 }))
      req.pause()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => finish(resolve, Buffer.concat(chunks)))
  req.on('error', (error) => finish(reject, error))
})

const clientIp = (req) => clientIpOf(req)

function cookieValue(req, name) {
  const raw = String(req.headers?.cookie ?? '')
  const found = raw.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))
  return found ? decodeURIComponent(found.slice(name.length + 1)) : ''
}

export async function handlePublic(pathname, url, req, res) {
  const auth = authOf(req)
  const userId = auth?.role === 'user' ? auth.sub : undefined
  const visitorId = String(req.headers['x-mh-visitor'] ?? '').trim().slice(0, 64)
  const lang = langFromRequest(req, url)
  const context = { ...userContext(userId), lang }
  const method = req.method

  if (pathname === '/api/auth/logout' && method === 'POST') {
    if (auth?.token) revokeToken(auth.token)
    return send(res, { ok: true })
  }

  /**
   * 登录门禁：浏览类接口公开（分享链接、搜索、榜单是免费流量入口），
   * 播放/权益/订单/个人中心必须登录。未登录用户看详情→点播放时才撞登录墙。
   */
  const OPEN_PATHS = new Set([
    '/api/constants', '/api/home', '/api/feed', '/api/auth/login', '/api/category', '/api/rank',
    '/api/search', '/api/tags', '/api/auth/email/send', '/api/auth/email/login', '/api/auth/email/password',
    '/api/plans',
    '/api/track', '/api/poster-wall', '/api/attribution/touch', '/api/content/click', '/api/content/rank',
    '/api/currency/options',
    // 模拟收银台在独立标签页，带不了 Bearer：靠一次性 HMAC 支付票据校验，见 mayPay()
    '/api/pay/mock', '/api/pay/alipay-sim',
  ])
  const OPEN_PREFIXES = ['/api/drama/', '/api/category/', '/api/tags/']
  // 只有支付宝服务端回调是公开的（自带 RSA2 验签）；其余回调一律留在内网/进程内
  const guestTrial = pathname.startsWith('/api/play/') && method === 'GET' && url.searchParams.get('trial') === '1'
  const isOpen = OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((p) => pathname.startsWith(p)) || guestTrial || pathname === '/api/notify/alipay'
  if (!isOpen && !userId) {
    return fail(res, '0401', '登录后才可播放与查看个人内容', 401)
  }

  try {
    if (pathname === '/api/attribution/touch' && method === 'POST') {
      const body = await readBody(req)
      const result = recordTouch({
        visitorId: body.visitorId ?? visitorId,
        userId,
        promoCode: body.promoCode ?? url.searchParams.get('c') ?? url.searchParams.get('promoCode'),
        host: req.headers['x-forwarded-host'] ?? req.headers.host,
        pathname: body.landingPath ?? url.pathname,
        referrer: body.referrer,
        utm: body.utm ?? {},
        ip: clientIp(req),
        ua: req.headers['user-agent'],
      })
      let referral = null
      const referralCode = body.referralCode ?? body.refCode ?? url.searchParams.get('ref')
      if (referralCode) {
        try {
          referral = recordInviteClick({
            code: referralCode, visitorId: body.visitorId ?? visitorId, userId,
            ip: clientIp(req), ua: req.headers['user-agent'], referrer: body.referrer,
          })
        } catch (error) {
          logWarn('attribution.referral_rejected', { requestId: res.getHeader?.('x-request-id'), code: error.code ?? 'invalid', error })
        }
      }
      return send(res, { ...result, referral })
    }

    if (pathname === '/api/content/click' && method === 'POST') {
      const body = await readBody(req)
      const result = recordClick({
        userId,
        visitorId: body.visitorId ?? visitorId,
        contentId: body.contentId,
        episodeId: body.episodeId,
        entryPage: body.entryPage ?? url.pathname,
        sourceModule: body.sourceModule,
        position: body.position,
        requestId: body.requestId,
        ip: clientIp(req),
        ua: req.headers['user-agent'],
      })
      return send(res, result)
    }

    if (pathname === '/api/content/rank' && method === 'GET') {
      const type = url.searchParams.get('type') ?? 'hot'
      const contentType = url.searchParams.get('contentType') ?? 'all'
      return sendPublic(res, {
        ...contentRank({ rankType: type, contentType }),
        lists: Object.entries(CONTENT_RANK_TYPES).map(([value, label]) => ({
          value, label: enumLabel(lang, 'contentRank', value, label),
        })),
      })
    }

    if (pathname === '/api/currency/options' && method === 'GET') {
      const requested = url.searchParams.get('currency') ?? cookieValue(req, 'mh_currency') ?? req.headers['x-mh-currency']
      const detected = detectCurrency({
        requested,
        country: req.headers['cf-ipcountry'] ?? req.headers['x-country'],
        acceptLanguage: req.headers['accept-language'],
      })
      return sendPublic(res, {
        detected,
        currencies: listCurrencies({ enabledOnly: true }).filter((row) => ['CNY', 'USD'].includes(row.code))
          .map((row) => ({ ...row, name: enumLabel(lang, 'currency', row.code, row.name) })),
        payoutCurrencies: listCurrencies({ enabledOnly: true }).filter((row) => row.isPayout)
          .map((row) => ({ ...row, name: enumLabel(lang, 'currency', row.code, row.name) })),
      })
    }

    if (pathname === '/api/distribution/me' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const requested = url.searchParams.get('currency') ?? cookieValue(req, 'mh_currency') ?? req.headers['x-mh-currency']
      const currency = detectCurrency({
        requested,
        country: req.headers['cf-ipcountry'] ?? req.headers['x-country'],
        acceptLanguage: req.headers['accept-language'],
      })
      const summary = distributionSummary(userId)
      const code = summary.profile?.status === 'active' ? summary.code?.code ?? null : null
      const localizedPayouts = payoutOptions({ currency })
      return send(res, {
        ...summary,
        currency,
        code,
        link: code ? `/i/${encodeURIComponent(code)}` : null,
        payoutOptions: {
          ...localizedPayouts,
          currencies: localizedPayouts.currencies.map((row) => ({
            ...row, name: enumLabel(lang, 'currency', row.code, row.name),
          })),
        },
        withdrawals: listWithdrawals({ distributorUserId: userId }).map((row) => ({
          ...row, statusLabel: enumLabel(lang, 'withdrawalStatus', row.status),
        })),
        canApply: !summary.profile,
      })
    }

    if (pathname === '/api/distribution/apply' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const profile = applyDistributor(userId)
      let code = null
      if (profile.status === 'active') code = getOrCreateReferralCode(userId).code
      return send(res, {
        profile,
        code,
        link: code ? `/i/${encodeURIComponent(code)}` : null,
        message: profile.status === 'active' ? '已开通佣金推广' : '已提交推广申请，等待审核',
      })
    }

    if (pathname === '/api/distribution/payout-options' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      return send(res, payoutOptions({ currency: url.searchParams.get('currency') ?? 'USD' }))
    }

    if (pathname === '/api/distribution/withdrawals' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      return send(res, { list: listWithdrawals({ distributorUserId: userId }) })
    }

    if (pathname === '/api/distribution/withdrawals' && method === 'POST') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      const result = createWithdrawalRequest({
        userId, amount: body.amount, currency: body.currency, methodCode: body.methodCode, account: body.account,
      })
      return send(res, result)
    }

    /* ---------- 基础 ---------- */
    if (pathname === '/api/constants') {
      const channels = paymentOptions('all')
      const live = channels.filter((channel) => channel.usable)
      const site = getSetting('site', {}) ?? {}
      const adultMenu = adultMenuSettings()
      // 会员价优先取在售套餐里的最低月价，避免运营忘配 settings.site 时收银台显示「元/月」
      const plan = all("SELECT price_cny, duration_days FROM plans WHERE status = 'active' ORDER BY price_cny ASC LIMIT 1")[0]
      const planMonthly = plan ? (Number(plan.price_cny) / Math.max(1, Number(plan.duration_days) / 30)).toFixed(2) : ''
      return sendPublic(res, {
        site: { name: '影巢' },
        supportEmail: process.env.MH_SUPPORT_EMAIL || site.supportEmail || '',
        vipPrice: site.vipPrice ?? (plan ? Number(plan.price_cny).toFixed(2) : ''),
        vipMonthlyPrice: planMonthly,
        vipUnit: site.vipUnit ?? '元/月',
        categories: CATEGORY_CHANNELS.filter((row) => row.value !== 'ALL').map((row) => ({ code: row.value, name: row.label })),
        adultMenu: {
          enabled: adultMenu.enabled,
          labels: { zh: adultMenu.labelZh, en: adultMenu.labelEn },
        },
        taxonomy: {
          channels: CATEGORY_CHANNELS,
          sorts: CATEGORY_SORTS,
          regions: CATEGORY_REGIONS.map((row) => ({ value: row.value, label: row.label })),
          genres: CATEGORY_GENRES,
          years: CATEGORY_YEARS.map((row) => ({ value: row.value, label: row.label })),
        },
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

    if (pathname === '/api/poster-wall') {
      const payload = posterWallPayload()
      return sendPublic(res, {
        ...payload,
        items: (payload.items ?? []).map((item) => ({
          ...item,
          categoryLabel: enumLabel(lang, 'category', item.category, item.category),
        })),
      })
    }

    if (pathname === '/api/home') {
      const banners = all(`SELECT b.id, b.name, b.title, b.image, b.target_drama_id, b.sort,
          d.sub_title, d.description, d.year, d.area, d.category, d.score, d.cover_url
        FROM banners b LEFT JOIN dramas d ON d.id = b.target_drama_id
        WHERE b.enabled = 1 AND (b.target_drama_id IS NULL OR (d.id IS NOT NULL AND ${adultVisibilitySql()}))
        ORDER BY b.sort`).map((banner) => ({
        id: banner.id,
        name: banner.name,
        title: banner.title,
        image: banner.image,
        targetDramaId: banner.target_drama_id,
        subTitle: banner.sub_title,
        description: banner.description,
        year: banner.year,
        area: banner.area,
        areaLabel: enumLabel(lang, 'area', banner.area, banner.area),
        category: banner.category,
        categoryLabel: enumLabel(lang, 'category', banner.category),
        score: banner.score,
        previewUrl: previewUrlForCover(banner.cover_url),
      }))
      const backdropByDrama = new Map()
      for (const banner of banners) {
        if (banner.targetDramaId && banner.image && !backdropByDrama.has(banner.targetDramaId)) {
          backdropByDrama.set(banner.targetDramaId, banner.image)
        }
      }
      const sections = all('SELECT * FROM sections WHERE enabled = 1 ORDER BY sort').map((section) => ({
        id: section.id,
        title: section.title,
        items: withPlayCounts(all(`SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? AND d.status = 'published' AND ${adultVisibilitySql()}
          ORDER BY si.sort LIMIT 30`, section.id))
          .map((drama) => ({
            ...cardOf(drama, userId, context),
            backdropUrl: backdropByDrama.get(drama.id) ?? wideArtworkForCover(drama.cover_url),
          })),
      }))
      const hot = all(`SELECT title FROM dramas WHERE ${adultVisibilitySql('general', '')} ORDER BY score DESC LIMIT 8`).map((row) => row.title)
      return sendPublic(res, { banners, sections, hotwords: hot })
    }

    if (pathname === '/api/category') {
      // 「全部分类」筛选：频道 / 排序 / 地区 / 类型（按标签名）/ 年份（单年或年代桶）/ 标签 + 分页
      // total 为筛选后的真实总数；facets 的计数按当前频道内统计，用于给筛选项打数量
      const p = url.searchParams
      const channel = (p.get('type') ?? p.get('channel') ?? 'ALL').trim().toUpperCase()
      const page = Math.max(1, Number(p.get('page') ?? 1))
      const pageSize = Math.min(60, Math.max(1, Number(p.get('pageSize') ?? 24)))
      const sort = (p.get('sort') ?? 'hot').trim().toLowerCase()
      const audience = (p.get('audience') ?? 'general').trim().toLowerCase() === 'adult' ? 'adult' : 'general'
      const audienceSql = adultVisibilitySql(audience)

      const where = ["d.status = 'published'", audienceSql]
      const params = []
      const channelWhere = []
      const channelParams = []
      if (channel && channel !== 'ALL') {
        // 频道条件既进主查询（列表/总数），也作为 facets 计数的「当前频道」范围
        channelWhere.push('d.category = ?')
        channelParams.push(channel)
        where.push('d.category = ?')
        params.push(channel)
      }

      // 地区：前端传标准 code（US/UK/KR/JP/TH/CN/HK/TW/OTHER），按 area 文本映射
      const region = (p.get('region') ?? '').trim().toUpperCase()
      const regionRule = CATEGORY_REGIONS.find((row) => row.value === region)
      if (regionRule) {
        if (regionRule.negate) {
          const known = CATEGORY_REGIONS.filter((row) => !row.negate).flatMap((row) => row.areas)
          where.push(`COALESCE(d.area, '') NOT IN (${known.map(() => '?').join(',')})`)
          params.push(...known)
        } else {
          where.push(`d.area IN (${regionRule.areas.map(() => '?').join(',')})`)
          params.push(...regionRule.areas)
        }
      }

      // 年份：2026 这种单年，或 2011-2020 / 2000-2010 / 1990s / 1980s 这种区间
      const year = (p.get('year') ?? '').trim()
      const yearRule = CATEGORY_YEARS.find((row) => row.value === year)
      if (yearRule && Number.isInteger(yearRule.from)) {
        where.push('d.year >= ? AND d.year <= ?')
        params.push(yearRule.from, yearRule.to)
      }

      // 类型：按标签名匹配（标签支持一级/二级，选一级时带上其子标签）
      const genre = (p.get('genre') ?? '').trim()
      if (genre) {
        where.push(`d.id IN (SELECT dt.drama_id FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id
          WHERE t.name = ? OR t.parent_id IN (SELECT id FROM tags WHERE name = ?))`)
        params.push(genre, genre)
      }

      // 标签：直接指定 tagId（后台/C 端标签墙进入）
      const tagId = Number(p.get('tag') ?? 0)
      if (tagId) {
        where.push('d.id IN (SELECT drama_id FROM drama_tags WHERE tag_id = ?)')
        params.push(tagId)
      }

      // 兼容旧参数（area 精确 / sort=play|new|score）
      const legacyArea = (p.get('area') ?? '').trim()
      if (!regionRule && legacyArea) { where.push('d.area = ?'); params.push(legacyArea) }

      const orderBy = sort === 'new' ? 'd.year DESC, d.id DESC'
        : sort === 'score' ? 'd.score DESC, d.id DESC'
          : sort === 'discuss' ? 'discuss_count DESC, d.score DESC'
            : sort === 'upcoming' ? 'd.year DESC, d.id DESC'
              : 'hot_score DESC, d.score DESC'

      // 热播 = 播放 + 完播×2 + 收藏×3（30 天），讨论 = 弹幕 + 评论
      const FROM = `FROM dramas d
        LEFT JOIN (SELECT drama_id, COUNT(*) AS play_count FROM play_events WHERE created_at >= datetime('now', '-30 days') GROUP BY drama_id) pe ON pe.drama_id = d.id
        LEFT JOIN (SELECT e.drama_id, COUNT(*) AS danmu_count FROM danmus m JOIN episodes e ON e.id = m.episode_id WHERE m.status = 'approved' GROUP BY e.drama_id) dm ON dm.drama_id = d.id
        LEFT JOIN (SELECT drama_id, COUNT(*) AS comment_count FROM comments WHERE status = 'approved' GROUP BY drama_id) cm ON cm.drama_id = d.id
        LEFT JOIN (SELECT drama_id, COUNT(*) AS fav_count FROM favorites GROUP BY drama_id) fv ON fv.drama_id = d.id`
      const SELECT = `SELECT d.*, COALESCE(pe.play_count, 0) AS play_count,
        COALESCE(dm.danmu_count, 0) + COALESCE(cm.comment_count, 0) AS discuss_count,
        (COALESCE(pe.play_count, 0) + COALESCE(dm.danmu_count, 0) * 2 + COALESCE(fv.fav_count, 0) * 3) AS hot_score`

      const clause = where.join(' AND ')
      const rows = all(`${SELECT} ${FROM} WHERE ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
        ...params, pageSize, (page - 1) * pageSize)
      const total = one(`SELECT COUNT(*) AS n ${FROM} WHERE ${clause}`, ...params).n

      // 筛选项：全部来自固定枚举（空库也有完整分类树），计数按「当前频道内」统计
      const channelClause = channelWhere.length
        ? `WHERE d.status = 'published' AND ${audienceSql} AND ${channelWhere.join(' AND ')}`
        : `WHERE d.status = 'published' AND ${audienceSql}`
      const countBy = (sql, argList = []) => Number(one(`SELECT COUNT(*) AS n ${FROM} ${channelClause} AND ${sql}`, ...channelParams, ...argList)?.n ?? 0)
      const facets = {
        channels: CATEGORY_CHANNELS.map((row) => ({
          value: row.value, label: enumLabel(lang, 'category', row.value, row.label), count: row.value === 'ALL'
            ? Number(one(`SELECT COUNT(*) AS n FROM dramas d WHERE d.status = 'published' AND ${audienceSql}`).n)
            : Number(one(`SELECT COUNT(*) AS n FROM dramas d WHERE d.status = 'published' AND ${audienceSql} AND d.category = ?`, row.value).n),
        })),
        sorts: CATEGORY_SORTS.map((row) => ({ value: row.value, label: enumLabel(lang, 'sort', row.value, row.label) })),
        regions: CATEGORY_REGIONS.map((row) => ({
          value: row.value,
          label: enumLabel(lang, 'region', row.value, row.label),
          count: row.negate
            ? countBy(`COALESCE(d.area, '') NOT IN (${CATEGORY_REGIONS.filter((item) => !item.negate).flatMap((item) => item.areas).map(() => '?').join(',')})`,
              CATEGORY_REGIONS.filter((item) => !item.negate).flatMap((item) => item.areas))
            : countBy(`d.area IN (${row.areas.map(() => '?').join(',')})`, row.areas),
        })),
        genres: CATEGORY_GENRES.map((label) => ({ value: label, label: enumLabel(lang, 'genre', label, label), count: countBy(
          `d.id IN (SELECT dt.drama_id FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id WHERE t.name = ? OR t.parent_id IN (SELECT id FROM tags WHERE name = ?))`,
          [label, label]) })),
        years: CATEGORY_YEARS.map((row) => ({ value: row.value, label: localizedYearLabel(lang, row.label), count: countBy('d.year >= ? AND d.year <= ?', [row.from, row.to]) })),
        tags: all(`SELECT t.id, t.name, (SELECT COUNT(*) FROM drama_tags dt
            JOIN dramas d ON d.id = dt.drama_id AND d.status = 'published' AND ${audienceSql}
            WHERE dt.tag_id = t.id) AS n
          FROM tags t WHERE t.status = 'active' ORDER BY n DESC, t.sort LIMIT 24`)
          .map((row) => ({ value: Number(row.id), label: enumLabel(lang, 'genre', row.name, row.name), count: Number(row.n) })),
      }
      const adultStats = audience === 'adult' ? adultStatsFor(rows.map((drama) => drama.id)) : null
      const listRows = adultStats
        ? rows.map((drama) => ({ ...drama, adult_stats: adultStats.get(drama.id) }))
        : rows
      return sendPublic(res, {
        page, pageSize, total,
        list: listRows.map((drama) => cardOf(drama, userId, context)),
        facets,
        active: { audience, channel, sort, region, year, genre, tagId },
      })
    }

    if (pathname === '/api/rank') {
      const type = url.searchParams.get('type') ?? 'HOT'
      const lists = all('SELECT name, type FROM rank_lists ORDER BY sort').map((row) => ({
        name: row.name, type: row.type, label: enumLabel(lang, 'rank', row.type, row.name),
      }))
      const list = one('SELECT * FROM rank_lists WHERE type = ? ORDER BY sort LIMIT 1', type)
      if (!list) return sendPublic(res, { type, listName: '', lists, items: [] })
      const items = withPlayCounts(all(`SELECT d.*, ri.rank_no FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id
        WHERE ri.list_id = ? AND ${adultVisibilitySql()} ORDER BY ri.rank_no`, list.id))
        .map((drama) => ({ ...cardOf(drama, userId, context), rankNo: drama.rank_no }))
      return sendPublic(res, { type, listName: enumLabel(lang, 'rank', list.type, list.name), lists, items })
    }

    /* 「换一换」：按分区随机重排；无分区参数时全站随机 */
    if (pathname === '/api/feed') {
      const sectionId = Number(url.searchParams.get('section') ?? 0)
      if (sectionId) {
        const items = withPlayCounts(all(`SELECT d.* FROM section_items si JOIN dramas d ON d.id = si.drama_id
          WHERE si.section_id = ? AND d.status = 'published' AND ${adultVisibilitySql()}
          ORDER BY RANDOM() LIMIT 12`, sectionId))
          .map((drama) => cardOf(drama, userId, context))
        if (items.length > 1) return sendPublic(res, { sectionId, items })
      }
      const items = withPlayCounts(all(`SELECT * FROM dramas WHERE status = 'published' AND ${adultVisibilitySql('general', '')} ORDER BY RANDOM() LIMIT 12`))
        .map((drama) => cardOf(drama, userId, context))
      return sendPublic(res, { sectionId, items })
    }

    if (pathname === '/api/search') {
      const keyword = (url.searchParams.get('keyword') ?? '').trim()
      const tagId = Number(url.searchParams.get('tag') ?? url.searchParams.get('tagId') ?? 0)
      const where = ["status = 'published'", adultVisibilitySql('general', '')]
      const params = []
      // 标签与关键词可以叠加：标签缩小集合，关键词在集合内再筛（原来两者互斥，搜标签名搜不到片）
      if (tagId) {
        where.push('id IN (SELECT drama_id FROM drama_tags WHERE tag_id = ?)')
        params.push(tagId)
      }
      if (keyword) {
        const like = `%${keyword}%`
        const categoryMap = {
          电影: 'MOVIE',
          电视剧: 'TV',
          短剧: 'PLAYLET',
          动漫: 'ANIME',
          纪录片: 'DOCUMENTARY',
          movie: 'MOVIE',
          movies: 'MOVIE',
          tv: 'TV',
          'tv series': 'TV',
          'short drama': 'PLAYLET',
          anime: 'ANIME',
          documentary: 'DOCUMENTARY',
        }
        const category = categoryMap[keyword] ?? categoryMap[keyword.toLowerCase()]
        const keywordWhere = [
          'title LIKE ?',
          'sub_title LIKE ?',
          'description LIKE ?',
          'area LIKE ?',
          `id IN (SELECT dt.drama_id FROM drama_tags dt JOIN tags t ON t.id = dt.tag_id
            WHERE t.status = 'active' AND t.name LIKE ?)`,
        ]
        params.push(like, like, like, like, like)
        if (category) {
          keywordWhere.push('category = ?')
          params.push(category)
        }
        where.push(`(${keywordWhere.join(' OR ')})`)
      }
      if (!keyword && !tagId) return send(res, { keyword, tagId, total: 0, list: [] })
      const clause = where.join(' AND ')
      const total = one(`SELECT COUNT(*) AS n FROM dramas WHERE ${clause}`, ...params).n
      const rows = all(`SELECT * FROM dramas WHERE ${clause} ORDER BY score DESC LIMIT 60`, ...params)
      return sendPublic(res, { keyword, tagId, total, list: rows.map((drama) => cardOf(drama, userId, context)) })
    }

    if (pathname === '/api/tags') {
      const requestedScope = url.searchParams.get('scope') ?? 'general'
      const scope = requestedScope === 'adult' ? 'adult' : 'general'
      return sendPublic(res, {
        list: listTags({ withCount: true, publicOnly: true, scope }).map((tag) => ({
          ...tag,
          label: scope === 'adult' ? tag.name : enumLabel(lang, 'genre', tag.name, tag.name),
        })),
      })
    }

    /* ---------- 详情 / 权益 ---------- */
    if (pathname.startsWith('/api/drama/')) {
      const dramaId = Number(pathname.split('/')[3])
      const drama = one("SELECT * FROM dramas WHERE id = ? AND status = 'published'", dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)
      const policy = policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0, purchase_kind: 'single' }
      const episodes = all("SELECT id, no, title, duration, status, hls_path FROM episodes WHERE drama_id = ? AND status != 'merged' ORDER BY no", drama.id)
      const purchase = context.purchase.has(drama.id) ? one(`SELECT * FROM purchases WHERE user_id = ? AND drama_id = ? AND status = 'active'
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')) ORDER BY id DESC LIMIT 1`, userId, drama.id) : undefined
      const decided = decideEpisodes({ drama, policy, subscription: context.subscription, purchase, episodes })
      // 收藏态与观看进度：详情页要靠这两个字段渲染「✓ 已收藏」「继续观看第 N 集」，
      // 否则前端只能再打一次 /api/me，多一轮请求且首屏会闪。
      const favorite = userId ? one('SELECT 1 AS x FROM favorites WHERE user_id = ? AND drama_id = ?', userId, drama.id) : undefined
      const resume = userId ? one('SELECT episode_no, position, updated_at FROM history WHERE user_id = ? AND drama_id = ?', userId, drama.id) : undefined
      const card = cardOf(drama, userId, context)
      if (drama.is_adult) card.stats = adultStatsFor([drama.id]).get(drama.id)
      return sendPublic(res, {
        ...card,
        description: drama.description,
        episodes: decided.map((episode) => ({
          id: episode.id, no: episode.no, title: episode.title, duration: episode.duration,
          status: episode.status, allow: episode.allow, source: episode.source,
          reason: episode.reason ?? null,
          rule: episode.rule ? { mode: episode.rule.mode, price: Number(episode.rule.price_cny ?? 0) } : null,
          trialSeconds: episode.trialSeconds, price: episode.price,
        })),
        priceInfo: {
          ...priceInfo(drama),
          rules: rulesOfDrama(drama.id).map((rule) => ({
            fromNo: Number(rule.from_no),
            toNo: rule.to_no === null || rule.to_no === undefined ? null : Number(rule.to_no),
            mode: rule.mode,
            price: Number(rule.price_cny ?? 0),
            note: rule.note ?? '',
          })),
        },
        tags: tagsOfDrama(drama.id).map((tag) => ({ id: tag.id, name: tag.name })),
        hasSubscription: Boolean(context.subscription),
        favorited: Boolean(favorite),
        resumeEpisodeNo: resume?.episode_no ?? null,
        resumePosition: resume?.position ?? null,
        resumeUpdatedAt: resume?.updated_at ?? null,
        // 参考站详情页右侧/底部有「类似影视」：同类型优先，不足时用高分剧补齐，最多 8 部
        similar: (() => {
          const sameType = all(
            `SELECT d.* FROM dramas d
              WHERE d.id <> ? AND d.status = 'published' AND d.category = ? AND ${adultVisibilitySql(drama.is_adult ? 'adult' : 'general')}
              ORDER BY d.score DESC, d.id DESC LIMIT 8`,
            drama.id, drama.category,
          )
          if (sameType.length >= 4) return sameType.map((row) => cardOf(row, userId, context))
          const fill = all(
            `SELECT d.* FROM dramas d WHERE d.id <> ? AND d.status = 'published' AND ${adultVisibilitySql(drama.is_adult ? 'adult' : 'general')}
              ORDER BY d.score DESC, d.id DESC LIMIT ?`,
            drama.id, 8 - sameType.length,
          )
          const seen = new Set(sameType.map((row) => row.id))
          return [...sameType, ...fill.filter((row) => !seen.has(row.id))].map((row) => cardOf(row, userId, context))
        })(),
      })
    }

    if (pathname.startsWith('/api/access/')) {
      const [, , , dramaId, no] = pathname.split('/')
      return send(res, resolveAccess(userId, Number(dramaId), Number(no)))
    }

    if (pathname.startsWith('/api/play/session/') && pathname.endsWith('/heartbeat') && method === 'POST') {
      const sessionId = pathname.split('/')[4]
      const body = await readBody(req)
      const result = applyHeartbeat({
        sessionId, userId, visitorId,
        positionSeconds: body.positionSeconds,
        durationSeconds: body.durationSeconds,
        playing: Boolean(body.playing),
        visible: Boolean(body.visible),
        playbackRate: body.playbackRate,
      })
      return send(res, result)
    }

    /* ---------- 播放：签发短时链接 ---------- */
    if (pathname.startsWith('/api/play/')) {
      const [, , , dramaIdRaw, noRaw] = pathname.split('/')
      const dramaId = Number(dramaIdRaw)
      let no = Number(noRaw ?? 1)
      const drama = one('SELECT * FROM dramas WHERE id = ?', dramaId)
      if (!drama) return fail(res, '0404', '内容不存在', 404)
      let episode = one("SELECT * FROM episodes WHERE drama_id = ? AND no = ? AND status != 'merged'", dramaId, no)
      if (!episode && drama.category === 'MOVIE') {
        episode = one("SELECT * FROM episodes WHERE drama_id = ? AND no = 1 AND hls_path LIKE '%/merged/%'", dramaId)
        if (episode) no = 1
      }
      if (!episode) return fail(res, '0404', '该集不存在', 404)
      if (!episode.hls_path || episode.status !== 'ready') {
        // 转码中/失败的集不能签发空链接：前端要能区分「还没好」和「没权限」
        return send(res, {
          dramaId, episodeId: episode.id, episodeStatus: episode.status, reason: 'episode_not_ready',
          message: episode.status === 'error' ? '该集片源处理失败，请稍后再试' : '该集片源正在处理中，请稍后再试',
        }, '0409', '该集片源尚未就绪', 409)
      }
      const tracks = publicTracksOf(episode.id, lang)

      const access = resolveAccess(userId, dramaId, no)
      const trialWanted = url.searchParams.get('trial') === '1'
      if (!access.allow && access.trialSeconds > 0 && trialWanted) {
        let trialSeconds = Number(access.trialSeconds)
        if (!userId) {
          if (!visitorId) return fail(res, '0400', '缺少访客标识', 400)
          trialSeconds = Math.min(15, trialSeconds)
          const latest = one(`SELECT * FROM guest_trials
            WHERE visitor_id = ? AND drama_id = ? AND started_at >= datetime('now', '-24 hours')
            ORDER BY id DESC LIMIT 1`, visitorId, dramaId)
          if (latest) {
            const expiresAt = new Date(`${String(latest.expires_at).replace(' ', 'T')}Z`).getTime()
            if (expiresAt <= Date.now()) return fail(res, '0403', '试看已结束，请购买后观看', 403)
            trialSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))
          } else {
            db.prepare(`INSERT INTO guest_trials (visitor_id, drama_id, episode_no, expires_at, ip, ua)
              VALUES (?, ?, ?, datetime('now', '+15 seconds'), ?, ?)`)
              .run(visitorId, dramaId, no, clientIp(req), req.headers['user-agent'] ?? '')
          }
        }
        // 试看：签名有效期必须覆盖试看时长，否则前端按 trialSeconds 截断前就先被 403 断流
        const trialHls = episode.hls_path ?? `/media/hls/${episode.id}/index.m3u8`
        const ua = req.headers['user-agent'] ?? ''
        const trialTtl = Math.min(PLAY_TTL_MAX, Math.max(120, trialSeconds + 60))
        const trialLink = episode.hls_path ? secureLink(trialHls, trialTtl, ua) : { url: null, sign: null, expires: 0 }
        if (episode.hls_path) setLinkCookies(res, trialLink, trialTtl, req, episode.id)
        recordPlay({ userId, visitorId, dramaId, episodeId: episode.id, episodeNo: no, source: 'trial', ip: clientIp(req), ua: req.headers['user-agent'] })
        let viewSession = null
        try {
          viewSession = startViewSession({
            userId, visitorId, contentId: dramaId, episodeId: episode.id, source: 'trial',
            duration: episode.duration, ip: clientIp(req), ua: req.headers['user-agent'],
          })
        } catch (error) {
          logWarn('content.view_session_failed', { requestId: res.getHeader?.('x-request-id'), userId, dramaId, error })
        }
        return send(res, {
          dramaId, title: drama.title, episodeId: episode.id, episodeStatus: episode.status,
          episode: { id: episode.id, no: episode.no, title: episode.title },
          source: 'trial', hls: episode.hls_path, expiresIn: trialTtl, trialSeconds, danmu: [],
          viewSessionId: viewSession?.id ?? null, heartbeatIntervalSeconds: 15,
          viewThresholdSeconds: viewSession?.thresholdSeconds ?? 30, duration: Number(episode.duration ?? 0),
          ...tracks,
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
      recordPlay({ userId, visitorId, dramaId, episodeId: episode.id, episodeNo: no, source: 'play', ip: clientIp(req), ua: req.headers['user-agent'] })
      let viewSession = null
      try {
        viewSession = startViewSession({
          userId, visitorId, contentId: dramaId, episodeId: episode.id, source: access.source,
          duration: episode.duration, ip: clientIp(req), ua: req.headers['user-agent'],
        })
      } catch (error) {
        logWarn('content.view_session_failed', { requestId: res.getHeader?.('x-request-id'), userId, dramaId, error })
      }
      const danmu = all("SELECT time_ms, content FROM danmus WHERE episode_id = ? AND status = 'approved' ORDER BY time_ms", episode.id)
      // 续播：该用户在该集的已看进度；连播：下一集集号（同剧存在即给）
      const resume = one('SELECT position FROM history WHERE user_id = ? AND drama_id = ? AND episode_no = ?', userId, dramaId, no)
      const nextEp = one("SELECT no FROM episodes WHERE drama_id = ? AND no > ? AND status != 'merged' ORDER BY no LIMIT 1", dramaId, no)
      return send(res, {
        dramaId, title: drama.title, episodeId: episode.id, episodeStatus: episode.status,
        episode: { id: episode.id, no: episode.no, title: episode.title },
        source: access.source,
        hls: hlsPath,
        expiresIn: playTtl,
        viewSessionId: viewSession?.id ?? null,
        heartbeatIntervalSeconds: 15,
        viewThresholdSeconds: viewSession?.thresholdSeconds ?? 30,
        duration: Number(episode.duration ?? 0),
        trialSeconds: 0,
        resumePosition: Number(resume?.position ?? 0),
        nextEpisodeNo: nextEp ? nextEp.no : null,
        danmu: danmu.map((row) => ({ time: row.time_ms, text: row.content })),
        ...tracks,
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
        visitorId,
        productType: body.productType === 'single' ? 'single' : 'subscription',
        planId: Number(body.planId ?? 0) || undefined,
        dramaId: Number(body.dramaId ?? 0) || undefined,
        channel,
        couponCode: body.couponCode,
        ip: clientIp(req),
        ua: req.headers['user-agent'],
      })
      // 模拟收银台是独立标签页，带不了 Bearer → 用一次性票据换取支付权限
      const simTicket = result.payUrl && result.simulated ? signPayTicket(result.order.out_trade_no) : null
      return send(res, {
        outTradeNo: result.order.out_trade_no,
        amount: result.order.amount_cny,
        channel: result.order.channel,
        status: result.order.status,
        statusLabel: enumLabel(lang, 'orderStatus', result.order.status),
        expiresAt: result.order.expires_at,
        payUrl: simTicket ? `${result.payUrl}?ticket=${encodeURIComponent(simTicket)}` : result.payUrl,
        simulated: result.simulated ?? false,
        usdt: result.usdt ?? null,
      })
    }

    if (pathname === '/api/orders' && method === 'GET') {
      if (!userId) return fail(res, '0401', '请先登录', 401)
      return send(res, {
        list: listOrders({ userId, limit: 50 }).map((row) => ({
          ...orderDto(row),
          statusLabel: enumLabel(lang, 'orderStatus', row.status),
        })),
      })
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
        outTradeNo: order.out_trade_no, status: order.status,
        statusLabel: enumLabel(lang, 'orderStatus', order.status), amount: order.amount_cny,
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
      // 支付宝只认纯文本 success：任何 JSON 信封（含异常被外层兜成信封）都会触发 25 小时重试
      let ok = false
      try {
        ok = handleAlipayNotify(params)?.code === '0000'
      } catch (error) {
        console.warn('[notify/alipay]', error?.message ?? error)
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end(ok ? 'success' : 'failure')
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
        ...(result.testCode ? { testCode: result.testCode } : {}),
      })
    }

    if (pathname === '/api/auth/email/login' && method === 'POST') {
      const body = await readBody(req)
      verifyCode({ email: body.email, purpose: 'login', code: body.code })
      const result = loginByEmail(body.email, { nickname: body.nickname })
      let acquisitionBonded = false
      let distributionBonded = false
      if (result.created) {
        try {
          acquisitionBonded = Boolean(bindUserAcquisition({ userId: result.user.id, visitorId }))
        } catch (error) {
          logWarn('auth.acquisition_bind_failed', { requestId: res.getHeader?.('x-request-id'), userId: result.user.id, error })
        }
        const referralCode = body.referralCode ?? cookieValue(req, 'mh_ref')
        if (referralCode) {
          try {
            distributionBonded = Boolean(bindReferral({ userId: result.user.id, visitorId, code: referralCode }))
          } catch (error) {
            logWarn('auth.distribution_bind_failed', { requestId: res.getHeader?.('x-request-id'), userId: result.user.id, code: error.code ?? 'invalid', error })
          }
        }
      }
      return send(res, {
        token: result.token,
        expiresAt: result.expiresAt,
        created: result.created,
        acquisitionBonded,
        distributionBonded,
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
      const rawType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      const rawExt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[rawType]
      let buffer
      let ext
      if (rawExt) {
        try {
          buffer = await readRawBody(req)
        } catch (error) {
          return fail(res, error.code ?? '0400', error.message ?? '头像上传失败', error.status ?? 400)
        }
        ext = rawExt
      } else {
        const body = await readBody(req)
        const dataUrl = String(body.dataUrl ?? '')
        const match = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
        if (!match) return fail(res, '0400', '头像格式需为 PNG / JPEG / WebP', 400)
        buffer = Buffer.from(match[3], 'base64')
        ext = match[2] === 'jpeg' ? 'jpg' : match[2]
      }
      if (buffer.length > 1024 * 1024) return fail(res, '0413', '头像不能超过 1MB', 413)
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
      if (!isClientTrackType(body.type) && ['order_created', 'payment_success'].includes(body.type)) {
        return fail(res, '0403', '交易事件只允许服务端记录', 403)
      }
      const ok = recordEvent({
        type: body.type, userId, visitorId: body.visitorId ?? visitorId, dramaId: body.dramaId, episodeId: body.episodeId,
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

    if (pathname === '/api/me/track-preferences' && method === 'GET') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const dramaId = Number(url.searchParams.get('dramaId'))
      if (!Number.isInteger(dramaId) || dramaId <= 0) return fail(res, '0400', 'dramaId 无效', 400)
      return send(res, userTrackPreferences(userId, dramaId))
    }

    if (pathname === '/api/me/track-preferences' && method === 'PUT') {
      if (!userId) return fail(res, '0401', '需要登录', 401)
      const body = await readBody(req)
      try {
        const saved = saveUserTrackPreference({ ...body, userId })
        return send(res, saved)
      } catch (error) {
        if (error?.name === 'TrackError') {
          return fail(res, error.status === 404 ? '0404' : '0400', error.message, error.status)
        }
        throw error
      }
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
      return send(res, toggleFavorite({ userId, contentId: dramaId, requestId: body.requestId }))
    }

    return fail(res, '0404', '接口不存在', 404)
  } catch (error) {
    if (error instanceof OtpError) return send(res, { ...error.extra }, error.code, error.message, error.status)
    if (error instanceof CommerceError) return fail(res, error.code, error.message, error.status)
    if (error?.status === 413) {
      res.setHeader('connection', 'close')
      return fail(res, error.code ?? '0413', error.message ?? '请求体过大', 413)
    }
    if (error?.status && error?.code) return fail(res, error.code, error.message, error.status)
    if (error?.code === 'password_weak' || error?.code === 'email_taken' || error?.code === 'user_banned' || error?.code === 'avatar_invalid') {
      return fail(res, error.code, error.message, 400)
    }
    logError('public.exception', { requestId: res.getHeader?.('x-request-id'), method: req.method, path: pathname, userId, error })
    return fail(res, '0500', '服务器错误', 500)
  }
}

export { markPaid }

