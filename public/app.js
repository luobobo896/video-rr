/** 影巢复刻站前端：Vue 3 应用外壳 + 既有业务页面渲染器。 */
import { getLang, initI18n, setLang, t, translateText } from './i18n.js'
import { bindChromeActions, syncChrome } from './chrome.js'
import { matchTrack } from './track-match.js'

const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)
const VISITOR_KEY = 'mh-visitor-id'
function loadVisitorId() {
  try {
    const saved = localStorage.getItem(VISITOR_KEY)
    if (/^[A-Za-z0-9_-]{8,64}$/.test(saved ?? '')) return saved
    const id = globalThis.crypto?.randomUUID?.()
      ?? `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    localStorage.setItem(VISITOR_KEY, id)
    return id
  } catch {
    return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  }
}
const VISITOR_ID = loadVisitorId()

function readStoredUser() {
  try {
    const raw = localStorage.getItem('mh-user')
    if (!raw) return undefined
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    try { localStorage.removeItem('mh-user') } catch { /* ignore */ }
    return undefined
  }
}

/** hls.js 加载器：只使用本站 vendored 模块，避免运行时执行未固定的远程代码。 */
let hlsPromise
function loadHls() {
  if (!hlsPromise) {
    hlsPromise = import(`${BASE}/vendor/hls.mjs?v=20261111fix8`)
      .then((mod) => mod.default ?? mod.Hls)
      .catch((error) => {
        hlsPromise = undefined
        console.error('[hls] 本地播放器模块加载失败', error)
        return null
      })
  }
  return hlsPromise
}
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const sidebar = $('#sidebar')
const topbar = $('#topbar')
const modalRoot = $('#modal')
modalRoot?.addEventListener('click', (event) => {
  if (event.target === modalRoot) modalRoot._dialogClose?.()
})
document.addEventListener('error', (event) => {
  const img = event.target
  if (!(img instanceof HTMLImageElement) || !img.dataset.imgFallback) return
  if (img.dataset.imgFallback === 'cover') {
    img.style.display = 'none'
    img.parentElement?.classList.add('noimg')
  } else {
    img.style.visibility = 'hidden'
  }
}, true)
const ICON_PATHS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.3-3.3"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  gem: '<path d="M6 3h12l3 6-9 12L3 9l3-6Z"/><path d="M3 9h18"/><path d="m9 3 3 6 3-6"/><path d="m9 21 3-12 3 12"/>',
  play: '<path d="m9 7 8 5-8 5V7Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3L3 11"/><path d="M3 4v7h7"/><path d="M4 13a8 8 0 0 0 14.9 3l2.1-3"/><path d="M21 20v-7h-7"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.7 6.8-4.3M8.6 13.3l6.8 4.3"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
}
const icon = (name, size = 16) => `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] ?? ''}</svg>`

const CONTENT_RANK_TABS = [
  ['hot', '热播榜'], ['favorite', '收藏榜'], ['completion', '完播榜'],
  ['new', '新片榜'], ['recommend', '推荐榜'],
]

// 内容类型的中文名（服务端 dramaType 是 MOVIE/TV/PLAYLET/VARIETY 这类枚举，
// 详情页 meta 行直接渲染会露出英文，C 端读起来像内部字段）
const DRAMA_CATEGORY_LABEL = {
  MOVIE: '电影', TV: '电视剧', PLAYLET: '短剧', VARIETY: '综艺',
  ANIME: '动漫', COMIC: '动漫', DOCUMENTARY: '纪录片',
}
const DRAMA_CATEGORY_LABEL_EN = {
  MOVIE: 'Movies', TV: 'TV Series', PLAYLET: 'Short Drama', VARIETY: 'Variety',
  ANIME: 'Anime', COMIC: 'Anime', DOCUMENTARY: 'Documentaries',
}
const categoryLabel = (value) => (getLang() === 'en' ? DRAMA_CATEGORY_LABEL_EN : DRAMA_CATEGORY_LABEL)[value] ?? value ?? ''
const state = {
  constants: {},
  me: { history: [], favorites: [] },
  vipDismissed: false,
  token: localStorage.getItem('mh-token') ?? '',
  user: readStoredUser(),
}
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
// 未登录点「免费看第 1 集」时记下目标，登录成功后直接跳过去，不让用户再点一次
let pendingRoute = ''
let preserveScrollOnNextRoute = null
// 登录前发起、需要在登录成功后重放的动作（目前只有"打开付费墙购买"）
let pendingAction
// 当前页面注册的清理函数（定时器、hls 实例、进度与埋点上报），路由切换前统一执行
let routeCleanups = []
// 当前路由的请求作用域：新路由会中止上一页未完成的请求，避免旧响应覆盖新页面。
let apiSignal = null
let routeSeq = 0
let routeController = null

function cleanupRoute() {
  const list = routeCleanups
  routeCleanups = []
  for (const fn of list) { try { fn() } catch { /* 单个清理失败不影响其它 */ } }
  if (impressionObserver) {
    impressionObserver.disconnect()
    impressionObserver = undefined
  }
}

/** 行为埋点：beacon 优先（不阻塞导航），失败静默——埋点永远不能影响用户体验 */
function track(type, data = {}) {
  try {
    const payload = JSON.stringify({ type, visitorId: VISITOR_ID, ...data })
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon(`${BASE}/api/track`, new Blob([payload], { type: 'application/json' }))
      if (ok) return
    }
    fetch(`${BASE}/api/track`, {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: payload,
    }).catch(() => {})
  } catch { /* ignore */ }
}

function initAttribution() {
  try {
    const params = new URLSearchParams(location.search)
    const utm = {
      source: params.get('utm_source'), medium: params.get('utm_medium'),
      campaign: params.get('utm_campaign'), content: params.get('utm_content'), term: params.get('utm_term'),
    }
    const payload = {
      visitorId: VISITOR_ID,
      promoCode: params.get('c') ?? params.get('promoCode') ?? undefined,
      referralCode: params.get('ref') ?? undefined,
      landingPath: `${location.pathname}${location.hash || ''}`,
      referrer: document.referrer || undefined,
      utm,
    }
    fetch(`${BASE}/api/attribution/touch`, {
      method: 'POST', keepalive: true,
      headers: { 'content-type': 'application/json', 'x-mh-visitor': VISITOR_ID },
      body: JSON.stringify(payload),
    }).catch(() => {})
  } catch { /* ignore */ }
}

function trackContentClick(contentId, episodeId = null) {
  if (!contentId) return
  try {
    const path = location.hash || '#/home'
    fetch(`${BASE}/api/content/click`, {
      method: 'POST', keepalive: true,
      headers: {
        'content-type': 'application/json', 'x-mh-visitor': VISITOR_ID,
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: JSON.stringify({
        visitorId: VISITOR_ID, contentId: Number(contentId), episodeId: episodeId ? Number(episodeId) : undefined,
        entryPage: path.split('?')[0], sourceModule: 'card', position: 0,
      }),
    }).catch(() => {})
  } catch { /* ignore */ }
}

view.addEventListener('click', (event) => {
  const card = event.target.closest('.card[data-drama-id], .wide-card[data-drama-id]')
  if (!card) return
  trackContentClick(card.dataset.dramaId)
}, { capture: true })

let impressionObserver
function observeImpressions() {
  if (!('IntersectionObserver' in window)) return
  if (!impressionObserver) {
    impressionObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const dramaId = Number(entry.target.dataset.dramaId)
        impressionObserver.unobserve(entry.target)
        if (dramaId) track('impression', { dramaId })
      }
    }, { threshold: 0.45 })
  }
  view.querySelectorAll('.card[data-drama-id]:not([data-impression-bound]), .wide-card[data-drama-id]:not([data-impression-bound])').forEach((card) => {
    card.dataset.impressionBound = '1'
    impressionObserver.observe(card)
  })
}

async function api(path, options = {}) {
  const { timeoutMs = 15000, signal: externalSignal, ...fetchOptions } = options
  const headers = { ...(fetchOptions.headers ?? {}), 'x-mh-lang': getLang() }
  const blobBody = fetchOptions.body instanceof Blob
  if (VISITOR_ID) headers['x-mh-visitor'] = VISITOR_ID
  if (state.token) headers.authorization = `Bearer ${state.token}`
  if (fetchOptions.body !== undefined && !blobBody) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  let timedOut = false
  const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs) : null
  const forwardAbort = () => controller.abort()
  const signal = externalSignal ?? apiSignal
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    let res
    try {
      res = await fetch(BASE + path, { ...fetchOptions, headers, signal: controller.signal })
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (timedOut) throw Object.assign(new Error('请求超时，请检查网络后重试'), { code: 'timeout' })
        throw Object.assign(new Error('请求已取消'), { name: 'AbortError', code: 'aborted' })
      }
      throw Object.assign(new Error('网络异常，请检查网络后重试'), { code: 'network' })
    }
    let json
    try {
      json = await res.json()
    } catch {
      // nginx 502/504 会返回 HTML，直接 res.json() 会抛英文 SyntaxError 给用户看
      throw Object.assign(new Error(`服务暂时不可用（${res.status}），请稍后重试`), { code: 'bad_response', status: res.status })
    }
    if (json.code === '0401') {
      // 会话过期：清掉本地凭证，避免每次请求都撞 0401 却仍显示"已登录"
      state.token = ''
      state.user = undefined
      localStorage.removeItem('mh-token')
      localStorage.removeItem('mh-user')
      const error = new Error(json.msg || '登录已过期，请重新登录')
      error.code = '0401'
      throw error
    }
    if (json.code !== '0000') {
      const error = new Error(json.msg || '接口失败')
      error.code = json.code
      error.data = json.data
      throw error
    }
    return json.data
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

function applySession(data, message) {
  state.token = data.token
  state.user = data.user
  localStorage.setItem('mh-token', data.token)
  localStorage.setItem('mh-user', JSON.stringify(data.user))
  toast(message)
  renderChrome()
  if (pendingRoute) {
    const next = pendingRoute
    pendingRoute = ''
    location.hash = next
    return
  }
  if (pendingAction) {
    // 登录前发起的动作（如"点购买"）在登录后无缝续上，不要求用户重选
    const action = pendingAction
    pendingAction = undefined
    if (action.type === 'paywall') {
      route().then(() => openPaywall(action.detail, action.options))
      return
    }
  }
  return route()
}

async function login(email, code) {
  const data = await api('/api/auth/email/login', { method: 'POST', body: JSON.stringify({ email, code }) })
  track('login_success', { meta: { method: 'code', created: Boolean(data.created) } })
  await applySession(data, data.created ? '注册成功，已自动登录' : '登录成功')
}

async function loginWithPassword(email, password) {
  const data = await api('/api/auth/email/password', { method: 'POST', body: JSON.stringify({ email, password }) })
  track('login_success', { meta: { method: 'password' } })
  await applySession(data, '登录成功')
}

async function logout() {
  const currentToken = state.token
  if (currentToken) {
    try {
      await fetch(`${BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${currentToken}` },
      })
    } catch { /* 本地退出优先，网络失败不影响清理 */ }
  }
  state.token = ''
  state.user = undefined
  localStorage.removeItem('mh-token')
  localStorage.removeItem('mh-user')
  toast('已退出登录')
  renderChrome()
  route()
}

const DIALOG_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
let dialogReturnFocus = null

function dialogFocusable(modal) {
  return [...modal.querySelectorAll(DIALOG_FOCUSABLE)].filter((node) => !node.hidden && node.getClientRects().length > 0)
}

function setDialogInert(inert) {
  const skip = $('.skip-link')
  if (skip) skip.inert = inert
  if (sidebar) sidebar.inert = inert
  if (topbar) topbar.inert = inert
  if (view) view.inert = inert
}

function openDialog(modal, close) {
  try { modal._dialogCleanup?.() } catch { /* ignore */ }
  modal._dialogCleanup = null
  dialogReturnFocus = document.activeElement
  modal._dialogClose = close
  modal.classList.remove('hidden')
  modal.setAttribute('aria-hidden', 'false')
  setDialogInert(true)
  const card = modal.querySelector('.modal-card')
  if (card) {
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    const title = card.querySelector('h3')
    if (title) {
      if (!title.id) title.id = 'dialog-title'
      card.setAttribute('aria-labelledby', title.id)
    }
  }
  const target = modal.querySelector('[autofocus]') ?? dialogFocusable(modal)[0]
  requestAnimationFrame(() => target?.focus())
}

function closeDialog(modal) {
  if (modal.classList.contains('hidden')) return
  try { modal._dialogCleanup?.() } catch { /* ignore */ }
  modal._dialogCleanup = null
  modal.classList.add('hidden')
  modal.setAttribute('aria-hidden', 'true')
  setDialogInert(false)
  modal._dialogClose = null
  const target = dialogReturnFocus
  dialogReturnFocus = null
  if (target?.isConnected) target.focus()
}

document.addEventListener('keydown', (event) => {
  const modal = $('#modal')
  if (!modal || modal.classList.contains('hidden')) return
  if (event.key === 'Escape') {
    if (typeof modal._dialogClose === 'function') {
      event.preventDefault()
      modal._dialogClose()
    }
    return
  }
  if (event.key !== 'Tab') return
  const items = dialogFocusable(modal)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
})

/** 登录 / 注册：验证码（默认）与密码两种方式 */
function openLogin() {
  track('login_open')
  const modal = $('#modal')
  let countdown = 0
  let timer
  let mode = 'code'

  modal.innerHTML = `
    <div class="modal-card login-modal">
      <h3>登录 / 注册</h3>
      <div class="seg login-tabs" id="login-tabs">
        <button class="seg-item active" data-mode="code">验证码登录</button>
        <button class="seg-item" data-mode="password">密码登录</button>
      </div>
      <label class="field"><span>邮箱</span>
        <input id="login-email" type="email" placeholder="you@example.com" autocomplete="email" autofocus />
      </label>
      <div id="code-block">
        <div class="login-code-row">
          <input id="login-code" aria-label="邮箱验证码" placeholder="6 位验证码" maxlength="6" inputmode="numeric" autocomplete="one-time-code" class="input" />
          <button class="btn-ghost" id="send-code">获取验证码</button>
        </div>
      </div>
      <div id="password-block" class="hidden">
        <label class="field login-password-row"><span>密码</span>
          <input id="login-password" type="password" placeholder="账号密码" autocomplete="current-password" />
        </label>
      </div>
      <div id="login-hint" class="login-hint" role="status" aria-live="polite"></div>
      <div class="login-actions">
        <button class="btn-primary login-submit" id="login-submit">登录 / 注册</button>
        <button class="btn-ghost" id="login-cancel">取消</button>
      </div>
      <p class="login-help">未注册的邮箱会自动创建账号；密码可在「个人中心」设置。</p>
    </div>`

  const close = () => { clearInterval(timer); closeDialog(modal) }
  const hint = (text, tone = '') => {
    const node = $('#login-hint')
    node.textContent = translateText(text, node)
    node.dataset.tone = tone
  }

  $('#login-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]')
    if (!button) return
    mode = button.dataset.mode
    modal.querySelectorAll('#login-tabs .seg-item').forEach((item) => item.classList.toggle('active', item.dataset.mode === mode))
    $('#code-block').classList.toggle('hidden', mode !== 'code')
    $('#password-block').classList.toggle('hidden', mode !== 'password')
    $('#login-submit').textContent = mode === 'code' ? t('登录 / 注册') : t('登录')
    hint('')
  })

  $('#send-code').addEventListener('click', async () => {
    const email = $('#login-email').value.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return hint('请输入正确的邮箱地址', 'error')
    const button = $('#send-code')
    button.disabled = true
    try {
      const result = await api('/api/auth/email/send', { method: 'POST', body: JSON.stringify({ email }) })
      hint(`验证码已发送至 ${email}，5 分钟内有效`, 'success')
      countdown = result.resendAfter ?? 60
      button.textContent = translateText(`${countdown}s 后重发`, button)
      timer = setInterval(() => {
        countdown -= 1
        if (countdown <= 0) {
          clearInterval(timer)
          button.disabled = false
          button.textContent = t('获取验证码')
          return
        }
        button.textContent = translateText(`${countdown}s 后重发`, button)
      }, 1000)
    } catch (error) {
      button.disabled = false
      // 邮件通道没配好时不能只甩一句报错：给出客服出路 + 切到密码登录
      if (error.code === 'mail_not_configured' || error.code === 'mail_failed') {
        const support = state.constants.supportEmail
        hint(`${error.message}${support ? `（客服邮箱：${support}）` : ''}`, 'error')
        $('#login-tabs').querySelector('[data-mode="password"]')?.click()
      } else {
        hint(error.message, 'error')
      }
    }
  })

  $('#login-submit').addEventListener('click', async () => {
    const email = $('#login-email').value.trim()
    if (!email) return hint('请输入邮箱', 'error')
    try {
      if (mode === 'password') {
        const password = $('#login-password').value
        if (!password) return hint('请输入密码', 'error')
        await loginWithPassword(email, password)
      } else {
        const code = $('#login-code').value.trim()
        if (!/^\d{6}$/.test(code)) return hint('请输入 6 位数字验证码', 'error')
        await login(email, code)
      }
      close()
    } catch (error) {
      hint(error.message, 'error')
    }
  })

  $('#login-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#login-submit').click() })
  $('#login-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#login-submit').click() })
  $('#login-cancel').addEventListener('click', close)
  openDialog(modal, close)
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

const ORDER_STATUS = {
  created: '待支付', pending: '支付确认中', paid: '已支付', fulfilled: '已完成',
  closed: '已关闭', refunded: '已退款', refunding: '退款中', refund_pending: '退款待审', failed: '支付失败',
}
/**
 * 支付渠道完全由服务端 /api/constants 决定（后台启停哪个就是哪个）。
 * 前端不再内置 mock 默认值——否则后台关掉模拟支付后收银台仍然显示"模拟支付"，制造假单。
 */
const PAY = { channels: [], defaultChannel: null, usdtNetwork: 'TRC20', ready: false }
const CHANNEL_LABEL = { mock: '模拟支付（测试）', alipay: '支付宝', usdt: 'USDT（TRC20）', wechat: '微信支付' }
// 只把「真能收钱」的渠道摆给用户：后台启用但缺密钥/缺地址的渠道由服务端标记 usable=false
const usableChannels = () => (PAY.channels ?? []).filter((channel) => channel.usable !== false)
const unavailableChannelReason = () => {
  const broken = (PAY.channels ?? []).find((channel) => channel.usable === false)
  return broken ? (broken.unavailableReason || `${CHANNEL_LABEL[broken.code] ?? broken.code} 暂不可用`) : ''
}
const channelList = () => usableChannels().map((channel) => {
  const code = channel.code ?? channel.channelCode
  return { code, label: CHANNEL_LABEL[code] ?? channel.name ?? code }
})
const defaultChannel = () => {
  const list = channelList()
  const preferred = list.find((item) => item.code === PAY.defaultChannel)
  return preferred?.code ?? list[0]?.code ?? null
}
const badgeOf = (item) => {
  const access = item.access ?? (item.accessMode === 'paid' ? 'paid' : 'subscription')
  if (access === 'free') return '<span class="badge badge-free">免费</span>'
  if (access === 'owned') return '<span class="badge badge-own">已购</span>'
  if (access === 'subscribed') return '<span class="badge badge-vip">已开通</span>'
  if (access === 'paid') return `<span class="badge badge-pay">¥${Number(item.singlePrice ?? 0).toFixed(0)}</span>`
  return '<span class="badge badge-vip">会员</span>'
}

async function createOrder(payload) {
  return api('/api/orders', { method: 'POST', body: JSON.stringify(payload) })
}

async function waitOrderPaid(outTradeNo, onTick, shouldStop) {
  // 订单有效期 15 分钟；2s 起轮询、逐步退避到 15s，避免把限流打满
  const deadline = Date.now() + 15 * 60 * 1000
  let delay = 2000
  while (Date.now() < deadline) {
    if (shouldStop?.()) return { status: 'aborted' }
    try {
      const data = await api(`/api/orders/${outTradeNo}`)
      onTick?.(data)
      if (data.status === 'fulfilled' || data.status === 'paid') return data
      if (data.status === 'closed' || data.status === 'refunded') return data
    } catch { /* 网络抖动：继续等，不打断用户 */ }
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(delay + 1000, 15000)
  }
  return undefined
}

function openPaywall(detail, options = {}) {
  const dramaId = detail?.dramaId ?? options.dramaId ?? null
  track('paywall_view', { dramaId, meta: { reason: options.reason ?? '' } })
  const modal = $('#modal')
  const plans = options.plans ?? detail?.priceInfo?.plans ?? []
  const singlePrice = Number(options.price ?? detail?.singlePrice ?? 0)
  const canSingle = (options.reason === 'single_purchase_required') || detail?.accessMode === 'paid'
  const token = `paywall-${Date.now()}`
  const stillMine = () => modal.dataset.paywall === token && !modal.classList.contains('hidden')
  const earn = (text) => { if (stillMine()) $('#paywall-msg').textContent = text }
  const earnHtml = (html) => { if (stillMine()) $('#paywall-msg').innerHTML = html }

  if (!plans.length && !canSingle) {
    openModal('暂无可购套餐', `当前没有在售的会员套餐，请联系客服开通。

客服邮箱：${state.constants?.supportEmail || '—'}`)
    return
  }

  let selected = plans.length
    ? { productType: 'subscription', planId: Number(plans[0].id) }
    : { productType: 'single', dramaId }

  modal.dataset.paywall = token
  modal.innerHTML = `
    <div class="modal-card paywall">
      <h3>${escapeHtml(options.title ?? (canSingle ? '该片需单独购买' : '开通会员后可观看'))}</h3>
      <p class="paywall-sub">${canSingle ? '本片为单独付费内容，会员也可观看全部剧集' : '会员可看全站剧集（不含单独付费影片）'}</p>
      <div class="plan-list">
        ${plans.map((plan) => `<button class="plan-item${selected.planId === Number(plan.id) ? ' active' : ''}" data-plan="${plan.id}">
          <span class="plan-name">${escapeHtml(plan.name)}</span>
          <span class="plan-price">¥${Number(plan.price).toFixed(2)}</span>
          <span class="plan-days">${plan.days} 天</span>
        </button>`).join('')}
        ${canSingle ? `<button class="plan-item single${plans.length ? '' : ' active'}" data-single="1">
          <span class="plan-name">购买本片（${detail?.purchaseKind === 'rental' ? '限时租赁' : '永久解锁'}）</span>
          <span class="plan-price">¥${singlePrice.toFixed(2)}</span>
        </button>` : ''}
      </div>
      <div class="paywall-coupon">
        <input id="coupon-input" aria-label="优惠券码" placeholder="优惠券码（可选，如 WELCOME10）" />
        <button class="btn-ghost" id="coupon-apply">使用</button>
      </div>
      <div class="paywall-channels" id="pay-channels"></div>
      <div class="paywall-foot">
        <span id="paywall-msg"></span>
        <button class="btn-ghost" id="paywall-close">稍后再说</button>
      </div>
    </div>`
  // 只隐藏自己这一层：modal 是共享容器，用户可能已经把它切换成别的表单
  const close = () => {
    closeDialog(modal)
    if (modal.dataset.paywall === token) delete modal.dataset.paywall
  }
  $('#paywall-close').addEventListener('click', close)

  let couponCode = ''
  $('#coupon-apply').addEventListener('click', async () => {
    const code = $('#coupon-input').value.trim()
    if (!code) return
    const base = selected.productType === 'single' ? singlePrice : (plans.find((p) => Number(p.id) === selected.planId)?.price ?? plans[0]?.price ?? 0)
    try {
      const result = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code, amount: base }) })
      earn(result.ok ? `优惠券可用，立减 ¥${Number(result.discount).toFixed(2)}` : (result.message ?? '不可用'))
      if (result.ok) couponCode = code
    } catch (error) {
      earn(error.message)
    }
  })

  const channels = channelList()
  $('#pay-channels').innerHTML = channels.length
    ? channels.map((channel) => `<button class="channel" data-channel="${escapeHtml(channel.code)}">${escapeHtml(channel.label)}</button>`).join('')
    : `<div class="paywall-sub" style="color:#ff8a8a">${escapeHtml(unavailableChannelReason() || '当前暂无可用支付渠道，请联系客服开通')}</div>`

  let busy = false
  const go = async (channel) => {
    if (busy) return
    const payload = selected
    track('paywall_click', { dramaId, meta: { channel, product: payload.productType, planId: payload.planId ?? null } })
    if (!state.token) {
      // 记住购买意图，登录后自动回到付费墙（否则用户要重选套餐，转化二次流失）
      pendingAction = { type: 'paywall', detail, options, selected: { ...payload } }
      close()
      openLogin()
      return
    }
    if (!channel) { earn('暂无可用支付渠道'); return }
    busy = true
    const buttons = [...modal.querySelectorAll('[data-channel]')]
    buttons.forEach((button) => { button.disabled = true; button.classList.add('busy') })
    earn('正在创建订单…')
    // 弹窗必须在 await 之前打开，否则 iOS Safari / 微信内会被拦截
    const popup = channel === 'usdt' ? null : window.open('', '_blank', 'width=520,height=680')
    try {
      const order = await createOrder({ ...payload, channel, couponCode })
      earn(`订单 ${order.outTradeNo} 已创建，金额 ¥${Number(order.amount).toFixed(2)}`)
      if (order.payUrl) {
        const target = order.payUrl.startsWith('http') ? order.payUrl : BASE + order.payUrl
        if (popup) popup.location.href = target
        else {
          // 弹窗被拦（微信/部分浏览器）：退回当前页跳转，否则用户点支付没有任何反应
          toast('若未自动跳转，请允许本站弹出窗口')
          location.href = target
          return
        }
      }
      if (order.simulated) earn('已打开模拟收银台，付款后自动到账')
      if (order.usdt) showUsdt(order.usdt, order.outTradeNo)
      const done = await waitOrderPaid(order.outTradeNo, (tick) => {
        earn(`等待支付… ${ORDER_STATUS[tick.status] ?? tick.status}（到账后自动更新，无需刷新）`)
      }, () => !stillMine())
      if (done && (done.status === 'fulfilled' || done.status === 'paid')) {
        toast('支付成功，权益已到账')
        close()
        route()
      } else if (done && done.status === 'aborted') {
        if (popup && !popup.closed) popup.close()
      } else if (done && (done.status === 'closed' || done.status === 'refunded')) {
        earn(`订单${ORDER_STATUS[done.status]}，可在「我的」页继续支付或重新下单`)
      } else if (done) {
        const confirms = order.usdt?.minConfirmations ?? 19
        earn(`仍在等待到账（USDT 需 ${confirms} 个区块确认，通常 1–3 分钟）。可关闭此窗，到账后自动开通，也可在「我的」页继续支付`)
      }
    } catch (error) {
      if (popup && !popup.closed) popup.close()
      earn(error.message)
    } finally {
      busy = false
      buttons.forEach((button) => { button.disabled = false; button.classList.remove('busy') })
    }
  }

  /** USDT 收银台：地址一键复制 + 实时倒计时 + 服务端下发的汇率/确认数（不再写死）。 */
  function showUsdt(usdt, outTradeNo) {
    const deadline = usdt.expiresAt ? new Date(String(usdt.expiresAt).replace(' ', 'T') + 'Z').getTime() : Date.now() + 15 * 60_000
    const box = document.createElement('div')
    box.className = 'usdt-box'
    box.innerHTML = `<div class="usdt-row"><span>金额</span><b id="usdt-amount">${Number(usdt.amount).toFixed(2)} USDT</b></div>
      <div class="usdt-row"><span>汇率</span><span>1 USDT ≈ ¥${Number(usdt.rate ?? 0).toFixed(2)}</span></div>
      <div class="usdt-row"><span>网络</span><span>${escapeHtml(usdt.network ?? 'TRC20')}（${usdt.minConfirmations ?? 19} 确认）</span></div>
      <div class="usdt-addr"><code id="usdt-address">${escapeHtml(usdt.address ?? '')}</code>
        <button class="btn-ghost" id="usdt-copy">复制地址</button></div>
      <div class="usdt-row"><span>剩余</span><b id="usdt-left">--:--</b></div>
      <div class="usdt-tip">请精确转账该金额，多笔同额订单可能混淆；到账后自动开通权益。</div>`
    const host = $('#paywall-msg')
    host?.insertAdjacentElement('afterend', box)
    const buttonsEnable = () => modal.querySelectorAll('[data-channel]').forEach((button) => { button.disabled = false; button.classList.remove('busy') })
    const tick = () => {
      const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000))
      const node = box.querySelector('#usdt-left')
      if (!node) return
      node.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
      if (left === 0) {
        clearInterval(timer)
        box.querySelector('#usdt-copy')?.setAttribute('disabled', 'disabled')
        earn('订单已超时，请重新下单')
        buttonsEnable()
      }
    }
    const timer = setInterval(tick, 1000)
    const priorCleanup = modal._dialogCleanup
    modal._dialogCleanup = () => {
      clearInterval(timer)
      priorCleanup?.()
    }
    tick()
    box.querySelector('#usdt-copy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(String(usdt.address ?? ''))
        toast('收款地址已复制')
      } catch {
        const range = document.createRange()
        range.selectNodeContents(box.querySelector('#usdt-address'))
        const selection = window.getSelection()
        selection.removeAllRanges()
        selection.addRange(range)
        toast('已选中地址，请按 Ctrl/⌘+C 复制')
      }
    })
  }

  const markSelected = (next) => {
    selected = next
    modal.querySelectorAll('.plan-item').forEach((node) => {
      const isPlan = next.productType === 'subscription' && Number(node.dataset.plan) === next.planId
      const isSingle = next.productType === 'single' && node.dataset.single === '1'
      node.classList.toggle('active', isPlan || isSingle)
    })
  }
  modal.querySelectorAll('[data-plan]').forEach((button) => {
    button.addEventListener('click', () => markSelected({ productType: 'subscription', planId: Number(button.dataset.plan) }))
  })
  const singleButton = modal.querySelector('[data-single]')
  if (singleButton) singleButton.addEventListener('click', () => markSelected({ productType: 'single', dramaId }))
  modal.querySelectorAll('[data-channel]').forEach((button) => {
    button.addEventListener('click', () => go(button.dataset.channel))
  })
  openDialog(modal, close)
}

/** 播放量等计数：1234 / 1.2万 / 3.4亿（列表里要短，不做千分位） */
function fmtCount(value) {
  const n = Number(value) || 0
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

function toast(text) {
  const node = $('#toast')
  node.textContent = translateText(text, node)
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), 1800)
}

function posterCard(item, options = {}) {
  // 游览类卡片（首页/分类/榜单/搜索/收藏）默认不挂价格与会员标，
  // 首屏挂满 ¥6 /「会员」会把内容展示变成价目表；价格只在详情页与付费墙出现。
  // 需要角标时显式传 { badge: true }。
  const badge = options.badge === true ? badgeOf(item) : ''
  const rank = options.rank ? `<span class="rank-no">${options.rank}</span>` : ''
  // 参考站海报：左上角「最新上线」角标、右下角评分；列表里不再重复一行评分
  const ribbon = item.isNew ? '<span class="card-ribbon">最新上线</span>' : ''
  const score = options.score !== false && Number(item.score) > 0
    ? `<span class="card-score-badge">${icon('star', 11)}${Number(item.score).toFixed(1)}</span>`
    : ''
  // playCount 由 cardOf 提供；只在明确要求的地方显示（分类列表），避免每张卡都塞满数字
  const plays = options.plays && Number(item.playCount) > 0 ? `<span class="card-plays">${icon('play', 10)}${fmtCount(item.playCount)}</span>` : ''
  const meta = (item.labels ?? []).slice(0, 2).join(' · ')
  const sub = `${plays}${escapeHtml(item.subTitle || meta)}`
  const adultMeta = item.isAdult && item.stats
    ? [item.releaseDate ? `发行 ${item.releaseDate}` : '', `收藏 ${fmtCount(item.stats.favoriteCount ?? 0)}`, `浏览 ${fmtCount(item.stats.totalViews ?? 0)}`].filter(Boolean).join(' · ')
    : ''
  return `
    <div class="card" data-drama-id="${escapeHtml(item.dramaId)}">
      <a class="poster" href="#/drama/${escapeHtml(item.dramaId)}" title="${escapeHtml(item.title)}">
        ${badge}${rank}${ribbon}
        <img loading="lazy" decoding="async" width="480" height="720" src="${escapeHtml(mediaUrl(item.coverUrl))}" alt="${escapeHtml(item.title)}" data-img-fallback="cover" />
        ${score}
        <span class="play-hint">${icon('play', 26)}</span>
      </a>
      <div class="card-title">${escapeHtml(item.title)}</div>
      ${sub ? `<div class="card-sub">${sub}</div>` : ''}
      ${adultMeta ? `<div class="card-sub card-adult-stats">${escapeHtml(adultMeta)}</div>` : ''}
    </div>`
}

/**
 * 侧栏/频道高亮判定。
 * 旧写法用 `hash.startsWith(href.split('?')[0])` 且榜单组用 `hash.includes('rank')`，
 * 结果只要进了 #/rank，四个榜单项（HOT/RISE/CLASSIC/SEARCH 共用 #/rank 路径）全部点亮，
 * 用户无法判断当前在看哪个榜。这里改成「路径精确相等 + query 里 type 精确相等」，
 * 缺省 type 视为 HOT（与服务端 /api/rank 默认值一致）。
 */
function navIsActive(href, hash) {
  const normalizePath = (value) => {
    const path = String(value ?? '').split('?')[0]
    return !path || path === '#' || path === '#/' ? '#/home' : path
  }
  const [hrefPath, hrefQuery] = String(href ?? '').split('?')
  if (!hrefPath) return false
  if (normalizePath(hrefPath) !== normalizePath(hash)) return false
  // 个人中心顶部四个入口带 ?tab=，侧栏仍应保持「历史 / 收藏」高亮。
  if (normalizePath(hrefPath) === '#/me' && !hrefQuery) return true
  // 移动端「榜单」是一个总入口，进入任意榜单都保持高亮。
  if (normalizePath(hrefPath) === '#/rank' && !hrefQuery) return true
  if (normalizePath(hrefPath) === '#/content-rank' && !hrefQuery) return true
  // 同一路径下靠 query 区分入口（#/category/TV 与 #/category/TV?region=KR 是不同频道），
  // 只比 type 会让「电视剧/美剧/韩剧/日剧/英剧」同时高亮。
  const hrefParams = new URLSearchParams(hrefQuery ?? '')
  const currentParams = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '')
  if ([...hrefParams.keys()].length === 0) return [...currentParams.keys()].length === 0
  for (const [key, value] of hrefParams) {
    const current = currentParams.get(key)
    if (key === 'type') {
      if ((current ?? 'HOT') !== value) return false
      continue
    }
    if ((current ?? '') !== value) return false
  }
  return true
}

function renderChrome() {
  syncChrome({
    user: state.user,
    lang: getLang(),
    hash: location.hash || '#/home',
    adultMenu: state.constants?.adultMenu ?? null,
  })
}

const ADULT_CONFIRM_KEY = 'mh-adult-confirmed'

function hasAdultConsent() {
  try { return sessionStorage.getItem(ADULT_CONFIRM_KEY) === '1' } catch { return false }
}

function rememberAdultConsent() {
  try { sessionStorage.setItem(ADULT_CONFIRM_KEY, '1') } catch { /* 隐私模式下不阻断本次确认 */ }
}

let adultGatePromise = null

function promptAdultAge() {
  if (hasAdultConsent()) return Promise.resolve(true)
  if (adultGatePromise) return adultGatePromise
  const modal = $('#modal')
  adultGatePromise = new Promise((resolve) => {
    let settled = false
    const finish = (allowed) => {
      if (settled) return
      settled = true
      if (allowed) rememberAdultConsent()
      closeDialog(modal)
      resolve(allowed)
    }
    modal.innerHTML = `
      <div class="modal-card age-gate" data-i18n-ignore>
        <h3>${escapeHtml(t('是否年满18岁'))}</h3>
        <p>${escapeHtml(t('成人内容仅面向年满18岁的用户。'))}</p>
        <div class="age-gate-actions">
          <button class="btn-ghost" type="button" id="age-gate-no">${escapeHtml(t('否，未满18岁'))}</button>
          <button class="btn-primary" type="button" id="age-gate-yes">${escapeHtml(t('是，我已满18岁'))}</button>
        </div>
      </div>`
    $('#age-gate-yes').addEventListener('click', () => finish(true))
    $('#age-gate-no').addEventListener('click', () => finish(false))
    openDialog(modal, () => finish(false))
  }).finally(() => { adultGatePromise = null })
  return adultGatePromise
}

function openAdultMenu() {
  if (!state.constants?.adultMenu?.enabled) return
  const go = () => { if (location.hash === '#/adult') route(); else location.hash = '#/adult' }
  if (hasAdultConsent()) return go()
  void promptAdultAge().then((allowed) => { if (allowed) go() })
}

function openProfile() {
  if (!state.token) {
    openLogin()
    return
  }
  if (location.hash === '#/me') route()
  else location.hash = '#/me'
}

function switchLanguage(next) {
  if (next === getLang()) return
  const scroll = { x: window.scrollX, y: window.scrollY }
  document.documentElement.classList.add('switching-language')
  setLang(next)
  const url = new URL(location.href)
  url.searchParams.set('lang', next)
  history.replaceState(null, '', url.toString())
  preserveScrollOnNextRoute = scroll
  void route().finally(() => {
    requestAnimationFrame(() => window.scrollTo(scroll.x, scroll.y))
    setTimeout(() => {
      window.scrollTo(scroll.x, scroll.y)
      setTimeout(() => {
        window.scrollTo(scroll.x, scroll.y)
        document.documentElement.classList.remove('switching-language')
        requestAnimationFrame(() => window.scrollTo(scroll.x, scroll.y))
        setTimeout(() => window.scrollTo(scroll.x, scroll.y), 60)
      }, 220)
    }, 80)
  })
}

bindChromeActions({
  search: (keyword) => { location.hash = `#/search?q=${encodeURIComponent(keyword)}` },
  openProfile,
  openAdult: openAdultMenu,
  switchLanguage,
})

