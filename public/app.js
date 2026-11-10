/** 影巢复刻站前端：hash 路由 + 原生模板渲染，零构建。 */
const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)

/** hls.js 加载器：优先本站 `/vendor/hls.mjs`（无第三方依赖），失败再退回 CDN，最后交给原生 HLS。 */
let hlsPromise
function loadHls() {
  if (!hlsPromise) {
    hlsPromise = import(`${BASE}/vendor/hls.mjs`)
      .then((mod) => mod.default ?? mod.Hls)
      .catch(() => import('https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.mjs')
        .then((mod) => mod.default ?? mod.Hls)
        .catch(() => null))
  }
  return hlsPromise
}
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const sidebar = $('#sidebar')
const topbar = $('#topbar')

const NAV_MAIN = [
  ['精选', '#/home'],
  ['电影', '#/category/MOVIE'],
  ['电视剧', '#/category/TV'],
  ['短剧', '#/category/PLAYLET'],
  ['综艺', '#/category/VARIETY'],
]
const NAV_RANK = [
  ['热播榜', '#/rank?type=HOT'],
  ['飙升榜', '#/rank?type=RISE'],
  ['经典榜', '#/rank?type=CLASSIC'],
  ['热搜榜', '#/rank?type=SEARCH'],
]

const state = {
  constants: {},
  me: { history: [], favorites: [] },
  vipDismissed: false,
  token: localStorage.getItem('mh-token') ?? '',
  user: JSON.parse(localStorage.getItem('mh-user') ?? 'null'),
}
// 未登录点「免费看第 1 集」时记下目标，登录成功后直接跳过去，不让用户再点一次
let pendingRoute = ''

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(BASE + path, { ...options, headers })
  const json = await res.json()
  if (json.code === '0401') {
    const error = new Error(json.msg || '需要登录')
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
  return route()
}

async function login(email, code) {
  const data = await api('/api/auth/email/login', { method: 'POST', body: JSON.stringify({ email, code }) })
  await applySession(data, data.created ? '注册成功，已自动登录' : '登录成功')
}

async function loginWithPassword(email, password) {
  const data = await api('/api/auth/email/password', { method: 'POST', body: JSON.stringify({ email, password }) })
  await applySession(data, '登录成功')
}

function logout() {
  state.token = ''
  state.user = undefined
  localStorage.removeItem('mh-token')
  localStorage.removeItem('mh-user')
  toast('已退出登录')
  renderChrome()
  route()
}

/** 登录 / 注册：验证码（默认）与密码两种方式 */
function openLogin() {
  const modal = $('#modal')
  modal.classList.remove('hidden')
  let countdown = 0
  let timer
  let mode = 'code'

  modal.innerHTML = `
    <div class="modal-card" style="width:min(420px,94vw)">
      <h3>登录 / 注册</h3>
      <div class="seg" id="login-tabs" style="margin:10px 0 14px">
        <button class="seg-item active" data-mode="code">验证码登录</button>
        <button class="seg-item" data-mode="password">密码登录</button>
      </div>
      <label class="field"><span>邮箱</span>
        <input id="login-email" type="email" placeholder="you@example.com" autocomplete="email" />
      </label>
      <div id="code-block">
        <div style="display:flex;gap:8px;margin-top:10px">
          <input id="login-code" placeholder="6 位验证码" maxlength="6" inputmode="numeric" class="input" style="flex:1" />
          <button class="btn-ghost" id="send-code">获取验证码</button>
        </div>
      </div>
      <div id="password-block" class="hidden">
        <label class="field" style="margin-top:10px"><span>密码</span>
          <input id="login-password" type="password" placeholder="账号密码" autocomplete="current-password" />
        </label>
      </div>
      <div id="login-hint" style="font-size:12px;color:#9aa3b2;min-height:18px;margin-top:8px"></div>
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn-primary" id="login-submit" style="flex:1">登录 / 注册</button>
        <button class="btn-ghost" id="login-cancel">取消</button>
      </div>
      <p style="color:#7d8695;font-size:12px;margin-top:12px">未注册的邮箱会自动创建账号；密码可在「个人中心」设置。</p>
    </div>`

  const close = () => { clearInterval(timer); modal.classList.add('hidden') }
  const hint = (text, color = '#9aa3b2') => {
    const node = $('#login-hint')
    node.textContent = text
    node.style.color = color
  }

  $('#login-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mode]')
    if (!button) return
    mode = button.dataset.mode
    modal.querySelectorAll('#login-tabs .seg-item').forEach((item) => item.classList.toggle('active', item.dataset.mode === mode))
    $('#code-block').classList.toggle('hidden', mode !== 'code')
    $('#password-block').classList.toggle('hidden', mode !== 'password')
    $('#login-submit').textContent = mode === 'code' ? '登录 / 注册' : '登录'
    hint('')
  })

  $('#send-code').addEventListener('click', async () => {
    const email = $('#login-email').value.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return hint('请输入正确的邮箱地址', '#ff8a8a')
    const button = $('#send-code')
    button.disabled = true
    try {
      const result = await api('/api/auth/email/send', { method: 'POST', body: JSON.stringify({ email }) })
      hint(`验证码已发送至 ${email}，5 分钟内有效`, '#4ade80')
      countdown = result.resendAfter ?? 60
      button.textContent = `${countdown}s 后重发`
      timer = setInterval(() => {
        countdown -= 1
        if (countdown <= 0) {
          clearInterval(timer)
          button.disabled = false
          button.textContent = '获取验证码'
          return
        }
        button.textContent = `${countdown}s 后重发`
      }, 1000)
    } catch (error) {
      button.disabled = false
      // 邮件通道没配好时不能只甩一句报错：给出客服出路 + 切到密码登录
      if (error.code === 'mail_not_configured' || error.code === 'mail_failed') {
        const support = state.constants.supportEmail
        hint(`${error.message}${support ? `（客服邮箱：${support}）` : ''}`, '#ff8a8a')
        $('#login-tabs').querySelector('[data-mode="password"]')?.click()
      } else {
        hint(error.message, '#ff8a8a')
      }
    }
  })

  $('#login-submit').addEventListener('click', async () => {
    const email = $('#login-email').value.trim()
    if (!email) return hint('请输入邮箱', '#ff8a8a')
    try {
      if (mode === 'password') {
        const password = $('#login-password').value
        if (!password) return hint('请输入密码', '#ff8a8a')
        await loginWithPassword(email, password)
      } else {
        const code = $('#login-code').value.trim()
        if (!/^\d{6}$/.test(code)) return hint('请输入 6 位数字验证码', '#ff8a8a')
        await login(email, code)
      }
      close()
    } catch (error) {
      hint(error.message, '#ff8a8a')
    }
  })

  $('#login-code').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#login-submit').click() })
  $('#login-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') $('#login-submit').click() })
  $('#login-cancel').addEventListener('click', close)
  modal.addEventListener('click', (event) => { if (event.target === modal) close() }, { once: true })
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

