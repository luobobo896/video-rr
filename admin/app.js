/** 影巢运营后台（原生 ESM，无构建）。 */
const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const nav = $('#nav')

/* 菜单分组：后台按「看 / 内容 / 交易 / 用户 / 系统」分区，默认折叠非当前区，避免 18 项平铺。 */
const NAV_GROUPS = [
  {
    id: 'overview', title: '数据概览',
    items: [
      ['dashboard', '概览', 'dashboard.read'],
      ['analytics', '经营数据', 'analytics.read'],
      ['events', '埋点数据', 'ops.events.read'],
    ],
  },
  {
    id: 'content', title: '内容运营',
    items: [
      ['dramas', '剧集管理', 'content.drama.read'],
      ['policies', '付费策略', 'content.drama.read'],
      ['tags', '标签管理', 'tag.read'],
      ['ops', '首页运营', 'ops.banner.write'],
      ['ranks', '榜单', 'ops.rank.write'],
      ['review', '内容审核', 'content.review'],
    ],
  },
  {
    id: 'commerce', title: '交易与财务',
    items: [
      ['plans', '套餐定价', 'commerce.plan.write'],
      ['coupons', '优惠券', 'commerce.coupon.write'],
      ['orders', '订单', 'finance.order.read'],
      ['refunds', '退款审核', 'finance.refund.create'],
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
      ['roles', '角色权限', 'admin.read'],
      ['admins', '管理员账号', 'system.admin'],
      ['audit', '审计日志', 'audit.read'],
      ['pay', '支付渠道', 'payment.channel.read'],
      ['email', '邮件设置', 'email.read'],
    ],
  },
]

/** 扁平索引：路由与标题查表用，保持与原 NAV 数组同构 [key, label, perm]。 */
const NAV = NAV_GROUPS.flatMap((group) => group.items)

const state = { token: localStorage.getItem('mh-admin-token') ?? '', page: 'dashboard', params: {}, timers: [] }

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : n ?? '—')

function toast(text) {
  const node = $('#toast')
  node.textContent = text
  node.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => node.classList.add('hidden'), 2000)
}

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  if (options.body !== undefined && !(options.body instanceof Blob)) headers['content-type'] = 'application/json'
  const url = BASE ? path.replace('/admin/api', BASE + '/api') : path
  let res
  try {
    res = await fetch(url, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : (options.body instanceof Blob ? options.body : JSON.stringify(options.body)),
    })
  } catch {
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
}

function clearTimers() {
  for (const timer of state.timers) clearInterval(timer)
  state.timers = []
}

/** 轻量弹层：后台没有引入组件库，用一层 mask 包住表单/向导。 */
function openOverlay(title, bodyHtml, onMount) {
  const mask = document.createElement('div')
  mask.className = 'modal-mask'
  mask.innerHTML = `<div class="modal-box">
    <header><h3>${esc(title)}</h3><button class="btn sm" data-close>关闭</button></header>
    <div class="modal-body">${bodyHtml}</div>
  </div>`
  document.body.appendChild(mask)
  const close = () => mask.remove()
  mask.querySelector('[data-close]').addEventListener('click', close)
  mask.addEventListener('click', (event) => { if (event.target === mask) close() })
  onMount?.(mask.querySelector('.modal-body'), close)
  return close
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
function logout() {
  state.token = ''
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
  const activeGroup = NAV_GROUPS.find((group) => group.items.some(([key]) => key === state.page))
  if (activeGroup) open.add(activeGroup.id)
  nav.innerHTML = NAV_GROUPS
    .map((group) => {
      const items = group.items.filter(([, , perm]) => perms.has(perm))
      if (!items.length) return ''
      const expanded = open.has(group.id)
      return `<div class="nav-group ${expanded ? 'open' : 'collapsed'}" data-group="${group.id}">
        <button class="nav-group-head" data-toggle="${group.id}" aria-expanded="${expanded}">
          <span>${esc(group.title)}</span><span class="chev">${expanded ? '▾' : '▸'}</span>
        </button>
        <div class="nav-group-body">
          ${items.map(([key, label]) => `<a class="nav-item ${state.page === key ? 'active' : ''}" href="#/${key}">${esc(label)}</a>`).join('')}
        </div>
      </div>`
    }).join('')
  nav.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.toggle
      const next = readOpenGroups()
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(NAV_OPEN_KEY, JSON.stringify([...next]))
      renderNav()
    })
  })
  const who = $('#whoami')
  if (who) who.textContent = state.me ? `${state.me.admin.displayName ?? state.me.admin.username} · ${(state.me.roles ?? []).map((role) => role.name).join(' / ')}` : ''
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

async function route() {
  clearTimers()
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard'
  state.page = hash.split('?')[0].split('/')[0]
  const navItem = NAV.find(([id]) => id === state.page)
  const key = navItem ? state.page : 'dashboard'
  const perm = (NAV.find(([id]) => id === key) ?? [])[2]
  const perms = new Set(state.me?.permissions ?? [])
  $('#page-title').textContent = NAV.find(([id]) => id === key)[1]
  renderNav()
  // 页面级权限守卫：菜单已经按权限隐藏，手改 hash 时也不发请求、不渲染空表
  if (perm && !perms.has(perm)) {
    view.innerHTML = `<div class="card empty-card"><h3>无权限访问</h3>
      <p>当前账号缺少 <code>${esc(perm)}</code> 权限，请联系超级管理员分配角色。</p>
      <a class="btn sm" href="#/dashboard">返回数据概览</a></div>`
    return
  }
  try {
    if (key === 'dashboard') await pageDashboard()
    else if (key === 'dramas') await pageDramas()
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
    else if (key === 'admins') await pageAdmins()
  } catch (error) {
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
  }
}

/* ---------------- 概览 ---------------- */
async function pageDashboard() {
  const stats = await api('/admin/api/stats')
  const queue = stats.queue ?? { pending: 0, running: false, pendingItems: [] }
  const cats = stats.categories ?? []
  $('#top-right').innerHTML = `<span class="muted">更新于 ${new Date().toLocaleTimeString('zh-CN')}</span>
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
        <h3>内容结构</h3>
        ${cats.length ? `<table><thead><tr><th>类型</th><th>数量</th></tr></thead><tbody>
          ${cats.map((row) => `<tr><td>${esc(row.label)}</td><td>${fmt(row.n)} 部</td></tr>`).join('')}
        </tbody></table>` : '<div class="muted">还没有剧集：去「内容运营 → 剧集管理 → 新建剧集」，填标题后会自动搜刮元数据。</div>'}
        <p class="muted" style="margin-top:10px">
          发信通道：${stats.mailReady ? '<span class="pill ok">已配置</span>' : '<span class="pill warn">未配置（C 端无法自助收验证码）</span>'}
          <a href="#/email">去配置 →</a>
        </p>
      </div>
      <div class="panel">
        <h3>转码队列</h3>
        ${queue.pending === 0 && !queue.running ? '<div class="muted">队列空闲：去「剧集管理 → 分集」上传视频或生成示例视频</div>' : `
          <table><thead><tr><th>分集</th><th>状态</th><th>进度</th></tr></thead><tbody>
            ${queue.current ? `<tr><td>EP ${queue.current.episodeId}</td><td><span class="pill warn">转码中</span></td><td>${esc(queue.current.source ?? '')}</td></tr>` : ''}
            ${(queue.pendingItems ?? []).map((item) => `<tr><td>EP ${item.episodeId}</td><td><span class="pill">排队</span></td><td class="muted">第 ${item.no} 集</td></tr>`).join('')}
          </tbody></table>`}
      </div>
    </div>`
}

const card = (key, value, unit) => `<div class="card"><div class="k">${esc(key)}</div><div class="v">${value} <small>${esc(unit)}</small></div></div>`

/* ---------------- 剧集 ---------------- */
const CATEGORY_LABEL = { MOVIE: '电影', TV: '电视剧', PLAYLET: '短剧/漫剧', ANIME: '动漫', VARIETY: '综艺', DOCUMENTARY: '纪录片' }
const ACCESS_LABEL = { free: '免费', subscription: '会员免费', paid: '单独收费' }
const MISSING_LABEL = { title: '标题', category: '类型', coverUrl: '封面', year: '年份', area: '地区', score: '评分', accessMode: '付费模式' }
const STATUS_LABEL = { published: '已上架', draft: '草稿', offline: '已下架' }