function openModal(title, body) {
  const modal = $('#modal')
  const paragraphs = String(body ?? '').split(/\n{2,}/).map((text) => `<p>${escapeHtml(text)}</p>`).join('')
  modal.innerHTML = `<div class="modal-card"><h3>${escapeHtml(title)}</h3>${paragraphs}
    <button class="btn-primary" id="modal-close" style="margin-top:18px">知道了</button></div>`
  const close = () => closeDialog(modal)
  $('#modal-close').addEventListener('click', close)
  openDialog(modal, close)
}

/* ---------------- 页面 ---------------- */

// 片单广场：参考站的「片单广场」= 编辑精选合集。这里先用首页楼层（sections）当合集，
// 每个合集渲染成一格网格，点卡片直接进详情；后续可换成人工编排的 playlists 表。
async function renderPlaylists() {
  document.title = '片单广场 · 影巢'
  const data = await api('/api/home')
  const sections = (data.sections ?? []).filter((section) => (section.items ?? []).length > 0)
  if (!sections.length) {
    view.innerHTML = '<div class="section-head" style="margin-top:22px"><h1 class="section-title">片单广场</h1></div>'
      + '<div class="empty">还没有片单，内容上架后这里会按主题自动成集。</div>'
    return
  }
  const block = (section, index) => {
    const items = section.items ?? []
    return '<section class="section">'
      + '<div class="section-head"><h2 class="section-title">' + escapeHtml(section.title ?? ('片单 ' + (index + 1))) + '</h2>'
      + '<div class="section-hint">' + items.length + ' 部</div></div>'
      + '<div class="grid">' + items.map((item) => posterCard(item)).join('') + '</div>'
      + '</section>'
  }
  view.innerHTML = '<div class="section-head" style="margin-top:22px">'
    + '<h1 class="section-title">片单广场</h1>'
    + '</div>'
    + sections.map(block).join('')
}

function backdropMapOf(banners) {
  const map = new Map()
  for (const banner of banners ?? []) {
    const dramaId = Number(banner.targetDramaId)
    if (dramaId && banner.image && !map.has(dramaId)) map.set(dramaId, banner.image)
  }
  return map
}

function withBackdrops(items, backdropByDrama) {
  return (items ?? []).map((item) => ({
    ...item,
    backdropUrl: item.backdropUrl || backdropByDrama.get(Number(item.dramaId)) || null,
  }))
}

function heroMeta(banner) {
  return [banner.year, banner.categoryLabel ?? categoryLabel(banner.category), banner.areaLabel ?? banner.area].filter(Boolean).join(' · ')
}

