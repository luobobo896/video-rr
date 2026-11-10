/** 影巢复刻站前端：hash 路由 + 原生模板渲染，零构建。 */
const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const sidebar = $('#sidebar')
const topbar = $('#topbar')

const NAV_MAIN = [
  ['精选', '#/home'],
  ['电影', '#/category/MOVIE'],
  ['美剧', '#/category/TV'],
  ['短剧', '#/category/PLAYLET'],
  ['动漫', '#/category/COMIC'],
  ['综艺', '#/category/VARIETY'],
  ['纪录片', '#/category/DOCUMENTARY'],
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
  if (json.code !== '0000') throw new Error(json.msg || '接口失败')
  return json.data
}

async function login(phone) {
  const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone }) })
  state.token = data.token
  state.user = data.user
  localStorage.setItem('mh-token', data.token)
  localStorage.setItem('mh-user', JSON.stringify(data.user))
  toast(`已登录：${data.user?.nickname ?? phone}`)
  renderChrome()
  await route()
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

function openLogin() {
  const modal = $('#modal')
  modal.classList.remove('hidden')
  modal.innerHTML = `
    <div class="modal-card">
      <h3>登录 / 注册</h3>
      <p>演示站用手机号直接登录（真实站走短信验证码 + token）。</p>
      <input id="login-phone" placeholder="11 位手机号" style="width:100%;padding:10px 12px;margin-top:10px;border-radius:8px;border:1px solid var(--line);background:var(--bg-elev);color:var(--text)" />
      <div style="display:flex;gap:8px;margin-top:14px">
        <button class="btn-primary" id="login-submit">登录</button>
        <button class="btn-ghost" id="login-cancel">取消</button>
      </div>
    </div>`
  const close = () => modal.classList.add('hidden')
  $('#login-cancel').addEventListener('click', close)
  $('#login-submit').addEventListener('click', async () => {
    const phone = $('#login-phone').value.trim()
    if (!/^1\d{10}$/.test(phone)) { toast('手机号格式不对'); return }
    try { await login(phone); close() } catch (error) { toast(error.message) }
  })
  modal.addEventListener('click', (event) => { if (event.target === modal) close() }, { once: true })
}

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

const ACCESS_LABEL = { free: '免费', subscription: '会员', subscribed: '已开通', paid: '单片', owned: '已购' }
const PAY = { mock: true, alipay: false, usdt: true, usdtNetwork: 'TRC20' }
const defaultChannel = () => (PAY.mock ? 'mock' : PAY.usdt ? 'usdt' : 'alipay')
const channelList = () => [
  PAY.mock && { code: 'mock', label: '模拟支付（演示）' },
  PAY.alipay && { code: 'alipay', label: '支付宝' },
  PAY.usdt && { code: 'usdt', label: `USDT（${PAY.usdtNetwork}）` },
].filter(Boolean)
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
  for (let i = 0; i < 40; i++) {
    const data = await api(`/api/orders/${outTradeNo}`)
    onTick?.(data)
    if (data.status === 'fulfilled' || data.status === 'paid') return data
    if (data.status === 'closed' || data.status === 'refunded') return data
    await new Promise((resolve) => setTimeout(resolve, 2000))
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

  $('#pay-channels').innerHTML = channelList().map((channel) => `<button class="channel" data-channel="${channel.code}">${channel.label}</button>`).join('')

  const go = async (channel, payload) => {
    if (!state.token) { close(); openLogin(); return }
    $('#paywall-msg').textContent = '正在创建订单…'
    try {
      const order = await createOrder({ ...payload, channel, couponCode })
      $('#paywall-msg').textContent = `订单 ${order.outTradeNo} 已创建，金额 ¥${order.amount.toFixed(2)}`
      if (order.payUrl) window.open(order.payUrl.startsWith('http') ? order.payUrl : BASE + order.payUrl, '_blank', 'width=520,height=680')
      if (order.simulated) $('#paywall-msg').textContent = '已打开支付宝（沙箱）收银台，付款后自动到账'
      if (order.usdt) {
        $('#paywall-msg').innerHTML = `请向 <b>${escapeHtml(order.usdt.address)}</b> 转入 <b>${order.usdt.amount} USDT</b>（${order.usdt.network}），15 分钟内有效`
      }
      const done = await waitOrderPaid(order.outTradeNo, (tick) => {
        $('#paywall-msg').textContent = `等待支付… 状态：${tick.status}`
      })
      if (done && (done.status === 'fulfilled' || done.status === 'paid')) {
        toast('支付成功，权益已到账')
        close()
        renderChrome()
        route()
      } else {
        $('#paywall-msg').textContent = '订单未完成（超时或已关闭），可重新下单'
      }
    } catch (error) {
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
    <h4>双11钜惠 开通 VIP</h4>
    <p>包年订阅首年，四端通用</p>
    <div><span class="vip-price">${state.constants.vipPrice ?? '7.3'}</span><small> ${state.constants.vipUnit ?? '元/月'}</small></div>
    <button class="vip-cta">查看详情</button>`
  node.querySelector('.vip-close').addEventListener('click', () => { state.vipDismissed = true; node.remove() })
  node.querySelector('.vip-cta').addEventListener('click', () => openModal('VIP 订阅（演示）', '真实站会跳转到 H5 收银台（/m-station/create_common_purchase_h5 + 支付轮询 /m-station/selling/pay/polling）。'))
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
    <div class="footer"><span>© 2026 影巢（复刻演示）</span><span>数据来自公开页面抓取，仅用于技术验证</span><span>接口契约见 API.md</span></div>`

  $('#hero-play').addEventListener('click', () => { location.hash = `#/play/${banner?.targetUrl ?? 60535}/1` })
  $('#hero-fav').addEventListener('click', () => toast('已加入收藏（本地）'))
  view.querySelectorAll('[data-refresh]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.refresh
      const grid = view.querySelector(`[data-grid="${id}"]`)
      const shuffled = await api(`/api/feed?seed=${Math.floor(Math.random() * 999)}`)
      grid.innerHTML = shuffled.items.map((item) => posterCard(item)).join('')
      toast('已换一批')
    })
  })
  vipFloat()
}