async function pageDramas() {
  const idMatch = /^#\/dramas\/(\d+)(?:\/episodes)?$/.exec(location.hash)
  if (idMatch) {
    if (location.hash.endsWith('/episodes')) return pageEpisodes(Number(idMatch[1]))
    return pageDramaEdit(Number(idMatch[1]))
  }

  const data = await api('/admin/api/dramas')
  const options = data.options ?? { categories: [] }
  const rows = data.list ?? []
  const cat = state.params.cat ?? 'all'
  const keyword = (state.params.q ?? '').trim()
  const filtered = rows.filter((row) => (cat === 'all' || row.category === cat)
    && (!keyword || String(row.title ?? '').includes(keyword)))
  const counts = rows.reduce((acc, row) => { acc[row.category] = (acc[row.category] ?? 0) + 1; return acc }, {})

  view.innerHTML = `
    <div class="panel">
      <h3>剧集库 <span class="muted">共 ${rows.length} 部 · 已上架 ${rows.filter((row) => row.status === 'published').length}</span>
        <span class="spacer"></span>
        <input id="drama-q" class="input" placeholder="搜标题" value="${esc(keyword)}" style="width:180px" />
        <button class="btn primary" id="new-drama">＋ 新建剧集</button>
      </h3>
      <div class="subtabs" id="drama-cats">
        <button class="pill ${cat === 'all' ? 'active' : ''}" data-cat="all">全部 ${rows.length}</button>
        ${(options.categories ?? []).map((item) => `<button class="pill ${cat === item.value ? 'active' : ''}" data-cat="${item.value}">${esc(item.label)} ${counts[item.value] ?? 0}</button>`).join('')}
      </div>
      <table>
        <thead><tr><th>封面</th><th>标题</th><th>类型</th><th>收费</th><th>分集</th><th>资料</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${filtered.map((row) => {
            const missing = (row.completeness?.missing ?? []).map((key) => MISSING_LABEL[key] ?? key)
            return `<tr>
              <td>${row.cover_url ? `<img class="mini" src="${esc(mediaUrl(row.cover_url))}" alt="" onerror="this.style.visibility='hidden'" />` : '<span class="pill warn">缺</span>'}</td>
              <td><strong>${esc(row.title)}</strong>
                <div class="muted">${esc(row.sub_title ?? '')} ${row.year ? `· ${row.year}` : ''} ${row.area ? `· ${esc(row.area)}` : ''}</div></td>
              <td>${esc(CATEGORY_LABEL[row.category] ?? row.category ?? '—')}</td>
              <td>${esc(ACCESS_LABEL[row.policy?.access_mode] ?? '—')}</td>
              <td>${row.readyEpisodes ?? 0} / ${row.episodeCount ?? 0}</td>
              <td>${missing.length ? `<span class="pill warn" title="${esc(missing.join('、'))}">缺 ${missing.length} 项</span>` : '<span class="pill ok">完整</span>'}</td>
              <td>${row.status === 'published' ? '<span class="pill ok">已上架</span>' : `<span class="pill">${esc(STATUS_LABEL[row.status] ?? row.status)}</span>`}</td>
              <td class="row-actions">
                <a class="btn sm" href="#/dramas/${row.id}">编辑</a>
                <a class="btn sm" href="#/dramas/${row.id}/episodes">分集</a>
                <button class="btn sm" data-toggle-publish="${row.id}" data-status="${row.status}">${row.status === 'published' ? '下架' : '上架'}</button>
                <button class="btn sm danger" data-del="${row.id}">删除</button>
              </td>
            </tr>`
          }).join('') || '<tr><td colspan="8" class="muted">没有匹配的剧集</td></tr>'}
        </tbody>
      </table>
    </div>`

  view.querySelectorAll('[data-cat]').forEach((button) => button.addEventListener('click', () => {
    state.params.cat = button.dataset.cat
    pageDramas()
  }))
  $('#drama-q')?.addEventListener('change', (event) => {
    state.params.q = event.target.value
    pageDramas()
  })
  $('#new-drama').addEventListener('click', () => dramaWizard(options))
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
      if (!confirm('删除剧集及其分集？')) return
      await api(`/admin/api/dramas/${button.dataset.del}`, { method: 'DELETE' })
      toast('已删除')
      await pageDramas()
    })
  })
}

/** 新建剧集向导：先搜刮再补，字段不全只能存草稿。 */
function dramaWizard(options) {
  const categories = options?.categories ?? []
  const accessModes = options?.accessModes ?? []
  const draft = { title: '', subTitle: '', category: '', coverUrl: '', year: '', area: '', score: '', description: '', accessMode: 'subscription', singlePrice: 0, freeEpisodes: 1, trialSeconds: 0 }

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
      <div class="field"><label>付费模式 *</label>
        <select id="wz-access">${accessModes.map((item) => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}</select></div>
      <div class="field"><label>年份</label><input id="wz-year" placeholder="2010" /></div>
      <div class="field"><label>地区</label><input id="wz-area" placeholder="荷兰 / 中国大陆" /></div>
      <div class="field"><label>评分（0–10）</label><input id="wz-score" placeholder="9.1" /></div>
      <div class="field"><label>单片价格（元，单独收费时用）</label><input id="wz-price" placeholder="6" /></div>
    </div>
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
      draft.accessMode = body.querySelector('#wz-access').value
      draft.year = body.querySelector('#wz-year').value
      draft.area = body.querySelector('#wz-area').value.trim()
      draft.score = body.querySelector('#wz-score').value
      draft.coverUrl = body.querySelector('#wz-cover').value.trim()
      draft.description = body.querySelector('#wz-desc').value.trim()
      draft.singlePrice = Number(body.querySelector('#wz-price').value || 0)
      draft.tags = body.querySelector('#wz-tags').value.split(/[,，\s]+/).filter(Boolean)
      return draft
    }
    const missingOf = (value) => {
      const missing = []
      if (!value.title) missing.push('标题')
      if (!value.category) missing.push('内容类型')
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
            coverUrl: value.coverUrl, description: value.description,
            year: Number(value.year) || 0, area: value.area, score: Number(value.score) || 0,
            accessMode: value.accessMode, singlePrice: Number(value.singlePrice) || 0,
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
    body.querySelector('#wz-title').focus()
  })
}

