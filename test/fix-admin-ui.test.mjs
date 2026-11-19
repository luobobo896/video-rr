import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createSequencer,
  couponValidTo,
  episodesSignature,
  formatClock,
  hydrateListState,
  nextTopPriority,
  pickAllowedNumber,
  selectionSummary,
  toggleSelection,
  validateCouponDraft,
  writeHashQuery,
} from '../admin/table-state.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const readAdmin = (name) => readFileSync(`${root}admin/${name}`, 'utf8')

const appJs = readAdmin('app.js')
const stylesCss = readAdmin('styles.css')
const modernCss = readAdmin('modern.css')
const ordersVue = readAdmin('components/AdminOrdersPage.vue')
const dataTableVue = readAdmin('components/AdminDataTable.vue')

/** 截取某个选择器/片段附近的源码，避免整文件里到处都有同名符号时断言失真。 */
const sliceAround = (source, marker, before = 400, after = 2400) => {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `源码里找不到锚点：${marker}`)
  return source.slice(Math.max(0, at - before), at + after)
}

/** 从某函数起点向后截取，用于同一文件里多处同名选择器（如 [data-del]）时锁定页面。 */
const sliceSince = (source, marker, length = 4000) => {
  const at = source.indexOf(marker)
  assert.notEqual(at, -1, `源码里找不到锚点：${marker}`)
  return source.slice(at, at + length)
}

// ---------------------------------------------------------------- P1-1 分集轮询幂等收口

test('分集表格指纹：内容一样时指纹相同，任一字段变化即不同', () => {
  const rows = [{ id: 1, no: 1, title: '第一集', status: 'ready', progress: 100, vip: 0 }]
  assert.equal(episodesSignature(rows), episodesSignature([...rows]))
  assert.notEqual(episodesSignature(rows), episodesSignature([{ ...rows[0], status: 'processing' }]))
  assert.notEqual(episodesSignature(rows), episodesSignature([{ ...rows[0], progress: 99 }]))
  assert.equal(episodesSignature(), '')
  assert.equal(episodesSignature(null), '')
})

test('分集轮询：定时器先清旧再登记，内容未变不重建 tbody，重建后恢复滚动与焦点（静态断言）', () => {
  const timer = sliceAround(appJs, 'function startPageTimer(')
  assert.match(timer, /stopTimers\(name\)/, 'startPageTimer 必须先停同名旧 timer，避免同页重入累积')
  assert.match(timer, /pageTimers\.set\(name, id\)/)
  const polling = sliceAround(appJs, "startPageTimer('episodes'")
  assert.match(polling, /const next = episodesSignature\(fresh\.list\)/);
  assert.match(polling, /if \(next === signature\) return/, '内容没变时不重建 #ep-body')
  assert.match(polling, /view\.scrollTop = scrollTop/)
  assert.match(polling, /focus\(\{ preventScroll: true \}\)/)
})

// ---------------------------------------------------------------- P1-2 每个 route 都能离开骨架屏

