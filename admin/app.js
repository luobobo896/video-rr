/** 影巢运营后台（原生 ESM，无构建）。 */
import { adminUi } from './ui.js'

const BASE = window.__MH_BASE || ''
const SITE_BASE = BASE.replace(/-admin$/, '')
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : SITE_BASE + url)
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const nav = $('#nav')
const openSite = $('#open-site')
$('.skip-link')?.addEventListener('click', (event) => {
  event.preventDefault()
  view.focus()
  view.scrollIntoView({ block: 'start' })
})
if (openSite) openSite.href = BASE ? `${BASE.replace(/-admin$/, '')}/` : '/'
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'
document.addEventListener('error', (event) => {
  const img = event.target
  if (img instanceof HTMLImageElement && img.dataset.imgFallback === 'hide') img.style.visibility = 'hidden'
}, true)

/* 菜单分组：后台按「看 / 内容 / 交易 / 用户 / 系统」分区，默认折叠非当前区，避免 18 项平铺。 */
const NAV_GROUPS = [
  {
    id: 'overview', title: '数据概览',
    items: [
      ['dashboard', '概览', 'dashboard.read'],
      ['analytics', '经营数据', 'analytics.read'],
      ['events', '埋点数据', 'ops.events.read'],
      ['channels', '渠道分析', 'growth.channel.read'],
    ],
  },
  {
    id: 'content', title: '内容运营',
    items: [
      ['dramas', '剧集管理', 'content.drama.read'],
      ['adult-settings', '成人菜单', 'content.drama.write'],
      ['policies', '付费策略', 'content.policy.write'],
      ['tags', '标签管理', 'tag.read'],
      ['ops', '首页运营', 'ops.banner.write&ops.section.write'],
      ['ranks', '榜单', 'ops.rank.write'],
      ['content-stats', '内容统计', 'growth.content.read'],
      ['review', '内容审核', 'content.review'],
    ],
  },
  {
    id: 'commerce', title: '交易与财务',
    items: [
      ['plans', '套餐定价', 'commerce.plan.write'],
      ['coupons', '优惠券', 'commerce.coupon.write'],
      ['orders', '订单', 'finance.order.read'],
      ['refunds', '退款审核', 'finance.order.read'],
      ['distribution', '分销分析', 'growth.distribution.read'],
      ['distribution-config', '分销配置', 'growth.distribution.write'],
    ],
  },
  {
    id: 'users', title: '用户',
    items: [
      ['users', 'C 端用户', 'user.read'],
    ],
  },
  {
    id: 'system', title: '系统设置',
    items: [
      ['roles', '角色管理', 'admin.read'],
      ['menus', '菜单管理', 'system.menu'],
      ['admins', '用户管理', 'system.admin'],
      ['audit', '审计日志', 'audit.read'],
      ['pay', '支付渠道', 'payment.channel.read'],
      ['email', '邮件设置', 'email.read'],
    ],
  },
]

/** 扁平索引：路由与标题查表用，保持与原 NAV 数组同构 [key, label, perm]。 */
const navFlat = () => navGroups().flatMap((group) => group.items)
const hasPerm = (perm, perms) => !perm || String(perm).split('&').every((item) => perms.has(item))

/**
 * 侧边栏数据源：优先用 /admin/api/me 下发的 admin_menus（运营可在「菜单管理」里改），
 * 接口没返回时退回内置默认值，保证后台在接口异常时仍可用。
 */
function navGroups() {
  const remote = state.me?.menus
  if (Array.isArray(remote) && remote.length) {
    return remote.map((group) => ({
      id: group.key,
      title: group.label,
      items: (group.items ?? []).map((item) => [String(item.route ?? '').replace(/^\//, ''), item.label, item.permCode, item.icon, item.visible !== false]),
    }))
  }
  return NAV_GROUPS
}

const state = { token: localStorage.getItem('mh-admin-token') ?? '', page: 'dashboard', params: {}, timers: [], episodeImporting: false }
let apiSignal = null
let routeSeq = 0
let routeController = null

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : n ?? '—')
/** 数据库时间是 UTC，后台统一按北京时间展示，避免与 C 端同一订单相差 8 小时。 */
const fmtTs = (value) => {
  if (!value) return '—'
  const text = String(value).trim()
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? text.replace(' ', 'T') + 'Z' : text
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return text
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function toast(text) {
  const node = $('#toast')
  node.textContent = text
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), 2000)
}

async function api(path, options = {}) {
  const { timeoutMs = 15000, signal: externalSignal, ...fetchOptions } = options
  const headers = { ...(fetchOptions.headers ?? {}) }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  if (fetchOptions.body !== undefined && !(fetchOptions.body instanceof Blob)) headers['content-type'] = 'application/json'
  const url = BASE ? path.replace('/admin/api', BASE + '/api') : path
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
      res = await fetch(url, {
        ...fetchOptions,
        headers,
        body: fetchOptions.body === undefined ? undefined : (fetchOptions.body instanceof Blob ? fetchOptions.body : JSON.stringify(fetchOptions.body)),
        signal: controller.signal,
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (timedOut) throw Object.assign(new Error('请求超时，请检查网络后重试'), { code: 'timeout' })
        throw Object.assign(new Error('请求已取消'), { name: 'AbortError', code: 'aborted' })
      }
      throw new Error('网络异常，请检查网络后重试')
    }
    const text = await res.text()
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      // 反代 502/504 会回 HTML，之前被 catch 成 {code:'0000'} 显示成空表，掩盖了故障
      throw new Error(res.ok ? '服务返回了非预期内容，请稍后重试' : `服务暂时不可用（${res.status}），请稍后重试`)
    }
    if (json.code === '0401') { logout(); throw new Error(json.msg ?? '未登录') }
    if (!res.ok && json.code === undefined) throw new Error(`服务暂时不可用（${res.status}），请稍后重试`)
    if (json.code !== '0000') throw new Error(json.msg ?? `请求失败 ${path}`)
    return json.data
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

function clearTimers() {
  for (const timer of state.timers) clearInterval(timer)
  state.timers = []
}

const OVERLAY_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const overlayStack = []
let overlaySeq = 0

function overlayFocusable(mask) {
  return [...mask.querySelectorAll(OVERLAY_FOCUSABLE)].filter((node) => !node.hidden && node.getClientRects().length > 0)
}

function syncOverlayInert() {
  const shell = $('#shell')
  if (shell) shell.inert = overlayStack.length > 0
}

const overlayObserver = new MutationObserver(() => {
  let changed = false
  const restore = []
  while (overlayStack.length && !overlayStack[overlayStack.length - 1].mask.isConnected) {
    const item = overlayStack.pop()
    item.onClose?.()
    if (item.previous?.isConnected) restore.push(item.previous)
    changed = true
  }
  if (changed) {
    syncOverlayInert()
    restore.forEach((node) => node.focus())
  }
})
overlayObserver.observe(document.body, { childList: true })

document.addEventListener('keydown', (event) => {
  const top = overlayStack[overlayStack.length - 1]
  if (!top) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (typeof top.mask._overlayClose === 'function') top.mask._overlayClose()
    else top.mask.remove()
    return
  }
  if (event.key !== 'Tab') return
  const items = overlayFocusable(top.mask)
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

/** 轻量弹层：后台没有引入组件库，用一层 mask 包住表单/向导。 */
function openOverlay(title, bodyHtml, onMount, options = {}) {
  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.setAttribute('role', 'presentation')
  const titleId = `overlay-title-${++overlaySeq}`
  mask.innerHTML = `<div class="modal-box ${esc(options.className ?? '')}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
    <header><h3 id="${titleId}">${esc(title)}</h3><button class="btn sm" data-close>关闭</button></header>
    <div class="modal-body">${bodyHtml}</div>
  </div>`
  const previous = document.activeElement
  document.body.appendChild(mask)
  overlayStack.push({ mask, previous, onClose: options.onClose })
  syncOverlayInert()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    options.onClose?.()
    mask.remove()
  }
  mask._overlayClose = close
  mask.querySelector('[data-close]').addEventListener('click', close)
  mask.addEventListener('click', (event) => { if (event.target === mask) close() })
  onMount?.(mask.querySelector('.modal-body'), close)
  const target = mask.querySelector('[autofocus]')
    ?? mask.querySelector('.modal-body input:not([type="hidden"]), .modal-body select, .modal-body textarea')
    ?? overlayFocusable(mask)[0]
  requestAnimationFrame(() => target?.focus())
  return close
}

function askText({
  title,
  label,
  value = '',
  placeholder = '',
  hint = '',
  confirmText = '确定',
  required = true,
  minLength = 0,
} = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    openOverlay(title, `
      <form class="overlay-form">
        <label class="field"><span>${esc(label)}</span>
          <input id="overlay-text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" autofocus />
        </label>
        ${hint ? `<p class="muted small">${esc(hint)}</p>` : ''}
        <p class="field-error" id="overlay-text-error" role="alert"></p>
        <div class="modal-foot">
          <button class="btn" type="button" data-cancel>取消</button>
          <button class="btn primary" type="submit">${esc(confirmText)}</button>
        </div>
      </form>`, (body, close) => {
      const form = body.querySelector('.overlay-form')
      const input = body.querySelector('#overlay-text')
      const error = body.querySelector('#overlay-text-error')
      const submit = body.querySelector('[type="submit"]')
      const submitValue = () => {
        const next = input.value.trim()
        if (required && !next) {
          error.textContent = `请填写${label}`
          input.focus()
          return
        }
        if (minLength && next.length < minLength) {
          error.textContent = `至少填写 ${minLength} 个字`
          input.focus()
          return
        }
        finish(next)
        close()
      }
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        submitValue()
      })
      body.querySelector('[data-cancel]').addEventListener('click', () => {
        finish(null)
        close()
      })
      input.addEventListener('input', () => {
        error.textContent = ''
        submit.disabled = required && !input.value.trim()
      })
      submit.disabled = required && !input.value.trim()
    }, { onClose: () => finish(null), className: 'overlay-confirm' })
  })
}

function askConfirm({
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    openOverlay(title, `
      <p class="settings-modal-copy">${esc(message)}</p>
      <div class="modal-foot">
        <button class="btn" type="button" data-cancel>${esc(cancelText)}</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" type="button" data-confirm autofocus>${esc(confirmText)}</button>
      </div>`, (body, close) => {
      body.querySelector('[data-cancel]').addEventListener('click', () => {
        finish(false)
        close()
      })
      body.querySelector('[data-confirm]').addEventListener('click', () => {
        finish(true)
        close()
      })
    }, { onClose: () => finish(false), className: 'overlay-confirm' })
  })
}

function showNotice({ title, message, code = '', confirmText = '知道了' } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    openOverlay(title, `
      <p class="settings-modal-copy">${esc(message)}</p>
      ${code ? `<div class="notice-code"><code>${esc(code)}</code><button class="btn sm" type="button" data-copy-code>复制</button></div>` : ''}
      <div class="modal-foot"><button class="btn primary" type="button" data-notice-close autofocus>${esc(confirmText)}</button></div>`,
    (body, close) => {
      body.querySelector('[data-notice-close]').addEventListener('click', () => {
        finish()
        close()
      })
      body.querySelector('[data-copy-code]')?.addEventListener('click', async (event) => {
        try {
          await navigator.clipboard.writeText(code)
          event.currentTarget.textContent = '已复制'
        } catch {
          toast('复制失败，请手动选择验证码')
        }
      })
    }, { onClose: finish, className: 'overlay-notice' })
  })
}

/* ---------------- 登录 / 改密 ---------------- */
let pendingPassword = ''

function showPassForm({ tip = '' } = {}) {
  $('#login').classList.remove('hidden')
  $('#login-form').classList.add('hidden')
  $('#pass-form').classList.remove('hidden')
  $('#pass-old').value = pendingPassword
  $('#pass-new').value = ''
  $('#pass-confirm').value = ''
  $('#pass-tip').textContent = tip
}

function hidePassForm() {
  $('#pass-form').classList.add('hidden')
  $('#login-form').classList.add('hidden')
  $('#shell').classList.remove('hidden')
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const tip = $('#login-tip')
  tip.textContent = ''
  const password = $('#login-pass').value
  try {
    const data = await api('/admin/api/login', { method: 'POST', body: { username: $('#login-user').value, password } })
    state.token = data.token
    localStorage.setItem('mh-admin-token', data.token)
    if (data.mustChangePassword) {
      pendingPassword = password
      $('#login').classList.remove('hidden')
      showPassForm({ tip: '首次登录或密码已被重置，请先设置新密码' })
      return
    }
    await boot()
  } catch (error) {
    tip.textContent = error.message
  }
})

$('#pass-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const tip = $('#pass-tip')
  tip.textContent = ''
  const next = $('#pass-new').value
  if (next !== $('#pass-confirm').value) { tip.textContent = '两次输入的新密码不一致'; return }
  try {
    const data = await api('/admin/api/password', { method: 'POST', body: { oldPassword: $('#pass-old').value, newPassword: next } })
    if (data?.token) {
      state.token = data.token
      localStorage.setItem('mh-admin-token', data.token)
    }
    pendingPassword = ''
    $('#login-pass').value = ''
    $('#pass-form').classList.add('hidden')
    hidePassForm()
    await boot()
  } catch (error) {
    tip.textContent = error.message
  }
})

$('#change-pass').addEventListener('click', () => {
  pendingPassword = ''
  $('#shell').classList.add('hidden')
  showPassForm({ tip: '修改成功后建议重新登录' })
})

$('#logout').addEventListener('click', () => logout())
async function logout() {
  const currentToken = state.token
  if (currentToken) {
    try {
      await fetch(BASE ? `${BASE}/api/logout` : '/admin/api/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${currentToken}` },
      })
    } catch { /* 本地退出优先，网络失败不影响清理 */ }
  }
  routeController?.abort()
  clearTimers()
  closeAllOverlays()
  state.token = ''
  state.me = undefined
  localStorage.removeItem('mh-admin-token')
  $('#shell').classList.add('hidden')
  $('#login').classList.remove('hidden')
  $('#login-form').classList.remove('hidden')
  $('#pass-form').classList.add('hidden')
}

/* ---------------- 路由 ---------------- */
const NAV_OPEN_KEY = 'mh-admin-nav-open'

const readOpenGroups = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(NAV_OPEN_KEY) ?? 'null')
    if (Array.isArray(saved)) return new Set(saved)
  } catch { /* 存储损坏就当没存过 */ }
  return new Set(['overview', 'content'])
}

function renderNav() {
  const perms = new Set(state.me?.permissions ?? [])
  const open = readOpenGroups()
  adminUi.groups = navGroups()
    .map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items
        .filter(([, , perm, , visible = true]) => visible !== false && hasPerm(perm, perms))
        .map(([key, label]) => ({ key, label })),
    }))
    .filter((group) => group.items.length)
  adminUi.active = state.page
  adminUi.openKeys = [...open]
  const who = $('#whoami')
  if (who) who.textContent = state.me ? `${state.me.admin.username}${(state.me.roles ?? []).length ? ` · ${(state.me.roles ?? []).map((role) => role.name).join(' / ')}` : ''}` : ''
}

/** 只切 active，不重建菜单：切换页面时侧栏不抖动、不滚回顶部。 */
function highlightNav() {
  adminUi.active = state.page
  requestAnimationFrame(() => {
    const active = nav.querySelector('.el-menu-item.is-active')
    if (!active || !active.offsetParent) return
    const box = nav.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    const padding = 6
    if (item.top < box.top + padding) nav.scrollTop -= box.top + padding - item.top
    else if (item.bottom > box.bottom - padding) nav.scrollTop += item.bottom - (box.bottom - padding)
  })
}

window.addEventListener('hashchange', () => route())

async function boot() {
  try {
    state.me = await api('/admin/api/me')
  } catch { logout(); return }
  $('#login').classList.add('hidden')
  $('#shell').classList.remove('hidden')
  renderNav()
  await route()
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

function closeAllOverlays() {
  while (overlayStack.length) {
    const item = overlayStack.pop()
    item.onClose?.()
    if (item.mask?.isConnected) item.mask.remove()
  }
  syncOverlayInert()
}

async function route() {
  // 页面级导航必须收掉上一页的弹层，否则弹窗会悬浮在新页面上并可能提交到错误上下文。
  closeAllOverlays()
  const seq = ++routeSeq
  routeController?.abort()
  const controller = new AbortController()
  routeController = controller
  apiSignal = controller.signal
  clearTimers()
  setRouteBusy(true)
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard'
  state.page = hash.split('?')[0].split('/')[0]
  const topRight = $('#top-right')
  if (topRight) topRight.innerHTML = `<span class="muted">更新于 ${new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</span>`
  if (state.page === 'permissions') {
    history.replaceState(null, '', '#/roles')
    state.page = 'roles'
  }
  // 菜单切换是页面级导航：立即回到顶部，避免新页面继承上一页滚动位置后二次跳动。
  if (window.scrollY > 0) window.scrollTo(0, 0)
  const flat = navFlat()
  const navItem = flat.find(([id]) => id === state.page)
  const key = navItem ? state.page : 'dashboard'
  const perm = (flat.find(([id]) => id === key) ?? [])[2]
  const perms = new Set(state.me?.permissions ?? [])
  $('#page-title').textContent = flat.find(([id]) => id === key)?.[1] ?? key
  // 切页只更新高亮；目标页在折叠分组里时才重绘一次展开状态（避免每次导航都重建侧栏）
  const activeGroup = navGroups().find((group) => group.items.some(([id]) => id === key))
  const open = readOpenGroups()
  if (activeGroup && !open.has(activeGroup.id)) {
    open.add(activeGroup.id)
    localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...open]))
    renderNav()
  }
  highlightNav()
  // 页面级权限守卫：菜单已经按权限隐藏，手改 hash 时也不发请求、不渲染空表
  if (!hasPerm(perm, perms)) {
    view.innerHTML = `<div class="card empty-card"><h3>无权限访问</h3>
      <p>当前账号缺少 <code>${esc(perm)}</code> 权限，请联系超级管理员分配角色。</p>
      <a class="btn sm" href="#/dashboard">返回数据概览</a></div>`
    if (seq === routeSeq) {
      apiSignal = null
      setRouteBusy(false)
    }
    return
  }
  try {
    if (key === 'dashboard') await pageDashboard()
    else if (key === 'dramas') await pageDramas()
    else if (key === 'adult-settings') await pageAdultSettings()
    else if (key === 'policies') await pagePolicies()
    else if (key === 'plans') await pagePlans()
    else if (key === 'coupons') await pageCoupons()
    else if (key === 'orders') await pageOrders()
    else if (key === 'refunds') await pageRefunds()
    else if (key === 'ops') await pageOps()
    else if (key === 'ranks') await pageRanks()
    else if (key === 'review') await pageReview()
    else if (key === 'users') await pageUsers()
    else if (key === 'roles') await pageRoles()
    else if (key === 'audit') await pageAudit()
    else if (key === 'pay') await pagePay()
    else if (key === 'email') await pageEmail()
    else if (key === 'analytics') await pageAnalytics()
    else if (key === 'tags') await pageTags()
    else if (key === 'events') await pageEvents()
    else if (key === 'channels') await pageChannels()
    else if (key === 'content-stats') await pageContentStats()
    else if (key === 'distribution') await pageDistribution()
    else if (key === 'distribution-config') await pageDistributionConfig()
    else if (key === 'admins') await pageAdmins()
    else if (key === 'menus') await pageMenus()
  } catch (error) {
    if (error?.name === 'AbortError' || seq !== routeSeq) return
    // 单页渲染失败不影响其它页面：给出错误、页面名与重试入口
    console.error('[admin]', key, error)
    view.innerHTML = `<div class="panel">
      <h3>${esc(key)} 加载失败</h3>
      <p class="muted">${esc(error.message)}</p>
      <button class="btn primary" id="retry-page">重试</button>
      <button class="btn" data-home>回到概览</button>
    </div>`
    $('#retry-page')?.addEventListener('click', () => route())
    view.querySelector('[data-home]')?.addEventListener('click', () => { location.hash = '#/dashboard' })
  } finally {
    if (seq === routeSeq) {
      apiSignal = null
      setRouteBusy(false)
    }
  }
}

/* ---------------- 概览 ---------------- */
async function pageDashboard() {
  const perms = new Set(state.me?.permissions ?? [])
  const stats = await api('/admin/api/stats')
  const queue = stats.queue ?? { pending: 0, running: false, pendingItems: [] }
  const cats = stats.categories ?? []
  const activity = stats.activity ?? []
  const catSegments = cats.map((row, index) => ({ label: row.label, value: Number(row.n ?? 0), color: CHART_COLORS[index % CHART_COLORS.length] }))
  const todoRows = [
    { label: '转码排队', value: Number(queue.pending ?? 0) },
    { label: '待审弹幕', value: Number(stats.pendingDanmu ?? 0) },
    { label: '待审评论', value: Number(stats.pendingComments ?? 0) },
    { label: '草稿剧集', value: Number(stats.draftDramas ?? 0) },
  ]
  $('#top-right').innerHTML = `<span class="muted">更新于 ${new Date().toLocaleTimeString('zh-CN')}</span>
    ${perms.has('growth.distribution.write') ? '<a class="btn sm" href="#/distribution-config">分销配置 →</a>' : ''}
    <a class="btn sm" href="#/analytics">看经营数据 →</a>`
  // 概览只讲平台资产与内容健康度；收款/订阅/退款一律在「经营数据」里看。
  view.innerHTML = `
    <div class="cards">
      ${card('已上架剧集', fmt(stats.publishedDramas ?? 0), `部（草稿 ${fmt(stats.draftDramas ?? 0)}）`)}
      ${card('分集', fmt(stats.episodes ?? 0), `集（可播 ${fmt(stats.readyEpisodes ?? 0)}）`)}
      ${card('标签', fmt(stats.tags ?? 0), '个启用')}
      ${card('C 端用户', fmt(stats.users ?? 0), `人（7 日活跃 ${fmt(stats.activeUsers7d ?? 0)}）`)}
      ${card('转码队列', fmt(queue.pending ?? 0), queue.running ? `进行中：EP ${queue.current?.episodeId ?? '-'}` : '空闲')}
      ${card('待审弹幕', fmt(stats.pendingDanmu ?? 0), '条')}
      ${card('待审评论', fmt(stats.pendingComments ?? 0), '条')}
    </div>
    <div class="split">
      <div class="panel">
        <h3>近 7 日活跃趋势</h3>
        ${svgLineChart(activity, [
          { key: 'plays', label: '播放量', color: CHART_COLORS[0] },
          { key: 'viewers', label: '独立观众', color: CHART_COLORS[1] },
          { key: 'users', label: '新增用户', color: CHART_COLORS[3] },
        ], { height: 230 })}
      </div>
      <div class="panel">
        <h3>内容结构</h3>
        ${donutChart(catSegments, '剧集')}
        <p class="muted" style="margin-top:10px">
          发信通道：${stats.mailReady ? '<span class="pill ok">已配置</span>' : '<span class="pill warn">未配置（C 端无法自助收验证码）</span>'}
          <a href="#/email">去配置 →</a>
        </p>
      </div>
    </div>
    <div class="split">
      <div class="panel">
        <h3>转码队列</h3>
        ${queue.pending === 0 && !queue.running ? '<div class="chart-empty">队列空闲</div>' : `
          <table><thead><tr><th>分集</th><th>状态</th><th>进度</th></tr></thead><tbody>
            ${queue.current ? `<tr><td>EP ${queue.current.episodeId}</td><td><span class="pill warn">转码中</span></td><td>${esc(queue.current.source ?? '')}</td></tr>` : ''}
            ${(queue.pendingItems ?? []).map((item) => `<tr><td>EP ${item.episodeId}</td><td><span class="pill">排队</span></td><td class="muted">第 ${item.no} 集</td></tr>`).join('')}
          </tbody></table>`}
      </div>
      <div class="panel">
        <h3>待处理事项</h3>
        ${rankedBars(todoRows, 'value', 'label', ' 项')}
      </div>
    </div>`
}

const card = (key, value, unit) => `<div class="card"><div class="k">${esc(key)}</div><div class="v">${value} <small>${esc(unit)}</small></div></div>`

/* ---------------- 剧集 ---------------- */
const CATEGORY_LABEL = { MOVIE: '电影', TV: '电视剧', PLAYLET: '短剧/漫剧', ANIME: '动漫', VARIETY: '综艺', DOCUMENTARY: '纪录片' }
const ACCESS_LABEL = { free: '免费', subscription: '会员免费', paid: '单独收费' }
const MISSING_LABEL = { title: '标题', category: '类型', coverUrl: '封面', year: '年份', area: '地区', score: '评分', accessMode: '付费模式' }
const STATUS_LABEL = { published: '已上架', draft: '草稿', offline: '已下架' }
const policyGroupSummary = (group) => {
  if (!group) return '未选择策略组'
  const parts = [ACCESS_LABEL[group.access_mode] ?? group.access_mode]
  if (Number(group.free_episodes) > 0) parts.push(`前 ${Number(group.free_episodes)} 集免费`)
  if (Number(group.trial_seconds) > 0) parts.push(`试看 ${Number(group.trial_seconds)} 秒`)
  if (group.access_mode === 'paid' && Number(group.single_price_cny) > 0) parts.push(`单片 ¥${Number(group.single_price_cny).toFixed(2)}`)
  return parts.join(' · ')
}

async function pageDramas() {
  const idMatch = /^#\/dramas\/(\d+)(?:\/episodes)?$/.exec(location.hash)
  if (idMatch) {
    if (location.hash.endsWith('/episodes')) return pageEpisodes(Number(idMatch[1]))
    return pageDramaEdit(Number(idMatch[1]))
  }

  const page = Number(listPages.dramas ?? 1)
  const pageSize = Number(state.params.dramaPageSize ?? 20)
  const category = state.params.dramaCat ?? 'all'
  const status = state.params.dramaStatus ?? 'all'
  const keyword = String(state.params.dramaQ ?? '').trim()
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
  if (keyword) query.set('keyword', keyword)
  if (category !== 'all') query.set('category', category)
  if (status !== 'all') query.set('status', status)
  const data = await api(`/admin/api/dramas?${query.toString()}`)
  listPages.dramas = Number(data.page ?? 1)
  const options = data.options ?? { categories: [] }
  const policyGroups = data.policyGroups ?? []
  const rows = data.list ?? []
  const counts = Object.fromEntries((data.categoryCounts ?? []).map((row) => [row.category, Number(row.n ?? 0)]))
  const statusCounts = Object.fromEntries((data.statusCounts ?? []).map((row) => [row.status, Number(row.n ?? 0)]))
  const published = Number(statusCounts.published ?? 0)
  const categoryOptions = [
    `<option value="all" ${category === 'all' ? 'selected' : ''}>全部类型（${fmt(data.total ?? 0)}）</option>`,
    ...(options.categories ?? []).map((item) => `<option value="${esc(item.value)}" ${category === item.value ? 'selected' : ''}>${esc(item.label)}（${fmt(counts[item.value] ?? 0)}）</option>`),
  ].join('')
  const statusOptions = [
    `<option value="all" ${status === 'all' ? 'selected' : ''}>全部状态（${fmt(data.total ?? 0)}）</option>`,
    ...(options.dramaStatus ?? []).map((item) => `<option value="${esc(item.value)}" ${status === item.value ? 'selected' : ''}>${esc(item.label)}（${fmt(statusCounts[item.value] ?? 0)}）</option>`),
  ].join('')

  view.innerHTML = `
    <div class="panel">
      <div class="panel-head drama-head">
        <h3>剧集库 <span class="muted">共 ${fmt(data.total ?? 0)} 部 · 已上架 ${fmt(published)} 部 · 当前页 ${rows.length} 部</span></h3>
        <div class="drama-actions">
        <span class="artwork-status" id="artwork-status" role="status" aria-live="polite">素材同步就绪</span>
        <button class="btn scrape-btn" id="scrape-artwork" type="button"
          aria-label="一键刮削海报与首页 banner" title="抓取缺失海报，并补齐首页 banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M21 12a9 9 0 0 0-15.5-6.2L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 15.5 6.2L21 16" />
            <path d="M16 16h5v5" />
          </svg>
          <span id="scrape-label">一键刮削</span>
        </button>
        <button class="btn primary" id="new-drama">＋ 新建剧集</button>
        </div>
      </div>
      <form class="form-row drama-filters" id="drama-filters">
        <input id="drama-q" class="input" aria-label="搜索剧集" placeholder="搜索标题 / 副标题 / 标签" value="${esc(keyword)}" />
        <select id="drama-cat" aria-label="内容类型">${categoryOptions}</select>
        <select id="drama-status" aria-label="上架状态">${statusOptions}</select>
        <select id="drama-size" aria-label="每页数量">
          ${[10, 20, 50].map((size) => `<option value="${size}" ${pageSize === size ? 'selected' : ''}>每页 ${size} 部</option>`).join('')}
        </select>
        <button class="btn" type="submit">搜索</button>
        <button class="btn" type="button" id="drama-reset">重置</button>
      </form>
      <div class="bulk-assign-bar" id="drama-bulk-assign" hidden>
        <span class="muted">已选 <strong id="drama-selected-count">0</strong> 部</span>
        <select id="drama-bulk-group" aria-label="批量分配付费策略组">
          <option value="">选择策略组</option>
          ${policyGroups.map((group) => `<option value="${group.id}" title="${esc(policyGroupSummary(group))}">${esc(group.name)}</option>`).join('')}
        </select>
        <button class="btn primary" type="button" id="drama-bulk-apply" ${policyGroups.length ? '' : 'disabled'}>批量分配</button>
        <button class="btn" type="button" id="drama-bulk-clear">取消选择</button>
      </div>
      <table class="drama-table">
        <thead><tr>
          <th class="select-col"><input id="drama-select-all" type="checkbox" aria-label="选择本页全部剧集" /></th>
          <th>封面</th><th>标题</th><th>类型 / 分集</th><th>策略组</th><th>状态</th><th>操作</th>
        </tr></thead>
        <tbody>
          ${rows.map((row) => {
            const missing = (row.completeness?.missing ?? []).map((key) => MISSING_LABEL[key] ?? key)
            const policyGroupId = Number(row.policy?.policy_group_id ?? 0)
            return `<tr data-drama-row="${row.id}">
              <td class="select-col col-select"><input class="drama-select" type="checkbox" value="${row.id}" aria-label="选择 ${esc(row.title)}" /></td>
              <td class="cover-cell col-cover" data-cover-for="${row.id}">${row.cover_url ? `<img class="mini" loading="lazy" src="${esc(mediaUrl(row.cover_url))}" alt="" data-img-fallback="hide" />` : '<span class="pill warn">缺</span>'}</td>
              <td class="table-title col-title" title="${esc(row.title)}"><strong>${esc(row.title)}</strong>
                ${row.isAdult ? '<span class="pill warn">成人</span>' : ''}
                <div class="muted">${esc(row.sub_title ?? '')} ${row.year && !String(row.sub_title ?? '').includes(String(row.year)) ? `· ${row.year}` : ''} ${row.area ? `· ${esc(row.area)}` : ''}</div>
                ${missing.length ? `<span class="pill warn" title="${esc(missing.join('、'))}">缺 ${missing.length} 项</span>` : '<span class="pill ok">完整</span>'}</td>
              <td class="col-meta">${esc(CATEGORY_LABEL[row.category] ?? row.category ?? '—')} · ${row.readyEpisodes ?? 0}/${row.episodeCount ?? 0} 集</td>
              <td class="policy-cell">
                <select class="policy-group-select" data-policy-group="${row.id}" data-previous="${policyGroupId || ''}" aria-label="${esc(row.title)} 的付费策略组" ${policyGroups.length ? '' : 'disabled'}>
                  ${policyGroupId ? '' : '<option value="" selected disabled>未分组</option>'}
                  ${policyGroups.map((group) => `<option value="${group.id}" ${policyGroupId === Number(group.id) ? 'selected' : ''} title="${esc(policyGroupSummary(group))}">${esc(group.name)}</option>`).join('')}
                </select>
              </td>
              <td class="col-status">${row.status === 'published' ? '<span class="pill ok">已上架</span>' : `<span class="pill">${esc(STATUS_LABEL[row.status] ?? row.status)}</span>`}</td>
              <td class="row-actions col-actions">
                <a class="btn sm" href="#/dramas/${row.id}">编辑</a>
                <a class="btn sm" href="#/dramas/${row.id}/episodes">分集</a>
                <div class="row-more">
                  <button class="btn sm row-more-toggle" type="button" aria-expanded="false">更多</button>
                  <div class="row-more-menu">
                    <button class="btn sm" data-scrape-drama="${row.id}" title="刮削该剧海报和横幅">刮削</button>
                    <button class="btn sm" data-toggle-publish="${row.id}" data-status="${row.status}">${row.status === 'published' ? '下架' : '上架'}</button>
                    <button class="btn sm danger" data-del="${row.id}">删除</button>
                  </div>
                </div>
              </td>
            </tr>`
          }).join('')}
          ${rows.length ? '' : '<tr><td colspan="7" class="muted">没有匹配的剧集</td></tr>'}
        </tbody>
      </table>
      ${pager('dramas', data.page, data.pageSize, data.total, '部')}
    </div>`

  const applyDramaFilters = async () => {
    state.params.dramaQ = $('#drama-q')?.value.trim() ?? ''
    state.params.dramaCat = $('#drama-cat')?.value ?? 'all'
    state.params.dramaStatus = $('#drama-status')?.value ?? 'all'
    state.params.dramaPageSize = Number($('#drama-size')?.value ?? 20)
    listPages.dramas = 1
    await pageDramas()
    const input = $('#drama-q')
    if (input) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }
  $('#drama-filters')?.addEventListener('submit', (event) => {
    event.preventDefault()
    void applyDramaFilters()
  })
  $('#drama-cat')?.addEventListener('change', () => void applyDramaFilters())
  $('#drama-status')?.addEventListener('change', () => void applyDramaFilters())
  $('#drama-size')?.addEventListener('change', () => void applyDramaFilters())
  $('#drama-reset')?.addEventListener('click', async () => {
    state.params.dramaQ = ''
    state.params.dramaCat = 'all'
    state.params.dramaStatus = 'all'
    listPages.dramas = 1
    await pageDramas()
  })
  bindPager('dramas', pageDramas)
  const setArtworkStatus = (text, tone = '') => {
    const status = $('#artwork-status')
    if (!status) return
    status.textContent = text
    status.className = `artwork-status ${tone}`.trim()
  }
  const applyArtworkDetails = (details = []) => {
    for (const item of details) {
      if (!item.cover) continue
      const cell = view.querySelector(`[data-cover-for="${Number(item.id)}"]`)
      if (!cell) continue
      const src = mediaUrl(item.cover)
      const versioned = `${src}${src.includes('?') ? '&' : '?'}v=${Date.now()}`
      cell.innerHTML = `<img class="mini" loading="lazy" src="${esc(versioned)}" alt="" data-img-fallback="hide" />`
    }
  }
  $('#new-drama').addEventListener('click', () => dramaWizard(options, policyGroups))
  const selectedRows = () => [...view.querySelectorAll('.drama-select:checked')]
  const updateBulkBar = () => {
    const count = selectedRows().length
    const bar = $('#drama-bulk-assign')
    const countNode = $('#drama-selected-count')
    if (countNode) countNode.textContent = String(count)
    if (bar) bar.hidden = count === 0
    const all = view.querySelectorAll('.drama-select').length
    const selectAll = $('#drama-select-all')
    if (selectAll) {
      selectAll.checked = all > 0 && count === all
      selectAll.indeterminate = count > 0 && count < all
    }
  }
  view.querySelectorAll('.drama-select').forEach((checkbox) => checkbox.addEventListener('change', updateBulkBar))
  $('#drama-select-all')?.addEventListener('change', (event) => {
    view.querySelectorAll('.drama-select').forEach((checkbox) => { checkbox.checked = event.target.checked })
    updateBulkBar()
  })
  $('#drama-bulk-clear')?.addEventListener('click', () => {
    view.querySelectorAll('.drama-select').forEach((checkbox) => { checkbox.checked = false })
    updateBulkBar()
  })
  view.querySelectorAll('[data-policy-group]').forEach((select) => {
    select.addEventListener('change', async () => {
      if (!select.value || select.dataset.busy === '1') return
      const previous = select.dataset.previous ?? ''
      select.dataset.busy = '1'
      select.disabled = true
      try {
        await api(`/admin/api/dramas/${select.dataset.policyGroup}/policy`, {
          method: 'PUT',
          body: { policyGroupId: Number(select.value) },
        })
        select.dataset.previous = select.value
        toast('策略组已更新')
      } catch (error) {
        select.value = previous
        toast(error.message)
      } finally {
        delete select.dataset.busy
        select.disabled = false
      }
    })
  })
  $('#drama-bulk-apply')?.addEventListener('click', async (event) => {
    const button = event.currentTarget
    const groupId = Number($('#drama-bulk-group')?.value ?? 0)
    const ids = selectedRows().map((checkbox) => Number(checkbox.value))
    if (!groupId) return toast('请先选择策略组')
    if (!ids.length || button.disabled) return
    button.disabled = true
    button.textContent = '分配中…'
    try {
      const result = await api(`/admin/api/policy-groups/${groupId}/assign`, {
        method: 'POST',
        body: { dramaIds: ids },
      })
      ids.forEach((id) => {
        const select = view.querySelector(`[data-policy-group="${id}"]`)
        if (!select) return
        select.value = String(groupId)
        select.dataset.previous = String(groupId)
      })
      toast(`已分配 ${fmt(result.updated ?? result.matched ?? ids.length)} 部剧集`)
      view.querySelectorAll('.drama-select').forEach((checkbox) => { checkbox.checked = false })
      updateBulkBar()
    } catch (error) {
      toast(error.message)
    } finally {
      button.disabled = false
      button.textContent = '批量分配'
    }
  })
  view.querySelectorAll('.row-more-toggle').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      const current = button.closest('.row-more')
      const open = !current.classList.contains('open')
      view.querySelectorAll('.row-more.open').forEach((node) => {
        node.classList.remove('open')
        node.querySelector('.row-more-toggle')?.setAttribute('aria-expanded', 'false')
      })
      current.classList.toggle('open', open)
      button.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
  })
  $('#scrape-artwork').addEventListener('click', async () => {
    const button = $('#scrape-artwork')
    if (!button || button.dataset.busy === '1') return
    const label = $('#scrape-label')
    button.dataset.busy = '1'
    button.disabled = true
    button.classList.add('is-loading')
    button.setAttribute('aria-busy', 'true')
    if (label) label.textContent = '刮削中…'
    setArtworkStatus('正在抓取缺失海报与首页横幅…')
    try {
      const result = await api('/admin/api/artwork/refresh', {
        method: 'POST', timeoutMs: 180_000, body: { limit: 100, bannerLimit: 6, force: true },
      })
      const details = result.details ?? []
      const failed = details.filter((item) => !item.ok)
      // 只替换封面单元格，不整页重绘：刷新期间和刷新后表格尺寸保持稳定。
      applyArtworkDetails(details)
      const banners = Number(result.banners?.created ?? 0)
      const summary = `更新 ${result.updated ?? 0} 部 · 横幅 +${banners}${failed.length ? ` · 失败 ${failed.length}` : ''}`
      setArtworkStatus(summary, failed.length ? 'warn' : 'ok')
      toast(summary)
      if (failed.length) console.warn('[artwork]', failed)
    } catch (error) {
      setArtworkStatus('刮削失败，请稍后重试', 'bad')
      toast(error.message)
    } finally {
      delete button.dataset.busy
      button.disabled = false
      button.classList.remove('is-loading')
      button.setAttribute('aria-busy', 'false')
      if (label) label.textContent = '一键刮削'
    }
  })
  view.querySelectorAll('[data-scrape-drama]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.dataset.busy === '1') return
      const id = Number(button.dataset.scrapeDrama)
      const previous = button.textContent
      button.dataset.busy = '1'
      button.disabled = true
      button.setAttribute('aria-busy', 'true')
      button.textContent = '刮削中…'
      setArtworkStatus('正在刮削该剧海报与横幅…')
      try {
        const result = await api('/admin/api/artwork/refresh', {
          method: 'POST',
          timeoutMs: 60_000,
          body: { ids: [id], bannerLimit: 6, force: true },
        })
        const item = (result.details ?? [])[0]
        applyArtworkDetails(result.details ?? [])
        if (item?.ok && item.cover) {
          const summary = `《${item.title ?? '剧集'}》素材已更新`
          setArtworkStatus(summary, 'ok')
          toast(summary)
        } else {
          const message = item?.error ?? '未找到可用素材'
          setArtworkStatus(`刮削失败：${message}`, 'bad')
          toast(`刮削失败：${message}`)
        }
      } catch (error) {
        setArtworkStatus(`刮削失败：${error.message}`, 'bad')
        toast(error.message)
      } finally {
        delete button.dataset.busy
        button.disabled = false
        button.setAttribute('aria-busy', 'false')
        button.textContent = previous
      }
    })
  })
  view.querySelectorAll('[data-toggle-publish]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.togglePublish)
      const next = button.dataset.status === 'published' ? 'draft' : 'published'
      try {
        await api(`/admin/api/dramas/${id}/publish`, { method: 'POST', body: { status: next } })
        toast(next === 'published' ? '已上架' : '已下架')
      } catch (error) {
        toast(error.message)
      }
      await pageDramas()
    })
  })
  view.querySelectorAll('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!(await askConfirm({ title: '删除剧集', message: '将同时删除该剧集下的全部分集，操作不可撤销。', confirmText: '删除', danger: true }))) return
      await api(`/admin/api/dramas/${button.dataset.del}`, { method: 'DELETE' })
      toast('已删除')
      await pageDramas()
    })
  })
}