async function pageDramaEdit(id) {
  const data = await api(`/admin/api/dramas/${id}`)
  const drama = data.drama
  const allTags = await api('/admin/api/tags').then((result) => result.list).catch(() => [])
  const policy = data.policy ?? {}
  const currentTags = new Set((drama.tags ?? []).map((tag) => Number(tag.id ?? tag.tag_id)))
  view.innerHTML = `
    <div class="panel">
      <h3>编辑剧集 #${id}<span class="spacer"></span><a class="btn" href="#/dramas">返回列表</a></h3>
      <div class="form">
        ${field('title', '标题', drama.title)}
        ${field('subTitle', '副标题', drama.sub_title)}
        ${field('coverUrl', '封面地址', drama.cover_url)}
        <label>内容类型<select id="f-category">
          ${Object.entries(CATEGORY_LABEL).map(([value, label]) => `<option value="${value}" ${drama.category === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        ${field('year', '年份', drama.year, 'number')}
        ${field('area', '地区', drama.area)}
        ${field('score', '评分', drama.score, 'number')}
        <label>付费模式<select id="f-accessMode">
          ${Object.entries(ACCESS_LABEL).map(([value, label]) => `<option value="${value}" ${policy.access_mode === value ? 'selected' : ''}>${label}</option>`).join('')}
        </select></label>
        <label>状态<select id="f-status">
          <option value="published" ${drama.status === 'published' ? 'selected' : ''}>已上架</option>
          <option value="draft" ${drama.status !== 'published' ? 'selected' : ''}>草稿 / 待补全</option>
        </select></label>
      </div>
      <label class="muted">标签<span class="spacer"></span></label>
    <div class="tag-picker" style="display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 14px">
      ${allTags.length === 0
        ? '<span class="muted">还没有标签，先去「标签管理」新建</span>'
        : allTags.map((tag) => `<label style="display:inline-flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" class="f-tag" value="${tag.id}" ${currentTags.has(Number(tag.id)) ? 'checked' : ''} />${esc(tag.name)}
          </label>`).join('')}
    </div>
    <label class="muted">简介</label>
      <textarea id="f-description" rows="3" style="width:100%;margin-top:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text)">${esc(drama.description ?? '')}</textarea>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn primary" id="save-drama">保存</button>
        <button class="btn" id="save-tags">保存标签</button>
        <button class="btn" id="edit-rules">按集定价规则</button>
        <a class="btn" href="#/dramas/${id}/episodes">管理分集与视频 →</a>
      </div>
    </div>`

    $('#save-tags')?.addEventListener('click', async () => {
    const tagIds = [...view.querySelectorAll('.f-tag:checked')].map((node) => Number(node.value))
    try {
      await api(`/admin/api/dramas/${id}/tags`, { method: 'POST', body: { tagIds } })
      toast('标签已保存')
    } catch (error) { toast(error.message) }
  })

  $('#edit-rules').addEventListener('click', () => openRuleEditor(Number(id), drama.title))

    $('#save-drama').addEventListener('click', async () => {
    await api(`/admin/api/dramas/${id}`, {
      method: 'PUT',
      body: {
        title: $('#f-title').value, subTitle: $('#f-subTitle').value, coverUrl: $('#f-coverUrl').value,
        category: $('#f-category').value, year: Number($('#f-year').value), area: $('#f-area').value,
        score: Number($('#f-score').value), status: $('#f-status').value,
        description: $('#f-description').value,
      },
    })
    await api(`/admin/api/dramas/${id}/policy`, {
      method: 'PUT',
      body: {
        accessMode: $('#f-accessMode').value,
        freeEpisodes: Number(policy.free_episodes ?? 0),
        trialSeconds: Number(policy.trial_seconds ?? 0),
        singlePrice: Number(policy.single_price_cny ?? 0),
      },
    }).catch(() => null)
    toast('已保存')
  })
}

const field = (key, label, value, type = 'text') =>
  `<label>${esc(label)}<input id="f-${key}" type="${type}" value="${esc(value ?? '')}" /></label>`

async function pageEpisodes(dramaId) {
  const data = await api(`/admin/api/dramas/${dramaId}/episodes`)
  view.innerHTML = `
    <div class="panel">
      <h3>分集与视频 · 剧集 #${dramaId}<span class="spacer"></span>
        <a class="btn" href="#/dramas/${dramaId}">编辑剧集</a>
        <button class="btn primary" id="add-episode">新增分集</button>
      </h3>
      <div class="muted" style="margin-bottom:10px">上传视频后自动进入转码队列（ffmpeg → HLS 720p，4s 切片）。也可以「生成示例视频」验证整条链路。</div>
      <table>
        <thead><tr><th>集</th><th>标题</th><th>状态</th><th>进度</th><th>HLS</th><th>操作</th></tr></thead>
        <tbody id="ep-body">
          ${data.list.map((row) => episodeRow(row)).join('')}
        </tbody>
      </table>
    </div>`
  wireEpisodeActions(dramaId)

  $('#add-episode').addEventListener('click', async () => {
    await api(`/admin/api/dramas/${dramaId}/episodes`, { method: 'POST', body: {} })
    await pageEpisodes(dramaId)
  })

  state.timers.push(setInterval(async () => {
    try {
      const fresh = await api(`/admin/api/dramas/${dramaId}/episodes`)
      $('#ep-body').innerHTML = fresh.list.map((row) => episodeRow(row)).join('')
      wireEpisodeActions(dramaId)
    } catch { /* 页面已切走 */ }
  }, 2500))
}

function episodeRow(row) {
  const badge = row.status === 'ready' && !row.hls_path ? '<span class="pill">无片源</span>'
    : row.status === 'ready' ? '<span class="pill ok">就绪</span>'
    : row.status === 'transcoding' ? '<span class="pill warn">转码中</span>'
    : row.status === 'queued' ? '<span class="pill">排队</span>'
    : row.status === 'error' ? `<span class="pill bad">失败</span><div class="muted">${esc(row.error ?? '')}</div>`
    : '<span class="pill">未上传</span>'
  return `<tr>
    <td>第 ${row.no} 集</td>
    <td>${esc(row.title ?? '')}${row.vip ? ' <span class="pill warn">VIP</span>' : ''}</td>
    <td>${badge}</td>
    <td style="width:160px"><div class="progress"><i style="width:${row.progress}%"></i></div><div class="muted">${row.progress}%</div></td>
    <td class="mono">${row.hls_path ? esc(row.hls_path) : '—'}</td>
    <td class="row-actions">
      <label class="btn sm">上传<input type="file" accept="video/*" data-upload="${row.id}" style="display:none" /></label>
      <button class="btn sm" data-sample="${row.id}">示例视频</button>
      <button class="btn sm danger" data-delep="${row.id}">删除</button>
    </td>
  </tr>`
}

function wireEpisodeActions(dramaId) {
  view.querySelectorAll('[data-upload]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      const id = input.dataset.upload
      toast(`上传中 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）…`)
      try {
        const result = await api(`/admin/api/episodes/${id}/upload`, { method: 'POST', body: file })
        toast(`已入队：${result.source}`)
      } catch (error) { toast(`上传失败：${error.message}`) }
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
      if (!confirm('删除该分集？')) return
      await api(`/admin/api/episodes/${button.dataset.delep}`, { method: 'DELETE' })
      await pageEpisodes(dramaId)
    })
  })
}

/* ---------------- 首页运营 ---------------- */
async function pageOps() {
  const [banners, sections] = await Promise.all([api('/admin/api/banners'), api('/admin/api/sections')])
  view.innerHTML = `
    <div class="panel">
      <h3>首页 Banner<span class="spacer"></span><button class="btn primary" id="add-banner">新增 Banner</button></h3>
      <table><thead><tr><th>图</th><th>名称/标题</th><th>跳转剧集</th><th>排序</th><th>启用</th><th>操作</th></tr></thead><tbody>
        ${banners.list.map((row) => `<tr>
          <td><img class="mini" src="${esc(mediaUrl(row.image))}" alt="" onerror="this.style.visibility='hidden'" /></td>
          <td>${esc(row.name)}<div class="muted">${esc(row.title ?? '')}</div></td>
          <td>#${esc(row.target_drama_id ?? '—')}</td>
          <td>${row.sort}</td>
          <td>${row.enabled ? '<span class="pill ok">启用</span>' : '<span class="pill">停用</span>'}</td>
          <td class="row-actions">
            <button class="btn sm" data-toggle-banner="${row.id}" data-enabled="${row.enabled ? 0 : 1}">${row.enabled ? '停用' : '启用'}</button>
            <button class="btn sm danger" data-del-banner="${row.id}">删除</button>
          </td></tr>`).join('')}
      </tbody></table>
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
    const name = prompt('Banner 名称')
    if (!name) return
    const image = prompt('图片地址 https://…') ?? ''
    const target = prompt('跳转剧集 ID（可空）') ?? ''
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
    const title = prompt('楼层标题')
    if (!title) return
    await api('/admin/api/sections', { method: 'POST', body: { title } })
    await pageOps()
  })
  view.querySelectorAll('[data-attach-section]').forEach((button) => {
    button.addEventListener('click', async () => {
      const dramaId = prompt('要挂到该楼层的剧集 ID')
      if (!dramaId) return
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
}

/* ---------------- 榜单 ---------------- */
const RANK_TYPE_LABEL = { HOT: '热播榜', RISE: '飙升榜', SEARCH: '搜索榜', CLASSIC: '口碑榜' }

async function pageRanks() {
  const [data, dramas] = await Promise.all([api('/admin/api/ranks'), api('/admin/api/dramas').catch(() => ({ list: [] }))])
  view.innerHTML = `
    <div class="panel">
      <h3>榜单 <span class="muted">每日自动按用户行为重算</span><span class="spacer"></span>
        <button class="btn primary" id="refresh-ranks">立即刷新全部</button>
        <button class="btn" id="add-rank">＋ 新增榜单</button>
      </h3>
      <p class="muted">自动榜每天凌晨按播放/收藏/成交重算；人工插进去的条目可以「锁定」，刷新时原位保留不被覆盖。</p>
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
          <table style="margin-top:8px">
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
      <div class="field"><label>剧集</label>
        <select id="rk-drama">${(dramas.list ?? []).map((row) => `<option value="${row.id}">#${row.id} ${esc(row.title)}</option>`).join('')}</select></div>
      <div class="field"><label>名次</label><input id="rk-no" type="number" value="1" /></div>
      <div class="modal-foot"><button class="btn primary" id="rk-save">加入</button></div>
    `, (body, close) => {
      body.querySelector('#rk-save').addEventListener('click', async () => {
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
  const [danmus, comments] = await Promise.all([api('/admin/api/danmus'), api('/admin/api/comments')])
  view.innerHTML = `
    <div class="panel">
      <h3>弹幕审核 <span class="muted">待审 ${danmus.list.filter((x) => x.status === 'pending').length}</span></h3>
      <table><thead><tr><th>ID</th><th>分集</th><th>时间</th><th>内容</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${danmus.list.slice(0, 40).map((row) => `<tr>
          <td>${row.id}</td><td>EP ${row.episode_id}</td><td>${Math.round(row.time_ms / 1000)}s</td>
          <td>${esc(row.content)}</td><td>${statusPill(row.status)}</td>
          <td class="row-actions">${reviewButtons('danmus', row)}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="panel">
      <h3>评论审核 <span class="muted">待审 ${comments.list.filter((x) => x.status === 'pending').length}</span></h3>
      <table><thead><tr><th>ID</th><th>剧集</th><th>内容</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${comments.list.slice(0, 40).map((row) => `<tr>
          <td>${row.id}</td><td>#${row.drama_id}</td><td>${esc(row.content)}</td>
          <td>${statusPill(row.status)}</td><td class="row-actions">${reviewButtons('comments', row)}</td></tr>`).join('')}
      </tbody></table>
    </div>`

  view.querySelectorAll('[data-review]').forEach((button) => {
    button.addEventListener('click', async () => {
      const [table, id, action] = button.dataset.review.split(':')
      await api(`/admin/api/${table}/${id}/${action}`, { method: 'POST', body: {} })
      toast(action === 'approve' ? '已通过' : '已驳回')
      await pageReview()
    })
  })
}

const statusPill = (status) => status === 'approved' ? '<span class="pill ok">已通过</span>' : status === 'rejected' ? '<span class="pill bad">已驳回</span>' : '<span class="pill warn">待审</span>'
const reviewButtons = (table, row) => `
  <button class="btn sm" data-review="${table}:${row.id}:approve">通过</button>
  <button class="btn sm danger" data-review="${table}:${row.id}:reject">驳回</button>`

/* ---------------- 用户 ---------------- */
async function pageUsers() {
  const data = await api('/admin/api/users')
  const rows = data.list.map((row) => `<tr>
    <td>${row.id}</td>
    <td class="mono">${esc(row.email ?? row.phone ?? '')}</td>
    <td>${esc(row.nickname)}</td>
    <td>${row.avatar ? '<span class="pill ok">有</span>' : '<span class="pill">无</span>'}</td>
    <td>${row.status === 'banned' ? '<span class="pill bad">已禁用</span>' : '<span class="pill ok">正常</span>'}</td>
    <td>${esc(row.vip_until ?? '—')}</td>
    <td>${row.order_count}</td>
    <td>¥${Number(row.paid_total).toFixed(2)}</td>
    <td><button class="btn sm" data-toggle="${row.id}" data-status="${row.status === 'banned' ? 'active' : 'banned'}">${row.status === 'banned' ? '解禁' : '禁用'}</button>
        ${row.email ? `<button class="btn sm ghost" data-code="${row.id}">登录码</button>` : ''}</td>
  </tr>`)
  view.innerHTML = `<div class="panel">
    <h3>用户<span class="spacer"></span></h3>
    <table><thead><tr><th>ID</th><th>邮箱</th><th>昵称</th><th>头像</th><th>状态</th><th>会员到期</th><th>订单数</th><th>累计付费</th><th>操作</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <p class="muted">C 端已改为邮箱验证码登录；邮件通道不可用时，用「登录码」为该用户签发一次性验证码（5 分钟、单次、写审计）。</p>
  </div>`
  view.querySelectorAll('[data-code]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt('签发原因（必填，将写入审计）')
      if (!reason) return
      try {
        const result = await api(`/admin/api/users/${button.dataset.code}/login-code`, { method: 'POST', body: { reason } })
        alert(`登录码已生成（${Math.round(result.expiresIn / 60)} 分钟内有效，仅可使用一次）\n\n${result.email}\n验证码：${result.code}\n\n请通过可靠渠道转交用户，页面关闭后无法再次查看。`)
        await pageUsers()
      } catch (error) {
        toast(error.message)
      }
    })
  })
  view.querySelectorAll('[data-toggle]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt('操作原因（必填）')
      if (!reason) return
      await api(`/admin/api/users/${button.dataset.toggle}/status`, { method: 'POST', body: { status: button.dataset.status, reason } })
      toast('已更新用户状态')
      await pageUsers()
    })
  })
}

