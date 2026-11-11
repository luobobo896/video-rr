/** 渠道归因：触达解析、访客/账号快照、订单快照和投流分析。 */
import { createHash } from 'node:crypto'
import { db, getSetting } from './db.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)
const run = (sql, ...args) => db.prepare(sql).run(...args)

const nowSql = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const normalizeVisitorId = (value) => {
  const id = String(value ?? '').trim().slice(0, 64)
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null
}
const normalizeHost = (value) => String(value ?? '').trim().toLowerCase().split(',')[0].split(':')[0].replace(/^www\./, '')
const hashShort = (value) => createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 32)
const validText = (value) => String(value ?? '').trim()

export function directChannel() {
  return one("SELECT * FROM channels WHERE channel_code = 'direct'")
}

export function legacyChannel() {
  return one("SELECT * FROM channels WHERE channel_code = 'legacy_unattributed'")
}

function validByDate(row) {
  if (!row) return false
  const now = nowSql()
  if (row.status !== 'active') return false
  if (row.valid_from && row.valid_from > now) return false
  if (row.valid_to && row.valid_to < now) return false
  return true
}

function findPromo(code, purpose = 'acquisition') {
  const normalized = validText(code).toUpperCase()
  if (!normalized) return { row: null, reason: null }
  const row = one(`SELECT p.*, c.id AS resolved_channel_id, c.channel_code, c.channel_name,
      c.channel_type, c.status AS channel_status
    FROM promo_codes p JOIN channels c ON c.id = p.channel_id
    WHERE p.code = ? AND p.purpose = ?`, normalized, purpose)
  if (!row) return { row: null, reason: 'promo_not_found' }
  if (!validByDate(row) || row.channel_status !== 'active') return { row: null, reason: 'promo_inactive' }
  if (row.max_uses > 0 && row.used_count >= row.max_uses) return { row: null, reason: 'promo_exhausted' }
  return { row, reason: null }
}

function findDomain(host, pathname) {
  if (!host) return null
  const rows = all(`SELECT d.*, c.id AS resolved_channel_id, c.channel_code, c.channel_name,
      c.channel_type, c.status AS channel_status
    FROM channel_domains d JOIN channels c ON c.id = d.channel_id
    WHERE d.host = ? AND d.status = 'active'
    ORDER BY length(d.path_prefix) DESC, d.id ASC`, host)
  const path = pathname || '/'
  return rows.find((row) => validByDate(row) && row.channel_status === 'active' && path.startsWith(row.path_prefix || '/')) ?? null
}

function touchSnapshot(row, { visitorId, userId, domainSource, landingUrl, referrer, utm, matchRule, touchId, rejectedCode }) {
  const channelId = Number(row.resolved_channel_id ?? row.channel_id ?? row.id)
  return {
    channelId,
    channelCode: row.channel_code,
    channelName: row.channel_name,
    channelType: row.channel_type,
    campaignId: row.campaign_id ? Number(row.campaign_id) : null,
    promoCode: row.promo_code ?? null,
    domainSource: domainSource || null,
    landingUrl: landingUrl || null,
    referrer: referrer || null,
    utm: utm || {},
    matchRule,
    firstEnterAt: row.first_enter_at ?? null,
    attributedAt: row.attributed_at ?? null,
    attributionModel: row.attribution_model ?? 'first_touch',
    lastTouchAt: row.last_touch_at ?? null,
    visitorId,
    userId: userId ?? null,
    touchId,
    rejectedPromoCode: rejectedCode || null,
  }
}

function ensureVisitor({ visitorId, userId, path, ip, ua }) {
  run(`INSERT INTO visitors (id, user_id, first_path, ip, ua)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = COALESCE(excluded.user_id, visitors.user_id),
      last_seen = datetime('now'),
      ip = COALESCE(excluded.ip, visitors.ip),
      ua = COALESCE(excluded.ua, visitors.ua)`,
  visitorId, userId ?? null, String(path ?? '').slice(0, 200), String(ip ?? '').slice(0, 64), String(ua ?? '').slice(0, 200))
}

