<script setup>
import { computed, onMounted, watchEffect } from 'vue';
import AppShell from './components/AppShell.vue';
import Icon from './components/Icon.vue';
import ToastMessage from './components/ToastMessage.vue';
import AdultPage from './pages/c/AdultPage.vue';
import CategoryPage from './pages/c/CategoryPage.vue';
import ContentRankPage from './pages/c/ContentRankPage.vue';
import DetailPage from './pages/c/DetailPage.vue';
import FavoritesPage from './pages/c/FavoritesPage.vue';
import HistoryPage from './pages/c/HistoryPage.vue';
import HomePage from './pages/c/HomePage.vue';
import LandingPage from './pages/c/LandingPage.vue';
import LoginPage from './pages/c/LoginPage.vue';
import MePage from './pages/c/MePage.vue';
import MessagesPage from './pages/c/MessagesPage.vue';
import OrdersPage from './pages/c/OrdersPage.vue';
import PlayPage from './pages/c/PlayPage.vue';
import PlaylistsPage from './pages/c/PlaylistsPage.vue';
import PostersPage from './pages/c/PostersPage.vue';
import ProfileEditPage from './pages/c/ProfileEditPage.vue';
import PromotionPage from './pages/c/PromotionPage.vue';
import RankPage from './pages/c/RankPage.vue';
import SearchPage from './pages/c/SearchPage.vue';
import UpcomingPage from './pages/c/UpcomingPage.vue';
import VipPage from './pages/c/VipPage.vue';
import { href, route } from './router.js';
import { loadConstants, refreshMe } from './authState.js';

const C_PAGES = {
  '/': HomePage,
  '/category': CategoryPage,
  '/adult': AdultPage,
  '/rank': RankPage,
  '/content-rank': ContentRankPage,
  '/playlists': PlaylistsPage,
  '/posters': PostersPage,
  '/upcoming': UpcomingPage,
  '/favorites': FavoritesPage,
  '/history': HistoryPage,
  '/messages': MessagesPage,
  '/orders': OrdersPage,
  '/profile-edit': ProfileEditPage,
  '/promotion': PromotionPage,
  '/me': MePage,
  '/vip': VipPage
};

const isCStandalone = computed(() => route.path === '/login');
const isLanding = computed(() => route.path === '/lp');

const pageComponent = computed(() => {
  if (C_PAGES[route.path]) return C_PAGES[route.path];
  if (route.path.startsWith('/detail/')) return DetailPage;
  if (route.path.startsWith('/play/')) return PlayPage;
  if (route.path === '/search') return SearchPage;
  return null;
});

const activeKey = computed(() => {
  if (route.path === '/') return 'home';
  if (route.path.startsWith('/detail/')) return '';
  if (route.path === '/search') return '';
  if (route.path === '/profile-edit') return 'me';
  return route.path.split('/')[1] || '';
});

const componentKey = computed(() => `${route.path}?${JSON.stringify(route.query)}`);

const pageTitle = computed(() => {
  if (route.path === '/login') return '登录 · 影巢';
  if (route.path.startsWith('/detail/')) return '影巢 · 详情';
  if (route.path.startsWith('/play/')) return '播放 · 影巢';
  const titles = {
    '/': '影巢 · 高清影视在线观看',
    '/category': '片库 · 影巢',
    '/adult': '成人频道 · 影巢',
    '/rank': '榜单 · 影巢',
    '/content-rank': '内容数据榜 · 影巢',
    '/playlists': '片单广场 · 影巢',
    '/posters': '海报墙 · 影巢',
    '/upcoming': '即将上线 · 影巢',
    '/favorites': '我的收藏 · 影巢',
    '/history': '观看历史 · 影巢',
    '/messages': '消息 · 影巢',
    '/orders': '我的订单 · 影巢',
    '/profile-edit': '编辑资料 · 影巢',
    '/promotion': '佣金推广 · 影巢',
    '/me': '个人中心 · 影巢',
    '/vip': '会员 · 影巢',
    '/search': '搜索 · 影巢',
    '/lp': '影巢 · 会员'
  };
  return titles[route.path] || '影巢';
});

watchEffect(() => {
  document.body.dataset.accent = 'c';
  document.title = pageTitle.value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0b0709');
});

onMounted(() => {
  loadConstants().catch(() => null);
  if (localStorage.getItem('mh-token')) refreshMe().catch(() => null);
});
</script>

<template>
  <LandingPage v-if="isLanding" />
  <LoginPage v-else-if="isCStandalone" />
  <AppShell v-else :active="activeKey">
    <component :is="pageComponent" v-if="pageComponent" :key="componentKey" />
    <div v-else class="empty">
      <Icon name="film" />
      <h3>页面不存在</h3>
      <p>这个地址没有对应的页面。</p>
      <a class="btn btn--ghost btn--sm" :href="href('/')">返回精选</a>
    </div>
  </AppShell>
  <ToastMessage />
</template>
