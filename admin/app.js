/** 影巢运营后台（原生 ESM，无构建）。 */
const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const nav = $('#nav')

const NAV = [
  ['dashboard', '概览', 'dashboard.read'],
  ['analytics', '经营数据', 'analytics.read'],
  ['dramas', '剧集管理', 'content.drama.read'],
  ['tags', '标签管理', 'tag.read'],
  ['policies', '付费策略', 'content.drama.read'],
  ['plans', '套餐定价', 'commerce.plan.write'],
  ['coupons', '优惠券', 'commerce.coupon.write'],
  ['orders', '订单', 'finance.order.read'],
  ['refunds', '退款审核', 'finance.refund.create'],
  ['ops', '首页运营', 'ops.banner.write'],
  ['ranks', '榜单', 'ops.rank.write'],
  ['review', '内容审核', 'content.review'],
  ['users', '用户', 'user.read'],
  ['roles', '角色权限', 'admin.read'],
  ['audit', '审计日志', 'audit.read'],
  ['pay', '支付渠道', 'payment.channel.read'],
  ['email', '邮件设置', 'email.read'],
]

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
  const res = await fetch(url, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : (options.body instanceof Blob ? options.body : JSON.stringify(options.body)),
  })
  const json = await res.json().catch(() => ({ code: '0000', data: {} }))
  if (json.code === '0401') { logout(); throw new Error(json.msg ?? '未登录') }
  if (json.code !== '0000') throw new Error(json.msg ?? `请求失败 ${path}`)
  return json.data
}