async function renderCategory(type) {
  const data = await api(`/api/category?type=${encodeURIComponent(type)}`)
  const label = { MOVIE: '电影', TV: '美剧', PLAYLET: '短剧', COMIC: '动漫', VARIETY: '综艺', DOCUMENTARY: '纪录片' }[type] ?? type
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px">
      <div class="section-title">${escapeHtml(label)}</div>
      <div class="section-hint">共 ${data.total} 部 · 按更新时间</div>
    </div>
    ${data.content.length === 0
      ? '<div class="empty">该分类暂无数据（演示库样本有限，接口形状与真实站一致）</div>'
      : `<div class="grid">${data.content.map((item) => posterCard(item)).join('')}</div>`}`
  vipFloat()
}

async function renderRank(params) {
  const data = await api('/api/rank')
  const activeType = params.get('type') ?? 'HOT'
  const container = data.containerList.find((item) => item.topList.some((top) => top.type === activeType)) ?? data.containerList[0]
  view.innerHTML = `
    <div class="tabs">
      ${data.containerList.map((item) => `<button class="tab ${item.id === container.id ? 'active' : ''}">${escapeHtml(item.name)}</button>`).join('')}
    </div>
    <div class="subtabs">
      ${container.topList.map((top, index) => `<a class="pill ${index === 0 ? 'active' : ''}" href="#/rank?type=${encodeURIComponent(top.type)}">${escapeHtml(top.name)}</a>`).join('')}
    </div>
    <div class="grid">
      ${data.list.map((item, index) => posterCard(item, { rank: index + 1 })).join('')}
    </div>
    <div class="footer"><span>${escapeHtml(container.name)} · 每小时更新</span></div>`
  view.querySelectorAll('.tab').forEach((tab, index) => {
    tab.addEventListener('click', () => { view.querySelectorAll('.tab').forEach((node) => node.classList.remove('active')); tab.classList.add('active') })
    void index
  })
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
  const cta = access === 'owned' || access === 'subscribed'
    ? '<button class="btn-primary" id="play-first">▶ 继续观看</button>'
    : `<button class="btn-primary" id="open-paywall">${canSingle ? '购买本片 ¥' + Number(detail.singlePrice ?? 0).toFixed(0) : '开通会员'} </button>`

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
    <div class="footer"><span>剧集 #${detail.dramaId}</span><span>权益判定：/api/access/:dramaId/:no</span></div>`

  $('#play-first')?.addEventListener('click', () => {
    const first = detail.episodes.find((episode) => episode.allow) ?? detail.episodes[0]
    location.hash = `#/play/${detail.dramaId}/${first.no}`
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
  $('#share-btn').addEventListener('click', () => toast('已复制分享链接（演示）'))
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
        <div class="notice" id="player-notice">${data.hls ? '播放链接 10 分钟有效（签名防盗链）' : '该集没有片源：后台生成示例视频后即可播放'}</div>
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

  const startDanmu = () => {
    clearInterval(danmuTimer)
    if (danmu.length === 0) return
    danmuTimer = setInterval(() => {
      const current = video.currentTime * 1000
      const upcoming = danmu.find((item) => item.time >= current && item.time <= current + 1500)
      const text = upcoming?.text ?? danmu[Math.floor(Math.random() * danmu.length)]?.text
      if (!text) return
      const node = document.createElement('span')
      node.className = 'danmu'
      node.textContent = text
      node.style.top = `${8 + Math.random() * 70}%`
      node.style.animationDuration = `${6 + Math.random() * 4}s`
      danmuLayer.appendChild(node)
      setTimeout(() => node.remove(), 11000)
    }, 1200)
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
        const { default: Hls } = await import('https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.mjs')
        if (Hls.isSupported()) {
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
    video.addEventListener('timeupdate', () => { if (Math.floor(video.currentTime) % 15 === 0) saveHistory() })
  } else {
    const bigPlay = document.createElement('button')
    bigPlay.className = 'big-play'
    bigPlay.textContent = '▶'
    bigPlay.addEventListener('click', () => { startDanmu(); saveHistory(); toast('没有片源：后台生成示例视频后即可播放') })
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
      <div class="section-hint">${escapeHtml(data.user.nickname)} · ${escapeHtml(data.user.phone ?? '')}</div></div>
    <div class="me-grid">
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
        ${orders.length === 0 ? '<div class="me-sub">暂无订单</div>' : orders.slice(0, 6).map((order) => `<div class="me-row"><span>${escapeHtml(order.out_trade_no)}</span><span>¥${Number(order.amount_cny).toFixed(2)} · ${escapeHtml(order.status)}</span></div>`).join('')}
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
  vipFloat()
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
  const isHome = segments.length === 0 || segments[0] === 'home'
  // 登录门禁：未登录只能看首页（其余路由一律显示登录墙）
  if (!state.token && !isHome) {
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

window.addEventListener('hashchange', route)
state.constants = await api('/api/constants').catch(() => ({}))
if (state.constants?.pay) Object.assign(PAY, state.constants.pay)
await route()