async function pageAdultSettings() {
  const settings = await api('/admin/api/adult-menu')
  const enabled = settings.enabled !== false
  view.innerHTML = `
    <div class="settings-ui settings-page">
      <div class="settings-intro">
        <p>成人菜单单独控制 C 端入口和标签，不与其他频道配置混用。内容仍需在剧集编辑页勾选“成人内容”后才会出现在成人列表。</p>
        <span class="settings-status ${enabled ? 'is-active' : 'is-off'}">${enabled ? '菜单已启用' : '菜单已停用'}</span>
      </div>
      <section class="panel settings-section" aria-labelledby="adult-menu-title">
        <div class="settings-section-head">
          <div>
            <h3 id="adult-menu-title">成人菜单</h3>
            <p>中文和英文标签分别配置，语言切换后立即使用对应文案。停用只隐藏菜单和成人列表，不会删除已标记内容。</p>
          </div>
        </div>
        <div class="settings-form-grid">
          <label class="setting-field">
            <span>菜单状态</span>
            <select class="input" id="adult-enabled">
              <option value="1" ${enabled ? 'selected' : ''}>启用</option>
              <option value="0" ${enabled ? '' : 'selected'}>停用</option>
            </select>
            <small>启用后显示在桌面侧栏和移动端底栏。</small>
          </label>
          <label class="setting-field">
            <span>中文标签</span>
            <input class="input" id="adult-label-zh" maxlength="20" value="${esc(settings.labelZh)}" />
            <small>中文环境显示，例如“成人”或“18+”。</small>
          </label>
          <label class="setting-field">
            <span>英文标签</span>
            <input class="input" id="adult-label-en" maxlength="20" value="${esc(settings.labelEn)}" />
            <small>英文环境显示，例如“Adult”。</small>
          </label>
        </div>
        <div class="settings-actions">
          <button class="btn primary" type="button" id="adult-save">保存设置</button>
        </div>
      </section>
    </div>`
  $('#adult-save').addEventListener('click', async () => {
    const labelZh = $('#adult-label-zh').value.trim()
    const labelEn = $('#adult-label-en').value.trim()
    if (!labelZh || !labelEn) return toast('中英文标签都不能为空')
    const button = $('#adult-save')
    button.disabled = true
    try {
      await api('/admin/api/adult-menu', {
        method: 'PUT',
        body: { enabled: $('#adult-enabled').value === '1', labelZh, labelEn },
      })
      toast('成人菜单已保存')
      await pageAdultSettings()
    } catch (error) {
      toast(error.message)
      button.disabled = false
    }
  })
}

/** 新建剧集向导：先搜刮再补，付费策略直接绑定策略组。 */
function dramaWizard(options, policyGroups = []) {
  const categories = options?.categories ?? []
  const groups = Array.isArray(policyGroups) ? policyGroups : []
  const defaultGroup = groups.find((group) => group.access_mode === 'subscription') ?? groups[0] ?? null
  const draft = {
    title: '', subTitle: '', category: '', coverUrl: '', year: '', area: '', score: '', description: '',
    contentType: '', policyGroupId: defaultGroup?.id ?? null, isAdult: false,
  }

  openOverlay('新建剧集', `
    <div class="field">
      <label>剧集名称（先填名字，再点搜刮）</label>
      <div style="display:flex;gap:8px">
        <input id="wz-title" placeholder="例如：辛特尔 / 钢铁之泪" autocomplete="off" />
        <button class="btn primary" id="wz-scrape" style="white-space:nowrap">自动搜刮</button>
      </div>
      <div class="catalog-hint" id="wz-hint">搜刮会补封面、年份、地区、评分、简介与标签；结果有误可直接改。</div>
    </div>
    <div class="grid-2">
      <div class="field"><label>内容类型 *</label>
        <select id="wz-category"><option value="">请选择</option>
          ${categories.map((item) => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}
        </select></div>
      <div class="field"><label>统计类型 *</label>
        <select id="wz-content-type">
          <option value="">请选择</option>
          <option value="series">剧集</option>
          <option value="movie">电影</option>
          <option value="comic_drama">漫剧</option>
        </select></div>
      <div class="field"><label>付费策略组 *</label>
        <select id="wz-policy-group">
          ${groups.map((group) => `<option value="${group.id}" ${Number(defaultGroup?.id) === Number(group.id) ? 'selected' : ''}>${esc(group.name)}</option>`).join('')}
        </select>
        <span class="muted" id="wz-policy-summary">${esc(policyGroupSummary(defaultGroup))}</span>
      </div>
      <div class="field"><label>年份</label><input id="wz-year" placeholder="2010" /></div>
      <div class="field"><label>地区</label><input id="wz-area" placeholder="荷兰 / 中国大陆" /></div>
      <div class="field"><label>评分（0–10）</label><input id="wz-score" placeholder="9.1" /></div>
    </div>
    <label class="check-item">
      <input id="wz-adult" type="checkbox" />
      <span class="check-copy"><strong>成人内容</strong><small>勾选后只在成人菜单展示，普通首页、分类、搜索与榜单均不显示。</small></span>
    </label>
    <div class="field"><label>封面地址 *</label>
      <div style="display:flex;gap:10px;align-items:flex-start">
        <input id="wz-cover" placeholder="https://… 或 /media/images/cover-xxx.jpg" />
        <img class="cover-prev" id="wz-prev" alt="" />
      </div>
    </div>
    <div class="field"><label>简介</label><textarea id="wz-desc" rows="3"></textarea></div>
    <div class="field"><label>标签（逗号分隔，可留空后续在标签管理里绑定）</label><input id="wz-tags" placeholder="动画,奇幻,无对白" /></div>
    <div class="req-missing" id="wz-missing"></div>
    <div class="modal-foot">
      <button class="btn" id="wz-draft">存为草稿</button>
      <button class="btn primary" id="wz-publish">保存并上架</button>
    </div>
  `, (body, close) => {
    const read = () => {
      draft.title = body.querySelector('#wz-title').value.trim()
      draft.category = body.querySelector('#wz-category').value
      draft.contentType = body.querySelector('#wz-content-type').value
      draft.policyGroupId = Number(body.querySelector('#wz-policy-group').value || 0) || null
      draft.year = body.querySelector('#wz-year').value
      draft.area = body.querySelector('#wz-area').value.trim()
      draft.score = body.querySelector('#wz-score').value
      draft.isAdult = body.querySelector('#wz-adult').checked
      draft.coverUrl = body.querySelector('#wz-cover').value.trim()
      draft.description = body.querySelector('#wz-desc').value.trim()
      draft.tags = body.querySelector('#wz-tags').value.split(/[,，\s]+/).filter(Boolean)
      return draft
    }
    const missingOf = (value) => {
      const missing = []
      if (!value.title) missing.push('标题')
      if (!value.category) missing.push('内容类型')
      if (!value.contentType) missing.push('统计类型')
      if (!value.policyGroupId) missing.push('付费策略组')
      if (!value.coverUrl) missing.push('封面')
      if (!(Number(value.year) > 1900)) missing.push('年份')
      if (!value.area) missing.push('地区')
      if (!(Number(value.score) > 0)) missing.push('评分')
      return missing
    }
    const paint = () => {
      const value = read()
      const missing = missingOf(value)
      body.querySelector('#wz-missing').textContent = missing.length
        ? `还缺：${missing.join('、')}（缺项只能存草稿）`
        : '字段已完整，可以直接上架'
      const prev = body.querySelector('#wz-prev')
      const url = mediaUrl(value.coverUrl)
      prev.src = url || ''
      prev.style.visibility = url ? 'visible' : 'hidden'
      const group = groups.find((item) => Number(item.id) === Number(value.policyGroupId))
      body.querySelector('#wz-policy-summary').textContent = policyGroupSummary(group)
    }
    body.addEventListener('input', paint)
    body.addEventListener('change', paint)

    body.querySelector('#wz-scrape').addEventListener('click', async () => {
      const title = body.querySelector('#wz-title').value.trim()
      if (!title) return toast('请先填剧集名称')
      const hint = body.querySelector('#wz-hint')
      hint.textContent = '搜刮中…'
      try {
        const result = await api(`/admin/api/scrape?title=${encodeURIComponent(title)}`)
        const payload = result.payload ?? {}
        body.querySelector('#wz-title').value = payload.title ?? title
        if (payload.subTitle) body.querySelector('#wz-desc').value ||= ''
        body.querySelector('#wz-category').value = payload.category ?? ''
        body.querySelector('#wz-year').value = payload.year ?? ''
        body.querySelector('#wz-area').value = payload.area ?? ''
        body.querySelector('#wz-score').value = payload.score ?? ''
        body.querySelector('#wz-cover').value = payload.coverUrl ?? ''
        if (payload.description) body.querySelector('#wz-desc').value = payload.description
        if (payload.tags?.length) body.querySelector('#wz-tags').value = payload.tags.join(',')
        const missing = (payload.completeness?.missing ?? []).map((key) => MISSING_LABEL[key] ?? key)
        hint.textContent = result.found
          ? `已从「${payload.source === 'catalog' ? '内置片库' : payload.source === 'remote' ? '外部元数据' : '本地缓存'}」补全${missing.length ? `，仍缺：${missing.join('、')}` : '，字段齐了'}${(result.suggestions ?? []).length ? `；站内已有：${result.suggestions.join('、')}` : ''}`
          : `没有搜到「${title}」的公开元数据，请手动补齐（封面/年份/地区/评分）`
        paint()
      } catch (error) {
        hint.textContent = `搜刮失败：${error.message}`
      }
    })

    const submit = async (wantPublish) => {
      const value = read()
      if (!value.title) return toast('请先填剧集名称')
      try {
        const created = await api('/admin/api/dramas', {
          method: 'POST',
          body: {
            title: value.title, subTitle: value.subTitle, category: value.category,
            contentType: value.contentType,
            isAdult: value.isAdult,
            coverUrl: value.coverUrl, description: value.description,
            year: Number(value.year) || 0, area: value.area, score: Number(value.score) || 0,
            policyGroupId: value.policyGroupId,
            status: wantPublish ? 'published' : 'draft',
          },
        })
        const dramaId = created.drama?.id
        toast(created.statusNote || '已保存')
        close()
        if (dramaId) location.hash = `#/dramas/${dramaId}`
        else await pageDramas()
      } catch (error) {
        toast(error.message)
      }
    }
    body.querySelector('#wz-draft').addEventListener('click', () => submit(false))
    body.querySelector('#wz-publish').addEventListener('click', () => submit(true))
    body.querySelector('#wz-category').addEventListener('change', (event) => {
      const select = body.querySelector('#wz-content-type')
      if (!select || select.value) return
      select.value = event.target.value === 'MOVIE' ? 'movie'
        : event.target.value === 'ANIME' ? 'comic_drama' : 'series'
    })
    body.querySelector('#wz-title').focus()
  })
}

async function pageDramaEdit(id) {
  const [data, tagResult, groupResult] = await Promise.all([
    api(`/admin/api/dramas/${id}`),
    api('/admin/api/tags').then((result) => ({ list: result.list ?? [] })).catch((error) => ({ error })),
    api('/admin/api/policy-groups').then((result) => ({ groups: result.groups ?? [] })).catch((error) => ({ error })),
  ])
  const drama = data.drama
  const policy = data.policy ?? {}
  const allTags = tagResult.list ?? []
  const tagsFailed = Boolean(tagResult.error)
  const policyGroups = groupResult.groups ?? []
  const policyGroupId = Number(policy.policy_group_id ?? 0)
  const currentGroup = policyGroups.find((group) => Number(group.id) === policyGroupId)
  const currentTags = new Set((drama.tags ?? []).map((tag) => Number(tag.id ?? tag.tag_id)))
  view.innerHTML = `
    <div class="panel">
      <h3>编辑剧集 #${id}<span class="spacer"></span><a class="btn" href="#/dramas">返回列表</a></h3>
      <div class="form">
        ${field('title', '标题', drama.title)}
        ${field('subTitle', '副标题', drama.sub_title)}
        <label class="span-2">封面地址<input id="f-coverUrl" value="${esc(drama.cover_url ?? '')}" /></label>
        <label>内容类型<select id="f-category">
          ${Object.entries(CATEGORY_LABEL).map(([value, label]) => `<option value="${value}" ${drama.category === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        <label>统计类型<select id="f-content-type">
          ${[['series', '剧集'], ['movie', '电影'], ['comic_drama', '漫剧']].map(([value, label]) => `<option value="${value}" ${drama.content_type === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        ${field('year', '年份', drama.year, 'number')}
        ${field('area', '地区', drama.area)}
        ${field('score', '评分', drama.score, 'number')}
        <label>付费策略组<select id="f-policy-group">
          ${policyGroupId ? '' : '<option value="" selected disabled>未分组（请选择）</option>'}
          ${policyGroups.map((group) => `<option value="${group.id}" ${policyGroupId === Number(group.id) ? 'selected' : ''}>${esc(group.name)}</option>`).join('')}
        </select></label>
        <label>状态<select id="f-status">
          <option value="published" ${drama.status === 'published' ? 'selected' : ''}>已上架</option>
          <option value="draft" ${drama.status !== 'published' ? 'selected' : ''}>草稿 / 待补全</option>
        </select></label>
        <label class="span-2 switch"><input id="f-is-adult" type="checkbox" ${drama.isAdult ? 'checked' : ''} />成人内容（仅成人菜单可见）</label>
      </div>
      <div class="muted" id="f-policy-summary" style="margin-top:8px">
        <span id="f-policy-text">当前：${esc(currentGroup ? policyGroupSummary(currentGroup) : `${ACCESS_LABEL[policy.access_mode] ?? '会员免费'}（旧版自定义策略）`)}</span>
        <a href="#/policies">管理策略组 →</a>
      </div>
      <label class="muted">标签<span class="spacer"></span></label>
    <div class="tag-picker-head">
      <input id="tag-search" placeholder="搜索标签…" aria-label="搜索标签" />
      <span class="muted small" id="tag-selected-count"></span>
    </div>
    <div class="tag-picker" style="display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 14px">
      ${tagsFailed
        ? '<span class="pill bad">标签加载失败，标签保存已禁用</span>'
        : allTags.length === 0
          ? '<span class="muted">还没有标签，先去「标签管理」新建</span>'
          : allTags.map((tag) => `<label class="tag-option" data-name="${esc(tag.name)}" style="display:inline-flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" class="f-tag" value="${tag.id}" ${currentTags.has(Number(tag.id)) ? 'checked' : ''} />${esc(tag.name)}
          </label>`).join('')}
    </div>
    <label class="muted">简介</label>
      <textarea id="f-description" rows="3" style="width:100%;margin-top:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text)">${esc(drama.description ?? '')}</textarea>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="save-drama">保存</button>
        <button class="btn" id="save-tags" ${tagsFailed ? 'disabled' : ''}>保存标签</button>
        <button class="btn" id="edit-rules">按集定价规则</button>
        <a class="btn" href="#/dramas/${id}/episodes">管理分集与视频 →</a>
      </div>
    </div>`

    $('#save-tags')?.addEventListener('click', async () => {
    if (tagsFailed) return toast('标签加载失败，请刷新页面后重试')
    const tagIds = [...view.querySelectorAll('.f-tag:checked')].map((node) => Number(node.value))
    try {
      await api(`/admin/api/dramas/${id}/tags`, { method: 'POST', body: { tagIds } })
      toast('标签已保存')
    } catch (error) { toast(error.message) }
  })

  // 标签多时先搜索再勾选；已选项始终可见，避免筛选后误以为丢失。
  const syncTagCount = () => {
    const count = view.querySelectorAll('.f-tag:checked').length
    const badge = $('#tag-selected-count')
    if (badge) badge.textContent = `已选 ${count}`
  }
  $('#tag-search')?.addEventListener('input', (event) => {
    const keyword = event.target.value.trim().toLowerCase()
    view.querySelectorAll('.tag-option').forEach((node) => {
      const hit = !keyword || String(node.dataset.name ?? '').toLowerCase().includes(keyword)
      node.style.display = hit || node.querySelector('.f-tag')?.checked ? 'inline-flex' : 'none'
    })
  })
  view.querySelectorAll('.f-tag').forEach((node) => node.addEventListener('change', syncTagCount))
  syncTagCount()

  $('#edit-rules').addEventListener('click', () => openRuleEditor(Number(id), drama.title))
  $('#f-policy-group')?.addEventListener('change', (event) => {
    const group = policyGroups.find((item) => Number(item.id) === Number(event.target.value))
    $('#f-policy-text').textContent = `当前：${policyGroupSummary(group)}`
  })

    $('#save-drama').addEventListener('click', async () => {
    await api(`/admin/api/dramas/${id}`, {
      method: 'PUT',
      body: {
        title: $('#f-title').value, subTitle: $('#f-subTitle').value, coverUrl: $('#f-coverUrl').value,
        category: $('#f-category').value, contentType: $('#f-content-type').value,
        isAdult: $('#f-is-adult').checked,
        year: Number($('#f-year').value), area: $('#f-area').value,
        score: Number($('#f-score').value), status: $('#f-status').value,
        description: $('#f-description').value,
      },
    })
    const nextPolicyGroupId = Number($('#f-policy-group').value || 0)
    if (nextPolicyGroupId) {
      await api(`/admin/api/dramas/${id}/policy`, {
        method: 'PUT',
        body: { policyGroupId: nextPolicyGroupId },
      })
    }
    toast('已保存')
  })
}

const field = (key, label, value, type = 'text') =>
  `<label>${esc(label)}<input id="f-${key}" type="${type}" value="${esc(value ?? '')}" /></label>`

async function pageEpisodes(dramaId) {
  const data = await api(`/admin/api/dramas/${dramaId}/episodes`)
  const isMovie = data.category === 'MOVIE'
  const canAdd = !isMovie || data.list.length === 0
  view.innerHTML = `
    <div class="panel">
      <h3>分集与视频 · 剧集 #${dramaId}<span class="spacer"></span>
        <a class="btn" href="#/dramas/${dramaId}">编辑剧集</a>
        ${canAdd ? `<button class="btn primary" id="add-episode">${isMovie ? '新增正片' : '新增分集'}</button>` : ''}
      </h3>
      <div class="muted" style="margin-bottom:10px">${isMovie
        ? (data.list.length ? '电影只有一个正片，不支持新增分集。上传或替换正片视频即可。' : '电影先新增一个正片，再上传视频。')
        : '上传视频后自动进入转码队列（ffmpeg → HLS 720p，4s 切片）。也可以「生成示例视频」验证整条链路。'}</div>
      <table>
        <thead><tr><th>集</th><th>标题</th><th>状态</th><th>进度</th><th>HLS</th><th>操作</th></tr></thead>
        <tbody id="ep-body">
          ${data.list.map((row) => episodeRow(row, isMovie)).join('')}
        </tbody>
      </table>
    </div>`
  wireEpisodeActions(dramaId)

  $('#add-episode')?.addEventListener('click', async () => {
    await api(`/admin/api/dramas/${dramaId}/episodes`, { method: 'POST', body: {} })
    await pageEpisodes(dramaId)
  })

  state.timers.push(setInterval(async () => {
    if (state.episodeImporting) return
    try {
      const fresh = await api(`/admin/api/dramas/${dramaId}/episodes`)
      $('#ep-body').innerHTML = fresh.list.map((row) => episodeRow(row, isMovie)).join('')
      wireEpisodeActions(dramaId)
    } catch { /* 页面已切走 */ }
  }, 2500))
}

function episodeRow(row, isMovie = false) {
  const badge = row.status === 'ready' && !row.hls_path ? '<span class="pill">无片源</span>'
    : row.status === 'ready' ? '<span class="pill ok">就绪</span>'
    : row.status === 'transcoding' ? '<span class="pill warn">转码中</span>'
    : row.status === 'queued' ? '<span class="pill">排队</span>'
    : row.status === 'error' ? `<span class="pill bad">失败</span><div class="muted">${esc(row.error ?? '')}</div>`
    : '<span class="pill">未上传</span>'
  return `<tr>
    <td>${isMovie && row.no === 1 ? '正片' : `第 ${row.no} 集`}</td>
    <td>${esc(row.title ?? '')}${row.vip ? ' <span class="pill warn">VIP</span>' : ''}</td>
    <td>${badge}</td>
    <td style="width:160px"><div class="progress"><i style="width:${row.progress}%"></i></div><div class="muted">${row.progress}%</div></td>
    <td class="mono">${row.hls_path ? esc(row.hls_path) : '—'}</td>
    <td class="row-actions">
      <button class="btn sm" type="button" data-tracks="${row.id}">音轨/字幕</button>
      <button class="btn sm" type="button" data-import-url="${row.id}">URL 导入</button>
      <button class="btn sm" type="button" data-upload-trigger="${row.id}" aria-label="上传第 ${row.no} 集视频">上传</button>
      <input type="file" accept="video/*" data-upload="${row.id}" hidden />
      <button class="btn sm" data-sample="${row.id}">示例视频</button>
      <button class="btn sm danger" data-delep="${row.id}">删除</button>
    </td>
  </tr>`
}

function wireEpisodeActions(dramaId) {
  view.querySelectorAll('[data-tracks]').forEach((button) => {
    button.addEventListener('click', () => openTracksDialog(Number(button.dataset.tracks)))
  })
  view.querySelectorAll('[data-upload-trigger]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = view.querySelector(`[data-upload="${button.dataset.uploadTrigger}"]`)
      input?.click()
    })
  })
  view.querySelectorAll('[data-import-url]').forEach((button) => {
    button.addEventListener('click', async () => {
      const url = await askText({
        title: 'URL 导入视频',
        label: '视频直链 URL',
        placeholder: 'https://example.com/movie.mp4',
        confirmText: '开始导入',
      })
      if (!url) return
      state.episodeImporting = true
      button.disabled = true
      button.textContent = '导入中…'
      toast('正在下载视频，完成后自动进入转码队列…')
      try {
        const result = await api(`/admin/api/episodes/${button.dataset.importUrl}/import-url`, {
          method: 'POST',
          body: { url },
          timeoutMs: 0,
        })
        toast(`已入队：${result.source ?? '转码队列'}`)
      } catch (error) {
        toast(`导入失败：${error.message}`)
      } finally {
        state.episodeImporting = false
        if (location.hash.startsWith(`#/dramas/${dramaId}/episodes`)) await pageEpisodes(dramaId)
      }
    })
  })
  view.querySelectorAll('[data-upload]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      const id = input.dataset.upload
      const trigger = view.querySelector(`[data-upload-trigger="${id}"]`)
      toast(`上传中 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）…`)
      if (trigger) {
        trigger.disabled = true
        trigger.textContent = '上传中…'
        trigger.setAttribute('aria-busy', 'true')
      }
      try {
        const result = await api(`/admin/api/episodes/${id}/upload`, { method: 'POST', body: file, timeoutMs: 0 })
        toast(`已入队：${result.source}`)
      } catch (error) {
        toast(`上传失败：${error.message}`)
        if (trigger) {
          trigger.disabled = false
          trigger.textContent = '上传'
          trigger.removeAttribute('aria-busy')
        }
      }
      await pageEpisodes(dramaId)
    })
  })
  view.querySelectorAll('[data-sample]').forEach((button) => {
    button.addEventListener('click', async () => {
      toast('生成 30 秒示例视频并转码…')
      try {
        await api(`/admin/api/episodes/${button.dataset.sample}/sample`, { method: 'POST', body: { seconds: 30 } })
        toast('已入队转码')
      } catch (error) { toast(error.message) }
      await pageEpisodes(dramaId)
    })
  })
  view.querySelectorAll('[data-delep]').forEach((button) => {
    button.addEventListener('click', async () => {
      if (!(await askConfirm({ title: '删除分集', message: '删除后该集片源与观看入口会一并移除。', confirmText: '删除', danger: true }))) return
      await api(`/admin/api/episodes/${button.dataset.delep}`, { method: 'DELETE' })
      await pageEpisodes(dramaId)
    })
  })
}

function trackKindLabel(kind) {
  return kind === 'audio' ? '音轨' : '字幕'
}

async function openTracksDialog(episodeId) {
  let data
  try {
    data = await api(`/admin/api/episodes/${episodeId}/tracks`)
  } catch (error) {
    toast(error.message)
    return
  }
  const rows = data.list ?? []
  openOverlay(`音轨/字幕 · 分集 #${episodeId}`, `
    <div class="row-actions" style="margin-bottom:12px">
      <button class="btn primary" type="button" data-track-add>新增轨道</button>
    </div>
    ${rows.length ? `<table>
      <thead><tr><th>类型</th><th>语言</th><th>版本/片源</th><th>展示名</th><th>URI</th><th>默认</th><th>操作</th></tr></thead>
      <tbody>${rows.map((row) => `<tr>
        <td>${trackKindLabel(row.kind)}</td>
        <td>${esc(row.language)}</td>
        <td>${esc(row.edition)}</td>
        <td>${esc(row.label)}</td>
        <td class="mono" title="${esc(row.uri)}">${esc(row.uri)}</td>
        <td>${row.is_default ? '是' : ''}</td>
        <td class="row-actions">
          <button class="btn sm" type="button" data-track-edit="${row.id}">编辑</button>
          ${row.is_default ? '' : `<button class="btn sm" type="button" data-track-default="${row.id}">设默认</button>`}
          <button class="btn sm danger" type="button" data-track-delete="${row.id}">删除</button>
        </td>
      </tr>`).join('')}</tbody>
    </table>` : '<p class="muted">还没有音轨或字幕。</p>'}`, (body, close) => {
    body.querySelector('[data-track-add]').addEventListener('click', () => {
      close()
      openTrackForm(episodeId)
    })
    body.querySelectorAll('[data-track-edit]').forEach((button) => {
      button.addEventListener('click', () => {
        const track = rows.find((row) => Number(row.id) === Number(button.dataset.trackEdit))
        close()
        openTrackForm(episodeId, track)
      })
    })
    body.querySelectorAll('[data-track-default]').forEach((button) => {
      button.addEventListener('click', async () => {
        try {
          await api(`/admin/api/tracks/${button.dataset.trackDefault}`, { method: 'PUT', body: { isDefault: true } })
          toast('已设为默认')
          close()
          await openTracksDialog(episodeId)
        } catch (error) {
          toast(error.message)
        }
      })
    })
    body.querySelectorAll('[data-track-delete]').forEach((button) => {
      button.addEventListener('click', async () => {
        if (!(await askConfirm({ title: '删除轨道', message: '删除后播放器将不再显示该音轨/字幕。', confirmText: '删除', danger: true }))) return
        try {
          await api(`/admin/api/tracks/${button.dataset.trackDelete}`, { method: 'DELETE' })
          toast('已删除')
          close()
          await openTracksDialog(episodeId)
        } catch (error) {
          toast(error.message)
        }
      })
    })
  }, { className: 'track-modal' })
}

function openTrackForm(episodeId, track = null) {
  const editing = Boolean(track)
  openOverlay(editing ? '编辑音轨/字幕' : '新增音轨/字幕', `
    <form class="overlay-form">
      <div class="grid-2">
        <label class="field"><span>类型</span>
          <select id="tr-kind">
            <option value="audio"${track?.kind === 'audio' ? ' selected' : ''}>音轨</option>
            <option value="subtitle"${track?.kind === 'subtitle' ? ' selected' : ''}>字幕</option>
          </select>
        </label>
        <label class="field"><span>语言</span>
          <input id="tr-language" value="${esc(track?.language ?? '')}" placeholder="zh-Hans / yue / en" autocomplete="off" autofocus />
        </label>
      </div>
      <div class="grid-2">
        <label class="field"><span>版本/片源</span>
          <input id="tr-edition" value="${esc(track?.edition ?? 'original')}" placeholder="original / mandarin-dub" autocomplete="off" />
        </label>
        <label class="field"><span>展示名</span>
          <input id="tr-label" value="${esc(track?.label ?? '')}" placeholder="粤语原声 / 简体中文" autocomplete="off" />
        </label>
      </div>
      <label class="field"><span>来源（可选）</span>
        <input id="tr-source" value="${esc(track?.source ?? '')}" placeholder="官方字幕 / 蓝光" autocomplete="off" />
      </label>
      <label class="field"><span>URI</span>
        <input id="tr-uri" value="${esc(track?.uri ?? '')}" placeholder="/media/hls/.../audio/index.m3u8 或 .vtt" autocomplete="off" />
      </label>
      <label class="field inline"><span><input id="tr-default" type="checkbox"${track?.is_default ? ' checked' : ''} /> 设为默认</span></label>
      <p class="field-error" id="tr-error" role="alert"></p>
      <div class="modal-foot">
        <button class="btn" type="button" data-cancel>取消</button>
        <button class="btn primary" type="submit">保存</button>
      </div>
    </form>`, (body, close) => {
    body.querySelector('[data-cancel]').addEventListener('click', close)
    body.querySelector('.overlay-form').addEventListener('submit', async (event) => {
      event.preventDefault()
      const payload = {
        kind: body.querySelector('#tr-kind').value,
        language: body.querySelector('#tr-language').value.trim(),
        edition: body.querySelector('#tr-edition').value.trim(),
        label: body.querySelector('#tr-label').value.trim(),
        source: body.querySelector('#tr-source').value.trim(),
        uri: body.querySelector('#tr-uri').value.trim(),
        isDefault: body.querySelector('#tr-default').checked,
      }
      const errorNode = body.querySelector('#tr-error')
      try {
        if (editing) await api(`/admin/api/tracks/${track.id}`, { method: 'PUT', body: payload })
        else await api(`/admin/api/episodes/${episodeId}/tracks`, { method: 'POST', body: payload })
        close()
        toast(editing ? '已保存' : '已新增')
        await openTracksDialog(episodeId)
      } catch (error) {
        errorNode.textContent = error.message
      }
    })
  }, { className: 'track-modal' })
}

