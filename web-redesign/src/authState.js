import { computed, reactive } from 'vue';
import { adminApi, publicApi } from './api.js';

function readStoredUser() {
  try {
    const raw = localStorage.getItem('mh-user');
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function readAdultConsent() {
  try {
    return sessionStorage.getItem('mh-adult-confirmed') === '1';
  } catch {
    return false;
  }
}

export const state = reactive({
  user: readStoredUser(),
  me: null,
  meLoading: false,
  constants: null,
  plans: [],
  adultConfirmed: readAdultConsent()
});

export const ui = reactive({
  loginOpen: false,
  loginMessage: ''
});

export const isLoggedIn = computed(() => Boolean(state.user));
export const isVip = computed(() => Boolean(state.me?.subscription));
export const favoriteIds = computed(() =>
  new Set((state.me?.favorites ?? []).map((item) => Number(item.dramaId)))
);

export const toastState = reactive({
  show: false,
  message: '',
  kind: 'ok'
});

let toastTimer = 0;

export function toast(message, kind = 'ok') {
  window.clearTimeout(toastTimer);
  toastState.message = message;
  toastState.kind = kind;
  toastState.show = true;
  toastTimer = window.setTimeout(() => {
    toastState.show = false;
  }, 2400);
}

function saveSession(data) {
  state.user = data.user;
  state.me = null;
  localStorage.setItem('mh-token', data.token);
  localStorage.setItem('mh-user', JSON.stringify(data.user));
}

function clearSession(kind) {
  if (kind === 'admin') {
    localStorage.removeItem('mh-admin-token');
    return;
  }
  localStorage.removeItem('mh-token');
  localStorage.removeItem('mh-user');
  state.user = null;
  state.me = null;
}

window.addEventListener('mh:unauthorized', (event) => {
  clearSession(event.detail?.area === 'admin' ? 'admin' : 'public');
});

export async function sendLoginCode(email) {
  return publicApi('/auth/email/send', {
    method: 'POST',
    body: { email: email.trim() },
    token: ''
  });
}

export async function loginWithCode(email, code) {
  const data = await publicApi('/auth/email/login', {
    method: 'POST',
    body: { email: email.trim(), code: code.trim() },
    token: ''
  });
  saveSession(data);
  await refreshMe();
  return data;
}

export async function loginWithPassword(email, password) {
  const data = await publicApi('/auth/email/password', {
    method: 'POST',
    body: { email: email.trim(), password },
    token: ''
  });
  saveSession(data);
  await refreshMe();
  return data;
}

export async function logout() {
  try {
    await publicApi('/auth/logout', { method: 'POST' });
  } catch {
    // Clearing local credentials is the priority when the network is unavailable.
  }
  clearSession('public');
}

export async function refreshMe() {
  if (!localStorage.getItem('mh-token')) {
    state.me = null;
    state.user = null;
    return null;
  }
  state.meLoading = true;
  try {
    state.me = await publicApi('/me');
    state.user = state.me.user;
    localStorage.setItem('mh-user', JSON.stringify(state.me.user));
    return state.me;
  } catch (error) {
    if (error.code === '0401') {
      clearSession('public');
      return null;
    }
    throw error;
  } finally {
    state.meLoading = false;
  }
}

export async function loadConstants() {
  if (state.constants) return state.constants;
  state.constants = await publicApi('/constants');
  return state.constants;
}

export async function loadPlans() {
  const data = await publicApi('/plans');
  state.plans = data.plans ?? [];
  return state.plans;
}

export function isFavorite(dramaId) {
  return favoriteIds.value.has(Number(dramaId));
}

export async function toggleFavorite(dramaId) {
  if (!state.user) {
    requireLogin('登录后可以收藏');
    throw Object.assign(new Error('请先登录'), { code: '0401' });
  }
  const result = await publicApi('/me/favorite', {
    method: 'POST',
    body: { dramaId: Number(dramaId) }
  });
  await refreshMe();
  return Boolean(result.favorited);
}

export function requireLogin(message = '请先登录') {
  ui.loginMessage = message;
  ui.loginOpen = true;
}

export function confirmAdult() {
  state.adultConfirmed = true;
  try {
    sessionStorage.setItem('mh-adult-confirmed', '1');
  } catch {
    // Session storage may be unavailable in restricted browser modes.
  }
}

export const adminState = reactive({
  token: localStorage.getItem('mh-admin-token') || '',
  me: null,
  loading: false
});

export async function loadAdminMe() {
  if (!adminState.token) {
    adminState.me = null;
    return null;
  }
  adminState.loading = true;
  try {
    adminState.me = await adminApi('/me');
    return adminState.me;
  } catch (error) {
    if (error.code === '0401') {
      adminState.token = '';
      adminState.me = null;
      localStorage.removeItem('mh-admin-token');
    }
    throw error;
  } finally {
    adminState.loading = false;
  }
}

export async function loginAdmin(username, password) {
  const data = await adminApi('/login', {
    method: 'POST',
    body: { username: username.trim(), password },
    token: ''
  });
  adminState.token = data.token;
  localStorage.setItem('mh-admin-token', data.token);
  await loadAdminMe();
  return data;
}

export async function logoutAdmin() {
  try {
    await adminApi('/logout', { method: 'POST' });
  } catch {
    // Always allow local sign-out.
  }
  adminState.token = '';
  adminState.me = null;
  localStorage.removeItem('mh-admin-token');
}