const ACCESS_LABEL = { free: '免费', subscription: '会员', subscribed: '已开通', paid: '单片', owned: '已购' }
const ORDER_STATUS = {
  created: '待支付', pending: '支付确认中', paid: '已支付', fulfilled: '已完成',
  closed: '已关闭', refunded: '已退款', refunding: '退款中', refund_pending: '退款待审', failed: '支付失败',
}
/**
 * 支付渠道完全由服务端 /api/constants 决定（后台启停哪个就是哪个）。
 * 前端不再内置 mock 默认值——否则后台关掉模拟支付后收银台仍然显示"模拟支付"，制造假单。
 */
const PAY = { channels: [], defaultChannel: null, usdtNetwork: 'TRC20', ready: false }
const CHANNEL_LABEL = { mock: '模拟支付（演示）', alipay: '支付宝', usdt: 'USDT（TRC20）', wechat: '微信支付' }
const channelList = () => (PAY.channels ?? []).map((channel) => {
  const code = channel.code ?? channel.channelCode
  return { code, label: CHANNEL_LABEL[code] ?? channel.name ?? code }
})
const defaultChannel = () => PAY.defaultChannel ?? channelList()[0]?.code ?? null
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

async function waitOrderPaid(outTradeNo, onTick) {
  // 订单有效期 15 分钟；2s 起轮询、逐步退避到 15s，避免把限流打满
  const deadline = Date.now() + 15 * 60 * 1000
  let delay = 2000
  while (Date.now() < deadline) {
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
  const modal = $('#modal')
  const plans = options.plans ?? detail?.priceInfo?.plans ?? []
  const singlePrice = Number(options.price ?? detail?.singlePrice ?? 0)
  const canSingle = (options.reason === 'single_purchase_required') || detail?.accessMode === 'paid'
  modal.classList.remove('hidden')
  modal.innerHTML = `
    <div class="modal-card paywall">
      <h3>${escapeHtml(options.title ?? (canSingle ? '该片需单独购买' : '开通会员后可观看'))}</h3>
      <p class="paywall-sub">${canSingle ? '本片为单独付费内容，会员也可观看全部剧集' : '会员可看全站剧集（不含单独付费影片）'}</p>
      <div class="plan-list">
        ${plans.map((plan) => `<button class="plan-item" data-plan="${plan.id}">
          <span class="plan-name">${escapeHtml(plan.name)}</span>
          <span class="plan-price">¥${Number(plan.price).toFixed(0)}</span>
          <span class="plan-days">${plan.days} 天</span>
        </button>`).join('')}
      </div>
      ${canSingle ? `<button class="plan-item single" data-single="1">
        <span class="plan-name">购买本片（${detail?.purchaseKind === 'rental' ? '限时租赁' : '永久解锁'}）</span>
        <span class="plan-price">¥${singlePrice.toFixed(0)}</span>
      </button>` : ''}
      <div class="paywall-coupon">
        <input id="coupon-input" placeholder="优惠券码（可选，如 WELCOME10）" />
        <button class="btn-ghost" id="coupon-apply">校验</button>
      </div>
      <div class="paywall-channels" id="pay-channels"></div>
      <div class="paywall-foot">
        <span id="paywall-msg"></span>
        <button class="btn-ghost" id="paywall-close">稍后再说</button>
      </div>
    </div>`
  const close = () => modal.classList.add('hidden')
  $('#paywall-close').addEventListener('click', close)
  modal.addEventListener('click', (event) => { if (event.target === modal) close() }, { once: true })

  let couponCode = ''
  $('#coupon-apply').addEventListener('click', async () => {
    const code = $('#coupon-input').value.trim()
    if (!code) return
    const base = singlePrice || plans[0]?.price || 0
    const result = await api('/api/coupons/validate', { method: 'POST', body: JSON.stringify({ code, amount: base }) })
    $('#paywall-msg').textContent = result.ok ? `优惠券可用，立减 ¥${result.discount.toFixed(2)}` : (result.message ?? '不可用')
    if (result.ok) couponCode = code
  })

  const channels = channelList()
  $('#pay-channels').innerHTML = channels.length
    ? channels.map((channel) => `<button class="channel" data-channel="${escapeHtml(channel.code)}">${escapeHtml(channel.label)}</button>`).join('')
    : '<div class="paywall-sub" style="color:#ff8a8a">当前暂无可用支付渠道，请联系客服开通</div>'

  const go = async (channel, payload) => {
    if (!state.token) { close(); openLogin(); return }
    if (!channel) { $('#paywall-msg').textContent = '暂无可用支付渠道'; return }
    $('#paywall-msg').textContent = '正在创建订单…'
    // 弹窗必须在 await 之前打开，否则 iOS Safari / 微信内会被拦截
    const popup = channel === 'usdt' ? null : window.open('', '_blank', 'width=520,height=680')
    try {
      const order = await createOrder({ ...payload, channel, couponCode })
      $('#paywall-msg').textContent = `订单 ${order.outTradeNo} 已创建，金额 ¥${order.amount.toFixed(2)}`
      if (order.payUrl) {
        const target = order.payUrl.startsWith('http') ? order.payUrl : BASE + order.payUrl
        if (popup) popup.location.href = target
        else window.open(target, '_blank', 'width=520,height=680')
      }
      if (order.simulated) $('#paywall-msg').textContent = '已打开支付宝（沙箱）收银台，付款后自动到账'
      if (order.usdt) {
        $('#paywall-msg').innerHTML = `请向 <b>${escapeHtml(order.usdt.address)}</b> 转入 <b>${order.usdt.amount} USDT</b>（${order.usdt.network}），15 分钟内有效`
      }
      const done = await waitOrderPaid(order.outTradeNo, (tick) => {
        $('#paywall-msg').textContent = `等待支付… ${ORDER_STATUS[tick.status] ?? tick.status}（到账后自动更新，无需刷新）`
      })
      if (done && (done.status === 'fulfilled' || done.status === 'paid')) {
        toast('支付成功，权益已到账')
        close()
        renderChrome()
        route()
      } else if (done && (done.status === 'closed' || done.status === 'refunded')) {
        $('#paywall-msg').textContent = `订单${ORDER_STATUS[done.status]}，可在「我的」页继续支付或重新下单`
      } else {
        $('#paywall-msg').textContent = '仍在等待到账（USDT 需 19 个区块确认，通常 1–3 分钟）。可关闭此窗，到账后自动开通，也可在「我的」页继续支付'
      }
    } catch (error) {
      if (popup) popup.close()
      $('#paywall-msg').textContent = error.message
    }
  }

  modal.querySelectorAll('[data-plan]').forEach((button) => {
    button.addEventListener('click', () => go(defaultChannel(), { productType: 'subscription', planId: Number(button.dataset.plan) }))
  })
  const singleButton = modal.querySelector('[data-single]')
  if (singleButton) singleButton.addEventListener('click', () => go(defaultChannel(), { productType: 'single', dramaId: detail?.dramaId }))
  modal.querySelectorAll('[data-channel]').forEach((button) => {
    button.addEventListener('click', () => {
      const payload = canSingle
        ? { productType: 'single', dramaId: detail?.dramaId }
        : { productType: 'subscription', planId: plans[0]?.id }
      go(button.dataset.channel, payload)
    })
  })
}

const fmtDuration = (seconds) => {
  if (!seconds) return ''
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function toast(text) {
  const node = $('#toast')
  node.textContent = text
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), 1800)
}

