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

// 频道导航对齐参考站：主线是「精选 + 频道 + 地区快捷入口 + 即将上线」。
// 美剧/韩剧/日剧/英剧不是独立频道，而是「电视剧 + 地区筛选」的快捷入口，
// 这样既不用多一套内容模型，也不会出现点进去全是空列表的独立频道。
const NAV_MAIN = [
  ['精选', '#/home'],
  ['分类', '#/category/ALL'],
  ['电影', '#/category/MOVIE'],
  ['电视剧', '#/category/TV'],
  ['美剧', '#/category/TV?region=US'],
  ['韩剧', '#/category/TV?region=KR'],
  ['日剧', '#/category/TV?region=JP'],
  ['英剧', '#/category/TV?region=UK'],
  ['短剧', '#/category/PLAYLET'],
  ['动漫', '#/category/ANIME'],
  ['综艺', '#/category/VARIETY'],
  ['纪录片', '#/category/DOCUMENTARY'],
  ['即将上线', '#/category/ALL?sort=upcoming'],
  ['片单广场', '#/playlists'],
]

// 内容类型的中文名（服务端 dramaType 是 MOVIE/TV/PLAYLET/VARIETY 这类枚举，
// 详情页 meta 行直接渲染会露出英文，C 端读起来像内部字段）
const DRAMA_CATEGORY_LABEL = {
  MOVIE: '电影', TV: '电视剧', PLAYLET: '短剧', VARIETY: '综艺',
  ANIME: '动漫', COMIC: '动漫', DOCUMENTARY: '纪录片',
}
const categoryLabel = (value) => DRAMA_CATEGORY_LABEL[value] ?? value ?? ''
// 榜单口径对齐参考站顶部 9 个榜：热播 / 热搜 / 飙升 / 期待 / 经典 / 短剧 / 季度 / 高分 / 冷门佳作
const NAV_RANK = [
  ['热播榜', '#/rank?type=HOT'],
  ['热搜榜', '#/rank?type=SEARCH'],
  ['飙升榜', '#/rank?type=RISE'],
  ['期待榜', '#/rank?type=EXPECT'],
  ['经典榜', '#/rank?type=CLASSIC'],
  ['短剧榜', '#/rank?type=PLAYLIST'],
  ['季度榜', '#/rank?type=QUARTER'],
  ['高分榜', '#/rank?type=HIGHRATE'],
  ['冷门佳作', '#/rank?type=HIDDEN'],
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
// 登录前发起、需要在登录成功后重放的动作（目前只有"打开付费墙购买"）
let pendingAction
// 当前页面注册的清理函数（定时器、hls 实例、进度与埋点上报），路由切换前统一执行
let routeCleanups = []

function cleanupRoute() {
  const list = routeCleanups
  routeCleanups = []
  for (const fn of list) { try { fn() } catch { /* 单个清理失败不影响其它 */ } }
}

/** 行为埋点：beacon 优先（不阻塞导航），失败静默——埋点永远不能影响用户体验 */
function track(type, data = {}) {
  try {
    const payload = JSON.stringify({ type, ...data })
    if (navigator.sendBeacon) {
      const ok = navigator.sendBeacon(`${BASE}/api/track`, new Blob([payload], { type: 'application/json' }))
      if (ok) return
    }
    fetch(`${BASE}/api/track`, {
      method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: payload,
    }).catch(() => {})
  } catch { /* ignore */ }
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  let res
  try {
    res = await fetch(BASE + path, { ...options, headers })
  } catch {
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
    openModal('暂无可购套餐', `<p class="paywall-sub">当前没有在售的会员套餐，请联系客服开通。</p>
      <p class="paywall-sub">客服邮箱：${escapeHtml(state.constants?.supportEmail || '—')}</p>`)
    return
  }

  let selected = plans.length
    ? { productType: 'subscription', planId: Number(plans[0].id) }
    : { productType: 'single', dramaId }

  modal.dataset.paywall = token
  modal.classList.remove('hidden')
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
        <input id="coupon-input" placeholder="优惠券码（可选，如 WELCOME10）" />
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
    modal.classList.add('hidden')
    if (modal.dataset.paywall === token) delete modal.dataset.paywall
  }
  $('#paywall-close').addEventListener('click', close)
  modal.addEventListener('click', (event) => { if (event.target === modal) close() })

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

  const go = async (channel) => {
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
    earn('正在创建订单…')
    // 弹窗必须在 await 之前打开，否则 iOS Safari / 微信内会被拦截
    const popup = channel === 'usdt' ? null : window.open('', '_blank', 'width=520,height=680')
    try {
      const order = await createOrder({ ...payload, channel, couponCode })
      earn(`订单 ${order.outTradeNo} 已创建，金额 ¥${Number(order.amount).toFixed(2)}`)
      if (order.payUrl) {
        const target = order.payUrl.startsWith('http') ? order.payUrl : BASE + order.payUrl
        if (popup) popup.location.href = target
        else window.open(target, '_blank', 'width=520,height=680')
      }
      if (order.simulated) earn('已打开模拟收银台，付款后自动到账')
      if (order.usdt) {
        earnHtml(`请向 <b>${escapeHtml(order.usdt.address)}</b> 转入 <b>${order.usdt.amount} USDT</b>（${order.usdt.network}），15 分钟内有效`)
      }
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
        earn('仍在等待到账（USDT 需 19 个区块确认，通常 1–3 分钟）。可关闭此窗，到账后自动开通，也可在「我的」页继续支付')
      }
    } catch (error) {
      if (popup && !popup.closed) popup.close()
      earn(error.message)
    }
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
}