/* ---------------- 通用小工具 ---------------- */
function panel(title, body, extra = '') {
  return `<div class="panel"><h3>${title}<span class="spacer"></span>${extra}</h3>${body}</div>`
}
function table(headers, rows) {
  return `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`
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
  const data = await api('/admin/api/dramas')
  const rows = data.list.map((drama) => {
    const policy = drama.policy ?? { access_mode: 'subscription', free_episodes: 1, trial_seconds: 0, single_price_cny: 0 }
    return `<tr data-row="${drama.id}">
      <td>${esc(drama.title)}</td>
      <td><select data-f="accessMode">${['free', 'subscription', 'paid'].map((mode) => `<option value="${mode}" ${policy.access_mode === mode ? 'selected' : ''}>${ACCESS_LABEL_POLICY[mode] ?? mode}</option>`).join('')}</select></td>
      <td><input data-f="freeEpisodes" type="number" min="0" value="${policy.free_episodes}" style="width:70px" /></td>
      <td><input data-f="trialSeconds" type="number" min="0" value="${policy.trial_seconds}" style="width:80px" /></td>
      <td><input data-f="singlePrice" type="number" min="0" step="0.01" value="${policy.single_price_cny}" style="width:80px" /></td>
      <td><button class="btn sm primary" data-save="${drama.id}">保存</button></td>
      <td><button class="btn sm" data-rules="${drama.id}" data-title="${esc(drama.title)}">按集规则</button></td>
    </tr>`
  })
  view.innerHTML = panel('付费策略', `
    <p class="muted">整体策略决定默认口径：免费 = 全部可看；会员免费 = 有会员即可看；单独收费 = 按单片价购买。需要「VIP 免费但最后两集单独收费」这类组合，用每行的「按集规则」配置。</p>
    ${table(['剧名', '模式', '免费集', '试看(秒)', '单片价', '保存', '按集规则'], rows)}`)

  view.querySelectorAll('[data-save]').forEach((button) => {
    button.addEventListener('click', async () => {
      const row = button.closest('tr')
      const value = (name) => row.querySelector(`[data-f="${name}"]`).value
      await api(`/admin/api/dramas/${button.dataset.save}/policy`, {
        method: 'PUT',
        body: {
          accessMode: value('accessMode'),
          freeEpisodes: Number(value('freeEpisodes')),
          trialSeconds: Number(value('trialSeconds')),
          singlePrice: Number(value('singlePrice')),
        },
      })
      toast('策略已保存')
    })
  })

  view.querySelectorAll('[data-rules]').forEach((button) => button.addEventListener('click', () => {
    openRuleEditor(Number(button.dataset.rules), button.dataset.title)
  }))
}

/** 按集规则编辑器：可以叠加多条区间规则，保存时整体替换。 */
async function openRuleEditor(dramaId, title) {
  const data = await api(`/admin/api/dramas/${dramaId}/pricing-rules`)
  const rules = (data.rules ?? []).map((rule) => ({
    fromNo: rule.from_no, toNo: rule.to_no ?? '', mode: rule.mode, price: Number(rule.price_cny ?? 0), note: rule.note ?? '',
  }))
  openOverlay(`按集定价 · ${title}`, `
    <p class="muted">共 ${data.episodeCount} 集（最后一集第 ${data.lastNo} 集）。规则从上到下匹配，命中第一条即生效；没有命中的集走整体策略（${ACCESS_LABEL_POLICY[data.defaults.accessMode] ?? data.defaults.accessMode}，单片价 ¥${Number(data.defaults.singlePrice).toFixed(2)}）。</p>
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
      if (!confirm('清空该剧全部按集规则？')) return
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
  const cards = (data.list ?? []).map((plan) => {
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
        <input id="plan-name" placeholder="套餐名（月卡会员）" />
        <input id="plan-days" type="number" placeholder="天数" value="30" style="width:90px" />
        <input id="plan-price" type="number" step="0.01" placeholder="价格" style="width:100px" />
        <button class="btn primary" id="plan-add">新增套餐</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">${cards || '<p class="muted">还没有套餐</p>'}</div>`
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
}

/* ---------------- 优惠券 ---------------- */
async function pageCoupons() {
  const data = await api('/admin/api/coupons')
  const rows = (data.list ?? []).map((coupon) => `<tr>
    <td class="mono">${esc(coupon.code)}</td><td>${esc(coupon.name)}</td>
    <td>${coupon.discount_type === 'amount' ? '立减' : '折扣'}</td>
    <td>${coupon.discount_type === 'amount' ? '¥' + Number(coupon.discount_value).toFixed(2) : coupon.discount_value + '%'}</td>
    <td>¥${Number(coupon.min_amount).toFixed(2)}</td><td>${coupon.used}/${coupon.total || '不限'}</td>
    <td>${esc(coupon.valid_to ?? '长期')}</td><td>${pillOf(coupon.status)}</td>
    <td><button class="btn sm" data-c-status="${coupon.id}" data-status="${coupon.status === 'active' ? 'disabled' : 'active'}">${coupon.status === 'active' ? '停用' : '启用'}</button></td>
  </tr>`)
  view.innerHTML = panel('优惠券', `
    <p class="muted">编码留空时由系统生成纯数字唯一码；需要外部投放的固定码也可以自己填。</p>
    <div class="form-row">
      <input id="c-code" placeholder="券码（留空自动生成）" />
      <input id="c-name" placeholder="名称" />
      <select id="c-type"><option value="amount">立减</option><option value="percent">折扣(%)</option></select>
      <input id="c-value" type="number" step="0.01" placeholder="面额/折扣" style="width:110px" />
      <input id="c-min" type="number" step="0.01" placeholder="门槛" style="width:90px" />
      <button class="btn primary" id="c-add">新增</button>
    </div>
    ${table(['券码', '名称', '类型', '面额', '门槛', '已用/总量', '有效期', '状态', '操作'], rows)}`)
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
}

/* ---------------- 订单 ---------------- */
async function pageOrders() {
  const data = await api('/admin/api/orders')
  const total = data.list.filter((order) => ['paid', 'fulfilled'].includes(order.status)).reduce((sum, order) => sum + order.amount_cny, 0)
  const rows = data.list.map((order) => `<tr>
    <td class="mono">${esc(order.out_trade_no)}</td>
    <td>${esc(order.nickname ?? '')}<div class="muted" style="font-size:11px">${esc(order.phone ?? '')}</div></td>
    <td>${order.product_type === 'subscription' ? '会员 · ' + esc(order.plan_name ?? '') : '单片 · ' + esc(order.drama_title ?? '')}</td>
    <td>¥${Number(order.amount_cny).toFixed(2)}</td>
    <td>${esc(order.channel)}</td>
    <td>${pillOf(order.status)}</td>
    <td class="muted">${esc(order.paid_at ?? order.created_at)}</td>
    <td>${['paid', 'fulfilled'].includes(order.status)
      ? `<button class="btn sm danger" data-refund="${order.id}">发起退款</button>`
      : ['created', 'pending'].includes(order.status)
        ? `<button class="btn sm" data-confirm="${order.id}">确认到账</button>`
        : '—'}</td>
  </tr>`)
  view.innerHTML = panel('订单', `
    <p class="muted">已支付合计 ¥${total.toFixed(2)}（最近 100 笔）</p>
    ${table(['单号', '用户', '商品', '金额', '渠道', '状态', '时间', '操作'], rows)}`,
  '<button class="btn" id="close-expired">关闭超时订单</button>')
  $('#close-expired').addEventListener('click', async () => {
    const result = await api('/admin/api/close-expired', { method: 'POST', body: {} })
    toast(`已关闭 ${result.closed} 笔`)
    await pageOrders()
  })
  view.querySelectorAll('[data-confirm]').forEach((button) => {
    button.addEventListener('click', async () => {
      const orderId = Number(button.dataset.confirm)
      const txid = prompt('链上 txid / 流水号（USDT 建议填写，留空则记人工补单）') ?? ''
      try {
        await api(`/admin/api/orders/${orderId}/confirm`, { method: 'POST', body: { txid: txid || undefined } })
        toast('已确认到账并发放权益')
        await pageOrders()
      } catch (error) { toast(error.message) }
    })
  })
  view.querySelectorAll('[data-refund]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt('退款原因（必填，≥4 字）')
      if (!reason) return
      await api('/admin/api/refunds', { method: 'POST', body: { orderId: Number(button.dataset.refund), reason } })
      toast('退款单已创建，需另一位管理员审批')
      await pageOrders()
    })
  })
}