function posterCard(item, options = {}) {
  const badge = badgeOf(item)
  const rank = options.rank ? `<span class="rank-no">${options.rank}</span>` : ''
  return `
    <div class="card">
      <a class="poster" href="#/drama/${escapeHtml(item.dramaId)}" title="${escapeHtml(item.title)}">
        ${badge}${rank}
        <img loading="lazy" src="${escapeHtml(mediaUrl(item.coverUrl))}" alt="${escapeHtml(item.title)}" onerror="this.style.display='none';this.parentNode.classList.add('noimg')" />
        <span class="play-hint">▶</span>
      </a>
      <div class="card-title">${escapeHtml(item.title)}</div>
      <div class="card-sub">${escapeHtml(item.subTitle || (item.labels ?? []).slice(0, 2).join(' · '))}</div>
    </div>`
}

function renderChrome() {
  const hash = location.hash || '#/home'
  sidebar.innerHTML = `
    <div class="nav-group">
      <div class="nav-title">频道</div>
      ${NAV_MAIN.map(([label, href]) => `<a class="nav-item ${hash.startsWith(href.split('?')[0]) ? 'active' : ''}" href="${href}">${label}</a>`).join('')}
    </div>
    <div class="nav-group">
      <div class="nav-title">榜单</div>
      ${NAV_RANK.map(([label, href]) => `<a class="nav-item ${hash.includes('rank') ? 'active' : ''}" href="${href}">${label}</a>`).join('')}
    </div>
    <div class="nav-group">
      <div class="nav-title">我的</div>
      <a class="nav-item" href="#/me">历史 / 收藏</a>
    </div>`

  topbar.innerHTML = `
    <a class="logo" href="#/home"><span class="logo-mark">影</span>影巢</a>
    <form class="search" id="search-form">
      <span>🔍</span>
      <input id="search-input" placeholder="搜索剧名、演员、导演" autocomplete="off" />
    </form>
    <div class="top-actions">
      <a class="top-action" href="#/me"><span class="ico">🕘</span>历史</a>
      <a class="top-action" href="#/me"><span class="ico">⭐</span>收藏</a>
      <a class="top-action" href="#/me"><span class="ico">✉️</span>消息</a>
      <a class="top-action" href="#/me"><span class="ico">💎</span>会员</a>
      <button class="btn-login" id="login-btn">${state.user ? escapeHtml(state.user.nickname ?? '我的账号') : '登录'}</button>
    </div>`
  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const keyword = $('#search-input').value.trim()
    location.hash = `#/search?q=${encodeURIComponent(keyword)}`
  })
  $('#login-btn').addEventListener('click', () => { state.token ? logout() : openLogin() })
}

function openModal(title, body) {
  const modal = $('#modal')
  modal.classList.remove('hidden')
  modal.innerHTML = `<div class="modal-card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>
    <button class="btn-primary" id="modal-close" style="margin-top:18px">知道了</button></div>`
  $('#modal-close').addEventListener('click', () => modal.classList.add('hidden'))
  modal.addEventListener('click', (event) => { if (event.target === modal) modal.classList.add('hidden') }, { once: true })
}

function vipFloat() {
  if (state.vipDismissed || document.querySelector('.vip-float')) return
  const node = document.createElement('div')
  node.className = 'vip-float'
  node.innerHTML = `
    <button class="vip-close" aria-label="关闭">×</button>
    <h4>开通会员 全场畅看</h4>
    <p>会员期内可看全站剧集</p>
    <div><span class="vip-price">${state.constants.vipPrice ?? '—'}</span><small> ${state.constants.vipUnit ?? '元/月'}</small></div>
    <button class="vip-cta">查看套餐</button>`
  node.querySelector('.vip-close').addEventListener('click', () => { state.vipDismissed = true; node.remove() })
  node.querySelector('.vip-cta').addEventListener('click', async () => {
    node.remove()
    try {
      const { plans } = await api('/api/plans')
      openPaywall({ dramaId: 0, priceInfo: { plans } }, { title: '开通 / 续费会员' })
    } catch (error) { toast(error.message) }
  })
  document.body.appendChild(node)
}

