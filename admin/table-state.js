export function readHashQuery(hash = location.hash) {
  return Object.fromEntries(new URLSearchParams(String(hash).split('?')[1] ?? ''))
}

export function writeHashQuery(route, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) query.set(key, String(value))
  }
  const suffix = query.toString()
  history.replaceState(null, '', `#/${route}${suffix ? `?${suffix}` : ''}`)
}

export function pageNumbers(current, pages) {
  const total = Math.max(1, Number(pages) || 1)
  const active = Math.min(Math.max(1, Number(current) || 1), total)
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const values = new Set([1, total, active - 1, active, active + 1])
  if (active <= 4) [2, 3, 4, 5].forEach((value) => values.add(value))
  if (active >= total - 3) [total - 4, total - 3, total - 2, total - 1].forEach((value) => values.add(value))
  const sorted = [...values].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b)
  const result = []
  for (const value of sorted) {
    if (result.length && value - result[result.length - 1] > 1) result.push('…')
    result.push(value)
  }
  return result
}

/**
 * 白名单数值：localStorage / URL 里的脏值（'abc'、'0'、'9999'）不能直接拼进查询串。
 * 只接受 allowed 里的值，其余一律回退 fallback。
 */
export function pickAllowedNumber(value, allowed, fallback) {
  const num = Number(value)
  return (Array.isArray(allowed) ? allowed : []).includes(num) ? num : fallback
}

/**
 * 列表页 URL 状态还原：把 `readHashQuery()` 的结果并进默认状态。
 * 数字型默认值按数字还原（脏值回退默认值），其余按字符串。
 */
export function hydrateListState(initial, defaults = {}) {
  const source = initial ?? {}
  const out = { ...defaults }
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = source[key]
    if (raw === undefined || raw === null || raw === '') continue
    if (typeof fallback === 'number') {
      const num = Number(raw)
      out[key] = Number.isFinite(num) ? num : fallback
    } else if (typeof fallback === 'boolean') {
      out[key] = raw === '1' || raw === 'true'
    } else {
      out[key] = String(raw)
    }
  }
  return out
}

/** 后台统一按北京时间展示时钟：同屏不能出现浏览器本地时区与 Asia/Shanghai 混用。 */
export function formatClock(value = new Date(), timeZone = 'Asia/Shanghai') {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { timeZone, hour12: false })
}

/** 优惠券默认有效期：今天 + N 天（YYYY-MM-DD），不再写死某个年份。 */
export function couponValidTo(now = new Date(), days = 30) {
  const date = new Date(now.getTime())
  const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 30
  date.setDate(date.getDate() + span)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 优惠券草稿校验：面额必须 > 0，折扣必须落在 0–100，门槛不能为负。 */
export function validateCouponDraft({ discountType = 'amount', discountValue, minAmount = 0 } = {}) {
  const value = Number(discountValue)
  const min = Number(minAmount)
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: discountType === 'percent' ? '折扣必须大于 0%' : '面额必须大于 0 元' }
  }
  if (discountType === 'percent' && value > 100) return { ok: false, message: '折扣不能超过 100%' }
  if (!Number.isFinite(min) || min < 0) return { ok: false, message: '使用门槛不能为负数' }
  return { ok: true, message: '' }
}

/**
 * 请求序号守卫：同一个接口只允许「最新一次」的响应写状态/渲染。
 * begin() 每次调用自增；响应回来时用 isLatest() 判断自己是否已被更新的请求取代。
 */
export function createSequencer() {
  const latest = new Map()
  return {
    begin(key) {
      const next = (latest.get(key) ?? 0) + 1
      latest.set(key, next)
      return next
    },
    isLatest(key, token) {
      return latest.get(key) === token
    },
    tokenOf(key) {
      return latest.get(key) ?? 0
    },
    forget(key) {
      latest.delete(key)
    },
    reset() {
      latest.clear()
    },
  }
}

/** 分集表格指纹：内容没变就不重建 tbody（重建会丢焦点与滚动位置）。 */
export function episodesSignature(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => [row?.id, row?.no, row?.title, row?.vip, row?.status, row?.progress, row?.hls_path, row?.remote_url, row?.error]
      .map((value) => String(value ?? ''))
      .join('\u0001'))
    .join('\u0002')
}

/** 取最小优先级并留出更小的空位：空数组 / 脏值不能算出 Infinity 写进请求。 */
export function nextTopPriority(items = [], key = 'priority', fallback = 100) {
  const values = (Array.isArray(items) ? items : [])
    .map((item) => Number(item?.[key]))
    .filter((value) => Number.isFinite(value))
  const min = values.length ? Math.min(...values) : Number(fallback)
  return (Number.isFinite(min) ? min : Number(fallback) || 100) - 10
}

/** 跨页选中：按 id 存 Set，翻页不丢；返回新 Set（不改原集合）。 */
export function toggleSelection(selected, ids, checked) {
  const next = new Set(selected ?? [])
  for (const id of ids ?? []) {
    if (id === null || id === undefined || id === '') continue
    const numeric = Number(id)
    if (!Number.isFinite(numeric)) continue
    if (checked) next.add(numeric)
    else next.delete(numeric)
  }
  return next
}

/** 选中态摘要：本页选了几个 / 跨页共几个，用来写「本页全选」文案。 */
export function selectionSummary(selected, pageIds = []) {
  const all = selected instanceof Set ? selected : new Set(selected ?? [])
  const ids = (pageIds ?? []).map(Number).filter((id) => Number.isFinite(id))
  const onPage = ids.filter((id) => all.has(id)).length
  return {
    onPage,
    total: all.size,
    allOnPage: ids.length > 0 && onPage === ids.length,
    noneOnPage: onPage === 0,
  }
}