/* ---------------- 退款审核 ---------------- */
async function pageRefunds() {
  const data = await api('/admin/api/refunds')
  const rows = data.list.map((refund) => `<tr>
    <td>${refund.id}</td><td class="mono">${esc(refund.out_trade_no)}</td><td>${esc(refund.nickname ?? '')}</td>
    <td>¥${Number(refund.amount).toFixed(2)}</td><td>${esc(refund.reason)}</td>
    <td>${refund.status === 'pending' ? '<span class="pill">待审批</span>' : pillOf(refund.status)}</td>
    <td class="row-actions">${refund.status === 'pending' ? `<button class="btn sm primary" data-approve="${refund.id}" data-info="${esc(`${refund.out_trade_no} · ${refund.nickname ?? ''} · ¥${Number(refund.amount).toFixed(2)}`)}">通过</button>
      <button class="btn sm danger" data-reject="${refund.id}">驳回</button>` : '—'}</td>
  </tr>`)
  view.innerHTML = panel('退款审核', `
    <p class="muted">双人复核：发起人不能审批自己的退款单；通过后立即回收权益并标记订单已退款。</p>
    ${table(['ID', '单号', '用户', '金额', '原因', '状态', '操作'], rows)}`)
  view.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', async () => {
      // 通过是不可逆的资金动作（回收权益 + 标记已退款），必须先确认影响面
      const info = button.dataset.info ?? ''
      if (!window.confirm(`确认通过这笔退款？\n\n${info}\n\n通过后：订单置为已退款、该用户对应权益立即回收。`)) return
      try {
        const result = await api(`/admin/api/refunds/${button.dataset.approve}/approve`, { method: 'POST', body: {} })
        toast(result.warning ?? '退款完成，权益已回收')
      } catch (error) { toast(error.message) }
      await pageRefunds()
    })
  })
  view.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt('驳回原因') ?? '未通过审核'
      await api(`/admin/api/refunds/${button.dataset.reject}/reject`, { method: 'POST', body: { reason } })
      await pageRefunds()
    })
  })
}

/* ---------------- 角色权限（树形菜单） ---------------- */
const menuState = { tree: [], checked: new Set(), roleId: null, keyword: '', expanded: new Set() }

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

/** 半选：自己没有勾，但有子孙勾了。 */
function computeHalf(nodes) {
  let any = false
  for (const node of nodes) {
    const selfChecked = menuState.checked.has(node.code)
    const childAny = node.children?.length ? computeHalf(node.children) : false
    node.__half = !selfChecked && childAny
    any = any || selfChecked || childAny
  }
  return any
}

function setSubtree(node, checked) {
  if (checked) menuState.checked.add(node.code)
  else menuState.checked.delete(node.code)
  for (const child of node.children ?? []) setSubtree(child, checked)
}

function findNode(nodes, code) {
  for (const node of nodes) {
    if (node.code === code) return node
    const hit = node.children ? findNode(node.children, code) : undefined
    if (hit) return hit
  }
  return undefined
}

function renderTreeNode(node, keyword, depth = 0) {
  if (!treeVisible(node, keyword)) return ''
  const isChecked = menuState.checked.has(node.code)
  const hasChildren = Boolean(node.children?.length)
  const expanded = menuState.expanded.has(node.code) || Boolean(keyword)
  const typeTag = { dir: '目录', menu: '菜单', button: '按钮' }[node.type] ?? node.type
  return `<div class="tnode">
    <div class="trow ${node.type}" style="padding-left:${depth * 18 + 4}px">
      <span class="tcaret" data-toggle="${node.code}">${hasChildren ? (expanded ? '▾' : '▸') : '·'}</span>
      <label class="tlabel">
        <input type="checkbox" data-check="${node.code}" ${isChecked ? 'checked' : ''} ${node.__half ? 'data-half="1"' : ''} />
        <span class="ticon">${node.icon ?? ''}</span>
        <span class="tname">${esc(node.name)}</span>
        <span class="ttype ${node.type}">${typeTag}</span>
        <span class="tcode mono">${esc(node.code)}</span>
        ${node.path ? `<span class="tpath mono">${esc(node.path)}</span>` : ''}
      </label>
    </div>
    ${hasChildren && expanded ? node.children.map((child) => renderTreeNode(child, keyword, depth + 1)).join('') : ''}
  </div>`
}

async function pageRoles() {
  const [menuData, roleData, adminData] = await Promise.all([
    api('/admin/api/menus'), api('/admin/api/roles'), api('/admin/api/admins'),
  ])
  const roles = roleData.roles
  if (!menuState.roleId) menuState.roleId = roles[0]?.id ?? null
  const role = roles.find((item) => item.id === menuState.roleId) ?? roles[0]
  menuState.roleId = role?.id ?? null

  menuState.tree = JSON.parse(JSON.stringify(menuData.tree))
  const binding = await api(`/admin/api/roles/${menuState.roleId}/menus`)
  menuState.checked = new Set(binding.checked)
  // 首次进入默认展开目录与菜单（按钮层不用展开）
  if (menuState.expanded.size === 0) {
    for (const node of flattenTree(menuState.tree)) {
      if (node.type !== 'button') menuState.expanded.add(node.code)
    }
  }
  computeHalf(menuState.tree)

  view.innerHTML = panel('角色权限 · 树形菜单', `
    <div class="role-bar">
      ${roles.map((item) => `<button class="role-tab ${item.id === menuState.roleId ? 'active' : ''}" data-role-tab="${item.id}">${esc(item.name)}</button>`).join('')}
    </div>
    <div class="tree-toolbar">
      <input id="tree-search" placeholder="搜索菜单 / 权限 / 路由" value="${esc(menuState.keyword)}" />
      <button class="btn sm" id="tree-expand">展开全部</button>
      <button class="btn sm" id="tree-collapse">收起全部</button>
      <button class="btn sm" id="tree-check-all">全选</button>
      <button class="btn sm" id="tree-uncheck-all">清空</button>
      <span class="spacer"></span>
      <span class="muted" id="tree-count">已选 ${menuState.checked.size} 项</span>
      <button class="btn primary" id="tree-save">保存</button>
    </div>
    <div class="tree" id="menu-tree">${menuState.tree.map((node) => renderTreeNode(node, menuState.keyword)).join('')}</div>
    <p class="muted">父子联动：勾选目录/菜单会带动全部子项；只勾部分子项时父节点为半选（后端保存时自动补齐父级）。</p>
    <h3>管理员</h3>
    ${table(['ID', '账号', '姓名', '角色', '状态'], adminData.list.map((admin) => `<tr>
      <td>${admin.id}</td><td class="mono">${esc(admin.username)}</td><td>${esc(admin.display_name ?? '')}</td>
      <td>${admin.roles.map((item) => esc(item.name)).join(' / ')}</td><td>${pillOf(admin.status)}</td>
    </tr>`))}`)

  const refresh = () => pageRoles()
  view.querySelectorAll('[data-role-tab]').forEach((button) => {
    button.addEventListener('click', () => { menuState.roleId = Number(button.dataset.roleTab); menuState.keyword = ''; refresh() })
  })
  $('#tree-search').addEventListener('input', (event) => { menuState.keyword = event.target.value; refresh() })
  $('#tree-expand').addEventListener('click', () => { for (const node of flattenTree(menuState.tree)) menuState.expanded.add(node.code); refresh() })
  $('#tree-collapse').addEventListener('click', () => { menuState.expanded.clear(); refresh() })
  $('#tree-check-all').addEventListener('click', () => { for (const node of flattenTree(menuState.tree)) menuState.checked.add(node.code); refresh() })
  $('#tree-uncheck-all').addEventListener('click', () => { menuState.checked.clear(); refresh() })
  $('#tree-save').addEventListener('click', async () => {
    const result = await api(`/admin/api/roles/${menuState.roleId}/menus`, { method: 'PUT', body: { codes: [...menuState.checked] } })
    toast(`已保存 ${result.checked.length} 个节点（含自动补齐父级）`)
    await refresh()
  })
  view.querySelectorAll('[data-check]').forEach((input) => {
    input.addEventListener('change', () => {
      const node = findNode(menuState.tree, input.dataset.check)
      if (node) setSubtree(node, input.checked)
      refresh()
    })
  })
  view.querySelectorAll('[data-toggle]').forEach((caret) => {
    caret.addEventListener('click', () => {
      const code = caret.dataset.toggle
      if (menuState.expanded.has(code)) menuState.expanded.delete(code)
      else menuState.expanded.add(code)
      refresh()
    })
  })
}