const fmtDuration = (seconds) => {
  if (!seconds) return ''
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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
  node.textContent = text
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
  const score = options.score && Number(item.score) > 0 ? `<span class="card-score">★ ${Number(item.score).toFixed(1)}</span>` : ''
  // playCount 由 cardOf 提供；只在明确要求的地方显示（分类列表），避免每张卡都塞满数字
  const plays = options.plays && Number(item.playCount) > 0 ? `<span class="card-plays">▶ ${fmtCount(item.playCount)}</span>` : ''
  // 三块都为空时整行不渲染：留空 div 会让卡片的 title→图 间距塌掉，多行卡片高度不齐
  const sub = `${score}${plays}${escapeHtml(item.subTitle || (item.labels ?? []).slice(0, 2).join(' · '))}`
  return `
    <div class="card">
      <a class="poster" href="#/drama/${escapeHtml(item.dramaId)}" title="${escapeHtml(item.title)}">
        ${badge}${rank}
        <img loading="lazy" src="${escapeHtml(mediaUrl(item.coverUrl))}" alt="${escapeHtml(item.title)}" onerror="this.style.display='none';this.parentNode.classList.add('noimg')" />
        <span class="play-hint">▶</span>
      </a>
      <div class="card-title">${escapeHtml(item.title)}</div>
      ${sub ? `<div class="card-sub">${sub}</div>` : ''}
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
  const wanted = new URLSearchParams(hrefQuery ?? '').get('type')
  if (!wanted) return true
  const current = new URLSearchParams(String(hash ?? '').split('?')[1] ?? '').get('type')
  return (current ?? 'HOT') === wanted
}

function renderChrome() {
  const hash = location.hash || '#/home'
  const authKey = state.token ? String(state.user?.id ?? 'user') : 'anon'
  const topbarNode = $('#search-form')
  if (topbarNode && renderChrome.authKey === authKey) {
    // 只更新高亮与按钮文案：整块重建 topbar 会清掉用户正在输入的搜索词
    const loginBtn = $('#login-btn')
    if (loginBtn) {
      loginBtn.textContent = state.user ? (state.user.nickname ?? '我的账号') : '登录'
      loginBtn.title = state.user ? '进入个人中心' : '登录 / 注册'
    }
    sidebar.querySelectorAll('.nav-item').forEach((node) => {
      node.classList.toggle('active', navIsActive(node.getAttribute('href'), hash))
    })
    return
  }
  renderChrome.authKey = authKey
  sidebar.innerHTML = `
    <div class="nav-group">
      <div class="nav-title">频道</div>
      ${NAV_MAIN.map(([label, href]) => `<a class="nav-item ${navIsActive(href, hash) ? 'active' : ''}" href="${href}">${label}</a>`).join('')}
    </div>
    <div class="nav-group">
      <div class="nav-title">榜单</div>
      ${NAV_RANK.map(([label, href]) => `<a class="nav-item ${navIsActive(href, hash) ? 'active' : ''}" href="${href}">${label}</a>`).join('')}
    </div>
    <div class="nav-group">
      <div class="nav-title">我的</div>
      <a class="nav-item ${navIsActive('#/me', hash) ? 'active' : ''}" href="#/me">历史 / 收藏</a>
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
      <button class="btn-login" id="login-btn" title="${state.user ? '进入个人中心' : '登录 / 注册'}" aria-label="${state.user ? `进入个人中心（当前账号 ${escapeHtml(state.user.nickname ?? '我的账号')}）` : '登录或注册'}">${state.user ? escapeHtml(state.user.nickname ?? '我的账号') : '登录'}</button>
    </div>`
  $('#search-form').addEventListener('submit', (event) => {
    event.preventDefault()
    const keyword = $('#search-input').value.trim()
    location.hash = `#/search?q=${encodeURIComponent(keyword)}`
  })
  // 用户名/头像 = 进个人中心（旧行为是点一下就退出登录，误触即掉会话）。
  // 退出登录已挪到「我的」页内，只有明确进入个人中心才能执行。
  $('#login-btn').addEventListener('click', () => {
    if (!state.token) {
      openLogin()
      return
    }
    if (location.hash === '#/me') route()
    else location.hash = '#/me'
  })
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
  // 会员浮层只在「有片可看」的页面出现：首页与详情页。分类/榜单/搜索/播放页不挂，
  // 否则在长列表和播放器上挡住内容（参考站也没有全站挂浮层）。
  if (!/^#\/(home|drama\/)/.test(location.hash || '#/home')) return
  const price = Number(state.constants.vipPrice)
  if (!Number.isFinite(price) || price <= 0) return
  const node = document.createElement('div')
  node.className = 'vip-float'
  node.innerHTML = `
    <button class="vip-close" aria-label="关闭">×</button>
    <h4>开通会员 全场畅看</h4>
    <p>会员期内可看全站剧集</p>
    <div><span class="vip-price">${price.toFixed(2)}</span><small> ${state.constants.vipUnit ?? '元/月'}</small></div>
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

// 片单广场：参考站的「片单广场」= 编辑精选合集。这里先用首页楼层（sections）当合集，
// 每个合集渲染成一格网格，点卡片直接进详情；后续可换成人工编排的 playlists 表。
async function renderPlaylists() {
  document.title = '片单广场 · 影巢'
  const data = await api('/api/home')
  const sections = (data.sections ?? []).filter((section) => (section.items ?? []).length > 0)
  if (!sections.length) {
    view.innerHTML = '<div class="section-head" style="margin-top:22px"><div class="section-title">片单广场</div></div>'
      + '<div class="empty">还没有片单，内容上架后这里会按主题自动成集。</div>'
    return
  }
  const block = (section, index) => {
    const items = section.items ?? []
    return '<section class="section">'
      + '<div class="section-head"><div class="section-title">' + escapeHtml(section.title ?? ('片单 ' + (index + 1))) + '</div>'
      + '<div class="section-hint">' + items.length + ' 部</div></div>'
      + '<div class="grid">' + items.map((item) => posterCard(item)).join('') + '</div>'
      + '</section>'
  }
  view.innerHTML = '<div class="section-head" style="margin-top:22px">'
    + '<div class="section-title">片单广场</div>'
    + '<div class="section-hint">' + sections.length + ' 个主题片单 · 每张片单都是一组可直接播放的剧集</div>'
    + '</div>'
    + sections.map(block).join('')
  vipFloat()
}

async function renderHome() {
  const data = await api('/api/home')
  const banners = data.banners ?? []
  const banner = banners[0]
  const sections = (data.sections ?? []).filter((section) => (section.items ?? []).length > 0)
  const hasHero = Boolean(banner?.name || banner?.image)

  if (!hasHero && sections.length === 0) {
    view.innerHTML = `
      <div class="empty" style="padding-top:120px">
        <div style="font-size:18px;color:var(--text);margin-bottom:10px">内容正在上架</div>
        <div>新片正在转码入库，稍后刷新即可观看。</div>
        <div style="margin-top:10px">急用请联系：${escapeHtml(state.constants.supportEmail || '客服邮箱待配置')}</div>
      </div>`
    return
  }

  view.innerHTML = `
    ${hasHero ? `<section class="hero">
      ${banner?.image ? `<img class="hero-img" src="${escapeHtml(mediaUrl(banner.image))}" alt="${escapeHtml(banner.name ?? '')}" />` : ''}
      <div class="hero-mask"></div>
      <div class="hero-body">
        <span class="hero-tag">独家 · 正在热播</span>
        <h1 class="hero-title">${escapeHtml(banner?.name ?? '')}</h1>
        <div class="hero-sub">${escapeHtml(banner?.title ?? '')}</div>
        <div class="hero-actions">
          <button class="btn-primary" id="hero-play">▶ 查看详情</button>
          <button class="btn-ghost" id="hero-fav">＋ 收藏</button>
        </div>
      </div>
    </section>` : ''}
    ${sections.map((section, index) => `
      <section class="section" data-section="${section.id}">
        <div class="section-head">
          <div class="section-title">${escapeHtml(section.title)}${index === 0 ? '<span class="star">★</span>' : ''}</div>
          <div class="section-hint">按热度实时排序</div>
          <button class="section-refresh" data-refresh="${section.id}">换一换 ⟳</button>
        </div>
        <div class="grid" data-grid="${section.id}">
          ${(section.items ?? []).map((item) => posterCard(item, { badge: false, score: true })).join('')}
        </div>
      </section>`).join('')}
    <div class="footer"><span>© 2026 影巢</span><span>客服邮箱：${escapeHtml(state.constants.supportEmail ?? '')}</span></div>`

  document.title = '影巢 · 高清影视在线观看'
  const heroId = banner?.targetDramaId ?? sections?.[0]?.items?.[0]?.dramaId ?? null
  $('#hero-play')?.addEventListener('click', () => {
    if (!heroId) return toast('暂无可播放内容')
    // 详情页会自己挑"首个可播/免费集"，比写死第 1 集更不容易撞付费墙
    location.hash = `#/drama/${heroId}`
  })
  $('#hero-fav')?.addEventListener('click', async (event) => {
    if (!state.token) { pendingRoute = `#/drama/${heroId}`; return openLogin() }
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
        grid.innerHTML = shuffled.items.map((item) => posterCard(item, { badge: false, score: true })).join('')
        toast('已换一批')
      } catch (error) { toast(error.message) }
    })
  })
  vipFloat()
}