/** 记录一次进入触达；promo code 优先，其次域名，最后 direct。 */
export function recordTouch({
  visitorId: rawVisitorId, userId, promoCode, host, pathname = '/', referrer, utm = {}, ip, ua,
} = {}) {
  const visitorId = normalizeVisitorId(rawVisitorId) || (userId ? `u_${String(userId).padStart(8, '0')}` : null)
  if (!visitorId) throw Object.assign(new Error('访客标识无效'), { code: 'invalid_visitor', status: 400 })
  const domainSource = normalizeHost(host)
  const landingUrl = String(pathname || '/').slice(0, 500)
  const cleanUtm = Object.fromEntries(['source', 'medium', 'campaign', 'content', 'term']
    .map((key) => [key, validText(utm?.[key]).slice(0, 120)]).filter(([, value]) => value))

  const promo = findPromo(promoCode, 'acquisition')
  let match = null
  let matchRule = 'direct'
  let rejectedCode = null
  if (promo.row) {
    match = promo.row
    matchRule = 'promo_code'
  } else {
    rejectedCode = promo.reason
    match = findDomain(domainSource, pathname)
    if (match) matchRule = 'domain'
  }
  if (!match) match = directChannel()
  if (!match) throw Object.assign(new Error('直连渠道未初始化'), { code: 'channel_missing', status: 500 })
  const channelId = Number(match.resolved_channel_id ?? match.channel_id ?? match.id)
  const matchedPromoCode = matchRule === 'promo_code' ? (match.code ?? match.promo_code ?? null) : null

  const duplicate = one(`SELECT * FROM channel_touches
    WHERE visitor_id = ? AND channel_id = ? AND COALESCE(campaign_id, 0) = COALESCE(?, 0)
      AND COALESCE(promo_code, '') = COALESCE(?, '') AND match_rule = ?
      AND datetime(occurred_at) >= datetime('now', '-5 seconds')
    ORDER BY id DESC LIMIT 1`,
  visitorId, channelId, match.campaign_id ?? null, matchedPromoCode, matchRule)
  if (duplicate) {
    const visitor = one('SELECT * FROM visitors WHERE id = ?', visitorId) ?? {}
    return { ...touchSnapshot({
      ...match,
      first_enter_at: visitor.first_enter_at,
      attributed_at: visitor.attributed_at,
      attribution_model: visitor.attribution_model,
      last_touch_at: visitor.last_touch_at,
      promo_code: matchedPromoCode,
    }, { visitorId, userId, domainSource, landingUrl, referrer, utm: cleanUtm, matchRule, touchId: duplicate.id, rejectedCode }), isNewTouch: false }
  }

  const info = run(`INSERT INTO channel_touches
    (visitor_id, user_id, channel_id, campaign_id, promo_code, channel_type, domain_source, landing_url,
     referrer_url, utm_source, utm_medium, utm_campaign, utm_content, utm_term, match_rule, is_valid, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))`,
  visitorId, userId ?? null, channelId, match.campaign_id ?? null, matchedPromoCode,
  match.channel_type, domainSource || null, landingUrl, String(referrer ?? '').slice(0, 500) || null,
  cleanUtm.source ?? null, cleanUtm.medium ?? null, cleanUtm.campaign ?? null,
  cleanUtm.content ?? null, cleanUtm.term ?? null, matchRule)
  const touchId = Number(info.lastInsertRowid)
  ensureVisitor({ visitorId, userId, path: landingUrl, ip, ua })

  if (matchRule !== 'direct') {
    run(`UPDATE visitors SET
      first_channel_id = COALESCE(first_channel_id, ?),
      first_campaign_id = COALESCE(first_campaign_id, ?),
      first_promo_code = COALESCE(first_promo_code, ?),
      first_domain_source = COALESCE(first_domain_source, ?),
      first_enter_at = COALESCE(first_enter_at, datetime('now')),
      attributed_at = COALESCE(attributed_at, datetime('now')),
      attribution_model = COALESCE(attribution_model, 'first_touch'),
      first_channel_touch_id = COALESCE(first_channel_touch_id, ?),
      last_channel_id = ?, last_touch_at = datetime('now')
      WHERE id = ?`,
    channelId, match.campaign_id ?? null, matchedPromoCode, domainSource || null,
    touchId, channelId, visitorId)
  } else {
    run("UPDATE visitors SET last_channel_id = ?, last_touch_at = datetime('now') WHERE id = ?", channelId, visitorId)
  }

  if (userId) {
    const existing = one('SELECT * FROM user_acquisitions WHERE user_id = ?', userId)
    if (!existing) {
      bindUserAcquisition({ userId, visitorId })
    } else if (matchRule !== 'direct') {
      run(`UPDATE user_acquisitions SET last_channel_id = ?, last_touch_at = datetime('now'),
        updated_at = datetime('now') WHERE user_id = ?`, channelId, userId)
    }
  }

  const visitor = one('SELECT * FROM visitors WHERE id = ?', visitorId) ?? {}
  return {
    ...touchSnapshot({
      ...match,
      first_enter_at: visitor.first_enter_at,
      attributed_at: visitor.attributed_at,
      attribution_model: visitor.attribution_model,
      last_touch_at: visitor.last_touch_at,
      promo_code: matchedPromoCode,
    }, { visitorId, userId, domainSource, landingUrl, referrer, utm: cleanUtm, matchRule, touchId, rejectedCode }),
    isNewTouch: true,
  }
}

