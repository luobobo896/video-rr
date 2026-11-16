/**
 * C 端行为埋点：页面进出 + 点击。
 *
 * 每条都带：用户 id / 账号（服务端按 token 查）/ IP（服务端取）/ 设备与系统（服务端解析 UA）/
 * 页面地址 / 事件 code / 事件类型（0 未知 1 页面 2 点击）/ 事件操作（0 默认 1 进入 2 退出）/
 * 动作与描述 / 页面停留时长。
 *
 * 埋点失败绝不打扰用户：所有发送都吞异常。
 */
import { publicApi, publicToken } from './api.js';
import { route } from './router.js';

const PAGE_NAMES = {
  '/': '首页',
  '/category': '片库',
  '/rank': '榜单',
  '/search': '搜索',
  '/adult': '成人频道',
  '/short': '短剧频道',
  '/me': '个人中心',
  '/vip': '会员中心',
  '/help': '帮助中心'
};

const CLICK_THROTTLE_MS = 600;

let started = false;
let pageStartAt = Date.now();
let pagePath = route.path;
let pageName = pageNameOf(route.path);
let pageUrl = typeof location === 'undefined' ? '' : location.href;
let lastClickKey = '';
let lastClickAt = 0;

function pageNameOf(path) {
  if (PAGE_NAMES[path]) return PAGE_NAMES[path];
  if (path.startsWith('/detail/')) return '详情页';
  if (path.startsWith('/play/')) return '播放页';
  return path || '未知页面';
}

function trackUrl() {
  try {
    return new URL('api/track', document.baseURI).href;
  } catch {
    return '/api/track';
  }
}

function basePayload(extra) {
  return { pageUrl: location.href, ...extra };
}

async function send(body) {
  try {
    await publicApi('/track', { method: 'POST', body: basePayload(body), timeoutMs: 6000 });
  } catch {
    /* 埋点失败不影响页面 */
  }
}

/** 卸载/切页时用 keepalive 兜底：带得上 token 就还能认出是谁 */
function sendLoose(body) {
  const payload = JSON.stringify(basePayload(body));
  const token = publicToken();
  const headers = { 'content-type': 'application/json', 'x-mh-lang': 'zh' };
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const sent = fetch(trackUrl(), { method: 'POST', headers, body: payload, keepalive: true });
    sent?.catch?.(() => {});
  } catch {
    /* ignore */
  }
}

/** 页面进入：记一条 page_view（type=1 op=1），并开始计时 */
function enterPage() {
  const now = Date.now();
  const nextPath = route.path;
  const nextName = pageNameOf(nextPath);
  pageStartAt = now;
  pagePath = nextPath;
  pageName = nextName;
  pageUrl = location.href;
  void send({
    type: 'page_view',
    eventType: 1,
    eventOp: 1,
    eventCode: `page:${nextPath}`,
    action: `进入${nextName}`,
    description: `进入${nextName}`,
    path: location.hash.replace(/^#/, '') || '/'
  });
}

/** 页面离开：记一条 page_view（type=1 op=2）并带上停留毫秒 */
function leavePage({ loose = false } = {}) {
  const stayMs = Math.max(0, Date.now() - pageStartAt);
  const seconds = (stayMs / 1000).toFixed(1);
  const body = {
    type: 'page_view',
    eventType: 1,
    eventOp: 2,
    eventCode: `page:${pagePath}`,
    action: `离开${pageName}`,
    description: `停留 ${seconds} 秒`,
    path: pagePath,
    stayMs,
    // 用进入本页时的地址快照：此刻 location 可能已经跳到下一页了
    pageUrl
  };
  if (loose) sendLoose(body);
  else void send(body);
}

/** 业务代码可显式调用：trackClick({ code, action, description, type }) */
export function trackClick({
  code = 'click',
  action = '',
  description = '',
  type = 'click',
  dramaId = null,
  episodeId = null
} = {}) {
  if (!started) return;
  void send({
    type,
    eventType: 2,
    eventOp: 1,
    eventCode: String(code).slice(0, 80),
    action: String(action).slice(0, 200),
    description: String(description || action).slice(0, 300),
    dramaId,
    episodeId,
    path: pagePath
  });
}

/** 业务代码可显式调用：trackEvent({ type, code, action, description, extra }) */
export function trackEvent({ type = 'impression', code = '', action = '', description = '', extra = {} } = {}) {
  if (!started) return;
  void send({
    type,
    eventCode: String(code || type).slice(0, 80),
    action: String(action).slice(0, 200),
    description: String(description || action).slice(0, 300),
    ...extra
  });
}

function clickLabelOf(el) {
  const explicit = el.dataset?.trackLabel || el.getAttribute('aria-label') || el.getAttribute('title');
  if (explicit) return String(explicit).replace(/\s+/g, ' ').trim();
  return String(el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function handleClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const el = target.closest('[data-track], a, button, [role="button"], .chip, .poster-card');
  if (!el) return;
  const label = clickLabelOf(el).slice(0, 60);
  const explicit = el.dataset?.track;
  if (!label && !explicit) return;

  const href = el.getAttribute?.('href') ?? '';
  const classHint = String(el.className ?? '').split(/\s+/).filter(Boolean)[0] ?? '';
  const code = explicit
    || (href
      ? `link:${href.replace(/^#/, '').split('?')[0]}`
      : `click:${el.tagName.toLowerCase()}${classHint ? `.${classHint}` : ''}`);
  const key = `${code}|${label}`;
  const now = Date.now();
  if (key === lastClickKey && now - lastClickAt < CLICK_THROTTLE_MS) return;
  lastClickKey = key;
  lastClickAt = now;

  void send({
    type: 'click',
    eventType: 2,
    eventOp: 1,
    eventCode: code.slice(0, 80),
    action: label || code,
    description: `在${pageName}点击「${label || code}」`,
    path: pagePath
  });
}

/** 在 App 挂载时调用一次；重复调用安全 */
export function initTracking() {
  if (started || typeof window === 'undefined') return;
  started = true;

  void send({
    type: 'session_start',
    eventType: 1,
    eventOp: 1,
    eventCode: 'session:start',
    action: '开始访问',
    description: `进入站点：${pageName}`,
    path: location.hash.replace(/^#/, '') || '/'
  });
  enterPage();

  window.addEventListener('hashchange', () => {
    // 让 router 先同步 route，再按新页面重新计时
    window.setTimeout(() => {
      leavePage();
      enterPage();
    }, 0);
  });

  document.addEventListener('click', handleClick, { capture: true, passive: true });

  // 关标签页/切后台：用 keepalive 把停留时间送出去
  window.addEventListener('pagehide', () => leavePage({ loose: true }));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') leavePage({ loose: true });
    else pageStartAt = Date.now();
  });
}