function heroSlide(banner, index) {
  const image = mediaUrl(banner.image)
  const preview = banner.previewUrl ? mediaUrl(banner.previewUrl) : ''
  const title = banner.name || banner.title || ''
  const description = banner.description || banner.subTitle || banner.title || ''
  const score = Number(banner.score) > 0 ? `<span class="hero-score">${icon('star', 12)}${Number(banner.score).toFixed(1)}</span>` : ''
  return `
    <article class="hero-slide${index === 0 ? ' is-active' : ''}" data-hero-slide="${index}" aria-hidden="${index === 0 ? 'false' : 'true'}"${index === 0 ? '' : ' inert'}>
      ${image ? `<img class="hero-img" src="${escapeHtml(image)}" alt="" loading="${index === 0 ? 'eager' : 'lazy'}" decoding="async" fetchpriority="${index === 0 ? 'high' : 'low'}" />` : ''}
      ${preview ? `<video class="hero-video" muted loop playsinline preload="none" poster="${escapeHtml(image)}" data-src="${escapeHtml(preview)}" aria-hidden="true"></video>` : ''}
      <div class="hero-mask"></div>
      <div class="hero-body">
        <div class="hero-meta">${score}${heroMeta(banner) ? `<span>${escapeHtml(heroMeta(banner))}</span>` : ''}</div>
        <h2 class="hero-title">${escapeHtml(title)}</h2>
        <p class="hero-sub">${escapeHtml(description)}</p>
        <div class="hero-actions">
          <button class="btn-primary" type="button" data-hero-play="${index}">${icon('play', 16)}查看详情</button>
          <button class="btn-ghost" type="button" data-hero-fav="${index}">${icon('plus', 16)}收藏</button>
        </div>
      </div>
    </article>`
}

function wideCard(item) {
  const image = mediaUrl(item.backdropUrl || item.coverUrl)
  const preview = item.previewUrl ? mediaUrl(item.previewUrl) : ''
  const score = Number(item.score) > 0 ? `<span class="wide-card-score">${icon('star', 11)}${Number(item.score).toFixed(1)}</span>` : ''
  const meta = [item.year && !String(item.subTitle ?? '').includes(String(item.year)) ? item.year : null, item.dramaTypeLabel ?? categoryLabel(item.dramaType), item.areaLabel ?? item.area].filter(Boolean).join(' · ')
  return `
    <article class="wide-card" data-drama-id="${escapeHtml(item.dramaId)}"${preview ? ` data-preview-src="${escapeHtml(preview)}"` : ''}>
      <a class="wide-card-link" href="#/drama/${escapeHtml(item.dramaId)}" title="${escapeHtml(item.title)}">
        <div class="wide-card-media">
          <img loading="lazy" decoding="async" width="1600" height="900" src="${escapeHtml(image)}" alt="${escapeHtml(item.title)}" />
          ${preview ? `<video class="wide-card-video" muted loop playsinline preload="none" poster="${escapeHtml(image)}" data-src="${escapeHtml(preview)}" aria-hidden="true"></video>` : ''}
          <div class="wide-card-shade"></div>
          ${score}
          <span class="wide-card-play">${icon('play', 18)}</span>
          <div class="wide-card-copy">
            <h3>${escapeHtml(item.title)}</h3>
            ${item.subTitle ? `<p>${escapeHtml(item.subTitle)}</p>` : ''}
            ${meta ? `<div class="wide-card-meta">${escapeHtml(meta)}</div>` : ''}
          </div>
        </div>
      </a>
    </article>`
}

function sectionContentMarkup(section) {
  const items = section.items ?? []
  const useWide = items.length > 0 && items.length <= 4
  if (useWide) {
    return `<div class="section-wide" style="--section-cols:${items.length}" data-section-content>
      ${items.map(wideCard).join('')}
    </div>`
  }
  return `<div class="rail-shell" data-section-content aria-label="${escapeHtml(section.title)}内容">
    <button class="rail-arrow prev" type="button" data-rail-prev aria-label="向左浏览${escapeHtml(section.title)}">${icon('chevronLeft', 18)}</button>
    <div class="rail-track" data-rail-track>
      ${items.map((item) => posterCard(item, { badge: false, score: true })).join('')}
    </div>
    <button class="rail-arrow next" type="button" data-rail-next aria-label="向右浏览${escapeHtml(section.title)}">${icon('chevronRight', 18)}</button>
  </div>`
}

function sectionMarkup(section, index) {
  return `<section class="section" data-section="${escapeHtml(section.id)}">
    <div class="section-head">
      <h2 class="section-title">${escapeHtml(section.title)}${index === 0 ? `<span class="star" aria-hidden="true">${icon('star', 12)}</span>` : ''}</h2>
      <div class="section-hint">${(section.items ?? []).length} 部精选</div>
      ${(section.items ?? []).length > 4 ? `<button class="section-refresh" type="button" data-refresh="${escapeHtml(section.id)}">换一换${icon('refresh', 13)}</button>` : ''}
    </div>
    ${sectionContentMarkup(section)}
  </section>`
}

function bindRail(root) {
  const shell = root?.querySelector?.('[data-rail-track]')?.closest('.rail-shell')
  const track = root?.querySelector?.('[data-rail-track]')
  if (!shell || !track) return
  const prev = shell.querySelector('[data-rail-prev]')
  const next = shell.querySelector('[data-rail-next]')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const update = () => {
    const max = Math.max(0, track.scrollWidth - track.clientWidth)
    shell.classList.toggle('is-scrollable', max > 4)
    if (prev) prev.disabled = track.scrollLeft <= 4
    if (next) next.disabled = track.scrollLeft >= max - 4
  }
  const move = (direction) => track.scrollBy({
    left: direction * Math.max(280, track.clientWidth * 0.82),
    behavior: reduce ? 'auto' : 'smooth',
  })
  prev?.addEventListener('click', () => move(-1))
  next?.addEventListener('click', () => move(1))
  track.addEventListener('scroll', update, { passive: true })
  const frame = requestAnimationFrame(update)
  const observer = 'ResizeObserver' in window ? new ResizeObserver(update) : null
  observer?.observe(track)
  routeCleanups.push(() => {
    cancelAnimationFrame(frame)
    observer?.disconnect()
    track.removeEventListener('scroll', update)
  })
}

function bindHomePreviewCards() {
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!finePointer || reduce || navigator.connection?.saveData) return
  const heroVideos = [...view.querySelectorAll('.hero-video')]
  let activeCard = null
  let timer = 0
  const stop = (card) => {
    if (!card) return
    clearTimeout(timer)
    const video = card.querySelector('.wide-card-video')
    if (video) {
      video.pause()
      try { video.currentTime = 0 } catch { /* metadata 未就绪时浏览器会拒绝 */ }
    }
    card.classList.remove('is-previewing')
    if (activeCard === card) activeCard = null
  }
  const start = (card) => {
    if (activeCard && activeCard !== card) stop(activeCard)
    heroVideos.forEach((video) => video.pause())
    const video = card.querySelector('.wide-card-video')
    if (!video) return
    if (!video.src) video.src = video.dataset.src
    video.muted = true
    activeCard = card
    video.play().then(() => card.classList.add('is-previewing')).catch(() => {
      if (activeCard === card) activeCard = null
    })
  }
  const onOver = (event) => {
    const card = event.target.closest?.('.wide-card[data-preview-src]')
    if (!card || card.contains(event.relatedTarget)) return
    clearTimeout(timer)
    if (activeCard && activeCard !== card) stop(activeCard)
    timer = setTimeout(() => start(card), 650)
  }
  const onOut = (event) => {
    const card = event.target.closest?.('.wide-card[data-preview-src]')
    if (!card || card.contains(event.relatedTarget)) return
    stop(card)
  }
  const onScroll = () => stop(activeCard)
  view.addEventListener('pointerover', onOver)
  view.addEventListener('pointerout', onOut)
  view.addEventListener('scroll', onScroll, true)
  routeCleanups.push(() => {
    clearTimeout(timer)
    stop(activeCard)
    view.removeEventListener('pointerover', onOver)
    view.removeEventListener('pointerout', onOut)
    view.removeEventListener('scroll', onScroll, true)
  })
}

function bindHeroCarousel(banners) {
  const hero = $('#home-hero')
  const slides = [...(hero?.querySelectorAll('[data-hero-slide]') ?? [])]
  if (!hero || slides.length === 0) return
  const dots = [...hero.querySelectorAll('[data-hero-dot]')]
  const pauseButton = hero.querySelector('[data-hero-pause]')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  const canAuto = !reduce && !navigator.connection?.saveData && slides.length > 1
  let activeIndex = Math.max(0, slides.findIndex((slide) => slide.classList.contains('is-active')))
  let timer = 0
  let paused = false
  let userPaused = false
  let inView = true
  const videos = slides.map((slide) => slide.querySelector('.hero-video')).filter(Boolean)
  const stopVideo = (slide) => {
    const video = slide?.querySelector('.hero-video')
    if (!video) return
    video.pause()
    slide.classList.remove('is-video-playing')
  }
  const playVideo = (slide) => {
    const video = slide?.querySelector('.hero-video')
    if (!video || !canAuto || paused || document.hidden || !inView) return
    if (!video.src) video.src = video.dataset.src
    video.muted = true
    video.play().then(() => slide.classList.add('is-video-playing')).catch(() => {})
  }
  const schedule = () => {
    clearTimeout(timer)
    if (!canAuto || paused || document.hidden || !inView) return
    timer = setTimeout(() => activate(activeIndex + 1), 7000)
  }
  const activate = (next) => {
    activeIndex = (next + slides.length) % slides.length
    slides.forEach((slide, index) => {
      const active = index === activeIndex
      slide.classList.toggle('is-active', active)
      slide.setAttribute('aria-hidden', active ? 'false' : 'true')
      slide.inert = !active
      if (!active) stopVideo(slide)
    })
    dots.forEach((dot, index) => {
      const active = index === activeIndex
      dot.classList.toggle('is-active', active)
      dot.setAttribute('aria-current', active ? 'true' : 'false')
    })
    playVideo(slides[activeIndex])
    schedule()
  }
  const pause = () => {
    paused = true
    clearTimeout(timer)
    videos.forEach(stopVideo)
  }
  const resume = () => {
    if (userPaused) return
    paused = false
    playVideo(slides[activeIndex])
    schedule()
  }
  const paintPause = () => {
    if (!pauseButton) return
    pauseButton.innerHTML = icon(userPaused ? 'play' : 'pause', 14)
    pauseButton.setAttribute('aria-label', getLang() === 'en'
      ? (userPaused ? 'Resume carousel' : 'Pause carousel')
      : (userPaused ? '继续自动轮播' : '暂停自动轮播'))
    pauseButton.setAttribute('aria-pressed', String(userPaused))
  }
  const setUserPaused = (next) => {
    userPaused = next
    paused = next
    clearTimeout(timer)
    if (next) videos.forEach(stopVideo)
    else {
      playVideo(slides[activeIndex])
      schedule()
    }
    paintPause()
  }
  if (pauseButton) {
    pauseButton.hidden = !canAuto
    pauseButton.addEventListener('click', () => setUserPaused(!userPaused))
    paintPause()
  }
  hero.querySelector('[data-hero-prev]')?.addEventListener('click', () => activate(activeIndex - 1))
  hero.querySelector('[data-hero-next]')?.addEventListener('click', () => activate(activeIndex + 1))
  dots.forEach((dot) => dot.addEventListener('click', () => activate(Number(dot.dataset.heroDot))))
  hero.addEventListener('pointerenter', pause)
  hero.addEventListener('pointerleave', resume)
  hero.addEventListener('focusin', pause)
  hero.addEventListener('focusout', (event) => {
    if (!hero.contains(event.relatedTarget)) resume()
  })
  hero.addEventListener('click', async (event) => {
    const playButton = event.target.closest('[data-hero-play]')
    const favButton = event.target.closest('[data-hero-fav]')
    const button = playButton || favButton
    if (!button) return
    const banner = banners[Number(button.dataset.heroPlay ?? button.dataset.heroFav)]
    const dramaId = banner?.targetDramaId
    if (!dramaId) return toast('暂无可播放内容')
    if (playButton) {
      location.hash = `#/drama/${dramaId}`
      return
    }
    if (!state.token) {
      pendingRoute = `#/drama/${dramaId}`
      openLogin()
      return
    }
    try {
      const result = await api('/api/me/favorite', { method: 'POST', body: JSON.stringify({ dramaId }) })
      favButton.innerHTML = result.favorited ? `${icon('check', 15)}已收藏` : `${icon('plus', 15)}收藏`
      toast(result.favorited ? '已加入收藏' : '已取消收藏')
      track('favorite', { dramaId, meta: { favorited: Boolean(result.favorited), from: 'home' } })
    } catch (error) { toast(error.message) }
  })
  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer)
      videos.forEach((video) => video.pause())
      return
    }
    playVideo(slides[activeIndex])
    schedule()
  }
  document.addEventListener('visibilitychange', onVisibility)
  const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver(([entry]) => {
      inView = Boolean(entry?.isIntersecting)
      if (inView) {
        playVideo(slides[activeIndex])
        schedule()
      } else {
        clearTimeout(timer)
        videos.forEach((video) => video.pause())
      }
    }, { threshold: 0.15 })
    : null
  observer?.observe(hero)
  routeCleanups.push(() => {
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisibility)
    observer?.disconnect()
    videos.forEach((video) => video.pause())
  })
  activate(activeIndex)
}

function bindHomeSections(sections, backdropByDrama) {
  view.querySelectorAll('[data-section]').forEach((sectionNode) => {
    const section = sections.find((item) => String(item.id) === String(sectionNode.dataset.section))
    if (!section) return
    bindRail(sectionNode.querySelector('[data-section-content]'))
    const refresh = sectionNode.querySelector('[data-refresh]')
    refresh?.addEventListener('click', async () => {
      try {
        const shuffled = await api(`/api/feed?section=${encodeURIComponent(section.id)}`)
        if (!shuffled.items?.length) return toast('该分区内容不足，无法换一批')
        const next = { ...section, items: withBackdrops(shuffled.items, backdropByDrama) }
        const content = sectionNode.querySelector('[data-section-content]')
        if (content) content.outerHTML = sectionContentMarkup(next)
        const hint = sectionNode.querySelector('.section-hint')
        if (hint) hint.textContent = `${next.items.length} 部精选`
        bindRail(sectionNode.querySelector('[data-section-content]'))
        observeImpressions()
        toast('已换一批')
      } catch (error) { toast(error.message) }
    })
  })
}

async function renderHome() {
  const data = await api('/api/home')
  const banners = data.banners ?? []
  const backdropByDrama = backdropMapOf(banners)
  const sections = (data.sections ?? [])
    .filter((section) => (section.items ?? []).length > 0)
    .map((section) => ({ ...section, items: withBackdrops(section.items, backdropByDrama) }))
  const hasHero = banners.some((banner) => banner?.name || banner?.image)

  if (!hasHero && sections.length === 0) {
    view.innerHTML = `
      <h1 class="sr-only">影巢精选</h1>
      <div class="empty" style="padding-top:120px">
        <div style="font-size:18px;color:var(--text);margin-bottom:10px">内容正在上架</div>
        <div>新片正在转码入库，稍后刷新即可观看。</div>
        <div style="margin-top:10px">急用请联系：${escapeHtml(state.constants.supportEmail || '客服邮箱待配置')}</div>
      </div>`
    return
  }

  view.innerHTML = `
    <h1 class="sr-only">影巢精选</h1>
    ${hasHero ? `<section class="hero${banners.length === 1 ? ' is-single' : ''}" id="home-hero" role="region" aria-roledescription="carousel" aria-label="首页推荐">
      <div class="hero-track">
        ${banners.map(heroSlide).join('')}
      </div>
      ${banners.length > 1 ? `
        <button class="hero-arrow prev" type="button" data-hero-prev aria-label="上一张推荐">${icon('chevronLeft', 22)}</button>
        <button class="hero-arrow next" type="button" data-hero-next aria-label="下一张推荐">${icon('chevronRight', 22)}</button>
        <button class="hero-pause" type="button" data-hero-pause aria-label="暂停自动轮播" aria-pressed="false">${icon('pause', 14)}</button>
        <div class="hero-dots" role="group" aria-label="选择推荐">
          ${banners.map((banner, index) => {
            const label = banner.name || banner.title || index + 1
            const aria = getLang() === 'en' ? `View recommendation: ${label}` : `查看推荐：${label}`
            return `<button class="hero-dot${index === 0 ? ' is-active' : ''}" type="button" data-hero-dot="${index}" data-i18n-ignore aria-label="${escapeHtml(aria)}" aria-current="${index === 0 ? 'true' : 'false'}"></button>`
          }).join('')}
        </div>` : ''}
    </section>` : ''}
    ${sections.map(sectionMarkup).join('')}
    <div class="footer"><span>© 2026 影巢</span><span>客服邮箱：${escapeHtml(state.constants.supportEmail ?? '')}</span></div>`

  document.title = '影巢 · 高清影视在线观看'
  bindHeroCarousel(banners)
  bindHomeSections(sections, backdropByDrama)
  bindHomePreviewCards()
  observeImpressions()
}