/** 注册/首次登录后固定账号首次归因；已有归因不覆盖。 */
export function bindUserAcquisition({ userId, visitorId } = {}) {
  if (!userId) return null
  const existing = one('SELECT * FROM user_acquisitions WHERE user_id = ?', userId)
  if (existing) return existing
  const visitor = normalizeVisitorId(visitorId) ? one('SELECT * FROM visitors WHERE id = ?', visitorId) : null
  const fallback = directChannel()
  const attributionConfig = getSetting('attribution', {})
  const windowDays = Math.max(1, Math.min(180, Number(attributionConfig.windowDays ?? 30) || 30))
  const firstSeenAt = visitor?.first_enter_at
    ? Date.parse(String(visitor.first_enter_at).replace(' ', 'T') + 'Z') : 0
  const withinWindow = firstSeenAt > 0 && firstSeenAt >= Date.now() - windowDays * 86400_000
  const originalPromoCode = withinWindow ? visitor?.first_promo_code ?? null : null
  let promoCode = originalPromoCode
  if (promoCode) {
    const promo = one(`SELECT * FROM promo_codes WHERE code = ? AND status = 'active'
      AND (valid_from IS NULL OR valid_from <= datetime('now'))
      AND (valid_to IS NULL OR valid_to >= datetime('now'))`, promoCode)
    const claimed = promo ? run(`UPDATE promo_codes SET used_count = used_count + 1
      WHERE code = ? AND status = 'active' AND (max_uses = 0 OR used_count < max_uses)`, promoCode) : null
    if (!promo || Number(claimed?.changes ?? 0) !== 1) promoCode = null
  }
  const canUseVisitorChannel = withinWindow && (!originalPromoCode || Boolean(promoCode))
  const channelId = (canUseVisitorChannel ? visitor?.first_channel_id : null) ?? fallback?.id
  if (!channelId) return null
  const now = nowSql()
  const firstEnterAt = withinWindow ? visitor.first_enter_at : now
  const touchId = withinWindow ? visitor?.first_channel_touch_id ?? null : null
  run(`INSERT OR IGNORE INTO user_acquisitions
    (user_id, first_channel_id, first_campaign_id, first_promo_code, first_domain_source,
     first_enter_at, attributed_at, attribution_model, attribution_touch_id, last_channel_id, last_touch_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'first_touch', ?, ?, ?)`,
  userId, channelId, canUseVisitorChannel ? visitor?.first_campaign_id ?? null : null,
  promoCode,
  canUseVisitorChannel ? visitor?.first_domain_source ?? null : null, firstEnterAt, now, touchId,
  canUseVisitorChannel ? visitor?.last_channel_id ?? channelId : channelId,
  canUseVisitorChannel ? visitor?.last_touch_at ?? now : now)
  if (visitorId) run('UPDATE visitors SET user_id = COALESCE(user_id, ?) WHERE id = ?', userId, visitorId)
  return one('SELECT * FROM user_acquisitions WHERE user_id = ?', userId)
}

