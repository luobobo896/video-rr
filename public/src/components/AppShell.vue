<script setup>
import { computed, ref } from 'vue';
import Icon from './Icon.vue';
import LoginDialog from './LoginDialog.vue';
import { getLang, setLang } from '../i18n.js';
import { go, href, route } from '../router.js';
import { isVip, state, ui } from '../authState.js';

const props = defineProps({
  active: { type: String, default: 'home' }
});

const query = ref('');
const lang = ref(getLang());
const focusedRoute = computed(
  () => route.path.startsWith('/detail/') || route.path.startsWith('/play/')
);

const groups = [
  {
    label: '发现',
    items: [
      { key: 'home', label: '精选', path: '/', icon: 'home' },
      { key: 'category', label: '片库', path: '/category', icon: 'grid' },
      { key: 'adult', label: '成人', path: '/adult', icon: 'lock', badge: '18+' },
      { key: 'rank', label: '榜单', path: '/rank', icon: 'chart' },
      { key: 'content-rank', label: '内容数据榜', path: '/content-rank', icon: 'chart' }
    ]
  },
  {
    label: '片单',
    items: [
      { key: 'playlists', label: '片单广场', path: '/playlists', icon: 'film' },
      { key: 'posters', label: '海报墙', path: '/posters', icon: 'grid' },
      { key: 'upcoming', label: '即将上线', path: '/upcoming', icon: 'clock' }
    ]
  },
  {
    label: '我的',
    items: [
      { key: 'history', label: '观看历史', path: '/history', icon: 'history' },
      { key: 'favorites', label: '我的收藏', path: '/favorites', icon: 'heart' },
      { key: 'messages', label: '消息', path: '/messages', icon: 'bell' },
      { key: 'orders', label: '我的订单', path: '/orders', icon: 'orders' },
      { key: 'promotion', label: '佣金推广', path: '/promotion', icon: 'share' },
      { key: 'me', label: '个人中心', path: '/me', icon: 'user' },
      { key: 'vip', label: '会员', path: '/vip', icon: 'crown' }
    ]
  }
];

const bottomItems = [
  { key: 'home', label: '精选', path: '/', icon: 'home' },
  { key: 'category', label: '片库', path: '/category', icon: 'grid' },
  { key: 'adult', label: '成人', path: '/adult', icon: 'lock' },
  { key: 'rank', label: '榜单', path: '/rank', icon: 'chart' },
  { key: 'me', label: '我的', path: '/me', icon: 'user' },
  { key: 'messages', label: '消息', path: '/messages', icon: 'bell' }
];

const userInitial = computed(() => (state.user?.nickname || state.user?.email || '影').slice(0, 1));
const vipPrice = computed(() => state.constants?.vipPrice ?? '25');
const adultEnabled = computed(() => state.constants?.adultMenu?.enabled !== false);
const visibleGroups = computed(() =>
  groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.key !== 'adult' || adultEnabled.value)
    }))
    .filter((group) => group.items.length)
);
const visibleBottomItems = computed(() =>
  bottomItems.filter((item) => item.key !== 'adult' || adultEnabled.value)
);

function submitSearch() {
  const value = query.value.trim();
  if (value) go(`/search?q=${encodeURIComponent(value)}`);
}

function toggleLang() {
  const next = lang.value === 'en' ? 'zh' : 'en';
  const url = new URL(window.location.href);
  url.searchParams.set('lang', next);
  window.history.replaceState(null, '', url);
  setLang(next);
  window.location.reload();
}
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <a class="brand" :href="href('/')" aria-label="影巢首页">
        <span class="brand-mark">影</span>
        <span class="brand-name">影巢<span class="brand-sub">CINEMA NEST</span></span>
      </a>

      <div class="sidebar-scroll">
        <nav
          v-for="group in visibleGroups"
          :key="group.label"
          class="nav-group"
          :aria-label="group.label"
        >
          <span class="nav-label">{{ group.label }}</span>
          <a
            v-for="item in group.items"
            :key="item.key"
            class="nav-item"
            :href="href(item.path)"
            :aria-current="active === item.key ? 'page' : undefined"
          >
            <Icon :name="item.icon" />
            {{ item.label }}
            <span v-if="item.badge" class="nav-18">{{ item.badge }}</span>
          </a>
        </nav>
      </div>

      <div class="sidebar-foot">
        <div v-if="!isVip" class="side-card">
          <strong>
            {{ lang === 'en' ? `Plans from ¥${vipPrice}` : `会员套餐 ¥${vipPrice} 起` }}
          </strong>
          <p>
            {{ lang === 'en' ? 'Monthly, quarterly and annual plans · Adult channel included' : '月卡 / 季卡 / 年卡可选，成人专区同权。' }}
          </p>
          <a class="btn btn--primary btn--sm btn--block" :href="href('/vip')">
            {{ lang === 'en' ? 'View plans' : '查看套餐' }}
          </a>
        </div>
        <p class="meta">© 2026 影巢</p>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <template v-if="focusedRoute">
          <a class="icon-btn" :href="href('/')" aria-label="返回首页"><Icon name="back" /></a>
          <a class="brand" :href="href('/')"><span class="brand-mark">影</span><span class="brand-name">影巢</span></a>
        </template>
        <a v-else class="topbar-brand" :href="href('/')"><span class="brand-mark">影</span>影巢</a>
        <form v-if="!focusedRoute" class="search" role="search" @submit.prevent="submitSearch">
          <Icon name="search" />
          <input
            v-model="query"
            type="search"
            placeholder="搜索片名、类型、标签"
            aria-label="搜索片库"
          />
        </form>
        <div class="top-actions">
          <a class="icon-btn" :href="href('/history')" aria-label="观看历史" data-desktop>
            <Icon name="history" />
          </a>
          <a class="icon-btn" :href="href('/favorites')" aria-label="收藏" data-desktop>
            <Icon name="heart" />
          </a>
          <a class="icon-btn" :href="href('/vip')" aria-label="会员权益">
            <Icon name="crown" />
          </a>
          <a class="icon-btn" :href="href('/messages')" aria-label="消息">
            <Icon name="bell" />
          </a>
          <button
            class="icon-btn lang-switch"
            type="button"
            :aria-label="lang === 'en' ? '切换到中文' : 'Switch to English'"
            @click="toggleLang"
          >
            {{ lang === 'en' ? '中' : 'EN' }}
          </button>
          <div class="account">
            <a
              v-if="state.user"
              class="account"
              :href="href('/me')"
              aria-label="个人中心"
            >
              <span class="avatar">{{ userInitial }}</span>
              <span class="small account-name">{{ state.user.nickname || state.user.email }}</span>
            </a>
            <button v-else class="btn btn--ghost btn--sm" type="button" @click="ui.loginOpen = true; ui.loginMessage = ''">
              <Icon name="user" />登录
            </button>
          </div>
        </div>
      </header>

      <main class="page">
        <slot />
      </main>
    </div>
  </div>

  <nav
    class="bottom-nav"
    aria-label="主导航"
    :style="{ gridTemplateColumns: `repeat(${visibleBottomItems.length}, 1fr)` }"
  >
    <a
      v-for="item in visibleBottomItems"
      :key="item.key"
      :href="href(item.path)"
      :aria-current="active === item.key ? 'page' : undefined"
    >
      <Icon :name="item.icon" />{{ item.label }}
    </a>
  </nav>

  <LoginDialog v-model="ui.loginOpen" />
</template>
