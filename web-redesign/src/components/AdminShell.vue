<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { go, href } from '../router.js';
import {
  adminState,
  loadAdminMe,
  logoutAdmin,
  toast
} from '../authState.js';

defineProps({
  active: { type: String, default: 'overview' },
  title: { type: String, default: '概览' },
  subtitle: { type: String, default: '' }
});

const updatedAt = ref(
  new Date().toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
);

const groups = [
  {
    label: '数据概览',
    items: [
      { key: 'overview', label: '概览', icon: 'chart' },
      { key: 'analytics', label: '经营数据', icon: 'chart' },
      { key: 'tracking', label: '埋点数据', icon: 'chart' },
      { key: 'channels', label: '渠道分析', icon: 'chart' }
    ]
  },
  {
    label: '内容运营',
    items: [
      { key: 'dramas', label: '剧集管理', icon: 'film' },
      { key: 'policies', label: '付费策略', icon: 'settings' },
      { key: 'adult', label: '成人菜单', icon: 'lock', badge: '18+' },
      { key: 'tags', label: '标签管理', icon: 'grid' },
      { key: 'ranks', label: '榜单', icon: 'star' },
      { key: 'moderation', label: '内容审核', icon: 'alert' },
      { key: 'content-stats', label: '内容统计', icon: 'chart' }
    ]
  },
  {
    label: '交易与财务',
    items: [
      { key: 'plans', label: '套餐定价', icon: 'crown' },
      { key: 'coupons', label: '优惠券', icon: 'star' },
      { key: 'orders', label: '订单', icon: 'orders' },
      { key: 'refunds', label: '退款审核', icon: 'refresh' },
      { key: 'distribution', label: '分销分析', icon: 'share' },
      { key: 'distribution-config', label: '分销配置', icon: 'settings' }
    ]
  },
  {
    label: '用户',
    items: [{ key: 'users', label: 'C 端用户', icon: 'user' }]
  },
  {
    label: '系统设置',
    items: [
      { key: 'menus', label: '菜单管理', icon: 'grid' },
      { key: 'roles', label: '角色管理', icon: 'settings' },
      { key: 'admin-users', label: '用户管理', icon: 'user' },
      { key: 'audit', label: '审计日志', icon: 'clock' },
      { key: 'pay', label: '支付渠道', icon: 'orders' },
      { key: 'mail', label: '邮件设置', icon: 'bell' }
    ]
  }
];

const flatItems = groups.flatMap((group) => group.items);
const accountName = computed(() => {
  const admin = adminState.me?.admin;
  return admin?.displayName || admin?.username || 'admin';
});
const roleName = computed(() =>
  (adminState.me?.roles ?? []).map((role) => role.name).join(' / ') || '管理员'
);
const accountLabel = computed(() =>
  roleName.value && roleName.value !== accountName.value
    ? `${accountName.value} · ${roleName.value}`
    : accountName.value
);
const fullAdminUrl = import.meta.env.DEV ? 'http://127.0.0.1:5174/' : '/video-admin/';

async function signOut() {
  await logoutAdmin();
  go('/admin/login');
  toast('已退出后台');
}

onMounted(async () => {
  if (!adminState.token) {
    go('/admin/login');
    return;
  }
  if (!adminState.me) {
    try {
      await loadAdminMe();
    } catch {
      go('/admin/login');
    }
  }
});
</script>

<template>
  <div class="app">
    <aside class="sidebar">
      <a class="brand" :href="href('/admin/overview')" aria-label="运营后台首页">
        <span class="brand-mark">影</span>
        <span class="brand-name">影巢运营<span class="brand-sub">OPS CONSOLE</span></span>
      </a>
      <div class="sidebar-scroll">
        <nav
          v-for="group in groups"
          :key="group.label"
          class="nav-group"
          :aria-label="group.label"
        >
          <span class="nav-label">{{ group.label }}</span>
          <a
            v-for="item in group.items"
            :key="item.key"
            class="nav-item"
            :href="href(`/admin/${item.key}`)"
            :aria-current="active === item.key ? 'page' : undefined"
          >
            <Icon :name="item.icon" />
            {{ item.label }}
            <span v-if="item.badge" class="nav-18">{{ item.badge }}</span>
          </a>
        </nav>
      </div>
      <div class="sidebar-foot">
        <div class="side-card">
          <strong>{{ accountLabel }}</strong>
          <p>{{ adminState.me?.permissions?.length ?? 0 }} 个权限点；退款操作需第二位管理员复核。</p>
          <a class="btn btn--ghost btn--sm btn--block" :href="href('/')">打开 C 端</a>
        </div>
        <button class="nav-item" type="button" @click="signOut"><Icon name="logout" />退出登录</button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <a class="topbar-brand" :href="href('/admin/overview')">
          <span class="brand-mark">影</span>影巢运营后台
        </a>
        <span class="badge badge--ok"><span class="dot"></span>在线</span>
        <span id="updated-at" class="meta">更新于 {{ updatedAt }}</span>
        <div class="top-actions">
          <a class="btn btn--ghost btn--sm" :href="href('/')">C 端首页</a>
          <a class="icon-btn" :href="href('/admin/audit')" aria-label="审计日志">
            <Icon name="bell" />
          </a>
          <div class="account">
            <span class="avatar">{{ accountName.slice(0, 1) }}</span>
            <span class="small account-name">{{ accountLabel }}</span>
          </div>
        </div>
      </header>

      <nav class="admin-tabs" aria-label="后台导航">
        <a
          v-for="item in flatItems"
          :key="item.key"
          :href="href(`/admin/${item.key}`)"
          :aria-current="active === item.key ? 'page' : undefined"
        >
          {{ item.label }}
        </a>
      </nav>

      <main class="page">
        <div class="page-head">
          <div>
            <h1>{{ title }}</h1>
            <p>{{ subtitle }}</p>
          </div>
          <div class="actions">
            <a class="btn btn--ghost btn--sm" :href="fullAdminUrl" target="_blank" rel="noopener">
              完整后台
            </a>
            <a class="btn btn--ghost btn--sm" :href="href('/')">打开 C 端</a>
          </div>
        </div>
        <slot />
      </main>
    </div>
  </div>
</template>
