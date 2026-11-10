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
  ['直播', '#/live'],
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
  const badge = item.badge ? `<span class="badge">4K</span>` : (item.feeMode === 'vip' ? '<span class="badge">VIP</span>' : '')
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
      <a class="top-action" href="#/live"><span class="ico">📺</span>直播</a>
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
  const home = await api('/api/home').catch(() => ({ hotSearch: [] }))
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px">
      <div class="section-title">搜索</div>
      <div class="section-hint">${keyword ? `“${escapeHtml(keyword)}” 命中 ${data.total} 部` : '输入关键词开始搜索'}</div>
    </div>
    <div class="subtabs">
      ${(home.hotSearch ?? []).map((word) => `<a class="pill" href="#/search?q=${encodeURIComponent(word)}">${escapeHtml(word)}</a>`).join('')}
    </div>
    ${data.content.length === 0
      ? '<div class="empty">没有找到相关剧集</div>'
      : `<div class="grid">${data.content.map((item) => posterCard(item)).join('')}</div>`}`
  vipFloat()
}

async function renderDrama(id) {
  const detail = await api(`/api/drama/${encodeURIComponent(id)}`)
  view.innerHTML = `
    <div class="detail-head">
      <div class="detail-cover"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" onerror="this.style.display='none'" /></div>
      <div class="detail-meta">
        <div class="detail-title">${escapeHtml(detail.title)}</div>
        <div class="detail-facts">
          <span>⭐ ${detail.score ?? '—'}</span>
          <span>${escapeHtml(detail.year ?? '')}</span>
          <span>${escapeHtml(detail.area ?? '')}</span>
          <span>${escapeHtml(detail.category ?? '')}</span>
          <span>全 ${detail.episodes.length} 集</span>
          <span>${detail.feeMode === 'vip' ? 'VIP 专享' : '免费观看'}</span>
        </div>
        <div class="detail-desc">${escapeHtml(detail.subTitle)}<br/>${escapeHtml(detail.description)}</div>
        <div class="chips">
          ${(detail.actors ?? []).map((actor) => `<span class="chip">${escapeHtml(actor.name)}${actor.role ? ' · ' + escapeHtml(actor.role) : ''}</span>`).join('')}
        </div>
        <div class="detail-actions">
          <button class="btn-primary" id="play-first">▶ 播放第 1 集</button>
          <button class="btn-ghost" id="fav-btn">＋ 收藏</button>
          <button class="btn-ghost" id="share-btn">分享</button>
        </div>
      </div>
    </div>
    <div class="section-head"><div class="section-title">选集</div><div class="section-hint">点击播放，VIP 集数需要订阅</div></div>
    <div class="episodes">
      ${detail.episodes.map((episode) => `<a class="ep" href="#/play/${encodeURIComponent(detail.seasonId)}/${episode.no}">第 ${episode.no} 集${episode.vip ? ' · VIP' : ''}</a>`).join('')}
    </div>
    <div class="footer"><span>seasonId ${escapeHtml(detail.seasonId)}</span><span>数据形状对应 /m-station/drama/intro + /m-station/drama/play</span></div>`

  $('#play-first').addEventListener('click', () => { location.hash = `#/play/${detail.seasonId}/1` })
  $('#fav-btn').addEventListener('click', async () => {
    try {
      const result = await api('/api/me/favorite', { method: 'POST', body: JSON.stringify({ seasonId: detail.seasonId }) })
      toast(result.favorited ? '已收藏' : '已取消收藏')
    } catch (error) {
      if (error.code === '0401') openLogin(); else toast(error.message)
    }
  })
  $('#share-btn').addEventListener('click', () => toast('已复制分享链接（演示）'))
  vipFloat()
}

