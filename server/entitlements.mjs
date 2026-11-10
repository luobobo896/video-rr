/**
 * 权益判定（唯一入口）+ 播放令牌。
 *
 * 判定顺序（固定）：单片所有权 > 订阅 > 首集/免费库 > 试看 > 拒绝
 * 所有客户端（C 端/客服工具/接口）只认这里的结果，前端不做权限判断。
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { db, getSetting } from './db.mjs'

const one = (sql, ...args) => db.prepare(sql).get(...args)
const all = (sql, ...args) => db.prepare(sql).all(...args)

export const ACCESS = { FREE: 'free', SUBSCRIPTION: 'subscription', PAID: 'paid' }

export function policyOf(dramaId) {
  return one('SELECT * FROM content_policies WHERE drama_id = ?', dramaId)
}

/** 有效的订阅（未过期、覆盖该内容 scope）。 */
export function activeSubscription(userId) {
  if (!userId) return undefined
  return one(`SELECT * FROM subscriptions
    WHERE user_id = ? AND status = 'active' AND datetime(valid_to) > datetime('now')
    ORDER BY datetime(valid_to) DESC LIMIT 1`, userId)
}

export function activePurchase(userId, dramaId) {
  if (!userId) return undefined
  return one(`SELECT * FROM purchases
    WHERE user_id = ? AND drama_id = ? AND status = 'active'
      AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
    ORDER BY id DESC LIMIT 1`, userId, dramaId)
}

const scopeMatches = (scope, drama) => {
  if (!scope || scope === 'all') return true
  if (scope.startsWith('category:')) return scope.slice(9) === drama.category
  return false
}

/** 按集定价规则：优先级高于内容级策略（VIP 免费但最后 2 集单独收费就靠它）。 */
export function rulesOfDrama(dramaId) {
  return all('SELECT * FROM episode_price_rules WHERE drama_id = ? ORDER BY from_no, sort, id', Number(dramaId))
}

export function ruleFor(rules, episodeNo) {
  const no = Number(episodeNo)
  if (!Number.isFinite(no)) return null
  return rules.find((rule) => no >= Number(rule.from_no) && (rule.to_no === null || rule.to_no === undefined || no <= Number(rule.to_no))) ?? null
}

