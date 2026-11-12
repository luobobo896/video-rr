import { translateText } from './i18n.js?v=20261112ops3'

const BASE = window.__MH_BASE || ''
const CATEGORY_ORDER = ['MOVIE', 'TV', 'PLAYLET', 'ANIME', 'DOCUMENTARY']
const CATEGORY_LABEL = {
  MOVIE: '电影', TV: '电视剧', PLAYLET: '短剧',
  ANIME: '动漫', COMIC: '动漫', DOCUMENTARY: '纪录片', VARIETY: '综艺',
}

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[ch])

const safeHttpUrl = (value) => {
  const raw = String(value ?? '').trim()
  return /^https?:\/\//i.test(raw) ? raw : ''
}

const assetUrl = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `${BASE}${raw.startsWith('/') ? '' : '/'}${raw}`
}

const playIcon = `
  <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
    <path d="M8 5.5v13l10.5-6.5L8 5.5Z" />
  </svg>`

const detailsOf = (item) => [item.year, item.categoryLabel ?? CATEGORY_LABEL[item.category] ?? item.category]
  .filter(Boolean).join(' · ')

function posterOf(item) {
  const variant = item.variants.find((row) => row.key === 'portrait') || item.variants[0]
  if (!variant) return ''
  return `
    <a class="pw-tile" href="#/drama/${encodeURIComponent(item.dramaId)}" aria-label="查看《${escapeHtml(item.title)}》">
      <img src="${escapeHtml(assetUrl(variant.url))}" alt="《${escapeHtml(item.title)}》海报" width="${variant.width}" height="${variant.height}" loading="lazy" decoding="async" />
      <span class="pw-play" aria-hidden="true">${playIcon}</span>
      <span class="pw-copy">
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(detailsOf(item))}</small>
      </span>
    </a>`
}

export async function renderPosterWall(view, api) {
  document.title = '海报墙 · 影巢'
  view.innerHTML = `
    <section class="pw-page">
      <div class="pw-head">
        <div class="pw-title-row">
          <h1>海报墙</h1>
          <span class="pw-count" id="pw-count">正在加载</span>
          <a class="pw-back" href="#/home"><span aria-hidden="true">←</span> <span>返回片库</span></a>
        </div>
        <div class="pw-filters" id="pw-filters" aria-label="按内容类型筛选"></div>
      </div>
      <div class="pw-grid" id="pw-grid" aria-live="polite" aria-busy="true">
        <p class="pw-status">正在加载海报…</p>
      </div>
      <footer class="pw-foot">
        <span>© 2026 影巢</span>
        <button class="pw-text-button" type="button" id="pw-credits-open">内容来源</button>
      </footer>
      <dialog class="pw-dialog" id="pw-credits-dialog" aria-labelledby="pw-credits-title">
        <div class="pw-dialog-head">
          <h2 id="pw-credits-title">内容来源</h2>
          <button class="pw-dialog-close" type="button" id="pw-credits-close" aria-label="关闭">×</button>
        </div>
        <p class="pw-dialog-intro">海报画面来自公开授权影片；CC BY 作品保留作者与机构署名。</p>
        <ul class="pw-credits" id="pw-credits-list"></ul>
      </dialog>
    </section>`

  const grid = view.querySelector('#pw-grid')
  const filterBar = view.querySelector('#pw-filters')
  const countNode = view.querySelector('#pw-count')
  const dialog = view.querySelector('#pw-credits-dialog')
  const creditsList = view.querySelector('#pw-credits-list')
  const data = await api('/api/poster-wall')
  const items = (data.items ?? []).filter((item) => item.variants?.length)
  let activeFilter = 'ALL'

  const visibleItems = () => activeFilter === 'ALL'
    ? items
    : items.filter((item) => item.category === activeFilter)

  const renderWall = () => {
    const visible = visibleItems()
    countNode.textContent = translateText(`${visible.length} 部`, countNode)
    grid.setAttribute('aria-busy', 'false')
    grid.innerHTML = visible.map(posterOf).join('')
      || '<p class="pw-status">这类内容还没有上架。</p>'
  }

  const counts = new Map()
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
  const categoryLabels = new Map(items.map((item) => [item.category, item.categoryLabel]))
  const filters = [
    { key: 'ALL', label: '全部', count: items.length },
    ...CATEGORY_ORDER.flatMap((key) => counts.has(key)
      ? [{ key, label: categoryLabels.get(key) ?? CATEGORY_LABEL[key], count: counts.get(key) }]
      : []),
  ]
  filterBar.innerHTML = filters.map((filter) => `
    <button class="pw-filter" type="button" data-filter="${filter.key}" aria-pressed="${filter.key === activeFilter}">
      ${escapeHtml(filter.label)} <span>${filter.count}</span>
    </button>`).join('')
  filterBar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]')
    if (!button) return
    activeFilter = button.dataset.filter
    filterBar.querySelectorAll('[data-filter]').forEach((node) => {
      node.setAttribute('aria-pressed', String(node === button))
    })
    renderWall()
  })

  creditsList.innerHTML = items.map((item) => {
    const sourceUrl = safeHttpUrl(item.sourceUrl)
    return `<li>
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.license || '')}</span>
      <span>${escapeHtml(item.credit || '')}</span>
      ${sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">来源 ↗</a>` : '<span></span>'}
    </li>`
  }).join('')
  view.querySelector('#pw-credits-open').addEventListener('click', () => dialog.showModal())
  view.querySelector('#pw-credits-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  renderWall()
}
