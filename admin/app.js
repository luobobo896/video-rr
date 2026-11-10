/** 影巢运营后台（原生 ESM，无构建）。 */
const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const nav = $('#nav')

const NAV = [
  ['dashboard', '概览', 'dashboard.read'],
  ['dramas', '剧集管理', 'content.drama.read'],
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
  ['pay', '支付配置', 'admin.write'],
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

/* ---------------- 登录 ---------------- */
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const tip = $('#login-tip')
  tip.textContent = ''
  try {
    const data = await api('/admin/api/login', { method: 'POST', body: { username: $('#login-user').value, password: $('#login-pass').value } })
    state.token = data.token
    localStorage.setItem('mh-admin-token', data.token)
    await boot()
  } catch (error) {
    tip.textContent = error.message
  }
})

$('#logout').addEventListener('click', () => logout())
function logout() {
  state.token = ''
  localStorage.removeItem('mh-admin-token')
  $('#shell').classList.add('hidden')
  $('#login').classList.remove('hidden')
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
  } catch (error) {
    view.innerHTML = `<div class="panel">加载失败：${esc(error.message)}</div>`
  }
}

/* ---------------- 概览 ---------------- */
async function pageDashboard() {
  const stats = await api('/admin/api/stats')
  $('#top-right').innerHTML = `<span class="muted">更新于 ${esc(new Date(stats.updatedAt).toLocaleTimeString())}</span>`
  view.innerHTML = `
    <div class="cards">
      ${card('剧集', fmt(stats.dramas), '部')}
      ${card('分集', fmt(stats.episodes), `集（就绪 ${stats.readyEpisodes}）`)}
      ${card('转码队列', `${stats.queue.pending}`, stats.queue.running ? `进行中：EP ${stats.queue.current?.episodeId}` : '空闲')}
      ${card('待审弹幕', fmt(stats.pendingDanmu), '条')}
      ${card('待审评论', fmt(stats.pendingComments), '条')}
      ${card('用户', fmt(stats.users), '人')}
      ${card('订单收入', `¥${fmt(stats.revenue)}`, `${stats.orders} 笔订单`)}
    </div>
    <div class="split">
      <div class="panel">
        <h3>转码队列</h3>
        ${stats.queue.pending === 0 && !stats.queue.running ? '<div class="muted">队列空闲：去「剧集管理 → 分集」上传视频或生成示例视频</div>' : `
          <table><thead><tr><th>分集</th><th>状态</th><th>进度</th></tr></thead><tbody>
            ${stats.queue.current ? `<tr><td>EP ${stats.queue.current.episodeId}</td><td><span class="pill warn">转码中</span></td><td>${esc(stats.queue.current.source ?? '')}</td></tr>` : ''}
            ${stats.queue.pendingItems.map((item) => `<tr><td>EP ${item.episodeId}</td><td><span class="pill">排队</span></td><td class="muted">第 ${item.no} 集</td></tr>`).join('')}
          </tbody></table>`}
      </div>
      <div class="panel">
        <h3>直播</h3>
        <div class="muted">MediaMTX：${stats.live.installed ? (stats.live.running ? '<span class="pill ok">运行中</span>' : '<span class="pill">已安装未启动</span>') : '<span class="pill bad">未安装</span>'}</div>
        <p class="mono" style="margin-top:10px">RTMP 入流：${esc(stats.live.rtmpBase)}/&lt;key&gt;</p>
        <p class="mono">HLS 出流：${esc(stats.live.hlsBase)}/&lt;key&gt;/index.m3u8</p>
        <a class="btn" href="#/live">去管理直播 →</a>
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
      <label class="muted">简介</label>
      <textarea id="f-description" rows="3" style="width:100%;margin-top:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-2);color:var(--text)">${esc(drama.description ?? '')}</textarea>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn primary" id="save-drama">保存</button>
        <a class="btn" href="#/dramas/${id}/episodes">管理分集与视频 →</a>
      </div>
    </div>`

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
      await api(`/admin/api/sections?id=${button.dataset.delSection}`, { method: 'DELETE' })
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
    <td class="mono">${esc(row.phone ?? '')}</td>
    <td>${esc(row.nickname)}</td>
    <td>${row.status === 'banned' ? '<span class="pill bad">已禁用</span>' : '<span class="pill ok">正常</span>'}</td>
    <td>${esc(row.vip_until ?? '—')}</td>
    <td>${row.order_count}</td>
    <td>¥${Number(row.paid_total).toFixed(2)}</td>
    <td><button class="btn sm" data-toggle="${row.id}" data-status="${row.status === 'banned' ? 'active' : 'banned'}">${row.status === 'banned' ? '解禁' : '禁用'}</button></td>
  </tr>`)
  view.innerHTML = `<div class="panel">
    <h3>用户<span class="spacer"></span></h3>
    <table><thead><tr><th>ID</th><th>手机号</th><th>昵称</th><th>状态</th><th>会员到期</th><th>订单数</th><th>累计付费</th><th>操作</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table>
    <p class="muted">客服补发权益：POST /admin/api/cs/grant（需 cs.toolkit 权限）。</p>
  </div>`
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
    <td>${['paid', 'fulfilled'].includes(order.status) ? `<button class="btn sm danger" data-refund="${order.id}">发起退款</button>` : '—'}</td>
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

/* ---------------- 角色权限 ---------------- */
async function pageRoles() {
  const [roleData, adminData] = await Promise.all([api('/admin/api/roles'), api('/admin/api/admins')])
  const domains = [...new Set(roleData.permissions.map((perm) => perm.domain))]
  const roleBlocks = roleData.roles.map((role) => `<div class="panel" style="background:var(--panel-2);margin-bottom:12px">
    <h3>${esc(role.name)} <span class="muted" style="font-size:12px">${esc(role.code)}</span><span class="spacer"></span>
      <button class="btn sm primary" data-save-role="${role.id}">保存权限</button></h3>
    <div class="perm-grid" data-role="${role.id}">
      ${domains.map((domain) => `<div class="perm-domain"><div class="muted">${esc(domain)}</div>
        ${roleData.permissions.filter((perm) => perm.domain === domain).map((perm) => `<label class="perm-item">
          <input type="checkbox" value="${perm.code}" ${role.permissions.includes(perm.code) ? 'checked' : ''} />
          <span title="${esc(perm.code)}">${esc(perm.name)}</span></label>`).join('')}
      </div>`).join('')}
    </div></div>`)
  const adminRows = adminData.list.map((admin) => `<tr>
    <td>${admin.id}</td><td class="mono">${esc(admin.username)}</td><td>${esc(admin.display_name ?? '')}</td>
    <td>${admin.roles.map((role) => esc(role.name)).join(' / ')}</td><td>${pillOf(admin.status)}</td>
  </tr>`)
  view.innerHTML = panel('角色权限', `
    <p class="muted">权限点：&lt;域&gt;.&lt;对象&gt;.&lt;动作&gt;。接口层是唯一可信校验，菜单只是渲染。</p>
    ${roleBlocks.join('')}
    <h3>管理员</h3>
    ${table(['ID', '账号', '姓名', '角色', '状态'], adminRows)}`)
  view.querySelectorAll('[data-save-role]').forEach((button) => {
    button.addEventListener('click', async () => {
      const box = view.querySelector(`[data-role="${button.dataset.saveRole}"]`)
      const permissions = [...box.querySelectorAll('input:checked')].map((input) => input.value)
      await api(`/admin/api/roles/${button.dataset.saveRole}`, { method: 'PUT', body: { permissions } })
      toast('权限已保存（权限变更需重新登录生效）')
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

/* ---------------- 支付配置 ---------------- */
async function pagePay() {
  const data = await api('/admin/api/pay-settings')
  view.innerHTML = panel('支付配置', `
    <p class="muted">mock 仅演示用，生产必须关闭；支付宝需 appId + 商户私钥 + 支付宝公钥；USDT 填收款地址与最小确认数。</p>
    <div class="form-row"><label>USDT 汇率（1 USDT = ? CNY）<input id="usdt-rate" type="number" step="0.01" value="${data.usdtRate}" style="width:110px" /></label></div>
    <textarea id="pay-json" class="mono" style="width:100%;height:340px;background:var(--panel-2);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px">${esc(JSON.stringify(data.pay, null, 2))}</textarea>
    <div style="margin-top:12px"><button class="btn primary" id="pay-save">保存</button></div>`)
  $('#pay-save').addEventListener('click', async () => {
    let pay
    try { pay = JSON.parse($('#pay-json').value) } catch { return toast('JSON 格式错误') }
    await api('/admin/api/pay-settings', { method: 'PUT', body: { pay, usdtRate: Number($('#usdt-rate').value) } })
    toast('已保存')
  })
}

/* 启动 */
if (state.token) await boot()