async function renderCategory(type, params = new URLSearchParams(), audience = 'general') {
  const pageSize = 24
  const adultMode = audience === 'adult'
  // 「全部分类」：频道 / 排序 / 地区 / 类型 / 年份 / 标签 —— 六排筛选项全部来自服务端 facets，
  // 空库也有完整分类树（枚举固定），数量按当前频道内统计。
  const state = {
    channel: String(type || 'ALL').toUpperCase(),
    sort: params.get('sort') ?? 'hot',
    region: params.get('region') ?? '',
    year: params.get('year') ?? '',
    genre: params.get('genre') ?? '',
    tag: params.get('tag') ?? '',
  }
  let page = 1
  let items = []
  let total = 0
  let baseline = 0
  let exhausted = false
  let expanded = false
  let requestSeq = 0
  let facets = { channels: [], sorts: [], regions: [], genres: [], years: [], tags: [] }
  let adultTags = []

  const channelLabel = () => (facets.channels.find((row) => row.value === state.channel) ?? { label: '全部' }).label
  const adultLabel = () => state.constants?.adultMenu?.labels?.[getLang()] ?? (getLang() === 'en' ? 'Adult' : '成人')
  const pageTitle = () => (adultMode ? adultLabel() : (state.channel === 'ALL' ? '全部分类' : channelLabel()))
  const hasFilter = () => Boolean(state.region || state.year || state.genre || state.tag)
  const sortLabel = () => (facets.sorts.find((row) => row.value === state.sort) ?? { label: '最热' }).label

  const buildQuery = (nextPage) => {
    const query = new URLSearchParams({ type: state.channel, page: String(nextPage), pageSize: String(pageSize), sort: state.sort })
    if (adultMode) query.set('audience', 'adult')
    for (const key of ['region', 'year', 'genre', 'tag']) if (state[key]) query.set(key, state[key])
    return query
  }
  // 筛选项写进 hash，分享/刷新后仍是同一份筛选结果（replaceState 不触发 hashchange，不会重复渲染）
  const syncHash = () => {
    const query = new URLSearchParams()
    if (state.sort !== 'hot') query.set('sort', state.sort)
    if (adultMode && state.channel !== 'ALL') query.set('channel', state.channel)
    for (const key of ['region', 'year', 'genre', 'tag']) if (state[key]) query.set(key, state[key])
    const suffix = query.toString() ? `?${query.toString()}` : ''
    const next = adultMode ? `#/adult${suffix}` : `#/category/${state.channel}${suffix}`
    if (location.hash !== next) window.history.replaceState(null, '', next)
  }

  const [first, adultTagResult] = await Promise.all([
    api(`/api/category?${buildQuery(1).toString()}`),
    adultMode ? api('/api/tags?scope=adult').catch(() => ({ list: [] })) : Promise.resolve(null),
  ])
  adultTags = adultMode ? (adultTagResult?.list ?? []) : []
  total = Number(first.total ?? 0)
  baseline = total
  items = first.list ?? []
  facets = { ...facets, ...(first.facets ?? {}) }
  exhausted = items.length < pageSize

  document.title = `${pageTitle()} · 影巢`
  view.innerHTML = `
    <div class="section-head" style="margin-top:22px">
      <h1 class="section-title">${escapeHtml(pageTitle())}</h1>
      <div class="section-hint" id="cat-hint"></div>
    </div>
    <div class="cat-filters" id="cat-filters"></div>
    <div class="grid" id="cat-grid"></div>
    <div id="cat-more-wrap" style="text-align:center;margin:24px 0"></div>`

  const row = (title, key, list, options = {}) => {
    if (!list || !list.length) return ''
    const limit = options.limit ?? list.length
    const shown = expanded || limit >= list.length ? list : list.slice(0, limit)
    const pill = (value, text, count) => {
      const active = String(value) === String(state[key] ?? '')
      const tail = count === undefined || count === null ? '' : `<em>${fmtCount(count)}</em>`
      return `<button class="pill ${active ? 'active' : ''}" data-facet="${key}" data-value="${escapeHtml(String(value))}" aria-pressed="${active}">${escapeHtml(text)}${tail}</button>`
    }
    const more = limit < list.length
      ? `<button class="pill pill-more" data-expand="1">${expanded ? '收起选项' : `展开 ${list.length - limit} 项`}</button>`
      : (options.collapsible && expanded ? '<button class="pill pill-more" data-expand="1">收起选项</button>' : '')
    const all = options.showAll === false ? '' : pill('', '全部')
    return `<div class="filter-row" data-filter-row="${key}"><span class="filter-label">${title}</span>
      <div class="subtabs" data-filter-strip="${key}">${all}${shown.map((facet) => pill(facet.value, facet.label ?? facet.value, facet.count)).join('')}${options.collapsible ? more : ''}</div></div>`
  }

  const paintFilters = () => {
    const bar = $('#cat-filters')
    if (!bar) return
    const scrolls = new Map([...bar.querySelectorAll('[data-filter-strip]')]
      .map((strip) => [strip.dataset.filterStrip, strip.scrollLeft]))
    const channelRow = adultMode ? '' : row('频道', 'channel', facets.channels ?? [])
    const sortRow = row('排序', 'sort', facets.sorts ?? [])
    const regionRow = row('地区', 'region', facets.regions ?? [])
    const genreRow = row('类型', 'genre', (facets.genres ?? []).map((g) => ({ value: g.value, label: g.label, count: g.count })))
    const yearRow = row('年份', 'year', facets.years ?? [])
    const tagRow = expanded ? row('标签', 'tag', facets.tags ?? [], { limit: 24 }) : ''
    const adultTagRows = adultMode
      ? adultTags.filter((tag) => !tag.parent_id).map((group) => {
        const children = adultTags.filter((tag) => Number(tag.parent_id) === Number(group.id))
        return row(group.name, 'tag', children.map((tag) => ({
          value: tag.id,
          label: tag.label ?? tag.name,
          count: tag.dramaCount,
        })), { showAll: false })
      }).join('')
      : ''
    bar.innerHTML = `${adultMode ? `${sortRow}${adultTagRows}` : `${channelRow}${sortRow}${regionRow}${genreRow}${yearRow}${tagRow}`}
      <div class="filter-foot">
        ${adultMode ? '' : `<button class="btn-ghost sm" data-expand="1">${expanded ? '收起选项' : '更多筛选（标签）'}</button>`}
        ${hasFilter() ? '<button class="btn-ghost sm" id="cat-reset">清空筛选</button>' : ''}
      </div>`
    bar.querySelectorAll('[data-filter-strip]').forEach((strip) => {
      const previous = scrolls.get(strip.dataset.filterStrip)
      if (previous) strip.scrollLeft = previous
      const active = strip.querySelector('.pill.active')
      if (!active || strip.scrollWidth <= strip.clientWidth) return
      const stripRect = strip.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      if (activeRect.right > stripRect.right - 18) {
        strip.scrollLeft += activeRect.right - stripRect.right + 18
      } else if (activeRect.left < stripRect.left + 12) {
        strip.scrollLeft -= stripRect.left - activeRect.left + 12
      }
    })
  }

  const paintGrid = () => {
    const hint = $('#cat-hint')
    if (hint) {
      const parts = []
      parts.push(hasFilter() ? `筛选命中 ${total} 部 / 共 ${baseline} 部` : `共 ${total} 部`)
      parts.push(`按${sortLabel()}`)
      if (state.region) parts.push((facets.regions.find((r) => r.value === state.region) ?? {}).label ?? state.region)
      if (state.year) parts.push((facets.years.find((r) => r.value === state.year) ?? {}).label ?? state.year)
      if (state.genre) parts.push(state.genre)
      const activeTag = (adultMode ? adultTags : (facets.tags ?? [])).find((tag) => String(tag.value ?? tag.id) === String(state.tag))
      if (activeTag) parts.push(`#${activeTag.label ?? activeTag.name}`)
      hint.textContent = parts.filter(Boolean).join(' · ')
    }
    const grid = $('#cat-grid')
    if (!grid) return
    grid.innerHTML = items.length
      ? items.map((item) => posterCard(item, { plays: true })).join('')
      : `<div class="empty" style="grid-column:1 / -1">
           ${hasFilter() ? `没有符合条件的内容 · <button class="btn-ghost sm" id="cat-reset-2">清空筛选</button>` : (adultMode ? '成人分类暂无内容' : '这个分类暂时还没有内容')}
         </div>`
    observeImpressions()
    const reset2 = $('#cat-reset-2')
    if (reset2) reset2.addEventListener('click', () => { void applyPatch({ region: '', year: '', genre: '', tag: '' }) })
    const wrap = $('#cat-more-wrap')
    if (!wrap) return
    wrap.innerHTML = items.length < total && !exhausted ? '<button class="btn-ghost" id="cat-more">加载更多</button>' : ''
    const more = $('#cat-more')
    if (!more) return
    more.addEventListener('click', async () => {
      const seq = requestSeq
      const nextPage = page + 1
      more.disabled = true
      more.textContent = '加载中…'
      try {
        const next = await api(`/api/category?${buildQuery(nextPage).toString()}`)
        if (seq !== requestSeq) return
        page = nextPage
        const list = next.list ?? []
        if (list.length < pageSize) exhausted = true
        total = Number(next.total ?? total)
        items = items.concat(list)
        paintGrid()
      } catch (error) {
        if (seq !== requestSeq) return
        more.disabled = false
        more.textContent = '加载更多'
        toast(error.message)
      }
    })
  }

  // 所有筛选变化都走这里：改状态 → 从第 1 页重取 → 重画；失败回滚
  const applyPatch = async (patch) => {
    const seq = ++requestSeq
    const previous = { ...state }
    Object.assign(state, patch)
    if (state.channel === previous.channel) { /* 频道变了要重取，其余也一样 */ }
    syncHash()
    paintFilters()
    const hint = $('#cat-hint')
    if (hint) hint.textContent = '筛选中…'
    try {
      const data = await api(`/api/category?${buildQuery(1).toString()}`)
      if (seq !== requestSeq) return
      page = 1
      total = Number(data.total ?? 0)
      items = data.list ?? []
      facets = { ...facets, ...(data.facets ?? {}) }
      exhausted = items.length < pageSize
      // 无筛选时的 total 就是该频道全量，作为「筛选命中 N / 共 M」的分母
      if (!hasFilter()) baseline = total
    } catch (error) {
      if (error?.name === 'AbortError' || seq !== requestSeq) return
      Object.assign(state, previous)
      syncHash()
      paintFilters()
      paintGrid()
      toast(error.message)
      return
    }
    if (patch.channel) document.title = `${pageTitle()} · 影巢`
    const title = document.querySelector('.section-title')
    if (title) title.textContent = pageTitle()
    paintFilters()
    paintGrid()
    track('category_filter', {
      dramaId: null,
      value: total,
      meta: { channel: state.channel, sort: state.sort, region: state.region, year: state.year, genre: state.genre, tag: state.tag },
    })
  }

  $('#cat-filters').addEventListener('click', (event) => {
    const expander = event.target.closest('[data-expand]')
    if (expander) {
      expanded = !expanded
      paintFilters()
      return
    }
    if (event.target.closest('#cat-reset')) {
      void applyPatch({ region: '', year: '', genre: '', tag: '', sort: 'hot' })
      return
    }
    const button = event.target.closest('[data-facet]')
    if (!button || button.disabled) return
    const key = button.dataset.facet
    const value = button.dataset.value ?? ''
    const next = key === 'channel'
      ? { channel: value || 'ALL' }
      : key === 'sort'
        ? { sort: value || 'hot' }
        : { [key]: String(state[key]) === String(value) ? '' : value }   // 再点一次同一个筛选项 = 取消
    if (key === 'channel') { expanded = expanded; }
    void applyPatch(next)
  })

  paintFilters()
  paintGrid()
}

async function renderRank(params) {
  const activeType = params.get('type') ?? 'HOT'
  // 榜单浏览埋点：哪个榜被看了（四榜共用 #/rank，只能靠 type 区分）
  track('rank_view', { meta: { type: activeType } })
  const data = await api(`/api/rank?type=${encodeURIComponent(activeType)}`)
  document.title = `${data.listName ?? '榜单'} · 影巢`
  const lists = data.lists ?? []
  view.innerHTML = `
    <h1 class="sr-only">${escapeHtml(data.listName ?? '榜单')}</h1>
    <div class="tabs">
      ${lists.map((item) => `<a class="tab ${item.type === (data.type ?? activeType) ? 'active' : ''}" href="#/rank?type=${encodeURIComponent(item.type)}">${escapeHtml(item.label ?? item.name)}</a>`).join('')}
    </div>
    <div class="subtabs"><a class="pill" href="#/content-rank">查看内容数据榜</a></div>
    ${(data.items ?? []).length === 0
      ? '<div class="empty">该榜单暂无内容</div>'
      : `<div class="grid">${data.items.map((item, index) => posterCard(item, { rank: item.rankNo ?? index + 1 })).join('')}</div>`}
    <div class="footer"><span>${escapeHtml(data.listName || '榜单')} · 每小时更新</span></div>`
}

async function renderContentRank(params) {
  const activeType = params.get('type') ?? 'hot'
  const contentType = params.get('contentType') ?? 'all'
  track('rank_view', { meta: { type: `content_${activeType}`, contentType } })
  const data = await api(`/api/content/rank?type=${encodeURIComponent(activeType)}&contentType=${encodeURIComponent(contentType)}`)
  const pct = (value) => `${(Number(value ?? 0) * 100).toFixed(1)}%`
  document.title = `${data.label ?? '内容榜'} · 影巢`
  view.innerHTML = `
    <h1 class="sr-only">${escapeHtml(data.label ?? '内容榜')}</h1>
    <div class="section-head" style="margin-top:26px">
      <h2 class="section-title">内容数据榜</h2>
      <div class="section-hint">${data.generatedAt ? `生成于 ${escapeHtml(data.generatedAt)}` : '榜单待生成，后台重算后展示'}</div>
    </div>
    <div class="tabs">
      ${CONTENT_RANK_TABS.map(([value, label]) => `<a class="tab ${value === activeType ? 'active' : ''}" href="#/content-rank?type=${value}&contentType=${encodeURIComponent(contentType)}">${label}</a>`).join('')}
    </div>
    <div class="subtabs">
      ${[['all', '全部'], ['series', '剧集'], ['movie', '电影'], ['comic_drama', '漫剧']].map(([value, label]) => `<a class="pill ${value === contentType ? 'active' : ''}" href="#/content-rank?type=${activeType}&contentType=${value}">${label}</a>`).join('')}
    </div>
    ${(data.items ?? []).length === 0
      ? '<div class="empty">该榜单暂无足够数据</div>'
      : `<div class="grid">${data.items.map((item) => posterCard(item, { rank: item.rankNo })).join('')}</div>`}
    ${(data.items ?? []).length === 0 ? '' : `<div class="panel" style="margin-top:18px">
      <h3>榜单指标</h3>
      <table><thead><tr><th>#</th><th>内容</th><th>观看人数</th><th>有效观看</th><th>完播率</th><th>新增收藏</th></tr></thead><tbody>
        ${data.items.map((item) => `<tr><td>${item.rankNo}</td><td>${escapeHtml(item.title)}</td>
          <td>${Number(item.metrics?.viewerCount ?? 0).toLocaleString('zh-CN')}</td>
          <td>${Number(item.metrics?.viewCount ?? 0).toLocaleString('zh-CN')}</td>
          <td>${pct(item.metrics?.completionRate)}</td>
          <td>${Number(item.metrics?.favoriteAddUv ?? 0).toLocaleString('zh-CN')}</td></tr>`).join('')}
      </tbody></table>
    </div>`}
    <div class="footer"><span>${escapeHtml(data.label ?? '内容榜')} · 每小时自动更新</span><span>有效观看与收藏按去重口径</span></div>`
}

async function downloadDistributionPoster(code, link) {
  if (!code || !link) return toast('推广码尚未生成')
  const canvas = document.createElement('canvas')
  canvas.width = 720
  canvas.height = 1080
  const ctx = canvas.getContext('2d')
  if (!ctx) return toast('当前浏览器不支持生成海报')
  let drawQrCode
  try {
    ({ drawQrCode } = await import('./qr-code.js?v=20261111fix8'))
  } catch {
    return toast('二维码组件加载失败，请刷新后重试')
  }
  ctx.fillStyle = '#0e1116'
  ctx.fillRect(0, 0, 720, 1080)
  ctx.fillStyle = '#d4af37'
  ctx.fillRect(48, 64, 624, 4)
  ctx.fillStyle = '#f4efe2'
  ctx.font = '600 44px "Microsoft YaHei", sans-serif'
  ctx.fillText('影巢', 48, 150)
  ctx.font = '400 24px "Microsoft YaHei", sans-serif'
  ctx.fillStyle = '#b8b2a5'
  ctx.fillText('分享好片，好友付费后获得佣金', 48, 196)
  ctx.fillStyle = '#f4efe2'
  ctx.font = '600 34px "Microsoft YaHei", sans-serif'
  ctx.fillText('邀请码', 48, 380)
  ctx.fillStyle = '#d4af37'
  ctx.font = '700 72px "Microsoft YaHei", sans-serif'
  const codeMaxWidth = 320
  const codeScale = Math.min(1, codeMaxWidth / ctx.measureText(code).width)
  ctx.font = `700 ${Math.floor(72 * codeScale)}px "Microsoft YaHei", sans-serif`
  ctx.fillText(code, 48, 476, codeMaxWidth)
  ctx.fillStyle = '#b8b2a5'
  ctx.font = '400 22px "Microsoft YaHei", sans-serif'
  ctx.fillText('打开链接注册后生效', 48, 540)
  try {
    drawQrCode(ctx, link, 390, 270, 270)
  } catch {
    return toast('推广链接过长，二维码生成失败，请联系运营')
  }
  ctx.fillStyle = '#b8b2a5'
  ctx.font = '400 20px "Microsoft YaHei", sans-serif'
  ctx.fillText('扫码注册', 390, 570)
  ctx.fillText('好友扫码后自动绑定推广码', 390, 602)
  // 链接按 300px 宽度换行，避免长域名压到右侧二维码。
  const lines = []
  let current = ''
  for (const ch of String(link)) {
    if (ctx.measureText(current + ch).width > 300) {
      lines.push(current)
      current = ch
    } else current += ch
  }
  if (current) lines.push(current)
  ctx.fillStyle = '#f4efe2'
  ctx.font = '400 18px "Microsoft YaHei", sans-serif'
  lines.slice(0, 4).forEach((line, index) => ctx.fillText(line, 48, 620 + index * 30))
  ctx.fillStyle = '#b8b2a5'
  ctx.font = '400 18px "Microsoft YaHei", sans-serif'
  ctx.fillText('内容付费平台 · 影巢', 48, 1000)
  canvas.toBlob((blob) => {
    if (!blob) return toast('海报生成失败')
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `影巢-推广-${code}.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }, 'image/png')
}

async function renderPromotion() {
  const preferred = localStorage.getItem('mh-currency') ?? ''
  const data = await api(`/api/distribution/me${preferred ? `?currency=${encodeURIComponent(preferred)}` : ''}`)
  if (data.currency) localStorage.setItem('mh-currency', data.currency)
  document.title = '佣金推广 · 影巢'
  if (!data.profile) {
    view.innerHTML = `<div class="section-head" style="margin-top:26px"><h1 class="section-title">佣金推广</h1></div>
      <div class="empty">分享影巢好片，好友通过你的邀请注册并付费后，你可获得佣金。<br/><br/>
        <button class="btn-primary" id="distribution-apply">申请开通佣金推广</button></div>`
    $('#distribution-apply')?.addEventListener('click', async () => {
      try {
        const result = await api('/api/distribution/apply', { method: 'POST', body: {} })
        toast(result.message ?? '推广申请已提交')
        await renderPromotion()
      } catch (error) { toast(error.message) }
    })
    return
  }
  if (data.profile.status !== 'active') {
    view.innerHTML = `<div class="section-head" style="margin-top:26px"><h1 class="section-title">佣金推广</h1></div>
      <div class="empty">申请状态：${escapeHtml(data.profile.status === 'pending' ? '待审核' : '已停用')}<br/>审核通过后会生成专属推广码。</div>`
    return
  }
  const code = data.code ?? ''
  const link = code ? `${location.origin}${BASE}/i/${encodeURIComponent(code)}` : ''
  const money = (fen) => `¥${(Number(fen ?? 0) / 100).toFixed(2)}`
  const displayCurrency = data.currency === 'CNY' ? 'CNY' : 'USD'
  const displayMeta = (data.payoutOptions?.currencies ?? []).find((row) => row.code === displayCurrency)
  const displayRate = Number(displayMeta?.rateToCny ?? (displayCurrency === 'CNY' ? 1 : 7.2))
  const moneyDisplay = (fen) => `${displayMeta?.symbol ?? (displayCurrency === 'CNY' ? '¥' : '$')}${(Math.round(Number(fen ?? 0) / displayRate) / 100).toFixed(2)}`
  const displayBalance = (data.balances ?? []).find((row) => row.code === displayCurrency) ?? data.balances?.[0]
  const displayMoney = displayBalance
    ? `${displayBalance.symbol}${Number(displayBalance.amount ?? 0).toFixed(2)}`
    : money(data.commissions?.withdrawableFen)
  const teamPaidFen = Math.round(Number(data.teamPaidAmount ?? 0) * 100)
  const teamPaidDisplay = displayCurrency === 'CNY' ? money(teamPaidFen) : moneyDisplay(teamPaidFen)
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px"><h1 class="section-title">佣金推广</h1>
      <div class="section-hint">分享好片，好友注册并付费后按推广层级结算佣金</div></div>
    <div class="subtabs">
      ${[['CNY', '人民币'], ['USD', '美元']].map(([codeValue, label]) => `<button class="pill ${displayCurrency === codeValue ? 'active' : ''}" data-promotion-currency="${codeValue}">${label}</button>`).join('')}
    </div>
    <p class="me-sub" style="margin:-4px 0 12px">当前金额统一按${displayCurrency === 'CNY' ? '人民币' : `美元（1 USD ≈ ¥${displayRate.toFixed(2)}）`}展示；提现记录按实际申请币种显示。</p>
    <div class="me-grid">
      <div class="me-card">
        <div class="me-card-title">我的推广码</div>
        <div class="me-big">${escapeHtml(code || '待生成')}</div>
        <div class="me-sub">${escapeHtml(link)}</div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn-primary" id="copy-invite">复制推广链接</button>
          <button class="btn-ghost" id="save-poster">保存推广海报</button>
        </div>
      </div>
      <div class="me-card">
        <div class="me-card-title">推广数据</div>
        <div class="me-row"><span>邀请人数</span><b>${Number(data.directInvitees ?? 0)}</b></div>
        <div class="me-row"><span>推广人数</span><b>${Number(data.teamSize ?? 0)}</b></div>
        <div class="me-row"><span>好友支付订单</span><b>${Number(data.paidOrders ?? 0)}</b></div>
        <div class="me-row"><span>好友支付金额${displayCurrency === 'USD' ? '（折合美元）' : ''}</span><b>${teamPaidDisplay}</b></div>
        ${displayCurrency === 'USD' ? `<div class="me-sub">原币 ¥${Number(data.teamPaidAmount ?? 0).toFixed(2)} · 按 1 USD ≈ ¥${displayRate.toFixed(2)} 折算</div>` : ''}
      </div>
      <div class="me-card">
        <div class="me-card-title">佣金</div>
        <div class="me-row"><span>可提现</span><b>${displayMoney}</b></div>
        <div class="me-row"><span>冻结中</span><b>${moneyDisplay(data.commissions?.pendingFen)}</b></div>
        <div class="me-row"><span>可结算</span><b>${moneyDisplay(data.commissions?.availableFen)}</b></div>
        <div class="me-row"><span>已结算</span><b>${moneyDisplay(data.commissions?.settledFen)}</b></div>
        <div class="me-row"><span>退款冲减</span><b>${moneyDisplay(data.commissions?.reversedFen)}</b></div>
        ${Number(data.commissions?.debtFen ?? 0) > 0 ? `<div class="me-row"><span>待抵扣</span><b>${moneyDisplay(data.commissions?.debtFen)}</b></div>` : ''}
        <button class="btn-primary" id="open-withdrawal" style="margin-top:12px" ${Number(data.commissions?.withdrawableFen ?? 0) <= 0 ? 'disabled' : ''}>申请提现</button>
      </div>
      <div class="me-card">
        <div class="me-card-title">推广层级</div>
        ${(data.levels ?? []).length ? data.levels.map((row) => `<div class="me-row"><span>${row.level} 级</span><b>${Number(row.users ?? 0)} 人</b></div>`).join('') : '<div class="me-sub">暂无推广数据</div>'}
      </div>
    </div>`
  view.insertAdjacentHTML('beforeend', `
    <div class="section-head"><h2 class="section-title">提现记录</h2><div class="section-hint">金额按实际申请币种显示；财务复核后打款</div></div>
    <div class="table-wrap"><table><thead><tr><th>时间</th><th>金额</th><th>方式</th><th>状态</th></tr></thead><tbody>
      ${(data.withdrawals ?? []).length ? data.withdrawals.map((row) => `<tr>
        <td>${escapeHtml(row.created_at)}</td><td>${escapeHtml(row.currency_symbol ?? '')}${Number(row.amount ?? 0).toFixed(2)}</td>
        <td>${escapeHtml(row.method_name ?? row.method_code)}</td><td>${escapeHtml(row.statusLabel ?? row.status)}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="empty">暂无提现记录</td></tr>'}
    </tbody></table></div>`)
  for (const button of view.querySelectorAll('[data-promotion-currency]')) {
    button.addEventListener('click', async () => {
      localStorage.setItem('mh-currency', button.dataset.promotionCurrency)
      await renderPromotion()
    })
  }
  $('#open-withdrawal')?.addEventListener('click', () => openWithdrawalDialog(data, displayCurrency))
  $('#copy-invite')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('邀请链接已复制') } catch { toast(link) }
  })
  $('#save-poster')?.addEventListener('click', () => downloadDistributionPoster(code, link))
}

async function openWithdrawalDialog(data, displayCurrency) {
  const balance = (data.balances ?? []).find((row) => row.code === displayCurrency) ?? data.balances?.[0]
  const payoutCurrencies = data.payoutOptions?.currencies ?? []
  const modal = $('#modal')
  modal.innerHTML = `<div class="modal-card" style="width:min(520px,94vw)">
    <h3>申请提现</h3>
    <div class="form-row">
      <label>提现币种<select id="wd-currency">${payoutCurrencies.map((row) => `<option value="${escapeHtml(row.code)}" ${row.code === displayCurrency ? 'selected' : ''}>${escapeHtml(row.name)}</option>`).join('')}</select></label>
      <label>金额<input id="wd-amount" type="number" min="0" step="0.01" placeholder="0.00" /></label>
    </div>
    <div class="form-row"><label>可提现<b id="wd-available">${displayCurrency === 'CNY' ? '¥' : '$'}${Number(balance?.amount ?? 0).toFixed(2)}</b></label></div>
    <p class="me-sub" id="wd-rate-note"></p>
    <div id="wd-method-fields"></div>
    <div class="modal-foot"><button class="btn" data-cancel>取消</button><button class="btn primary" id="wd-submit">提交申请</button></div>
  </div>`
  const close = () => closeDialog(modal)
  const body = modal
  {
    let methods = []
    let selectedMethod = null
    const renderMethods = async () => {
      const currency = body.querySelector('#wd-currency').value
      let options
      try {
        options = await api(`/api/distribution/payout-options?currency=${encodeURIComponent(currency)}`)
      } catch (error) {
        body.querySelector('#wd-method-fields').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`
        return
      }
      methods = options.methods ?? []
      selectedMethod = methods[0] ?? null
      const selectedCurrency = (options.currencies ?? []).find((row) => row.code === currency)
      const rate = Number(selectedCurrency?.rateToCny ?? 1)
      const availableMinor = Math.round(Number(data.commissions?.withdrawableFen ?? 0) / rate)
      body.querySelector('#wd-available').textContent = `${selectedCurrency?.symbol ?? ''}${(availableMinor / 100).toFixed(2)}`
      body.querySelector('#wd-rate-note').textContent = currency === 'CNY'
        ? '当前按人民币申请，实际到账金额以财务复核结果为准。'
        : `1 ${currency} ≈ ¥${rate.toFixed(2)}；可提现余额已按该汇率折算，实际打款以所选提现方式为准。`
      const fieldHost = body.querySelector('#wd-method-fields')
      fieldHost.innerHTML = methods.length ? `
        <div class="form-row"><label>提现方式<select id="wd-method">${methods.map((method) => `<option value="${method.code}" data-min="${method.minAmountMinor ?? 0}">${escapeHtml(method.name)}</option>`).join('')}</select></label></div>
        <div class="form-row" id="wd-account-fields">${(methods[0].fields ?? []).map((field) => `<label>${escapeHtml(field.label ?? field.key)}<input data-wd-field="${escapeHtml(field.key)}" /></label>`).join('')}</div>
        <p class="muted small">${escapeHtml(methods[0].instructions ?? '')}</p>` : '<div class="empty">该币种暂无可用提现方式</div>'
      const methodSelect = fieldHost.querySelector('#wd-method')
      methodSelect?.addEventListener('change', () => {
        selectedMethod = methods.find((row) => row.code === methodSelect.value) ?? methods[0]
        const accountHost = fieldHost.querySelector('#wd-account-fields')
        if (accountHost) accountHost.innerHTML = (selectedMethod?.fields ?? []).map((field) => `<label>${escapeHtml(field.label ?? field.key)}<input data-wd-field="${escapeHtml(field.key)}" /></label>`).join('')
      })
    }
    body.querySelector('#wd-currency').addEventListener('change', () => void renderMethods())
    body.querySelector('[data-cancel]').addEventListener('click', close)
    body.querySelector('#wd-submit').addEventListener('click', async () => {
      if (!selectedMethod) return toast('该币种暂无可用提现方式')
      const button = body.querySelector('#wd-submit')
      if (button.disabled) return
      button.disabled = true
      button.textContent = '提交中…'
      const account = {}
      body.querySelectorAll('[data-wd-field]').forEach((input) => { account[input.dataset.wdField] = input.value.trim() })
      try {
        await api('/api/distribution/withdrawals', {
          method: 'POST',
          body: {
            amount: Number(body.querySelector('#wd-amount').value),
            currency: body.querySelector('#wd-currency').value,
            methodCode: selectedMethod.code,
            account,
          },
        })
        close()
        toast('提现申请已提交')
        await renderPromotion()
      } catch (error) {
        toast(error.message)
        button.disabled = false
        button.textContent = '提交申请'
      }
    })
    void renderMethods()
  }
  openDialog(modal, close)
}

