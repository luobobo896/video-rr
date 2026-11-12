import { getLang } from './i18n.js';

const runtimePath = window.location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '');
const runtimeBase = /^\/(video|video-admin)$/.test(runtimePath) ? runtimePath : '';
const siteBaseValue = window.__MH_BASE || runtimeBase;

const PUBLIC_BASE = import.meta.env.VITE_PUBLIC_API_BASE ?? `${siteBaseValue}/api`;
const ADMIN_BASE = import.meta.env.VITE_ADMIN_API_BASE
  ?? (siteBaseValue.startsWith('/video') ? '/video-admin/api' : '/admin/api');
const MEDIA_BASE = import.meta.env.VITE_MEDIA_BASE ?? siteBaseValue;

function readVisitorId() {
  try {
    const saved = localStorage.getItem('mh-visitor-id');
    if (/^[A-Za-z0-9_-]{8,64}$/.test(saved ?? '')) return saved;
    const id = globalThis.crypto?.randomUUID?.()
      ?? `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem('mh-visitor-id', id);
    return id;
  } catch {
    return `v-${Date.now().toString(36)}`;
  }
}

const visitorId = readVisitorId();
export const siteBase = siteBaseValue;

export class ApiError extends Error {
  constructor(message, { code = 'error', status = 0, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

function langHeader() {
  return getLang();
}

function buildQuery(path) {
  const lang = langHeader();
  return `${path}${path.includes('?') ? '&' : '?'}lang=${lang}`;
}

async function request(base, path, options = {}) {
  const {
    method = 'GET',
    body,
    token = '',
    timeoutMs = 15000,
    signal: externalSignal,
    raw = false
  } = options;
  const headers = { 'x-mh-lang': langHeader(), 'x-mh-visitor': visitorId };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof Blob)) headers['content-type'] = 'application/json';

  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    let response;
    try {
      response = await fetch(base + buildQuery(path), {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (timedOut) throw new ApiError('请求超时，请检查网络后重试', { code: 'timeout' });
        throw new ApiError('请求已取消', { code: 'aborted' });
      }
      throw new ApiError('网络异常，请检查网络后重试', { code: 'network' });
    }

    if (raw) {
      if (!response.ok) throw new ApiError(`请求失败（${response.status}）`, { status: response.status });
      return response;
    }

    let json;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(`服务暂时不可用（${response.status}）`, {
        code: 'bad_response',
        status: response.status
      });
    }

    if (json.code === '0401') {
      window.dispatchEvent(new CustomEvent('mh:unauthorized', {
        detail: { area: base === ADMIN_BASE ? 'admin' : 'public' }
      }));
      throw new ApiError(json.msg || '登录已过期，请重新登录', {
        code: '0401',
        status: response.status,
        data: json.data
      });
    }

    if (json.code !== '0000') {
      throw new ApiError(json.msg || '接口失败', {
        code: json.code,
        status: response.status,
        data: json.data
      });
    }
    return json.data;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

function publicToken() {
  try {
    return localStorage.getItem('mh-token') || '';
  } catch {
    return '';
  }
}

function adminToken() {
  try {
    return localStorage.getItem('mh-admin-token') || '';
  } catch {
    return '';
  }
}

export const publicApi = (path, options = {}) =>
  request(PUBLIC_BASE, path, { ...options, token: options.token ?? publicToken() });

export const adminApi = (path, options = {}) =>
  request(ADMIN_BASE, path, { ...options, token: options.token ?? adminToken() });

export function mediaUrl(url) {
  if (!url) return '';
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  return `${MEDIA_BASE}${url}`;
}

export function hlsUrl(path) {
  return mediaUrl(path);
}