/** 写入某部剧的规则集合（整体替换，后台保存用）。 */
export function setEpisodeRules(dramaId, rules) {
  const id = Number(dramaId)
  const rows = (rules ?? []).map((rule, index) => ({
    from: Math.max(1, Number(rule.fromNo ?? rule.from_no ?? 1) || 1),
    to: rule.toNo ?? rule.to_no ?? null,
    mode: ['free', 'vip', 'single'].includes(rule.mode) ? rule.mode : 'vip',
    price: Math.max(0, Number(rule.price ?? rule.price_cny ?? 0) || 0),
    note: rule.note ?? null,
    sort: index,
  }))
  for (const row of rows) {
    if (row.to !== null && Number(row.to) < row.from) throw Object.assign(new Error(`第 ${row.from} 集的结束集数不能小于起始集数`), { status: 400 })
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM episode_price_rules WHERE drama_id = ?').run(id)
    const insert = db.prepare(`INSERT INTO episode_price_rules (drama_id, from_no, to_no, mode, price_cny, note, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const row of rows) insert.run(id, row.from, row.to === null ? null : Number(row.to), row.mode, row.price, row.note, row.sort)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return rulesOfDrama(id)
}

/** 内容级支付方式摘要（给前端渲染角标与购买入口）。 */
export function priceInfo(drama) {
  const policy = policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0, purchase_kind: 'single' }
  return {
    accessMode: policy.access_mode,
    freeEpisodes: policy.free_episodes,
    trialSeconds: policy.trial_seconds,
    singlePrice: policy.single_price_cny,
    purchaseKind: policy.purchase_kind,
    plans: all("SELECT * FROM plans WHERE status = 'active' ORDER BY sort").map((plan) => ({
      id: plan.id, code: plan.code, name: plan.name, price: plan.price_cny, days: plan.duration_days, scope: plan.scope,
    })),
  }
}

/**
 * 判定单个用户能否看某集。
 * @returns {{allow:boolean, source?:string, reason?:string, trialSeconds?:number, price?:number,
 *            plans?:Array, purchaseKind?:string, subscription?:object}}
 */
export function resolveAccess(userId, dramaId, episodeNo) {
  const drama = one('SELECT * FROM dramas WHERE id = ?', dramaId)
  if (!drama) return { allow: false, reason: 'content_not_found' }
  const policy = policyOf(drama.id) ?? { access_mode: 'subscription', free_episodes: 0, trial_seconds: 0, single_price_cny: 0, purchase_kind: 'single' }

  // 1) 单片所有权（买断整部：优先于一切规则）
  const purchase = activePurchase(userId, drama.id)
  if (purchase) return { allow: true, source: 'purchase', purchase }

  // 2) 按集规则（VIP 免费但某几集单独卖，就靠这里覆盖内容级策略）
  const rules = rulesOfDrama(drama.id)
  const rule = ruleFor(rules, episodeNo)
  const subscription = activeSubscription(userId)
  const subCovers = Boolean(subscription) && scopeMatches(subscription.scope, drama)

  if (rule) {
    if (rule.mode === 'free') return { allow: true, source: 'free', rule }
    if (rule.mode === 'vip') {
      if (subCovers) return { allow: true, source: 'subscription', subscription, rule }
      return {
        allow: false,
        reason: 'vip_required',
        trialSeconds: policy.trial_seconds,
        price: 0,
        purchaseKind: policy.purchase_kind,
        plans: priceInfo(drama).plans,
        membership: false,
        rule,
      }
    }
    // mode === 'single'：会员也要单独买
    return {
      allow: false,
      reason: 'single_purchase_required',
      trialSeconds: policy.trial_seconds,
      price: Number(rule.price_cny) || Number(policy.single_price_cny) || 0,
      purchaseKind: policy.purchase_kind,
      plans: priceInfo(drama).plans,
      membership: subCovers,
      rule,
    }
  }

  // 3) 订阅（覆盖 scope）；会员「全场畅看」包含单片付费库，单片价格只对非会员生效
  if (subCovers) {
    return { allow: true, source: 'subscription', subscription }
  }

  // 4) 免费集 / 免费库（免费集是拉新钩子，与 access_mode 无关：单片剧也常放前 1–2 集）
  if (policy.access_mode === 'free') return { allow: true, source: 'free' }
  if (Number(policy.free_episodes) > 0 && Number(episodeNo) <= Number(policy.free_episodes)) {
    return { allow: true, source: 'free' }
  }

  // 5) 拒绝 + 引导信息（含单片价格与试看时长）
  const info = priceInfo(drama)
  return {
    allow: false,
    reason: policy.access_mode === 'paid' ? 'single_purchase_required' : 'subscription_required',
    trialSeconds: policy.trial_seconds,
    price: policy.single_price_cny,
    purchaseKind: policy.purchase_kind,
    plans: info.plans,
    membership: Boolean(subscription),
  }
}

/** 发放订阅权益（幂等：同一 order 只发一次）。 */
export function grantSubscription({ userId, planId, orderId }) {
  const existing = one('SELECT * FROM subscriptions WHERE order_id = ?', orderId)
  if (existing) return existing
  const plan = one('SELECT * FROM plans WHERE id = ?', planId)
  if (!plan) throw new Error(`套餐不存在：${planId}`)
  const current = activeSubscription(userId)
  const base = current ? new Date(`${current.valid_to}Z`).getTime() : Date.now()
  const from = new Date(Math.max(Date.now(), base)).toISOString().slice(0, 19).replace('T', ' ')
  const to = new Date(Math.max(Date.now(), base) + plan.duration_days * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
  const info = db.prepare(`INSERT INTO subscriptions (user_id, plan_id, order_id, scope, valid_from, valid_to, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')`).run(userId, planId, orderId, plan.scope ?? 'all', from, to)
  return one('SELECT * FROM subscriptions WHERE id = ?', Number(info.lastInsertRowid))
}

/** 发放单片所有权（幂等）。 */
export function grantPurchase({ userId, dramaId, orderId, kind, rentalHours }) {
  const existing = one('SELECT * FROM purchases WHERE order_id = ?', orderId)
  if (existing) return existing
  const expiresAt = kind === 'rental'
    ? new Date(Date.now() + Number(rentalHours ?? 72) * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    : null
  const info = db.prepare(`INSERT INTO purchases (user_id, drama_id, order_id, kind, expires_at, status)
    VALUES (?, ?, ?, ?, ?, 'active')`).run(userId, dramaId, orderId, kind ?? 'single', expiresAt)
  return one('SELECT * FROM purchases WHERE id = ?', Number(info.lastInsertRowid))
}

/** 退款/风控时回收权益（按订单）。 */
export function revokeByOrder(orderId) {
  const subs = db.prepare("UPDATE subscriptions SET status = 'revoked' WHERE order_id = ? AND status = 'active'").run(orderId)
  const buys = db.prepare("UPDATE purchases SET status = 'revoked' WHERE order_id = ? AND status = 'active'").run(orderId)
  return { subscriptions: Number(subs.changes ?? 0), purchases: Number(buys.changes ?? 0) }
}

/** 批量判定某部剧的分集状态（一次查询，避免 N+1）。 */
export function decideEpisodes({ drama, policy, subscription, purchase, episodes, rules }) {
  const subscriptionCovers = Boolean(subscription) && scopeMatches(subscription.scope, drama)
  const ruleList = rules ?? rulesOfDrama(drama.id)
  return episodes.map((episode) => {
    const rule = ruleFor(ruleList, episode.no)
    let allow = false
    let source = null
    let reason = null
    let price = 0
    if (purchase) {
      allow = true
      source = 'purchase'
    } else if (rule) {
      if (rule.mode === 'free') { allow = true; source = 'free' }
      else if (rule.mode === 'vip') {
        if (subscriptionCovers) { allow = true; source = 'subscription' }
        else reason = 'vip_required'
      } else {
        reason = 'single_purchase_required'
        price = Number(rule.price_cny) || Number(policy.single_price_cny) || 0
      }
    } else if (subscriptionCovers) {
      allow = true
      source = 'subscription'
    } else if (policy.access_mode === 'free') {
      allow = true
      source = 'free'
    } else if (Number(policy.free_episodes) > 0 && Number(episode.no) <= Number(policy.free_episodes)) {
      allow = true
      source = 'free'
    } else {
      reason = policy.access_mode === 'paid' ? 'single_purchase_required' : 'subscription_required'
    }
    return {
      ...episode,
      allow,
      source,
      reason,
      rule,
      trialSeconds: allow ? 0 : policy.trial_seconds,
      price: allow ? 0 : price || policy.single_price_cny,
    }
  })
}

export function entitlementsOf(userId) {
  const subscription = activeSubscription(userId)
  const purchases = userId
    ? all(`SELECT p.*, d.title FROM purchases p JOIN dramas d ON d.id = p.drama_id
           WHERE p.user_id = ? AND p.status = 'active' ORDER BY p.id DESC`, userId)
    : []
  return { subscription, purchases }
}

/* ---------------- 播放令牌（nginx secure_link 兼容） ---------------- */

const linkSecret = () => getSetting('site', {}).linkSecret ?? 'dev-link-secret'

/** 播放链接有效期（秒）：默认 5 分钟，可用 MH_LINK_TTL 覆盖（60–1800）。 */
export const LINK_TTL = Math.min(1800, Math.max(60, Number(process.env.MH_LINK_TTL ?? 300) || 300))

/**
 * UA 指纹：同一链接只允许签发时的浏览器使用，防止链接被复制到别处/脚本盗链。
 * 只取 UA 的哈希前 16 位进签名，不改 Cookie 结构。
 */
export function uaFingerprint(ua) {
  const text = String(ua ?? '').trim().toLowerCase()
  if (!text) return 'noua'
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

/**
 * 签名作用域：HLS 是 master → <rendition>/index.m3u8 → seg_%03d.ts 的多层相对路径，
 * 只签单个 URI 会让分片全部 403。这里统一把 /media/hls/<episodeId>/ 作为作用域，
 * 同一集的所有播放列表与分片共用一次签名。
 */
export function linkScope(uri) {
  const text = String(uri ?? '')
  const match = text.match(/^(\/media\/hls\/[^/?#]+\/)/)
  return match ? match[1] : text
}

/**
 * base64url(md5(expires + scope + ua + secret))。
 * scope 为 /media/hls/<episodeId>/ 时，该目录下所有文件通用；
 * 其他路径退化为精确匹配。
 */
export function secureLink(uri, expiresInSeconds = LINK_TTL, ua = '') {
  const scope = linkScope(uri)
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds
  const digest = createHash('md5').update(`${expires}${scope}${uaFingerprint(ua)}${linkSecret()}`).digest()
  const sign = digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return { expires, sign, scope, url: `${uri}?sign=${sign}&expires=${expires}` }
}

export function verifyLink(uri, sign, expires, ua = '') {
  if (!sign || !expires) return false
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false
  const digest = createHash('md5').update(`${expires}${linkScope(uri)}${uaFingerprint(ua)}${linkSecret()}`).digest()
  const expected = digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const left = Buffer.from(expected)
  const right = Buffer.from(String(sign))
  return left.length === right.length && timingSafeEqual(left, right)
}

/** 设备/用户级 HMAC 令牌（可选，防转发）。 */
export function signPlayToken(payload, ttlSeconds = 600) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })).toString('base64url')
  const mac = createHmac('sha256', linkSecret()).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyPlayToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return undefined
  const [body, mac] = token.split('.')
  const expected = createHmac('sha256', linkSecret()).update(body).digest('base64url')
  if (mac !== expected) return undefined
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) return undefined
    return payload
  } catch { return undefined }
}

/**
 * 收银台票据：模拟支付页在独立标签页打开，带不了 Bearer，也不能把用户 token 放进 URL。
 * 所以由服务端给该订单签一张短时票据，收银台只提交 { outTradeNo, ticket }。
 */
export function signPayTicket(outTradeNo, ttlSeconds = 900) {
  const body = Buffer.from(JSON.stringify({ o: String(outTradeNo ?? ''), exp: Date.now() + ttlSeconds * 1000 })).toString('base64url')
  const mac = createHmac('sha256', linkSecret()).update(`pay:${body}`).digest('base64url')
  return `${body}.${mac}`
}

export function verifyPayTicket(outTradeNo, ticket) {
  if (typeof ticket !== 'string' || !ticket.includes('.')) return false
  const [body, mac] = ticket.split('.')
  const expected = createHmac('sha256', linkSecret()).update(`pay:${body}`).digest('base64url')
  const left = Buffer.from(mac)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp < Date.now()) return false
    return String(payload.o) === String(outTradeNo ?? '')
  } catch { return false }
}