// 分类页排序：服务端 sort=new|score|play
const CATEGORY_SORTS = [['new', '最新'], ['score', '评分'], ['play', '最多播放']]

async function renderCategory(type, params = new URLSearchParams()) {
  const pageSize = 24
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
  let facets = { channels: [], sorts: [], regions: [], genres: [], years: [], tags: [] }

  const channelLabel = () => (facets.channels.find((row) => row.value === state.channel) ?? { label: '全部' }).label
  const hasFilter = () => Boolean(state.region || state.year || state.genre || state.tag)
  const sortLabel = () => (facets.sorts.find((row) => row.value === state.sort) ?? { label: '最热' }).label

  const buildQuery = (nextPage) => {
    const query = new URLSearchParams({ type: state.channel, page: String(nextPage), pageSize: String(pageSize), sort: state.sort })
    for (const key of ['region', 'year', 'genre', 'tag']) if (state[key]) query.set(key, state[key])
    return query
  }
  // 筛选项写进 hash，分享/刷新后仍是同一份筛选结果（replaceState 不触发 hashchange，不会重复渲染）
  const syncHash = () => {
    const query = new URLSearchParams()
    if (state.sort !== 'hot') query.set('sort', state.sort)
    for (const key of ['region', 'year', 'genre', 'tag']) if (state[key]) query.set(key, state[key])
    const suffix = query.toString() ? `?${query.toString()}` : ''
    const next = `#/category/${state.channel}${suffix}`
    if (location.hash !== next) window.history.replaceState(null, '', next)
  }

  const first = await api(`/api/category?${buildQuery(1).toString()}`)
  total = Number(first.total ?? 0)
  baseline = total
  items = first.list ?? []
  facets = { ...facets, ...(first.facets ?? {}) }
  exhausted = items.length < pageSize

  document.title = `${state.channel === 'ALL' ? '全部分类' : channelLabel()} · 影巢`
  view.innerHTML = `
    <div class="section-head" style="margin-top:22px">
      <div class="section-title">${state.channel === 'ALL' ? '全部分类' : escapeHtml(channelLabel())}</div>
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
    return `<div class="filter-row"><span class="filter-label">${title}</span>
      <div class="subtabs">${pill('', '全部')}${shown.map((facet) => pill(facet.value, facet.label ?? facet.value, facet.count)).join('')}${options.collapsible ? more : ''}</div></div>`
  }

  const paintFilters = () => {
    const bar = $('#cat-filters')
    if (!bar) return
    const channelRow = row('频道', 'channel', facets.channels ?? [])
    const sortRow = row('排序', 'sort', facets.sorts ?? [])
    const regionRow = row('地区', 'region', facets.regions ?? [])
    const genreRow = row('类型', 'genre', (facets.genres ?? []).map((g) => ({ value: g.value, label: g.label, count: g.count })))
    const yearRow = row('年份', 'year', facets.years ?? [])
    const tagRow = expanded ? row('标签', 'tag', facets.tags ?? [], { limit: 24 }) : ''
    bar.innerHTML = `${channelRow}${sortRow}${regionRow}${genreRow}${yearRow}
      ${tagRow}
      <div class="filter-foot">
        <button class="btn-ghost sm" data-expand="1">${expanded ? '收起选项' : '更多筛选（标签）'}</button>
        ${hasFilter() ? '<button class="btn-ghost sm" id="cat-reset">清空筛选</button>' : ''}
      </div>`
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
      const activeTag = (facets.tags ?? []).find((tag) => String(tag.value) === String(state.tag))
      if (activeTag) parts.push(`#${activeTag.label}`)
      hint.textContent = parts.filter(Boolean).join(' · ')
    }
    const grid = $('#cat-grid')
    if (!grid) return
    grid.innerHTML = items.length
      ? items.map((item) => posterCard(item, { plays: true })).join('')
      : `<div class="empty" style="grid-column:1 / -1">
           ${hasFilter() ? `没有符合条件的内容 · <button class="btn-ghost sm" id="cat-reset-2">清空筛选</button>` : '这个分类暂时还没有内容'}
         </div>`
    const reset2 = $('#cat-reset-2')
    if (reset2) reset2.addEventListener('click', () => { void applyPatch({ region: '', year: '', genre: '', tag: '' }) })
    const wrap = $('#cat-more-wrap')
    if (!wrap) return
    wrap.innerHTML = items.length < total && !exhausted ? '<button class="btn-ghost" id="cat-more">加载更多</button>' : ''
    const more = $('#cat-more')
    if (!more) return
    more.addEventListener('click', async () => {
      more.disabled = true
      more.textContent = '加载中…'
      try {
        page += 1
        const next = await api(`/api/category?${buildQuery(page).toString()}`)
        const list = next.list ?? []
        if (list.length < pageSize) exhausted = true
        total = Number(next.total ?? total)
        items = items.concat(list)
        paintGrid()
      } catch (error) {
        page -= 1
        more.disabled = false
        more.textContent = '加载更多'
        toast(error.message)
      }
    })
  }

  // 所有筛选变化都走这里：改状态 → 从第 1 页重取 → 重画；失败回滚
  const applyPatch = async (patch) => {
    const previous = { ...state }
    Object.assign(state, patch)
    if (state.channel === previous.channel) { /* 频道变了要重取，其余也一样 */ }
    syncHash()
    paintFilters()
    const hint = $('#cat-hint')
    if (hint) hint.textContent = '筛选中…'
    try {
      const data = await api(`/api/category?${buildQuery(1).toString()}`)
      page = 1
      total = Number(data.total ?? 0)
      items = data.list ?? []
      facets = { ...facets, ...(data.facets ?? {}) }
      exhausted = items.length < pageSize
      // 无筛选时的 total 就是该频道全量，作为「筛选命中 N / 共 M」的分母
      if (!hasFilter()) baseline = total
    } catch (error) {
      Object.assign(state, previous)
      syncHash()
      paintFilters()
      paintGrid()
      toast(error.message)
      return
    }
    if (patch.channel) document.title = `${state.channel === 'ALL' ? '全部分类' : channelLabel()} · 影巢`
    const title = document.querySelector('.section-title')
    if (title) title.textContent = state.channel === 'ALL' ? '全部分类' : channelLabel()
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
  vipFloat()
}