/* ---------------- 审计日志 ---------------- */
async function pageAudit() {
  const data = await api('/admin/api/audit?limit=200')
  const rows = data.list.map((log) => `<tr>
    <td>${log.id}</td><td class="muted">${esc(log.created_at)}</td>
    <td>${esc(log.actor_name ?? log.actor_type)}</td><td class="mono">${esc(log.action)}</td>
    <td class="muted">${esc(log.target_type ?? '')}${log.target_id ? ' #' + esc(log.target_id) : ''}</td>
    <td class="muted">${esc(log.reason ?? '')}</td>
    <td>${log.result === 'denied' ? '<span class="pill bad">拒绝</span>' : '<span class="pill ok">成功</span>'}</td>
    <td class="mono muted">${esc(log.ip ?? '')}</td>
  </tr>`)
  view.innerHTML = panel('审计日志', table(['ID', '时间', '操作人', '动作', '对象', '原因', '结果', 'IP'], rows))
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
    return `<label class="field"><span>${esc(label)}</span>
      ${type === 'textarea'
        ? `<textarea data-cfg="${key}" rows="2" placeholder="${esc(hint || '请输入')}"></textarea>`
        : `<input data-cfg="${key}" value="" placeholder="${esc(hint || '请输入')}" />`}
    </label>`
  }).join('')
}

async function pagePay() {
  const data = await api('/admin/api/pay-channels')
  const rows = data.list.map((channel) => `<tr>
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
  </tr>`)

  view.innerHTML = panel('支付渠道', `
    <p class="muted">敏感字段（AppID/私钥/APIv3 密钥/收款地址）以 AES-256-GCM 加密存储，列表只回显掩码；密钥版本 v${data.keyVersion}，可用版本 ${data.keyVersions.join(' / ')}。</p>
    ${table(['ID', '编码', '名称', '场景', '环境', '状态', '默认', '优先级', '币种', '密钥版本', '操作'], rows)}
    <div id="pay-form" class="panel" style="background:var(--panel-2);margin-top:14px;display:none"></div>`,
  '<button class="btn primary" id="add-channel">新增渠道</button>')

  const form = $('#pay-form')
  const openForm = (channel) => {
    form.style.display = 'block'
    const code = channel?.channel_code ?? 'alipay'
    form.innerHTML = `
      <h3>${channel ? '编辑渠道 #' + channel.id : '新增渠道'}<span class="spacer"></span><button class="btn sm" id="close-form">关闭</button></h3>
      <div class="form-row">
        <label>渠道
          <select id="f-code" ${channel ? 'disabled' : ''}>
            ${Object.entries(CHANNEL_PRESETS).map(([key, preset]) => `<option value="${key}" ${key === code ? 'selected' : ''}>${esc(preset.label)}（${key}）</option>`).join('')}
          </select>
        </label>
        <label>名称<input id="f-name" value="${esc(channel?.name ?? '支付宝')}" /></label>
        <label>场景
          <select id="f-scene">
            ${['all', 'subscription', 'single'].map((scene) => `<option value="${scene}" ${channel?.scene === scene ? 'selected' : ''}>${scene}</option>`).join('')}
          </select>
        </label>
        <label>环境
          <select id="f-env">
            ${['sandbox', 'prod'].map((env) => `<option value="${env}" ${channel?.env === env ? 'selected' : ''}>${env}</option>`).join('')}
          </select>
        </label>
        <label>优先级<input id="f-priority" type="number" value="${channel?.priority ?? 100}" style="width:80px" /></label>
        <label>币种<input id="f-currency" value="${esc(channel?.currency ?? 'CNY')}" style="width:90px" /></label>
        <label>最小额<input id="f-min" type="number" step="0.01" value="${channel?.min_amount ?? 0}" style="width:90px" /></label>
        <label>最大额<input id="f-max" type="number" step="0.01" value="${channel?.max_amount ?? 0}" style="width:90px" /></label>
      </div>
      <div class="cfg-grid" id="cfg-fields">${channelConfigForm(code, channel?.config_preview)}</div>
      <div class="form-row" style="margin-top:12px">
        <button class="btn primary" id="save-channel">保存</button>
        <span class="muted">私钥类字段只写不读：留空表示保持原值。</span>
      </div>`
    $('#f-code').addEventListener('change', (event) => {
      $('#cfg-fields').innerHTML = channelConfigForm(event.target.value)
    })
    $('#close-form').addEventListener('click', () => { form.style.display = 'none' })
    $('#save-channel').addEventListener('click', async () => {
      const config = {}
      form.querySelectorAll('[data-cfg]').forEach((input) => {
        if (input.value !== '') config[input.dataset.cfg] = input.value
      })
      const payload = {
        channelCode: channel?.channel_code ?? $('#f-code').value,
        name: $('#f-name').value, scene: $('#f-scene').value, env: $('#f-env').value,
        priority: Number($('#f-priority').value), currency: $('#f-currency').value,
        minAmount: Number($('#f-min').value), maxAmount: Number($('#f-max').value),
        config,
      }
      await api(channel ? `/admin/api/pay-channels/${channel.id}` : '/admin/api/pay-channels',
        { method: channel ? 'PUT' : 'POST', body: payload })
      toast('已保存（密钥加密入库）')
      await pagePay()
    })
  }

  $('#add-channel').addEventListener('click', () => openForm(null))
  view.querySelectorAll('[data-edit]').forEach((button) => {
    button.addEventListener('click', () => openForm(data.list.find((item) => item.id === Number(button.dataset.edit))))
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
      const reason = prompt('变更原因（必填）')
      if (!reason) return
      await api(`/admin/api/pay-channels/${button.dataset.status}/status`, { method: 'POST', body: { status: next, reason } })
      await pagePay()
    })
  })
  view.querySelectorAll('[data-default]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt('切换默认渠道的原因（必填）')
      if (!reason) return
      await api(`/admin/api/pay-channels/${button.dataset.default}/default`, { method: 'POST', body: { reason } })
      toast('默认渠道已切换')
      await pagePay()
    })
  })
  view.querySelectorAll('[data-del]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = prompt('删除原因（必填）')
      if (!reason) return
      await api(`/admin/api/pay-channels/${button.dataset.del}`, { method: 'DELETE', body: { reason } })
      await pagePay()
    })
  })
}