async function renderPlay(id, episodeNo) {
  let data
  try {
    data = await api(`/api/play/${encodeURIComponent(id)}/${encodeURIComponent(episodeNo)}`)
  } catch (error) {
    if (error.code === '0401') {
      view.innerHTML = `<div class="empty">${escapeHtml(error.message)}<br/><br/><button class="btn-primary" id="play-login">登录后播放</button></div>`
      $('#play-login').addEventListener('click', openLogin)
      return
    }
    view.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`
    return
  }

  const detail = await api(`/api/drama/${encodeURIComponent(id)}`)
  view.innerHTML = `
    <div class="player-wrap">
      <div class="player-bar">
        <span>${escapeHtml(data.title)} · 第 ${escapeHtml(episodeNo)} 集</span>
        <span style="margin-left:auto">${data.hls ? 'HLS 720p · 已转码' : '未上传片源（演示画面）'}</span>
      </div>
      <div class="player" id="player">
        <video id="video" playsinline controls style="width:100%;height:100%;background:#000"></video>
        ${data.hls ? '' : '<button class="big-play" id="big-play">▶</button>'}
        <div class="danmu-layer" id="danmu-layer"></div>
        <div class="notice" id="player-notice">${data.hls ? 'HLS 由本机 ffmpeg 转码生成' : '该集还没有片源：后台「分集/视频」上传或生成示例视频后即可播放'}</div>
      </div>
    </div>
    <div class="detail-head" style="margin-top:0">
      <div class="detail-cover" style="width:120px;flex:0 0 120px"><img src="${escapeHtml(mediaUrl(detail.coverUrl))}" alt="" /></div>
      <div class="detail-meta">
        <div class="detail-title" style="font-size:20px">${escapeHtml(detail.title)}</div>
        <div class="detail-facts"><span>${escapeHtml(detail.subTitle)}</span></div>
        <div class="chips">${detail.episodes.slice(0, 40).map((item) => `<a class="ep ${String(item.no) === String(episodeNo) ? 'active' : ''}" style="display:inline-block;margin:0 6px 6px 0" href="#/play/${detail.seasonId}/${item.no}">${item.no}</a>`).join('')}</div>
      </div>
    </div>`

  const video = $('#video')
  const danmuLayer = $('#danmu-layer')
  const danmu = Array.isArray(data.danmu) && data.danmu.length > 0 ? data.danmu : []
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
      body: JSON.stringify({ seasonId: detail.seasonId, episode: Number(episodeNo), position: Math.round(video.currentTime || 0) }),
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
        } else {
          video.src = BASE + data.hls
        }
      } catch {
        video.src = BASE + data.hls
        $('#player-notice').textContent = 'hls.js 加载失败（离线？），已改用浏览器原生 HLS 尝试'
      }
    }
    video.addEventListener('play', startDanmu, { once: true })
    video.addEventListener('pause', saveHistory)
    video.addEventListener('timeupdate', () => { if (Math.floor(video.currentTime) % 15 === 0) saveHistory() })
  } else {
    $('#big-play').addEventListener('click', () => {
      startDanmu()
      toast('该集没有片源：后台生成示例视频后即可真正播放')
      saveHistory()
    })
  }
  vipFloat()
}

async function renderLive() {
  const data = await api('/api/live')
  view.innerHTML = `
    <div class="section-head" style="margin-top:26px">
      <div class="section-title">直播</div>
      <div class="section-hint">RTMP 入流 → HLS 出流（MediaMTX）</div>
    </div>
    ${data.streams.length === 0 ? '<div class="empty">暂无直播频道：后台「直播推流」里新建一个</div>' : data.streams.map((stream) => `
      <div class="player-wrap">
        <div class="player-bar"><span>${escapeHtml(stream.name)}</span><span style="margin-left:auto">${escapeHtml(stream.status)}</span></div>
        <div class="player" style="aspect-ratio:16/9">
          <video data-live="${escapeHtml(stream.hls)}" controls playsinline style="width:100%;height:100%;background:#000"></video>
          <div class="notice">推流地址：${escapeHtml(stream.rtmp)}</div>
        </div>
      </div>`).join('')}`
  for (const video of view.querySelectorAll('[data-live]')) {
    const src = BASE + video.dataset.live
    try {
      const { default: Hls } = await import('https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.mjs')
      if (Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: true })
        hls.loadSource(src)
        hls.attachMedia(video)
        continue
      }
    } catch { /* 走原生 */ }
    video.src = src
  }
  vipFloat()
}

async function renderMe() {
  if (!state.token) {
    view.innerHTML = `
      <div class="section-head" style="margin-top:26px"><div class="section-title">我的</div></div>
      <div class="empty">登录后可以同步观看历史与收藏<br/><br/><button class="btn-primary" id="me-login">登录 / 注册</button></div>`
    $('#me-login').addEventListener('click', openLogin)
    return
  }
  const data = await api('/api/me')
  view.innerHTML = `
    <div class="tabs"><button class="tab active">观看历史</button><button class="tab">我的收藏</button></div>
    ${data.history.length === 0 && data.favorites.length === 0
      ? '<div class="empty">还没有记录：去播放一集，或收藏几部剧</div>'
      : `<div class="grid">${[...data.history.map((item) => ({ dramaId: item.seasonId, title: item.title, subTitle: `看到第 ${item.episode} 集`, coverUrl: item.coverUrl })), ...data.favorites].map((item) => posterCard(item)).join('')}</div>`}
    <div class="footer"><span>历史/收藏在本机服务端内存里，重启清零；真实站是 /m-station/user/history 与 /m-station/behavior/like/add</span></div>`
  vipFloat()
}

/* ---------------- 路由 ---------------- */

async function route() {
  renderChrome()
  const hash = location.hash || '#/home'
  const [pathPart, queryPart] = hash.slice(1).split('?')
  const params = new URLSearchParams(queryPart ?? '')
  const segments = pathPart.split('/').filter(Boolean)
  try {
    if (segments[0] === 'home' || segments.length === 0) await renderHome()
    else if (segments[0] === 'category') await renderCategory(segments[1] ?? 'ALL')
    else if (segments[0] === 'rank') await renderRank(params)
    else if (segments[0] === 'search') await renderSearch(params)
    else if (segments[0] === 'drama') await renderDrama(segments[1])
    else if (segments[0] === 'play') await renderPlay(segments[1], segments[2] ?? '1')
    else if (segments[0] === 'me') await renderMe()
    else if (segments[0] === 'live') await renderLive()
    else await renderHome()
  } catch (error) {
    view.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`
  }
  window.scrollTo(0, 0)
}

window.addEventListener('hashchange', route)
state.constants = await api('/api/constants').catch(() => ({}))
await route()