/* ---------------- 首页运营 ---------------- */
async function pageOps() {
  const [banners, sections] = await Promise.all([api('/admin/api/banners'), api('/admin/api/sections')])
  const bannerPage = clientPage('opsBanners', banners.list ?? [], 20)
  view.innerHTML = `
    <div class="panel">
      <h3>首页 Banner<span class="spacer"></span><button class="btn primary" id="add-banner">新增 Banner</button></h3>
      <table><thead><tr><th>图</th><th>名称/标题</th><th>跳转剧集</th><th>排序</th><th>启用</th><th>操作</th></tr></thead><tbody>
        ${bannerPage.items.map((row) => `<tr>
          <td><img class="mini" loading="lazy" src="${esc(mediaUrl(row.image))}" alt="" data-img-fallback="hide" /></td>
          <td>${esc(row.name)}<div class="muted">${esc(row.title ?? '')}</div></td>
          <td>#${esc(row.target_drama_id ?? '—')}</td>
          <td>${row.sort}</td>
          <td>${row.enabled ? '<span class="pill ok">启用</span>' : '<span class="pill">停用</span>'}</td>
          <td class="row-actions">
            <button class="btn sm" data-toggle-banner="${row.id}" data-enabled="${row.enabled ? 0 : 1}">${row.enabled ? '停用' : '启用'}</button>
            <button class="btn sm danger" data-del-banner="${row.id}">删除</button>
          </td></tr>`).join('')}
      </tbody></table>
      ${pager('opsBanners', bannerPage.page, bannerPage.pageSize, bannerPage.total, '个')}
    </div>
    <div class="panel">
      <h3>首页楼层<span class="spacer"></span><button class="btn primary" id="add-section">新增楼层</button></h3>
      ${sections.list.map((section) => `
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px">
          <div style="display:flex;gap:10px;align-items:center">
            <strong>${esc(section.title)}</strong><span class="muted">#${section.id} · 排序 ${section.sort} · ${section.items.length} 部</span>
            <span class="spacer" style="flex:1"></span>
            <button class="btn sm" data-attach-section="${section.id}">挂剧集</button>
            <button class="btn sm danger" data-del-section="${section.id}">删除</button>
          </div>
          <div class="muted" style="margin-top:6px">${section.items.map((item) => `#${item.drama_id} ${esc(item.title)}`).join(' · ') || '（空）'}</div>
        </div>`).join('')}
    </div>`

  $('#add-banner').addEventListener('click', async () => {
    const name = await askText({ title: '新增 Banner', label: 'Banner 名称', confirmText: '下一步' })
    if (name === null) return
    const image = await askText({ title: '新增 Banner', label: '图片地址', placeholder: 'https://…', required: false, confirmText: '下一步' })
    if (image === null) return
    const target = await askText({ title: '新增 Banner', label: '跳转剧集 ID（可空）', required: false, confirmText: '创建' })
    if (target === null) return
    await api('/admin/api/banners', { method: 'POST', body: { name, title: name, image, targetDramaId: target ? Number(target) : null } })
    await pageOps()
  })
  view.querySelectorAll('[data-toggle-banner]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/banners/${button.dataset.toggleBanner}`, { method: 'PUT', body: { enabled: button.dataset.enabled === '1' } })
      await pageOps()
    })
  })
  view.querySelectorAll('[data-del-banner]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/banners/${button.dataset.delBanner}`, { method: 'DELETE' })
      await pageOps()
    })
  })
  $('#add-section').addEventListener('click', async () => {
    const title = await askText({ title: '新增首页楼层', label: '楼层标题', confirmText: '创建' })
    if (title === null) return
    await api('/admin/api/sections', { method: 'POST', body: { title } })
    await pageOps()
  })
  view.querySelectorAll('[data-attach-section]').forEach((button) => {
    button.addEventListener('click', async () => {
      const dramaId = await askText({ title: '挂载剧集', label: '剧集 ID', confirmText: '挂载' })
      if (dramaId === null) return
      await api('/admin/api/sections', { method: 'POST', body: { action: 'attach', sectionId: Number(button.dataset.attachSection), dramaId: Number(dramaId), sort: 0 } })
      await pageOps()
    })
  })
  view.querySelectorAll('[data-del-section]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/sections/${button.dataset.delSection}`, { method: 'DELETE' })
      await pageOps()
    })
  })
  bindPager('opsBanners', pageOps)
}

/* ---------------- 榜单 ---------------- */
const RANK_TYPE_LABEL = { HOT: '热播榜', RISE: '飙升榜', SEARCH: '搜索榜', CLASSIC: '口碑榜' }

async function pageRanks() {
  const data = await api('/admin/api/ranks')
  view.innerHTML = `
    <div class="panel">
      <h3>榜单 <span class="muted">每日自动按用户行为重算</span><span class="spacer"></span>
        <button class="btn primary" id="refresh-ranks">立即刷新全部</button>
        <button class="btn" id="add-rank">＋ 新增榜单</button>
      </h3>
      <p class="muted">自动榜每日重算；锁定项刷新时保留。</p>
      ${(data.list ?? []).map((list) => `
        <div style="border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <strong>${esc(list.name)}</strong>
            <span class="pill">${esc(RANK_TYPE_LABEL[list.type] ?? list.type)}</span>
            <span class="pill ${list.auto ? 'ok' : ''}">${list.auto ? '自动更新' : '人工维护'}</span>
            <span class="muted">${list.updated_at ? `上次刷新 ${esc(list.updated_at)}` : '尚未刷新'}</span>
            <span class="spacer" style="flex:1"></span>
            <button class="btn sm" data-refresh="${list.id}">刷新此榜</button>
            <button class="btn sm" data-attach-rank="${list.id}">加榜单项</button>
          </div>
          <table class="rank-items-table" style="margin-top:8px">
            <thead><tr><th>名次</th><th>剧集</th><th>得分</th><th>来源</th><th>操作</th></tr></thead>
            <tbody>
              ${(list.items ?? []).map((item) => `<tr>
                <td>${item.rank_no}</td>
                <td>#${item.drama_id} ${esc(item.title ?? '')}</td>
                <td>${item.score === null || item.score === undefined ? '—' : Number(item.score).toFixed(1)}</td>
                <td>${item.locked ? '<span class="pill warn">人工锁定</span>' : '<span class="muted">自动</span>'}</td>
                <td><button class="btn sm" data-lock="${list.id}" data-drama="${item.drama_id}" data-locked="${item.locked ? 1 : 0}">${item.locked ? '解锁' : '锁定'}</button></td>
              </tr>`).join('') || '<tr><td colspan="5" class="muted">（空）点「刷新此榜」按现有数据生成</td></tr>'}
            </tbody>
          </table>
        </div>`).join('')}
    </div>`

  $('#refresh-ranks').addEventListener('click', async () => {
    try {
      const result = await api('/admin/api/ranks/refresh', { method: 'POST', body: { limit: 20 } })
      const ok = (result.results ?? []).filter((row) => !row.error)
      toast(`已刷新 ${ok.length} 个榜（生成 ${ok.reduce((sum, row) => sum + (row.added ?? 0), 0)} 条）`)
      await pageRanks()
    } catch (error) { toast(error.message) }
  })
  view.querySelectorAll('[data-refresh]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/admin/api/ranks/${button.dataset.refresh}/refresh`, { method: 'POST', body: { limit: 20 } })
      toast(`已刷新：保留锁定 ${result.kept} 条，新增 ${result.added} 条`)
      await pageRanks()
    } catch (error) { toast(error.message) }
  }))
  view.querySelectorAll('[data-lock]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/admin/api/ranks/${button.dataset.lock}/lock`, {
        method: 'POST',
        body: { dramaId: Number(button.dataset.drama), locked: button.dataset.locked !== '1' },
      })
      await pageRanks()
    } catch (error) { toast(error.message) }
  }))
  view.querySelectorAll('[data-attach-rank]').forEach((button) => button.addEventListener('click', () => {
    openOverlay('加入榜单', `
      <div class="field"><label>搜索剧集</label><input id="rk-search" placeholder="输入标题" /></div>
      <div class="field"><label>剧集</label><select id="rk-drama"></select></div>
      <div class="field"><label>名次</label><input id="rk-no" type="number" value="1" /></div>
      <div class="modal-foot"><button class="btn primary" id="rk-save">加入</button></div>
    `, (body, close) => {
      const select = body.querySelector('#rk-drama')
      const search = body.querySelector('#rk-search')
      let timer
      const loadDramas = async () => {
        const keyword = search.value.trim()
        const query = new URLSearchParams({ page: '1', pageSize: '50' })
        if (keyword) query.set('keyword', keyword)
        const result = await api(`/admin/api/dramas?${query.toString()}`)
        select.innerHTML = (result.list ?? []).map((row) => `<option value="${row.id}">#${row.id} ${esc(row.title)}</option>`).join('')
        if (!result.list?.length) select.innerHTML = '<option value="">没有匹配剧集</option>'
      }
      void loadDramas()
      search.addEventListener('input', () => {
        clearTimeout(timer)
        timer = setTimeout(() => void loadDramas(), 250)
      })
      body.querySelector('#rk-save').addEventListener('click', async () => {
        if (!body.querySelector('#rk-drama').value) return toast('请先选择剧集')
        await api('/admin/api/ranks', {
          method: 'POST',
          body: { action: 'attach', listId: Number(button.dataset.attachRank), dramaId: Number(body.querySelector('#rk-drama').value), rankNo: Number(body.querySelector('#rk-no').value || 1) },
        })
        close()
        await pageRanks()
      })
    })
  }))
  $('#add-rank').addEventListener('click', () => {
    openOverlay('新增榜单', `
      <div class="field"><label>名称</label><input id="nr-name" placeholder="如：本周热播" /></div>
      <div class="field"><label>类型</label>
        <select id="nr-type">${Object.entries(RANK_TYPE_LABEL).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div>
      <div class="modal-foot"><button class="btn primary" id="nr-save">创建</button></div>
    `, (body, close) => {
      body.querySelector('#nr-save').addEventListener('click', async () => {
        const name = body.querySelector('#nr-name').value.trim()
        if (!name) return toast('请填名称')
        await api('/admin/api/ranks', { method: 'POST', body: { name, type: body.querySelector('#nr-type').value } })
        close()
        await pageRanks()
      })
    })
  })
}

/* ---------------- 审核 ---------------- */
async function pageReview() {
  const [danmus, comments] = await Promise.all([
    api(`/admin/api/danmus?page=${listPages.reviewDanmu}&pageSize=20`),
    api(`/admin/api/comments?page=${listPages.reviewComments}&pageSize=20`),
  ])
  listPages.reviewDanmu = Number(danmus.page ?? 1)
  listPages.reviewComments = Number(comments.page ?? 1)
  view.innerHTML = `
    <div class="panel">
      <h3>弹幕审核 <span class="muted">待审 ${fmt(danmus.total ?? danmus.list.length)}</span></h3>
      <table><thead><tr><th>ID</th><th>分集</th><th>时间</th><th>内容</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${danmus.list.map((row) => `<tr>
          <td>${row.id}</td><td>EP ${row.episode_id}</td><td>${Math.round(row.time_ms / 1000)}s</td>
          <td>${esc(row.content)}</td><td>${statusPill(row.status)}</td>
          <td class="row-actions">${reviewButtons('danmus', row)}</td></tr>`).join('')}
      </tbody></table>
      ${pager('reviewDanmu', listPages.reviewDanmu, danmus.pageSize, danmus.total, '条')}
    </div>
    <div class="panel">
      <h3>评论审核 <span class="muted">待审 ${fmt(comments.total ?? comments.list.length)}</span></h3>
      <table><thead><tr><th>ID</th><th>剧集</th><th>内容</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${comments.list.map((row) => `<tr>
          <td>${row.id}</td><td>#${row.drama_id}</td><td>${esc(row.content)}</td>
          <td>${statusPill(row.status)}</td><td class="row-actions">${reviewButtons('comments', row)}</td></tr>`).join('')}
      </tbody></table>
      ${pager('reviewComments', listPages.reviewComments, comments.pageSize, comments.total, '条')}
    </div>`

  view.querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [table, id, action] = button.dataset.review.split(':')
      await api(`/admin/api/${table}/${id}/${action}`, { method: 'POST', body: {} })
      toast(action === 'approve' ? '已通过' : '已驳回')
      await pageReview()
    })
  })
  bindPager('reviewDanmu', pageReview)
  bindPager('reviewComments', pageReview)
}

const statusPill = (status) => status === 'approved' ? '<span class="pill ok">已通过</span>' : status === 'rejected' ? '<span class="pill bad">已驳回</span>' : '<span class="pill warn">待审</span>'
const reviewButtons = (table, row) => `
  <button class="btn sm" data-review="${table}:${row.id}:approve">通过</button>
  <button class="btn sm danger" data-review="${table}:${row.id}:reject">驳回</button>`

/* ---------------- 用户 ---------------- */
async function pageUsers() {
  const data = await api(`/admin/api/users?page=${listPages.users}&pageSize=20`)
  listPages.users = Number(data.page ?? 1)
  const perms = new Set(state.me?.permissions ?? [])
  const canPassword = perms.has('user.password')
  const canManage = perms.has('user.manage')
  const canAssist = perms.has('user.login.assist')
  const rows = data.list.map((row) => `<tr>
    <td>${row.id}</td>
    <td class="mono">${esc(row.email ?? row.phone ?? '')}</td>
    <td>${esc(row.nickname)}</td>
    <td>${row.avatar ? '<span class="pill ok">有</span>' : '<span class="pill">无</span>'}</td>
    <td>${row.status === 'banned' ? '<span class="pill bad">已禁用</span>' : '<span class="pill ok">正常</span>'}</td>
    <td>${esc(fmtTs(row.vip_until))}</td>
    <td>${row.order_count}</td>
    <td>¥${Number(row.paid_total).toFixed(2)}</td>
    <td class="row-actions">${canManage ? `<button class="btn sm" data-toggle="${row.id}" data-status="${row.status === 'banned' ? 'active' : 'banned'}">${row.status === 'banned' ? '解禁' : '禁用'}</button>` : ''}
        ${canPassword ? `<button class="btn sm" data-user-password="${row.id}" data-mode="set">改密</button>
        ${row.email ? `<button class="btn sm" data-user-password="${row.id}" data-mode="reset">重置密码</button>` : ''}` : ''}
        ${canAssist && row.email ? `<button class="btn sm ghost" data-code="${row.id}">登录码</button>` : ''}
        ${!canManage && !canPassword && !canAssist ? '<span class="muted">—</span>' : ''}</td>
  </tr>`)
  view.innerHTML = `<div class="panel">
    <h3>用户<span class="spacer"></span><span class="muted small">共 ${fmt(data.total ?? data.list.length)} 人</span></h3>
    <table><thead><tr><th>ID</th><th>邮箱</th><th>昵称</th><th>头像</th><th>状态</th><th>会员到期</th><th>订单数</th><th>累计付费</th><th>操作</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    ${pager('users', listPages.users, data.pageSize, data.total, '人')}
    <p class="muted">C 端使用邮箱验证码登录。</p>
  </div>`
  bindPager('users', pageUsers)
  view.querySelectorAll('[data-code]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = await askText({ title: '签发一次性登录码', label: '签发原因', hint: '原因会写入审计日志。', minLength: 2, confirmText: '生成' })
      if (reason === null) return
      try {
        const result = await api(`/admin/api/users/${button.dataset.code}/login-code`, { method: 'POST', body: { reason } })
        await showNotice({
          title: '一次性登录码已生成',
          message: `${result.email}\n${Math.round(result.expiresIn / 60)} 分钟内有效，仅可使用一次。请通过可靠渠道转交用户，关闭后无法再次查看。`,
          code: result.code,
        })
        await pageUsers()
      } catch (error) {
        toast(error.message)
      }
    })
  })
  view.querySelectorAll('[data-user-password]').forEach((button) => {
    button.addEventListener('click', () => {
      const user = data.list.find((row) => Number(row.id) === Number(button.dataset.userPassword))
      if (user) openUserPasswordEditor(user, button.dataset.mode)
    })
  })
  view.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = await askText({ title: button.dataset.status === 'banned' ? '禁用用户' : '恢复用户', label: '操作原因', hint: '原因会写入审计日志。', minLength: 2, confirmText: '提交' })
      if (reason === null) return
      await api(`/admin/api/users/${button.dataset.toggle}/status`, { method: 'POST', body: { status: button.dataset.status, reason } })
      toast('已更新用户状态')
      await pageUsers()
    })
  })
}

function openUserPasswordEditor(user, mode) {
  const reset = mode === 'reset'
  openOverlay(reset ? '重置用户密码' : '修改用户密码', `
    <p class="muted">${esc(user.email ?? user.phone ?? `#${user.id}`)}</p>
    ${reset
      ? '<p>将生成临时密码并发送到用户注册邮箱，旧会话立即失效。</p>'
      : `<label>新密码<input id="up-pass" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母和数字" /></label>
         <label style="margin-top:10px">确认密码<input id="up-pass2" type="password" autocomplete="new-password" /></label>`}
    <label style="display:block;margin-top:10px">操作原因（可选）<input id="up-reason" /></label>`,
  (body, close) => {
    const foot = document.createElement('div')
    foot.className = 'modal-foot'
    foot.innerHTML = `<button class="btn" data-cancel>取消</button><button class="btn primary" id="up-save">${reset ? '发送重置邮件' : '保存密码'}</button>`
    body.appendChild(foot)
    foot.querySelector('[data-cancel]').addEventListener('click', close)
    foot.querySelector('#up-save').addEventListener('click', async (event) => {
      const button = event.currentTarget
      let password
      if (!reset) {
        password = body.querySelector('#up-pass').value
        if (password !== body.querySelector('#up-pass2').value) return toast('两次密码不一致')
      }
      button.disabled = true
      try {
        const result = await api(`/admin/api/users/${user.id}/password`, {
          method: 'POST',
          body: { mode, password, reason: body.querySelector('#up-reason').value.trim() },
        })
        close()
        toast(reset ? `临时密码已发送至 ${result.email}` : '密码已更新')
        await pageUsers()
      } catch (error) {
        toast(error.message)
        button.disabled = false
      }
    })
  })
}

/* ---------------- 通用小工具 ---------------- */
function panel(title, body, extra = '') {
  return `<div class="panel"><h3>${title}<span class="spacer"></span>${extra}</h3>${body}</div>`
}
function table(headers, rows, className = '') {
  return `<table${className ? ` class="${className}"` : ''}><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
}
const listPages = { dramas: 1, users: 1, orders: 1, audit: 1, refunds: 1, reviewDanmu: 1, reviewComments: 1 }

function pagerNumbers(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const values = new Set([1, pages, page - 1, page, page + 1])
  if (page <= 4) [2, 3, 4, 5].forEach((value) => values.add(value))
  if (page >= pages - 3) [pages - 4, pages - 3, pages - 2, pages - 1].forEach((value) => values.add(value))
  const sorted = [...values].filter((value) => value >= 1 && value <= pages).sort((a, b) => a - b)
  const result = []
  for (const value of sorted) {
    if (result.length && value - result[result.length - 1] > 1) result.push('…')
    result.push(value)
  }
  return result
}

function pager(key, page, pageSize, total, unit = '条') {
  const count = Math.max(0, Number(total ?? 0))
  const pages = Math.max(1, Math.ceil(count / Math.max(1, Number(pageSize) || 20)))
  const current = Math.min(Math.max(1, Number(page) || 1), pages)
  const numbers = pagerNumbers(current, pages)
  return `<nav class="pager" aria-label="分页">
    <span class="pager-summary">共 <b>${fmt(count)}</b> ${unit} · 第 <b>${current}</b> / ${pages} 页</span>
    <div class="pager-pages">
      <button class="pager-btn pager-step" type="button" data-pager="${key}" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''} aria-label="上一页">上一页</button>
      ${numbers.map((value) => value === '…'
        ? '<span class="pager-gap" aria-hidden="true">…</span>'
        : `<button class="pager-btn ${value === current ? 'is-current' : ''}" type="button" data-pager="${key}" data-page="${value}" ${value === current ? 'aria-current="page"' : ''} aria-label="第 ${value} 页">${value}</button>`).join('')}
      <button class="pager-btn pager-step" type="button" data-pager="${key}" data-page="${current + 1}" ${current >= pages ? 'disabled' : ''} aria-label="下一页">下一页</button>
    </div>
  </nav>`
}

function clientPage(key, items, pageSize = 20) {
  const list = Array.isArray(items) ? items : []
  const pages = Math.max(1, Math.ceil(list.length / Math.max(1, pageSize)))
  const page = Math.min(Math.max(1, Number(listPages[key] ?? 1)), pages)
  listPages[key] = page
  return {
    items: list.slice((page - 1) * pageSize, page * pageSize),
    total: list.length,
    page,
    pages,
    pageSize,
  }
}

function bindPager(key, rerender) {
  view.querySelectorAll(`[data-pager="${key}"]`).forEach((button) => {
    button.addEventListener('click', async () => {
      if (button.disabled) return
      listPages[key] = Number(button.dataset.page)
      await rerender()
      view.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    })
  })
}
const pillOf = (status) => {
  const map = {
    fulfilled: ['ok', '已支付'], paid: ['ok', '已支付'], created: ['', '待支付'], pending: ['', '待支付'],
    closed: ['bad', '已关闭'], refunded: ['bad', '已退款'], refunding: ['', '退款中'],
    active: ['ok', '启用'], disabled: ['', '停用'], draft: ['', '草稿'], published: ['ok', '已上架'],
    approved: ['ok', '已通过'], rejected: ['bad', '已驳回'], done: ['ok', '已完成'],
  }
  const [cls, label] = map[status] ?? ['', status]
  return `<span class="pill ${cls}">${esc(label)}</span>`
}

/* ---------------- 付费策略 + 按集定价规则 ---------------- */
const ACCESS_LABEL_POLICY = { free: '免费', subscription: '会员免费', paid: '单独收费' }
const RULE_MODE_LABEL = { free: '免费观看', vip: '需会员', single: '需单集购买' }

function rulesSummary(rules) {
  if (!rules || !rules.length) return '<span class="muted">沿用整体策略</span>'
  return rules.map((rule) => {
    const range = rule.to_no ? `第 ${rule.from_no}-${rule.to_no} 集` : `第 ${rule.from_no} 集起`
    const extra = rule.mode === 'single' ? ` ¥${Number(rule.price_cny ?? 0).toFixed(2)}` : ''
    return `<span class="pill">${range} · ${RULE_MODE_LABEL[rule.mode] ?? rule.mode}${extra}</span>`
  }).join(' ')
}

async function pagePolicies() {
  const data = await api('/admin/api/policy-groups')
  const options = data.options ?? { categories: [], dramaStatus: [], accessModes: [] }
  const groupList = data.groups ?? []
  const groupPage = clientPage('policyGroups', groupList, 20)
  const categoryOptions = options.categories ?? []
  const statusRows = options.dramaStatus ?? []
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>付费策略组 <span class="muted">${groupList.length} 个组 · 未分组 ${fmt(data.ungrouped ?? 0)} 部</span></h3>
        <div class="drama-actions">
          <a class="btn" href="#/dramas">去剧集列表分配</a>
          <button class="btn primary" id="policy-group-new">＋ 新建策略组</button>
        </div>
      </div>
      ${table(['策略组', '模式', '免费集', '试看(秒)', '单片价', '已分配', '操作'], groupPage.items.map((group) => `<tr>
        <td class="policy-name"><strong>${esc(group.name)}</strong><div class="muted">${esc(group.description ?? '')}</div></td>
        <td class="policy-mode" data-label="模式">${esc(ACCESS_LABEL_POLICY[group.access_mode] ?? group.access_mode)}</td>
        <td class="policy-free" data-label="免费集">${group.free_episodes}</td>
        <td class="policy-trial" data-label="试看(秒)">${group.trial_seconds}</td>
        <td class="policy-price" data-label="单片价">¥${Number(group.single_price_cny ?? 0).toFixed(2)}</td>
        <td class="policy-assigned" data-label="已分配">${fmt(group.assigned ?? 0)} 部</td>
        <td class="row-actions policy-actions">
          <button class="btn sm primary" data-group-assign="${group.id}">批量分配</button>
          <button class="btn sm" data-group-edit="${group.id}">编辑</button>
          <button class="btn sm danger" data-group-del="${group.id}">删除</button>
        </td>
      </tr>`), 'policy-table')}
      ${pager('policyGroups', groupPage.page, groupPage.pageSize, groupPage.total, '个')}
      <p class="muted">策略组是付费规则的唯一来源。修改组会立即影响所有已分配剧集；单部或批量分配在「剧集管理」完成。</p>
    </div>`

  const groupById = (id) => groupList.find((group) => Number(group.id) === Number(id))
  const openPolicyGroupForm = (group) => {
    openOverlay(group ? `编辑策略组 · ${group.name}` : '新建策略组', `
      <div class="grid-2">
        <label>名称<input id="pg-name" value="${esc(group?.name ?? '')}" /></label>
        <label>说明<input id="pg-desc" value="${esc(group?.description ?? '')}" /></label>
        <label>模式<select id="pg-mode">${(options.accessModes ?? []).map((item) => `<option value="${esc(item.value)}" ${group?.access_mode === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
        <label>免费集<input id="pg-free" type="number" min="0" value="${group?.free_episodes ?? 1}" /></label>
        <label>试看秒数<input id="pg-trial" type="number" min="0" value="${group?.trial_seconds ?? 0}" /></label>
        <label>单片价<input id="pg-price" type="number" min="0" step="0.01" value="${group?.single_price_cny ?? 0}" /></label>
        <label>售卖方式<select id="pg-kind">
          <option value="single" ${group?.purchase_kind !== 'rental' ? 'selected' : ''}>买断</option>
          <option value="rental" ${group?.purchase_kind === 'rental' ? 'selected' : ''}>租赁</option>
        </select></label>
        <label>租赁时长（小时）<input id="pg-hours" type="number" min="1" value="${group?.rental_hours ?? 72}" /></label>
      </div>`, (body, close) => {
      const foot = document.createElement('div')
      foot.className = 'modal-foot'
      foot.innerHTML = '<button class="btn" data-cancel>取消</button><button class="btn primary" id="pg-save">保存</button>'
      body.appendChild(foot)
      foot.querySelector('[data-cancel]').addEventListener('click', close)
      foot.querySelector('#pg-save').addEventListener('click', async () => {
        try {
          const payload = {
            name: body.querySelector('#pg-name').value.trim(),
            description: body.querySelector('#pg-desc').value.trim(),
            accessMode: body.querySelector('#pg-mode').value,
            freeEpisodes: Number(body.querySelector('#pg-free').value || 0),
            trialSeconds: Number(body.querySelector('#pg-trial').value || 0),
            singlePrice: Number(body.querySelector('#pg-price').value || 0),
            purchaseKind: body.querySelector('#pg-kind').value,
            rentalHours: Number(body.querySelector('#pg-hours').value || 72),
          }
          if (!payload.name) return toast('策略组名称必填')
          await api(group ? `/admin/api/policy-groups/${group.id}` : '/admin/api/policy-groups', { method: group ? 'PUT' : 'POST', body: payload })
          close()
          await pagePolicies()
        } catch (error) { toast(error.message) }
      })
    })
  }
  const openGroupAssign = (group) => {
    openOverlay(`批量分配 · ${group.name}`, `
      <div class="form-row">
        <input id="pga-q" class="input" aria-label="标题关键词" placeholder="标题关键词（可选）" />
        <select id="pga-cat"><option value="all">全部内容类型</option>${categoryOptions.map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('')}</select>
        <select id="pga-status"><option value="all">全部状态</option>${statusRows.map((item) => `<option value="${esc(item.value)}" ${item.value === 'published' ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select>
        <button class="btn" type="button" id="pga-preview">预览</button>
        <button class="btn primary" type="button" id="pga-apply">分配</button>
      </div>
      <div class="bulk-result" id="pga-result">先预览影响范围，再确认分配</div>`, (body, close) => {
      const payload = () => ({ filters: {
        keyword: body.querySelector('#pga-q').value.trim(),
        category: body.querySelector('#pga-cat').value,
        status: body.querySelector('#pga-status').value,
      } })
      const preview = () => api(`/admin/api/policy-groups/${group.id}/assign`, { method: 'POST', body: { ...payload(), dryRun: true } })
      body.querySelector('#pga-preview').addEventListener('click', async () => {
        try {
          const result = await preview()
          body.querySelector('#pga-result').textContent = result.matched
            ? `将影响 ${fmt(result.matched)} 部：${result.sample.map((row) => `《${row.title}》`).join('、')}`
            : '没有匹配剧集'
        } catch (error) { body.querySelector('#pga-result').textContent = error.message }
      })
      body.querySelector('#pga-apply').addEventListener('click', async () => {
        const button = body.querySelector('#pga-apply')
        if (button.disabled) return
        button.disabled = true
        button.textContent = '分配中…'
        try {
          const result = await preview()
          if (!result.matched) {
            body.querySelector('#pga-result').textContent = '没有匹配剧集'
            return
          }
          if (!(await askConfirm({
            title: '批量分配策略组',
            message: `确认将 ${result.matched} 部剧集分配到「${group.name}」？`,
            confirmText: '分配',
          }))) return
          await api(`/admin/api/policy-groups/${group.id}/assign`, { method: 'POST', body: payload() })
          close()
          toast(`已分配 ${fmt(result.matched)} 部剧集`)
          await pagePolicies()
        } catch (error) {
          body.querySelector('#pga-result').textContent = error.message
          toast(error.message)
        } finally {
          button.disabled = false
          button.textContent = '分配'
        }
      })
    })
  }
  $('#policy-group-new').addEventListener('click', () => openPolicyGroupForm(null))
  view.querySelectorAll('[data-group-edit]').forEach((button) => button.addEventListener('click', () => openPolicyGroupForm(groupById(button.dataset.groupEdit))))
  view.querySelectorAll('[data-group-assign]').forEach((button) => button.addEventListener('click', () => openGroupAssign(groupById(button.dataset.groupAssign))))
  view.querySelectorAll('[data-group-del]').forEach((button) => button.addEventListener('click', async () => {
    if (!(await askConfirm({ title: '删除策略组', message: '已分配的剧集需要先改派，删除后不可恢复。', confirmText: '删除', danger: true }))) return
    try {
      await api(`/admin/api/policy-groups/${button.dataset.groupDel}`, { method: 'DELETE' })
      toast('策略组已删除')
      await pagePolicies()
    } catch (error) { toast(error.message) }
  }))
  bindPager('policyGroups', pagePolicies)
}

/** 按集规则编辑器：可以叠加多条区间规则，保存时整体替换。 */
async function openRuleEditor(dramaId, title) {
  const data = await api(`/admin/api/dramas/${dramaId}/pricing-rules`)
  const rules = (data.rules ?? []).map((rule) => ({
    fromNo: rule.from_no, toNo: rule.to_no ?? '', mode: rule.mode, price: Number(rule.price_cny ?? 0), note: rule.note ?? '',
  }))
  openOverlay(`按集定价 · ${title}`, `
    <p class="muted">共 ${data.episodeCount} 集；规则从上到下匹配，未命中时走整体策略。</p>
    <div id="rules-body"></div>
    <button class="btn sm" id="rule-add">＋ 加一条规则</button>
    <div class="modal-foot">
      <button class="btn" id="rule-clear">清空全部规则</button>
      <button class="btn primary" id="rule-save">保存规则</button>
    </div>
  `, (body, close) => {
    const host = body.querySelector('#rules-body')
    const paint = () => {
      host.innerHTML = rules.map((rule, index) => `<div class="grid-2" style="align-items:end;margin-bottom:8px" data-rule="${index}">
        <div class="field"><label>起始集</label><input type="number" min="1" data-k="fromNo" value="${rule.fromNo}" /></div>
        <div class="field"><label>结束集（留空 = 到最后一集）</label><input type="number" min="1" data-k="toNo" value="${rule.toNo}" /></div>
        <div class="field"><label>规则</label><select data-k="mode">${Object.entries(RULE_MODE_LABEL).map(([value, label]) => `<option value="${value}" ${rule.mode === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
        <div class="field"><label>单集价格（仅「需单集购买」用）</label><input type="number" min="0" step="0.01" data-k="price" value="${rule.price}" /></div>
        <div class="field" style="grid-column:1/-1"><label>备注（给运营看）</label>
          <div style="display:flex;gap:8px"><input data-k="note" value="${esc(rule.note)}" />
          <button class="btn sm danger" data-del-rule="${index}">删除</button></div></div>
        <div class="muted rule-preview" data-preview="${index}" style="grid-column:1/-1"></div>
      </div>`).join('') || '<p class="muted">还没有规则：全部剧集走整体策略。</p>'
      const previewText = (rule) => {
        const fromNo = Number(rule.fromNo)
        const toRaw = String(rule.toNo ?? '').trim()
        const toNo = toRaw === '' ? null : Number(toRaw)
        const range = !Number.isInteger(fromNo) || fromNo < 1
          ? '（还没填起始集）'
          : toNo === null ? `第 ${fromNo} 集起` : `第 ${fromNo}–${toNo} 集`
        if (rule.mode === 'single') return `${range} → 需单集购买 ¥${Number(rule.price || 0).toFixed(2)}（会员也要买）`
        if (rule.mode === 'vip') return `${range} → 需开通会员才能看`
        return `${range} → 免费观看`
      }
      const paintPreviews = () => {
        host.querySelectorAll('[data-preview]').forEach((node) => {
          const rule = rules[Number(node.dataset.preview)]
          if (rule) node.textContent = previewText(rule)
        })
      }
      paintPreviews()
      host.querySelectorAll('[data-del-rule]').forEach((node) => node.addEventListener('click', () => {
        rules.splice(Number(node.dataset.delRule), 1)
        paint()
      }))
      host.querySelectorAll('[data-rule]').forEach((node) => node.addEventListener('input', () => {
        const index = Number(node.dataset.rule)
        const rule = rules[index]
        node.querySelectorAll('[data-k]').forEach((input) => { rule[input.dataset.k] = input.value })
        const preview = host.querySelector(`[data-preview="${index}"]`)
        if (preview) preview.textContent = previewText(rule)
      }))
    }
    paint()
    body.querySelector('#rule-add').addEventListener('click', () => {
      // 默认给「最后两集单独收费」——新增一行直接保存也不会把整部剧变成会员专享
      const lastNo = Number(data.lastNo ?? 1)
      rules.push({
        fromNo: Math.max(1, lastNo - 1),
        toNo: lastNo,
        mode: 'single',
        price: Number(data.defaults.singlePrice ?? 0),
        note: '',
      })
      paint()
    })
    body.querySelector('#rule-clear').addEventListener('click', async () => {
      if (!(await askConfirm({ title: '清空按集规则', message: '该剧全部按集定价规则将被删除。', confirmText: '清空', danger: true }))) return
      try {
        await api(`/admin/api/dramas/${dramaId}/pricing-rules`, { method: 'PUT', body: { rules: [] } })
        toast('已清空')
        close()
      } catch (error) { toast(error.message) }
    })
    body.querySelector('#rule-save').addEventListener('click', async () => {
      // 以界面上的实际输入为准（表单里手改过、或浏览器自动填充的值都算数）
      const payload = []
      for (const node of body.querySelectorAll('[data-rule]')) {
        const value = {}
        node.querySelectorAll('[data-k]').forEach((input) => { value[input.dataset.k] = input.value })
        const fromNo = Number(value.fromNo)
        if (!Number.isInteger(fromNo) || fromNo < 1) {
          return toast('每条规则都要填起始集（≥1）')
        }
        const toRaw = String(value.toNo ?? '').trim()
        const toNo = toRaw === '' ? null : Number(toRaw)
        if (toNo !== null && (!Number.isInteger(toNo) || toNo < fromNo)) {
          return toast(`第 ${fromNo} 集那条：结束集不能小于起始集`)
        }
        payload.push({
          fromNo,
          toNo,
          mode: value.mode,
          price: Number(value.price || 0),
          note: value.note ?? '',
        })
      }
      try {
        await api(`/admin/api/dramas/${dramaId}/pricing-rules`, { method: 'PUT', body: { rules: payload } })
        toast('规则已保存')
        close()
        await pagePolicies()
      } catch (error) { toast(error.message) }
    })
  })
}

/* ---------------- 套餐 ---------------- */
async function pagePlans() {
  const data = await api('/admin/api/plans')
  const planPage = clientPage('plans', data.list ?? [], 12)
  const cards = planPage.items.map((plan) => {
    const days = Number(plan.duration_days || 30)
    const price = Number(plan.price_cny || 0)
    const perDay = days > 0 ? price / days : price
    const months = Math.max(1, Math.round(days / 30))
    return `<div class="panel" style="margin:0">
      <h3>${esc(plan.name)} <span class="pill ${plan.status === 'active' ? 'ok' : ''}">${plan.status === 'active' ? '在售' : '已下架'}</span></h3>
      <p style="font-size:26px;font-weight:600;margin:6px 0">¥${price.toFixed(2)}<span class="muted" style="font-size:13px"> / ${months} 个月</span></p>
      <p class="muted">日均 ¥${perDay.toFixed(2)} · 有效期 ${days} 天 · 范围 ${plan.scope === 'all' ? '全部内容' : esc(plan.scope)}</p>
      <p class="muted">权益：${plan.scope === 'all' ? '全站剧集无限观看（含单片付费内容）' : '指定范围内容观看'}</p>
      <p class="mono muted" style="font-size:12px">套餐编码 ${esc(plan.code)}</p>
      <div class="form-row">
        <button class="btn sm" data-toggle-plan="${plan.id}" data-status="${plan.status === 'active' ? 'disabled' : 'active'}">${plan.status === 'active' ? '下架' : '上架'}</button>
      </div>
    </div>`
  }).join('')
  view.innerHTML = `
    <div class="panel">
      <h3>套餐定价 <span class="muted">编码由系统生成，全局唯一</span></h3>
      <div class="form-row">
        <input id="plan-name" aria-label="套餐名" placeholder="套餐名（月卡会员）" />
        <input id="plan-days" aria-label="套餐天数" type="number" placeholder="天数" value="30" style="width:90px" />
        <input id="plan-price" aria-label="套餐价格" type="number" step="0.01" placeholder="价格" style="width:100px" />
        <button class="btn primary" id="plan-add">新增套餐</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">${cards || '<p class="muted">还没有套餐</p>'}</div>
    ${pager('plans', planPage.page, planPage.pageSize, planPage.total, '个')}`
  $('#plan-add').addEventListener('click', async () => {
    const name = $('#plan-name').value.trim()
    if (!name) return toast('请填套餐名')
    await api('/admin/api/plans', {
      method: 'POST',
      body: { name, days: Number($('#plan-days').value || 30), price: Number($('#plan-price').value || 0) },
    })
    await pagePlans()
  })
  view.querySelectorAll('[data-toggle-plan]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/plans/${button.dataset.togglePlan}`, { method: 'PUT', body: { status: button.dataset.status } })
      await pagePlans()
    })
  })
  bindPager('plans', pagePlans)
}