/* ---------------- 页面 ---------------- */

async function renderHome() {
  const data = await api('/api/home')
  const banner = data.banners[0]
  view.innerHTML = `
    <section class="hero">
      <img class="hero-img" src="${escapeHtml(mediaUrl(banner?.image ?? ''))}" alt="" />
      <div class="hero-mask"></div>
      <div class="hero-body">
        <span class="hero-tag">独家 · 正在热播</span>
        <h1 class="hero-title">${escapeHtml(banner?.name ?? '独一无二的浪漫')}</h1>
        <div class="hero-sub">${escapeHtml(banner?.title ?? '')}</div>
        <div class="hero-actions">
          <button class="btn-primary" id="hero-play">▶ 立即播放</button>
          <button class="btn-ghost" id="hero-fav">＋ 收藏</button>
        </div>
      </div>
    </section>
    ${data.sections.map((section, index) => `
      <section class="section" data-section="${section.id}">
        <div class="section-head">
          <div class="section-title">${escapeHtml(section.title)}${index === 0 ? '<span class="star">★</span>' : ''}</div>
          <div class="section-hint">按热度实时排序</div>
          <button class="section-refresh" data-refresh="${section.id}">换一换 ⟳</button>
        </div>
        <div class="grid" data-grid="${section.id}">
          ${section.items.map((item) => posterCard(item)).join('')}
        </div>
      </section>`).join('')}
    <div class="footer"><span>© 2026 影巢</span><span>客服邮箱：${escapeHtml(state.constants.supportEmail ?? 'support@example.com')}</span></div>`

  const heroId = banner?.targetDramaId ?? data.sections?.[0]?.items?.[0]?.dramaId ?? null
  $('#hero-play').addEventListener('click', () => {
    if (!heroId) return toast('暂无可播放内容')
    location.hash = `#/play/${heroId}/1`
  })
  $('#hero-fav').addEventListener('click', async (event) => {
    if (!state.token) return openLogin()
    if (!heroId) return toast('暂无可收藏内容')
    const button = event.currentTarget
    try {
      const result = await api('/api/me/favorite', { method: 'POST', body: JSON.stringify({ dramaId: heroId }) })
      button.textContent = result.favorited ? '✓ 已收藏' : '＋ 收藏'
      toast(result.favorited ? '已加入收藏' : '已取消收藏')
    } catch (error) { toast(error.message) }
  })
  view.querySelectorAll('[data-refresh]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.refresh
      const grid = view.querySelector(`[data-grid="${id}"]`)
      try {
        const shuffled = await api(`/api/feed?section=${encodeURIComponent(id)}`)
        if (!shuffled.items?.length) return toast('该分区内容不足，无法换一批')
        grid.innerHTML = shuffled.items.map((item) => posterCard(item)).join('')
        toast('已换一批')
      } catch (error) { toast(error.message) }
    })
  })
  vipFloat()
}

async function renderCategory(type) {
  const data = await api(`/api/category?type=${encodeURIComponent(type)}`)
  const label = { MOVIE: '电影', TV: '美剧', PLAYLET: '短剧', COMIC: '动漫', VARIETY: '综艺', DOCUMENTARY: '纪录片' }[type] ?? type
  const list = data.list ?? []
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px">
      <div class="section-title">${escapeHtml(label)}</div>
      <div class="section-hint">共 ${data.total ?? list.length} 部 · 按更新时间</div>
    </div>
    ${list.length === 0
      ? '<div class="empty">该分类暂无内容</div>'
      : `<div class="grid">${list.map((item) => posterCard(item)).join('')}</div>`}`
  vipFloat()
}

async function renderRank(params) {
  const activeType = params.get('type') ?? 'HOT'
  const data = await api(`/api/rank?type=${encodeURIComponent(activeType)}`)
  const lists = data.lists ?? []
  view.innerHTML = `
    <div class="tabs">
      ${lists.map((item) => `<a class="tab ${item.type === (data.type ?? activeType) ? 'active' : ''}" href="#/rank?type=${encodeURIComponent(item.type)}">${escapeHtml(item.name)}</a>`).join('')}
    </div>
    ${(data.items ?? []).length === 0
      ? '<div class="empty">该榜单暂无内容</div>'
      : `<div class="grid">${data.items.map((item, index) => posterCard(item, { rank: item.rankNo ?? index + 1 })).join('')}</div>`}
    <div class="footer"><span>${escapeHtml(data.listName || '榜单')} · 每小时更新</span></div>`
  vipFloat()
}

async function renderSearch(params) {
  const keyword = params.get('q') ?? ''
  const data = await api(`/api/search?keyword=${encodeURIComponent(keyword)}`)
  const home = await api('/api/home').catch(() => ({ hotwords: [] }))
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px">
      <div class="section-title">搜索</div>
      <div class="section-hint">${keyword ? `“${escapeHtml(keyword)}” 命中 ${data.total} 部` : '输入关键词开始搜索'}</div>
    </div>
    <div class="subtabs">
      ${(home.hotwords ?? []).map((word) => `<a class="pill" href="#/search?q=${encodeURIComponent(word)}">${escapeHtml(word)}</a>`).join('')}
    </div>
    ${(data.list ?? []).length === 0
      ? '<div class="empty">没有找到相关剧集</div>'
      : `<div class="grid">${data.list.map((item) => posterCard(item)).join('')}</div>`}`
  vipFloat()
}

