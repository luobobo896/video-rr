/** 影巢运营后台（原生 ESM，无构建）。 */
const BASE = window.__MH_BASE || ''
const mediaUrl = (url) => (!url ? '' : /^https?:/i.test(url) ? url : BASE + url)
const $ = (selector, root = document) => root.querySelector(selector)
const view = $('#view')
const nav = $('#nav')

const NAV = [
  ['dashboard', '概览'],
  ['dramas', '剧集管理'],
  ['ops', '首页运营'],
  ['ranks', '榜单'],
  ['review', '内容审核'],
  ['users', '用户与订单'],
  ['live', '直播推流'],
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
  nav.innerHTML = NAV.map(([key, label]) => `<a class="nav-item ${state.page === key ? 'active' : ''}" href="#/${key}">${label}</a>`).join('')
}

window.addEventListener('hashchange', () => route())

async function boot() {
  try {
    await api('/admin/api/me')
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
    else if (key === 'ops') await pageOps()
    else if (key === 'ranks') await pageRanks()
    else if (key === 'review') await pageReview()
    else if (key === 'users') await pageUsers()
    else if (key === 'live') await pageLive()
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

/* ---------------- 用户与订单 ---------------- */
async function pageUsers() {
  const [users, orders] = await Promise.all([api('/admin/api/users'), api('/admin/api/orders')])
  view.innerHTML = `
    <div class="panel"><h3>用户 <span class="muted">${users.list.length}</span></h3>
      <table><thead><tr><th>ID</th><th>手机号</th><th>昵称</th><th>VIP</th><th>到期</th></tr></thead><tbody>
        ${users.list.map((row) => `<tr><td>${row.id}</td><td class="mono">${esc(row.phone ?? '')}</td><td>${esc(row.nickname)}</td>
          <td>${row.is_vip ? '<span class="pill warn">VIP</span>' : '<span class="pill">普通</span>'}</td><td class="muted">${esc(row.vip_expire_at ?? '—')}</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="panel"><h3>订单 <span class="muted">收入 ¥${fmt(orders.revenue)}</span><span class="spacer"></span>
        <button class="btn primary" id="new-order">新建订单</button></h3>
      <table><thead><tr><th>ID</th><th>用户</th><th>SKU</th><th>金额</th><th>状态</th><th>时间</th><th>操作</th></tr></thead><tbody>
        ${orders.list.map((row) => `<tr><td>${row.id}</td><td>${esc(row.nickname ?? row.user_id)}</td><td>${esc(row.sku)}</td>
          <td>¥${row.amount}</td><td>${row.status === 'paid' ? '<span class="pill ok">已支付</span>' : '<span class="pill warn">待支付</span>'}</td>
          <td class="muted">${esc(row.created_at)}</td>
          <td>${row.status === 'paid' ? '' : `<button class="btn sm" data-pay="${row.id}">标记已支付</button>`}</td></tr>`).join('')}
      </tbody></table>
    </div>`
  $('#new-order').addEventListener('click', async () => {
    await api('/admin/api/orders', { method: 'POST', body: { userId: 1, sku: 'vip-year', amount: 88 } })
    await pageUsers()
  })
  view.querySelectorAll('[data-pay]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/admin/api/orders/${button.dataset.pay}/pay`, { method: 'POST', body: {} })
      toast('已标记支付并开通 VIP')
      await pageUsers()
    })
  })
}

/* ---------------- 直播 ---------------- */
async function pageLive() {
  const live = await api('/admin/api/live')
  view.innerHTML = `
    <div class="panel">
      <h3>推流服务 <span class="spacer"></span>
        <button class="btn ${live.running ? 'danger' : 'primary'}" id="toggle-live">${live.running ? '停止 MediaMTX' : '启动 MediaMTX'}</button>
      </h3>
      <div class="split">
        <div>
          <div class="muted">状态</div>
          <div style="margin:6px 0 14px">${live.running ? '<span class="pill ok">运行中</span>' : live.installed ? '<span class="pill">已安装未启动</span>' : '<span class="pill bad">未安装</span>'}</div>
          <div class="muted">RTMP 入流（OBS 推流地址，串流密钥 = key）</div>
          <div class="mono" style="margin:6px 0 14px">${esc(live.rtmpBase)}/&lt;key&gt;</div>
          <div class="muted">HLS 出流（播放器/浏览器）</div>
          <div class="mono" style="margin:6px 0 14px">${esc(live.hlsBase)}/&lt;key&gt;/index.m3u8</div>
          ${live.lastError ? `<div class="muted" style="color:#ffb4b4">${esc(live.lastError)}</div>` : ''}
        </div>
        <div>
          <div class="muted">用 ffmpeg 模拟一路推流（本机测试）</div>
          <pre class="mono" style="background:var(--panel-2);padding:10px;border-radius:8px;white-space:pre-wrap">ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -c:v libx264 -preset veryfast -g 60 -c:a aac -f flv rtmp://127.0.0.1:1935/live/demo</pre>
          <div class="muted">推上去后，把 <span class="mono">/live/demo/index.m3u8</span> 填进 C 端播放器即可看到画面。</div>
        </div>
      </div>
    </div>
    <div class="panel">
      <h3>直播频道<span class="spacer"></span><button class="btn primary" id="add-stream">新增频道</button></h3>
      <table><thead><tr><th>ID</th><th>名称</th><th>key</th><th>状态</th><th>操作</th></tr></thead><tbody>
        ${live.streams.map((stream) => `<tr>
          <td>${stream.id}</td><td>${esc(stream.name)}</td><td class="mono">${esc(stream.stream_key)}</td>
          <td>${stream.status === 'active' ? '<span class="pill ok">推流中</span>' : '<span class="pill">空闲</span>'}</td>
          <td class="row-actions">
            <button class="btn sm" data-copy="${esc(live.rtmpBase)}/${esc(stream.stream_key)}">复制推流地址</button>
            <button class="btn sm danger" data-del-stream="${stream.id}">删除</button>
          </td></tr>`).join('')}
      </tbody></table>
    </div>`
  $('#toggle-live').addEventListener('click', async () => {
    await api('/admin/api/live', { method: 'POST', body: { action: live.running ? 'stop' : 'start' } })
    await pageLive()
  })
  $('#add-stream').addEventListener('click', async () => {
    const name = prompt('频道名称')
    if (!name) return
    const key = prompt('推流 key（英文/数字）', `live${Date.now()}`) ?? `live${Date.now()}`
    await api('/admin/api/live', { method: 'POST', body: { action: 'create', name, key } })
    await pageLive()
  })
  view.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(button.dataset.copy); toast('已复制') } catch { toast(button.dataset.copy) }
    })
  })
  view.querySelectorAll('[data-del-stream]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api('/admin/api/live', { method: 'POST', body: { action: 'delete', id: Number(button.dataset.delStream) } })
      await pageLive()
    })
  })
}

/* 启动 */
if (state.token) await boot()