/* ---------------- 优惠券 ---------------- */
async function pageCoupons() {
  const data = await api('/admin/api/coupons')
  const allRows = (data.list ?? []).map((coupon) => `<tr>
    <td class="mono">${esc(coupon.code)}</td><td>${esc(coupon.name)}</td>
    <td>${coupon.discount_type === 'amount' ? '立减' : '折扣'}</td>
    <td>${coupon.discount_type === 'amount' ? '¥' + Number(coupon.discount_value).toFixed(2) : coupon.discount_value + '%'}</td>
    <td>¥${Number(coupon.min_amount).toFixed(2)}</td><td>${coupon.used}/${coupon.total || '不限'}</td>
    <td>${esc(coupon.valid_to ?? '长期')}</td><td>${pillOf(coupon.status)}</td>
    <td><button class="btn sm" data-c-status="${coupon.id}" data-status="${coupon.status === 'active' ? 'disabled' : 'active'}">${coupon.status === 'active' ? '停用' : '启用'}</button></td>
  </tr>`)
  const couponPage = clientPage('coupons', allRows, 20)
  view.innerHTML = panel('优惠券', `
    <p class="muted">券码留空自动生成。</p>
    <div class="form-row">
      <input id="c-code" aria-label="优惠券码" placeholder="券码（留空自动生成）" />
      <input id="c-name" aria-label="优惠券名称" placeholder="名称" />
      <select id="c-type" aria-label="优惠券类型"><option value="amount">立减</option><option value="percent">折扣(%)</option></select>
      <input id="c-value" aria-label="优惠面额或折扣" type="number" step="0.01" placeholder="面额/折扣" style="width:110px" />
      <input id="c-min" aria-label="使用门槛" type="number" step="0.01" placeholder="门槛" style="width:90px" />
      <button class="btn primary" id="c-add">新增</button>
    </div>
    ${table(['券码', '名称', '类型', '面额', '门槛', '已用/总量', '有效期', '状态', '操作'], couponPage.items)}
    ${pager('coupons', couponPage.page, couponPage.pageSize, couponPage.total, '张')}`)
  $('#c-add').addEventListener('click', async () => {
    await api('/admin/api/coupons', {
      method: 'POST',
      body: {
        code: $('#c-code').value.trim(), name: $('#c-name').value.trim(),
        discountType: $('#c-type').value, discountValue: Number($('#c-value').value || 0),
        minAmount: Number($('#c-min').value || 0), total: 0, validTo: '2027-12-31',
      },
    })
    await pageCoupons()
  })
  view.querySelectorAll('[data-c-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/coupons/${button.dataset.cStatus}`, { method: 'PUT', body: { status: button.dataset.status } })
      await pageCoupons()
    })
  })
  bindPager('coupons', pageCoupons)
}

/* ---------------- 订单 ---------------- */
async function pageOrders() {
  // 筛选条件写进 hash，刷新/回退后保持；不依赖全局 state，避免串到其它页面。
  const hashParams = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const status = hashParams.get('status') ?? ''
  const q = hashParams.get('q') ?? ''
  const query = new URLSearchParams({ page: listPages.orders, pageSize: 20 })
  if (status) query.set('status', status)
  if (q) query.set('q', q)
  const data = await api(`/admin/api/orders?${query.toString()}`)
  listPages.orders = Number(data.page ?? 1)
  const total = data.list.filter((order) => ['paid', 'fulfilled'].includes(order.status)).reduce((sum, order) => sum + order.amount_cny, 0)
  const rows = data.list.map((order) => `<tr>
    <td class="mono">${esc(order.out_trade_no)}</td>
    <td>${esc(order.nickname ?? '')}<div class="muted" style="font-size:11px">${esc(order.phone ?? '')}</div></td>
    <td>${order.product_type === 'subscription' ? '会员 · ' + esc(order.plan_name ?? '') : '单片 · ' + esc(order.drama_title ?? '')}</td>
    <td>¥${Number(order.amount_cny).toFixed(2)}</td>
    <td>${esc(order.channel)}</td>
    <td>${pillOf(order.status)}</td>
    <td class="muted">${esc(fmtTs(order.paid_at ?? order.created_at))}</td>
    <td class="row-actions">
      <button class="btn sm" data-detail="${order.id}">详情</button>
      ${['paid', 'fulfilled'].includes(order.status)
        ? `<button class="btn sm danger" data-refund="${order.id}">发起退款</button>`
        : ['created', 'pending'].includes(order.status)
          ? `<button class="btn sm" data-confirm="${order.id}">确认到账</button>`
          : ''}
    </td>
  </tr>`)
  const statusOptions = [['', '全部状态'], ['created', '待支付'], ['pending', '待支付'], ['paid', '已支付'], ['fulfilled', '已完成'], ['refunded', '已退款'], ['closed', '已关闭']]
  view.innerHTML = panel('订单', `
    <div class="form-row" style="margin-bottom:10px">
      <select id="order-status" aria-label="订单状态">
        ${statusOptions.map(([value, label]) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <input id="order-q" aria-label="搜索订单" placeholder="单号 / 用户 / 商品" value="${esc(q)}" style="max-width:260px" />
      <button class="btn" id="order-search">搜索</button>
      <button class="btn" id="order-reset">重置</button>
    </div>
    <p class="muted">共 ${fmt(data.total ?? data.list.length)} 笔 · 本页已支付合计 ¥${total.toFixed(2)}</p>
    ${table(['单号', '用户', '商品', '金额', '渠道', '状态', '时间', '操作'], rows.length ? rows : ['<tr><td colspan="8" class="muted">没有匹配的订单</td></tr>'])}
    ${pager('orders', listPages.orders, data.pageSize, data.total, '笔')}`,
  '<button class="btn" id="close-expired">关闭超时订单</button>')
  const applyOrderFilters = async (resetPage = true) => {
    const next = new URLSearchParams()
    const nextStatus = $('#order-status').value
    const nextQ = $('#order-q').value.trim()
    if (nextStatus) next.set('status', nextStatus)
    if (nextQ) next.set('q', nextQ)
    const suffix = next.toString()
    history.replaceState(null, '', `#/orders${suffix ? `?${suffix}` : ''}`)
    if (resetPage) listPages.orders = 1
    await pageOrders()
  }
  $('#order-search').addEventListener('click', () => applyOrderFilters())
  $('#order-q').addEventListener('keydown', (event) => { if (event.key === 'Enter') applyOrderFilters() })
  $('#order-status').addEventListener('change', () => applyOrderFilters())
  $('#order-reset').addEventListener('click', async () => {
    history.replaceState(null, '', '#/orders')
    listPages.orders = 1
    await pageOrders()
  })
  bindPager('orders', pageOrders)
  $('#close-expired').addEventListener('click', async () => {
    const result = await api('/admin/api/close-expired', { method: 'POST', body: {} })
    toast(`已关闭 ${result.closed} 笔`)
    await pageOrders()
  })
  view.querySelectorAll('[data-detail]').forEach((button) => button.addEventListener('click', () => openOrderDetail(Number(button.dataset.detail))))
  view.querySelectorAll('[data-confirm]').forEach((button) => {
    button.addEventListener('click', async () => {
      const orderId = Number(button.dataset.confirm)
      const txid = await askText({
        title: '确认订单到账',
        label: '链上 txid / 流水号',
        hint: 'USDT 建议填写；留空将记为人工补单。',
        required: false,
        confirmText: '确认到账',
      })
      if (txid === null) return
      try {
        await api(`/admin/api/orders/${orderId}/confirm`, { method: 'POST', body: { txid: txid || undefined } })
        toast('已确认到账并发放权益')
        await pageOrders()
      } catch (error) { toast(error.message) }
    })
  })
  view.querySelectorAll('[data-refund]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = await askText({ title: '发起退款', label: '退款原因', hint: '至少 4 个字，提交后需另一位管理员审批。', minLength: 4, confirmText: '提交退款' })
      if (reason === null) return
      await api('/admin/api/refunds', { method: 'POST', body: { orderId: Number(button.dataset.refund), reason } })
      toast('退款单已创建，需另一位管理员审批')
      await pageOrders()
    })
  })
}