async function renderDrama(id) {
  const detail = await api(`/api/drama/${encodeURIComponent(id)}`)
  const access = detail.access ?? 'subscription'
  const priceInfo = detail.priceInfo ?? { plans: [], singlePrice: detail.singlePrice ?? 0 }
  const canSingle = detail.accessMode === 'paid'
  const firstFree = detail.episodes.find((episode) => episode.allow)
  const entitled = access === 'owned' || access === 'subscribed'
  const payCta = `<button class="btn-ghost" id="open-paywall">${canSingle ? '解锁全部 ¥' + Number(detail.singlePrice ?? 0).toFixed(0) : '开通会员看全集'}</button>`
  const cta = entitled
    ? '<button class="btn-primary" id="play-first">▶ 继续观看</button>'
    : firstFree
      // 首集免费是拉新的唯一钩子：先让人看到内容，再谈付费
      ? `<button class="btn-primary" id="play-free">▶ 免费看第 ${firstFree.no} 集</button>${payCta}`
      : `<button class="btn-primary" id="open-paywall">${canSingle ? '购买本片 ¥' + Number(detail.singlePrice ?? 0).toFixed(0) : '开通会员'}</button>`

  view.innerHTML = `
    <div class="detail-head">
      <div class="detail-cover"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" onerror="this.style.display='none'" /></div>
      <div class="detail-meta">
        <div class="detail-title">${escapeHtml(detail.title)} ${badgeOf(detail)}</div>
        <div class="detail-facts">
          <span>⭐ ${detail.score ?? '—'}</span>
          <span>${escapeHtml(String(detail.year ?? ''))}</span>
          <span>${escapeHtml(detail.area ?? '')}</span>
          <span>${escapeHtml(detail.dramaType ?? '')}</span>
          <span>全 ${detail.episodes.length} 集</span>
          <span>${detail.freeEpisodes > 0 ? `首 ${detail.freeEpisodes} 集免费` : (canSingle ? '单片付费' : '会员专享')}</span>
        </div>
        <div class="detail-desc">${escapeHtml(detail.subTitle ?? '')}<br/>${escapeHtml(detail.description ?? '')}</div>
        <div class="detail-actions">
          ${cta}
          <button class="btn-ghost" id="fav-btn">＋ 收藏</button>
          <button class="btn-ghost" id="share-btn">分享</button>
        </div>
      </div>
    </div>
    <div class="section-head"><div class="section-title">选集</div><div class="section-hint">${detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费，其余需${canSingle ? '购买' : '会员'}` : '需开通权益后观看'}</div></div>
    <div class="episodes">
      ${detail.episodes.map((episode) => `<a class="ep ${episode.allow ? '' : 'locked'}" data-no="${episode.no}" href="#/play/${detail.dramaId}/${episode.no}">
        ${episode.no}${episode.allow ? '' : ' 🔒'}${episode.trialSeconds > 0 ? ' · 试看' : ''}
      </a>`).join('')}
    </div>
    <div class="footer"><span>${escapeHtml(detail.title)} · 共 ${detail.episodes.length} 集</span><span>${detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费` : '需开通权益后观看'}</span></div>`

  $('#play-first')?.addEventListener('click', () => {
    const first = detail.episodes.find((episode) => episode.allow) ?? detail.episodes[0]
    location.hash = `#/play/${detail.dramaId}/${first.no}`
  })
  $('#play-free')?.addEventListener('click', () => {
    if (!firstFree) return
    // 未登录先登录（免费集也要账号才能记权益与进度），登录后回到本集
    if (!state.token) { pendingRoute = `#/play/${detail.dramaId}/${firstFree.no}`; openLogin(); return }
    location.hash = `#/play/${detail.dramaId}/${firstFree.no}`
  })
  $('#open-paywall')?.addEventListener('click', () => openPaywall(detail, { price: detail.singlePrice, reason: canSingle ? 'single_purchase_required' : 'subscription_required' }))
  view.querySelectorAll('.ep.locked').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.preventDefault()
      openPaywall(detail, { price: detail.singlePrice, reason: canSingle ? 'single_purchase_required' : 'subscription_required' })
    })
  })
  $('#fav-btn').addEventListener('click', async () => {
    try {
      const result = await api('/api/me/favorite', { method: 'POST', body: JSON.stringify({ dramaId: detail.dramaId }) })
      toast(result.favorited ? '已收藏' : '已取消收藏')
    } catch (error) {
      if (error.code === '0401') openLogin(); else toast(error.message)
    }
  })
  $('#share-btn').addEventListener('click', async () => {
    const url = `${location.origin}${BASE}/#/drama/${detail.dramaId}`
    const text = `《${detail.title}》${detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费` : ''}`
    if (navigator.share) {
      try { await navigator.share({ title: detail.title, text, url }); return } catch { /* 用户取消或不支持，退回复制 */ }
    }
    try { await navigator.clipboard.writeText(`${text} ${url}`); toast('分享链接已复制') } catch { toast(url) }
  })
  void priceInfo
  vipFloat()
}

async function renderPlay(id, episodeNo) {
  let data
  let detail
  try {
    data = await api(`/api/play/${encodeURIComponent(id)}/${encodeURIComponent(episodeNo)}`)
    detail = await api(`/api/drama/${encodeURIComponent(id)}`)
  } catch (error) {
    if (error.code === '0401') {
      view.innerHTML = `<div class="empty">${escapeHtml(error.message)}<br/><br/><button class="btn-primary" id="play-login">登录后播放</button></div>`
      $('#play-login').addEventListener('click', openLogin)
      return
    }
    // 402：权益不足 → 详情 + 付费墙
    try { detail = await api(`/api/drama/${encodeURIComponent(id)}`) } catch { /* ignore */ }
    view.innerHTML = `
      <div class="empty">
        <div style="font-size:16px;margin-bottom:8px">${escapeHtml(error.message)}</div>
        ${detail ? `<div style="color:#9aa3b2;font-size:13px">${escapeHtml(detail.title)} · 第 ${escapeHtml(episodeNo)} 集</div>` : ''}
        <div style="margin-top:18px;display:flex;gap:10px;justify-content:center">
          <button class="btn-primary" id="go-paywall">查看购买选项</button>
          <a class="btn-ghost" href="#/drama/${encodeURIComponent(id)}">返回详情</a>
        </div>
      </div>`
    const info = error.data ?? {}
    $('#go-paywall').addEventListener('click', () => openPaywall(detail, {
      plans: info.plans, price: info.price, reason: info.reason, title: error.message,
    }))
    return
  }

  const sourceLabel = { free: '免费观看', subscription: '会员权益', purchase: '已购买' }[data.source] ?? ''
  view.innerHTML = `
    <div class="player-wrap">
      <div class="player-bar">
        <span>${escapeHtml(data.title)} · 第 ${escapeHtml(episodeNo)} 集</span>
        <span style="margin-left:auto">${sourceLabel}${data.hls ? ' · HLS' : ' · 未上传片源'}</span>
      </div>
      <div class="player" id="player">
        <video id="video" playsinline controls style="width:100%;height:100%;background:#000"></video>
        <div class="danmu-layer" id="danmu-layer"></div>
        <div class="notice" id="player-notice">${data.hls ? `播放链接 ${Math.round((data.expiresIn ?? 300) / 60)} 分钟内有效（签名防盗链，过期自动续签）` : '该集片源正在处理中，请稍后再试'}</div>
        <div class="player-tools">
          <select id="quality-select"><option value="-1">自动清晰度</option></select>
          <input id="danmu-input" placeholder="发条弹幕…" maxlength="60" />
          <button class="btn-ghost" id="danmu-send">发送</button>
          <button class="btn-ghost" id="share-btn">分享</button>
        </div>
      </div>
    </div>
    <div class="detail-head" style="margin-top:0">
      <div class="detail-cover" style="width:120px;flex:0 0 120px"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" /></div>
      <div class="detail-meta">
        <div class="detail-title" style="font-size:20px">${escapeHtml(detail.title)}</div>
        <div class="detail-facts"><span>${escapeHtml(detail.subTitle ?? '')}</span></div>
        <div class="chips">${detail.episodes.slice(0, 60).map((item) => `<a class="ep ${String(item.no) === String(episodeNo) ? 'active' : ''} ${item.allow ? '' : 'locked'}" data-no="${item.no}" style="display:inline-block;margin:0 6px 6px 0" href="#/play/${detail.dramaId}/${item.no}">${item.no}${item.allow ? '' : ' 🔒'}</a>`).join('')}</div>
      </div>
    </div>`

  view.querySelectorAll('.ep.locked').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.preventDefault()
      openPaywall(detail, { price: detail.singlePrice, reason: detail.accessMode === 'paid' ? 'single_purchase_required' : 'subscription_required' })
    })
  })

  const video = $('#video')
  const danmuLayer = $('#danmu-layer')
  $('#danmu-send')?.addEventListener('click', async () => {
    const input = $('#danmu-input')
    const content = input.value.trim()
    if (!content) return
    try {
      const result = await api('/api/danmu', {
        method: 'POST',
        body: JSON.stringify({ episodeId: data.episode.id, timeMs: Math.round((video?.currentTime ?? 0) * 1000), content }),
      })
      toast(result.message ?? '已提交')
      input.value = ''
    } catch (error) { toast(error.message) }
  })
  $('#share-btn')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('播放链接已复制') } catch { toast(location.href) }
  })
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
  }

  const saveHistory = () => {
    if (!state.token) return
    void api('/api/me/history', {
      method: 'POST',
      body: JSON.stringify({ dramaId: detail.dramaId, episode: Number(episodeNo), position: Math.round(video.currentTime || 0) }),
    }).catch(() => {})
  }

  if (data.hls) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = BASE + data.hls
    } else {
      try {
        const Hls = await loadHls()
        if (Hls && Hls.isSupported()) {
          const hls = new Hls({ lowLatencyMode: false })
          hls.loadSource(BASE + data.hls)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const select = $('#quality-select')
            if (!select) return
            select.innerHTML = '<option value="-1">自动清晰度</option>'
              + hls.levels.map((level, index) => `<option value="${index}">${level.height}p</option>`).join('')
            select.addEventListener('change', () => { hls.currentLevel = Number(select.value) })
          })
        } else {
          video.src = BASE + data.hls
        }
      } catch {
        video.src = BASE + data.hls
        $('#player-notice').textContent = 'hls.js 加载失败（离线？），已尝试浏览器原生 HLS'
      }
    }
    video.addEventListener('play', startDanmu, { once: true })
    video.addEventListener('pause', saveHistory)
    // 续播：从上次看到的进度恢复（太靠近开头/结尾时不跳，避免误判）
    video.addEventListener('loadedmetadata', () => {
      const at = Number(data.resumePosition ?? 0)
      if (at > 5 && (!video.duration || at < video.duration - 10)) {
        video.currentTime = at
        $('#player-notice').textContent = `已从上次观看到的 ${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, '0')} 继续播放`
      }
    }, { once: true })
    // 连播：本集播完自动进下一集
    video.addEventListener('ended', () => {
      saveHistory()
      if (!data.nextEpisodeNo) return toast('已是最后一集')
      toast(`即将播放第 ${data.nextEpisodeNo} 集`)
      setTimeout(() => { location.hash = `#/play/${detail.dramaId}/${data.nextEpisodeNo}` }, 800)
    })
    // 上报节流：timeupdate 约 4Hz，按「距上次上报满 15 秒」判定，避免同秒重复写库
    let lastSavedAt = -15
    video.addEventListener('timeupdate', () => {
      if (video.currentTime - lastSavedAt < 15) return
      lastSavedAt = video.currentTime
      saveHistory()
    })
  } else {
    const bigPlay = document.createElement('button')
    bigPlay.className = 'big-play'
    bigPlay.textContent = '▶'
    bigPlay.addEventListener('click', () => toast('该集片源仍在处理中，稍后再试或联系客服'))
    $('#player').appendChild(bigPlay)
  }
  vipFloat()
}

