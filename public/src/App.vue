<script setup>
import { computed, defineAsyncComponent, onMounted, watchEffect } from 'vue';
import AppShell from './components/AppShell.vue';
import Icon from './components/Icon.vue';
import ToastMessage from './components/ToastMessage.vue';
import { initTracking } from './track.js';
import { t } from './i18n.js';
// 首屏关键路径（首页）保持同步，其余 21 个页面路由级分包：
// 原来 22 个页面静态 import 会把详情/播放/个人中心等一次性打进首屏 chunk。
import HomePage from './pages/c/HomePage.vue';

const CategoryPage = defineAsyncComponent(() => import('./pages/c/CategoryPage.vue'));
const AdultPage = defineAsyncComponent(() => import('./pages/c/AdultPage.vue'));
const ShortPage = defineAsyncComponent(() => import('./pages/c/ShortPage.vue'));
const RankPage = defineAsyncComponent(() => import('./pages/c/RankPage.vue'));
const ContentRankPage = defineAsyncComponent(() => import('./pages/c/ContentRankPage.vue'));
const PlaylistsPage = defineAsyncComponent(() => import('./pages/c/PlaylistsPage.vue'));
const PostersPage = defineAsyncComponent(() => import('./pages/c/PostersPage.vue'));
const UpcomingPage = defineAsyncComponent(() => import('./pages/c/UpcomingPage.vue'));
const FavoritesPage = defineAsyncComponent(() => import('./pages/c/FavoritesPage.vue'));
const HistoryPage = defineAsyncComponent(() => import('./pages/c/HistoryPage.vue'));
const MessagesPage = defineAsyncComponent(() => import('./pages/c/MessagesPage.vue'));
const OrdersPage = defineAsyncComponent(() => import('./pages/c/OrdersPage.vue'));
const ProfileEditPage = defineAsyncComponent(() => import('./pages/c/ProfileEditPage.vue'));
const PromotionPage = defineAsyncComponent(() => import('./pages/c/PromotionPage.vue'));
const MePage = defineAsyncComponent(() => import('./pages/c/MePage.vue'));
const VipPage = defineAsyncComponent(() => import('./pages/c/VipPage.vue'));
const DetailPage = defineAsyncComponent(() => import('./pages/c/DetailPage.vue'));
const PlayPage = defineAsyncComponent(() => import('./pages/c/PlayPage.vue'));
const SearchPage = defineAsyncComponent(() => import('./pages/c/SearchPage.vue'));
const LandingPage = defineAsyncComponent(() => import('./pages/c/LandingPage.vue'));
const LoginPage = defineAsyncComponent(() => import('./pages/c/LoginPage.vue'));
import { href, route } from './router.js';
import { loadConstants, refreshMe } from './authState.js';

const C_PAGES = {
  '/': HomePage,
  '/category': CategoryPage,
  '/adult': AdultPage,
  '/short': ShortPage,
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
  // 短剧频道挂在成人专区下，外层导航没有独立入口，高亮回到「成人」
  if (route.path === '/short') return 'adult';
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
    '/short': '短剧频道 · 影巢',
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
  initTracking();
  loadConstants().catch(() => null);
  if (localStorage.getItem('mh-token')) refreshMe().catch(() => null);
});
</script>

<template>
  <LandingPage v-if="isLanding" />
  <LoginPage v-else-if="isCStandalone" />
  <AppShell v-else :active="activeKey">
    <component :is="pageComponent" v-if="pageComponent" :key="componentKey" />
    <div v-else class="empty empty--art">
      <img class="empty-art" :src="'./art/empty-404.jpg'" alt="" />
      <h3>{{ t('页面不存在') }}</h3>
      <p>{{ t('这个地址没有对应的页面。') }}</p>
      <a class="btn btn--ghost btn--sm" :href="href('/')">{{ t('返回精选') }}</a>
    </div>
  </AppShell>
  <ToastMessage />
</template>