async function openOrderDetail(id) {
  const data = await api(`/admin/api/orders/${id}`)
  const order = data.order ?? {}
  const refunds = data.refunds ?? []
  const rowsOf = [
    ['单号', order.out_trade_no],
    ['用户', `${order.nickname ?? '—'}${order.email ? ` · ${order.email}` : ''}`],
    ['商品', order.product_type === 'subscription' ? `会员 · ${order.plan_name ?? ''}` : `单片 · ${order.drama_title ?? ''}`],
    ['金额', `¥${Number(order.amount_cny ?? 0).toFixed(2)}`],
    ['渠道', order.channel],
    ['状态', pillOf(order.status), true],
    ['创建时间', fmtTs(order.created_at)],
    ['支付时间', fmtTs(order.paid_at)],
  ]
  const refundRows = refunds.map((row) => `<tr><td>${row.id}</td><td>¥${Number(row.amount ?? 0).toFixed(2)}</td><td>${esc(row.reason ?? '')}</td><td>${pillOf(row.status)}</td><td class="muted">${esc(fmtTs(row.created_at))}</td></tr>`)
  openOverlay(`订单详情 · ${order.out_trade_no ?? `#${id}`}`, `
    <table style="margin-bottom:12px"><tbody>
      ${rowsOf.map(([key, value, html]) => `<tr><th style="width:110px">${esc(key)}</th><td>${html ? value : esc(String(value ?? '—'))}</td></tr>`).join('')}
    </tbody></table>
    <h4 style="margin:4px 0 8px">退款记录</h4>
    ${refundRows.length ? table(['ID', '金额', '原因', '状态', '时间'], refundRows) : '<p class="muted">没有退款记录</p>'}
  `)
}

/* ---------------- 退款审核 ---------------- */
async function pageRefunds() {
  const data = await api(`/admin/api/refunds?page=${listPages.refunds}&pageSize=20`)
  listPages.refunds = Number(data.page ?? 1)
  const perms = new Set(state.me?.permissions ?? [])
  const canApprove = perms.has('finance.refund.approve')
  const rows = data.list.map((refund) => `<tr>
    <td>${refund.id}</td><td class="mono">${esc(refund.out_trade_no)}</td><td>${esc(refund.nickname ?? '')}</td>
    <td>¥${Number(refund.amount).toFixed(2)}</td><td>${esc(refund.reason)}</td>
    <td>${refund.status === 'pending' ? '<span class="pill">待审批</span>' : pillOf(refund.status)}</td>
    <td class="row-actions">${refund.status === 'pending' && canApprove ? `<button class="btn sm primary" data-approve="${refund.id}" data-info="${esc(`${refund.out_trade_no} · ${refund.nickname ?? ''} · ¥${Number(refund.amount).toFixed(2)}`)}">通过</button>
      <button class="btn sm danger" data-reject="${refund.id}">驳回</button>` : '—'}</td>
  </tr>`)
  view.innerHTML = panel('退款审核', `
    <p class="muted">双人复核，发起人不能审批。</p>
    ${table(['ID', '单号', '用户', '金额', '原因', '状态', '操作'], rows.length ? rows : ['<tr><td colspan="7" class="muted">暂无退款申请。订单页对已支付订单发起退款后会出现在这里。</td></tr>'])}
    ${pager('refunds', listPages.refunds, data.pageSize, data.total, '笔')}`)
  view.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', async () => {
      // 通过是不可逆的资金动作（回收权益 + 标记已退款），必须先确认影响面
      const info = button.dataset.info ?? ''
      if (!(await askConfirm({
        title: '通过退款',
        message: `${info}\n\n通过后订单置为已退款，该用户对应权益立即回收。`,
        confirmText: '通过并回收权益',
        danger: true,
      }))) return
      try {
        const result = await api(`/admin/api/refunds/${button.dataset.approve}/approve`, { method: 'POST', body: {} })
        toast(result.warning ?? '退款完成，权益已回收')
      } catch (error) { toast(error.message) }
      await pageRefunds()
    })
  })
  view.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = await askText({ title: '驳回退款', label: '驳回原因', hint: '至少 4 个字，原因会通知申请人。', minLength: 4, confirmText: '确认驳回' })
      if (reason === null) return
      await api(`/admin/api/refunds/${button.dataset.reject}/reject`, { method: 'POST', body: { reason } })
      await pageRefunds()
    })
  })
  bindPager('refunds', pageRefunds)
}

/* ---------------- 角色管理 + 独立权限分配 ---------------- */
function flattenTree(nodes, depth = 0, acc = []) {
  for (const node of nodes) {
    acc.push({ ...node, depth })
    if (node.children?.length) flattenTree(node.children, depth + 1, acc)
  }
  return acc
}

function treeVisible(node, keyword) {
  if (!keyword) return true
  const haystack = `${node.name}${node.code}${node.path ?? ''}`.toLowerCase()
  return haystack.includes(keyword.toLowerCase()) || (node.children ?? []).some((child) => treeVisible(child, keyword))
}

function computeHalf(nodes, state) {
  let any = false
  for (const node of nodes) {
    const selfChecked = state.checked.has(node.code)
    const childAny = node.children?.length ? computeHalf(node.children, state) : false
    node.__half = !selfChecked && childAny
    any = any || selfChecked || childAny
  }
  return any
}

function setSubtree(node, checked, state) {
  if (checked) state.checked.add(node.code)
  else state.checked.delete(node.code)
  for (const child of node.children ?? []) setSubtree(child, checked, state)
}

function findNode(nodes, code) {
  for (const node of nodes) {
    if (node.code === code) return node
    const hit = node.children ? findNode(node.children, code) : undefined
    if (hit) return hit
  }
  return undefined
}

function renderTreeNode(node, state, depth = 0) {
  if (!treeVisible(node, state.keyword)) return ''
  const isChecked = state.checked.has(node.code)
  const hasChildren = Boolean(node.children?.length)
  const expanded = state.expanded.has(node.code) || Boolean(state.keyword)
  const typeTag = { dir: '目录', menu: '菜单', button: '按钮' }[node.type] ?? node.type
  return `<div class="tnode">
    <div class="trow ${node.type}" style="padding-left:${depth * 18 + 4}px">
      ${hasChildren
        ? `<button class="tcaret" type="button" data-toggle="${node.code}" aria-expanded="${expanded}" aria-label="${expanded ? '收起' : '展开'} ${esc(node.name)}">${navChevron(expanded)}</button>`
        : '<span class="tcaret is-leaf" aria-hidden="true"></span>'}
      <label class="tlabel">
        <input type="checkbox" data-check="${node.code}" ${isChecked ? 'checked' : ''} ${node.__half ? 'data-half="1"' : ''} />
        <span class="tname">${esc(node.name)}</span>
        <span class="ttype ${node.type}">${typeTag}</span>
        <span class="tcode mono">${esc(node.code)}</span>
        ${node.path ? `<span class="tpath mono">${esc(node.path)}</span>` : ''}
      </label>
    </div>
    ${hasChildren && expanded ? node.children.map((child) => renderTreeNode(child, state, depth + 1)).join('') : ''}
  </div>`
}

async function pageRoles() {
  const [roleData, adminData] = await Promise.all([
    api('/admin/api/roles'),
    api('/admin/api/admins'),
  ])
  const roles = roleData.roles ?? []
  const admins = adminData.list ?? []
  const canWrite = new Set(state.me?.permissions ?? []).has('admin.write')
  const userCount = (code) => admins.filter((admin) => (admin.roles ?? []).some((role) => role.code === code)).length
  const rolePage = clientPage('roles', roles, 20)
  const rows = rolePage.items.map((role) => `<tr>
    <td data-label="角色"><strong>${esc(role.name)}</strong><div class="muted small">${esc(role.description || '—')}</div></td>
    <td data-label="编码" class="mono">${esc(role.code)}</td>
    <td data-label="成员">${fmt(userCount(role.code))} 人</td>
    <td data-label="权限">${fmt((role.permissions ?? []).length)} 个</td>
    <td data-label="类型"><span class="pill ${role.is_system ? '' : 'ok'}">${role.is_system ? '内置角色' : '自定义角色'}</span></td>
    <td class="row-actions settings-row-actions">${canWrite ? `
      <button class="btn sm" type="button" data-role-permissions="${role.id}">分配权限</button>
      <button class="btn sm" type="button" data-role-edit="${role.id}">编辑</button>
      <button class="btn sm danger" type="button" data-role-delete="${role.id}" ${role.is_system ? 'disabled' : ''}>删除</button>` : '<span class="muted">只读</span>'}</td>
  </tr>`).join('')

  view.innerHTML = panel('角色管理', `
    <div class="rbac-summary">
      <span><b>${fmt(roles.length)}</b> 个角色</span>
      <span><b>${fmt(admins.length)}</b> 个后台用户</span>
      <span><b>${fmt(roleData.permissions?.length ?? 0)}</b> 个权限点</span>
      <span class="muted">角色只负责分组；权限通过「分配权限」单独配置。</span>
    </div>
    <p class="muted">内置角色不可删除；自定义角色仍分配给账号时也不能删除。成员分配在「用户管理」完成。</p>
    <div class="settings-table-wrap"><table class="settings-table role-table">
      <thead><tr><th>角色</th><th>编码</th><th>成员</th><th>权限</th><th>类型</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">还没有角色</td></tr>'}</tbody>
    </table></div>
    ${pager('roles', rolePage.page, rolePage.pageSize, rolePage.total, '个')}`,
  canWrite ? '<button class="btn primary" type="button" id="role-new">新增角色</button>' : '')

  const byId = (id) => roles.find((role) => role.id === Number(id))
  const openRoleForm = (role) => {
    const editing = Boolean(role)
    openOverlay(editing ? `编辑角色 · ${role.name}` : '新增角色', `
      <div class="settings-ui">
        <p class="settings-modal-copy">角色编码用于接口识别，保存后不可修改；权限在列表页的「分配权限」中单独设置。</p>
        <div class="settings-form-grid modal-settings-grid">
          <label class="setting-field">
            <span>角色名称</span>
            <input class="input" id="role-name" maxlength="50" value="${esc(role?.name ?? '')}" />
          </label>
          <label class="setting-field">
            <span>角色编码</span>
            <input class="input" id="role-code" maxlength="32" placeholder="例如 content_ops_2" value="${esc(role?.code ?? '')}" ${editing ? 'disabled' : ''} />
            <small>${editing ? '角色编码不可修改。' : '2–32 位小写字母、数字或下划线，以字母开头。'}</small>
          </label>
          <label class="setting-field settings-span-2">
            <span>角色说明</span>
            <textarea class="input" id="role-desc" rows="3" maxlength="200" placeholder="说明该角色的职责边界">${esc(role?.description ?? '')}</textarea>
          </label>
        </div>
        <div class="modal-foot"><button class="btn" type="button" data-cancel>取消</button><button class="btn primary" type="button" id="role-save">${editing ? '保存角色' : '创建角色'}</button></div>
      </div>`, (body, close) => {
      body.querySelector('[data-cancel]').addEventListener('click', close)
      body.querySelector('#role-save').addEventListener('click', async () => {
        const button = body.querySelector('#role-save')
        const name = body.querySelector('#role-name').value.trim()
        const code = body.querySelector('#role-code').value.trim()
        if (!name) return toast('请填写角色名称')
        if (!editing && !code) return toast('请填写角色编码')
        if (!editing && !/^[a-z][a-z0-9_]{1,31}$/.test(code)) return toast('角色编码需为 2–32 位小写字母、数字或下划线，并以字母开头')
        button.disabled = true
        button.textContent = '保存中…'
        try {
          if (editing) await api(`/admin/api/roles/${role.id}`, {
            method: 'PUT', body: { name, description: body.querySelector('#role-desc').value.trim() },
          })
          else await api('/admin/api/roles', {
            method: 'POST', body: { code, name, description: body.querySelector('#role-desc').value.trim() },
          })
          close()
          toast(editing ? '角色已保存' : '角色已创建')
          await pageRoles()
        } catch (error) {
          toast(error.message)
          button.disabled = false
          button.textContent = editing ? '保存角色' : '创建角色'
        }
      })
    })
  }

  const openPermissions = async (role) => {
    openOverlay(`分配权限 · ${role.name}`, `
      <div class="settings-ui permission-modal-body">
        <div class="rbac-loading">正在加载权限…</div>
      </div>`, async (body, close) => {
      try {
        const binding = await api(`/admin/api/roles/${role.id}/menus`)
        const state = {
          tree: binding.tree ?? [],
          checked: new Set(binding.checked ?? []),
          keyword: '',
          expanded: new Set(),
        }
        for (const node of flattenTree(state.tree)) {
          if (node.type !== 'button') state.expanded.add(node.code)
        }
        const total = roleData.permissions?.length ?? flattenTree(state.tree).length
        body.innerHTML = `
          <div class="permission-modal-summary">
            <span><b id="perm-selected-count">${state.checked.size}</b> 已选权限</span>
            <span><b>${fmt(total)}</b> 权限节点</span>
            <span><b>${fmt(userCount(role.code))}</b> 个账号使用该角色</span>
          </div>
          <p class="settings-modal-copy">勾选后立即写入该角色的菜单与接口权限；子节点会自动补齐父级目录。</p>
          <div class="tree-toolbar rbac-toolbar">
            <input id="perm-search" aria-label="搜索权限、菜单或路由" placeholder="搜索权限 / 菜单 / 路由" value="" />
            <button class="btn sm" id="perm-expand" type="button">展开全部</button>
            <button class="btn sm" id="perm-collapse" type="button">收起全部</button>
            <button class="btn sm" id="perm-check-all" type="button">全选</button>
            <button class="btn sm" id="perm-uncheck-all" type="button">清空</button>
          </div>
          <div class="tree rbac-tree" id="perm-tree"></div>
          <div class="modal-foot"><button class="btn" type="button" data-cancel>取消</button><button class="btn primary" type="button" id="perm-save">保存权限</button></div>`
        body.querySelector('[data-cancel]').addEventListener('click', close)
        const treeEl = body.querySelector('#perm-tree')
        const paintTree = (focusCode = '') => {
          computeHalf(state.tree, state)
          treeEl.innerHTML = state.tree.map((node) => renderTreeNode(node, state)).join('')
          treeEl.querySelectorAll('[data-half="1"]').forEach((input) => {
            input.indeterminate = true
            input.setAttribute('aria-checked', 'mixed')
          })
          body.querySelector('#perm-selected-count').textContent = state.checked.size
          if (focusCode) treeEl.querySelector(`[data-check="${CSS.escape(focusCode)}"]`)?.focus()
        }
        paintTree()
        body.querySelector('#perm-search').addEventListener('input', (event) => { state.keyword = event.target.value; paintTree() })
        body.querySelector('#perm-expand').addEventListener('click', () => { for (const node of flattenTree(state.tree)) state.expanded.add(node.code); paintTree() })
        body.querySelector('#perm-collapse').addEventListener('click', () => { state.expanded.clear(); paintTree() })
        body.querySelector('#perm-check-all').addEventListener('click', () => { for (const node of flattenTree(state.tree)) state.checked.add(node.code); paintTree() })
        body.querySelector('#perm-uncheck-all').addEventListener('click', () => { state.checked.clear(); paintTree() })
        body.querySelector('#perm-save').addEventListener('click', async (event) => {
          const button = event.currentTarget
          button.disabled = true
          button.textContent = '保存中…'
          try {
            const result = await api(`/admin/api/roles/${role.id}/menus`, { method: 'PUT', body: { codes: [...state.checked] } })
            close()
            toast(`已保存 ${result.checked.length} 个权限节点`)
            await pageRoles()
          } catch (error) {
            toast(error.message)
            button.disabled = false
            button.textContent = '保存权限'
          }
        })
        treeEl.addEventListener('change', (event) => {
          const input = event.target.closest('[data-check]')
          if (!input) return
          const node = findNode(state.tree, input.dataset.check)
          if (node) setSubtree(node, input.checked, state)
          paintTree(input.dataset.check)
        })
        treeEl.addEventListener('click', (event) => {
          const caret = event.target.closest('[data-toggle]')
          if (!caret) return
          const code = caret.dataset.toggle
          if (state.expanded.has(code)) state.expanded.delete(code)
          else state.expanded.add(code)
          paintTree(code)
        })
      } catch (error) {
        body.innerHTML = `<div class="rbac-loading">权限加载失败：${esc(error.message)}</div>`
      }
    }, { className: 'permission-modal' })
  }

  $('#role-new')?.addEventListener('click', () => openRoleForm(null))
  view.querySelectorAll('[data-role-permissions]').forEach((button) => button.addEventListener('click', () => {
    const role = byId(button.dataset.rolePermissions)
    if (role) void openPermissions(role)
  }))
  view.querySelectorAll('[data-role-edit]').forEach((button) => button.addEventListener('click', () => openRoleForm(byId(button.dataset.roleEdit))))
  view.querySelectorAll('[data-role-delete]').forEach((button) => button.addEventListener('click', async () => {
    const role = byId(button.dataset.roleDelete)
    if (!role || !(await askConfirm({
      title: '删除角色',
      message: `删除角色「${role.name}」？仅未分配给任何后台账号的自定义角色可以删除。`,
      confirmText: '删除',
      danger: true,
    }))) return
    try {
      await api(`/admin/api/roles/${role.id}`, { method: 'DELETE' })
      toast('角色已删除')
      await pageRoles()
    } catch (error) { toast(error.message) }
  }))
  bindPager('roles', pageRoles)
}

/* ---------------- 审计日志 ---------------- */
async function pageAudit() {
  const data = await api(`/admin/api/audit?page=${listPages.audit}&pageSize=20`)
  listPages.audit = Number(data.page ?? 1)
  const rows = data.list.map((log) => `<tr>
    <td>${log.id}</td><td class="muted">${esc(fmtTs(log.created_at))}</td>
    <td>${esc(log.actor_name ?? log.actor_type)}</td><td class="mono">${esc(log.action)}</td>
    <td class="muted">${esc(log.target_type ?? '')}${log.target_id ? ' #' + esc(log.target_id) : ''}</td>
    <td class="muted">${esc(log.reason ?? '')}</td>
    <td>${log.result === 'denied' ? '<span class="pill bad">拒绝</span>' : '<span class="pill ok">成功</span>'}</td>
    <td class="mono muted">${esc(log.ip ?? '')}</td>
  </tr>`)
  view.innerHTML = panel('审计日志', `
    <p class="muted">共 ${fmt(data.total ?? data.list.length)} 条</p>
    ${table(['ID', '时间', '操作人', '动作', '对象', '原因', '结果', 'IP'], rows)}
    ${pager('audit', listPages.audit, data.pageSize, data.total, '条')}`)
  bindPager('audit', pageAudit)
}

/* ---------------- 支付渠道（多渠道 + 加密配置） ---------------- */
const CHANNEL_PRESETS = {
  alipay: {
    label: '支付宝', currency: 'CNY',
    fields: [
      ['appId', 'AppID'],
      ['privateKey', '商户私钥（PEM，加密存储）', 'textarea', true],
      ['publicKey', '支付宝公钥（PEM，加密存储）', 'textarea', true],
      ['gateway', '网关地址'],
      ['notifyUrl', '异步通知地址'],
    ],
  },
  wechat: {
    label: '微信支付', currency: 'CNY',
    fields: [
      ['appId', 'AppID'],
      ['mchId', '商户号'],
      ['apiV3Key', 'APIv3 密钥（加密存储）', 'text', true],
      ['serialNo', '商户证书序列号'],
    ],
  },
  usdt: {
    label: 'USDT', currency: 'USDT',
    fields: [
      ['walletAddress', '收款地址（TRC20）'],
      ['network', '网络'],
      ['minConfirmations', '最小确认数'],
      ['rate', '汇率（1 USDT = ? CNY）'],
    ],
  },
  mock: { label: '模拟支付', currency: 'CNY', fields: [] },
}

function channelConfigForm(code, preview = {}) {
  const preset = CHANNEL_PRESETS[code] ?? { label: code, fields: [] }
  return preset.fields.map(([key, label, type = 'text', secret = false]) => {
    const current = preview?.[key] ?? ''
    const hint = secret ? '留空表示不修改（当前：' + (current || '未设置') + '）' : ''
    return `<label class="setting-field"><span>${esc(label)}</span>
      ${type === 'textarea'
        ? `<textarea class="input" data-cfg="${key}" rows="2" placeholder="${esc(hint || '请输入')}"></textarea>`
        : `<input class="input" data-cfg="${key}" value="" placeholder="${esc(hint || '请输入')}" />`}
      ${hint ? `<small>${esc(hint)}</small>` : ''}
    </label>`
  }).join('')
}

async function pagePay() {
  const data = await api('/admin/api/pay-channels')
  const allChannels = data.list ?? []
  const payPage = clientPage('pay', allChannels.map((channel) => `<tr>
    <td>${channel.id}</td>
    <td><span class="pill">${esc(channel.channel_code)}</span></td>
    <td>${esc(channel.name)}</td>
    <td>${esc(channel.scene)}</td>
    <td>${channel.env === 'prod' ? '<span class="pill bad">生产</span>' : '<span class="pill">沙箱</span>'}</td>
    <td>${channel.status === 'enabled' ? '<span class="pill ok">启用</span>' : '<span class="pill">停用</span>'}</td>
    <td>${channel.is_default ? '<span class="pill ok">默认</span>' : '—'}</td>
    <td>${channel.priority}</td>
    <td>${esc(channel.currency)}</td>
    <td class="mono">v${channel.key_version}</td>
    <td class="row-actions">
      <button class="btn sm" data-edit="${channel.id}">编辑</button>
      <button class="btn sm" data-test="${channel.id}">测试</button>
      <button class="btn sm" data-status="${channel.id}" data-current="${channel.status}">${channel.status === 'enabled' ? '停用' : '启用'}</button>
      <button class="btn sm" data-default="${channel.id}" ${channel.status !== 'enabled' || channel.is_default ? 'disabled' : ''}>设为默认</button>
      <button class="btn sm danger" data-del="${channel.id}" ${channel.is_default ? 'disabled' : ''}>删除</button>
    </td>
  </tr>`), 20)

  view.innerHTML = panel('支付渠道', `
    ${table(['ID', '编码', '名称', '场景', '环境', '状态', '默认', '优先级', '币种', '密钥版本', '操作'], payPage.items)}
    ${pager('pay', payPage.page, payPage.pageSize, payPage.total, '个')}`,
  '<button class="btn primary" id="add-channel">新增渠道</button>')

  const openForm = (channel) => {
    const code = channel?.channel_code ?? 'alipay'
    openOverlay(channel ? `编辑支付渠道 #${channel.id}` : '新增支付渠道', `
      <div class="settings-ui">
        <p class="settings-modal-copy">支付渠道决定收银台的路由顺序；生产渠道上线前必须完成小额支付和回调验证。</p>
        <div class="settings-form-grid modal-settings-grid">
          <label class="setting-field">
            <span>渠道类型</span>
            <select class="input" id="f-code" ${channel ? 'disabled' : ''}>
            ${Object.entries(CHANNEL_PRESETS).map(([key, preset]) => `<option value="${key}" ${key === code ? 'selected' : ''}>${esc(preset.label)}（${key}）</option>`).join('')}
            </select>
            <small>${channel ? '渠道类型创建后不可修改。' : '选择后将自动带出币种和参数模板。'}</small>
          </label>
          <label class="setting-field">
            <span>显示名称</span>
            <input class="input" id="f-name" value="${esc(channel?.name ?? '支付宝')}" />
          </label>
          <label class="setting-field">
            <span>适用场景</span>
            <select class="input" id="f-scene">
            ${[['all', '全部'], ['subscription', '会员订阅'], ['single', '单片购买']].map(([scene, label]) => `<option value="${scene}" ${channel?.scene === scene ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label class="setting-field">
            <span>运行环境</span>
            <select class="input" id="f-env">
            ${[['sandbox', '沙箱'], ['prod', '生产']].map(([env, label]) => `<option value="${env}" ${channel?.env === env ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label class="setting-field">
            <span>优先级</span>
            <input class="input" id="f-priority" type="number" value="${channel?.priority ?? 100}" />
            <small>数字越小越优先。</small>
          </label>
          <label class="setting-field">
            <span>币种</span>
            <input class="input" id="f-currency" value="${esc(channel?.currency ?? 'CNY')}" />
          </label>
          <label class="setting-field">
            <span>最小支付金额（元）</span>
            <input class="input" id="f-min" type="number" step="0.01" value="${channel?.min_amount ?? 0}" />
          </label>
          <label class="setting-field">
            <span>最大支付金额（元）</span>
            <input class="input" id="f-max" type="number" step="0.01" value="${channel?.max_amount ?? 0}" />
            <small>0 表示不限制。</small>
          </label>
        </div>
        <section class="settings-subsection">
          <div class="settings-subsection-head">
            <div>
              <h4>渠道密钥与参数</h4>
              <p>敏感字段加密存储；留空表示保持原值。</p>
            </div>
          </div>
          <div class="cfg-grid" id="cfg-fields">${channelConfigForm(code, channel?.config_preview)}</div>
        </section>
        <div class="modal-foot"><button class="btn" data-cancel>取消</button><button class="btn primary" id="save-channel">保存</button></div>
      </div>
      `, (body, close) => {
      body.querySelector('#f-code').addEventListener('change', (event) => {
        const preset = CHANNEL_PRESETS[event.target.value]
        body.querySelector('#cfg-fields').innerHTML = channelConfigForm(event.target.value)
        if (!channel) {
          body.querySelector('#f-name').value = preset?.label ?? event.target.value
          body.querySelector('#f-currency').value = preset?.currency ?? 'CNY'
        }
      })
      body.querySelector('[data-cancel]').addEventListener('click', close)
      body.querySelector('#save-channel').addEventListener('click', async (event) => {
        const config = {}
        body.querySelectorAll('[data-cfg]').forEach((input) => {
          if (input.value !== '') config[input.dataset.cfg] = input.value
        })
        const payload = {
          channelCode: channel?.channel_code ?? body.querySelector('#f-code').value,
          name: body.querySelector('#f-name').value, scene: body.querySelector('#f-scene').value, env: body.querySelector('#f-env').value,
          priority: Number(body.querySelector('#f-priority').value), currency: body.querySelector('#f-currency').value,
          minAmount: Number(body.querySelector('#f-min').value), maxAmount: Number(body.querySelector('#f-max').value),
          config,
        }
        const button = event.currentTarget
        button.disabled = true
        button.textContent = '保存中…'
        try {
          await api(channel ? `/admin/api/pay-channels/${channel.id}` : '/admin/api/pay-channels',
            { method: channel ? 'PUT' : 'POST', body: payload })
          close()
          toast('渠道已保存')
          await pagePay()
        } catch (error) {
          toast(error.message)
          button.disabled = false
          button.textContent = '保存'
        }
      })
    })
  }

  $('#add-channel').addEventListener('click', () => openForm(null))
  view.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => openForm(allChannels.find((item) => item.id === Number(button.dataset.edit))))
  })
  view.querySelectorAll('[data-test]').forEach((button) => {
    button.addEventListener('click', async () => {
      const result = await api(`/admin/api/pay-channels/${button.dataset.test}/test`, { method: 'POST', body: {} })
      toast(result.ok ? '配置完整，可用' : `缺少字段：${result.missing.join(', ')}`)
    })
  })
  view.querySelectorAll('[data-status]').forEach((button) => {
    button.addEventListener('click', async () => {
      const next = button.dataset.current === 'enabled' ? 'disabled' : 'enabled'
      const reason = await askText({ title: next === 'enabled' ? '启用支付渠道' : '停用支付渠道', label: '变更原因', hint: '原因会写入审计日志。', minLength: 2, confirmText: '提交' })
      if (reason === null) return
      await api(`/admin/api/pay-channels/${button.dataset.status}/status`, { method: 'POST', body: { status: next, reason } })
      await pagePay()
    })
  })
  view.querySelectorAll('[data-default]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = await askText({ title: '切换默认支付渠道', label: '变更原因', hint: '原因会写入审计日志。', minLength: 2, confirmText: '切换' })
      if (reason === null) return
      await api(`/admin/api/pay-channels/${button.dataset.default}/default`, { method: 'POST', body: { reason } })
      toast('默认渠道已切换')
      await pagePay()
    })
  })
  view.querySelectorAll('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = await askText({ title: '删除支付渠道', label: '删除原因', hint: '原因会写入审计日志。', minLength: 2, confirmText: '删除', danger: true })
      if (reason === null) return
      await api(`/admin/api/pay-channels/${button.dataset.del}`, { method: 'DELETE', body: { reason } })
      await pagePay()
    })
  })
  bindPager('pay', pagePay)
}

/* ---------------- 邮件通道（厂家无关，可多条按优先级回退） ---------------- */
async function pageEmail() {
  const data = await api('/admin/api/email-channels')
  const channels = data.channels ?? []
  const presets = data.presets ?? []
  const template = data.template ?? {}
  let editing = null

  const typeLabel = { smtp: 'SMTP', oauth2: 'OAuth2', http: 'HTTP API', dev: '开发' }
  const statusOf = (channel) => {
    if (channel.enabled === false) return '<span class="pill">已停用</span>'
    if (!channel.lastTest) return '<span class="pill">未测试</span>'
    return channel.lastTest.ok ? '<span class="pill ok">可用</span>' : '<span class="pill bad">失败</span>'
  }

  const sortedChannels = channels
    .slice()
    .sort((a, b) => a.priority - b.priority)
  const emailPage = clientPage('emailChannels', sortedChannels, 20)
  const rows = emailPage.items
    .map((channel) => `<tr>
      <td>${channel.priority}</td>
      <td>${esc(channel.name)}</td>
      <td><span class="pill">${typeLabel[channel.type] ?? channel.type}</span></td>
      <td class="mono">${esc(channel.from || (channel.smtp?.host ?? channel.http?.url ?? ''))}</td>
      <td>${statusOf(channel)}</td>
      <td class="muted" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(channel.lastTest?.message ?? '')}</td>
      <td style="white-space:nowrap">
        <button class="btn sm" data-edit="${channel.id}">编辑</button>
        <button class="btn sm" data-test="${channel.id}">测试</button>
        <button class="btn sm" data-top="${channel.id}">置顶</button>
        <button class="btn sm ${channel.enabled === false ? '' : 'danger'}" data-toggle="${channel.id}">${channel.enabled === false ? '启用' : '停用'}</button>
        <button class="btn sm danger" data-del="${channel.id}">删除</button>
      </td>
    </tr>`)
    .join('')

  view.innerHTML = panel('邮件通道', `
    <div class="cards">
      <div class="card"><div class="k">当前状态</div><div class="v">${data.mailMissing ? '<span class="pill warn">未配置可用通道（验证码无法发送）</span>' : '<span class="pill ok">真实发信</span>'}</div></div>
      <div class="card"><div class="k">通道数</div><div class="v">${channels.length}</div></div>
      <div class="card"><div class="k">默认发件人</div><div class="v" style="font-size:14px">${esc(data.from || '未设置')}</div></div>
    </div>

    <div class="form-row" style="margin-top:14px">
      <label>默认发件邮箱 <input id="em-from" value="${esc(data.from ?? '')}" placeholder="no-reply@yourdomain.com" style="width:260px" /></label>
      <label>发件人名称 <input id="em-fromname" value="${esc(data.fromName ?? '影巢')}" style="width:120px" /></label>
      <button class="btn" id="em-save-global">保存默认</button>
      <span class="spacer" style="flex:1"></span>
      <select id="em-preset" aria-label="邮件通道预设">${presets.map((preset) => `<option value="${preset.id}">${esc(preset.name)}</option>`).join('')}</select>
      <button class="btn primary" id="em-add">新增通道</button>
    </div>
    <p class="muted" id="em-preset-note"></p>

    <table style="margin-top:12px">
      <thead><tr><th>优先级</th><th>名称</th><th>类型</th><th>发件人 / 端点</th><th>状态</th><th>最近测试</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">还没有通道。选一个厂家预设，点「新增通道」开始。</td></tr>'}</tbody>
    </table>
    ${pager('emailChannels', emailPage.page, emailPage.pageSize, emailPage.total, '个')}
    <div class="email-template-editor">
      <h3>验证码邮件模板</h3>
      <div class="grid-2">
        <label>邮件主题<input id="et-subject" value="${esc(template.subject ?? '')}" /></label>
        <label>品牌名<input id="et-brand" value="${esc(template.brand ?? '影巢')}" /></label>
        <label>标题<input id="et-title" value="${esc(template.title ?? '')}" /></label>
        <label>强调色<input id="et-accent" type="color" value="${esc(template.accent ?? '#ff3d6e')}" /></label>
        <label>引导语<textarea id="et-intro" rows="3">${esc(template.intro ?? '')}</textarea></label>
        <label>页脚说明<textarea id="et-footer" rows="3">${esc(template.footer ?? '')}</textarea></label>
      </div>
      <div class="row-actions" style="margin:10px 0">
        <button class="btn" type="button" id="et-preview">刷新预览</button>
        <button class="btn primary" type="button" id="et-save">保存模板</button>
      </div>
      <iframe class="email-preview-frame" id="et-preview-frame" sandbox title="验证码邮件预览"></iframe>
    </div>`)

  const notePreset = () => {
    const preset = presets.find((item) => item.id === $('#em-preset').value)
    $('#em-preset-note').textContent = preset?.note ?? ''
  }
  notePreset()
  $('#em-preset').addEventListener('change', notePreset)

  const templateFromForm = () => ({
    subject: $('#et-subject').value.trim(),
    brand: $('#et-brand').value.trim(),
    title: $('#et-title').value.trim(),
    intro: $('#et-intro').value.trim(),
    footer: $('#et-footer').value.trim(),
    accent: $('#et-accent').value,
  })
  const previewTemplate = async () => {
    const result = await api('/admin/api/email-template/preview', { method: 'POST', body: { template: templateFromForm() } })
    const frame = $('#et-preview-frame')
    if (frame) frame.srcdoc = result.html
  }
  $('#et-preview').addEventListener('click', async () => {
    try { await previewTemplate() } catch (error) { toast(error.message) }
  })
  $('#et-save').addEventListener('click', async () => {
    try {
      await api('/admin/api/email-settings', {
        method: 'PUT',
        body: { from: $('#em-from').value.trim(), fromName: $('#em-fromname').value.trim(), template: templateFromForm() },
      })
      toast('邮件模板已保存')
      await pageEmail()
    } catch (error) { toast(error.message) }
  })
  void previewTemplate().catch(() => {})

  $('#em-save-global').addEventListener('click', async () => {
    try {
      await api('/admin/api/email-settings', { method: 'PUT', body: { from: $('#em-from').value.trim(), fromName: $('#em-fromname').value.trim() } })
      toast('默认发件人已保存')
      await pageEmail()
    } catch (error) { toast(error.message) }
  })

  $('#em-add').addEventListener('click', () => {
    const presetId = $('#em-preset').value
    const preset = presets.find((item) => item.id === presetId)
    editing = {
      id: '',
      name: preset?.name ?? '新通道',
      type: preset?.type ?? 'smtp',
      enabled: true,
      priority: (channels.at(-1)?.priority ?? 0) + 10,
      from: data.from ?? '',
      fromName: data.fromName ?? '影巢',
      smtp: { host: preset?.host ?? '', port: preset?.port ?? 465, secure: preset?.secure ?? true, user: '', authMode: preset?.authMode ?? 'login' },
      oauth2: { tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token', deviceUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode', clientId: '', scope: 'https://outlook.office.com/SMTP.Send offline_access', account: '' },
      http: { url: preset?.url ?? '', method: preset?.method ?? 'POST', headers: preset?.headers ?? { 'content-type': 'application/json' }, body: preset?.body ?? '' },
      presetId,
    }
    renderForm()
  })

  const renderForm = () => {
    const channel = editing
    if (!channel) return
    const isHttp = channel.type === 'http'
    const isOauth = channel.type === 'oauth2'
    openOverlay(`${channel.id ? '编辑邮件通道' : '新增邮件通道'} · ${channel.name}`, `
      <div class="settings-ui" id="em-form">
        <p class="settings-modal-copy">邮件通道按优先级回退；验证码等关键邮件需要保持至少一条可用通道。</p>
        <div class="settings-form-grid modal-settings-grid">
          <label class="setting-field">
            <span>通道名称</span>
            <input class="input" id="ch-name" value="${esc(channel.name)}" />
          </label>
          <label class="setting-field">
            <span>通道类型</span>
            <select class="input" id="ch-type">
              ${[['smtp', 'SMTP（账号密码）'], ['oauth2', 'OAuth2（XOAUTH2）'], ['http', 'HTTP API']]
                .map(([value, label]) => `<option value="${value}" ${channel.type === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label class="setting-field">
            <span>优先级</span>
            <input class="input" id="ch-priority" type="number" value="${channel.priority}" />
            <small>数字越小越先尝试。</small>
          </label>
          <label class="setting-field">
            <span>发件邮箱</span>
            <input class="input" id="ch-from" value="${esc(channel.from ?? '')}" placeholder="no-reply@example.com" />
          </label>
          <label class="setting-field settings-span-2">
            <span>发件人名称</span>
            <input class="input" id="ch-fromname" value="${esc(channel.fromName ?? '影巢')}" />
          </label>
        </div>

        ${isHttp ? `
        <section class="settings-subsection">
          <div class="settings-subsection-head">
            <div>
              <h4>HTTP 投递</h4>
              <p>通过第三方邮件 API 发送，请求体和请求头使用固定模板。</p>
            </div>
          </div>
          <div class="settings-form-grid modal-settings-grid">
            <label class="setting-field">
              <span>请求方法</span>
              <select class="input" id="ch-method">${['POST', 'PUT', 'GET'].map((m) => `<option ${channel.http.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
            </label>
            <label class="setting-field">
              <span>API URL</span>
              <input class="input" id="ch-url" value="${esc(channel.http.url ?? '')}" placeholder="https://api.example.com/send" />
            </label>
            <label class="setting-field settings-span-2">
              <span>Headers（JSON）</span>
              <textarea class="input" id="ch-headers" rows="3">${esc(JSON.stringify(channel.http.headers ?? {}, null, 2))}</textarea>
            </label>
            <label class="setting-field settings-span-2">
              <span>Body 模板</span>
              <textarea class="input" id="ch-body" rows="5">${esc(channel.http.body ?? '')}</textarea>
            </label>
            <label class="setting-field settings-span-2">
              <span>API Key</span>
              <input class="input" id="ch-apikey" type="password" placeholder="${channel.http.apiKeySet ? '已保存，留空不修改' : '写入模板 {{apiKey}} 使用'}" />
            </label>
          </div>
          <p class="settings-inline-note">可用占位符：{{apiKey}} {{from}} {{fromName}} {{to}} {{subject}} {{text}} {{html}} {{timestamp}}</p>
        </section>
        ` : ''}

        ${isOauth ? `
        <section class="settings-subsection">
          <div class="settings-subsection-head">
            <div>
              <h4>OAuth2 授权</h4>
              <p>适用于 Microsoft 365 / Outlook 的设备码授权。</p>
            </div>
          </div>
          <div class="settings-callout">
            没有 clientId？打开
            <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Azure 应用注册</a>，
            新建应用后允许公共客户端流，并添加「Office 365 Exchange Online → SMTP.Send」委派权限。
          </div>
          <div class="settings-form-grid modal-settings-grid">
            <label class="setting-field settings-span-2">
              <span>Token URL</span>
              <input class="input" id="ch-token-url" value="${esc(channel.oauth2.tokenUrl ?? '')}" />
            </label>
            <label class="setting-field settings-span-2">
              <span>Device URL</span>
              <input class="input" id="ch-device-url" value="${esc(channel.oauth2.deviceUrl ?? '')}" />
            </label>
            <label class="setting-field">
              <span>Client ID</span>
              <input class="input" id="ch-client" value="${esc(channel.oauth2.clientId ?? '')}" />
            </label>
            <label class="setting-field">
              <span>Client Secret</span>
              <input class="input" id="ch-secret" type="password" placeholder="${channel.oauth2.clientSecretSet ? '已保存，留空不修改' : '公共客户端可留空'}" />
            </label>
            <label class="setting-field settings-span-2">
              <span>Scope</span>
              <input class="input" id="ch-scope" value="${esc(channel.oauth2.scope ?? '')}" />
            </label>
          </div>
          <div class="settings-inline-actions">
            <button class="btn" id="ch-oauth-start" type="button">生成授权码</button>
            <button class="btn primary" id="ch-oauth-check" type="button" disabled>检查授权</button>
            <span class="muted" id="ch-oauth-state">${channel.oauth2.refreshTokenSet ? '已授权' + (channel.oauth2.account ? '：' + esc(channel.oauth2.account) : '') : '未授权'}</span>
          </div>
          <div id="ch-oauth-code" class="settings-code-box" style="display:none">
            <div class="muted">浏览器打开下面链接并输入这串码：</div>
            <div class="settings-user-code" id="ch-usercode">—</div>
            <div class="muted" id="ch-uri"></div>
          </div>
        </section>
        ` : ''}

        ${channel.type === 'smtp' || isOauth ? `
        <section class="settings-subsection">
          <div class="settings-subsection-head">
            <div><h4>SMTP 连接</h4><p>465 端口通常启用 SSL；587 端口通常使用 STARTTLS。</p></div>
          </div>
          <div class="settings-form-grid modal-settings-grid">
            <label class="setting-field">
              <span>SMTP 主机</span>
              <input class="input" id="ch-host" value="${esc(channel.smtp.host ?? '')}" placeholder="smtp.example.com" />
            </label>
            <label class="setting-field">
              <span>端口</span>
              <input class="input" id="ch-port" type="number" value="${channel.smtp.port ?? 465}" />
            </label>
            <label class="settings-check">
              <input id="ch-secure" type="checkbox" ${channel.smtp.secure ? 'checked' : ''} />
              <span>启用 SSL / SMTPS</span>
              <small>465 端口勾选；587 端口不勾选。</small>
            </label>
            ${isOauth ? '' : `<label class="setting-field">
              <span>认证方式</span>
              <select class="input" id="ch-auth">
              ${[['login', 'AUTH LOGIN'], ['plain', 'AUTH PLAIN'], ['auto', '自动（按服务器能力）'], ['none', '不认证']]
                .map(([value, label]) => `<option value="${value}" ${channel.smtp.authMode === value ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
            </label>`}
            ${isOauth ? '' : `<label class="setting-field">
              <span>SMTP 账号</span>
              <input class="input" id="ch-user" value="${esc(channel.smtp.user ?? '')}" placeholder="完整邮箱地址" />
            </label>
            <label class="setting-field">
              <span>密码 / 授权码</span>
              <input class="input" id="ch-pass" type="password" placeholder="${channel.smtp.passSet ? '已保存，留空不修改' : 'SMTP 密码或应用专用密码'}" />
            </label>`}
          </div>
        </section>
        ` : ''}

        <section class="settings-subsection">
          <div class="settings-subsection-head">
            <div><h4>连接测试</h4><p>保存前可先向前台收件箱发送一封测试邮件。</p></div>
          </div>
          <div class="settings-inline-actions">
            <input class="input" id="ch-test-to" aria-label="测试收件邮箱" placeholder="测试收件邮箱" />
            <button class="btn" id="ch-test" type="button">连接测试并发送</button>
          </div>
          <span class="muted" id="ch-msg"></span>
        </section>
        <div class="modal-foot">
          <button class="btn" id="ch-cancel" type="button">取消</button>
          <button class="btn primary" id="ch-save" type="button">保存通道</button>
        </div>
      </div>`)

    const closeForm = () => document.querySelector('#em-form')?.closest('.modal-mask')?.remove()

    let deviceCode = null
    let timer = null
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }

    $('#ch-cancel').addEventListener('click', () => { stop(); editing = null; closeForm() })

    $('#ch-type').addEventListener('change', () => {
      collect()
      editing.type = $('#ch-type').value
      closeForm()
      renderForm()
    })
    $('#ch-name')?.addEventListener('input', () => { editing.name = $('#ch-name').value })

    const collect = () => {
      if (!editing) return
      editing.name = $('#ch-name').value.trim() || editing.name
      editing.type = $('#ch-type').value
      editing.priority = Number($('#ch-priority').value || 100)
      editing.from = $('#ch-from').value.trim()
      editing.fromName = $('#ch-fromname').value.trim()
      if (editing.type === 'http') {
        editing.http.method = $('#ch-method').value
        editing.http.url = $('#ch-url').value.trim()
        try { editing.http.headers = JSON.parse($('#ch-headers').value || '{}') } catch { /* 保留原值 */ }
        editing.http.body = $('#ch-body').value
        const apiKey = $('#ch-apikey').value
        if (apiKey) editing.http.apiKeyInput = apiKey
      } else {
        editing.smtp.host = $('#ch-host').value.trim()
        editing.smtp.port = Number($('#ch-port').value || 465)
        editing.smtp.secure = $('#ch-secure').checked
        if ($('#ch-auth')) editing.smtp.authMode = $('#ch-auth').value
        if ($('#ch-user')) editing.smtp.user = $('#ch-user').value.trim()
        if ($('#ch-pass')?.value) editing.smtp.passInput = $('#ch-pass').value
        if (editing.type === 'oauth2') {
          editing.oauth2.tokenUrl = $('#ch-token-url').value.trim()
          editing.oauth2.deviceUrl = $('#ch-device-url').value.trim()
          editing.oauth2.clientId = $('#ch-client').value.trim()
          editing.oauth2.scope = $('#ch-scope').value.trim()
          if ($('#ch-secret').value) editing.oauth2.clientSecretInput = $('#ch-secret').value
          editing.smtp.user = $('#ch-from').value.trim()
        }
      }
    }

    $('#ch-save').addEventListener('click', async () => {
      collect()
      const payload = {
        id: editing.id || undefined,
        name: editing.name,
        type: editing.type,
        enabled: editing.enabled !== false,
        priority: editing.priority,
        from: editing.from,
        fromName: editing.fromName,
        presetId: editing.presetId,
      }
      if (editing.type === 'http') {
        payload.http = { url: editing.http.url, method: editing.http.method, headers: editing.http.headers, body: editing.http.body }
        if (editing.http.apiKeyInput) payload.apiKey = editing.http.apiKeyInput
      } else {
        payload.smtp = {
          host: editing.smtp.host, port: editing.smtp.port, secure: editing.smtp.secure,
          user: editing.smtp.user, authMode: editing.smtp.authMode,
          ...(editing.smtp.passInput ? { pass: editing.smtp.passInput } : {}),
        }
        if (editing.type === 'oauth2') {
          payload.oauth2 = {
            tokenUrl: editing.oauth2.tokenUrl, deviceUrl: editing.oauth2.deviceUrl,
            clientId: editing.oauth2.clientId, scope: editing.oauth2.scope,
            ...(editing.oauth2.clientSecretInput ? { clientSecret: editing.oauth2.clientSecretInput } : {}),
          }
        }
      }
      try {
        await api('/admin/api/email-channels', { method: 'POST', body: payload })
        toast('通道已保存')
        stop()
        closeForm()
        await pageEmail()
      } catch (error) { $('#ch-msg').textContent = error.message }
    })

    $('#ch-test')?.addEventListener('click', async () => {
      if (!editing.id) { $('#ch-msg').textContent = '请先保存通道再测试'; return }
      const to = $('#ch-test-to').value.trim() || editing.from
      $('#ch-msg').textContent = '正在测试…'
      try {
        const result = await api(`/admin/api/email-channels/${editing.id}/test`, { method: 'POST', body: { to } })
        $('#ch-msg').textContent = result.note ?? `成功：${result.transport ?? ''}，测试邮件已发往 ${result.to}`
        toast('测试通过')
      } catch (error) { $('#ch-msg').textContent = error.message }
    })

    $('#ch-oauth-start')?.addEventListener('click', async () => {
      collect()
      try {
        await api('/admin/api/email-channels', { method: 'POST', body: { id: editing.id || undefined, name: editing.name, type: 'oauth2', enabled: editing.enabled !== false, priority: editing.priority, from: editing.from, fromName: editing.fromName, smtp: { host: editing.smtp.host, port: editing.smtp.port, secure: editing.smtp.secure, user: editing.from }, oauth2: { tokenUrl: editing.oauth2.tokenUrl, deviceUrl: editing.oauth2.deviceUrl, clientId: editing.oauth2.clientId, scope: editing.oauth2.scope, ...(editing.oauth2.clientSecretInput ? { clientSecret: editing.oauth2.clientSecretInput } : {}) } } })
        const fresh = (await api('/admin/api/email-channels')).channels
        const mine = fresh.find((item) => item.type === 'oauth2' && item.oauth2.clientId === editing.oauth2.clientId)
        if (!mine) throw new Error('通道保存失败，请先点保存')
        editing.id = mine.id
        const started = await api(`/admin/api/email-channels/${mine.id}/oauth/start`, { method: 'POST', body: {} })
        deviceCode = started.deviceCode
        $('#ch-oauth-code').style.display = 'block'
        $('#ch-usercode').textContent = started.userCode
        $('#ch-uri').textContent = started.verificationUri
        $('#ch-oauth-state').textContent = `等待授权（${Math.round(started.expiresIn / 60)} 分钟内有效）`
        $('#ch-oauth-check').disabled = false
        timer = setInterval(async () => {
          try {
            const result = await api(`/admin/api/email-channels/${mine.id}/oauth/poll`, { method: 'POST', body: { deviceCode } })
            if (result.ok) { stop(); toast('授权成功'); closeForm(); await pageEmail() }
          } catch { stop() }
        }, Math.max(5, started.interval ?? 5) * 1000)
      } catch (error) { $('#ch-msg').textContent = error.message }
    })

    $('#ch-oauth-check')?.addEventListener('click', async () => {
      if (!editing.id || !deviceCode) { $('#ch-msg').textContent = '请先生成授权码'; return }
      try {
        const result = await api(`/admin/api/email-channels/${editing.id}/oauth/poll`, { method: 'POST', body: { deviceCode } })
        if (result.pending) { $('#ch-msg').textContent = '还没完成授权，请在浏览器输入验证码并同意'; return }
        stop()
        toast('授权成功')
        closeForm()
        await pageEmail()
      } catch (error) { $('#ch-msg').textContent = error.message }
    })
  }

  for (const button of view.querySelectorAll('[data-edit]')) {
    button.addEventListener('click', async () => {
      const channel = (await api('/admin/api/email-channels')).channels.find((item) => item.id === button.dataset.edit)
      editing = { ...channel, smtp: { ...channel.smtp }, oauth2: { ...channel.oauth2 }, http: { ...channel.http } }
      renderForm()
    })
  }
  for (const button of view.querySelectorAll('[data-test]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.test
      const to = await askText({ title: '发送测试邮件', label: '测试收件邮箱', value: data.from ?? '', confirmText: '发送' })
      if (to === null) return
      button.disabled = true
      try {
        const result = await api(`/admin/api/email-channels/${id}/test`, { method: 'POST', body: { to } })
        toast(result.note ?? `测试邮件已发送至 ${result.to ?? to}`)
      } catch (error) { toast(error.message) }
      button.disabled = false
      await pageEmail()
    })
  }
  for (const button of view.querySelectorAll('[data-toggle]')) {
    button.addEventListener('click', async () => {
      const channel = (await api('/admin/api/email-channels')).channels.find((item) => item.id === button.dataset.toggle)
      await api('/admin/api/email-channels', { method: 'POST', body: { id: channel.id, enabled: channel.enabled === false } })
      await pageEmail()
    })
  }
  for (const button of view.querySelectorAll('[data-del]')) {
    button.addEventListener('click', async () => {
      await api(`/admin/api/email-channels/${button.dataset.del}`, { method: 'DELETE' })
      toast('已删除')
      await pageEmail()
    })
  }
  for (const button of view.querySelectorAll('[data-top]')) {
    button.addEventListener('click', async () => {
      const channels2 = (await api('/admin/api/email-channels')).channels
      const min = Math.min(...channels2.map((item) => item.priority))
      await api('/admin/api/email-channels', { method: 'POST', body: { id: button.dataset.top, priority: min - 10 } })
      await pageEmail()
    })
  }
  bindPager('emailChannels', pageEmail)
}

/* ---------------- 经营数据（播放 / 用户 / 订单 / 订阅多维统计） ---------------- */
const EVENT_LABEL = {
  session_start: '访问开始', page_view: '页面浏览', impression: '内容曝光', detail_view: '详情页浏览',
  paywall_view: '付费墙展示', paywall_click: '付费墙点击', play_start: '开始播放', play_end: '播放结束',
  episode_click: '选集点击', favorite: '收藏', search: '搜索', share: '分享',
  category_filter: '分类筛选', rank_view: '榜单浏览', login_open: '打开登录', login_success: '登录成功',
  play_error: '播放失败', order_created: '创建订单', payment_success: '支付成功',
}

const CHART_COLORS = ['#4f7cff', '#22d3ee', '#f59e0b', '#22c55e', '#a78bfa', '#ef4444']

function svgLineChart(rows, series, { height = 220 } = {}) {
  if (!rows?.length) return '<div class="chart-empty">该区间暂无数据</div>'
  const width = 720
  const left = 42
  const right = 16
  const top = 20
  const bottom = 30
  const plotW = width - left - right
  const plotH = height - top - bottom
  const values = rows.flatMap((row) => series.map((item) => Number(row[item.key] ?? 0)))
  const max = Math.max(1, ...values)
  const xOf = (index) => left + (rows.length === 1 ? plotW / 2 : (index / (rows.length - 1)) * plotW)
  const yOf = (value) => top + plotH - (Number(value ?? 0) / max) * plotH
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = top + plotH * ratio
    return `<line class="chart-grid-line" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"></line>`
  }).join('')
  const labelStep = Math.max(1, Math.ceil(rows.length / 6))
  const xLabels = rows.map((row, index) => (index % labelStep === 0 || index === rows.length - 1)
    ? `<text class="chart-axis-text" x="${xOf(index)}" y="${height - 8}" text-anchor="middle">${esc(String(row.day ?? '').slice(5))}</text>`
    : '').join('')
  const paths = series.map((item, seriesIndex) => {
    const points = rows.map((row, index) => `${xOf(index).toFixed(1)},${yOf(row[item.key]).toFixed(1)}`).join(' ')
    const area = seriesIndex === 0
      ? `<polygon points="${left},${top + plotH} ${points} ${xOf(rows.length - 1)},${top + plotH}" fill="${item.color}" opacity=".10"></polygon>`
      : ''
    return `${area}<polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      ${rows.map((row, index) => `<circle cx="${xOf(index)}" cy="${yOf(row[item.key])}" r="3.5" fill="${item.color}"><title>${esc(row.day ?? '')} ${esc(item.label)} ${fmt(row[item.key] ?? 0)}</title></circle>`).join('')}`
  }).join('')
  const legend = series.map((item) => `<span class="chart-legend-item"><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join('')
  return `<div class="chart-block">
    <div class="chart-legend">${legend}<span class="chart-legend-total">峰值 ${fmt(max)}</span></div>
    <svg class="analytics-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="趋势图">
      ${grid}${xLabels}${paths}
    </svg>
  </div>`
}

function funnelChart(stages) {
  const list = (stages ?? []).filter((stage) => stage && stage.label)
  if (!list.length) return '<div class="chart-empty">该区间暂无漏斗数据</div>'
  const values = list.map((stage) => Number(stage.value ?? 0))
  const base = Math.max(1, ...values)
  return `<div class="funnel-chart">${list.map((stage, index) => {
    const value = Number(stage.value ?? 0)
    const width = Math.max(2, Math.round((value / base) * 100))
    const previous = index === 0 ? value : Number(list[index - 1].value ?? 0)
    const rate = Number.isFinite(Number(stage.rate))
      ? Number(stage.rate)
      : (index === 0 ? 100 : (previous ? Number(((value / previous) * 100).toFixed(1)) : 0))
    return `<div class="funnel-row">
      <div class="funnel-label"><span>${esc(stage.label)}</span><b>${fmt(value)}</b></div>
      <div class="funnel-track"><i style="width:${width}%;background:${CHART_COLORS[index % CHART_COLORS.length]}"></i></div>
      <span class="funnel-rate">${rate}%</span>
    </div>`
  }).join('')}<p class="funnel-note">按同一访客逐级去重，只统计完成前序步骤的人；新数据按匿名访客 ID 归因，历史数据按用户/IP 回退。历史订单若缺 visitor_id，不会计入漏斗的「支付成功」，因此可能低于上方按订单统计的支付转化率。</p></div>`
}

function donutChart(segments, centerLabel = '总计') {
  const list = (segments ?? []).filter((item) => Number(item.value ?? 0) > 0)
  const total = list.reduce((sum, item) => sum + Number(item.value ?? 0), 0)
  if (!total) return '<div class="chart-empty">该区间暂无数据</div>'
  let cursor = 0
  const stops = list.map((item, index) => {
    const start = cursor
    cursor += (Number(item.value) / total) * 100
    return `${item.color ?? CHART_COLORS[index % CHART_COLORS.length]} ${start.toFixed(2)}% ${cursor.toFixed(2)}%`
  }).join(', ')
  return `<div class="donut-wrap">
    <div class="donut" style="background:conic-gradient(${stops})"><div class="donut-center"><b>${fmt(total)}</b><span>${esc(centerLabel)}</span></div></div>
    <div class="donut-legend">${list.map((item, index) => `<span><i style="background:${item.color ?? CHART_COLORS[index % CHART_COLORS.length]}"></i>${esc(item.label)}<b>${fmt(item.value)}</b></span>`).join('')}</div>
  </div>`
}

function rankedBars(rows, key, labelKey, unit = '') {
  const list = (rows ?? []).filter(Boolean).slice(0, 8)
  if (!list.length) return '<div class="chart-empty">该区间暂无数据</div>'
  const max = Math.max(1, ...list.map((row) => Number(row[key] ?? 0)))
  return `<div class="ranked-bars">${list.map((row, index) => {
    const value = Number(row[key] ?? 0)
    return `<div class="ranked-row">
      <span class="ranked-label" title="${esc(row[labelKey] ?? '')}">${esc(row[labelKey] ?? '—')}</span>
      <span class="ranked-track"><i style="width:${Math.max(2, Math.round((value / max) * 100))}%;background:${CHART_COLORS[index % CHART_COLORS.length]}"></i></span>
      <b>${fmt(value)}${unit}</b>
    </div>`
  }).join('')}</div>`
}

async function pageAnalytics() {
  const days = Number(localStorage.getItem('mh-analytics-days') ?? 7)
  const perms = new Set(state.me?.permissions ?? [])
  const data = await api(`/admin/api/analytics?days=${days}`)
  const t = {
    upstream: {}, byType: [], completion: {}, searchTerms: [], topDetailViews: [],
    ...(data.tracking ?? {}),
  }
  const u = { detailViews: 0, paywallViews: 0, paywallClicks: 0, detailToPaywall: 0, paywallToOrder: 0, orderToPaid: 0, ...t.upstream }
  const comp = { samples: 0, avgRate: 0, finished: 0, ...t.completion }
  const visitors = { total: 0, anonymous: 0, linked: 0, newByDay: [], ...(data.visitors ?? {}) }
  const conversion = data.conversion ?? [
    { label: '访客', value: visitors.total },
    { label: '页面浏览', value: u.pageViews ?? 0 },
    { label: '详情页', value: u.detailViews },
    { label: '付费墙', value: u.paywallViews },
    { label: '下单', value: data.funnel.orders },
    { label: '支付成功', value: data.funnel.paid },
  ]
  const visitorDayMap = new Map()
  for (const row of visitors.newByDay ?? []) visitorDayMap.set(row.day, { day: row.day, visitors: row.n, users: 0 })
  for (const row of data.users.newByDay ?? []) {
    const item = visitorDayMap.get(row.day) ?? { day: row.day, visitors: 0, users: 0 }
    item.users = row.n
    visitorDayMap.set(row.day, item)
  }
  const visitorDays = [...visitorDayMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))
  const eventDayMap = new Map()
  for (const row of t.byDay ?? []) {
    const item = eventDayMap.get(row.day) ?? { day: row.day }
    item[row.type] = row.n
    eventDayMap.set(row.day, item)
  }
  const eventDays = [...eventDayMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)))
  const sourceLabel = { play: '正常播放', trial: '试看' }
  const sourceSegments = (data.sourceSplit ?? []).map((row, index) => ({
    label: sourceLabel[row.source] ?? row.source, value: row.n, color: CHART_COLORS[index % CHART_COLORS.length],
  }))
  const channelRows = (data.byChannel ?? []).map((row) => ({ label: row.channel, revenue: row.revenue }))
  const eventRows = (t.byType ?? []).map((row) => ({ label: EVENT_LABEL[row.type] ?? row.type, value: row.n }))
  const bars = (rows, key, label) => {
    const max = Math.max(1, ...rows.map((row) => Number(row[key] ?? 0)))
    return `<div class="bars">${rows.map((row) => `<div class="bar-row">
      <span class="bar-label">${esc(row.day ?? row.date ?? '')}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.round((Number(row[key] ?? 0) / max) * 100)}%"></span></span>
      <span class="bar-value">${fmt(row[key] ?? 0)}</span>
    </div>`).join('') || '<div class="muted">该区间暂无数据</div>'}</div>`
  }

  view.innerHTML = panel('经营数据', `
    <div class="form-row" style="margin-bottom:12px">
      ${[7, 14, 30].map((n) => `<button class="btn sm ${days === n ? 'primary' : ''}" data-days="${n}">近 ${n} 天</button>`).join('')}
      <span class="spacer" style="flex:1"></span>
      <span class="muted">统计区间：${esc(data.range.since)} 起</span>
      ${perms.has('growth.distribution.read') ? '<a class="btn sm" href="#/distribution">分销分析</a>' : ''}
      ${perms.has('growth.distribution.write') ? '<a class="btn sm primary" href="#/distribution-config">分销配置</a>' : ''}
    </div>

    <div class="cards">
      ${card('播放量', fmt(data.totals.plays), `次（历史 ${fmt(data.totals.playsAllTime)}）`)}
      ${card('独立观众', fmt(data.totals.viewers), '人')}
      ${card('人均播放', String(data.totals.playsPerViewer), '次/人')}
      ${card('被播放剧集', fmt(data.totals.dramasPlayed), '部')}
      ${card('收入', `¥${fmt(data.money.revenue)}`, `客单价 ¥${data.money.aov}`)}
      ${card('支付转化', `${data.funnel.payRate}%`, `${data.funnel.paid}/${data.funnel.orders} 单`)}
      ${card('新增用户', fmt(data.users.newInRange), `累计 ${fmt(data.users.total)}`)}
      ${card('活跃订阅', fmt(data.subscriptions.active), '个')}
      ${card('新增访客', fmt(visitors.total), `匿名 ${fmt(visitors.anonymous)} · 已关联 ${fmt(visitors.linked)}`)}
      ${card('页面浏览', fmt(u.pageViews ?? 0), '次')}
    </div>

    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>播放与访客趋势</h3>
        ${svgLineChart(data.playsByDay, [
          { key: 'plays', label: '播放量', color: CHART_COLORS[0] },
          { key: 'viewers', label: '独立观众', color: CHART_COLORS[1] },
        ])}
        <h3 style="margin-top:18px">新增访客 / 注册用户</h3>
        ${svgLineChart(visitorDays, [
          { key: 'visitors', label: '新增访客', color: CHART_COLORS[2] },
          { key: 'users', label: '注册用户', color: CHART_COLORS[3] },
        ])}
        <h3 style="margin-top:18px">关键事件趋势</h3>
        ${svgLineChart(eventDays, [
          { key: 'page_view', label: '页面浏览', color: CHART_COLORS[0] },
          { key: 'detail_view', label: '详情页', color: CHART_COLORS[1] },
          { key: 'play_start', label: '开始播放', color: CHART_COLORS[3] },
          { key: 'paywall_view', label: '付费墙', color: CHART_COLORS[2] },
        ])}
      </div>
      <div class="panel">
        <h3>转化漏斗</h3>
        ${funnelChart(conversion)}
        <h3 style="margin-top:20px">播放来源</h3>
        ${donutChart(sourceSegments, '播放')}
      </div>
    </div>

    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>收入趋势</h3>
        ${svgLineChart(data.ordersByDay, [{ key: 'revenue', label: '收入（元）', color: CHART_COLORS[3] }], { height: 190 })}
        <h3 style="margin-top:18px">收款渠道</h3>
        ${rankedBars(channelRows, 'revenue', 'label', ' 元')}
      </div>
      <div class="panel">
        <h3>事件构成</h3>
        ${rankedBars(eventRows, 'value', 'label')}
      </div>
    </div>

    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>播放趋势（按日）</h3>
        ${bars(data.playsByDay, 'plays')}
        <h3 style="margin-top:18px">新增用户（按日）</h3>
        ${bars(data.users.newByDay, 'n')}
      </div>
      <div class="panel">
        <h3>播放来源</h3>
        <table><thead><tr><th>来源</th><th>次数</th></tr></thead><tbody>
          ${(data.sourceSplit.length ? data.sourceSplit : [{ source: '—', n: 0 }]).map((row) => `<tr><td>${row.source === 'trial' ? '试看' : row.source === 'play' ? '正常播放' : esc(row.source)}</td><td>${fmt(row.n)}</td></tr>`).join('')}
        </tbody></table>
        <h3 style="margin-top:18px">订阅分布</h3>
        <table><thead><tr><th>套餐</th><th>人数</th></tr></thead><tbody>
          ${(data.subscriptions.byPlan.length ? data.subscriptions.byPlan : [{ name: '—', n: 0 }]).map((row) => `<tr><td>${esc(row.name)}</td><td>${fmt(row.n)}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>

    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>热门内容 Top 10</h3>
        <table><thead><tr><th>剧集</th><th>播放</th><th>观众</th></tr></thead><tbody>
          ${(data.topDramas.length ? data.topDramas : [{ title: '—', plays: 0, viewers: 0 }]).map((row) => `<tr><td>${esc(row.title)}</td><td>${fmt(row.plays)}</td><td>${fmt(row.viewers)}</td></tr>`).join('')}
        </tbody></table>
      </div>
      <div class="panel">
        <h3>收款渠道</h3>
        <table><thead><tr><th>渠道</th><th>订单</th><th>收入</th></tr></thead><tbody>
          ${(data.byChannel.length ? data.byChannel : [{ channel: '—', orders: 0, revenue: 0 }]).map((row) => `<tr><td>${esc(row.channel)}</td><td>${fmt(row.orders)}</td><td>¥${fmt(row.revenue)}</td></tr>`).join('')}
        </tbody></table>
        <h3 style="margin-top:18px">订单漏斗</h3>
        <table><tbody>
          <tr><td>下单</td><td>${fmt(data.funnel.orders)}</td></tr>
          <tr><td>已支付</td><td>${fmt(data.funnel.paid)}</td></tr>
          <tr><td>超时关闭</td><td>${fmt(data.funnel.closed)}</td></tr>
          <tr><td>已退款</td><td>${fmt(data.funnel.refunded)}</td></tr>
          <tr><td>退款中</td><td>${fmt(data.money.pendingRefunds)}</td></tr>
        </tbody></table>
      </div>
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>转化漏斗（上游）</h3>
        <table><tbody>
          <tr><td>详情页浏览</td><td>${fmt(u.detailViews)}</td></tr>
          <tr><td>选集点击</td><td>${fmt(u.episodeClicks ?? 0)}</td></tr>
          <tr><td>开始播放</td><td>${fmt(u.playStarts ?? 0)} <span class="muted">播放失败 ${fmt(u.playErrors ?? 0)}</span></td></tr>
          <tr><td>付费墙展示</td><td>${fmt(u.paywallViews)} <span class="muted">详情→付费墙 ${u.detailToPaywall}%</span></td></tr>
          <tr><td>付费墙点击</td><td>${fmt(u.paywallClicks)}</td></tr>
          <tr><td>打开登录 / 登录成功</td><td>${fmt(u.loginOpens ?? 0)} / ${fmt(u.loginSuccesses ?? 0)}</td></tr>
          <tr><td>收藏</td><td>${fmt(u.favorites ?? 0)}</td></tr>
          <tr><td>下单</td><td>${fmt(data.funnel.orders)} <span class="muted">付费墙→下单 ${u.paywallToOrder}%</span></td></tr>
          <tr><td>支付成功</td><td>${fmt(data.funnel.paid)} <span class="muted">下单→支付 ${u.orderToPaid}%</span></td></tr>
        </tbody></table>
        <h3 style="margin-top:18px">完播</h3>
        <table><tbody>
          <tr><td>播放结束事件</td><td>${fmt(comp.samples)}</td></tr>
          <tr><td>平均完播率</td><td>${Math.round(Number(comp.avgRate ?? 0) * 100)}%</td></tr>
          <tr><td>看完（≥90%）</td><td>${fmt(comp.finished)}</td></tr>
        </tbody></table>
      </div>
      <div class="panel">
        <h3>事件类型</h3>
        <table><thead><tr><th>事件</th><th>次数</th></tr></thead><tbody>
          ${(t.byType.length ? t.byType : [{ type: '—', n: 0 }]).map((row) => `<tr><td>${esc(EVENT_LABEL[row.type] ?? row.type)}</td><td>${fmt(row.n)}</td></tr>`).join('')}
        </tbody></table>
        <h3 style="margin-top:18px">搜索词 Top 10</h3>
        <table><thead><tr><th>关键词</th><th>次数</th></tr></thead><tbody>
          ${(t.searchTerms.length ? t.searchTerms : [{ term: '—', n: 0 }]).map((row) => `<tr><td>${esc(row.term)}</td><td>${fmt(row.n)}</td></tr>`).join('')}
        </tbody></table>
      </div>
    </div>`)

  for (const button of view.querySelectorAll('[data-days]')) {
    button.addEventListener('click', async () => {
      localStorage.setItem('mh-analytics-days', button.dataset.days)
      await pageAnalytics()
    })
  }
}

/* ---------------- 渠道分析 ---------------- */
const CHANNEL_TYPE_LABEL = {
  paid_ad: '广告投放', kol: '达人合作', affiliate: '联盟', distribution: '分销',
  organic: '自然流量', direct: '直接访问', legacy_unattributed: '历史未归因',
}

async function pageChannels() {
  const days = Number(localStorage.getItem('mh-channel-days') ?? 7)
  const [catalog, report, attributionConfig] = await Promise.all([
    api('/admin/api/channels'),
    api(`/admin/api/channels/analytics?days=${days}`),
    api('/admin/api/attribution/config'),
  ])
  const channels = catalog.channels ?? []
  const domains = catalog.domains ?? []
  const codes = catalog.promoCodes ?? []
  const t = report.totals ?? {}
  const reportPage = clientPage('channelReport', report.rows ?? [], 20)
  const channelPage = clientPage('channelConfig', channels, 20)
  const touchRows = [
    ...domains.map((row) => `<tr><td>${esc(row.host)}${esc(row.path_prefix)}</td><td>${esc(row.channel_name)}</td><td>域名</td></tr>`),
    ...codes.map((row) => `<tr><td>${esc(row.code)}</td><td>${esc(row.channel_name)}</td><td>${row.purpose === 'distribution' ? '分销' : '投放'}码</td></tr>`),
  ]
  const touchPage = clientPage('channelTouchpoints', touchRows, 20)
  view.innerHTML = panel('渠道分析', `
    <div class="form-row" style="margin-bottom:12px">
      ${[7, 14, 30].map((n) => `<button class="btn sm ${days === n ? 'primary' : ''}" data-channel-days="${n}">近 ${n} 天</button>`).join('')}
      <span class="spacer" style="flex:1"></span>
      <select id="attribution-model" aria-label="归因模型" style="width:130px">
        <option value="first_touch" ${attributionConfig.model !== 'last_touch' ? 'selected' : ''}>首次归因</option>
        <option value="last_touch" ${attributionConfig.model === 'last_touch' ? 'selected' : ''}>末次归因</option>
      </select>
      <button class="btn sm" id="save-attribution">保存模型</button>
      <button class="btn sm" id="add-channel">＋ 渠道</button>
      <button class="btn sm" id="add-domain">＋ 域名</button>
      <button class="btn sm" id="add-promo">＋ 推广码</button>
    </div>
    <div class="cards">
      ${card('渠道访客', fmt(t.visitors), '人')}
      ${card('新增注册', fmt(t.newUsers), '人')}
      ${card('下单量', fmt(t.createdOrders), '单')}
      ${card('支付订单', fmt(t.paidOrders), '单')}
      ${card('支付金额', `¥${fmt(t.grossPaidAmount)}`, '毛收入')}
      ${card('访客到支付率', `${Number(t.visitorToPaidRate ?? 0).toFixed(1)}%`, '')}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>渠道转化</h3>
      ${table(['渠道', '类型', '访客', '注册', '下单', '支付', '支付率', '支付金额', '退款', '净收入', 'ROAS'], reportPage.items.map((row) => `<tr>
        <td>${esc(row.channelName)}<div class="muted small">${esc(row.channelCode)}</div></td>
        <td>${esc(CHANNEL_TYPE_LABEL[row.channelType] ?? row.channelType)}</td>
        <td>${fmt(row.visitors)}</td><td>${fmt(row.newUsers)}</td><td>${fmt(row.createdOrders)}</td>
        <td>${fmt(row.paidOrders)}</td><td>${Number(row.payRate ?? 0).toFixed(1)}%</td>
        <td>¥${fmt(row.grossPaidAmount)}</td><td>¥${fmt(row.refundAmount)}</td><td>¥${fmt(row.netRevenue)}</td>
        <td>${row.roas == null ? '未导入花费' : Number(row.roas).toFixed(2)}</td>
      </tr>`))}
      ${pager('channelReport', reportPage.page, reportPage.pageSize, reportPage.total, '个')}
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>渠道配置</h3>
        ${table(['渠道', '类型', '状态', '域名', '推广码'], channelPage.items.map((row) => `<tr>
          <td>${esc(row.channel_name)}<div class="muted small">${esc(row.channel_code)}</div></td>
          <td>${esc(CHANNEL_TYPE_LABEL[row.channel_type] ?? row.channel_type)}</td>
          <td><span class="pill ${row.status === 'active' ? 'ok' : ''}">${row.status === 'active' ? '启用' : '停用'}</span></td>
          <td>${fmt(row.domainCount)}</td><td>${fmt(row.promoCodeCount)}</td>
        </tr>`))}
        ${pager('channelConfig', channelPage.page, channelPage.pageSize, channelPage.total, '个')}
      </div>
      <div class="panel">
        <h3>域名与推广码</h3>
        ${table(['域名 / 推广码', '归属', '状态'], touchPage.items)}
        ${pager('channelTouchpoints', touchPage.page, touchPage.pageSize, touchPage.total, '个')}
      </div>
    </div>`, '<span class="muted">归因口径：推广码优先，其次域名最长前缀</span>')

  for (const button of view.querySelectorAll('[data-channel-days]')) {
    button.addEventListener('click', async () => {
      localStorage.setItem('mh-channel-days', button.dataset.channelDays)
      listPages.channelReport = 1
      listPages.channelConfig = 1
      listPages.channelTouchpoints = 1
      await pageChannels()
    })
  }

  $('#save-attribution')?.addEventListener('click', async () => {
    try {
      await api('/admin/api/attribution/config', { method: 'POST', body: {
        model: $('#attribution-model').value, windowDays: 30,
      } })
      toast('归因模型已保存')
      await pageChannels()
    } catch (error) { toast(error.message) }
  })

  const reload = async () => { toast('已保存'); await pageChannels() }
  const channelForm = () => {
    openOverlay('新增渠道', `
      <div class="settings-ui">
        <p class="settings-modal-copy">渠道用于承接投放来源，编码创建后不要随意更改。</p>
        <div class="settings-form-grid modal-settings-grid">
          <label class="setting-field">
            <span>渠道编码</span>
            <input class="input" id="ch-code" placeholder="例如 douyin_a" />
            <small>建议使用英文小写和下划线。</small>
          </label>
          <label class="setting-field">
            <span>渠道名称</span>
            <input class="input" id="ch-name" placeholder="例如 抖音 A 计划" />
          </label>
          <label class="setting-field settings-span-2">
            <span>渠道类型</span>
            <select class="input" id="ch-type">${Object.entries(CHANNEL_TYPE_LABEL).filter(([key]) => !['legacy_unattributed'].includes(key)).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select>
          </label>
        </div>
        <div class="modal-foot"><button class="btn" data-cancel>取消</button><button class="btn primary" id="ch-save">保存</button></div>
      </div>`, (body, close) => {
      body.querySelector('[data-cancel]').addEventListener('click', close)
      body.querySelector('#ch-save').addEventListener('click', async () => {
        try {
          await api('/admin/api/channels', { method: 'POST', body: {
            action: 'channel',
            channelCode: body.querySelector('#ch-code').value,
            channelName: body.querySelector('#ch-name').value,
            channelType: body.querySelector('#ch-type').value,
          } })
          close(); await reload()
        } catch (error) { toast(error.message) }
      })
    })
  }
  const domainForm = () => {
    openOverlay('新增域名', `
      <div class="settings-ui">
        <p class="settings-modal-copy">域名用于归因匹配；同一路径前缀按最长匹配优先。</p>
        <div class="settings-form-grid modal-settings-grid">
          <label class="setting-field settings-span-2">
            <span>归属渠道</span>
            <select class="input" id="dm-channel">${channels.map((row) => `<option value="${row.id}">${esc(row.channel_name)}</option>`).join('')}</select>
          </label>
          <label class="setting-field">
            <span>域名</span>
            <input class="input" id="dm-host" placeholder="例如 a.example.com" />
          </label>
          <label class="setting-field">
            <span>路径前缀</span>
            <input class="input" id="dm-path" value="/" placeholder="/" />
          </label>
        </div>
        <div class="modal-foot"><button class="btn" data-cancel>取消</button><button class="btn primary" id="dm-save">保存</button></div>
      </div>`, (body, close) => {
      body.querySelector('[data-cancel]').addEventListener('click', close)
      body.querySelector('#dm-save').addEventListener('click', async () => {
        try {
          await api('/admin/api/channels', { method: 'POST', body: {
            action: 'domain', channelId: Number(body.querySelector('#dm-channel').value),
            host: body.querySelector('#dm-host').value, pathPrefix: body.querySelector('#dm-path').value || '/',
          } })
          close(); await reload()
        } catch (error) { toast(error.message) }
      })
    })
  }
  const promoForm = () => {
    openOverlay('新增推广码', `
      <div class="settings-ui">
        <p class="settings-modal-copy">推广码优先于域名匹配；使用上限填 0 表示不限制。</p>
        <div class="settings-form-grid modal-settings-grid">
          <label class="setting-field">
            <span>推广码</span>
            <input class="input" id="pc-code" placeholder="例如 AFF10" />
          </label>
          <label class="setting-field">
            <span>归属渠道</span>
            <select class="input" id="pc-channel">${channels.map((row) => `<option value="${row.id}">${esc(row.channel_name)}</option>`).join('')}</select>
          </label>
          <label class="setting-field">
            <span>用途</span>
            <select class="input" id="pc-purpose"><option value="acquisition">投放</option><option value="distribution">分销</option></select>
          </label>
          <label class="setting-field">
            <span>使用上限</span>
            <input class="input" id="pc-max" type="number" min="0" value="0" />
            <small>0 表示不限制使用次数。</small>
          </label>
        </div>
        <div class="modal-foot"><button class="btn" data-cancel>取消</button><button class="btn primary" id="pc-save">保存</button></div>
      </div>`, (body, close) => {
      body.querySelector('[data-cancel]').addEventListener('click', close)
      body.querySelector('#pc-save').addEventListener('click', async () => {
        try {
          await api('/admin/api/channels', { method: 'POST', body: {
            action: 'promo', code: body.querySelector('#pc-code').value,
            channelId: Number(body.querySelector('#pc-channel').value),
            purpose: body.querySelector('#pc-purpose').value,
            maxUses: Number(body.querySelector('#pc-max').value) || 0,
          } })
          close(); await reload()
        } catch (error) { toast(error.message) }
      })
    })
  }
  $('#add-channel')?.addEventListener('click', channelForm)
  $('#add-domain')?.addEventListener('click', domainForm)
  $('#add-promo')?.addEventListener('click', promoForm)
  bindPager('channelReport', pageChannels)
  bindPager('channelConfig', pageChannels)
  bindPager('channelTouchpoints', pageChannels)
}

/* ---------------- 内容统计 ---------------- */
async function pageContentStats() {
  const days = Number(localStorage.getItem('mh-content-days') ?? 7)
  const contentType = localStorage.getItem('mh-content-type') ?? 'all'
  const canRefresh = new Set(state.me?.permissions ?? []).has('growth.content.write')
  const [data, rank] = await Promise.all([
    api(`/admin/api/content-stats?days=${days}&contentType=${encodeURIComponent(contentType)}`),
    api(`/admin/api/content-ranks?type=hot&contentType=${encodeURIComponent(contentType)}`),
  ])
  const t = data.totals ?? {}
  const pct = (value) => `${(Number(value ?? 0) * 100).toFixed(1)}%`
  const statsPage = clientPage('contentStats', data.rows ?? [], 20)
  const contentRankPage = clientPage('contentRank', rank.items ?? [], 20)
  view.innerHTML = panel('内容统计', `
    <div class="form-row" style="margin-bottom:12px">
      ${[7, 14, 30].map((n) => `<button class="btn sm ${days === n ? 'primary' : ''}" data-content-days="${n}">近 ${n} 天</button>`).join('')}
      <select id="content-type-filter" aria-label="内容类型筛选" style="width:140px">
        ${[['all', '全部类型'], ['series', '剧集'], ['movie', '电影'], ['comic_drama', '漫剧']].map(([value, label]) => `<option value="${value}" ${contentType === value ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
      <span class="spacer" style="flex:1"></span>
      ${canRefresh ? '<button class="btn sm" id="refresh-content-stats">重算统计与榜单</button>' : ''}
    </div>
    <div class="cards">
      ${card('点击', fmt(t.clickCount), `人数 ${fmt(t.clickUv)}`)}
      ${card('有效观看', fmt(t.viewCount), `人数 ${fmt(t.viewerCount)}`)}
      ${card('完播率', pct(t.completionRate), `${fmt(t.completionCount)} 次完播`)}
      ${card('新增收藏', fmt(t.favoriteAddCount), `取消 ${fmt(t.favoriteRemoveCount)}`)}
      ${card('当前收藏', fmt(t.favoriteCount), '个')}
      ${card('平均观看', `${Number(t.avgWatchSeconds ?? 0).toFixed(0)}s`, '有效会话')}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>内容表现</h3>
      ${table(['内容', '类型', '点击', '观看', '人数', '完播率', '收藏新增', '当前收藏', '收藏率', '点击→观看'], statsPage.items.map((row) => `<tr>
        <td>${esc(row.title)}<div class="muted small">#${row.contentId}</div></td>
        <td>${esc({ series: '剧集', movie: '电影', comic_drama: '漫剧' }[row.contentType] ?? row.contentType ?? '—')}</td>
        <td>${fmt(row.clickCount)}</td><td>${fmt(row.viewCount)}</td><td>${fmt(row.viewerCount)}</td>
        <td>${pct(row.completionRate)}</td><td>${fmt(row.favoriteAddCount)}</td><td>${fmt(row.favoriteCount)}</td>
        <td>${pct(row.favoriteRate)}</td><td>${pct(row.clickToViewRate)}</td>
      </tr>`))}
      ${pager('contentStats', statsPage.page, statsPage.pageSize, statsPage.total, '部')}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>热播榜 <span class="muted small">${esc(rank.generatedAt ?? '尚未生成')}</span></h3>
      ${table(['#', '内容', '观看人数', '有效观看', '完播率', '新增收藏'], contentRankPage.items.map((row) => `<tr>
        <td>${row.rankNo}</td><td>${esc(row.title)}</td><td>${fmt(row.metrics?.viewerCount)}</td>
        <td>${fmt(row.metrics?.viewCount)}</td><td>${pct(row.metrics?.completionRate)}</td><td>${fmt(row.metrics?.favoriteAddUv)}</td>
      </tr>`))}
      ${pager('contentRank', contentRankPage.page, contentRankPage.pageSize, contentRankPage.total, '部')}
    </div>`, '<span class="muted">窗口 UV 来自原始会话，不把日 UV 直接相加</span>')
  for (const button of view.querySelectorAll('[data-content-days]')) {
    button.addEventListener('click', async () => {
      localStorage.setItem('mh-content-days', button.dataset.contentDays)
      listPages.contentStats = 1
      listPages.contentRank = 1
      await pageContentStats()
    })
  }
  $('#content-type-filter')?.addEventListener('change', async (event) => {
    localStorage.setItem('mh-content-type', event.target.value)
    listPages.contentStats = 1
    listPages.contentRank = 1
    await pageContentStats()
  })
  $('#refresh-content-stats')?.addEventListener('click', async () => {
    try {
      await api('/admin/api/content-stats/refresh', { method: 'POST', body: { days } })
      toast('统计与榜单已重算')
      await pageContentStats()
    } catch (error) { toast(error.message) }
  })
  bindPager('contentStats', pageContentStats)
  bindPager('contentRank', pageContentStats)
}

/* ---------------- 分销佣金 ---------------- */
async function pageDistribution() {
  const days = Number(localStorage.getItem('mh-distribution-days') ?? 30)
  const canConfigure = new Set(state.me?.permissions ?? []).has('growth.distribution.write')
  const pageQuery = (key) => `page=${listPages[key] ?? 1}&pageSize=20`
  const [configData, dashboard, overview, settlements, commissions, relations, withdrawals] = await Promise.all([
    api('/admin/api/distribution/config'),
    api(`/admin/api/distribution/dashboard?days=${days}`),
    api(`/admin/api/distribution/overview?days=${days}`),
    api(`/admin/api/distribution/settlements?${pageQuery('distributionSettlements')}`),
    api(`/admin/api/distribution/commissions?${pageQuery('distributionCommissions')}`),
    api(`/admin/api/distribution/relations?${pageQuery('distributionRelations')}`),
    api(`/admin/api/distribution/withdrawals?${pageQuery('distributionWithdrawals')}`),
  ])
  const config = configData.config ?? {}
  const ruleCount = (configData.rules ?? []).length
  const t = overview.totals ?? {}
  const d = dashboard.summary ?? {}
  const yuan = (fen) => `¥${(Number(fen ?? 0) / 100).toFixed(2)}`
  const daily = (dashboard.daily ?? []).map((row) => ({
    ...row,
    paidYuan: Number(row.paidAmount ?? 0),
    commissionYuan: Number(row.commissionFen ?? 0) / 100,
  }))
  const funnelRows = (dashboard.funnel ?? []).map((row, index, list) => ({
    ...row,
    rate: index === 0 ? 100 : (Number(list[index - 1]?.value ?? 0) ? Number(row.value ?? 0) / Number(list[index - 1].value) * 100 : 0),
  }))
  const topDistributorPage = clientPage('distributionTopDistributors', dashboard.topDistributors ?? [], 10)
  const topContentPage = clientPage('distributionTopContent', dashboard.topContent ?? [], 10)
  const withdrawalPage = withdrawals
  const distributorPage = clientPage('distributionDistributors', overview.rows ?? [], 10)
  const settlementPage = settlements
  const commissionPage = commissions
  const relationPage = relations
  view.innerHTML = panel('分销分析', `
    <div class="form-row" style="margin-bottom:12px">
      ${[7, 30, 90].map((n) => `<button class="btn sm ${days === n ? 'primary' : ''}" data-distribution-days="${n}">近 ${n} 天</button>`).join('')}
      <span class="spacer" style="flex:1"></span>
      ${canConfigure
        ? '<a class="btn sm primary" href="#/distribution-config">分销配置</a>'
        : '<span class="muted small">当前账号仅可查看分销数据</span>'}
      <a class="btn sm" href="#/analytics">经营总览</a>
    </div>
    <div class="cards">
      ${card('邀请点击', fmt(d.inviteClicks), `访客 ${fmt(d.inviteVisitors)}`)}
      ${card('有效邀请', fmt(d.invites), `覆盖 ${fmt(d.invitees)} 人`)}
      ${card('付费用户', fmt(d.paidUsers), `${fmt(d.paidOrders)} 笔订单`)}
      ${card('支付金额', yuan(d.paidAmountFen), `净额 ${yuan(d.netAmountFen)}`)}
      ${card('佣金总额', yuan(d.commissionTotalFen), `冲减 ${yuan(d.commissionReversedFen)}`)}
      ${card('待结算', yuan(d.commissionPendingFen), `可结算 ${yuan(d.commissionAvailableFen)}`)}
      ${card('已结算', yuan(d.commissionSettledFen), '')}
      ${card('推广员', fmt(d.activeDistributors), `启用 / 待审 ${fmt(d.pendingDistributors)}`)}
    </div>
    <div class="cards" style="margin-top:12px">
      ${card('待审提现', fmt(withdrawals.summary?.pendingCount ?? 0), '笔')}
      ${card('待打款', yuan(withdrawals.summary?.approvedFen ?? 0), '')}
      ${card('已打款', yuan(withdrawals.summary?.paidFen ?? 0), '')}
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>邀请转化漏斗</h3>
        ${funnelChart(funnelRows)}
      </div>
      <div class="panel">
        <h3>按日趋势</h3>
        ${svgLineChart(daily, [
          { key: 'paidYuan', label: '支付金额（元）', color: CHART_COLORS[3] },
          { key: 'commissionYuan', label: '佣金（元）', color: CHART_COLORS[0] },
        ], { height: 230 })}
      </div>
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>层级贡献</h3>
        ${table(['层级', '邀请人数', '支付订单', '支付金额', '佣金'], (dashboard.byLevel ?? []).map((row) => `<tr>
          <td>${row.level} 级</td><td>${fmt(row.invitees)}</td><td>${fmt(row.paidOrders)}</td>
          <td>${yuan(row.paidAmount * 100)}</td><td>${yuan(row.commissionFen)}</td></tr>`))}
      </div>
      <div class="panel">
        <h3>内容类型贡献</h3>
        ${table(['类型', '支付订单', '支付金额', '佣金'], (dashboard.byContentType ?? []).map((row) => `<tr>
          <td>${esc({ series: '剧集', movie: '电影', comic_drama: '漫剧', subscription: '会员订阅' }[row.contentType] ?? row.contentType)}</td>
          <td>${fmt(row.paidOrders)}</td><td>${yuan(row.paidAmount * 100)}</td><td>${yuan(row.commissionFen)}</td></tr>`))}
      </div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>Top 分销员</h3>
      ${table(['分销员', '直邀', '团队', '支付订单', '支付金额', '净佣金'], topDistributorPage.items.map((row) => `<tr>
        <td>${esc(row.nickname ?? `#${row.distributorUserId}`)}</td><td>${fmt(row.directInvitees)}</td>
        <td>${fmt(row.teamSize)}</td><td>${fmt(row.paidOrders)}</td><td>¥${fmt(row.paidAmount)}</td>
        <td>${yuan(row.netCommissionFen)}</td></tr>`))}
      ${pager('distributionTopDistributors', topDistributorPage.page, topDistributorPage.pageSize, topDistributorPage.total, '人')}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>Top 内容</h3>
      ${table(['内容', '支付订单', '支付金额', '佣金'], topContentPage.items.map((row) => `<tr>
        <td>${esc(row.title)}</td><td>${fmt(row.paidOrders)}</td><td>¥${fmt(row.paidAmount)}</td><td>${yuan(row.commissionFen)}</td></tr>`))}
      ${pager('distributionTopContent', topContentPage.page, topContentPage.pageSize, topContentPage.total, '部')}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>佣金状态</h3>
      ${table(['状态', '记录数', '净额'], (dashboard.statuses ?? []).map((row) => `<tr>
        <td>${esc(row.status)}</td><td>${fmt(row.n)}</td><td>${yuan(row.netFen)}</td></tr>`))}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>提现申请 <span class="muted small">用户提交，需财务审核</span></h3>
      ${table(['时间', '推广员', '金额', '方式', '状态', '操作'], withdrawalPage.items.map((row) => `<tr>
        <td>${esc(fmtTs(row.created_at))}</td><td>${esc(row.nickname ?? `#${row.distributor_user_id}`)}</td>
        <td>${esc(row.currency_symbol ?? '')}${Number(row.amount ?? 0).toFixed(2)}</td>
        <td>${esc(row.method_name ?? row.method_code)}</td><td>${esc(row.status)}</td>
        <td><button class="btn sm" data-withdrawal-action="approve" data-withdrawal-id="${row.id}">批准</button>
          <button class="btn sm" data-withdrawal-action="pay" data-withdrawal-id="${row.id}">打款</button>
          <button class="btn sm" data-withdrawal-action="reject" data-withdrawal-id="${row.id}">驳回</button></td>
      </tr>`))}
      ${pager('distributionWithdrawals', withdrawalPage.page, withdrawalPage.pageSize, withdrawalPage.total, '笔')}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>分销配置 <span class="spacer"></span>${canConfigure ? '<a class="btn sm" href="#/distribution-config">打开配置</a>' : ''}</h3>
      ${table(['状态', '启用级数', '总比例上限', '冻结天数', '最低结算', '自动审核', '归因窗口', '佣金规则'], [`<tr>
        <td><span class="pill ${config.status === 'active' ? 'ok' : ''}">${config.status === 'active' ? '已启用' : '已停用'}</span></td>
        <td>${Number(config.max_enabled_level ?? 3)} 级</td>
        <td>${(Number(config.max_total_rate_bp ?? 0) / 100).toFixed(2)}%</td>
        <td>${Number(config.freeze_days ?? 0)} 天</td>
        <td>¥${(Number(config.min_settlement_fen ?? 0) / 100).toFixed(2)}</td>
        <td>${Number(config.auto_approve ?? 0) ? '自动通过' : '人工审核'}</td>
        <td>${Number(config.attribution_window_days ?? 0)} 天</td>
        <td>${ruleCount} 条</td>
      </tr>`])}
      ${canConfigure ? '' : '<p class="muted small">当前账号只有查看权限；配置入口需要财务或超级管理员角色。</p>'}
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>分销员概览</h3>
      ${table(['分销员', '直邀', '团队', '佣金', '可结算'], distributorPage.items.map((row) => `<tr>
        <td>${esc(row.nickname ?? row.email ?? `#${row.distributorUserId}`)}</td>
        <td>${fmt(row.directInvitees)}</td><td>${fmt(row.teamSize)}</td>
        <td>¥${(Number(row.netCommissionFen ?? 0) / 100).toFixed(2)}</td>
        <td>¥${(Number(row.availableFen ?? 0) / 100).toFixed(2)} <button class="btn sm" data-create-settlement="${row.distributorUserId}">结算</button></td>
      </tr>`))}
      ${pager('distributionDistributors', distributorPage.page, distributorPage.pageSize, distributorPage.total, '人')}
    </div>
    <div class="split" style="margin-top:16px">
      <div class="panel">
        <h3>结算单</h3>
        ${table(['分销员', '周期', '金额', '状态', '操作'], settlementPage.items.map((row) => `<tr>
          <td>#${row.distributor_user_id}</td><td>${esc(row.period_start)} ~ ${esc(row.period_end)}</td>
          <td>¥${(Number(row.amount_fen ?? 0) / 100).toFixed(2)}</td><td>${esc(row.status)}</td>
          <td><button class="btn sm" data-settle-action="approve" data-settle-id="${row.id}">批准</button>
            <button class="btn sm" data-settle-action="pay" data-settle-id="${row.id}">打款</button>
            <button class="btn sm" data-settle-action="reject" data-settle-id="${row.id}">驳回</button></td>
        </tr>`))}
        ${pager('distributionSettlements', settlementPage.page, settlementPage.pageSize, settlementPage.total, '笔')}
      </div>
      <div class="panel">
        <h3>最近佣金</h3>
        ${table(['订单', '层级', '佣金', '状态'], commissionPage.items.map((row) => `<tr>
          <td>${esc(row.out_trade_no ?? `#${row.order_id}`)}</td><td>${row.commission_level} 级</td>
          <td>¥${(Number(row.commission_amount_fen ?? 0) / 100).toFixed(2)}</td><td>${esc(row.status)}</td>
        </tr>`))}
        ${pager('distributionCommissions', commissionPage.page, commissionPage.pageSize, commissionPage.total, '条')}
      </div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>团队关系与风控</h3>
      ${table(['上级', '下级', '深度', '状态', '风险', '操作'], relationPage.items.map((row) => `<tr>
        <td>#${row.ancestor_user_id}</td><td>${esc(row.nickname ?? row.email ?? `#${row.descendant_user_id}`)}</td>
        <td>${row.depth} 级</td><td>${esc(row.status)}</td><td>${esc(row.risk_status)}</td>
        <td><button class="btn sm" data-risk-action="freeze" data-relation-id="${row.relationId}">冻结</button>
          <button class="btn sm" data-risk-action="unfreeze" data-relation-id="${row.relationId}">解冻</button></td>
      </tr>`))}
      ${pager('distributionRelations', relationPage.page, relationPage.pageSize, relationPage.total, '条')}
    </div>`)

  for (const button of view.querySelectorAll('[data-distribution-days]')) {
    button.addEventListener('click', async () => {
      localStorage.setItem('mh-distribution-days', button.dataset.distributionDays)
      for (const key of ['distributionTopDistributors', 'distributionTopContent', 'distributionDistributors', 'distributionCommissions', 'distributionRelations']) {
        listPages[key] = 1
      }
      await pageDistribution()
    })
  }
  for (const button of view.querySelectorAll('[data-create-settlement]')) {
    button.addEventListener('click', () => {
      const distributorUserId = Number(button.dataset.createSettlement)
      const end = new Date().toISOString().slice(0, 10)
      const start = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
      openOverlay('生成结算单', `
        <div class="form-row"><label>分销员<input value="${distributorUserId}" disabled /></label>
          <label>开始日期<input id="st-start" type="date" value="${start}" /></label>
          <label>结束日期<input id="st-end" type="date" value="${end}" /></label></div>
        <div class="modal-foot"><button class="btn" data-cancel>取消</button><button class="btn primary" id="st-save">生成</button></div>`, (body, close) => {
        body.querySelector('[data-cancel]').addEventListener('click', close)
        body.querySelector('#st-save').addEventListener('click', async () => {
          try {
            await api('/admin/api/distribution/settlements', { method: 'POST', body: {
              distributorUserId, periodStart: body.querySelector('#st-start').value, periodEnd: body.querySelector('#st-end').value,
            } })
            close(); toast('结算单已生成'); await pageDistribution()
          } catch (error) { toast(error.message) }
        })
      })
    })
  }
  for (const button of view.querySelectorAll('[data-settle-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.settleAction
      const id = Number(button.dataset.settleId)
      let payoutRef = ''
      if (action === 'pay') {
        const result = await askText({ title: '确认结算打款', label: '打款凭证', hint: '填写银行流水号或链上交易号。', confirmText: '确认打款' })
        if (result === null) return
        payoutRef = result
      }
      try {
        await api(`/admin/api/distribution/settlements/${id}/${action}`, { method: 'POST', body: { payoutRef, reason: action } })
        toast('结算状态已更新'); await pageDistribution()
      } catch (error) { toast(error.message) }
    })
  }
  for (const button of view.querySelectorAll('[data-risk-action]')) {
    button.addEventListener('click', async () => {
      try {
        await api(`/admin/api/distribution/relations/${button.dataset.relationId}/risk`, {
          method: 'POST', body: { action: button.dataset.riskAction, reason: '后台风险处理' },
        })
        toast('风险状态已更新'); await pageDistribution()
      } catch (error) { toast(error.message) }
    })
  }
  for (const button of view.querySelectorAll('[data-withdrawal-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.withdrawalAction
      const id = Number(button.dataset.withdrawalId)
      let payoutRef = ''
      if (action === 'pay') {
        const result = await askText({ title: '确认提现打款', label: '打款凭证', hint: '填写银行流水号或链上交易号。', confirmText: '确认打款' })
        if (result === null) return
        payoutRef = result
      }
      try {
        await api(`/admin/api/distribution/withdrawals/${id}/${action}`, {
          method: 'POST', body: { payoutRef, reason: action },
        })
        toast('提现状态已更新')
        await pageDistribution()
      } catch (error) { toast(error.message) }
    })
  }
  for (const key of ['distributionTopDistributors', 'distributionTopContent', 'distributionWithdrawals', 'distributionDistributors', 'distributionSettlements', 'distributionCommissions', 'distributionRelations']) {
    bindPager(key, pageDistribution)
  }
}

/* ---------------- 分销配置 ---------------- */
const DISTRIBUTION_FIELD_PRESETS = {
  bank_cn: {
    label: '人民币银行卡',
    fields: [
      { key: 'accountName', label: '收款人' },
      { key: 'bankName', label: '开户行' },
      { key: 'accountNo', label: '银行卡号' },
    ],
  },
  bank_intl: {
    label: '国际银行账户',
    fields: [
      { key: 'accountName', label: '收款人' },
      { key: 'bankName', label: '开户行' },
      { key: 'accountNo', label: '银行账号' },
      { key: 'swift', label: 'SWIFT / BIC' },
    ],
  },
  usdt_trc20: {
    label: 'USDT TRC20',
    fields: [{ key: 'address', label: 'TRC20 地址' }],
  },
}

const distributionPercent = (bp) => `${(Number(bp ?? 0) / 100).toFixed(2)}%`
const distributionYuan = (fen, symbol = '¥') => `${symbol}${(Number(fen ?? 0) / 100).toFixed(2)}`

/** 按十进制字符串转分/基点，避免 1.005 * 100 的二进制误差。 */
function decimalToScaled(value) {
  const text = String(value ?? '').trim()
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return 0
  const sign = text.startsWith('-') ? -1 : 1
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.')
  const cents = Number(fraction.slice(0, 2).padEnd(2, '0') || 0)
  const roundUp = Number(fraction[2] ?? 0) >= 5 ? 1 : 0
  return sign * (Number(whole) * 100 + cents + roundUp)
}
const distributionPercentToBp = (value) => decimalToScaled(value)
const distributionYuanToFen = (value) => decimalToScaled(value)

function distributionRuleScope(row) {
  const type = row.scope_type ?? 'global'
  if (type === 'global') return '全部订单'
  if (type === 'content_type') return `内容类型 · ${row.scope_value ?? '未指定'}`
  if (type === 'plan') return `套餐 · #${row.scope_value ?? '-'}`
  if (type === 'content') return `指定内容 · #${row.scope_value ?? '-'}`
  return `${type}${row.scope_value ? ` · ${row.scope_value}` : ''}`
}

function payoutMethodKind(method) {
  if (!method) return ''
  const keys = new Set((method.fields ?? []).map((field) => field.key))
  if (keys.has('address')) return 'usdt_trc20'
  if (keys.has('swift')) return 'bank_intl'
  if (keys.has('accountName') && keys.has('bankName') && keys.has('accountNo')) return 'bank_cn'
  return 'custom'
}

function payoutMethodFieldsForKind(kind) {
  return DISTRIBUTION_FIELD_PRESETS[kind]?.fields ?? []
}

async function pageDistributionConfig() {
  const [configData, payoutConfig] = await Promise.all([
    api('/admin/api/distribution/config'),
    api('/admin/api/distribution/payout-config'),
  ])
  const config = configData.config ?? {}
  const rules = configData.rules ?? []
  const methods = payoutConfig.methods ?? []
  const currencies = payoutConfig.currencies ?? []
  const enabled = config.status !== 'disabled'
  const maxTotalRateBp = Number(config.max_total_rate_bp ?? 1800)
  const maxLevel = Number(config.max_enabled_level ?? 3)
  const ruleRows = rules.map((row) => {
    const thresholds = []
    if (Number(row.min_order_fen ?? 0) > 0) thresholds.push(`订单满 ${distributionYuan(row.min_order_fen)}`)
    if (Number(row.max_commission_fen ?? 0) > 0) thresholds.push(`单笔封顶 ${distributionYuan(row.max_commission_fen)}`)
    return `<tr>
      <td data-label="层级"><span class="settings-level">${esc(String(row.relation_level))} 级</span></td>
      <td data-label="规则"><span class="settings-code">${esc(row.rule_code)}</span>${thresholds.length ? `<span class="settings-cell-note">${thresholds.map(esc).join(' · ')}</span>` : ''}</td>
      <td data-label="适用范围">${esc(distributionRuleScope(row))}</td>
      <td data-label="佣金比例" class="settings-num">${distributionPercent(row.rate_bp)}</td>
      <td data-label="状态"><span class="pill ${row.status === 'active' ? 'ok' : ''}">${row.status === 'active' ? '启用' : '停用'}</span></td>
      <td class="settings-row-actions"><button class="btn sm" type="button" data-config-rule="${row.id}">编辑</button></td>
    </tr>`
  }).join('')
  const methodRows = methods.map((row) => {
    const symbol = row.currency_symbol ?? row.currency_code ?? '¥'
    const feeParts = []
    if (Number(row.feeBp ?? 0) > 0) feeParts.push(`${(Number(row.feeBp) / 100).toFixed(2)}%`)
    if (Number(row.fixedFeeMinor ?? 0) > 0) feeParts.push(distributionYuan(row.fixedFeeMinor, symbol))
    const fields = (row.fields ?? []).map((field) => `<span class="settings-tag">${esc(field.label ?? field.key)}</span>`).join('')
    return `<tr>
      <td data-label="提现方式"><strong>${esc(row.name)}</strong><span class="settings-cell-note settings-code">${esc(row.code)}</span></td>
      <td data-label="币种">${esc(row.currency_name ?? row.currency_code)}</td>
      <td data-label="最低提现" class="settings-num">${distributionYuan(row.minAmountMinor, symbol)}</td>
      <td data-label="手续费" class="settings-num">${feeParts.length ? esc(feeParts.join(' + ')) : '免手续费'}</td>
      <td data-label="收款信息"><div class="settings-tags">${fields || '<span class="muted">未配置</span>'}</div></td>
      <td data-label="状态"><span class="pill ${row.enabled ? 'ok' : ''}">${row.enabled ? '启用' : '停用'}</span></td>
      <td class="settings-row-actions"><button class="btn sm" type="button" data-config-method="${esc(row.code)}">编辑</button></td>
    </tr>`
  }).join('')
  const currencyRows = currencies.map((row) => `<tr>
    <td data-label="币种"><strong>${esc(row.code)}</strong></td>
    <td data-label="名称">${esc(row.name)} <span class="muted">${esc(row.symbol)}</span></td>
    <td data-label="1 单位 = CNY" class="settings-num">${Number(row.rateToCny ?? row.rate_to_cny ?? 0).toFixed(4)}</td>
    <td data-label="用途"><div class="settings-tags">
      ${['CNY', 'USD'].includes(row.code) ? '<span class="settings-tag">账户余额</span>' : ''}
      ${row.isPayout ? '<span class="settings-tag">提现币种</span>' : ''}
    </div></td>
    <td data-label="状态"><span class="pill ${row.enabled ? 'ok' : ''}">${row.enabled ? '启用' : '停用'}</span></td>
    <td class="settings-row-actions"><button class="btn sm" type="button" data-config-currency="${esc(row.code)}">编辑</button></td>
  </tr>`).join('')

  view.innerHTML = `
    <div class="settings-ui settings-page">
      <div class="settings-intro">
        <p>统一管理分销层级、佣金规则、结算门槛和提现方式。金额按元展示，比例按百分比展示，保存后立即生效。</p>
        <span class="settings-status ${enabled ? 'is-active' : 'is-off'}">${enabled ? '分销运行中' : '分销已停用'}</span>
      </div>

      <section class="panel settings-section" aria-labelledby="distribution-basic-title">
        <div class="settings-section-head">
          <div>
            <h3 id="distribution-basic-title">基础规则</h3>
            <p>控制分销是否接单、可发展的层级，以及结算前需要满足的条件。</p>
          </div>
        </div>
        <div class="settings-form-grid">
          <label class="setting-field">
            <span>分销状态</span>
            <select class="input" id="cfg-status">
              <option value="active" ${enabled ? 'selected' : ''}>启用</option>
              <option value="disabled" ${!enabled ? 'selected' : ''}>停用</option>
            </select>
            <small>停用后不再产生新的邀请关系和佣金。</small>
          </label>
          <label class="setting-field">
            <span>启用级数</span>
            <select class="input" id="cfg-level">
              ${[1, 2, 3, 4, 5].map((level) => `<option value="${level}" ${Number(config.max_enabled_level ?? 3) === level ? 'selected' : ''}>${level} 级分销</option>`).join('')}
            </select>
            <small>只有前 N 级关系参与佣金计算。</small>
          </label>
          <label class="setting-field">
            <span>申请审核</span>
            <select class="input" id="cfg-auto">
              <option value="1" ${Number(config.auto_approve ?? 1) ? 'selected' : ''}>自动通过</option>
              <option value="0" ${Number(config.auto_approve ?? 1) ? '' : 'selected'}>人工审核</option>
            </select>
            <small>人工审核时，新推广员需要后台审核后才能生效。</small>
          </label>
          <label class="setting-field">
            <span>总佣金比例上限（%）</span>
            <input class="input" id="cfg-rate" type="number" min="0" max="100" step="0.01" value="${(maxTotalRateBp / 100).toFixed(2)}" />
            <small>所有启用层级的佣金比例合计不能超过该值。</small>
          </label>
          <label class="setting-field">
            <span>归因窗口（天）</span>
            <input class="input" id="cfg-attribution" type="number" min="1" max="365" step="1" value="${Number(config.attribution_window_days ?? 30)}" />
            <small>用户点击邀请链接后，在该窗口内注册可绑定关系。</small>
          </label>
          <label class="setting-field">
            <span>佣金冻结期（天）</span>
            <input class="input" id="cfg-freeze" type="number" min="1" max="365" step="1" value="${Number(config.freeze_days ?? 7)}" />
            <small>支付后的佣金先冻结，期满后才可申请结算。</small>
          </label>
          <label class="setting-field">
            <span>最低结算金额（元）</span>
            <input class="input" id="cfg-min" type="number" min="0.01" step="0.01" value="${(Number(config.min_settlement_fen ?? 10000) / 100).toFixed(2)}" />
            <small>低于该金额时暂不生成结算单。</small>
          </label>
        </div>
        <div class="settings-actions">
          <button class="btn primary" type="button" id="cfg-save">保存基础规则</button>
        </div>
      </section>

      <section class="panel settings-section" aria-labelledby="distribution-rules-title">
        <div class="settings-section-head">
          <div>
            <h3 id="distribution-rules-title">佣金规则</h3>
            <p>按关系层级设置佣金比例。规则修改只影响新产生的佣金，历史订单保留原快照。</p>
          </div>
          <button class="btn" type="button" id="cfg-add-rule">新增规则</button>
        </div>
        ${rules.length ? `<div class="settings-table-wrap"><table class="settings-table">
          <thead><tr><th>层级</th><th>规则</th><th>适用范围</th><th>佣金比例</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${ruleRows}</tbody>
        </table></div>` : '<div class="settings-empty"><strong>还没有佣金规则</strong><span>新增首条规则后，已支付订单才会按层级产生佣金。</span></div>'}
      </section>

      <section class="panel settings-section" aria-labelledby="distribution-methods-title">
        <div class="settings-section-head">
          <div>
            <h3 id="distribution-methods-title">提现方式</h3>
            <p>定义推广员可选择的收款方式、最低提现金额和手续费。收款信息使用结构化字段，不需要编辑 JSON。</p>
          </div>
          <button class="btn" type="button" id="cfg-add-method">新增提现方式</button>
        </div>
        ${methods.length ? `<div class="settings-table-wrap"><table class="settings-table">
          <thead><tr><th>提现方式</th><th>币种</th><th>最低提现</th><th>手续费</th><th>收款信息</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${methodRows}</tbody>
        </table></div>` : '<div class="settings-empty"><strong>还没有提现方式</strong><span>至少配置一种提现方式后，推广员才能申请提现。</span></div>'}
      </section>

      <section class="panel settings-section" aria-labelledby="distribution-currencies-title">
        <div class="settings-section-head">
          <div>
            <h3 id="distribution-currencies-title">币种与汇率</h3>
            <p>汇率用于把佣金折算为账户展示币种。修改汇率不会重算已经生成的佣金记录。</p>
          </div>
        </div>
        <div class="settings-table-wrap"><table class="settings-table">
          <thead><tr><th>币种</th><th>名称</th><th>1 单位 = CNY</th><th>用途</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${currencyRows}</tbody>
        </table></div>
      </section>
    </div>`

  $('#cfg-save')?.addEventListener('click', async () => {
    const button = $('#cfg-save')
    button.disabled = true
    button.textContent = '保存中…'
    try {
      await api('/admin/api/distribution/config', { method: 'POST', body: {
        maxEnabledLevel: Number($('#cfg-level').value), maxTotalRateBp: distributionPercentToBp($('#cfg-rate').value),
        freezeDays: Number($('#cfg-freeze').value), minSettlementFen: distributionYuanToFen($('#cfg-min').value),
        status: $('#cfg-status').value, autoApprove: $('#cfg-auto').value === '1',
        attributionWindowDays: Number($('#cfg-attribution').value),
      } })
      toast('分销配置已保存'); await pageDistributionConfig()
    } catch (error) {
      toast(error.message)
      button.disabled = false
      button.textContent = '保存基础规则'
    }
  })
  $('#cfg-add-rule')?.addEventListener('click', () => openRuleOverlay(null, { maxLevel, maxTotalRateBp }, () => pageDistributionConfig()))
  $('#cfg-add-method')?.addEventListener('click', () => openPayoutMethodOverlay(null, currencies, () => pageDistributionConfig()))
  for (const button of view.querySelectorAll('[data-config-rule]')) {
    button.addEventListener('click', () => {
      const rule = rules.find((row) => Number(row.id) === Number(button.dataset.configRule))
      if (rule) openRuleOverlay(rule, { maxLevel, maxTotalRateBp }, () => pageDistributionConfig())
    })
  }
  for (const button of view.querySelectorAll('[data-config-method]')) {
    button.addEventListener('click', () => {
      const method = methods.find((row) => row.code === button.dataset.configMethod)
      openPayoutMethodOverlay(method, currencies, () => pageDistributionConfig())
    })
  }
  for (const button of view.querySelectorAll('[data-config-currency]')) {
    button.addEventListener('click', () => {
      const currency = currencies.find((row) => row.code === button.dataset.configCurrency)
      openCurrencyOverlay(currency, () => pageDistributionConfig())
    })
  }
}

function openRuleOverlay(rule, { maxLevel = 3, maxTotalRateBp = 1800 } = {}, onSaved) {
  const editing = Boolean(rule)
  const levelOptions = Array.from({ length: Math.max(1, Math.min(5, maxLevel)) }, (_, index) => index + 1)
    .map((level) => `<option value="${level}" ${Number(rule?.relation_level ?? 1) === level ? 'selected' : ''}>${level} 级</option>`).join('')
  openOverlay(editing ? `编辑佣金规则 · ${rule.rule_code}` : '新增佣金规则', `
    <div class="settings-ui">
      <p class="settings-modal-copy">佣金比例按订单实付金额计算；所有启用规则的合计比例不能超过 ${distributionPercent(maxTotalRateBp)}。</p>
      <div class="settings-form-grid modal-settings-grid">
        <label class="setting-field">
          <span>规则编码</span>
          <input class="input" id="r-code" maxlength="32" placeholder="例如 GLOBAL_L1" value="${esc(rule?.rule_code ?? '')}" ${editing ? 'disabled' : ''} />
          <small>${editing ? '规则编码用于接口识别，保存后不可修改。' : '建议使用英文大写和下划线，例如 GLOBAL_L1。'}</small>
        </label>
        <label class="setting-field">
          <span>关系层级</span>
          <select class="input" id="r-level">${levelOptions}</select>
          <small>第 1 级为直接邀请人。</small>
        </label>
        <label class="setting-field">
          <span>佣金比例（%）</span>
          <input class="input" id="r-rate" type="number" min="0" max="100" step="0.01" value="${(Number(rule?.rate_bp ?? 1000) / 100).toFixed(2)}" />
          <small>例如填写 10 表示订单金额的 10%。</small>
        </label>
        <label class="setting-field">
          <span>适用范围</span>
          <select class="input" id="r-scope">
            <option value="global" ${(rule?.scope_type ?? 'global') === 'global' ? 'selected' : ''}>全部订单</option>
            <option value="content_type" ${rule?.scope_type === 'content_type' ? 'selected' : ''}>指定内容类型</option>
            <option value="plan" ${rule?.scope_type === 'plan' ? 'selected' : ''}>指定套餐</option>
            <option value="content" ${rule?.scope_type === 'content' ? 'selected' : ''}>指定内容</option>
          </select>
          <small>默认对所有订单生效。</small>
        </label>
        <label class="setting-field settings-span-2" id="r-scope-value-field">
          <span>范围值</span>
          <input class="input" id="r-value" placeholder="内容类型编码或套餐 ID" value="${esc(rule?.scope_value ?? '')}" />
          <small id="r-scope-help">选择“指定内容类型”后填写 movie、series 等编码。</small>
        </label>
        <label class="setting-field">
          <span>最低订单金额（元，可选）</span>
          <input class="input" id="r-min-order" type="number" min="0" step="0.01" value="${(Number(rule?.min_order_fen ?? 0) / 100).toFixed(2)}" />
          <small>订单金额低于该值时不计佣金，填写 0 表示不限制。</small>
        </label>
        <label class="setting-field">
          <span>单笔佣金上限（元，可选）</span>
          <input class="input" id="r-max-commission" type="number" min="0" step="0.01" value="${(Number(rule?.max_commission_fen ?? 0) / 100).toFixed(2)}" />
          <small>填写 0 表示不限制单笔佣金金额。</small>
        </label>
        <label class="setting-field">
          <span>规则状态</span>
          <select class="input" id="r-status">
            <option value="active" ${(rule?.status ?? 'active') === 'active' ? 'selected' : ''}>启用</option>
            <option value="disabled" ${rule?.status === 'disabled' ? 'selected' : ''}>停用</option>
          </select>
          <small>停用后不再参与新订单的佣金计算。</small>
        </label>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-cancel>取消</button><button class="btn primary" type="button" id="r-save">${editing ? '保存规则' : '创建规则'}</button></div>
    </div>`, (body, close) => {
    body.querySelector('[data-cancel]').addEventListener('click', close)
    const scope = body.querySelector('#r-scope')
    const scopeField = body.querySelector('#r-scope-value-field')
    const scopeHelp = body.querySelector('#r-scope-help')
    const scopeInput = body.querySelector('#r-value')
    const syncScope = () => {
      const value = scope.value
      scopeField.classList.toggle('hidden', value === 'global')
      if (value === 'content_type') {
        scopeHelp.textContent = '填写内容类型编码，例如 movie、series、comic_drama。'
        scopeInput.placeholder = 'movie'
      } else if (value === 'plan') {
        scopeHelp.textContent = '填写会员套餐 ID，例如 1。'
        scopeInput.placeholder = '1'
      } else if (value === 'content') {
        scopeHelp.textContent = '填写剧集 ID，例如 12。'
        scopeInput.placeholder = '12'
      }
    }
    scope.addEventListener('change', syncScope)
    syncScope()
    body.querySelector('#r-save').addEventListener('click', async () => {
      const button = body.querySelector('#r-save')
      const code = body.querySelector('#r-code').value.trim()
      const ratePercent = Number(body.querySelector('#r-rate').value)
      if (!code) return toast('请填写规则编码')
      if (!Number.isFinite(ratePercent) || ratePercent < 0 || ratePercent > 100) return toast('佣金比例应在 0 到 100 之间')
      if (scope.value !== 'global' && !scopeInput.value.trim()) return toast('请填写范围值')
      button.disabled = true
      button.textContent = '保存中…'
      try {
        await api('/admin/api/distribution/rules', { method: 'POST', body: {
          ruleCode: code, relationLevel: Number(body.querySelector('#r-level').value),
          rateBp: distributionPercentToBp(ratePercent), scopeType: scope.value,
          scopeValue: scope.value === 'global' ? null : scopeInput.value.trim(),
          minOrderFen: distributionYuanToFen(body.querySelector('#r-min-order').value),
          maxCommissionFen: distributionYuanToFen(body.querySelector('#r-max-commission').value),
          status: body.querySelector('#r-status').value,
        } })
        close(); toast('规则已保存'); await onSaved()
      } catch (error) {
        toast(error.message)
        button.disabled = false
        button.textContent = editing ? '保存规则' : '创建规则'
      }
    })
  })
}

function openPayoutMethodOverlay(method, currencies, onSaved) {
  const editing = Boolean(method)
  const methodKind = payoutMethodKind(method)
  const currencyOptions = currencies.map((row) => `<option value="${esc(row.code)}" ${row.code === method?.currency_code ? 'selected' : ''}>${esc(row.code)} · ${esc(row.name)}</option>`).join('')
  openOverlay(editing ? `编辑提现方式 · ${method.name}` : '新增提现方式', `
    <div class="settings-ui">
      <p class="settings-modal-copy">收款信息是推广员申请提现时需要填写的字段，后台只需选择收款类型；所有字段均为必填。</p>
      <div class="settings-form-grid modal-settings-grid">
        <label class="setting-field">
          <span>方式编码</span>
          <input class="input" id="pm-code" maxlength="32" placeholder="例如 cny_bank" value="${esc(method?.code ?? '')}" ${editing ? 'disabled' : ''} />
          <small>${editing ? '方式编码用于接口识别，保存后不可修改。' : '使用英文小写和下划线，例如 cny_bank。'}</small>
        </label>
        <label class="setting-field">
          <span>显示名称</span>
          <input class="input" id="pm-name" maxlength="40" placeholder="例如 人民币银行卡" value="${esc(method?.name ?? '')}" />
          <small>展示给推广员和后台审核人员。</small>
        </label>
        <label class="setting-field">
          <span>提现币种</span>
          <select class="input" id="pm-currency">${currencyOptions}</select>
          <small>该方式提交的金额和手续费均使用此币种。</small>
        </label>
        <label class="setting-field">
          <span>收款类型</span>
          <select class="input" id="pm-kind">
            <option value="bank_cn" ${methodKind === 'bank_cn' ? 'selected' : ''}>人民币银行卡</option>
            <option value="bank_intl" ${methodKind === 'bank_intl' ? 'selected' : ''}>国际银行账户</option>
            <option value="usdt_trc20" ${methodKind === 'usdt_trc20' ? 'selected' : ''}>USDT TRC20</option>
            <option value="custom" ${methodKind === 'custom' ? 'selected' : ''}>自定义字段</option>
          </select>
          <small>选择模板后会自动生成收款信息字段。</small>
        </label>
        <label class="setting-field">
          <span>最低提现金额</span>
          <input class="input" id="pm-min" type="number" min="0" step="0.01" value="${(Number(method?.minAmountMinor ?? 1000) / 100).toFixed(2)}" />
          <small>按所选币种填写，例如 USDT 10 表示 10 USDT。</small>
        </label>
        <label class="setting-field">
          <span>手续费比例（%）</span>
          <input class="input" id="pm-fee" type="number" min="0" max="100" step="0.01" value="${(Number(method?.feeBp ?? 0) / 100).toFixed(2)}" />
          <small>按提现金额收取，填写 0 表示不收比例手续费。</small>
        </label>
        <label class="setting-field">
          <span>固定手续费</span>
          <input class="input" id="pm-fixed" type="number" min="0" step="0.01" value="${(Number(method?.fixedFeeMinor ?? 0) / 100).toFixed(2)}" />
          <small>按所选币种填写，可与比例手续费同时使用。</small>
        </label>
        <label class="setting-field">
          <span>方式状态</span>
          <select class="input" id="pm-enabled">
            <option value="1" ${method?.enabled !== 0 ? 'selected' : ''}>启用</option>
            <option value="0" ${method?.enabled === 0 ? 'selected' : ''}>停用</option>
          </select>
          <small>停用后推广员无法选择该提现方式。</small>
        </label>
      </div>
      <section class="settings-subsection" aria-labelledby="pm-fields-title">
        <div class="settings-subsection-head">
          <div>
            <h4 id="pm-fields-title">收款信息</h4>
            <p>推广员提交提现时需要填写的字段。预置模板会直接生成，不再手动编辑 JSON。</p>
          </div>
          <button class="btn sm hidden" type="button" id="pm-add-field">添加字段</button>
        </div>
        <div class="payout-field-preview" id="pm-field-preview"></div>
        <div class="custom-field-list hidden" id="pm-custom-fields"></div>
      </section>
      <label class="setting-field">
        <span>提现说明</span>
        <textarea class="input" id="pm-instructions" rows="3" placeholder="例如：提交后由财务复核，1 至 3 个工作日打款。">${esc(method?.instructions ?? '')}</textarea>
        <small>展示在推广员提交提现的确认区域。</small>
      </label>
      <div class="modal-foot"><button class="btn" type="button" data-cancel>取消</button><button class="btn primary" type="button" id="pm-save">${editing ? '保存提现方式' : '创建提现方式'}</button></div>
    </div>`, (body, close) => {
    const kindSelect = body.querySelector('#pm-kind')
    const preview = body.querySelector('#pm-field-preview')
    const customList = body.querySelector('#pm-custom-fields')
    const addFieldButton = body.querySelector('#pm-add-field')
    const addCustomRow = (field = { key: '', label: '' }) => {
      const row = document.createElement('div')
      row.className = 'custom-field-row'
      row.innerHTML = `
        <label class="setting-field">
          <span>字段名称</span>
          <input class="input" data-field-label maxlength="30" placeholder="例如 开户行" value="${esc(field.label ?? '')}" />
        </label>
        <label class="setting-field">
          <span>字段标识（英文）</span>
          <input class="input" data-field-key maxlength="32" placeholder="例如 bankName" value="${esc(field.key ?? '')}" />
        </label>
        <button class="btn" type="button" data-remove-field>移除</button>`
      row.querySelector('[data-remove-field]').addEventListener('click', () => {
        row.remove()
        if (!customList.children.length) addCustomRow()
      })
      customList.appendChild(row)
    }
    let seededCustom = false
    const renderFields = () => {
      const kind = kindSelect.value
      const preset = DISTRIBUTION_FIELD_PRESETS[kind]
      const custom = kind === 'custom'
      preview.classList.toggle('hidden', custom)
      customList.classList.toggle('hidden', !custom)
      addFieldButton.classList.toggle('hidden', !custom)
      if (custom) {
        if (!seededCustom) {
          const initial = (method?.fields ?? []).filter((field) => field.key && field.label)
          if (initial.length) initial.forEach(addCustomRow)
          else addCustomRow()
          seededCustom = true
        }
        return
      }
      preview.innerHTML = (preset?.fields ?? []).map((field) => `
        <div class="payout-field-preview-item">
          <span>${esc(field.label)}</span>
          <small>${esc(preset.label)} · 必填</small>
        </div>`).join('')
    }
    kindSelect.addEventListener('change', renderFields)
    addFieldButton.addEventListener('click', () => addCustomRow())
    body.querySelector('#pm-currency').addEventListener('change', (event) => {
      if (kindSelect.value === 'custom') return
      const code = event.target.value
      kindSelect.value = code === 'USDT' ? 'usdt_trc20' : code === 'USD' ? 'bank_intl' : 'bank_cn'
      renderFields()
    })
    renderFields()
    body.querySelector('[data-cancel]').addEventListener('click', close)
    body.querySelector('#pm-save').addEventListener('click', async () => {
      const button = body.querySelector('#pm-save')
      const code = body.querySelector('#pm-code').value.trim()
      const name = body.querySelector('#pm-name').value.trim()
      if (!code || !name) return toast('请填写方式编码和显示名称')
      if (!editing && !/^[a-z][a-z0-9_]*$/.test(code)) return toast('方式编码只能使用小写字母、数字和下划线，并以字母开头')
      const kind = kindSelect.value
      let fields = payoutMethodFieldsForKind(kind)
      if (kind === 'custom') {
        fields = [...customList.querySelectorAll('.custom-field-row')].map((row) => ({
          label: row.querySelector('[data-field-label]').value.trim(),
          key: row.querySelector('[data-field-key]').value.trim(),
        }))
        if (!fields.length || fields.some((field) => !field.label || !field.key)) return toast('请完整填写自定义收款字段')
        if (fields.some((field) => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(field.key))) return toast('字段标识只能使用英文字母、数字和下划线，并以字母开头')
        if (new Set(fields.map((field) => field.key)).size !== fields.length) return toast('字段标识不能重复')
      }
      button.disabled = true
      button.textContent = '保存中…'
      try {
        await api('/admin/api/distribution/payout-methods', { method: 'POST', body: {
          code: method?.code ?? code,
          name,
          currency: body.querySelector('#pm-currency').value,
          minAmountMinor: distributionYuanToFen(body.querySelector('#pm-min').value),
          feeBp: distributionPercentToBp(body.querySelector('#pm-fee').value),
          fixedFeeMinor: distributionYuanToFen(body.querySelector('#pm-fixed').value),
          enabled: body.querySelector('#pm-enabled').value === '1',
          fields, instructions: body.querySelector('#pm-instructions').value.trim(),
        } })
        close(); toast('提现方式已保存'); await onSaved()
      } catch (error) {
        toast(error.message)
        button.disabled = false
        button.textContent = editing ? '保存提现方式' : '创建提现方式'
      }
    })
  })
}

function openCurrencyOverlay(currency, onSaved) {
  openOverlay(`币种配置 · ${currency.code}`, `
    <div class="settings-ui">
      <p class="settings-modal-copy">汇率表示 1 单位该币种可兑换多少人民币，用于佣金余额折算。已经生成的佣金不会因汇率修改而重算。</p>
      <div class="settings-form-grid modal-settings-grid">
        <label class="setting-field">
          <span>币种</span>
          <input class="input" value="${esc(currency.code)}" disabled />
          <small>币种编码不可修改。</small>
        </label>
        <label class="setting-field">
          <span>显示名称</span>
          <input class="input" id="cur-name" value="${esc(currency.name)}" />
          <small>展示在推广员佣金页和后台报表中。</small>
        </label>
        <label class="setting-field">
          <span>货币符号</span>
          <input class="input" id="cur-symbol" maxlength="4" value="${esc(currency.symbol)}" />
          <small>用于金额前缀，例如 ¥、$、₮。</small>
        </label>
        <label class="setting-field">
          <span>1 单位 = CNY</span>
          <input class="input" id="cur-rate" type="number" min="0.0001" step="0.0001" value="${Number(currency.rateToCny ?? currency.rate_to_cny ?? 1)}" ${currency.code === 'CNY' ? 'readonly' : ''} />
          <small>${currency.code === 'CNY' ? '人民币汇率固定为 1。' : '修改后仅影响后续展示和结算折算。'}</small>
        </label>
        <label class="setting-field">
          <span>币种状态</span>
          <select class="input" id="cur-enabled">
            <option value="1" ${currency.enabled ? 'selected' : ''}>启用</option>
            <option value="0" ${!currency.enabled ? 'selected' : ''}>停用</option>
          </select>
          <small>停用后该币种不再用于余额展示或提现。</small>
        </label>
        <label class="setting-check">
          <input type="checkbox" id="cur-payout" ${currency.isPayout ? 'checked' : ''} />
          <span>允许作为提现币种</span>
          <small>关闭后，推广员不能选择该币种提现。</small>
        </label>
      </div>
      <div class="modal-foot"><button class="btn" type="button" data-cancel>取消</button><button class="btn primary" type="button" id="cur-save">保存币种</button></div>
    </div>`, (body, close) => {
    body.querySelector('[data-cancel]').addEventListener('click', close)
    body.querySelector('#cur-save').addEventListener('click', async () => {
      const button = body.querySelector('#cur-save')
      const rate = Number(body.querySelector('#cur-rate').value)
      if (!(rate > 0)) return toast('汇率必须大于 0')
      button.disabled = true
      button.textContent = '保存中…'
      try {
        await api('/admin/api/distribution/currencies', { method: 'POST', body: {
          code: currency.code, name: body.querySelector('#cur-name').value,
          symbol: body.querySelector('#cur-symbol').value, rateToCny: rate,
          enabled: body.querySelector('#cur-enabled').value === '1',
          isPayout: body.querySelector('#cur-payout').checked,
        } })
        close(); toast('币种已保存'); await onSaved()
      } catch (error) {
        toast(error.message)
        button.disabled = false
        button.textContent = '保存币种'
      }
    })
  })
}

/* ---------------- 标签管理 ---------------- */
const TAG_LEVELS = [['all', '全部'], ['top', '一级标签'], ['child', '二级标签']]

async function pageTags() {
  const page = Number(listPages.tags ?? 1)
  const level = state.params.tagLevel ?? 'all'
  const keyword = (state.params.tagQ ?? '').trim()
  const showDisabled = state.params.tagDisabled ? '1' : ''
  const canWrite = new Set(state.me?.permissions ?? []).has('tag.write')
  const query = new URLSearchParams({ page: String(page), pageSize: '20', level, includeDisabled: '1' })
  if (keyword) query.set('keyword', keyword)
  if (showDisabled) query.set('includeDisabled', '1')
  const data = await api(`/admin/api/tags?${query.toString()}`)
  const byId = new Map((data.tree ?? []).map((node) => [node.id, node.name]))

  view.innerHTML = `
    <div class="panel">
      <h3>标签管理 <span class="muted">共 ${data.total ?? 0} 个</span></h3>
      <p class="muted">启停即时生效；二级标签可更换父级。</p>
      <div class="form-row">
        <div class="subtabs">${TAG_LEVELS.map(([key, label]) => `<button class="pill ${level === key ? 'active' : ''}" data-level="${key}">${label}</button>`).join('')}</div>
        <input id="tag-q" aria-label="搜索标签" placeholder="搜标签名" value="${esc(keyword)}" style="width:160px" />
        ${canWrite ? '<button class="btn primary" id="tag-add">＋ 新增标签</button>' : ''}
      </div>
      <table style="margin-top:12px">
        <thead><tr><th>名称</th><th>层级</th><th>父级</th><th>剧集数</th><th>排序</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${(data.list ?? []).map((tag) => `<tr class="${tag.parent_id ? 'tag-row child' : ''}">
            <td>${tag.parent_id ? '└ ' : ''}${esc(tag.name)}</td>
            <td>${tag.parent_id ? '<span class="pill">二级</span>' : '<span class="pill ok">一级</span>'}</td>
            <td>${tag.parent_id ? esc(byId.get(tag.parent_id) ?? `#${tag.parent_id}`) : '—'}</td>
            <td>${fmt(tag.dramaCount ?? 0)}</td>
            <td>${tag.sort}</td>
            <td>${canWrite ? `<button class="btn sm ${tag.status === 'active' ? '' : 'ghost'}" data-status="${tag.id}" data-active="${tag.status === 'active' ? 1 : 0}">
              ${tag.status === 'active' ? '<span class="tag-state-on">● 启用</span>' : '<span class="tag-state-off">○ 停用</span>'}
            </button>` : (tag.status === 'active' ? '<span class="tag-state-on">● 启用</span>' : '<span class="tag-state-off">○ 停用</span>')}</td>
            <td class="row-actions">
              ${canWrite ? `<button class="btn sm" data-edit="${tag.id}">编辑</button>
              <button class="btn sm danger" data-del="${tag.id}">删除</button>` : '<span class="muted">只读</span>'}
            </td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">没有匹配的标签</td></tr>'}
        </tbody>
      </table>
      ${pager('tags', page, data.pageSize, data.total, '个')}
    </div>`

  const reload = () => pageTags()
  view.querySelectorAll('[data-level]').forEach((button) => button.addEventListener('click', () => {
    state.params.tagLevel = button.dataset.level
    listPages.tags = 1
    reload()
  }))
  $('#tag-q')?.addEventListener('change', (event) => {
    state.params.tagQ = event.target.value
    listPages.tags = 1
    reload()
  })
  bindPager('tags', pageTags)
  view.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', async () => {
    const enabled = button.dataset.active !== '1'
    try {
      await api(`/admin/api/tags/${button.dataset.status}/status`, { method: 'POST', body: { enabled } })
      toast(enabled ? '已启用' : '已停用')
      reload()
    } catch (error) { toast(error.message) }
  }))

  const openEditor = (tag) => {
    openOverlay(tag ? `编辑标签 · ${tag.name}` : '新增标签', `
      <div class="field"><label>名称 *</label><input id="tg-name" value="${esc(tag?.name ?? '')}" /></div>
      <div class="grid-2">
        <div class="field"><label>父级标签（留空 = 一级）</label>
          <select id="tg-parent"><option value="">（一级标签）</option>
            ${(data.tree ?? []).filter((node) => !tag || node.id !== tag.id).map((node) => `<option value="${node.id}" ${tag?.parent_id === node.id ? 'selected' : ''}>${esc(node.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label>排序（小的在前）</label><input id="tg-sort" type="number" value="${tag?.sort ?? 100}" /></div>
      </div>
      <div class="field"><label>状态</label>
        <select id="tg-status">
          <option value="active" ${tag?.status !== 'disabled' ? 'selected' : ''}>启用</option>
          <option value="disabled" ${tag?.status === 'disabled' ? 'selected' : ''}>停用</option>
        </select></div>
      <div class="modal-foot"><button class="btn primary" id="tg-save">保存</button></div>
    `, (body, close) => {
      body.querySelector('#tg-save').addEventListener('click', async () => {
        const name = body.querySelector('#tg-name').value.trim()
        if (!name) return toast('请填标签名')
        const payload = {
          name,
          sort: Number(body.querySelector('#tg-sort').value || 100),
          status: body.querySelector('#tg-status').value,
          parentId: body.querySelector('#tg-parent').value ? Number(body.querySelector('#tg-parent').value) : null,
        }
        try {
          if (tag) await api('/admin/api/tags', { method: 'POST', body: { id: tag.id, ...payload } })
          else await api('/admin/api/tags', { method: 'POST', body: payload })
          toast('已保存')
          close()
          reload()
        } catch (error) { toast(error.message) }
      })
    })
  }

  $('#tag-add')?.addEventListener('click', () => openEditor(null))
  view.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
    const tag = (data.list ?? []).find((row) => String(row.id) === button.dataset.edit)
    openEditor(tag)
  }))
  view.querySelectorAll('[data-del]').forEach((button) => button.addEventListener('click', async () => {
    if (!(await askConfirm({ title: '删除标签', message: '删除标签会同时解除它与剧集的关联。', confirmText: '删除', danger: true }))) return
    try {
      await api(`/admin/api/tags?id=${button.dataset.del}`, { method: 'DELETE' })
      toast('已删除')
      reload()
    } catch (error) { toast(error.message) }
  }))
}

/* ---------------- 埋点数据 ---------------- */
async function pageEvents() {
  const days = Number(state.params.eventDays ?? 7)
  const type = state.params.eventType ?? ''
  const page = Number(listPages.events ?? 1)
  const query = new URLSearchParams({ days: String(days), page: String(page), pageSize: '20' })
  if (type) query.set('type', type)
  const data = await api(`/admin/api/events?${query.toString()}`)
  const EVENT_LABEL = {
    session_start: '访问开始', page_view: '页面浏览', impression: '内容曝光', detail_view: '详情页浏览',
    paywall_view: '付费墙展示', paywall_click: '付费墙点击', play_start: '开始播放', play_end: '播放结束',
    episode_click: '选集点击', favorite: '收藏', search: '搜索', share: '分享',
    category_filter: '分类筛选', rank_view: '榜单浏览', login_open: '打开登录', login_success: '登录成功',
    play_error: '播放失败', order_created: '创建订单', payment_success: '支付成功',
  }
  const eventTypes = (data.byType ?? []).length
  const avgPerDay = data.byDay?.length ? Math.round((data.total ?? 0) / data.byDay.length) : 0

  view.innerHTML = `
    <div class="panel">
      <h3>埋点数据 <span class="muted">近 ${days} 天 · 共 ${fmt(data.total ?? 0)} 条 · 独立访客 ${fmt(data.visitors ?? 0)}</span></h3>
      <div class="cards">
        ${card('事件总数', fmt(data.total ?? 0), '条')}
        ${card('独立访客', fmt(data.visitors ?? 0), '人')}
        ${card('事件类型', fmt(eventTypes), '种')}
        ${card('日均事件', fmt(avgPerDay), '条/日')}
      </div>
      ${svgLineChart(data.byDay ?? [], [{ key: 'n', label: '事件数', color: CHART_COLORS[0] }], { height: 180 })}
      <div class="form-row">
        <div class="subtabs">${[1, 7, 30].map((n) => `<button class="pill ${days === n ? 'active' : ''}" data-days="${n}">${n} 天</button>`).join('')}</div>
        <select id="ev-type" aria-label="事件类型" style="width:160px">
          <option value="">全部事件</option>
          ${(data.byType ?? []).map((row) => `<option value="${esc(row.type)}" ${type === row.type ? 'selected' : ''}>${esc(EVENT_LABEL[row.type] ?? row.type)}（${row.n}）</option>`).join('')}
        </select>
      </div>
      <table style="margin-top:12px">
        <thead><tr><th>时间</th><th>事件</th><th>用户</th><th>访客</th><th>剧集</th><th>路径</th><th>数值</th><th>明细</th></tr></thead>
        <tbody>
          ${(data.list ?? []).map((row) => `<tr>
            <td class="muted">${esc(fmtTs(row.created_at))}</td>
            <td>${esc(EVENT_LABEL[row.type] ?? row.type)}</td>
            <td>${row.userEmail ? esc(row.userEmail) : (row.user_id ? `#${row.user_id}` : '游客')}</td>
            <td class="mono muted truncate" style="max-width:130px" title="${esc(row.visitor_id ?? '')}">${esc(row.visitor_id ?? '—')}</td>
            <td>${row.dramaTitle ? esc(row.dramaTitle) : (row.drama_id ? `#${row.drama_id}` : '—')}</td>
            <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(row.path ?? '—')}</td>
            <td>${row.value === null || row.value === undefined ? '—' : Number(row.value).toFixed(2)}</td>
            <td class="muted">${esc(row.meta ? JSON.stringify(row.meta) : '—')}</td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">还没有埋点数据：C 端产生浏览/播放后这里会实时出现</td></tr>'}
        </tbody>
      </table>
      ${pager('events', page, data.pageSize, data.total, '条')}
      <h3 style="margin-top:18px">事件分布</h3>
      <table><thead><tr><th>事件</th><th>次数</th></tr></thead><tbody>
        ${(data.byType ?? []).map((row) => `<tr><td>${esc(EVENT_LABEL[row.type] ?? row.type)}</td><td>${fmt(row.n)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">—</td></tr>'}
      </tbody></table>
    </div>`

  view.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => {
    state.params.eventDays = Number(button.dataset.days)
    listPages.events = 1
    pageEvents()
  }))
  $('#ev-type')?.addEventListener('change', (event) => {
    state.params.eventType = event.target.value
    listPages.events = 1
    pageEvents()
  })
  bindPager('events', pageEvents)
}

/* ---------------- 用户管理（B 端后台账号，可增删改 + 分配角色） ---------------- */
const ADMIN_STATUS_LABEL = { active: '正常', disabled: '已停用' }

/** 保存后刷新 /me：菜单可能被改，侧栏要跟着变。 */
async function refreshSession() {
  try {
    state.me = await api('/admin/api/me')
    renderNav()
  } catch { /* 会话失效时由 api() 统一处理 */ }
}

function roleChecks(roles, checked, name = 'roles') {
  return `<div class="check-list">${roles.map((role) => `
    <label class="check-item">
      <input type="checkbox" name="${name}" value="${esc(role.code)}" ${checked.includes(role.code) ? 'checked' : ''} />
      <span class="check-copy"><strong>${esc(role.name)}</strong><small class="muted">${esc(role.description ?? '')}</small></span>
    </label>`).join('')}</div>`
}

async function pageAdmins() {
  const [data, rolesData] = await Promise.all([api('/admin/api/admins'), api('/admin/api/roles').catch(() => ({ roles: [] }))])
  const roles = rolesData.roles ?? []
  const allAdmins = data.list ?? []
  const canWrite = new Set(state.me?.permissions ?? []).has('admin.write')
  const adminPage = clientPage('admins', allAdmins, 20)
  const list = adminPage.items
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>用户管理 <span class="muted">B 端 ${allAdmins.length} 个 · C 端用户 ${fmt(data.users ?? 0)} 人</span></h3>
        ${canWrite ? '<button class="btn primary" id="admin-new">＋ 新建用户</button>' : ''}
      </div>
      <p class="muted">后台登录账号；角色决定权限。</p>
      <table>
        <thead><tr><th>序号</th><th>账号</th><th>显示名</th><th>角色</th><th>状态</th><th>口令</th><th>最近操作</th><th style="width:230px">操作</th></tr></thead>
        <tbody>
          ${list.map((admin) => `<tr data-admin="${admin.id}">
            <td>${admin.id}</td>
            <td><strong>${esc(admin.username)}</strong></td>
            <td>${esc(admin.display_name ?? '—')}</td>
            <td>${(admin.roles ?? []).map((role) => `<span class="pill">${esc(role.name)}</span>`).join(' ') || '<span class="pill warn">未分配</span>'}</td>
            <td>${admin.status === 'active' ? '<span class="pill ok">正常</span>' : `<span class="pill warn">${esc(ADMIN_STATUS_LABEL[admin.status] ?? admin.status)}</span>`}</td>
            <td>${admin.mustChangePassword ? '<span class="pill warn">待首次修改</span>' : '<span class="muted">已修改</span>'}</td>
            <td class="muted small">${esc(fmtTs(admin.lastAuditAt))}</td>
            <td class="row-actions">${canWrite ? `
              <button class="btn sm" data-edit="${admin.id}">编辑</button>
              <button class="btn sm" data-roles="${admin.id}">分配角色</button>
              <button class="btn sm" data-pass="${admin.id}">重置口令</button>
              <button class="btn sm" data-toggle-status="${admin.id}" data-status="${admin.status}">${admin.status === 'active' ? '停用' : '启用'}</button>
              <button class="btn sm danger" data-del-admin="${admin.id}">删除</button>` : '<span class="muted">只读</span>'}
            </td>
          </tr>`).join('') || '<tr><td colspan="8" class="muted">还没有后台账号，点右上角新建</td></tr>'}
        </tbody>
      </table>
      ${pager('admins', adminPage.page, adminPage.pageSize, adminPage.total, '个')}
      <p class="muted small" style="margin-top:10px">口令策略：8 位以上，同时含字母与数字，不能包含账号名、不能是常见弱口令、至少 4 种不同字符；新建与重置账号默认要求首次登录改密。</p>
    </div>`

  const byId = (id) => allAdmins.find((item) => item.id === Number(id))

  $('#admin-new')?.addEventListener('click', () => openAdminForm(roles))
  view.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => openAdminForm(roles, byId(button.dataset.edit))))
  view.querySelectorAll('[data-roles]').forEach((button) => button.addEventListener('click', () => openRoleAssign(roles, byId(button.dataset.roles))))
  view.querySelectorAll('[data-pass]').forEach((button) => button.addEventListener('click', () => openPasswordReset(byId(button.dataset.pass))))
  view.querySelectorAll('[data-toggle-status]').forEach((button) => button.addEventListener('click', async () => {
    const admin = byId(button.dataset.toggleStatus)
    const next = admin.status === 'active' ? 'disabled' : 'active'
    if (next === 'disabled' && !(await askConfirm({
      title: '停用后台账号',
      message: `停用 ${admin.username}？停用后该账号立刻无法登录后台，已登录会话会被吊销。`,
      confirmText: '停用',
      danger: true,
    }))) return
    try {
      await api(`/admin/api/admins/${admin.id}`, { method: 'PUT', body: { status: next } })
      toast(next === 'active' ? '已启用' : '已停用，会话已吊销')
      await pageAdmins()
    } catch (error) { toast(error.message) }
  }))
  view.querySelectorAll('[data-del-admin]').forEach((button) => button.addEventListener('click', async () => {
    const admin = byId(button.dataset.delAdmin)
    if (!(await askConfirm({
      title: '删除后台账号',
      message: `删除 ${admin.username}？该账号的角色绑定会一并删除，操作不可撤销；如需保留请改用「停用」。`,
      confirmText: '删除',
      danger: true,
    }))) return
    try {
      await api(`/admin/api/admins/${admin.id}`, { method: 'DELETE' })
      toast('已删除')
      await pageAdmins()
    } catch (error) { toast(error.message) }
  }))
  bindPager('admins', pageAdmins)
}

function openAdminForm(roles, existing) {
  const isEdit = Boolean(existing)
  const checked = (existing?.roles ?? []).map((role) => role.code)
  openOverlay(isEdit ? `编辑账号 ${existing.username}` : '新建后台账号', `
    <div class="grid-2">
      <label>登录账号<input id="af-username" value="${esc(existing?.username ?? '')}" ${isEdit ? 'disabled' : ''} placeholder="如 ops02" /></label>
      <label>显示名<input id="af-name" value="${esc(existing?.display_name ?? '')}" placeholder="如 内容运营-小李" /></label>
    </div>
    ${isEdit ? '' : `<label style="display:block;margin-top:10px">初始口令<input id="af-pass" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字" /></label>
      <p class="muted small">创建后口令只在此处显示一次；账号首次登录会被要求改密。</p>`}
    <div style="margin-top:12px"><div class="muted small" style="margin-bottom:6px">角色（至少一个）</div>${roleChecks(roles, checked)}</div>
  `, (body) => {
    body.querySelector('#af-save')?.remove()
    const foot = document.createElement('div')
    foot.className = 'modal-foot'
    foot.innerHTML = `<button class="btn" data-cancel>取消</button><button class="btn primary" id="af-save">${isEdit ? '保存' : '创建账号'}</button>`
    body.appendChild(foot)
    foot.querySelector('[data-cancel]').addEventListener('click', () => body.closest('.modal-mask').remove())
    foot.querySelector('#af-save').addEventListener('click', async () => {
      const payload = {
        displayName: body.querySelector('#af-name').value.trim(),
        roles: [...body.querySelectorAll('input[name="roles"]:checked')].map((input) => input.value),
      }
      if (!payload.roles.length) return toast('请至少选择一个角色')
      if (!isEdit) {
        payload.username = body.querySelector('#af-username').value.trim()
        payload.password = body.querySelector('#af-pass').value
      }
      try {
        if (isEdit) await api(`/admin/api/admins/${existing.id}`, { method: 'PUT', body: payload })
        else await api('/admin/api/admins', { method: 'POST', body: payload })
        body.closest('.modal-mask').remove()
        toast(isEdit ? '已保存' : '账号已创建')
        await pageAdmins()
      } catch (error) { toast(error.message) }
    })
  })
}

function openRoleAssign(roles, admin) {
  const checked = (admin.roles ?? []).map((role) => role.code)
  openOverlay(`分配角色 · ${admin.username}`, `
    <p class="muted small">勾选后立即生效；该账号刷新页面即可看到新菜单。</p>
    ${roleChecks(roles, checked)}
  `, (body) => {
    const foot = document.createElement('div')
    foot.className = 'modal-foot'
    foot.innerHTML = '<button class="btn" data-cancel>取消</button><button class="btn primary" id="role-save">保存角色</button>'
    body.appendChild(foot)
    foot.querySelector('[data-cancel]').addEventListener('click', () => body.closest('.modal-mask').remove())
    foot.querySelector('#role-save').addEventListener('click', async () => {
      const codes = [...body.querySelectorAll('input[name="roles"]:checked')].map((input) => input.value)
      if (!codes.length) return toast('至少保留一个角色')
      try {
        await api(`/admin/api/admins/${admin.id}`, { method: 'PUT', body: { roles: codes } })
        body.closest('.modal-mask').remove()
        toast('角色已更新')
        await pageAdmins()
      } catch (error) { toast(error.message) }
    })
  })
}

function openPasswordReset(admin) {
  openOverlay(`重置口令 · ${admin.username}`, `
    <label style="display:block">新口令<input id="pr-pass" type="password" autocomplete="new-password" placeholder="至少 8 位，含字母与数字" /></label>
    <label class="check-item" style="margin-top:10px"><input type="checkbox" id="pr-must" checked /><span>要求下次登录修改</span></label>
    <p class="muted small">保存后该账号已登录的会话全部失效。</p>
  `, (body) => {
    const foot = document.createElement('div')
    foot.className = 'modal-foot'
    foot.innerHTML = '<button class="btn" data-cancel>取消</button><button class="btn primary" id="pr-save">重置</button>'
    body.appendChild(foot)
    foot.querySelector('[data-cancel]').addEventListener('click', () => body.closest('.modal-mask').remove())
    foot.querySelector('#pr-save').addEventListener('click', async () => {
      try {
        const result = await api(`/admin/api/admins/${admin.id}/password`, {
          method: 'POST',
          body: { password: body.querySelector('#pr-pass').value, mustChange: body.querySelector('#pr-must').checked },
        })
        body.closest('.modal-mask').remove()
        toast(`口令已重置${result.revokedSessions ? `，吊销 ${result.revokedSessions} 个会话` : ''}`)
        await pageAdmins()
      } catch (error) { toast(error.message) }
    })
  })
}

/* ---------------- 后台菜单（与角色权限独立） ---------------- */
async function pageMenus() {
  const data = await api('/admin/api/admin-menus')
  const groups = data.groups ?? []
  const permOptions = (data.permissions ?? []).filter((item) => item.type === 'menu' || item.type === 'button')
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <h3>后台菜单 <span class="muted">${groups.length} 个分组 · ${groups.reduce((n, g) => n + g.items.length, 0)} 个菜单</span></h3>
        <div class="row-actions">
          <button class="btn" id="menu-reset">恢复出厂菜单</button>
          <button class="btn primary" id="menu-new">＋ 新增菜单</button>
        </div>
      </div>
      <p class="muted">菜单结构不影响角色权限。</p>
      <div class="menu-tree">
        ${groups.map((group) => `
          <details class="menu-tree-group" open>
            <summary>
              <span class="menu-tree-caret" aria-hidden="true">${navChevron(false)}</span>
              <strong>${esc(group.label)}</strong>
              <span class="muted small">${esc(group.key)} · ${group.items.length} 项 · 排序 ${group.sort}</span>
              <span class="spacer"></span>
              <button class="btn sm" data-group-edit="${esc(group.key)}">编辑分组</button>
              <button class="btn sm" data-group-add="${esc(group.key)}">＋ 子菜单</button>
            </summary>
            <div class="menu-tree-children">
              ${group.items.map((item) => `<div class="menu-tree-item">
                <span class="menu-tree-branch">└</span>
                <span class="menu-tree-name">${esc(item.label)}${item.isSystem ? ' <span class="pill">内置</span>' : ''}</span>
                <code>${esc(item.route)}</code>
                <span class="muted small">${item.permCode ? esc(item.permCode) : '登录可见'}</span>
                <span class="muted small">排序 ${item.sort}</span>
                <span class="pill ${item.visible ? 'ok' : 'warn'}">${item.visible ? '显示' : '隐藏'}</span>
                <span class="row-actions">
                  <button class="btn sm" data-menu-edit="${item.id}">编辑</button>
                  <button class="btn sm" data-menu-visible="${item.id}">${item.visible ? '隐藏' : '显示'}</button>
                  <button class="btn sm danger" data-menu-del="${item.id}" ${item.isSystem ? 'disabled' : ''}>删除</button>
                </span>
              </div>`).join('')}
            </div>
          </details>`).join('')}
      </div>
    </div>`

  const flat = groups.flatMap((group) => group.items.map((item) => ({ ...item, groupKey: group.key, groupLabel: group.label, groupSort: group.sort })))
  const findItem = (id) => flat.find((item) => item.id === Number(id))
  const findGroup = (key) => groups.find((group) => group.key === key)
  const openForm = (item, group) => openMenuForm({ groups, permOptions, item, group })
  $('#menu-new').addEventListener('click', () => openForm(null))
  view.querySelectorAll('[data-group-add]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openForm(null, findGroup(button.dataset.groupAdd))
  }))
  view.querySelectorAll('[data-group-edit]').forEach((button) => button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    openMenuGroupForm(findGroup(button.dataset.groupEdit))
  }))
  view.querySelectorAll('[data-menu-edit]').forEach((button) => button.addEventListener('click', () => openForm(findItem(button.dataset.menuEdit))))
  view.querySelectorAll('[data-menu-visible]').forEach((button) => button.addEventListener('click', async () => {
    const item = findItem(button.dataset.menuVisible)
    try {
      await api(`/admin/api/admin-menus/${item.id}`, {
        method: 'PUT',
        body: { groupKey: item.groupKey, groupLabel: item.groupLabel, groupSort: item.groupSort, label: item.label, route: item.route, icon: item.icon, permCode: item.permCode, sort: item.sort, visible: !item.visible },
      })
      toast(item.visible ? '已隐藏（刷新后侧栏不再显示）' : '已显示')
      await refreshSession()
      await pageMenus()
    } catch (error) { toast(error.message) }
  }))
  view.querySelectorAll('[data-menu-del]').forEach((button) => button.addEventListener('click', async () => {
    const item = findItem(button.dataset.menuDel)
    if (!(await askConfirm({
      title: '删除菜单入口',
      message: `删除菜单「${item.label}」？只删侧栏入口，不影响权限与页面本身。`,
      confirmText: '删除',
      danger: true,
    }))) return
    try {
      await api(`/admin/api/admin-menus/${item.id}`, { method: 'DELETE' })
      toast('已删除')
      await refreshSession()
      await pageMenus()
    } catch (error) { toast(error.message) }
  }))
  $('#menu-reset').addEventListener('click', async () => {
    if (!(await askConfirm({
      title: '恢复出厂菜单',
      message: '自行新增或修改的菜单都会被清除。',
      confirmText: '恢复出厂',
      danger: true,
    }))) return
    try {
      await api('/admin/api/admin-menus/reset', { method: 'POST', body: {} })
      toast('已恢复出厂菜单')
      await refreshSession()
      await pageMenus()
    } catch (error) { toast(error.message) }
  })
}