async function renderMe() {
  if (!state.token) {
    view.innerHTML = `
      <div class="section-head" style="margin-top:26px"><div class="section-title">我的</div></div>
      <div class="empty">登录后可查看订阅权益、订单与观看历史<br/><br/><button class="btn-primary" id="me-login">登录 / 注册</button></div>`
    $('#me-login').addEventListener('click', openLogin)
    return
  }
  const data = await api('/api/me')
  const orders = (await api('/api/orders')).list ?? []
  const messages = (await api('/api/me/messages').catch(() => ({ messages: [] }))).messages ?? []
  const sub = data.subscription
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px"><div class="section-title">我的</div>
      <div class="section-hint">${escapeHtml(data.user.nickname)} · ${escapeHtml(data.user.email ?? '未绑定邮箱')}</div></div>
    <div class="me-grid">
      <div class="me-card me-profile-card">
        <div class="me-card-title">个人资料 · 完整度 ${data.completion?.percent ?? 0}%</div>
        <div class="me-profile">
          <div class="avatar-wrap">
            ${data.user.avatar
              ? `<img id="me-avatar" class="avatar" src="${escapeHtml(mediaUrl(data.user.avatar))}" alt="头像" />`
              : '<div id="me-avatar" class="avatar avatar-empty">' + escapeHtml((data.user.nickname ?? '影').slice(0, 1)) + '</div>'}
            <label class="avatar-upload">更换头像<input type="file" id="avatar-file" accept="image/png,image/jpeg,image/webp" hidden /></label>
          </div>
          <div class="me-profile-fields">
            <div class="me-row"><span>邮箱</span><span>${escapeHtml(data.user.email ?? '—')}<button class="btn sm" id="change-email" style="margin-left:8px">更换</button></span></div>
            <div class="me-row"><span>昵称</span><span>${escapeHtml(data.user.nickname)}</span></div>
            <div class="me-row"><span>生日</span><span>${escapeHtml(data.user.birthday ?? '未填写')}</span></div>
            <div class="me-row"><span>性别</span><span>${escapeHtml({ male: '男', female: '女', other: '其他', secret: '保密' }[data.user.gender] ?? '未填写')}</span></div>
            <div class="me-row"><span>简介</span><span>${escapeHtml(data.user.bio ?? '未填写')}</span></div>
            <div class="me-row"><span>密码</span><span>${data.user.hasPassword ? '已设置' : '未设置'}</span></div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn-primary" id="edit-profile">编辑资料</button>
          <button class="btn-ghost" id="change-password">修改密码</button>
          ${(data.completion?.missing ?? []).length ? `<span class="me-sub">待完善：${escapeHtml(data.completion.missing.join('、'))}</span>` : ''}
        </div>
      </div>
      <div class="me-card">
        <div class="me-card-title">会员权益</div>
        ${sub ? `<div class="me-big">会员中</div><div class="me-sub">有效期至 ${escapeHtml(sub.validTo)}</div>` : '<div class="me-big">未开通</div><div class="me-sub">开通后可看全站剧集</div>'}
        <button class="btn-primary" id="me-subscribe" style="margin-top:12px">${sub ? '续费' : '开通会员'}</button>
      </div>
      <div class="me-card">
        <div class="me-card-title">已购单片</div>
        ${data.purchases.length === 0 ? '<div class="me-sub">暂无</div>' : data.purchases.map((item) => `<div class="me-row"><a href="#/drama/${item.dramaId}">${escapeHtml(item.title)}</a><span>${item.kind === 'rental' ? '租赁至 ' + escapeHtml(item.expiresAt ?? '') : '永久'}</span></div>`).join('')}
      </div>
      <div class="me-card">
        <div class="me-card-title">最近订单</div>
        ${orders.length === 0 ? '<div class="me-sub">暂无订单</div>' : `<div class="order-list">${orders.slice(0, 12).map((order) => {
          const pending = order.status === 'created' || order.status === 'pending'
          return `<div class="me-row order-row">
            <span class="order-no">${escapeHtml(order.out_trade_no)}</span>
            <span>¥${Number(order.amount_cny).toFixed(2)}</span>
            <span class="order-status order-${escapeHtml(order.status)}">${escapeHtml(ORDER_STATUS[order.status] ?? order.status)}</span>
            ${pending ? `<button class="btn-ghost sm" data-resume="${escapeHtml(order.out_trade_no)}" data-channel="${escapeHtml(order.channel ?? '')}">继续支付</button>` : ''}
          </div>`
        }).join('')}</div>`}
      </div>
    </div>
    <div class="section-head"><div class="section-title">消息</div><div class="section-hint">权益与订单通知</div></div>
    <div class="me-grid">
      ${messages.length === 0 ? '<div class="me-card"><div class="me-sub">暂无消息</div></div>'
        : messages.slice(0, 4).map((message) => `<div class="me-card">
            <div class="me-card-title">${message.type === 'order' ? '订单' : '会员'}</div>
            <div style="font-size:14px">${escapeHtml(message.title)}</div>
            <div class="me-sub">${escapeHtml(message.body)}</div>
          </div>`).join('')}
    </div>
    <div class="section-head"><div class="section-title">观看历史</div></div>
    <div class="grid">${data.history.map((item) => `<a class="card" href="#/play/${item.dramaId}/${item.episode}"><div class="poster"><img src="${escapeHtml(mediaUrl(item.coverUrl))}" alt="" /></div><div class="card-title">${escapeHtml(item.title)}</div><div class="card-sub">看到第 ${item.episode} 集</div></a>`).join('') || '<div class="empty">还没有观看记录</div>'}</div>
    <div class="section-head"><div class="section-title">我的收藏</div></div>
    <div class="grid">${data.favorites.map((item) => posterCard(item)).join('') || '<div class="empty">还没有收藏</div>'}</div>`
  $('#me-subscribe').addEventListener('click', async () => {
    const { plans } = await api('/api/plans')
    openPaywall({ dramaId: 0, priceInfo: { plans } }, { title: '开通 / 续费会员' })
  })
  $('#edit-profile').addEventListener('click', () => openProfileEdit(data.user))
  view.querySelectorAll('[data-resume]').forEach((button) => {
    button.addEventListener('click', async () => {
      const no = button.dataset.resume
      const channel = button.dataset.channel
      try {
        const order = await api(`/api/orders/${encodeURIComponent(no)}`)
        if (order.status === 'paid' || order.status === 'fulfilled') { toast('该订单已完成支付'); return route() }
        if (order.status === 'closed') { toast('订单已关闭，请重新下单'); return }
        if (order.usdt?.address) {
          openModal('订单待支付', `订单 ${no} 待支付：请向 ${order.usdt.address} 转入 ${order.usdt.amount} USDT（${PAY.usdtNetwork}），到账后自动开通权益。`)
          return
        }
        const page = channel === 'alipay' ? 'alipay-sim' : channel === 'mock' ? 'mock' : null
        if (!page) { toast('该订单的支付渠道已停用，请重新下单'); return }
        window.open(`${BASE}/pay/${page}/${encodeURIComponent(no)}`, '_blank', 'width=520,height=680')
        toast('已打开收银台，支付完成后刷新本页')
      } catch (error) { toast(error.message) }
    })
  })
  $('#change-password').addEventListener('click', () => openChangePassword(data.user))
  $('#change-email').addEventListener('click', () => openChangeEmail(data.user))
  $('#avatar-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 1024 * 1024) { toast('头像不能超过 1MB'); return }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
    try {
      const result = await api('/api/me/avatar', { method: 'POST', body: JSON.stringify({ dataUrl }) })
      state.user = result.user
      localStorage.setItem('mh-user', JSON.stringify(result.user))
      toast('头像已更新')
      await renderMe()
    } catch (error) { toast(error.message) }
  })
  vipFloat()
}

/** 编辑资料：昵称 / 生日 / 性别 / 简介 */
function openProfileEdit(user) {
  const modal = $('#modal')
  modal.classList.remove('hidden')
  modal.innerHTML = `
    <div class="modal-card" style="width:min(460px,94vw)">
      <h3>编辑资料</h3>
      <label class="field"><span>昵称</span><input id="pf-nickname" value="${escapeHtml(user.nickname ?? '')}" maxlength="20" /></label>
      <label class="field"><span>生日</span><input id="pf-birthday" type="date" value="${escapeHtml(user.birthday ?? '')}" /></label>
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
  const close = () => modal.classList.add('hidden')
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
  modal.addEventListener('click', (event) => { if (event.target === modal) close() }, { once: true })
}