async function renderSearch(params) {
  const keyword = params.get('q') ?? ''
  const tagId = Number(params.get('tag') ?? 0)
  track('search', { path: keyword, value: tagId || undefined })
  const query = new URLSearchParams()
  if (keyword) query.set('keyword', keyword)
  if (tagId) query.set('tag', String(tagId))
  const [data, home, tagData] = await Promise.all([
    api(`/api/search?${query.toString()}`),
    api('/api/home').catch(() => ({ hotwords: [] })),
    api('/api/tags').catch(() => ({ list: [] })),
  ])
  const tags = (tagData.list ?? []).filter((tag) => Number(tag.count ?? tag.dramaCount ?? 0) > 0)
  const activeTag = tags.find((tag) => Number(tag.id) === tagId)
  const chips = [
    `<a class="pill ${tagId ? '' : 'active'}" href="#/search${keyword ? `?q=${encodeURIComponent(keyword)}` : ''}">全部</a>`,
    ...tags.slice(0, 24).map((tag) => {
      const next = new URLSearchParams()
      if (keyword) next.set('q', keyword)
      next.set('tag', String(tag.id))
      return `<a class="pill ${Number(tag.id) === tagId ? 'active' : ''}" href="#/search?${next.toString()}">${escapeHtml(tag.name)}${tag.count ? `<em>${tag.count}</em>` : ''}</a>`
    }),
  ].join('')
  document.title = activeTag
    ? `标签 · ${activeTag.name} · 影巢`
    : (keyword ? `${keyword} · 搜索 · 影巢` : '搜索 · 影巢')
  const heading = activeTag ? `标签 · ${escapeHtml(activeTag.name)}` : '搜索'
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px">
      <h1 class="section-title">${heading}</h1>
      <div class="section-hint">${keyword
        ? `“${escapeHtml(keyword)}” 命中 ${data.total ?? 0} 部`
        : activeTag ? `共 ${data.total ?? 0} 部` : '输入关键词，或直接点下面的标签'}</div>
    </div>
    <div class="subtabs">${chips}</div>
    ${keyword || activeTag ? '' : `<div class="subtabs">${(home.hotwords ?? []).slice(0, 8).map((word) => `<a class="pill" href="#/search?q=${encodeURIComponent(word)}">${escapeHtml(word)}</a>`).join('')}</div>`}
    ${(data.list ?? []).length === 0
      ? `<div class="empty">${keyword || activeTag ? '没有找到相关剧集' : '还没有内容，先去首页看看'}</div>`
      : `<div class="grid">${data.list.map((item) => posterCard(item)).join('')}</div>`}`
}

async function renderDrama(id) {
  const seq = routeSeq
  const detail = await api(`/api/drama/${encodeURIComponent(id)}`)
  if (detail.isAdult && !hasAdultConsent()) {
    const allowed = await promptAdultAge()
    if (seq !== routeSeq) return
    if (!allowed) {
      history.replaceState(null, '', '#/home')
      await renderHome()
      return
    }
  }
  track('detail_view', { dramaId: Number(id) })
  const access = detail.access ?? 'subscription'
  const priceInfo = detail.priceInfo ?? { plans: [], singlePrice: detail.singlePrice ?? 0 }
  const canSingle = detail.accessMode === 'paid'
  document.title = `${detail.title} · 影巢`
  const episodes = detail.episodes ?? []
  const firstFree = episodes.find((episode) => episode.allow)
  const trialEp = episodes.find((episode) => !episode.allow && Number(episode.trialSeconds) > 0)
  const trialText = !trialEp ? '' : (Number(trialEp.trialSeconds) < 60
    ? `${Math.round(Number(trialEp.trialSeconds))} 秒`
    : `${Math.max(1, Math.round(Number(trialEp.trialSeconds) / 60))} 分钟`)
  const hasSubscription = Boolean(detail.hasSubscription)
  const owned = episodes.some((episode) => episode.source === 'purchase')
  const entitled = hasSubscription || owned
  const resumeNo = Number(detail.resumeEpisodeNo ?? 0) || null
  const priceText = Number(detail.singlePrice ?? 0).toFixed(2)
  const dateOnly = (value) => (value ? String(value).slice(0, 10) : '—')
  const adultStats = detail.isAdult ? detail.stats : null
  const payCta = `<button class="btn-ghost" id="open-paywall">${canSingle ? '解锁全部 ¥' + priceText : '开通会员看全集'}</button>`
  const cta = episodes.length === 0
    ? '<button class="btn-primary" disabled>暂无剧集</button>'
    : entitled
      ? `<button class="btn-primary" id="play-first">${icon('play', 16)}继续观看${resumeNo ? `第 ${resumeNo} 集` : ''}</button>`
      : firstFree
        // 首集免费是拉新的唯一钩子：先让人看到内容，再谈付费
        ? `<button class="btn-primary" id="play-free">${icon('play', 16)}免费看第 ${firstFree.no} 集</button>${payCta}`
        : trialEp
          ? `<button class="btn-primary" id="play-trial" data-no="${trialEp.no}">${icon('play', 16)}试看 ${trialText}</button>${payCta}`
          : `<button class="btn-primary" id="open-paywall">${canSingle ? '购买本片 ¥' + priceText : '开通会员'}</button>`

  view.innerHTML = `
    <div class="detail-head">
      <div class="detail-cover"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" data-img-fallback="hide" /></div>
      <div class="detail-meta">
        <h1 class="detail-title">${escapeHtml(detail.title)}</h1>
        <div class="detail-facts">
          <span>${icon('star', 13)} ${detail.score ?? '—'}</span>
          <span>${escapeHtml(String(detail.year ?? ''))}</span>
          <span>${escapeHtml(detail.areaLabel ?? detail.area ?? '')}</span>
          <span>${escapeHtml(detail.dramaTypeLabel ?? categoryLabel(detail.dramaType))}</span>
          <span>全 ${detail.episodes.length} 集</span>
          <span>${detail.freeEpisodes > 0 ? `首 ${detail.freeEpisodes} 集免费` : (canSingle ? '单片付费' : '会员专享')}</span>
          ${detail.isAdult ? `<span>发行 ${escapeHtml(dateOnly(detail.releaseDate))}</span><span>最近更新 ${escapeHtml(dateOnly(detail.updatedAt))}</span>` : ''}
        </div>
        <div class="detail-desc">${escapeHtml(detail.subTitle ?? '')}<br/>${escapeHtml(detail.description ?? '')}</div>
        ${adultStats ? `<div class="adult-stat-grid" aria-label="成人内容统计">
          <div><span>收藏</span><strong>${fmtCount(adultStats.favoriteCount ?? 0)}</strong></div>
          <div><span>今日浏览</span><strong>${fmtCount(adultStats.todayViews ?? 0)}</strong></div>
          <div><span>本周浏览</span><strong>${fmtCount(adultStats.weekViews ?? 0)}</strong></div>
          <div><span>本月浏览</span><strong>${fmtCount(adultStats.monthViews ?? 0)}</strong></div>
          <div><span>总浏览</span><strong>${fmtCount(adultStats.totalViews ?? 0)}</strong></div>
        </div>` : ''}
        ${(detail.tags ?? []).length > 0
          ? `<div class="subtabs">${detail.tags.map((tag) => `<a class="pill" href="${detail.isAdult ? '#/adult' : '#/search'}?tag=${tag.id}">${escapeHtml(tag.name)}</a>`).join('')}</div>`
          : ''}
        <div class="detail-actions">
          ${cta}
          <button class="btn-ghost" id="fav-btn">${detail.favorited ? `${icon('check', 15)}已收藏` : `${icon('plus', 15)}收藏`}</button>
          <button class="btn-ghost" id="share-btn">${icon('share', 15)}分享</button>
        </div>
      </div>
    </div>
    <div class="section-head"><h2 class="section-title">选集</h2><div class="section-hint">${(detail.priceInfo?.rules ?? []).length > 0 ? '部分集数单独定价，点开可见具体规则' : detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费，其余需${canSingle ? '购买' : '会员'}` : '需开通权益后观看'}</div></div>
    <div class="episodes">
      ${episodes.map((episode) => {
        // 可试看的集必须带 ?trial=1，服务端只认这个参数（否则直接 402）
        const trial = !episode.allow && episode.trialSeconds > 0 ? '?trial=1' : ''
        const guest = !state.token ? '?trial=1' : ''
        // 未放行的集要说清「为什么不能看」：会员可看 / 单集多少钱 / 需开通。
        // 服务端已经给出 reason 与 rule（按集定价），前端不猜价格。
        const rulePrice = Number(episode.rule?.price ?? 0)
        const flatPrice = Number(episode.price ?? 0)
        const hint = episode.allow ? ''
          : episode.reason === 'vip_required' ? '需会员'
            : rulePrice > 0 ? `¥${rulePrice.toFixed(2)}`
              : flatPrice > 0 ? `¥${flatPrice.toFixed(2)}` : '需开通'
        return `<a class="ep ${episode.allow ? '' : 'locked'}" data-no="${episode.no}" title="${escapeHtml(`第 ${episode.no} 集${hint ? ` · ${hint}` : ''}`)}" href="#/play/${detail.dramaId}/${episode.no}${trial || guest}">
        ${episode.no}${episode.allow ? '' : ` ${icon('lock', 12)}`}${episode.trialSeconds > 0 ? ' · 试看' : ''}
      </a>`
      }).join('')}
    </div>
    <div class="footer"><span>${escapeHtml(detail.title)} · 共 ${detail.episodes.length} 集</span><span>${detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费` : '需开通权益后观看'}</span></div>`

  $('#play-first')?.addEventListener('click', () => {
    const target = episodes.find((episode) => episode.no === resumeNo)
      ?? episodes.find((episode) => episode.allow)
      ?? episodes[0]
    if (!target) return toast('暂无剧集')
    location.hash = `#/play/${detail.dramaId}/${target.no}${state.token ? '' : '?trial=1'}`
  })
  $('#play-free')?.addEventListener('click', () => {
    if (!firstFree) return
    location.hash = `#/play/${detail.dramaId}/${firstFree.no}${state.token ? '' : '?trial=1'}`
  })
  $('#play-trial')?.addEventListener('click', () => {
    if (!trialEp) return
    location.hash = `#/play/${detail.dramaId}/${trialEp.no}?trial=1`
  })
  $('#open-paywall')?.addEventListener('click', () => openPaywall(detail, { price: detail.singlePrice, reason: canSingle ? 'single_purchase_required' : 'subscription_required' }))
  view.querySelectorAll('.episodes .ep').forEach((node) => {
    node.addEventListener('click', () => {
      const episode = episodes.find((item) => String(item.no) === String(node.dataset.no))
      track('episode_click', {
        dramaId: detail.dramaId,
        episodeId: episode?.id ?? null,
        meta: { no: Number(node.dataset.no), locked: node.classList.contains('locked') },
      })
    })
  })
  view.querySelectorAll('.ep.locked').forEach((node) => {
    // 可试看的集优先走播放（由服务端按 trialSeconds 截断），其余才弹付费墙
    if ((node.getAttribute('href') ?? '').includes('trial=1')) return
    node.addEventListener('click', (event) => {
      event.preventDefault()
      openPaywall(detail, { price: detail.singlePrice, reason: canSingle ? 'single_purchase_required' : 'subscription_required' })
    })
  })
  // 类似影视：参考站详情页底部有同类型推荐，点了直接换片
  const similar = (detail.similar ?? []).filter((item) => String(item.dramaId) !== String(detail.dramaId))
  if (similar.length) {
    view.insertAdjacentHTML('beforeend', `
      <section class="section">
        <div class="section-head">
          <div class="section-title">类似影视</div>
          <div class="section-hint">按类型与评分推荐</div>
        </div>
        <div class="grid">${similar.slice(0, 8).map((item) => posterCard(item)).join('')}</div>
      </section>`)
  }
  $('#fav-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget
    try {
      const result = await api('/api/me/favorite', { method: 'POST', body: JSON.stringify({ dramaId: detail.dramaId }) })
      button.innerHTML = result.favorited ? `${icon('check', 15)}已收藏` : `${icon('plus', 15)}收藏`
      toast(result.favorited ? '已收藏' : '已取消收藏')
      track('favorite', { dramaId: detail.dramaId, meta: { favorited: Boolean(result.favorited), from: 'detail' } })
    } catch (error) {
      if (error.code === '0401') { pendingRoute = `#/drama/${detail.dramaId}`; openLogin() } else toast(error.message)
    }
  })
  $('#share-btn').addEventListener('click', async () => {
    const url = `${location.origin}${BASE}/#/drama/${detail.dramaId}`
    const text = `《${detail.title}》${detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费` : ''}`
    let channel = 'clipboard'
    if (navigator.share) {
      try { await navigator.share({ title: detail.title, text, url }); channel = 'native' } catch { /* 用户取消或不支持，退回复制 */ }
    }
    if (channel === 'clipboard') {
      try { await navigator.clipboard.writeText(`${text} ${url}`); toast('分享链接已复制') } catch { toast(url) }
    }
    track('share', { dramaId: detail.dramaId, meta: { channel, from: 'detail' } })
  })
  void priceInfo
}

async function renderPlay(id, episodeNo, params = new URLSearchParams()) {
  const seq = routeSeq
  const trialMode = params.get('trial') === '1'
  const playPath = `/api/play/${encodeURIComponent(id)}/${encodeURIComponent(episodeNo)}${trialMode ? '?trial=1' : ''}`
  const detail = await api(`/api/drama/${encodeURIComponent(id)}`)
  if (detail.isAdult && !hasAdultConsent()) {
    const allowed = await promptAdultAge()
    if (seq !== routeSeq) return
    if (!allowed) {
      history.replaceState(null, '', '#/home')
      await renderHome()
      return
    }
  }
  let data
  try {
    data = await api(playPath)
  } catch (error) {
    if (error.code === '0401') {
      view.innerHTML = `<div class="empty">${escapeHtml(error.message)}<br/><br/><button class="btn-primary" id="play-login">登录后播放</button></div>`
      $('#play-login').addEventListener('click', () => {
        pendingRoute = `#/play/${id}/${episodeNo}${trialMode ? '?trial=1' : ''}`
        openLogin()
      })
      return
    }
    // 409：片源未就绪；402：权益不足 → 详情 + 付费墙
    const notReady = error.code === 'episode_not_ready' || error.code === '0409'
    view.innerHTML = `
      <div class="empty">
        <div style="font-size:16px;margin-bottom:8px">${escapeHtml(error.message)}</div>
        ${detail ? `<div style="color:#9aa3b2;font-size:13px">${escapeHtml(detail.title)} · 第 ${escapeHtml(episodeNo)} 集</div>` : ''}
        <div style="margin-top:18px;display:flex;gap:10px;justify-content:center">
          ${notReady
            ? '<button class="btn-primary" id="play-retry">重新加载</button>'
            : '<button class="btn-primary" id="go-paywall">查看购买选项</button>'}
          <a class="btn-ghost" href="#/drama/${encodeURIComponent(id)}">返回详情</a>
        </div>
      </div>`
    const info = error.data ?? {}
    track('play_error', { dramaId: Number(id), meta: { code: error.code ?? null, message: error.message ?? '' } })
    $('#go-paywall')?.addEventListener('click', () => openPaywall(detail, {
      plans: info.plans, price: info.price, reason: info.reason, title: error.message,
    }))
    $('#play-retry')?.addEventListener('click', () => route())
    return
  }

  cleanupRoute()
  const cleanups = []
  const onCleanup = (fn) => { cleanups.push(fn) }
  routeCleanups = cleanups

  const episode = data.episode ?? detail.episodes.find((item) => String(item.no) === String(episodeNo)) ?? {}
  const trackPrefKey = `mh-track-pref:${detail.dramaId}`
  let trackPref = {}
  try {
    trackPref = JSON.parse(localStorage.getItem(trackPrefKey) ?? '{}') ?? {}
  } catch {
    trackPref = {}
  }
  if (state.token) {
    try {
      const saved = await api(`/api/me/track-preferences?dramaId=${encodeURIComponent(detail.dramaId)}`)
      if (saved?.audio) trackPref.audio = saved.audio
      if (saved?.subtitle === 'off' || saved?.subtitle) trackPref.subtitle = saved.subtitle
    } catch { /* ignore */ }
  }
  const saveTrackPref = (next) => {
    trackPref = next
    try { localStorage.setItem(trackPrefKey, JSON.stringify(next)) } catch { /* ignore */ }
  }
  const persistTrackPref = (kind, value) => {
    saveTrackPref({ ...trackPref, [kind]: value })
    if (!state.token) return
    const body = value === 'off'
      ? { dramaId: detail.dramaId, kind, off: true }
      : { dramaId: detail.dramaId, kind, language: value.language, edition: value.edition }
    void api('/api/me/track-preferences', { method: 'PUT', body }).catch(() => {})
  }
  const sourceLabel = { free: '免费观看', subscription: '会员权益', purchase: '已购买', trial: '试看' }[data.source] ?? ''
  const expiredNotice = data.hls ? `播放链接 ${Math.round((data.expiresIn ?? 300) / 60)} 分钟内有效，失效后自动重连` : ''

  const episodeLinks = detail.episodes.map((item) => {
    const trial = !item.allow && item.trialSeconds > 0 ? '?trial=1' : ''
    const guest = !state.token ? '?trial=1' : ''
    const hint = item.allow ? '' : item.trialSeconds > 0 ? ' · 可试看' : ' · 需解锁'
    return `<a class="ep ${String(item.no) === String(episodeNo) ? 'active' : ''} ${item.allow ? '' : 'locked'}"
      data-no="${item.no}" href="#/play/${detail.dramaId}/${item.no}${trial || guest}"
      title="第 ${item.no} 集${hint}"${String(item.no) === String(episodeNo) ? ' aria-current="page"' : ''}>
      ${item.no}${item.allow ? '' : ` ${icon('lock', 12)}`}${item.trialSeconds > 0 ? '<small>试看</small>' : ''}
    </a>`
  }).join('')

  view.innerHTML = `
    <h1 class="sr-only">${escapeHtml(data.title)} 第 ${escapeHtml(String(episodeNo))} 集</h1>
    <div class="watch-layout">
      <div class="watch-main">
        <div class="player-wrap">
          <div class="player-bar">
            <span>${escapeHtml(data.title)} · 第 ${escapeHtml(String(episodeNo))} 集</span>
            <span style="margin-left:auto">${sourceLabel}${data.hls ? ' · HLS' : ' · 未上传片源'}</span>
          </div>
          <div class="player" id="player">
            <video id="video" playsinline controls style="width:100%;height:100%;object-fit:contain;background:#000"></video>
            <div class="danmu-layer" id="danmu-layer" aria-hidden="true"></div>
            <div class="notice" id="player-notice">${data.hls ? expiredNotice : '该集片源正在处理中'}</div>
            <div class="player-tools">
              <select id="quality-select" aria-label="播放清晰度"><option value="-1">自动清晰度</option></select>
              <select id="audio-select" aria-label="${t('音轨')}" style="display:none"></select>
              <select id="subtitle-select" aria-label="${t('字幕')}" style="display:none"></select>
              <input id="danmu-input" aria-label="发送弹幕" placeholder="发条弹幕…" maxlength="60" />
              <button class="btn-ghost" id="danmu-send">发送</button>
              <button class="btn-ghost" id="share-btn">${icon('share', 15)}分享</button>
            </div>
            <div class="player-fail hidden" id="player-fail"><button class="btn-primary" id="player-retry">播放异常，点击重试</button></div>
          </div>
        </div>
        <div class="detail-head watch-info">
          <div class="detail-cover"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" /></div>
          <div class="detail-meta">
            <h2 class="detail-title">${escapeHtml(detail.title)}</h2>
            <div class="detail-facts"><span>${escapeHtml(String(detail.year ?? ''))}</span><span>${escapeHtml(detail.areaLabel ?? detail.area ?? '')}</span><span>${escapeHtml(detail.dramaTypeLabel ?? categoryLabel(detail.dramaType))}</span><span>第 ${escapeHtml(String(episodeNo))} 集</span></div>
            ${detail.subTitle ? `<p class="detail-desc">${escapeHtml(detail.subTitle)}</p>` : ''}
          </div>
        </div>
      </div>
      <aside class="watch-episodes" aria-labelledby="watch-episodes-title">
        <div class="watch-episodes-head"><h2 id="watch-episodes-title" class="section-title">选集</h2><span>${detail.episodes.length} 集</span></div>
        <div class="watch-episode-grid">${episodeLinks}</div>
      </aside>
    </div>`

  const video = $('#video')
  const danmuLayer = $('#danmu-layer')
  const viewSessionId = data.viewSessionId
  let heartbeatTimer = 0
  const sendViewHeartbeat = () => {
    if (!viewSessionId || !video) return
    const duration = Number(video.duration || data.duration || 0)
    void api(`/api/play/session/${encodeURIComponent(viewSessionId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({
        positionSeconds: Number(video.currentTime || 0),
        durationSeconds: duration,
        playing: !video.paused && !video.ended,
        visible: !document.hidden,
        playbackRate: Number(video.playbackRate || 1),
      }),
    }).catch(() => {})
  }
  if (viewSessionId) {
    heartbeatTimer = setInterval(() => {
      if (!video?.ended) sendViewHeartbeat()
    }, 15_000)
    video?.addEventListener('play', sendViewHeartbeat)
    video?.addEventListener('pause', sendViewHeartbeat)
    onCleanup(() => {
      clearInterval(heartbeatTimer)
      sendViewHeartbeat()
    })
  }
  const notice = (text) => { const node = $('#player-notice'); if (node) node.textContent = translateText(text, node) }
  const player = $('#player')
  const tools = $('.player-tools')
  let hideTimer = 0
  let toolsPinned = false
  const showControls = () => {
    player?.classList.remove('controls-hidden')
    clearTimeout(hideTimer)
    if (!video?.paused && !toolsPinned) {
      hideTimer = setTimeout(() => {
        if (!video.paused && !toolsPinned) player?.classList.add('controls-hidden')
      }, 2600)
    }
  }
  const showPausedControls = () => {
    clearTimeout(hideTimer)
    player?.classList.remove('controls-hidden')
  }
  video?.addEventListener('play', showControls)
  video?.addEventListener('pause', showPausedControls)
  video?.addEventListener('ended', showPausedControls)
  video?.addEventListener('seeking', showControls)
  player?.addEventListener('pointermove', showControls)
  player?.addEventListener('pointerdown', showControls)
  tools?.addEventListener('pointerenter', () => { toolsPinned = true; clearTimeout(hideTimer); player?.classList.remove('controls-hidden') })
  tools?.addEventListener('pointerleave', () => { toolsPinned = false; showControls() })
  tools?.addEventListener('focusin', () => { toolsPinned = true; clearTimeout(hideTimer); player?.classList.remove('controls-hidden') })
  tools?.addEventListener('focusout', () => { toolsPinned = false; showControls() })
  let playTracked = false
  video?.addEventListener('play', () => {
    if (playTracked) return
    playTracked = true
    track('play_start', { dramaId: detail.dramaId, episodeId: episode.id })
  })
  onCleanup(() => clearTimeout(hideTimer))

  view.querySelectorAll('.ep.locked').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.preventDefault()
      openPaywall(detail, { price: detail.singlePrice, reason: detail.accessMode === 'paid' ? 'single_purchase_required' : 'subscription_required' })
    })
  })

  $('#danmu-send')?.addEventListener('click', async () => {
    const input = $('#danmu-input')
    const content = input.value.trim()
    if (!content) return
    try {
      const result = await api('/api/danmu', {
        method: 'POST',
        body: JSON.stringify({ episodeId: episode.id, timeMs: Math.round((video?.currentTime ?? 0) * 1000), content }),
      })
      toast(result.message ?? '已提交')
      input.value = ''
    } catch (error) {
      if (error.code === '0401') { pendingRoute = `#/play/${id}/${episodeNo}`; openLogin() } else toast(error.message)
    }
  })
  $('#share-btn')?.addEventListener('click', async () => {
    // 分享详情页：播放页未登录会撞登录墙，分享出去等于发了个打不开的链接
    const url = `${location.origin}${BASE}/#/drama/${detail.dramaId}`
    const text = `《${detail.title}》`
    let channel = 'clipboard'
    if (navigator.share) {
      try { await navigator.share({ title: detail.title, text, url }); channel = 'native' } catch { /* 取消 */ }
    }
    if (channel === 'clipboard') {
      try { await navigator.clipboard.writeText(`${text} ${url}`); toast('分享链接已复制') } catch { toast(url) }
    }
    track('share', { dramaId: detail.dramaId, meta: { channel, from: 'play' } })
  })

  /* ---- 弹幕 ---- */
  const danmu = Array.isArray(data.danmu) ? data.danmu : []
  let danmuTimer
  const shownDanmu = new Set()
  const startDanmu = () => {
    clearInterval(danmuTimer)
    // 没弹幕就让它空着：随机兜底会伪造"很多人在看"，比空屏更糟
    if (danmu.length === 0) return
    danmuTimer = setInterval(() => {
      const current = video.currentTime * 1000
      danmu.forEach((item, index) => {
        if (shownDanmu.has(index)) return
        if (item.time < current - 500 || item.time > current + 1500) return
        shownDanmu.add(index)
        const node = document.createElement('span')
        node.className = 'danmu'
        node.textContent = item.text
        node.style.top = `${8 + Math.random() * 70}%`
        node.style.animationDuration = `${6 + Math.random() * 4}s`
        danmuLayer.appendChild(node)
        setTimeout(() => node.remove(), 11000)
      })
    }, 600)
    onCleanup(() => clearInterval(danmuTimer))
  }

  /* ---- 进度与埋点 ---- */
  const saveHistory = () => {
    if (!state.token) return
    if (!(video.currentTime > 0)) return
    void api('/api/me/history', {
      method: 'POST',
      body: JSON.stringify({ dramaId: detail.dramaId, episode: Number(episodeNo), position: Math.round(video.currentTime || 0) }),
    }).catch(() => {})
  }
  let endReported = false
  const reportEnd = (reason) => {
    if (endReported || !(video.currentTime > 0)) return
    endReported = true
    const duration = video.duration || Number(data.duration) || 0
    track('play_end', {
      dramaId: detail.dramaId,
      episodeId: episode.id ?? null,
      position: Math.round(video.currentTime),
      duration: Math.round(duration),
      value: duration ? Math.min(1, video.currentTime / duration) : 0,
      meta: { reason },
    })
  }
  onCleanup(() => { reportEnd('leave'); saveHistory() })

  const playable = Boolean(data.hls)
  if (!playable) {
    const status = data.episodeStatus ?? episode.status ?? ''
    const hint = status === 'processing' || status === 'queued' || status === 'transcoding'
      ? '本集正在转码，通常几分钟内完成，稍后刷新即可观看'
      : '本集片源异常，客服正在处理'
    notice(hint)
    const bigPlay = document.createElement('button')
    bigPlay.className = 'big-play'
    bigPlay.setAttribute('aria-label', '播放')
    bigPlay.innerHTML = icon('play', 28)
    bigPlay.addEventListener('click', () => {
      toast(hint)
      if (status === 'processing' || status === 'queued' || status === 'transcoding') {
        setTimeout(() => { if (seq === routeSeq) route() }, 30000)
      }
    })
    $('#player').appendChild(bigPlay)
    return
  }

  /* ---- 播放器（含错误恢复）---- */
  let hls = null
  let retries = 0
  let lastPosition = Number(data.resumePosition ?? episode.position ?? 0)
  let hlsUrl = data.hls

  const showFail = (message) => {
    const node = $('#player-fail')
    if (!node) return
    node.classList.remove('hidden')
    node.querySelector('#player-retry').textContent = message ?? '播放异常，点击重试'
  }
  const hideFail = () => $('#player-fail')?.classList.add('hidden')

  const setupTracks = (instance) => {
    const hlsAudio = Array.isArray(instance.audioTracks) ? instance.audioTracks : []
    const hlsSubs = Array.isArray(instance.subtitleTracks) ? instance.subtitleTracks : []
    const apiAudio = Array.isArray(data.audioTracks) && data.audioTracks.length
      ? data.audioTracks
      : hlsAudio.map((item) => ({ id: item.id, language: item.lang ?? 'und', edition: '', label: item.name ?? '', default: Boolean(item.default) }))
    const apiSubs = Array.isArray(data.subtitleTracks) && data.subtitleTracks.length
      ? data.subtitleTracks
      : hlsSubs.map((item) => ({ id: item.id, language: item.lang ?? 'und', edition: '', label: item.name ?? '', default: Boolean(item.default) }))
    const findHls = (trackInfo, list) => {
      const language = String(trackInfo?.language ?? '').toLowerCase()
      const label = String(trackInfo?.label ?? '').toLowerCase()
      return list.find((item) => String(item.lang ?? '').toLowerCase() === language && String(item.name ?? '').toLowerCase() === label)
        ?? list.find((item) => String(item.lang ?? '').toLowerCase() === language)
    }
    const audioChoice = matchTrack(apiAudio, trackPref.audio, getLang())
    const subtitleChoice = matchTrack(apiSubs, trackPref.subtitle, getLang(), { subtitle: true })
    const audioHls = audioChoice ? findHls(audioChoice, hlsAudio) : null
    const subtitleHls = subtitleChoice ? findHls(subtitleChoice, hlsSubs) : null
    if (audioHls?.id !== undefined) instance.audioTrack = audioHls.id
    instance.subtitleTrack = subtitleHls?.id ?? -1

    const audioSelect = $('#audio-select')
    if (audioSelect) {
      if (apiAudio.length > 1) {
        audioSelect.innerHTML = apiAudio.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}${item.edition ? ` · ${escapeHtml(item.edition)}` : ''}</option>`).join('')
        audioSelect.value = String(audioChoice?.id ?? apiAudio[0]?.id ?? '')
        audioSelect.style.display = ''
        audioSelect.onchange = () => {
          const next = apiAudio.find((item) => String(item.id) === String(audioSelect.value))
          if (!next) return
          const target = findHls(next, hlsAudio)
          if (target?.id !== undefined) instance.audioTrack = target.id
          persistTrackPref('audio', { language: next.language, edition: next.edition })
          track('track_change', { dramaId: detail.dramaId, meta: { kind: 'audio', language: next.language, edition: next.edition } })
        }
      } else {
        audioSelect.style.display = 'none'
      }
    }

    const subtitleSelect = $('#subtitle-select')
    if (subtitleSelect) {
      if (apiSubs.length) {
        subtitleSelect.innerHTML = `<option value="-1">${escapeHtml(t('关闭字幕'))}</option>`
          + apiSubs.map((item) => `<option value="${item.id}">${escapeHtml(item.label)}${item.edition ? ` · ${escapeHtml(item.edition)}` : ''}</option>`).join('')
        subtitleSelect.value = subtitleChoice ? String(subtitleChoice.id) : '-1'
        subtitleSelect.style.display = ''
        subtitleSelect.onchange = () => {
          if (subtitleSelect.value === '-1') {
            instance.subtitleTrack = -1
            persistTrackPref('subtitle', 'off')
            track('track_change', { dramaId: detail.dramaId, meta: { kind: 'subtitle', off: true } })
            return
          }
          const next = apiSubs.find((item) => String(item.id) === String(subtitleSelect.value))
          if (!next) return
          const target = findHls(next, hlsSubs)
          if (target?.id !== undefined) instance.subtitleTrack = target.id
          persistTrackPref('subtitle', { language: next.language, edition: next.edition })
          track('track_change', { dramaId: detail.dramaId, meta: { kind: 'subtitle', language: next.language, edition: next.edition } })
        }
      } else {
        subtitleSelect.style.display = 'none'
      }
    }
  }

  const attach = async (url) => {
    hlsUrl = url
    if (hls) { try { hls.destroy() } catch { /* ignore */ } hls = null }
    const hasTracks = (Array.isArray(data.audioTracks) && data.audioTracks.length > 0)
      || (Array.isArray(data.subtitleTracks) && data.subtitleTracks.length > 0)
    if (!hasTracks && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = BASE + url
      return
    }
    const Hls = await loadHls()
    if (!Hls || !Hls.isSupported()) {
      video.src = BASE + url
      return
    }
    const instance = new Hls({ lowLatencyMode: false })
    hls = instance
    instance.loadSource(BASE + url)
    instance.attachMedia(video)
    instance.on(Hls.Events.MANIFEST_PARSED, () => {
      const select = $('#quality-select')
      if (!select) return
      select.innerHTML = '<option value="-1">自动清晰度</option>'
        + instance.levels.map((level, index) => `<option value="${index}">${level.height}p</option>`).join('')
      select.onchange = () => { instance.currentLevel = Number(select.value) }
      setupTracks(instance)
    })
    instance.on(Hls.Events.ERROR, (_event, payload) => {
      if (!payload?.fatal) return
      void recover(`播放中断（${payload.type}）`)
    })
  }

  // 签名过期/分片 404/网络抖动：重新取一次播放地址（这是拿新 Cookie 的唯一途径）再续播
  const recover = async (reason) => {
    if (retries >= 3) { showFail('播放异常，点击重试'); return }
    retries += 1
    notice(`${reason}，正在重新获取播放地址…`)
    const at = video.currentTime || lastPosition || 0
    try {
      const fresh = await api(playPath)
      if (!fresh.hls) throw new Error('该集片源暂不可用')
      await attach(fresh.hls)
      video.addEventListener('loadedmetadata', () => {
        if (at > 0) video.currentTime = at
        void video.play().catch(() => {})
      }, { once: true })
      notice(expiredNotice)
      hideFail()
    } catch (error) {
      showFail(error.message || '播放异常，点击重试')
    }
  }

  $('#player-retry')?.addEventListener('click', () => { retries = 0; hideFail(); void recover('手动重试') })
  video.addEventListener('error', () => { void recover('播放中断') })
  onCleanup(() => {
    try { hls?.destroy() } catch { /* ignore */ }
    try { video.pause(); video.removeAttribute('src'); video.load() } catch { /* ignore */ }
  })

  await attach(hlsUrl).catch(() => { video.src = BASE + hlsUrl })

  // 浏览器自动播放策略：带声音的 play() 会被拒，此时给一个明显的开始按钮，而不是让用户对着黑屏
  const showStart = () => {
    if (document.querySelector('#player-start')) return
    const wrap = $('#player')
    if (!wrap) return
    const button = document.createElement('button')
    button.id = 'player-start'
    button.className = 'player-start'
    button.setAttribute('aria-label', '播放')
    button.innerHTML = icon('play', 28)
    button.addEventListener('click', () => { button.remove(); void video.play().catch(() => {}) })
    wrap.appendChild(button)
  }
  video.addEventListener('loadedmetadata', () => { void video.play().catch(showStart) }, { once: true })
  onCleanup(() => document.querySelector('#player-start')?.remove())

  video.addEventListener('play', startDanmu, { once: true })
  video.addEventListener('pause', saveHistory)
  video.addEventListener('loadedmetadata', () => {
    // 续播：太靠近开头/结尾时不跳，避免误判
    if (lastPosition > 5 && (!video.duration || lastPosition < video.duration - 10)) {
      video.currentTime = lastPosition
      notice(`已从上次观看到的 ${Math.floor(lastPosition / 60)}:${String(Math.floor(lastPosition % 60)).padStart(2, '0')} 继续播放`)
    }
  }, { once: true })

  // 试看截断：服务端只发短签名，前端到点必须停并弹付费墙
  const trialSeconds = Number(data.trialSeconds ?? 0)
  let trialHit = false
  if (data.source === 'trial' && trialSeconds > 0) {
    // 参考站是「试看 10:00 后结束，观看完整影片请登录」的倒计时提示，这里同样显示剩余秒数
    const remainText = (seconds) => {
      const left = Math.max(0, Math.ceil(seconds))
      return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
    }
    notice(`试看剩余 ${remainText(trialSeconds)}，结束后需开通会员或购买`)
    track('trial_start', { dramaId: detail.dramaId, episodeId: episode.id, meta: { seconds: trialSeconds } })
    let clamping = false
    const clampTrialSeek = () => {
      if (clamping || trialHit || video.currentTime <= trialSeconds + 0.25) return
      clamping = true
      video.currentTime = Math.max(0, trialSeconds - 0.25)
      notice(`试看仅限前 ${trialSeconds} 秒，结束后需开通会员或购买`)
      setTimeout(() => { clamping = false }, 0)
    }
    video.addEventListener('seeking', clampTrialSeek)
    onCleanup(() => video.removeEventListener('seeking', clampTrialSeek))
    video.addEventListener('timeupdate', () => {
      if (trialHit) return
      const left = trialSeconds - video.currentTime
      if (left > 0) {
        notice(`试看剩余 ${remainText(left)}，结束后需开通会员或购买`)
        return
      }
      trialHit = true
      video.pause()
      track('trial_end', { dramaId: detail.dramaId, episodeId: episode.id, position: Math.round(video.currentTime), meta: { reason: 'timeout' } })
      openPaywall(detail, {
        price: detail.singlePrice,
        reason: detail.accessMode === 'paid' ? 'single_purchase_required' : 'subscription_required',
        title: '试看结束',
      })
    })
  }

  // 连播：本集播完自动进下一集
  video.addEventListener('ended', () => {
    saveHistory()
    reportEnd('ended')
    if (!data.nextEpisodeNo) return toast('已是最后一集')
    toast(`即将播放第 ${data.nextEpisodeNo} 集`)
    const nextTimer = setTimeout(() => {
      if (seq === routeSeq) location.hash = `#/play/${detail.dramaId}/${data.nextEpisodeNo}`
    }, 800)
    onCleanup(() => clearTimeout(nextTimer))
  })

  // 上报节流：timeupdate 约 4Hz，按「距上次上报满 15 秒」判定，避免同秒重复写库
  let lastSavedAt = -15
  video.addEventListener('timeupdate', () => {
    if (video.currentTime - lastSavedAt < 15) return
    lastSavedAt = video.currentTime
    saveHistory()
  })

  document.title = `${data.title} 第 ${episodeNo} 集 · 影巢`
}

