/**
 * C 端列表页的 URL 状态：筛选与页码写进 location.hash 的 query 部分，
 * 刷新 / 后退能把列表还原。与后台 admin/table-state.js 同一套 API 形状
 * （readHashQuery / writeHashQuery），区别是 C 端 hash 形如 '#/category?type=MOVIE&page=2'，
 * 且写回用 replaceState（不触发 hashchange，页面不会整块重建）。
 */
export const DEFAULT_ROUTE = '/';

export function splitHash(hash = '') {
  const raw = String(hash ?? '').replace(/^#/, '') || DEFAULT_ROUTE;
  const [path, search = ''] = raw.split('?');
  return {
    path: path || DEFAULT_ROUTE,
    search
  };
}

export function readHashQuery(hash = '') {
  return new URLSearchParams(splitHash(hash).search);
}

export function parseHashState(hash = '') {
  return {
    path: splitHash(hash).path,
    query: Object.fromEntries(readHashQuery(hash))
  };
}

export function buildHashState(path, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  const route = path && String(path).startsWith('/') ? String(path) : `/${path || ''}`;
  return `#${route}${query ? `?${query}` : ''}`;
}

export function writeHashQuery(path, params = {}, location = globalThis.location) {
  const next = buildHashState(path, params);
  if (location && typeof history !== 'undefined' && location.hash !== next) {
    history.replaceState(null, '', next);
  }
  return next;
}

export function writeHashParams(params = {}, location = globalThis.location) {
  const { path } = parseHashState(location?.hash ?? '');
  return writeHashQuery(path, params, location);
}

/** 只读取白名单键，空值直接丢掉（避免把 'undefined' 写进 URL）。 */
export function readListState(keys = [], hash = '') {
  const query = readHashQuery(hash);
  const state = {};
  for (const key of keys) {
    const value = query.get(key);
    if (value !== null && value !== '') state[key] = value;
  }
  return state;
}