/** 修改密码：向注册邮箱发码 → 校验 → 设置新密码（≥8 位且含字母+数字） */
function openChangePassword(user) {
  const modal = $('#modal')
  modal.classList.remove('hidden')
  let timer
  modal.innerHTML = `
    <div class="modal-card" style="width:min(440px,94vw)">
      <h3>修改密码</h3>
      <p style="color:#9aa3b2;font-size:13px;margin:4px 0 10px">验证码将发送到注册邮箱 ${escapeHtml(user.email ?? '')}</p>
      <div style="display:flex;gap:8px">
        <input id="pw-code" placeholder="6 位验证码" maxlength="6" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);color:var(--text)" />
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
  const close = () => modal.classList.add('hidden')
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
  modal.addEventListener('click', (event) => { if (event.target === modal) close() }, { once: true })
}

/** 更换邮箱：向新邮箱发码 → 校验 → 更新绑定 */
function openChangeEmail(user) {
  const modal = $('#modal')
  modal.classList.remove('hidden')
  let timer
  modal.innerHTML = `
    <div class="modal-card" style="width:min(440px,94vw)">
      <h3>更换邮箱</h3>
      <p style="color:#9aa3b2;font-size:13px;margin:4px 0 10px">当前邮箱：${escapeHtml(user.email ?? '未绑定')}</p>
      <label class="field"><span>新邮箱</span><input id="ce-email" type="email" placeholder="new@example.com" /></label>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input id="ce-code" placeholder="6 位验证码" maxlength="6" style="flex:1;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg-elev);color:var(--text)" />
        <button class="btn-ghost" id="ce-send">发送验证码</button>
      </div>
      <div id="ce-msg" style="font-size:12px;min-height:18px;margin-top:8px;color:#9aa3b2"></div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn-primary" id="ce-save" style="flex:1">确认更换</button>
        <button class="btn-ghost" id="ce-cancel">取消</button>
      </div>
    </div>`
  const close = () => modal.classList.add('hidden')
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
  modal.addEventListener('click', (event) => { if (event.target === modal) close() }, { once: true })
}

function loginWall() {
  view.innerHTML = `
    <div class="empty" style="margin-top:80px">
      <div style="font-size:18px;margin-bottom:10px">登录后才能浏览和播放</div>
      <div style="color:#9aa3b2;font-size:13px;margin-bottom:18px">未登录仅可浏览首页；免费集同样需要登录后播放。</div>
      <button class="btn-primary" id="wall-login">登录 / 注册</button>
      <a class="btn-ghost" href="#/home" style="margin-left:8px">返回首页</a>
    </div>`
  $('#wall-login').addEventListener('click', openLogin)
}

async function route() {
  renderChrome()
  const hash = location.hash || '#/home'
  const [pathPart, queryPart] = hash.slice(1).split('?')
  const params = new URLSearchParams(queryPart ?? '')
  const segments = pathPart.split('/').filter(Boolean)
  // 浏览类页面（首页/分类/榜单/搜索/详情）对未登录开放：分享出去的链接必须能直接看，
  // 否则传播链在登录墙上归零。播放与个人中心仍需登录。
  const needsLogin = segments[0] === 'play' || segments[0] === 'me'
  if (!state.token && needsLogin) {
    loginWall()
    return
  }
  try {
    if (segments[0] === 'home' || segments.length === 0) await renderHome()
    else if (segments[0] === 'category') await renderCategory(segments[1] ?? 'ALL')
    else if (segments[0] === 'rank') await renderRank(params)
    else if (segments[0] === 'search') await renderSearch(params)
    else if (segments[0] === 'drama') await renderDrama(segments[1])
    else if (segments[0] === 'play') await renderPlay(segments[1], segments[2] ?? '1')
    else if (segments[0] === 'me') await renderMe()
    else await renderHome()
  } catch (error) {
    view.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`
  }
  window.scrollTo(0, 0)
}

window.addEventListener('hashchange', () => {
  // 路由切换时关闭可能残留的弹窗/付费墙，避免遮挡新页面
  $('#modal')?.classList.add('hidden')
  route()
})
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
