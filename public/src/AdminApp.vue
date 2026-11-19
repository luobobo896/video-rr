<script setup>
import { computed, onMounted, watchEffect } from 'vue';
import AdminShell from './components/AdminShell.vue';
import ToastMessage from './components/ToastMessage.vue';
import { ADMIN_PAGES } from './data/adminPages.js';
import AdminLogin from './pages/admin/AdminLogin.vue';
import AdminPage from './pages/admin/AdminPage.vue';
import { adminState, loadAdminMe } from './authState.js';
import { go, route } from './router.js';

const key = computed(() => {
  const path = route.path.startsWith('/admin') ? route.path : '/admin/overview';
  if (path === '/admin' || path === '/admin/') return 'overview';
  return path.split('/').pop() || 'overview';
});
const meta = computed(() => ADMIN_PAGES[key.value] || ADMIN_PAGES.overview);
const showLogin = computed(() =>
  key.value === 'login' || !adminState.token || adminState.mustChangePassword
);

watchEffect(() => {
  document.body.dataset.accent = 'b';
  document.title = showLogin.value
    ? '登录 · 影巢运营后台'
    : `${meta.value.title} · 影巢运营后台`;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#080a0f');
});

onMounted(() => {
  if (!route.path.startsWith('/admin')) go('/admin/overview');
  if (adminState.token && !adminState.me) loadAdminMe().catch(() => null);
});
</script>

<template>
  <AdminLogin v-if="showLogin" />
  <AdminShell
    v-else
    :active="key"
    :title="meta.title"
    :subtitle="meta.subtitle"
  >
    <AdminPage :key="route.path" />
  </AdminShell>
  <ToastMessage />
</template>