async function renderRank(params) {
  const activeType = params.get('type') ?? 'HOT'
  // 榜单浏览埋点：哪个榜被看了（四榜共用 #/rank，只能靠 type 区分）
  track('rank_view', { meta: { type: activeType } })
  const data = await api(`/api/rank?type=${encodeURIComponent(activeType)}`)
  document.title = `${data.listName ?? '榜单'} · 影巢`
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
      <div class="section-title">${heading}</div>
      <div class="section-hint">${keyword
        ? `“${escapeHtml(keyword)}” 命中 ${data.total ?? 0} 部`
        : activeTag ? `共 ${data.total ?? 0} 部` : '输入关键词，或直接点下面的标签'}</div>
    </div>
    <div class="subtabs">${chips}</div>
    ${keyword || activeTag ? '' : `<div class="subtabs">${(home.hotwords ?? []).slice(0, 8).map((word) => `<a class="pill" href="#/search?q=${encodeURIComponent(word)}">${escapeHtml(word)}</a>`).join('')}</div>`}
    ${(data.list ?? []).length === 0
      ? `<div class="empty">${keyword || activeTag ? '没有找到相关剧集' : '还没有内容，先去首页看看'}</div>`
      : `<div class="grid">${data.list.map((item) => posterCard(item)).join('')}</div>`}`
  vipFloat()
}

async function renderDrama(id) {
  const detail = await api(`/api/drama/${encodeURIComponent(id)}`)
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
  const payCta = `<button class="btn-ghost" id="open-paywall">${canSingle ? '解锁全部 ¥' + priceText : '开通会员看全集'}</button>`
  const cta = episodes.length === 0
    ? '<button class="btn-primary" disabled>暂无剧集</button>'
    : entitled
      ? `<button class="btn-primary" id="play-first">▶ 继续观看${resumeNo ? `第 ${resumeNo} 集` : ''}</button>`
      : firstFree
        // 首集免费是拉新的唯一钩子：先让人看到内容，再谈付费
        ? `<button class="btn-primary" id="play-free">▶ 免费看第 ${firstFree.no} 集</button>${payCta}`
        : trialEp
          ? `<button class="btn-primary" id="play-trial" data-no="${trialEp.no}">▶ 试看 ${trialText}</button>${payCta}`
          : `<button class="btn-primary" id="open-paywall">${canSingle ? '购买本片 ¥' + priceText : '开通会员'}</button>`

  view.innerHTML = `
    <div class="detail-head">
      <div class="detail-cover"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" onerror="this.style.display='none'" /></div>
      <div class="detail-meta">
        <div class="detail-title">${escapeHtml(detail.title)} ${badgeOf(detail)}</div>
        <div class="detail-facts">
          <span>⭐ ${detail.score ?? '—'}</span>
          <span>${escapeHtml(String(detail.year ?? ''))}</span>
          <span>${escapeHtml(detail.area ?? '')}</span>
          <span>${escapeHtml(categoryLabel(detail.dramaType))}</span>
          <span>全 ${detail.episodes.length} 集</span>
          <span>${detail.freeEpisodes > 0 ? `首 ${detail.freeEpisodes} 集免费` : (canSingle ? '单片付费' : '会员专享')}</span>
        </div>
        <div class="detail-desc">${escapeHtml(detail.subTitle ?? '')}<br/>${escapeHtml(detail.description ?? '')}</div>
        ${(detail.tags ?? []).length > 0
          ? `<div class="subtabs">${detail.tags.map((tag) => `<a class="pill" href="#/search?tag=${tag.id}">${escapeHtml(tag.name)}</a>`).join('')}</div>`
          : ''}
        <div class="detail-actions">
          ${cta}
          <button class="btn-ghost" id="fav-btn">${detail.favorited ? '✓ 已收藏' : '＋ 收藏'}</button>
          <button class="btn-ghost" id="share-btn">分享</button>
        </div>
      </div>
    </div>
    <div class="section-head"><div class="section-title">选集</div><div class="section-hint">${(detail.priceInfo?.rules ?? []).length > 0 ? '部分集数单独定价，点开可见具体规则' : detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费，其余需${canSingle ? '购买' : '会员'}` : '需开通权益后观看'}</div></div>
    <div class="episodes">
      ${episodes.map((episode) => {
        // 可试看的集必须带 ?trial=1，服务端只认这个参数（否则直接 402）
        const trial = !episode.allow && episode.trialSeconds > 0 ? '?trial=1' : ''
        // 未放行的集要说清「为什么不能看」：会员可看 / 单集多少钱 / 需开通。
        // 服务端已经给出 reason 与 rule（按集定价），前端不猜价格。
        const rulePrice = Number(episode.rule?.price ?? 0)
        const flatPrice = Number(episode.price ?? 0)
        const hint = episode.allow ? ''
          : episode.reason === 'vip_required' ? '需会员'
            : rulePrice > 0 ? `¥${rulePrice.toFixed(2)}`
              : flatPrice > 0 ? `¥${flatPrice.toFixed(2)}` : '需开通'
        return `<a class="ep ${episode.allow ? '' : 'locked'}" data-no="${episode.no}" title="${escapeHtml(`第 ${episode.no} 集${hint ? ` · ${hint}` : ''}`)}" href="#/play/${detail.dramaId}/${episode.no}${trial}">
        ${episode.no}${episode.allow ? '' : ' 🔒'}${episode.trialSeconds > 0 ? ' · 试看' : ''}
      </a>`
      }).join('')}
    </div>
    <div class="footer"><span>${escapeHtml(detail.title)} · 共 ${detail.episodes.length} 集</span><span>${detail.freeEpisodes > 0 ? `前 ${detail.freeEpisodes} 集免费` : '需开通权益后观看'}</span></div>`

  $('#play-first')?.addEventListener('click', () => {
    const target = episodes.find((episode) => episode.no === resumeNo)
      ?? episodes.find((episode) => episode.allow)
      ?? episodes[0]
    if (!target) return toast('暂无剧集')
    location.hash = `#/play/${detail.dramaId}/${target.no}`
  })
  $('#play-free')?.addEventListener('click', () => {
    if (!firstFree) return
    // 未登录先登录（免费集也要账号才能记权益与进度），登录后回到本集
    if (!state.token) { pendingRoute = `#/play/${detail.dramaId}/${firstFree.no}`; openLogin(); return }
    location.hash = `#/play/${detail.dramaId}/${firstFree.no}`
  })
  $('#play-trial')?.addEventListener('click', () => {
    if (!trialEp) return
    if (!state.token) { pendingRoute = `#/play/${detail.dramaId}/${trialEp.no}?trial=1`; openLogin(); return }
    location.hash = `#/play/${detail.dramaId}/${trialEp.no}?trial=1`
  })
  $('#open-paywall')?.addEventListener('click', () => openPaywall(detail, { price: detail.singlePrice, reason: canSingle ? 'single_purchase_required' : 'subscription_required' }))
  view.querySelectorAll('.ep.locked').forEach((node) => {
    // 可试看的集优先走播放（由服务端按 trialSeconds 截断），其余才弹付费墙
    if ((node.getAttribute('href') ?? '').includes('trial=1')) return
    node.addEventListener('click', (event) => {
      event.preventDefault()
      openPaywall(detail, { price: detail.singlePrice, reason: canSingle ? 'single_purchase_required' : 'subscription_required' })
    })
  })
  $('#fav-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget
    try {
      const result = await api('/api/me/favorite', { method: 'POST', body: JSON.stringify({ dramaId: detail.dramaId }) })
      button.textContent = result.favorited ? '✓ 已收藏' : '＋ 收藏'
      toast(result.favorited ? '已收藏' : '已取消收藏')
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
  vipFloat()
}

async function renderPlay(id, episodeNo, params = new URLSearchParams()) {
  const trialMode = params.get('trial') === '1'
  const playPath = `/api/play/${encodeURIComponent(id)}/${encodeURIComponent(episodeNo)}${trialMode ? '?trial=1' : ''}`
  let data
  let detail
  try {
    data = await api(playPath)
    detail = await api(`/api/drama/${encodeURIComponent(id)}`)
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
    try { detail = await api(`/api/drama/${encodeURIComponent(id)}`) } catch { /* ignore */ }
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
  const sourceLabel = { free: '免费观看', subscription: '会员权益', purchase: '已购买', trial: '试看' }[data.source] ?? ''
  const expiredNotice = data.hls ? `播放链接 ${Math.round((data.expiresIn ?? 300) / 60)} 分钟内有效，过期自动续期` : ''

  view.innerHTML = `
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
          <select id="quality-select"><option value="-1">自动清晰度</option></select>
          <input id="danmu-input" placeholder="发条弹幕…" maxlength="60" />
          <button class="btn-ghost" id="danmu-send">发送</button>
          <button class="btn-ghost" id="share-btn">分享</button>
        </div>
        <div class="player-fail hidden" id="player-fail"><button class="btn-primary" id="player-retry">播放异常，点击重试</button></div>
      </div>
    </div>
    <div class="detail-head" style="margin-top:0">
      <div class="detail-cover" style="width:120px;flex:0 0 120px"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" /></div>
      <div class="detail-meta">
        <div class="detail-title" style="font-size:20px">${escapeHtml(detail.title)}</div>
        <div class="detail-facts"><span>${escapeHtml(detail.subTitle ?? '')}</span></div>
        <div class="chips">${detail.episodes.slice(0, 60).map((item) => {
          const trial = !item.allow && item.trialSeconds > 0 ? '?trial=1' : ''
          return `<a class="ep ${String(item.no) === String(episodeNo) ? 'active' : ''} ${item.allow ? '' : 'locked'}" data-no="${item.no}" style="display:inline-block;margin:0 6px 6px 0" href="#/play/${detail.dramaId}/${item.no}${trial}">${item.no}${item.allow ? '' : ' 🔒'}${item.trialSeconds > 0 ? ' · 试看' : ''}</a>`
        }).join('')}</div>
      </div>
    </div>`

  const video = $('#video')
  const danmuLayer = $('#danmu-layer')
  const notice = (text) => { const node = $('#player-notice'); if (node) node.textContent = text }

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
    bigPlay.textContent = '▶'
    bigPlay.addEventListener('click', () => {
      toast(hint)
      if (status === 'processing' || status === 'queued' || status === 'transcoding') {
        setTimeout(() => { if (!routeCleanups.includes(onCleanup)) return; route() }, 30000)
      }
    })
    $('#player').appendChild(bigPlay)
    vipFloat()
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

  const attach = async (url) => {
    hlsUrl = url
    if (hls) { try { hls.destroy() } catch { /* ignore */ } hls = null }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
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
    button.textContent = '▶ 播放'
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
    notice(`试看 ${trialSeconds} 秒，开通会员或购买后可看全集`)
    video.addEventListener('timeupdate', () => {
      if (trialHit || video.currentTime < trialSeconds) return
      trialHit = true
      video.pause()
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
    setTimeout(() => { location.hash = `#/play/${detail.dramaId}/${data.nextEpisodeNo}` }, 800)
  })

  // 上报节流：timeupdate 约 4Hz，按「距上次上报满 15 秒」判定，避免同秒重复写库
  let lastSavedAt = -15
  video.addEventListener('timeupdate', () => {
    if (video.currentTime - lastSavedAt < 15) return
    lastSavedAt = video.currentTime
    saveHistory()
  })

  document.title = `${data.title} 第 ${episodeNo} 集 · 影巢`
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
          <button class="btn-ghost" id="me-logout" title="退出后需重新验证邮箱登录">退出登录</button>
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
  document.title = '登录 · 影巢'
  view.innerHTML = `
    <div class="empty" style="margin-top:80px">
      <div style="font-size:18px;margin-bottom:10px">登录后即可播放与查看个人中心</div>
      <div style="color:#9aa3b2;font-size:13px;margin-bottom:18px">首页、分类、榜单、搜索与剧集详情均可直接浏览；播放与购买需要账号。</div>
      <button class="btn-primary" id="wall-login">登录 / 注册</button>
      <a class="btn-ghost" href="#/home" style="margin-left:8px">返回首页</a>
    </div>`
  $('#wall-login').addEventListener('click', openLogin)
}

async function route() {
  cleanupRoute()
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
    else if (segments[0] === 'category') await renderCategory(segments[1] ?? 'ALL', params)
    else if (segments[0] === 'rank') await renderRank(params)
    else if (segments[0] === 'search') await renderSearch(params)
    else if (segments[0] === 'drama') await renderDrama(segments[1])
    else if (segments[0] === 'play') await renderPlay(segments[1], segments[2] ?? '1', params)
    else if (segments[0] === 'playlists') await renderPlaylists()
  else if (segments[0] === 'me') await renderMe()
    else await renderHome()
  } catch (error) {
    if (error.code === '0401') {
      loginWall()
      return
    }
    view.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}<br/><br/>
      <button class="btn-primary" id="route-retry">重试</button>
      <a class="btn-ghost" href="#/home" style="margin-left:8px">返回首页</a></div>`
    $('#route-retry').addEventListener('click', () => route())
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