function clearTimers() {
  for (const timer of state.timers) clearInterval(timer)
  state.timers = []
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
function renderNav() {
  const perms = new Set(state.me?.permissions ?? [])
  nav.innerHTML = NAV.filter(([, , perm]) => perms.has(perm))
    .map(([key, label]) => `<a class="nav-item ${state.page === key ? 'active' : ''}" href="#/${key}">${label}</a>`).join('')
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
  const key = NAV.find(([id]) => id === state.page) ? state.page : 'dashboard'
  $('#page-title').textContent = NAV.find(([id]) => id === key)[1]
  renderNav()
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
  const commerce = stats.commerce ?? {}
  $('#top-right').innerHTML = `<span class="muted">更新于 ${new Date().toLocaleTimeString('zh-CN')}</span>`
  view.innerHTML = `
    <div class="cards">
      ${card('剧集', fmt(stats.dramas), '部')}
      ${card('分集', fmt(stats.episodes), `集（就绪 ${fmt(stats.readyEpisodes)}）`)}
      ${card('转码队列', fmt(queue.pending), queue.running ? `进行中：EP ${queue.current?.episodeId ?? '-'}` : '空闲')}
      ${card('待审弹幕', fmt(stats.pendingDanmu), '条')}
      ${card('待审评论', fmt(stats.pendingComments), '条')}
      ${card('用户', fmt(stats.users), '人')}
      ${card('订单收入', `¥${fmt(commerce.revenue ?? 0)}`, `${fmt(commerce.orders ?? 0)} 笔订单`)}
    </div>
    <div class="split">
      <div class="panel">
        <h3>转码队列</h3>
        ${queue.pending === 0 && !queue.running ? '<div class="muted">队列空闲：去「剧集管理 → 分集」上传视频或生成示例视频</div>' : `
          <table><thead><tr><th>分集</th><th>状态</th><th>进度</th></tr></thead><tbody>
            ${queue.current ? `<tr><td>EP ${queue.current.episodeId}</td><td><span class="pill warn">转码中</span></td><td>${esc(queue.current.source ?? '')}</td></tr>` : ''}
            ${(queue.pendingItems ?? []).map((item) => `<tr><td>EP ${item.episodeId}</td><td><span class="pill">排队</span></td><td class="muted">第 ${item.no} 集</td></tr>`).join('')}
          </tbody></table>`}
      </div>
      <div class="panel">
        <h3>收款与订阅</h3>
        <table>
          <tbody>
            <tr><td>累计收入</td><td>¥${fmt(commerce.revenue ?? 0)}</td></tr>
            <tr><td>已支付订单</td><td>${fmt(commerce.paidOrders ?? 0)} 笔</td></tr>
            <tr><td>待支付订单</td><td>${fmt(commerce.pendingOrders ?? 0)} 笔</td></tr>
            <tr><td>待审退款</td><td>${fmt(commerce.pendingRefunds ?? 0)} 笔 ${(commerce.pendingRefunds ?? 0) > 0 ? '<a href="#/refunds">去处理 →</a>' : ''}</td></tr>
            <tr><td>活跃订阅</td><td>${fmt(commerce.activeSubscriptions ?? 0)} 个</td></tr>
            <tr><td>已购单片</td><td>${fmt(commerce.purchases ?? 0)} 个</td></tr>
          </tbody>
        </table>
        <p class="muted" style="margin-top:10px">
          发信通道状态：${stats.mailReady ? '<span class="pill ok">已配置真实通道</span>' : '<span class="pill warn">未配置通道（验证码无法发送）</span>'}
          <a href="#/email">去配置 →</a>
        </p>
      </div>
    </div>`
}

const card = (key, value, unit) => `<div class="card"><div class="k">${esc(key)}</div><div class="v">${value} <small>${esc(unit)}</small></div></div>`

/* ---------------- 剧集 ---------------- */
async function pageDramas() {
  const idMatch = /^#\/dramas\/(\d+)(?:\/episodes)?$/.exec(location.hash)
  if (idMatch) {
    if (location.hash.endsWith('/episodes')) return pageEpisodes(Number(idMatch[1]))
    return pageDramaEdit(Number(idMatch[1]))
  }

  const data = await api('/admin/api/dramas')
  view.innerHTML = `
    <div class="panel">
      <h3>剧集库 <span class="muted">共 ${data.list.length} 部</span><span class="spacer"></span>
        <button class="btn primary" id="new-drama">新建剧集</button>
      </h3>
      <table>
        <thead><tr><th>封面</th><th>标题</th><th>类型</th><th>收费</th><th>分集</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          ${data.list.map((row) => `
            <tr>
              <td><img class="mini" src="${esc(mediaUrl(row.cover_url))}" alt="" onerror="this.style.visibility='hidden'" /></td>
              <td>${esc(row.title)}<div class="muted">${esc(row.sub_title ?? '')}</div></td>
              <td>${esc(row.category ?? '')}</td>
              <td>${row.fee_mode === 'vip' ? '<span class="pill warn">VIP</span>' : '<span class="pill">免费</span>'}</td>
              <td>${row.episodeCount}</td>
              <td>${row.status === 'published' ? '<span class="pill ok">已上架</span>' : '<span class="pill">草稿</span>'}</td>
              <td class="row-actions">
                <a class="btn sm" href="#/dramas/${row.id}">编辑</a>
                <a class="btn sm" href="#/dramas/${row.id}/episodes">分集/视频</a>
                <button class="btn sm danger" data-del="${row.id}">删除</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`

  $('#new-drama').addEventListener('click', async () => {
    const title = prompt('剧集标题')
    if (!title) return
    const data = await api('/admin/api/dramas', { method: 'POST', body: { title, coverUrl: '', category: 'TV' } })
    location.hash = `#/dramas/${data.id}`
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

async function pageDramaEdit(id) {
  const data = await api(`/admin/api/dramas/${id}`)
  const drama = data.drama
  const allTags = await api('/admin/api/tags').then((result) => result.list).catch(() => [])
  const currentTags = new Set((drama.tags ?? []).map((tag) => Number(tag.id ?? tag.tag_id)))
  view.innerHTML = `
    <div class="panel">
      <h3>编辑剧集 #${id}<span class="spacer"></span><a class="btn" href="#/dramas">返回列表</a></h3>
      <div class="form">
        ${field('title', '标题', drama.title)}
        ${field('subTitle', '副标题', drama.sub_title)}
        ${field('coverUrl', '封面地址', drama.cover_url)}
        ${field('category', '类型（TV/MOVIE/PLAYLET…）', drama.category)}
        ${field('year', '年份', drama.year, 'number')}
        ${field('area', '地区', drama.area)}
        ${field('score', '评分', drama.score, 'number')}
        <label>收费<select id="f-feeMode"><option value="free" ${drama.fee_mode === 'free' ? 'selected' : ''}>免费</option><option value="vip" ${drama.fee_mode === 'vip' ? 'selected' : ''}>VIP</option></select></label>
        <label>状态<select id="f-status"><option value="published" ${drama.status === 'published' ? 'selected' : ''}>已上架</option><option value="draft" ${drama.status === 'draft' ? 'selected' : ''}>草稿</option></select></label>
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
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn primary" id="save-drama">保存</button>
        <button class="btn" id="save-tags">保存标签</button>
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

    $('#save-drama').addEventListener('click', async () => {
    await api(`/admin/api/dramas/${id}`, {
      method: 'PUT',
      body: {
        title: $('#f-title').value, subTitle: $('#f-subTitle').value, coverUrl: $('#f-coverUrl').value,
        category: $('#f-category').value, year: Number($('#f-year').value), area: $('#f-area').value,
        score: Number($('#f-score').value), feeMode: $('#f-feeMode').value, status: $('#f-status').value,
        description: $('#f-description').value,
      },
    })
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
async function pageRanks() {
  const data = await api('/admin/api/ranks')
  view.innerHTML = `
    <div class="panel">
      <h3>榜单配置<span class="spacer"></span><button class="btn primary" id="add-rank">新增榜单</button></h3>
      ${data.list.map((list) => `
        <div style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:10px">
          <div style="display:flex;gap:10px;align-items:center">
            <strong>${esc(list.name)}</strong><span class="muted">${esc(list.type)} · #${list.id}</span>
            <span class="spacer" style="flex:1"></span>
            <button class="btn sm" data-attach-rank="${list.id}">加榜单项</button>
          </div>
          <div class="muted" style="margin-top:6px">${list.items.map((item) => `${item.rank_no}. #${item.drama_id} ${esc(item.title)}`).join(' · ') || '（空）'}</div>
        </div>`).join('')}
    </div>`
  $('#add-rank').addEventListener('click', async () => {
    const name = prompt('榜单名称')
    if (!name) return
    const type = prompt('类型 HOT/SEARCH/RISE/CLASSIC', 'HOT') ?? 'HOT'
    await api('/admin/api/ranks', { method: 'POST', body: { name, type } })
    await pageRanks()
  })
  view.querySelectorAll('[data-attach-rank]').forEach((button) => {
    button.addEventListener('click', async () => {
      const dramaId = prompt('剧集 ID')
      const rankNo = prompt('名次', '1')
      if (!dramaId) return
      await api('/admin/api/ranks', { method: 'POST', body: { action: 'attach', listId: Number(button.dataset.attachRank), dramaId: Number(dramaId), rankNo: Number(rankNo ?? 0) } })
      await pageRanks()
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

/* ---------------- 付费策略 ---------------- */
async function pagePolicies() {
  const data = await api('/admin/api/dramas')
  const rows = data.list.map((drama) => {
    const policy = drama.policy ?? { access_mode: 'subscription', free_episodes: 1, trial_seconds: 0, single_price_cny: 0 }
    return `<tr data-row="${drama.id}">
      <td>${drama.id}</td>
      <td>${esc(drama.title)}</td>
      <td><select data-f="accessMode">${['free', 'subscription', 'paid'].map((mode) => `<option value="${mode}" ${policy.access_mode === mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></td>
      <td><input data-f="freeEpisodes" type="number" min="0" value="${policy.free_episodes}" style="width:70px" /></td>
      <td><input data-f="trialSeconds" type="number" min="0" value="${policy.trial_seconds}" style="width:80px" /></td>
      <td><input data-f="singlePrice" type="number" min="0" step="0.01" value="${policy.single_price_cny}" style="width:80px" /></td>
      <td><button class="btn sm primary" data-save="${drama.id}">保存</button></td>
    </tr>`
  })
  view.innerHTML = panel('内容付费策略', `
    <p class="muted">access_mode：free=免费 / subscription=会员 / paid=单片付费；free_episodes=前几集免费；trial_seconds=未授权试看秒数。</p>
    ${table(['ID', '剧名', '模式', '免费集', '试看(秒)', '单片价', '保存'], rows)}`)
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
}

/* ---------------- 套餐 ---------------- */
async function pagePlans() {
  const data = await api('/admin/api/plans')
  const rows = data.list.map((plan) => `<tr>
    <td>${plan.id}</td><td class="mono">${esc(plan.code)}</td><td>${esc(plan.name)}</td>
    <td>¥${Number(plan.price_cny).toFixed(2)}</td><td>${plan.duration_days}</td><td>${esc(plan.scope)}</td>
    <td>${pillOf(plan.status)}</td>
    <td><button class="btn sm" data-toggle-plan="${plan.id}" data-status="${plan.status === 'active' ? 'disabled' : 'active'}">${plan.status === 'active' ? '下架' : '上架'}</button></td>
  </tr>`)
  view.innerHTML = panel('套餐定价', `
    <div class="form-row">
      <input id="plan-name" placeholder="套餐名（月卡会员）" />
      <input id="plan-days" type="number" placeholder="天数" value="30" style="width:90px" />
      <input id="plan-price" type="number" step="0.01" placeholder="价格" style="width:100px" />
      <button class="btn primary" id="plan-add">新增套餐</button>
    </div>
    ${table(['ID', '编码', '名称', '价格', '天数', '范围', '状态', '操作'], rows)}`)
  $('#plan-add').addEventListener('click', async () => {
    const name = $('#plan-name').value.trim()
    if (!name) return toast('请填套餐名')
    await api('/admin/api/plans', {
      method: 'POST',
      body: { name, days: Number($('#plan-days').value || 30), price: Number($('#plan-price').value || 0), code: `plan-${Date.now()}` },
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
  const rows = data.list.map((coupon) => `<tr>
    <td>${coupon.id}</td><td class="mono">${esc(coupon.code)}</td><td>${esc(coupon.name)}</td>
    <td>${coupon.discount_type === 'amount' ? '立减' : '折扣'}</td>
    <td>${coupon.discount_type === 'amount' ? '¥' + coupon.discount_value : coupon.discount_value + '%'}</td>
    <td>¥${coupon.min_amount}</td><td>${coupon.used}/${coupon.total || '∞'}</td>
    <td>${esc(coupon.valid_to ?? '—')}</td><td>${pillOf(coupon.status)}</td>
    <td><button class="btn sm" data-c-status="${coupon.id}" data-status="${coupon.status === 'active' ? 'disabled' : 'active'}">${coupon.status === 'active' ? '停用' : '启用'}</button></td>
  </tr>`)
  view.innerHTML = panel('优惠券', `
    <div class="form-row">
      <input id="c-code" placeholder="券码（WELCOME10）" />
      <input id="c-name" placeholder="名称" />
      <select id="c-type"><option value="amount">立减</option><option value="percent">折扣(%)</option></select>
      <input id="c-value" type="number" step="0.01" placeholder="面额/折扣" style="width:110px" />
      <input id="c-min" type="number" step="0.01" placeholder="门槛" style="width:90px" />
      <button class="btn primary" id="c-add">新增</button>
    </div>
    ${table(['ID', '券码', '名称', '类型', '面额', '门槛', '已用/总量', '有效期', '状态', '操作'], rows)}`)
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
    <td class="row-actions">${refund.status === 'pending' ? `<button class="btn sm primary" data-approve="${refund.id}">通过</button>
      <button class="btn sm danger" data-reject="${refund.id}">驳回</button>` : '—'}</td>
  </tr>`)
  view.innerHTML = panel('退款审核', `
    <p class="muted">双人复核：发起人不能审批自己的退款单；通过后立即回收权益并标记订单已退款。</p>
    ${table(['ID', '单号', '用户', '金额', '原因', '状态', '操作'], rows)}`)
  view.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', async () => {
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
async function pageTags() {
  const data = await api('/admin/api/tags')
  const rows = data.list.map((tag) => `<tr>
    <td>${tag.id}</td>
    <td><input value="${esc(tag.name)}" data-name="${tag.id}" style="width:180px" /></td>
    <td><input type="number" value="${tag.sort}" data-sort="${tag.id}" style="width:80px" /></td>
    <td>${fmt(tag.dramaCount)}</td>
    <td><span class="pill ${tag.status === 'active' ? 'ok' : ''}">${tag.status === 'active' ? '启用' : '停用'}</span></td>
    <td>
      <button class="btn sm" data-save="${tag.id}">保存</button>
      <button class="btn sm danger" data-del="${tag.id}">删除</button>
    </td>
  </tr>`).join('')

  view.innerHTML = panel('标签管理', `
    <p class="muted">标签用于 C 端筛选与详情展示；改完后到「剧集管理」里给剧集打标。删除标签会同时解除剧集关联。</p>
    <div class="form-row">
      <label>新标签 <input id="tag-name" placeholder="如：甜宠 / 悬疑 / 高分" style="width:200px" /></label>
      <label>排序 <input id="tag-sort" type="number" value="100" style="width:80px" /></label>
      <button class="btn primary" id="tag-add">新增标签</button>
      <span class="muted" id="tag-msg"></span>
    </div>
    <table style="margin-top:12px">
      <thead><tr><th>ID</th><th>名称</th><th>排序</th><th>剧集数</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">还没有标签</td></tr>'}</tbody>
    </table>`)

  $('#tag-add').addEventListener('click', async () => {
    const name = $('#tag-name').value.trim()
    if (!name) return
    try {
      await api('/admin/api/tags', { method: 'POST', body: { name, sort: Number($('#tag-sort').value || 100) } })
      toast('标签已新增')
      await pageTags()
    } catch (error) { $('#tag-msg').textContent = error.message }
  })

  for (const button of view.querySelectorAll('[data-save]')) {
    button.addEventListener('click', async () => {
      const id = button.dataset.save
      const name = view.querySelector(`[data-name="${id}"]`).value.trim()
      const sort = Number(view.querySelector(`[data-sort="${id}"]`).value || 100)
      try {
        await api('/admin/api/tags', { method: 'POST', body: { id: Number(id), name, sort } })
        toast('已保存')
        await pageTags()
      } catch (error) { toast(error.message) }
    })
  }
  for (const button of view.querySelectorAll('[data-del]')) {
    button.addEventListener('click', async () => {
      await api(`/admin/api/tags?id=${button.dataset.del}`, { method: 'DELETE' })
      toast('已删除')
      await pageTags()
    })
  }
}

/* 启动 */
if (state.token) await boot()