test('路由兜底：未实现的路由渲染 501 而不是留在骨架屏（静态断言）', () => {
  assert.match(appJs, /renderErrorPage\(\{[\s\S]{0,120}code: '501'/)
  const chain = sliceAround(appJs, "key === 'ops'", 200, 6000)
  assert.match(chain, /else\s*renderErrorPage\(/, 'if 链末尾必须有 else 兜底')
})

// ---------------------------------------------------------------- P1-3 全局请求序号守卫

test('请求序号守卫：只有最新一次 begin 的 token 算最新，其余作废', () => {
  const seq = createSequencer()
  const first = seq.begin('/admin/api/users')
  const second = seq.begin('/admin/api/users')
  assert.notEqual(first, second)
  assert.equal(seq.isLatest('/admin/api/users', first), false)
  assert.equal(seq.isLatest('/admin/api/users', second), true)
  const other = seq.begin('/admin/api/orders')
  assert.equal(seq.isLatest('/admin/api/orders', other), true)
  assert.equal(seq.isLatest('/admin/api/users', second), true, '不同接口互不影响')
  seq.forget('/admin/api/orders')
  assert.equal(seq.isLatest('/admin/api/orders', other), false)
  seq.reset()
  assert.equal(seq.tokenOf('/admin/api/users'), 0)
})

test('api() 接入序号守卫：慢响应不覆盖新结果，被取代的请求不抛真实错误（静态断言）', () => {
  const wrapper = sliceAround(appJs, 'async function api(', 0, 1800)
  assert.match(wrapper, /apiSequencer\.begin\(/)
  assert.match(wrapper, /apiSequencer\.isLatest\(/)
  assert.match(wrapper, /code: 'stale'/, '被取代的请求要以 stale 收场，不能冒泡成页面错误')
  assert.match(appJs, /async function request\(path, options = \{\}\)/)
})

// ---------------------------------------------------------------- P1-4 OAuth 轮询随弹层关闭

test('OAuth 轮询：弹层关闭统一走 onClose 清理，重开前先 stop（静态断言）', () => {
  assert.match(appJs, /const closeOverlay = openOverlay\(/);
  assert.match(appJs, /null, \{ onClose: stop \}\)/)
  assert.match(appJs, /const closeForm = \(\) => closeOverlay\(\)/)
  assert.doesNotMatch(appJs, /closest\('\.modal-mask'\)\?\.remove\(\)/, '直接 remove 会绕过 onClose，轮询停不下来')
  const changeType = sliceAround(appJs, "$('#ch-type').addEventListener('change'")
  assert.match(changeType, /stop\(\)/, '切换通道类型前必须停掉旧轮询')
  const start = sliceAround(appJs, "$('#ch-oauth-start')?.addEventListener('click'")
  assert.match(start, /stop\(\)/, '再次生成授权码前必须停掉旧轮询')
})

// ---------------------------------------------------------------- P1-5 邮件通道删除/停用

test('邮件通道删除：二次确认说明「全站验证码将无法发送」，失败有 toast（静态断言）', () => {
  const del = sliceSince(appJs, 'async function pageEmail()', 60000)
  assert.match(del, /askConfirm\(/)
  assert.match(del, /删除后若没有其它启用通道，全站验证码将无法发送/)
  assert.match(del, /catch/)
  assert.match(del, /toast\(`删除失败/)
})

test('邮件通道停用：停用最后一条启用通道前二次确认（静态断言）', () => {
  const toggle = sliceSince(appJs, 'async function pageEmail()', 60000)
  assert.match(toggle, /askConfirm\(/)
  assert.match(toggle, /停用后没有任何可用发信通道/)
  assert.match(toggle, /catch/)
  assert.match(toggle, /aria-busy/)
})

// ---------------------------------------------------------------- P1-6 上下架/删除守卫

test('上下架与删除剧集：请求期间禁用按钮、失败 toast 并复原（静态断言）', () => {
  const publish = sliceAround(appJs, "querySelectorAll('[data-toggle-publish]').forEach")
  assert.match(publish, /dataset\.busy === '1'/, '重复点击要直接返回，不能上架→下架来回切')
  assert.match(publish, /button\.disabled = true/)
  assert.match(publish, /aria-busy/)
  assert.match(publish, /catch/)
  assert.match(publish, /finally/)
  const remove = sliceAround(appJs, "querySelectorAll('[data-del]').forEach")
  assert.match(remove, /try\s*\{[\s\S]{0,400}?method: 'DELETE'/)
  assert.match(remove, /catch/)
})

// ---------------------------------------------------------------- P1-7 关单按钮按权限门禁

test('订单页「关闭超时订单」按 finance.order.confirm 门禁，且请求期间禁用（静态断言）', () => {
  assert.match(ordersVue, /const canConfirm = computed\(\(\) => permissions\.value\.has\('finance\.order\.confirm'\)\)/)
  assert.match(ordersVue, /<button v-if="canConfirm"[^>]*@click="closeExpired"/)
  assert.match(ordersVue, /const closing = ref\(false\)/)
  assert.match(ordersVue, /:disabled="closing"/)
})

// ---------------------------------------------------------------- P2-8 列表状态进 URL

test('URL 状态还原：数字按数字还原，脏值回退默认，布尔识别 1/true', () => {
  const state = hydrateListState(
    { page: '3', q: '海', size: 'abc', closed: '1', scope: '' },
    { page: 1, q: '', size: 20, closed: false, scope: 'general' },
  )
  assert.deepEqual(state, { page: 3, q: '海', size: 20, closed: true, scope: 'general' })
  assert.deepEqual(hydrateListState({}, { page: 1 }), { page: 1 })
  assert.deepEqual(hydrateListState(null, { page: 2, q: 'x' }), { page: 2, q: 'x' })
})

test('URL 状态写回：空值不写、按 route 组装（不产生空参数）', () => {
  const calls = []
  globalThis.history = { replaceState: (_state, _title, url) => calls.push(url) }
  writeHashQuery('dramas', { page: 2, size: '', q: '海', cat: 'all' })
  assert.equal(calls.at(-1), '#/dramas?page=2&q=%E6%B5%B7&cat=all')
  writeHashQuery('audit', {})
  assert.equal(calls.at(-1), '#/audit')
})

test('剧集/标签/埋点/审计列表都用 URL 还原并写回状态（静态断言）', () => {
  const uses = appJs.match(/hydrateListState\(readHashQuery\(\)/g) ?? []
  assert.ok(uses.length >= 4, `至少 4 个列表页要接入 URL 状态，实际 ${uses.length}`)
  assert.match(appJs, /writeHashQuery\('dramas'/)
  assert.match(appJs, /writeHashQuery\('tags'/)
  assert.match(appJs, /writeHashQuery\('events'/)
  assert.match(appJs, /writeHashQuery\('audit'/)
  // 改筛选/翻页前必须先同步 hash，否则页面会从旧 hash 还原出旧筛选
  assert.match(appJs, /const syncTagHash = \(\) =>/)
  assert.match(appJs, /bindPager\('tags', reload\)/)
  assert.match(appJs, /const syncEventHash = \(\) =>/)
  assert.match(appJs, /bindPager\('events', async \(\) => \{\s*syncEventHash\(\)/)
})

// ---------------------------------------------------------------- P2-9 批量分配逐条应用

test('批量分配：按服务端明细逐条应用，未确认/失败的行保留原值（静态断言）', () => {
  const bulk = sliceAround(appJs, "#drama-bulk-apply")
  assert.match(bulk, /result\.failed \?\? result\.failedIds/)
  assert.match(bulk, /result\.updatedIds \?\? result\.okIds \?\? result\.ids/)
  assert.match(bulk, /部失败并保留原策略组/)
  assert.match(bulk, /未确认的行保留原策略组/)
  assert.match(bulk, /dataset\.previous/)
})

// ---------------------------------------------------------------- P2-10 跨页选中

test('跨页选中：翻页后保留、取消只删指定 id、脏 id 被忽略、返回新集合', () => {
  const page1 = toggleSelection(new Set(), [1, 2, 3], true)
  const page2 = toggleSelection(page1, [4, '5', 'abc', null], true)
  assert.deepEqual([...page2].sort(), [1, 2, 3, 4, 5])
  assert.equal(page1.size, 3, '原集合不被修改')
  const removed = toggleSelection(page2, [1, 4], false)
  assert.deepEqual([...removed].sort(), [2, 3, 5])
})

test('选中摘要：区分「本页全选」与「跨页已选」，空页不误报全选', () => {
  const selected = new Set([1, 2, 9])
  assert.deepEqual(selectionSummary(selected, [1, 2, 3]), {
    onPage: 2,
    total: 3,
    allOnPage: false,
    noneOnPage: false,
  })
  assert.deepEqual(selectionSummary(selected, ['1', '2']), {
    onPage: 2,
    total: 3,
    allOnPage: true,
    noneOnPage: false,
  })
  assert.deepEqual(selectionSummary(new Set(), []), { onPage: 0, total: 0, allOnPage: false, noneOnPage: true })
})

test('表头全选明确是「本页」、批量条区分跨页，AdminDataTable 翻页重置草稿与隐藏列（静态断言）', () => {
  assert.match(appJs, /aria-label="选择本页全部剧集（不跨页）"/)
  assert.match(appJs, /其余为跨页选择，翻页后保留/)
  assert.match(appJs, /indeterminate/)
  const watchPage = sliceAround(dataTableVue, 'watch(() => props.page')
  assert.match(watchPage, /searchDraft\.value = /)
  assert.match(watchPage, /hiddenKeys\.value = new Set\(\)/)
})

// ---------------------------------------------------------------- P2-11 分销权限与原因

test('分销结算/风控按权限门禁，处理原因可填（静态断言）', () => {
  assert.match(appJs, /\.has\('growth\.distribution\.settle'\)/)
  assert.match(appJs, /\.has\('growth\.distribution\.risk'\)/)
  const risk = sliceAround(appJs, "for (const button of view.querySelectorAll('[data-risk-action]'))")
  assert.match(risk, /askText\(/)
  assert.match(risk, /label: '处理原因'/)
  assert.doesNotMatch(risk, /reason: '后台风险处理' \}/, '原因不能写死')
  assert.equal((appJs.match(/yuan\(row\.paidAmount \* 100\)/g) ?? []).length, 2, '已复核的金额抵消不得改动语义')
})

// ---------------------------------------------------------------- P2-12 订单页列头与状态文案

test('订单页时间列显示与排序同字段，两个「待支付」文案区分（静态断言）', () => {
  assert.match(ordersVue, /key: 'created_at', label: '下单时间', sortable: true/)
  assert.match(ordersVue, /fmtTs\(row\.created_at\)/)
  assert.match(ordersVue, /支付 \{\{ fmtTs\(row\.paid_at\) \}\}/)
  assert.match(ordersVue, /value: 'created', label: '待支付'/)
  assert.match(ordersVue, /value: 'pending', label: '支付确认中'/)
  assert.match(ordersVue, /pending: \['', '支付确认中'\]/)
})

// ---------------------------------------------------------------- P2-13 时区统一

test('时钟格式：统一北京时间，非法输入给占位符', () => {
  const value = new Date('2026-11-16T12:34:56Z')
  assert.equal(
    formatClock(value),
    value.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  )
  assert.match(formatClock(value), /^\d{1,2}:\d{2}:\d{2}$/)
  assert.equal(formatClock('not-a-date'), '—')
  assert.match(formatClock(value, 'UTC'), /^\d{1,2}:\d{2}:\d{2}$/)
})

test('后台「更新于」都走 formatClock 并标注北京时间（静态断言）', () => {
  assert.doesNotMatch(appJs, /new Date\(\)\.toLocaleTimeString\('zh-CN'\)/, '不能再用浏览器本地时区')
  const clocks = appJs.match(/formatClock\(\)/g) ?? []
  assert.ok(clocks.length >= 2, `顶栏与概览都要用统一时钟，实际 ${clocks.length}`)
  assert.match(appJs, /（北京时间）/)
})

// ---------------------------------------------------------------- P2-14 经营数据兜底

test('调用区间白名单：脏值/越界值回退 7 天，合法值保留', () => {
  assert.equal(pickAllowedNumber('14', [7, 14, 30], 7), 14)
  assert.equal(pickAllowedNumber(30, [7, 14, 30], 7), 30)
  assert.equal(pickAllowedNumber('abc', [7, 14, 30], 7), 7)
  assert.equal(pickAllowedNumber('0', [7, 14, 30], 7), 7)
  assert.equal(pickAllowedNumber('9999', [7, 14, 30], 7), 7)
  assert.equal(pickAllowedNumber(null, [7, 14, 30], 7), 7)
  assert.equal(pickAllowedNumber(3, 'oops', 1), 1)
})

test('经营数据页对缺失字段兜底，不再直接解引用 data.funnel/users/totals（静态断言）', () => {
  const page = sliceAround(appJs, 'async function pageAnalytics()', 0, 9000)
  assert.match(page, /pickAllowedNumber\(localStorage\.getItem\('mh-analytics-days'\)/)
  assert.match(page, /const safeList = /)
  assert.doesNotMatch(page, /data\.funnel\.\w/, 'funnel 必须先兜底成本地变量')
  assert.doesNotMatch(page, /data\.totals\.\w/, 'totals 必须先兜底成本地变量')
})

// ---------------------------------------------------------------- P2-15 角色页分区块渲染

test('角色页用 allSettled 分区块渲染，canWrite 与菜单键 admin.read 对齐（静态断言）', () => {
  const page = sliceAround(appJs, 'async function pageRoles()', 0, 3000)
  assert.match(page, /Promise\.allSettled\(/)
  assert.match(page, /adminsReady/)
  assert.match(page, /perms\.has\('admin\.read'\)/)
  assert.match(page, /canWrite = canRead && perms\.has\('admin\.write'\)/)
})

// ---------------------------------------------------------------- P2-16 优惠券默认值与校验

test('优惠券默认有效期：今天 + 30 天，跨月跨年正确，脏参数回退 30 天', () => {
  assert.equal(couponValidTo(new Date('2026-11-16T10:00:00+08:00')), '2026-12-16')
  assert.equal(couponValidTo(new Date('2026-12-20T10:00:00+08:00')), '2027-01-19')
  assert.equal(couponValidTo(new Date('2026-01-31T10:00:00+08:00')), '2026-03-02')
  assert.equal(couponValidTo(new Date('2026-11-16T10:00:00+08:00'), 1), '2026-11-17')
  assert.equal(couponValidTo(new Date('2026-11-16T10:00:00+08:00'), 0), '2026-12-16')
  assert.equal(couponValidTo(new Date('2026-11-16T10:00:00+08:0' + '0'), 'abc'), '2026-12-16')
})

test('优惠券校验：0 元券、负门槛、超 100% 折扣都被拦下', () => {
  assert.deepEqual(validateCouponDraft({ discountValue: 20 }), { ok: true, message: '' })
  assert.equal(validateCouponDraft({ discountValue: 0 }).ok, false)
  assert.equal(validateCouponDraft({ discountValue: -5 }).message, '面额必须大于 0 元')
  assert.equal(validateCouponDraft({ discountType: 'percent', discountValue: 0 }).message, '折扣必须大于 0%')
  assert.equal(validateCouponDraft({ discountType: 'percent', discountValue: 101 }).message, '折扣不能超过 100%')
  assert.equal(validateCouponDraft({ discountType: 'percent', discountValue: 100 }).ok, true)
  assert.equal(validateCouponDraft({ discountValue: 10, minAmount: -1 }).message, '使用门槛不能为负数')
  assert.equal(validateCouponDraft({ discountValue: 'abc' }).ok, false)
})

test('优惠券表单不再写死有效期，保存前跑校验（静态断言）', () => {
  assert.doesNotMatch(appJs, /2027-12-31/, '有效期不能写死到某一年')
  const coupon = sliceAround(appJs, 'async function pageCoupons()', 0, 3000)
  assert.match(coupon, /id="c-valid"/)
  assert.match(coupon, /couponValidTo\(\)/)
  assert.match(coupon, /validateCouponDraft\(\{/)
})

// ---------------------------------------------------------------- P2-17 主题 token 单一来源

test('modern.css 不再重复定义共享令牌，只留 ink 别名（静态断言）', () => {
  assert.match(modernCss, /--ink-0: var\(--bg\)/)
  assert.match(modernCss, /--ink-1: var\(--bg-soft\)/)
  assert.match(modernCss, /--ink-2: var\(--bg-elev\)/)
  assert.match(modernCss, /--ink-3: var\(--surface\)/)
  for (const token of ['--bg', '--bg-soft', '--bg-elev', '--surface', '--panel', '--line', '--text', '--brand', '--ok', '--warn', '--bad', '--radius', '--r-lg', '--shadow']) {
    const re = new RegExp(`^\\s*${token.replace(/-/g, '\\-')}:`, 'm')
    assert.doesNotMatch(modernCss, re, `modern.css 不能再定义 ${token}，否则会覆盖 shared/tokens.css`)
  }
})

// ---------------------------------------------------------------- P2-18 行内菜单不被面板裁剪 + 优先级兜底

test('优先级兜底：空数组/脏值不产生 Infinity，正常取最小值再减 10', () => {
  assert.equal(nextTopPriority([], 'priority', 100), 90)
  assert.equal(nextTopPriority(null, 'priority', 100), 90)
  assert.equal(nextTopPriority([{ priority: 'abc' }, {}], 'priority', 50), 40)
  assert.equal(nextTopPriority([{ priority: 30 }, { priority: 5 }, { priority: 999 }]), -5)
  assert.equal(nextTopPriority([{ priority: 0 }]), -10)
})

test('行内「更多」菜单改用 fixed 定位，滚动/点空白收起（静态断言）', () => {
  const toggle = sliceAround(appJs, "querySelectorAll('.row-more-toggle').forEach")
  assert.match(toggle, /menu\.style\.position = 'fixed'/)
  assert.match(toggle, /getBoundingClientRect\(\)/)
  assert.match(appJs, /function closeRowMenus\(\)/)
  assert.match(appJs, /window\.addEventListener\('scroll', closeRowMenus/)
  assert.match(appJs, /nextTopPriority\(channels2, 'priority', 100\)/)
  assert.doesNotMatch(appJs, /Math\.min\(\.\.\.channels2\.map/, 'Math.min(...[]) 会算出 Infinity')
})

// ---------------------------------------------------------------- P2-19 图表数据表替代

test('四个图表都带可展开的数据表替代（静态断言）', () => {
  assert.match(appJs, /function chartDataTable\(/)
  assert.match(appJs, /<details class="chart-data"><summary>数据表<\/summary>/)
  const uses = appJs.match(/chartDataTable\(/g) ?? []
  assert.ok(uses.length >= 5, `折线/漏斗/环形/排行都要有数据表（含定义共 5 处），实际 ${uses.length}`)
  assert.match(stylesCss, /\.chart-data summary \{/)
})

// ---------------------------------------------------------------- 埋点中文化
test('埋点页面与事件 code 一律翻成中文（行为断言）', () => {
  const from = appJs.indexOf('const EVENT_LABEL = {')
  const to = appJs.indexOf('const CHART_COLORS')
  assert.ok(from > 0 && to > from, '找不到埋点标签定义块')
  const helpers = new Function(`${appJs.slice(from, to)}
    return { pagePathOf, pageLabelOf, eventCodeLabelOf }`)()

  assert.equal(helpers.pagePathOf('https://www.wyfclyes.top/video/#/adult'), '/adult')
  assert.equal(helpers.pagePathOf('/video/'), '/')
  assert.equal(helpers.pagePathOf(''), '')

  const cases = [
    ['/adult', '成人频道'],
    ['#/adult', '成人频道'],
    ['https://www.wyfclyes.top/video/#/adult', '成人频道'],
    ['/video/', '首页'],
    ['#/', '首页'],
    ['/short', '短剧频道'],
    ['#/category/MOVIE', '片库 · 电影'],
    ['#/category/PLAYLET', '片库 · 短剧'],
    ['#/drama/11', '剧目详情页'],
    ['/play/3764/1', '播放页'],
  ]
  for (const [input, expected] of cases) assert.equal(helpers.pageLabelOf(input), expected, input)
  assert.equal(helpers.pageLabelOf(''), '无页面信息')
  assert.equal(helpers.pageLabelOf('#/no-such-page'), '其他页面')
  assert.equal(helpers.pageLabelOf(undefined, 'https://x/video/#/vip'), '会员')

  assert.equal(helpers.eventCodeLabelOf('page:/adult'), '页面浏览 · 成人频道')
  assert.equal(helpers.eventCodeLabelOf('link:/adult'), '链接点击 · 成人频道')
  assert.equal(helpers.eventCodeLabelOf('impression'), '内容曝光')
  assert.equal(helpers.eventCodeLabelOf('click:button.btn'), '元素点击')
  assert.equal(helpers.eventCodeLabelOf(''), '—')
  assert.equal(helpers.eventCodeLabelOf('legacy_unknown_type'), '其他事件')

  for (const input of ['page:/adult', 'link:/short', 'page:/play/3764/1']) {
    assert.doesNotMatch(helpers.eventCodeLabelOf(input), /[a-z]/i, `事件 code 必须中文化：${input}`)
  }
  assert.doesNotMatch(helpers.pageLabelOf('#/category/MOVIE'), /[a-z]/i)
})

test('事件类型 0 不再叫「未知」，排行与明细都有中文兜底（静态断言）', () => {
  const at = appJs.indexOf('const EVENT_TYPE_LABEL')
  assert.ok(at > 0, '找不到 EVENT_TYPE_LABEL')
  assert.match(appJs.slice(at, at + 160), /0: '行为事件'/)
  assert.equal(appJs.includes("0: '未知'"), false, '「未知」对运营没有信息量，改叫行为事件')
  assert.match(appJs, /pageLabelOf\(row\.path, row\.page_url\)/)
  assert.match(appJs, /eventCodeLabelOf\(row\.event_code\)/)
  assert.match(appJs, /row\.title \?\? row\[labelKey\]/)
})

// ------------------------------------------------- 埋点快照兜底不再输出占位符
test('后端统计不再吐「(未知)」，热门页面只统计有路径的浏览（静态断言）', () => {
  const source = readFileSync(new URL('../server/event-stats.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes("'(未知)'"), false, '后端不该输出「(未知)」占位')
  assert.match(source, /WHERE \$\{clause\} AND te\.path IS NOT NULL AND te\.path <> ''/)
})

test('埋点页只留设备/系统/地区/事件四张分布图，趋势与排行下线（静态断言）', () => {
  assert.match(appJs, /<div class="chart-grid">/)
  for (const title of ['设备分布', '系统分布', '地区分布', '事件分布']) {
    assert.match(appJs, new RegExp(`distPanel\\('${title}'`), `缺少${title}`)
  }
  // 需求：图表只留这四张，事件趋势与各类 Top 排行不再渲染
  for (const gone of ['事件趋势 <span', '热门页面 Top 10', '热门事件 Top 12', '热门动作 Top 10', '热门剧目 Top 10']) {
    assert.equal(appJs.includes(gone), false, `${gone} 应已下线`)
  }
  assert.match(appJs, /rankedBars\(rows, key, labelKey, '', \{ total:/)
})

test('非路由的 path 不假装是页面，详情页与登录页都有中文名（行为断言）', () => {
  const from = appJs.indexOf('const EVENT_LABEL = {')
  const to = appJs.indexOf('const CHART_COLORS')
  const { pageLabelOf } = new Function(`${appJs.slice(from, to)}
    return { pageLabelOf }`)()

  assert.equal(pageLabelOf('/detail/3870'), '剧目详情页')
  assert.equal(pageLabelOf('/login'), '登录页')
  assert.equal(pageLabelOf('仙逆'), '非页面记录', '搜索词落在 path 里，不能当成页面')
  assert.equal(pageLabelOf('MH1794317247790EDDB'), '非页面记录')
})

// ------------------------------------------------- 埋点区间切换必须写回 hash
test('埋点区间与事件类型切换先写 hash 再重渲染，四个区间不会卡在同一个值（静态断言）', () => {
  const rangeHandler = sliceAround(appJs, "view.querySelectorAll('[data-range]').forEach", 120, 700)
  assert.match(rangeHandler, /state\.params\.eventRange = button\.dataset\.range/)
  assert.match(rangeHandler, /syncEventHash\(\)/, '换区间必须先写 hash，否则 pageEvents() 读回上一轮的旧 range')
  assert.match(rangeHandler, /syncEventHash\(\)[\s\S]{0,40}pageEvents\(\)/, '写 hash 要排在 pageEvents() 之前')

  const typeHandler = sliceAround(appJs, "$('#ev-type')?.addEventListener('change'", 60, 420)
  assert.match(typeHandler, /state\.params\.eventType = event\.target\.value/)
  assert.match(typeHandler, /syncEventHash\(\)[\s\S]{0,40}pageEvents\(\)/, '换类型同样要先写 hash')

  // 反例守卫：handler 里不允许出现「只改 state 直接重渲染」的写法
  for (const block of [rangeHandler, typeHandler]) {
    assert.doesNotMatch(block, /listPages\.events = 1\s*\n\s*pageEvents\(\)/, '缺少 syncEventHash()')
  }
})

test('概览「可播」按 HLS 或远程直链统计，远程片源不算不可播（静态断言）', () => {
  const api = readFileSync(new URL('../server/api-admin.mjs', import.meta.url), 'utf8')
  assert.match(
    api,
    /readyEpisodes: one\("SELECT COUNT\(\*\) AS n FROM episodes WHERE status = 'ready' AND \(hls_path IS NOT NULL OR \(remote_url IS NOT NULL AND remote_url <> ''\)\)"\)/,
  )
  assert.match(api, /SUM\(CASE WHEN status = 'ready' AND \(hls_path IS NOT NULL OR \(remote_url IS NOT NULL AND remote_url <> ''\)\) THEN 1 ELSE 0 END\) AS ready_episodes/)
})