function openMenuGroupForm(group) {
  if (!group) return
  openOverlay(`编辑分组 · ${group.label}`, `
    <div class="grid-2">
      <label>分组名称<input id="mg-label" value="${esc(group.label)}" /></label>
      <label>分组键<input id="mg-key" value="${esc(group.key)}" /></label>
      <label>分组排序<input id="mg-sort" type="number" value="${group.sort}" /></label>
    </div>`, (body, close) => {
    const foot = document.createElement('div')
    foot.className = 'modal-foot'
    foot.innerHTML = '<button class="btn" data-cancel>取消</button><button class="btn primary" id="mg-save">保存</button>'
    body.appendChild(foot)
    foot.querySelector('[data-cancel]').addEventListener('click', close)
    foot.querySelector('#mg-save').addEventListener('click', async () => {
      try {
        await api(`/admin/api/admin-menu-groups/${encodeURIComponent(group.key)}`, {
          method: 'PUT',
          body: {
            groupKey: body.querySelector('#mg-key').value.trim(),
            groupLabel: body.querySelector('#mg-label').value.trim(),
            groupSort: Number(body.querySelector('#mg-sort').value || 0),
          },
        })
        close()
        await refreshSession()
        await pageMenus()
      } catch (error) { toast(error.message) }
    })
  })
}