/* ---------------- 邮件通道（厂家无关，可多条按优先级回退） ---------------- */
async function pageEmail() {
  const data = await api('/admin/api/email-channels')
  const channels = data.channels ?? []
  const presets = data.presets ?? []
  let editing = null

  const typeLabel = { smtp: 'SMTP', oauth2: 'OAuth2', http: 'HTTP API', dev: '开发' }
  const statusOf = (channel) => {
    if (channel.enabled === false) return '<span class="pill">已停用</span>'
    if (!channel.lastTest) return '<span class="pill">未测试</span>'
    return channel.lastTest.ok ? '<span class="pill ok">可用</span>' : '<span class="pill bad">失败</span>'
  }

  const rows = channels
    .slice()
    .sort((a, b) => a.priority - b.priority)
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
    <p class="muted">
      验证码发信按「优先级」从小到大依次尝试，第一条失败自动回退到下一条。任何厂家都可接入：
      SMTP 只要 host/端口/账号；支持 OAuth2 的厂家填 token 端点即可；纯 HTTP API（Resend、SendGrid、Mailgun、自建服务）用 URL + Body 模板。
      密码/Key/refresh_token 全部 AES-256-GCM 加密存储。
    </p>
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
      <select id="em-preset">${presets.map((preset) => `<option value="${preset.id}">${esc(preset.name)}</option>`).join('')}</select>
      <button class="btn primary" id="em-add">新增通道</button>
    </div>
    <p class="muted" id="em-preset-note"></p>

    <table style="margin-top:12px">
      <thead><tr><th>优先级</th><th>名称</th><th>类型</th><th>发件人 / 端点</th><th>状态</th><th>最近测试</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="muted">还没有通道。选一个厂家预设，点「新增通道」开始。</td></tr>'}</tbody>
    </table>

    <div id="em-form"></div>`)

  const notePreset = () => {
    const preset = presets.find((item) => item.id === $('#em-preset').value)
    $('#em-preset-note').textContent = preset?.note ?? ''
  }
  notePreset()
  $('#em-preset').addEventListener('change', notePreset)

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
    if (!channel) { $('#em-form').innerHTML = ''; return }
    const isHttp = channel.type === 'http'
    const isOauth = channel.type === 'oauth2'
    $('#em-form').innerHTML = `
      <div class="panel" style="background:var(--panel-2);margin-top:16px">
        <h3>${channel.id ? '编辑通道' : '新增通道'} · ${esc(channel.name)}</h3>
        <div class="form-row">
          <label>名称 <input id="ch-name" value="${esc(channel.name)}" style="width:180px" /></label>
          <label>类型
            <select id="ch-type">
              ${[['smtp', 'SMTP（账号密码）'], ['oauth2', 'OAuth2（XOAUTH2）'], ['http', 'HTTP API']]
                .map(([value, label]) => `<option value="${value}" ${channel.type === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>
          <label>优先级 <input id="ch-priority" type="number" value="${channel.priority}" style="width:80px" /></label>
          <label>发件邮箱 <input id="ch-from" value="${esc(channel.from ?? '')}" style="width:230px" /></label>
          <label>发件人名称 <input id="ch-fromname" value="${esc(channel.fromName ?? '影巢')}" style="width:110px" /></label>
        </div>

        ${isHttp ? `
        <div class="form-row" style="margin-top:10px">
          <label>请求方法
            <select id="ch-method">${['POST', 'PUT', 'GET'].map((m) => `<option ${channel.http.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
          </label>
          <label style="flex:1">URL <input id="ch-url" value="${esc(channel.http.url ?? '')}" placeholder="https://api.example.com/send" style="width:100%" /></label>
        </div>
        <div class="form-row" style="margin-top:10px">
          <label style="flex:1">Headers(JSON) <textarea id="ch-headers" rows="2" style="width:100%">${esc(JSON.stringify(channel.http.headers ?? {}, null, 1))}</textarea></label>
        </div>
        <div class="form-row" style="margin-top:10px">
          <label style="flex:1">Body 模板 <textarea id="ch-body" rows="4" style="width:100%">${esc(channel.http.body ?? '')}</textarea></label>
        </div>
        <div class="form-row" style="margin-top:10px">
          <label>API Key <input id="ch-apikey" type="password" placeholder="${channel.http.apiKeySet ? '已保存，留空不修改' : '写入模板 {{apiKey}} 使用'}" style="width:260px" /></label>
        </div>
        <p class="muted">占位符：{{apiKey}} {{from}} {{fromName}} {{to}} {{subject}} {{text}} {{html}} {{timestamp}}</p>
        ` : ''}

        ${isOauth ? `
        <p class="muted" style="margin:8px 0 0">
          没有 clientId？→ 打开
          <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">Azure 应用注册</a>
          → 新注册（账户类型选「个人 Microsoft 账户」）→ 身份验证里打开「允许公共客户端流」→
          API 权限添加「Office 365 Exchange Online → SMTP.Send（委派）」→ 复制「应用程序(客户端) ID」填到下面。
        </p>
        <div class="form-row" style="margin-top:10px">
          <label style="flex:1">tokenUrl <input id="ch-token-url" value="${esc(channel.oauth2.tokenUrl ?? '')}" style="width:100%" /></label>
          <label style="flex:1">deviceUrl <input id="ch-device-url" value="${esc(channel.oauth2.deviceUrl ?? '')}" style="width:100%" /></label>
        </div>
        <div class="form-row" style="margin-top:10px">
          <label>clientId <input id="ch-client" value="${esc(channel.oauth2.clientId ?? '')}" style="width:300px" /></label>
          <label>clientSecret <input id="ch-secret" type="password" placeholder="${channel.oauth2.clientSecretSet ? '已保存，留空不修改' : '公共客户端可留空'}" style="width:200px" /></label>
          <label style="flex:1">scope <input id="ch-scope" value="${esc(channel.oauth2.scope ?? '')}" style="width:100%" /></label>
        </div>
        <div class="form-row" style="margin-top:10px">
          <button class="btn" id="ch-oauth-start">① 生成授权码</button>
          <button class="btn primary" id="ch-oauth-check" disabled>② 检查授权</button>
          <span class="muted" id="ch-oauth-state">${channel.oauth2.refreshTokenSet ? '已授权' + (channel.oauth2.account ? '：' + esc(channel.oauth2.account) : '') : '未授权'}</span>
        </div>
        <div id="ch-oauth-code" style="display:none;margin-top:10px;padding:12px;border:1px dashed var(--line);border-radius:10px">
          <div class="muted" style="font-size:12px">浏览器打开下面链接并输入这串码：</div>
          <div style="font-size:22px;letter-spacing:.18em;font-weight:700;margin:6px 0" id="ch-usercode">—</div>
          <div class="muted" style="font-size:12px" id="ch-uri"></div>
        </div>
        ` : ''}

        ${channel.type === 'smtp' || isOauth ? `
        <div class="form-row" style="margin-top:10px">
          <label>SMTP 主机 <input id="ch-host" value="${esc(channel.smtp.host ?? '')}" placeholder="smtp.example.com" style="width:210px" /></label>
          <label>端口 <input id="ch-port" type="number" value="${channel.smtp.port ?? 465}" style="width:80px" /></label>
          <label><input id="ch-secure" type="checkbox" ${channel.smtp.secure ? 'checked' : ''} /> SSL（465 勾选；587 不勾走 STARTTLS）</label>
          ${isOauth ? '' : `<label>认证方式
            <select id="ch-auth">
              ${[['login', 'AUTH LOGIN'], ['plain', 'AUTH PLAIN'], ['auto', '自动（按服务器能力）'], ['none', '不认证']]
                .map(([value, label]) => `<option value="${value}" ${channel.smtp.authMode === value ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
          </label>`}
        </div>
        ${isOauth ? '' : `
        <div class="form-row" style="margin-top:10px">
          <label>账号 <input id="ch-user" value="${esc(channel.smtp.user ?? '')}" placeholder="完整邮箱地址" style="width:260px" /></label>
          <label>密码 / 授权码 <input id="ch-pass" type="password" placeholder="${channel.smtp.passSet ? '已保存，留空不修改' : 'SMTP 密码或应用专用密码'}" style="width:240px" /></label>
        </div>`}
        ` : ''}

        <div class="form-row" style="margin-top:14px">
          <button class="btn primary" id="ch-save">保存通道</button>
          <input id="ch-test-to" placeholder="测试收件邮箱" style="width:230px" />
          <button class="btn" id="ch-test">连接测试 + 发测试邮件</button>
          <button class="btn" id="ch-cancel">取消</button>
          <span class="muted" id="ch-msg"></span>
        </div>
      </div>`

    let deviceCode = null
    let timer = null
    const stop = () => { if (timer) { clearInterval(timer); timer = null } }

    $('#ch-cancel').addEventListener('click', () => { stop(); editing = null; renderForm() })

    $('#ch-type').addEventListener('change', () => { collect(); editing.type = $('#ch-type').value; renderForm() })
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
        enabled: true,
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
        await api('/admin/api/email-channels', { method: 'POST', body: { id: editing.id || undefined, name: editing.name, type: 'oauth2', enabled: true, priority: editing.priority, from: editing.from, fromName: editing.fromName, smtp: { host: editing.smtp.host, port: editing.smtp.port, secure: editing.smtp.secure, user: editing.from }, oauth2: { tokenUrl: editing.oauth2.tokenUrl, deviceUrl: editing.oauth2.deviceUrl, clientId: editing.oauth2.clientId, scope: editing.oauth2.scope, ...(editing.oauth2.clientSecretInput ? { clientSecret: editing.oauth2.clientSecretInput } : {}) } } })
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
            if (result.ok) { stop(); $('#ch-oauth-state').textContent = '已授权：' + (result.account || '完成'); toast('授权成功'); await pageEmail() }
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
        $('#ch-oauth-state').textContent = '已授权：' + (result.account || '完成')
        toast('授权成功')
        await pageEmail()
      } catch (error) { $('#ch-msg').textContent = error.message }
    })
  }

  for (const button of view.querySelectorAll('[data-edit]')) {
    button.addEventListener('click', async () => {
      const channel = (await api('/admin/api/email-channels')).channels.find((item) => item.id === button.dataset.edit)
      editing = { ...channel, smtp: { ...channel.smtp }, oauth2: { ...channel.oauth2 }, http: { ...channel.http } }
      renderForm()
      $('#em-form').scrollIntoView({ block: 'start', behavior: 'smooth' })
    })
  }
  for (const button of view.querySelectorAll('[data-test]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.test
      button.disabled = true
      try {
        const result = await api(`/admin/api/email-channels/${id}/test`, { method: 'POST', body: {} })
        toast(result.note ?? '测试邮件已发送')
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
}

/* ---------------- 经营数据（播放 / 用户 / 订单 / 订阅多维统计） ---------------- */
const EVENT_LABEL = {
  impression: '曝光', detail_view: '详情页浏览', paywall_view: '付费墙展示', paywall_click: '付费墙点击',
  play_end: '播放结束', search: '搜索', share: '分享',
}

async function pageAnalytics() {
  const days = Number(localStorage.getItem('mh-analytics-days') ?? 7)
  const data = await api(`/admin/api/analytics?days=${days}`)
  const t = {
    upstream: {}, byType: [], completion: {}, searchTerms: [], topDetailViews: [],
    ...(data.tracking ?? {}),
  }
  const u = { detailViews: 0, paywallViews: 0, paywallClicks: 0, detailToPaywall: 0, paywallToOrder: 0, orderToPaid: 0, ...t.upstream }
  const comp = { samples: 0, avgRate: 0, finished: 0, ...t.completion }
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
          <tr><td>付费墙展示</td><td>${fmt(u.paywallViews)} <span class="muted">详情→付费墙 ${u.detailToPaywall}%</span></td></tr>
          <tr><td>付费墙点击</td><td>${fmt(u.paywallClicks)}</td></tr>
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

/* ---------------- 标签管理 ---------------- */
const TAG_LEVELS = [['all', '全部'], ['top', '一级标签'], ['child', '二级标签']]

async function pageTags() {
  const page = Number(state.params.tagPage ?? 1)
  const level = state.params.tagLevel ?? 'all'
  const keyword = (state.params.tagQ ?? '').trim()
  const showDisabled = state.params.tagDisabled ? '1' : ''
  const query = new URLSearchParams({ page: String(page), pageSize: '20', level, includeDisabled: '1' })
  if (keyword) query.set('keyword', keyword)
  if (showDisabled) query.set('includeDisabled', '1')
  const data = await api(`/admin/api/tags?${query.toString()}`)
  const byId = new Map((data.tree ?? []).map((node) => [node.id, node.name]))
  const pages = Math.max(1, Math.ceil((data.total ?? 0) / (data.pageSize || 20)))

  view.innerHTML = `
    <div class="panel">
      <h3>标签管理 <span class="muted">共 ${data.total ?? 0} 个</span></h3>
      <p class="muted">标签用于 C 端筛选与详情展示。启停开关即时生效；改名/换父级请点「编辑」。</p>
      <div class="form-row">
        <div class="subtabs">${TAG_LEVELS.map(([key, label]) => `<button class="pill ${level === key ? 'active' : ''}" data-level="${key}">${label}</button>`).join('')}</div>
        <input id="tag-q" placeholder="搜标签名" value="${esc(keyword)}" style="width:160px" />
        <button class="btn primary" id="tag-add">＋ 新增标签</button>
        <span class="muted">第 ${page} / ${pages} 页</span>
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
            <td><button class="btn sm ${tag.status === 'active' ? '' : 'ghost'}" data-status="${tag.id}" data-active="${tag.status === 'active' ? 1 : 0}">
              ${tag.status === 'active' ? '<span class="tag-state-on">● 启用</span>' : '<span class="tag-state-off">○ 停用</span>'}
            </button></td>
            <td class="row-actions">
              <button class="btn sm" data-edit="${tag.id}">编辑</button>
              <button class="btn sm danger" data-del="${tag.id}">删除</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">没有匹配的标签</td></tr>'}
        </tbody>
      </table>
      <div class="form-row" style="margin-top:12px">
        <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
      </div>
    </div>`

  const reload = () => pageTags()
  view.querySelectorAll('[data-level]').forEach((button) => button.addEventListener('click', () => {
    state.params.tagLevel = button.dataset.level
    state.params.tagPage = 1
    reload()
  }))
  $('#tag-q')?.addEventListener('change', (event) => {
    state.params.tagQ = event.target.value
    state.params.tagPage = 1
    reload()
  })
  view.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
    state.params.tagPage = Number(button.dataset.page)
    reload()
  }))
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

  $('#tag-add').addEventListener('click', () => openEditor(null))
  view.querySelectorAll('[data-edit]').forEach((button) => button.addEventListener('click', () => {
    const tag = (data.list ?? []).find((row) => String(row.id) === button.dataset.edit)
    openEditor(tag)
  }))
  view.querySelectorAll('[data-del]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm('删除该标签？会同时解除剧集关联。')) return
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
  const page = Number(state.params.eventPage ?? 1)
  const query = new URLSearchParams({ days: String(days), page: String(page), pageSize: '20' })
  if (type) query.set('type', type)
  const data = await api(`/admin/api/events?${query.toString()}`)
  const EVENT_LABEL = {
    impression: '曝光', detail_view: '详情页浏览', paywall_view: '付费墙展示', paywall_click: '付费墙点击',
    play_end: '播放结束', search: '搜索', share: '分享', category_filter: '分类筛选', rank_view: '榜单浏览', login_open: '打开登录',
  }
  const pages = Math.max(1, Math.ceil((data.total ?? 0) / (data.pageSize || 20)))

  view.innerHTML = `
    <div class="panel">
      <h3>埋点数据 <span class="muted">近 ${days} 天 · 共 ${fmt(data.total ?? 0)} 条</span></h3>
      <div class="form-row">
        <div class="subtabs">${[1, 7, 30].map((n) => `<button class="pill ${days === n ? 'active' : ''}" data-days="${n}">${n} 天</button>`).join('')}</div>
        <select id="ev-type" style="width:160px">
          <option value="">全部事件</option>
          ${(data.byType ?? []).map((row) => `<option value="${esc(row.type)}" ${type === row.type ? 'selected' : ''}>${esc(EVENT_LABEL[row.type] ?? row.type)}（${row.n}）</option>`).join('')}
        </select>
        <span class="muted">第 ${page} / ${pages} 页</span>
      </div>
      <table style="margin-top:12px">
        <thead><tr><th>时间</th><th>事件</th><th>用户</th><th>剧集</th><th>路径</th><th>数值</th><th>明细</th></tr></thead>
        <tbody>
          ${(data.list ?? []).map((row) => `<tr>
            <td class="muted">${esc(row.created_at)}</td>
            <td>${esc(EVENT_LABEL[row.type] ?? row.type)}</td>
            <td>${row.userEmail ? esc(row.userEmail) : (row.user_id ? `#${row.user_id}` : '游客')}</td>
            <td>${row.dramaTitle ? esc(row.dramaTitle) : (row.drama_id ? `#${row.drama_id}` : '—')}</td>
            <td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis">${esc(row.path ?? '—')}</td>
            <td>${row.value === null || row.value === undefined ? '—' : Number(row.value).toFixed(2)}</td>
            <td class="muted">${esc(row.meta ? JSON.stringify(row.meta) : '—')}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">还没有埋点数据：C 端产生浏览/播放后这里会实时出现</td></tr>'}
        </tbody>
      </table>
      <div class="form-row" style="margin-top:12px">
        <button class="btn sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn sm" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''}>下一页</button>
      </div>
      <h3 style="margin-top:18px">事件分布</h3>
      <table><thead><tr><th>事件</th><th>次数</th></tr></thead><tbody>
        ${(data.byType ?? []).map((row) => `<tr><td>${esc(EVENT_LABEL[row.type] ?? row.type)}</td><td>${fmt(row.n)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">—</td></tr>'}
      </tbody></table>
    </div>`

  view.querySelectorAll('[data-days]').forEach((button) => button.addEventListener('click', () => {
    state.params.eventDays = Number(button.dataset.days)
    state.params.eventPage = 1
    pageEvents()
  }))
  $('#ev-type')?.addEventListener('change', (event) => {
    state.params.eventType = event.target.value
    state.params.eventPage = 1
    pageEvents()
  })
  view.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
    state.params.eventPage = Number(button.dataset.page)
    pageEvents()
  }))
}

/* ---------------- 管理员账号（B 端） ---------------- */
async function pageAdmins() {
  const [data, roles] = await Promise.all([api('/admin/api/admins'), api('/admin/api/roles').catch(() => ({ roles: [] }))])
  const roleOptions = (roles.roles ?? []).map((role) => role.code)
  view.innerHTML = `
    <div class="panel">
      <h3>管理员账号 <span class="muted">B 端 ${data.list?.length ?? 0} 个 · C 端用户 ${fmt(data.users ?? 0)} 人</span></h3>
      <p class="muted">这里只列后台账号（B 端）；C 端注册用户在「用户 → C 端用户」里，两边不混表也不共用登录入口。</p>
      <table>
        <thead><tr><th>账号</th><th>类型</th><th>显示名</th><th>角色</th><th>状态</th><th>最近操作</th><th>创建时间</th></tr></thead>
        <tbody>
          ${(data.list ?? []).map((admin) => `<tr>
            <td><strong>${esc(admin.username)}</strong></td>
            <td><span class="pill">${esc(admin.kindLabel ?? 'B 端账号')}</span></td>
            <td>${esc(admin.display_name ?? '—')}</td>
            <td>${(admin.roles ?? []).map((role) => `<span class="pill">${esc(role.name)}</span>`).join(' ') || '<span class="muted">未分配</span>'}</td>
            <td>${admin.status === 'active' ? '<span class="pill ok">正常</span>' : `<span class="pill warn">${esc(admin.status)}</span>`}</td>
            <td class="muted">${esc(admin.lastAuditAt ?? '—')}</td>
            <td class="muted">${esc(admin.created_at ?? '—')}</td>
          </tr>`).join('') || '<tr><td colspan="7" class="muted">没有后台账号</td></tr>'}
        </tbody>
      </table>
      <p class="muted" style="margin-top:10px">角色分配在「系统设置 → 角色权限」里操作；后台口令策略为 8 位以上且同时含字母与数字。</p>
    </div>`
}
/* 启动 */
if (state.token) await boot()