/** 订单创建时读取只读快照；不回写历史订单。 */
export function getOrderAttribution({ userId, visitorId } = {}) {
  let acquisition = userId ? one('SELECT * FROM user_acquisitions WHERE user_id = ?', userId) : null
  if (!acquisition && userId) acquisition = bindUserAcquisition({ userId, visitorId })
  if (!acquisition) return {
    channelId: directChannel()?.id ?? null, channelType: 'direct', campaignId: null,
    promoCode: null, domainSource: null, firstEnterAt: nowSql(), attributedAt: nowSql(),
    attributionModel: 'first_touch', touchId: null, status: 'ok', snapshot: {},
  }
  const channel = one('SELECT * FROM channels WHERE id = ?', acquisition.first_channel_id)
  let selectedChannelId = acquisition.first_channel_id
  let selectedCampaignId = acquisition.first_campaign_id
  let selectedPromoCode = acquisition.first_promo_code
  let selectedDomain = acquisition.first_domain_source
  let selectedTouchId = acquisition.attribution_touch_id
  let selectedModel = acquisition.attribution_model ?? 'first_touch'
  let touch = acquisition.attribution_touch_id
    ? one('SELECT * FROM channel_touches WHERE id = ?', acquisition.attribution_touch_id) : null
  const configuredModel = String(getSetting('attribution', {})?.model ?? 'first_touch')
  if (configuredModel === 'last_touch' && (userId || visitorId)) {
    const attributionConfig = getSetting('attribution', {})
    const windowDays = Math.max(1, Math.min(180, Number(attributionConfig.windowDays ?? 30) || 30))
    const since = new Date(Date.now() - windowDays * 86400_000).toISOString().slice(0, 19).replace('T', ' ')
    const lastTouch = one(`SELECT t.*, c.channel_type AS resolved_channel_type
      FROM channel_touches t JOIN channels c ON c.id = t.channel_id
      WHERE (t.user_id = ? OR t.visitor_id = ?) AND t.match_rule <> 'direct' AND t.occurred_at >= ?
      ORDER BY t.id DESC LIMIT 1`, Number(userId) || 0, String(visitorId ?? ''), since)
    if (lastTouch) {
      selectedChannelId = lastTouch.channel_id
      selectedCampaignId = lastTouch.campaign_id
      selectedPromoCode = lastTouch.promo_code
      selectedDomain = lastTouch.domain_source
      selectedTouchId = lastTouch.id
      selectedModel = 'last_touch'
      touch = lastTouch
    }
  }
  const selectedChannel = selectedChannelId === acquisition.first_channel_id
    ? channel : one('SELECT * FROM channels WHERE id = ?', selectedChannelId)
  return {
    channelId: selectedChannelId,
    channelType: selectedChannel?.channel_type ?? 'direct',
    campaignId: selectedCampaignId ?? null,
    promoCode: selectedPromoCode ?? null,
    domainSource: selectedDomain ?? null,
    firstEnterAt: acquisition.first_enter_at,
    attributedAt: selectedModel === 'last_touch' ? nowSql() : acquisition.attributed_at,
    attributionModel: selectedModel,
    touchId: selectedTouchId ?? null,
    status: 'ok',
    snapshot: {
      matchRule: touch?.match_rule ?? 'direct',
      landingUrl: touch?.landing_url ?? null,
      referrer: touch?.referrer_url ?? null,
      utm: touch ? {
        source: touch.utm_source, medium: touch.utm_medium, campaign: touch.utm_campaign,
        content: touch.utm_content, term: touch.utm_term,
      } : {},
    },
  }
}