function openMenuForm({ groups, permOptions, item, group }) {
  const groupKeys = [...new Set(groups.map((group) => group.key))]
  openOverlay(item ? `编辑菜单 · ${item.label}` : '新增菜单', `
    <div class="grid-2">
      <label>菜单名称<input id="mf-label" value="${esc(item?.label ?? '')}" placeholder="如 内容审核" /></label>
      <label>路由<input id="mf-route" value="${esc(item?.route ?? '/')}" placeholder="/review" /></label>
      <label>所属分组（键）<input id="mf-group-key" value="${esc(item?.groupKey ?? group?.key ?? '')}" list="mf-groups" placeholder="system" /></label>
      <label>分组名称<input id="mf-group-label" value="${esc(item?.groupLabel ?? group?.label ?? '')}" placeholder="系统设置" /></label>
      <label>分组排序<input id="mf-group-sort" type="number" value="${item?.groupSort ?? group?.sort ?? 90}" /></label>
      <label>菜单内排序<input id="mf-sort" type="number" value="${item?.sort ?? 10}" /></label>
      <label>所需权限<select id="mf-perm">
        <option value="">登录即可见</option>
        ${permOptions.map((perm) => `<option value="${esc(perm.code)}" ${item?.permCode === perm.code ? 'selected' : ''}>${esc(perm.code)} · ${esc(perm.name)}</option>`).join('')}
      </select></label>
    </div>
    <datalist id="mf-groups">${groupKeys.map((key) => `<option value="${esc(key)}"></option>`).join('')}</datalist>
    <p class="muted small">侧栏菜单只显示文字，不显示图标。</p>
    <label class="check-item" style="margin-top:10px"><input type="checkbox" id="mf-visible" ${item?.visible === false ? '' : 'checked'} /><span>在侧栏显示</span></label>
  `, (body) => {
    const foot = document.createElement('div')
    foot.className = 'modal-foot'
    foot.innerHTML = '<button class="btn" data-cancel>取消</button><button class="btn primary" id="mf-save">保存</button>'
    body.appendChild(foot)
    foot.querySelector('[data-cancel]').addEventListener('click', () => body.closest('.modal-mask').remove())
    foot.querySelector('#mf-save').addEventListener('click', async () => {
      const payload = {
        label: body.querySelector('#mf-label').value.trim(),
        route: body.querySelector('#mf-route').value.trim(),
        groupKey: body.querySelector('#mf-group-key').value.trim(),
        groupLabel: body.querySelector('#mf-group-label').value.trim(),
        groupSort: Number(body.querySelector('#mf-group-sort').value) || 0,
        sort: Number(body.querySelector('#mf-sort').value) || 0,
        icon: item?.icon ?? '',
        permCode: body.querySelector('#mf-perm').value,
        visible: body.querySelector('#mf-visible').checked,
      }
      try {
        if (item) await api(`/admin/api/admin-menus/${item.id}`, { method: 'PUT', body: payload })
        else await api('/admin/api/admin-menus', { method: 'POST', body: payload })
        body.closest('.modal-mask').remove()
        toast('已保存')
        await refreshSession()
        await pageMenus()
      } catch (error) { toast(error.message) }
    })
  })
}
/* 启动 */
if (state.token) await boot()