const ACCOUNT_TABS = [
  ['me', '个人中心', '#/me'],
  ['history', '观看历史', '#/history'],
  ['favorites', '我的收藏', '#/favorites'],
]

function accountTabs(active) {
  return `<nav class="account-tabs" aria-label="账户导航">
    ${ACCOUNT_TABS.map(([key, label, href]) => `<a class="account-tab ${active === key ? 'active' : ''}" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`).join('')}
  </nav>`
}

function formatPlaybackPosition(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function parseUtcTimestamp(value) {
  const text = String(value ?? '').trim()
  if (!text) return NaN
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text
  return Date.parse(iso)
}

function formatAccountOrderTime(value) {
  if (!value) return '—'
  const text = String(value)
  const date = new Date(text.includes('T') ? text : `${text.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return text.slice(0, 16)
  return date.toLocaleString(getLang() === 'en' ? 'en-US' : 'zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function accountOrdersMarkup(rawOrders) {
  const orders = (rawOrders ?? []).map((order) => {
    const amount = Number(order.amount ?? order.amount_cny)
    const status = String(order.status ?? 'created')
    const productType = order.productType ?? order.product_type
    const planName = order.planName ?? order.plan_name
    const dramaTitle = order.dramaTitle ?? order.drama_title
    const productDetail = productType === 'subscription' ? planName : dramaTitle
    const productLabel = productType === 'subscription' ? t('会员订阅') : t('单片购买')
    return {
      outTradeNo: order.outTradeNo ?? order.out_trade_no ?? '',
      amountText: Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : '—',
      status,
      statusText: order.statusLabel ?? ORDER_STATUS[status] ?? status,
      productHtml: `${escapeHtml(productLabel)}${productDetail ? ` · <span data-i18n-ignore>${escapeHtml(productDetail)}</span>` : ''}`,
      channel: CHANNEL_LABEL[order.channel] ?? order.channel ?? '',
      timeText: formatAccountOrderTime(order.createdAt ?? order.created_at),
      pending: status === 'created' || status === 'pending',
    }
  })
  const visible = orders.slice(0, 10)
  return `<section class="me-orders" aria-labelledby="me-orders-title">
    <div class="section-head"><h2 class="section-title" id="me-orders-title">订单记录</h2>
      <div class="section-hint">共 ${orders.length} 笔${orders.length > 10 ? ' · 显示最近 10 笔' : ''}</div></div>
    ${visible.length ? `<div class="orders-panel"><table class="orders-table">
      <thead><tr><th>订单</th><th>内容</th><th>金额</th><th>状态</th><th>时间</th><th>操作</th></tr></thead>
      <tbody>${visible.map((order) => `<tr>
        <td data-label="订单"><span class="order-id" data-i18n-ignore title="${escapeHtml(order.outTradeNo)}">${escapeHtml(order.outTradeNo)}</span></td>
        <td data-label="内容"><span class="order-product">${order.productHtml}</span>${order.channel ? `<span class="order-sub" data-i18n-ignore>${escapeHtml(order.channel)}</span>` : ''}</td>
        <td data-label="金额"><span class="order-amount">${order.amountText}</span></td>
        <td data-label="状态"><span class="order-status order-${escapeHtml(order.status)}">${escapeHtml(order.statusText)}</span></td>
        <td data-label="时间"><span class="order-time">${escapeHtml(order.timeText)}</span></td>
        <td data-label="操作">${order.pending ? `<button class="btn-ghost sm" data-resume="${escapeHtml(order.outTradeNo)}">继续支付</button>` : '<span class="order-muted">—</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty orders-empty">还没有订单<br/><br/><a class="btn-primary" href="#/home">去首页看看</a></div>'}
  </section>`
}

async function renderHistory() {
  document.title = '观看历史 · 影巢'
  const data = await api('/api/me')
  const history = data.history ?? []
  view.innerHTML = `
    ${accountTabs('history')}
    <div class="section-head account-head"><h1 class="section-title">观看历史</h1><div class="section-hint">${history.length} 条记录</div></div>
    ${history.length ? `<div class="history-list">${history.map((item) => `
      <a class="history-item" href="#/play/${encodeURIComponent(item.dramaId)}/${encodeURIComponent(item.episode)}">
        <img class="history-cover" loading="lazy" src="${escapeHtml(mediaUrl(item.coverUrl))}" alt="" />
        <span class="history-copy"><span class="history-title">${escapeHtml(item.title)}</span><span class="history-meta">看到第 ${escapeHtml(String(item.episode))} 集${Number(item.position) > 0 ? ` · ${formatPlaybackPosition(item.position)}` : ''}</span></span>
        <span class="history-cta">继续观看${icon('play', 14)}</span>
      </a>`).join('')}</div>` : '<div class="empty account-empty">还没有观看记录<br/><br/><a class="btn-primary" href="#/home">去首页看看</a></div>'}`
  observeImpressions()
}

async function renderFavorites() {
  document.title = '我的收藏 · 影巢'
  const data = await api('/api/me')
  const favorites = data.favorites ?? []
  view.innerHTML = `
    ${accountTabs('favorites')}
    <div class="section-head account-head"><h1 class="section-title">我的收藏</h1><div class="section-hint">${favorites.length} 部</div></div>
    ${favorites.length ? `<div class="grid">${favorites.map((item) => posterCard(item)).join('')}</div>` : '<div class="empty account-empty">还没有收藏<br/><br/><a class="btn-primary" href="#/home">去首页看看</a></div>'}`
  observeImpressions()
}

async function resizeAvatar(file) {
  if (!('createImageBitmap' in window)) return file
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const size = Math.min(512, side)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    return file
  }
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  bitmap.close?.()
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.86))
  return blob ?? file
}

async function renderMe(params = {}) {
  const legacyTab = params.get?.('tab')
  if (legacyTab === 'history' || legacyTab === 'favorite' || legacyTab === 'favorites') {
    const next = legacyTab === 'history' ? '#/history' : '#/favorites'
    window.history.replaceState(null, '', next)
    return legacyTab === 'history' ? renderHistory() : renderFavorites()
  }
  if (!state.token) {
    view.innerHTML = `
      <div class="section-head" style="margin-top:26px"><h1 class="section-title">我的</h1></div>
      <div class="empty">登录后可查看订阅权益、订单与观看历史<br/><br/><button class="btn-primary" id="me-login">登录 / 注册</button></div>`
    $('#me-login').addEventListener('click', openLogin)
    return
  }
  const [data, orderData, messageData] = await Promise.all([
    api('/api/me'),
    api('/api/orders'),
    api('/api/me/messages').catch(() => ({ messages: [] })),
  ])
  const orders = orderData.list ?? []
  const messages = messageData.messages ?? []
  document.title = '我的 · 影巢'
  const sub = data.subscription
  const subscriptionDays = sub
    ? Math.max(0, Math.ceil((parseUtcTimestamp(sub.validTo) - Date.now()) / 86400000))
    : 0
  view.innerHTML = `
    ${accountTabs('me')}
    <div class="section-head"><h1 class="section-title">我的</h1>
      <div class="section-hint"><span data-i18n-ignore>${escapeHtml(data.user.nickname)}</span> · <span data-i18n-ignore>${escapeHtml(data.user.email ?? '未绑定邮箱')}</span></div></div>
    <div class="me-grid me-overview">
      <div class="me-card me-profile-card">
        <div class="me-card-title">个人资料 · 完整度 ${data.completion?.percent ?? 0}%</div>
        <div class="me-profile">
          <div class="avatar-wrap">
            ${data.user.avatar
              ? `<img id="me-avatar" class="avatar" src="${escapeHtml(mediaUrl(data.user.avatar))}" alt="头像" />`
              : '<div id="me-avatar" class="avatar avatar-empty">' + escapeHtml((data.user.nickname ?? '影').slice(0, 1)) + '</div>'}
            <label class="avatar-upload"><span id="avatar-upload-text">更换头像</span><input type="file" id="avatar-file" accept="image/png,image/jpeg,image/webp" hidden /></label>
          </div>
          <div class="me-profile-fields">
            <div class="me-row me-row-email"><span>邮箱</span><span><span data-i18n-ignore>${escapeHtml(data.user.email ?? '—')}</span><button class="btn sm" id="change-email">更换</button></span></div>
            <div class="me-row"><span>昵称</span><span data-i18n-ignore>${escapeHtml(data.user.nickname)}</span></div>
            <div class="me-row"><span>生日</span><span data-i18n-ignore>${escapeHtml(data.user.birthday ?? '未填写')}</span></div>
            <div class="me-row"><span>性别</span><span>${escapeHtml({ male: '男', female: '女', other: '其他', secret: '保密' }[data.user.gender] ?? '未填写')}</span></div>
            <div class="me-row"><span>简介</span><span data-i18n-ignore>${escapeHtml(data.user.bio ?? '未填写')}</span></div>
            <div class="me-row"><span>密码</span><span>${data.user.hasPassword ? '已设置' : '未设置'}</span></div>
          </div>
        </div>
        <div class="me-profile-actions">
          <button class="btn-primary" id="edit-profile">编辑资料</button>
          <button class="btn-ghost" id="change-password">修改密码</button>
          <a class="btn-ghost" href="#/promotion">佣金推广</a>
          <button class="btn-ghost" id="me-logout" title="退出后需重新验证邮箱登录">退出登录</button>
          ${(data.completion?.missing ?? []).length ? `<span class="me-sub me-completion">待完善：${escapeHtml(data.completion.missing.join('、'))}</span>` : ''}
        </div>
      </div>
      <div class="me-card" id="me-vip">
        <div class="me-card-title">会员权益</div>
        ${sub
          ? `<div class="me-big">会员中<small class="me-days">剩 ${subscriptionDays} 天</small></div>
             <div class="me-sub">有效期至 ${escapeHtml(sub.validTo)}${sub.scope === 'all' ? ' · 全站畅看' : ''}</div>`
          : '<div class="me-big">未开通</div><div class="me-sub">开通后可看全站剧集（含单片付费内容）</div>'}
        <button class="btn-primary" id="me-subscribe" style="margin-top:12px">${sub ? '续费' : '开通会员'}</button>
      </div>
      <div class="me-card">
        <div class="me-card-title">已购单片</div>
        ${data.purchases.length === 0 ? '<div class="me-sub">暂无</div>' : data.purchases.map((item) => `<div class="me-row"><a href="#/drama/${item.dramaId}">${escapeHtml(item.title)}</a><span>${item.kind === 'rental' ? '租赁至 ' + escapeHtml(item.expiresAt ?? '') : '永久'}</span></div>`).join('')}
      </div>
    </div>
    ${accountOrdersMarkup(orders)}
    <div class="section-head" id="me-message"><h2 class="section-title">消息</h2><div class="section-hint">权益与订单通知</div></div>
    <div class="me-grid">
      ${messages.length === 0 ? '<div class="me-card"><div class="me-sub">暂无消息</div></div>'
        : messages.slice(0, 4).map((message) => `<div class="me-card">
            <div class="me-card-title">${message.type === 'order' ? '订单' : '会员'}</div>
            <div style="font-size:14px" data-i18n-ignore>${escapeHtml(message.title)}</div>
            <div class="me-sub" data-i18n-ignore>${escapeHtml(message.body)}</div>
          </div>`).join('')}
    </div>`
  const meAnchor = { message: '#me-message', vip: '#me-vip' }[params.tab]
  if (meAnchor) setTimeout(() => document.querySelector(meAnchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150)
  $('#me-subscribe').addEventListener('click', async () => {    const { plans } = await api('/api/plans')
    openPaywall({ dramaId: 0, priceInfo: { plans } }, { title: '开通 / 续费会员' })
  })
  $('#edit-profile').addEventListener('click', () => openProfileEdit(data.user))
  view.querySelectorAll('[data-resume]').forEach((button) => {
    button.addEventListener('click', async () => {
      const no = button.dataset.resume
      try {
        const order = await api(`/api/orders/${encodeURIComponent(no)}`)
        if (order.status === 'paid' || order.status === 'fulfilled') { toast('该订单已完成支付'); return route() }
        if (order.status === 'closed') { toast('订单已关闭，请重新下单'); return }
        if (order.usdt?.address) {
          openModal('订单待支付', `订单 ${no} 待支付：请向 ${order.usdt.address} 转入 ${order.usdt.amount} USDT（${PAY.usdtNetwork}），到账后自动开通权益。`)
          return
        }
        // 收银台地址由服务端按渠道真实配置给出，前端不再猜页面
        if (!order.payUrl) { toast(order.payReason || '该订单当前无法继续支付，请重新下单'); return }
        const target = order.payUrl.startsWith('http') ? order.payUrl : BASE + order.payUrl
        window.open(target, '_blank', 'width=520,height=680')
        toast('已打开收银台，支付完成后刷新本页')
      } catch (error) { toast(error.message) }
    })
  })
  $('#change-password').addEventListener('click', () => openChangePassword(data.user))
  // 退出登录只在这里出现：顶栏点用户名是「进个人中心」，避免误触掉会话
  $('#me-logout').addEventListener('click', () => logout())
  $('#change-email').addEventListener('click', () => openChangeEmail(data.user))
  $('#avatar-file').addEventListener('change', async (event) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    if (file.size > 8 * 1024 * 1024) { toast('原始图片不能超过 8MB'); return }
    const label = input.closest('.avatar-upload')
    const labelText = $('#avatar-upload-text')
    input.disabled = true
    label?.classList.add('is-busy')
    if (labelText) labelText.textContent = '上传中…'
    try {
      const blob = await resizeAvatar(file)
      if (blob.size > 1024 * 1024) throw new Error('图片压缩后仍超过 1MB，请换一张')
      const result = await api('/api/me/avatar', { method: 'POST', body: blob, timeoutMs: 60_000 })
      state.user = result.user
      localStorage.setItem('mh-user', JSON.stringify(result.user))
      const avatar = $('#me-avatar')
      if (avatar?.tagName === 'IMG') {
        avatar.src = `${mediaUrl(result.user.avatar)}?v=${Date.now()}`
      } else if (avatar) {
        const img = document.createElement('img')
        img.id = 'me-avatar'
        img.className = 'avatar'
        img.alt = '头像'
        img.src = `${mediaUrl(result.user.avatar)}?v=${Date.now()}`
        avatar.replaceWith(img)
      }
      toast('头像已更新')
      await renderMe()
    } catch (error) {
      toast(error.message)
    } finally {
      input.disabled = false
      input.value = ''
      label?.classList.remove('is-busy')
      if (labelText) labelText.textContent = '更换头像'
    }
  })
}

/** 编辑资料：昵称 / 生日 / 性别 / 简介 */
function openProfileEdit(user) {
  const modal = $('#modal')
  modal.innerHTML = `
    <div class="modal-card" style="width:min(460px,94vw)">
      <h3>编辑资料</h3>
      <label class="field"><span>昵称</span><input id="pf-nickname" value="${escapeHtml(user.nickname ?? '')}" maxlength="20" /></label>
      <label class="field date-field"><span>生日</span><input id="pf-birthday" type="date" value="${escapeHtml(user.birthday ?? '')}" /></label>
      <label class="field"><span>性别</span>
        <select id="pf-gender">
          ${[['', '未填写'], ['male', '男'], ['female', '女'], ['other', '其他'], ['secret', '保密']]
            .map(([value, label]) => `<option value="${value}" ${user.gender === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>个人简介</span><textarea id="pf-bio" rows="3" maxlength="120">${escapeHtml(user.bio ?? '')}</textarea></label>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn-primary" id="pf-save" style="flex:1">保存</button>
        <button class="btn-ghost" id="pf-cancel">取消</button>
      </div>
      <div id="pf-msg" style="font-size:12px;color:#ff8a8a;min-height:16px;margin-top:8px"></div>
    </div>`
  const close = () => closeDialog(modal)
  $('#pf-cancel').addEventListener('click', close)
  $('#pf-save').addEventListener('click', async () => {
    try {
      const result = await api('/api/me/profile', {
        method: 'PUT',
        body: JSON.stringify({
          nickname: $('#pf-nickname').value.trim(),
          birthday: $('#pf-birthday').value,
          gender: $('#pf-gender').value,
          bio: $('#pf-bio').value.trim(),
        }),
      })
      state.user = result.user
      localStorage.setItem('mh-user', JSON.stringify(result.user))
      close()
      toast('资料已保存')
      await renderMe()
    } catch (error) { $('#pf-msg').textContent = error.message }
  })
  openDialog(modal, close)
}

/** 修改密码：向注册邮箱发码 → 校验 → 设置新密码（≥8 位且含字母+数字） */
function openChangePassword(user) {
  const modal = $('#modal')
  let timer
  modal.innerHTML = `
    <div class="modal-card" style="width:min(440px,94vw)">
      <h3>修改密码</h3>
      <p style="color:#9aa3b2;font-size:13px;margin:4px 0 10px">验证码将发送到注册邮箱 ${escapeHtml(user.email ?? '')}</p>
      <div style="display:flex;gap:8px">
        <input id="pw-code" aria-label="邮箱验证码" placeholder="6 位验证码" maxlength="6" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);color:var(--text)" />
        <button class="btn-ghost" id="pw-send">发送验证码</button>
      </div>
      <label class="field" style="margin-top:10px"><span>新密码（≥8 位，含字母和数字）</span><input id="pw-new" type="password" /></label>
      <label class="field" style="margin-top:8px"><span>确认新密码</span><input id="pw-confirm" type="password" /></label>
      <div id="pw-msg" style="font-size:12px;min-height:18px;margin-top:8px;color:#9aa3b2"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-primary" id="pw-save" style="flex:1">确认修改</button>
        <button class="btn-ghost" id="pw-cancel">取消</button>
      </div>
    </div>`
  const close = () => { clearInterval(timer); closeDialog(modal) }
  $('#pw-cancel').addEventListener('click', close)
  $('#pw-send').addEventListener('click', async () => {
    const button = $('#pw-send')
    button.disabled = true
    try {
      const result = await api('/api/auth/password/send', { method: 'POST', body: JSON.stringify({ email: user.email }) })
      $('#pw-msg').style.color = '#4ade80'
      $('#pw-msg').textContent = `验证码已发送至 ${user.email ?? '注册邮箱'}，5 分钟内有效`
      let countdown = result.resendAfter ?? 60
      button.textContent = `${countdown}s 后重发`
      timer = setInterval(() => {
        countdown -= 1
        if (countdown <= 0) {
          clearInterval(timer)
          button.disabled = false
          button.textContent = '发送验证码'
          return
        }
        button.textContent = `${countdown}s 后重发`
      }, 1000)
    } catch (error) {
      button.disabled = false
      $('#pw-msg').style.color = '#ff8a8a'
      $('#pw-msg').textContent = error.message
    }
  })
  $('#pw-save').addEventListener('click', async () => {
    const code = $('#pw-code').value.trim()
    const password = $('#pw-new').value
    if (password !== $('#pw-confirm').value) { $('#pw-msg').textContent = '两次输入的密码不一致'; return }
    try {
      const result = await api('/api/auth/password/change', {
        method: 'POST',
        body: JSON.stringify({ email: user.email, code, newPassword: password }),
      })
      if (result?.token) {
        state.token = result.token
        localStorage.setItem('mh-token', result.token)
      }
      clearInterval(timer)
      close()
      toast('密码已更新，其他设备需重新登录')
    } catch (error) {
      $('#pw-msg').style.color = '#ff8a8a'
      $('#pw-msg').textContent = error.message
    }
  })
  openDialog(modal, close)
}

/** 更换邮箱：向新邮箱发码 → 校验 → 更新绑定 */
function openChangeEmail(user) {
  const modal = $('#modal')
  let timer
  modal.innerHTML = `
    <div class="modal-card" style="width:min(440px,94vw)">
      <h3>更换邮箱</h3>
      <p style="color:#9aa3b2;font-size:13px;margin:4px 0 10px">当前邮箱：${escapeHtml(user.email ?? '未绑定')}</p>
      <label class="field"><span>新邮箱</span><input id="ce-email" type="email" placeholder="new@example.com" /></label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input id="ce-code" aria-label="新邮箱验证码" placeholder="6 位验证码" maxlength="6" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);color:var(--text)" />
        <button class="btn-ghost" id="ce-send">发送验证码</button>
      </div>
      <div id="ce-msg" style="font-size:12px;min-height:18px;margin-top:8px;color:#9aa3b2"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-primary" id="ce-save" style="flex:1">确认更换</button>
        <button class="btn-ghost" id="ce-cancel">取消</button>
      </div>
    </div>`
  const close = () => { clearInterval(timer); closeDialog(modal) }
  $('#ce-cancel').addEventListener('click', close)
  $('#ce-send').addEventListener('click', async () => {
    const email = $('#ce-email').value.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('#ce-msg').textContent = '邮箱格式不正确'; return }
    try {
      const result = await api('/api/auth/email/send-change', { method: 'POST', body: JSON.stringify({ newEmail: email }) })
      $('#ce-msg').style.color = '#4ade80'
      $('#ce-msg').textContent = `验证码已发送至 ${email}，5 分钟内有效`
      const button = $('#ce-send')
      button.disabled = true
      let countdown = result.resendAfter ?? 60
      button.textContent = `${countdown}s 后重发`
      timer = setInterval(() => {
        countdown -= 1
        if (countdown <= 0) {
          clearInterval(timer)
          button.disabled = false
          button.textContent = '发送验证码'
          return
        }
        button.textContent = `${countdown}s 后重发`
      }, 1000)
    } catch (error) {
      $('#ce-msg').style.color = '#ff8a8a'
      $('#ce-msg').textContent = error.message
    }
  })
  $('#ce-save').addEventListener('click', async () => {
    try {
      const result = await api('/api/auth/email/change', {
        method: 'POST',
        body: JSON.stringify({ newEmail: $('#ce-email').value.trim(), code: $('#ce-code').value.trim() }),
      })
      state.user = result.user
      localStorage.setItem('mh-user', JSON.stringify(result.user))
      if (result.token) {
        state.token = result.token
        localStorage.setItem('mh-token', result.token)
      }
      clearInterval(timer)
      close()
      toast('邮箱已更换')
      await renderMe()
    } catch (error) { $('#ce-msg').textContent = error.message }
  })
  openDialog(modal, close)
}

function loginWall() {
  document.title = '登录 · 影巢'
  view.innerHTML = `
    <h1 class="sr-only">登录影巢</h1>
    <div class="empty" style="margin-top:80px">
      <div style="font-size:18px;margin-bottom:10px">登录后即可播放与查看个人中心</div>
      <div style="color:#9aa3b2;font-size:13px;margin-bottom:18px">首页、分类、榜单、搜索与剧集详情均可直接浏览；播放与购买需要账号。</div>
      <button class="btn-primary" id="wall-login">登录 / 注册</button>
      <a class="btn-ghost" href="#/home" style="margin-left:8px">返回首页</a>
    </div>`
  $('#wall-login').addEventListener('click', openLogin)
}

function setRouteBusy(busy) {
  view.setAttribute('aria-busy', busy ? 'true' : 'false')
  const existing = $('#route-loading')
  if (busy) {
    if (existing) return
    const bar = document.createElement('div')
    bar.id = 'route-loading'
    bar.className = 'route-loading'
    bar.setAttribute('aria-hidden', 'true')
    document.body.appendChild(bar)
    return
  }
  existing?.remove()
}

async function renderLanding() {
  const copy = getLang() === 'en' ? {
    brand: 'Yingchao', login: 'Log in / Sign up', eyebrow: 'Membership streaming · Rentals available',
    watch: 'Watch now', vip: 'View membership', pay: 'Alipay / USDT',
    member: 'Membership covers series · Rentals sold separately', support: 'Support',
    why: 'Why Yingchao', whySub: 'One membership for series; premium titles can also be purchased separately.',
    feature1: 'Curated library', feature1Body: 'Films, series, short dramas and animation, updated by theme.',
    feature2: 'Watch anywhere', feature2Body: 'Phone, tablet and desktop browsers, with progress saved.',
    feature3: 'Flexible payment', feature3Body: 'Membership covers series; titles marked as rentals are purchased separately.',
    picks: 'Featured now', picksSub: 'Start with something you like.',
    plans: 'Membership plans', plansSub: 'Final price is shown at checkout. Alipay and USDT supported.',
    days: 'days', openVip: 'Open membership', faq: 'FAQ',
    q1: 'Does membership include everything?', a1: 'Membership covers series; titles marked as rentals require a separate purchase.',
    q2: 'Can I preview first?', a2: 'Titles with previews show them in the player according to the content policy.',
    q3: 'How do I request a refund or contact support?', a3: 'Start a refund from the order page for review; support email:',
    pending: 'Not configured', myAccount: 'My account',
  } : {
    brand: '影巢', login: '登录 / 注册', eyebrow: '会员畅看 · 单片可选',
    watch: '立即观看', vip: '查看会员', pay: '支付宝 / USDT',
    member: '会员覆盖剧集 · 单片单独购买', support: '客服',
    why: '为什么选择影巢', whySub: '一次开通，剧集持续看；高价值内容也可单独购买。',
    feature1: '精选片库', feature1Body: '电影、剧集、短剧与动漫，按主题持续更新。',
    feature2: '多端观看', feature2Body: '手机、平板和桌面浏览器均可播放，进度自动保存。',
    feature3: '灵活付费', feature3Body: '会员覆盖剧集；标注单片的內容可单独购买或租用。',
    picks: '本期精选', picksSub: '先从一部感兴趣的开始。',
    plans: '会员套餐', plansSub: '价格以收银台为准，支持支付宝与 USDT。',
    days: '天', openVip: '开通会员', faq: '常见问题',
    q1: '会员能看所有内容吗？', a1: '会员覆盖剧集；标注为单片的內容需要单独购买或租用。',
    q2: '可以先试看吗？', a2: '支持试看的內容会在播放器按策略提供；具体以详情页和付费墙为准。',
    q3: '如何退款或联系客服？', a3: '可在订单页发起退款，按退款规则审核；客服邮箱：',
    pending: '待配置', myAccount: '我的账号',
  }
  const [home, planData] = await Promise.all([
    api('/api/home'),
    api('/api/plans').catch(() => ({ plans: [] })),
  ])
  const sections = (home.sections ?? []).filter((section) => (section.items ?? []).length > 0)
  const items = []
  for (const section of sections) {
    for (const item of section.items ?? []) {
      if (!items.some((existing) => String(existing.dramaId) === String(item.dramaId))) items.push(item)
    }
  }
  const requestedDramaId = Number(new URLSearchParams(location.search).get('dramaId') || 0)
  const requested = requestedDramaId ? items.find((item) => Number(item.dramaId) === requestedDramaId) : null
  const banner = requested ? null : ((home.banners ?? []).find((item) => item.targetDramaId) ?? null)
  const featured = requested ?? items[0] ?? null
  const dramaId = banner?.targetDramaId ?? featured?.dramaId ?? null
  const title = banner?.name || featured?.title || copy.brand
  const description = banner?.description || featured?.description || featured?.subTitle || ''
  const image = banner?.image || featured?.backdropUrl || featured?.coverUrl || ''
  const meta = [
    banner?.score ?? featured?.score,
    banner?.year ?? featured?.year,
    banner?.categoryLabel ?? featured?.categoryLabel ?? categoryLabel(featured?.dramaType),
    banner?.areaLabel ?? featured?.areaLabel,
  ].filter(Boolean)
  const plans = (planData.plans ?? []).slice(0, 3)
  const support = state.constants.supportEmail || ''
  const watchHref = dramaId ? `#/drama/${encodeURIComponent(dramaId)}` : '#/home'
  const vipHref = '#/me?tab=vip'
  const contentCards = items.slice(0, 8)
  const campaign = new URLSearchParams(location.search).get('utm_campaign') || ''

  view.innerHTML = `
    <div class="landing">
      <header class="landing-header">
        <a class="landing-logo" href="#/home"><img src="${escapeHtml(mediaUrl('/icons/icon-64x64.png'))}" alt="" width="28" height="28" />${escapeHtml(copy.brand)}</a>
        <div class="landing-header-actions">
          <button class="btn-ghost" type="button" id="lp-lang">${getLang() === 'en' ? '中文' : 'EN'}</button>
          ${state.user
            ? `<a class="btn-ghost" href="#/me">${escapeHtml(state.user.nickname ?? copy.myAccount)}</a>`
            : `<button class="btn-primary" type="button" id="lp-login">${escapeHtml(copy.login)}</button>`}
        </div>
      </header>
      <section class="landing-hero" aria-labelledby="lp-title">
        <div class="landing-hero-media"${image ? '' : ' data-empty'}>
          ${image ? `<img src="${escapeHtml(mediaUrl(image))}" alt="${escapeHtml(title)}" fetchpriority="high" decoding="async" />` : ''}
        </div>
        <div class="landing-hero-body">
          <span class="landing-eyebrow">${escapeHtml(copy.eyebrow)}</span>
          <h1 class="landing-title" id="lp-title">${escapeHtml(title)}</h1>
          ${description ? `<p class="landing-sub">${escapeHtml(description)}</p>` : ''}
          ${meta.length ? `<div class="landing-meta">${meta.map((item) => `<span>${escapeHtml(String(item))}</span>`).join('')}</div>` : ''}
          <div class="landing-actions">
            <a class="btn-primary" href="${watchHref}" data-lp-cta="watch" data-drama-id="${dramaId ?? ''}">${icon('play', 16)}${escapeHtml(copy.watch)}</a>
            <a class="btn-ghost" href="${vipHref}" data-lp-cta="vip">${escapeHtml(copy.vip)}</a>
          </div>
          <div class="landing-proof">
            <span>${escapeHtml(copy.pay)}</span>
            <span>${escapeHtml(copy.member)}</span>
            ${support ? `<span>${escapeHtml(copy.support)}：${escapeHtml(support)}</span>` : ''}
          </div>
        </div>
      </section>
      <section class="landing-section" aria-labelledby="lp-why">
        <div class="landing-section-head"><div><h2 id="lp-why">${escapeHtml(copy.why)}</h2><p>${escapeHtml(copy.whySub)}</p></div></div>
        <div class="landing-features">
          <article class="landing-feature"><strong>${escapeHtml(copy.feature1)}</strong><span>${escapeHtml(copy.feature1Body)}</span></article>
          <article class="landing-feature"><strong>${escapeHtml(copy.feature2)}</strong><span>${escapeHtml(copy.feature2Body)}</span></article>
          <article class="landing-feature"><strong>${escapeHtml(copy.feature3)}</strong><span>${escapeHtml(copy.feature3Body)}</span></article>
        </div>
      </section>
      ${contentCards.length ? `<section class="landing-section" aria-labelledby="lp-picks">
        <div class="landing-section-head"><div><h2 id="lp-picks">${escapeHtml(copy.picks)}</h2><p>${escapeHtml(copy.picksSub)}</p></div></div>
        <div class="landing-content-grid">${contentCards.map((item) => posterCard(item, { badge: false, score: true })).join('')}</div>
      </section>` : ''}
      ${plans.length ? `<section class="landing-section" id="lp-vip" aria-labelledby="lp-plans">
        <div class="landing-section-head"><div><h2 id="lp-plans">${escapeHtml(copy.plans)}</h2><p>${escapeHtml(copy.plansSub)}</p></div></div>
        <div class="landing-plans">
          ${plans.map((plan, index) => `<article class="landing-plan${index === 1 ? ' is-featured' : ''}">
            <strong>${escapeHtml(plan.name)}</strong>
            <div class="landing-plan-price">¥${escapeHtml(String(plan.price))}<small> / ${escapeHtml(String(plan.days))} ${escapeHtml(copy.days)}</small></div>
            <p>${escapeHtml(plan.description ?? '')}</p>
            <a class="btn-primary" href="${vipHref}" data-lp-cta="vip-plan">${escapeHtml(copy.openVip)}</a>
          </article>`).join('')}
        </div>
      </section>` : ''}
      <section class="landing-section" aria-labelledby="lp-faq">
        <div class="landing-section-head"><div><h2 id="lp-faq">${escapeHtml(copy.faq)}</h2></div></div>
        <div class="landing-faq">
          <details><summary>${escapeHtml(copy.q1)}</summary><p>${escapeHtml(copy.a1)}</p></details>
          <details><summary>${escapeHtml(copy.q2)}</summary><p>${escapeHtml(copy.a2)}</p></details>
          <details><summary>${escapeHtml(copy.q3)}</summary><p>${escapeHtml(copy.a3)}${escapeHtml(support || copy.pending)}</p></details>
        </div>
      </section>
      <footer class="landing-footer"><span>© 2026 ${escapeHtml(copy.brand)}</span>${support ? ` · <span>${escapeHtml(support)}</span>` : ''}</footer>
    </div>`
  document.title = `${title} · ${copy.brand}`
  $('#lp-login')?.addEventListener('click', openLogin)
  $('#lp-lang')?.addEventListener('click', () => switchLanguage(getLang() === 'en' ? 'zh' : 'en'))
  view.querySelectorAll('[data-lp-cta]').forEach((node) => node.addEventListener('click', () => {
    track('lp_cta_click', { dramaId: Number(node.dataset.dramaId) || undefined, meta: { target: node.dataset.lpCta } })
  }))
  view.querySelectorAll('.card[data-drama-id]').forEach((node) => node.addEventListener('click', () => trackContentClick(node.dataset.dramaId)))
  track('lp_view', { path: location.hash || '#/lp', meta: { campaign } })
  observeImpressions()
}

async function route() {
  const seq = ++routeSeq
  routeController?.abort()
  const controller = new AbortController()
  routeController = controller
  apiSignal = controller.signal
  cleanupRoute()
  renderChrome()
  setRouteBusy(true)
  const hash = location.hash || '#/home'
  track('page_view', { path: hash })
  const [pathPart, queryPart] = hash.slice(1).split('?')
  const params = new URLSearchParams(queryPart ?? '')
  const segments = pathPart.split('/').filter(Boolean)
  document.documentElement.classList.toggle('landing-mode', segments[0] === 'lp')
  // 浏览类页面（首页/分类/榜单/搜索/详情）对未登录开放：分享出去的链接必须能直接看，
  // 否则传播链在登录墙上归零。播放与个人中心仍需登录。
  const guestTrial = segments[0] === 'play' && params.get('trial') === '1'
  const needsLogin = (segments[0] === 'play' && !guestTrial) || segments[0] === 'me'
    || segments[0] === 'history' || segments[0] === 'favorites'
    || segments[0] === 'promotion' || segments[0] === 'distribution'
  if (!state.token && needsLogin) {
    loginWall()
    setRouteBusy(false)
    apiSignal = null
    return
  }
  try {
    if (segments[0] === 'adult') {
      if (!state.constants?.adultMenu?.enabled) {
        history.replaceState(null, '', '#/home')
        await renderHome()
      } else {
        if (!hasAdultConsent()) {
          const allowed = await promptAdultAge()
          if (seq !== routeSeq) return
          if (!allowed) {
            history.replaceState(null, '', '#/home')
            await renderHome()
            return
          }
        }
        await renderCategory(params.get('channel') ?? 'ALL', params, 'adult')
      }
    }
    else if (segments[0] === 'home' || segments.length === 0) await renderHome()
    else if (segments[0] === 'lp') await renderLanding()
    else if (segments[0] === 'category') await renderCategory(segments[1] ?? 'ALL', params)
    else if (segments[0] === 'rank') await renderRank(params)
    else if (segments[0] === 'content-rank') await renderContentRank(params)
    else if (segments[0] === 'search') await renderSearch(params)
    else if (segments[0] === 'drama') await renderDrama(segments[1])
    else if (segments[0] === 'play') await renderPlay(segments[1], segments[2] ?? '1', params)
    else if (segments[0] === 'playlists') await renderPlaylists()
    else if (segments[0] === 'posters') {
      const { renderPosterWall } = await import('./poster-wall-view.js?v=20261111fix8')
      await renderPosterWall(view, api)
    }
    else if (segments[0] === 'me') await renderMe(params)
    else if (segments[0] === 'history') await renderHistory()
    else if (segments[0] === 'favorites') await renderFavorites()
    else if (segments[0] === 'promotion') await renderPromotion()
    else if (segments[0] === 'distribution') {
      history.replaceState(null, '', '#/promotion')
      await renderPromotion()
    }
    else await renderHome()
  } catch (error) {
    if (error?.name === 'AbortError' || seq !== routeSeq) return
    if (error.code === '0401') {
      loginWall()
      return
    }
    view.innerHTML = `<h1 class="sr-only">加载失败</h1><div class="empty">加载失败：${escapeHtml(error.message)}<br/><br/>
      <button class="btn-primary" id="route-retry">重试</button>
      <a class="btn-ghost" href="#/home" style="margin-left:8px">返回首页</a></div>`
    $('#route-retry').addEventListener('click', () => route())
  } finally {
    if (seq === routeSeq) {
      apiSignal = null
      setRouteBusy(false)
    }
  }
  if (seq === routeSeq) {
    if (preserveScrollOnNextRoute) {
      const scroll = preserveScrollOnNextRoute
      preserveScrollOnNextRoute = null
      const root = document.documentElement
      const previousAnchor = root.style.overflowAnchor
      const restore = () => window.scrollTo(scroll.x, scroll.y)
      root.style.overflowAnchor = 'none'
      restore()
      requestAnimationFrame(() => {
        restore()
        requestAnimationFrame(restore)
      })
      setTimeout(() => {
        restore()
        setTimeout(() => {
          restore()
          root.style.overflowAnchor = previousAnchor
        }, 80)
      }, 60)
    } else {
      window.scrollTo(0, 0)
    }
    observeImpressions()
  }
}

window.addEventListener('hashchange', () => {
  // 路由切换时关闭可能残留的弹窗/付费墙，避免遮挡新页面
  const modal = $('#modal')
  if (modal && !modal.classList.contains('hidden')) modal._dialogClose?.()
  route()
})
initI18n()
initAttribution()
track('session_start', { path: location.hash || '#/home' })
try {
  state.constants = await api('/api/constants')
  if (state.constants?.pay) Object.assign(PAY, state.constants.pay, { ready: true })
} catch (error) {
  // 常量决定支付渠道/皮肤/文案，静默成 {} 会让收银台空转，必须让用户看到
  state.constants = {}
  PAY.ready = false
  console.error('[constants]', error)
  toast('站点配置加载失败，支付等功能可能不可用，请刷新重试')
}
await route()