export function analyticsChannelRows({ days = 7, channelId } = {}) {
  const since = new Date(Date.now() - Math.max(1, Number(days) || 7) * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ')
  const where = channelId ? 'WHERE c.id = ?' : ''
  const args = channelId ? [Number(channelId)] : []
  const rows = all(`SELECT c.id AS channelId, c.channel_code AS channelCode, c.channel_name AS channelName,
      c.channel_type AS channelType,
      (SELECT COUNT(DISTINCT t.visitor_id) FROM channel_touches t
        WHERE t.channel_id = c.id AND t.occurred_at >= ?) AS visitors,
      (SELECT COUNT(*) FROM user_acquisitions ua
        WHERE ua.first_channel_id = c.id AND ua.attributed_at >= ?) AS newUsers,
      (SELECT COUNT(*) FROM orders o
        WHERE o.acquisition_channel_id = c.id AND o.created_at >= ?) AS createdOrders,
      (SELECT COUNT(*) FROM orders o
        WHERE o.acquisition_channel_id = c.id AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?) AS paidOrders,
      (SELECT COUNT(DISTINCT o.user_id) FROM orders o
        WHERE o.acquisition_channel_id = c.id AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?) AS paidUsers,
      (SELECT COALESCE(SUM(o.amount_cny),0) FROM orders o
        WHERE o.acquisition_channel_id = c.id AND o.status IN ('paid','fulfilled') AND o.paid_at >= ?) AS grossPaidAmount,
      (SELECT COALESCE(SUM(r.amount),0) FROM refunds r JOIN orders o ON o.id = r.order_id
        WHERE o.acquisition_channel_id = c.id AND r.status = 'done' AND r.done_at >= ?) AS refundAmount,
      (SELECT COALESCE(SUM(s.spend_fen),0) / 100.0 FROM channel_daily_spend s
        WHERE s.channel_id = c.id AND s.stat_date >= date(?)) AS spend
    FROM channels c
    ${where}
    ORDER BY c.id ASC`, since, since, since, since, since, since, since, since, ...args)
  const normalized = rows.map((row) => ({
    ...row,
    visitors: Number(row.visitors ?? 0),
    newUsers: Number(row.newUsers ?? 0),
    createdOrders: Number(row.createdOrders ?? 0),
    paidOrders: Number(row.paidOrders ?? 0),
    paidUsers: Number(row.paidUsers ?? 0),
    grossPaidAmount: Number(row.grossPaidAmount ?? 0),
    refundAmount: Number(row.refundAmount ?? 0),
    netRevenue: Number(row.grossPaidAmount ?? 0) - Number(row.refundAmount ?? 0),
    payRate: Number(row.createdOrders ?? 0) ? Number(row.paidOrders ?? 0) / Number(row.createdOrders) * 100 : 0,
    visitorToPaidRate: Number(row.visitors ?? 0) ? Number(row.paidUsers ?? 0) / Number(row.visitors) * 100 : 0,
    aov: Number(row.paidOrders ?? 0) ? Number(row.grossPaidAmount ?? 0) / Number(row.paidOrders) : 0,
    spend: row.spend === null || row.spend === undefined ? null : Number(row.spend),
    roas: row.spend && Number(row.spend) > 0 ? Number(row.grossPaidAmount ?? 0) / Number(row.spend) : null,
  }))
  const totals = normalized.reduce((acc, row) => {
    acc.visitors += row.visitors
    acc.newUsers += row.newUsers
    acc.createdOrders += row.createdOrders
    acc.paidOrders += row.paidOrders
    acc.paidUsers += row.paidUsers
    acc.grossPaidAmount += row.grossPaidAmount
    acc.refundAmount += row.refundAmount
    acc.spend += row.spend ?? 0
    return acc
  }, { visitors: 0, newUsers: 0, createdOrders: 0, paidOrders: 0, paidUsers: 0, grossPaidAmount: 0, refundAmount: 0, spend: 0 })
  totals.netRevenue = totals.grossPaidAmount - totals.refundAmount
  totals.payRate = totals.createdOrders ? totals.paidOrders / totals.createdOrders * 100 : 0
  totals.visitorToPaidRate = totals.visitors ? totals.paidUsers / totals.visitors * 100 : 0
  totals.aov = totals.paidOrders ? totals.grossPaidAmount / totals.paidOrders : 0
  totals.roas = totals.spend > 0 ? totals.grossPaidAmount / totals.spend : null
  return { range: { days: Number(days) || 7, since }, rows: normalized, totals }
}

export function listChannels() {
  return all(`SELECT c.*,
    (SELECT COUNT(*) FROM channel_domains d WHERE d.channel_id = c.id) AS domainCount,
    (SELECT COUNT(*) FROM promo_codes p WHERE p.channel_id = c.id) AS promoCodeCount
    FROM channels c ORDER BY c.id ASC`)
}

export function upsertChannel(payload = {}) {
  const code = validText(payload.channelCode ?? payload.channel_code)
  if (!code) throw Object.assign(new Error('渠道编码必填'), { code: 'channel_code_required', status: 400 })
  const fields = [
    code.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 48),
    validText(payload.channelName ?? payload.channel_name) || code,
    validText(payload.channelType ?? payload.channel_type) || 'paid_ad',
    payload.status === 'disabled' ? 'disabled' : 'active',
    validText(payload.ownerName ?? payload.owner_name) || null,
    payload.validFrom ?? payload.valid_from ?? null,
    payload.validTo ?? payload.valid_to ?? null,
  ]
  const existing = one('SELECT * FROM channels WHERE channel_code = ?', fields[0])
  if (existing) {
    run(`UPDATE channels SET channel_name = ?, channel_type = ?, status = ?, owner_name = ?,
      valid_from = ?, valid_to = ?, updated_at = datetime('now') WHERE id = ?`,
    fields[1], fields[2], fields[3], fields[4], fields[5], fields[6], existing.id)
    return one('SELECT * FROM channels WHERE id = ?', existing.id)
  }
  const info = run(`INSERT INTO channels (channel_code, channel_name, channel_type, status, owner_name, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, ...fields)
  return one('SELECT * FROM channels WHERE id = ?', Number(info.lastInsertRowid))
}

export function upsertChannelDomain(payload = {}) {
  const channelId = Number(payload.channelId ?? payload.channel_id)
  const host = normalizeHost(payload.host)
  const pathPrefix = validText(payload.pathPrefix ?? payload.path_prefix) || '/'
  if (!channelId || !host) throw Object.assign(new Error('渠道和域名必填'), { code: 'domain_required', status: 400 })
  const existing = one('SELECT * FROM channel_domains WHERE host = ? AND path_prefix = ?', host, pathPrefix)
  if (existing) {
    run(`UPDATE channel_domains SET channel_id = ?, campaign_id = ?, status = ?, valid_from = ?, valid_to = ?
      WHERE id = ?`, channelId, Number(payload.campaignId ?? payload.campaign_id) || null,
    payload.status === 'disabled' ? 'disabled' : 'active',
    payload.validFrom ?? payload.valid_from ?? null, payload.validTo ?? payload.valid_to ?? null, existing.id)
    return one('SELECT * FROM channel_domains WHERE id = ?', existing.id)
  }
  const info = run(`INSERT INTO channel_domains
    (channel_id, campaign_id, host, path_prefix, status, valid_from, valid_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  channelId, Number(payload.campaignId ?? payload.campaign_id) || null, host, pathPrefix,
  payload.status === 'disabled' ? 'disabled' : 'active',
  payload.validFrom ?? payload.valid_from ?? null, payload.validTo ?? payload.valid_to ?? null)
  return one('SELECT * FROM channel_domains WHERE id = ?', Number(info.lastInsertRowid))
}

export function upsertPromoCode(payload = {}) {
  const code = validText(payload.code).toUpperCase()
  const channelId = Number(payload.channelId ?? payload.channel_id)
  if (!code || !channelId) throw Object.assign(new Error('推广码和渠道必填'), { code: 'promo_required', status: 400 })
  const existing = one('SELECT * FROM promo_codes WHERE code = ?', code)
  if (existing) {
    run(`UPDATE promo_codes SET channel_id = ?, campaign_id = ?, purpose = ?, distributor_user_id = ?,
      status = ?, valid_from = ?, valid_to = ?, max_uses = ?, updated_at = datetime('now')
      WHERE id = ?`, channelId, Number(payload.campaignId ?? payload.campaign_id) || null,
    payload.purpose === 'distribution' ? 'distribution' : 'acquisition',
    Number(payload.distributorUserId ?? payload.distributor_user_id) || null,
    payload.status === 'disabled' ? 'disabled' : 'active',
    payload.validFrom ?? payload.valid_from ?? null, payload.validTo ?? payload.valid_to ?? null,
    Number(payload.maxUses ?? payload.max_uses ?? 0) || 0, existing.id)
    return one('SELECT * FROM promo_codes WHERE id = ?', existing.id)
  }
  const info = run(`INSERT INTO promo_codes
    (code, channel_id, campaign_id, purpose, distributor_user_id, status, valid_from, valid_to, max_uses)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  code, channelId, Number(payload.campaignId ?? payload.campaign_id) || null,
  payload.purpose === 'distribution' ? 'distribution' : 'acquisition',
  Number(payload.distributorUserId ?? payload.distributor_user_id) || null,
  payload.status === 'disabled' ? 'disabled' : 'active',
  payload.validFrom ?? payload.valid_from ?? null, payload.validTo ?? payload.valid_to ?? null,
  Number(payload.maxUses ?? payload.max_uses ?? 0) || 0)
  return one('SELECT * FROM promo_codes WHERE id = ?', Number(info.lastInsertRowid))
}

export function listPromoCodes() {
  return all(`SELECT p.*, c.channel_name FROM promo_codes p
    JOIN channels c ON c.id = p.channel_id ORDER BY p.id DESC LIMIT 200`)
}

export function listChannelDomains() {
  return all(`SELECT d.*, c.channel_name FROM channel_domains d
    JOIN channels c ON c.id = d.channel_id ORDER BY d.id DESC LIMIT 200`)
}

export { hashShort, normalizeHost, normalizeVisitorId }
