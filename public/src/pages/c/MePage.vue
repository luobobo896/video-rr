<script setup>
import { computed, onMounted, ref } from 'vue';
import CheckoutDialog from '../../components/CheckoutDialog.vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { mediaUrl } from '../../api.js';
import { formatDate, normalizeCard, subscriptionDaysLeft } from '../../models.js';
import { href } from '../../router.js';
import { logout, refreshMe, requireLogin, state, toast } from '../../authState.js';

const loading = ref(true);
const error = ref('');
const checkoutOpen = ref(false);
const daysLeft = computed(() => subscriptionDaysLeft(state.me?.subscription));
const favorites = computed(() => (state.me?.favorites ?? []).slice(0, 3).map(normalizeCard));
const purchases = computed(() => state.me?.purchases ?? []);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    await refreshMe();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function signOut() {
  await logout();
  toast('已退出登录');
  await load();
}

onMounted(load);
</script>

<template>
  <div v-if="loading" class="empty">
    <Icon name="user" />
    <h3>正在加载个人中心</h3>
  </div>
  <div v-else-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后查看个人中心</h3>
    <p>观看记录、收藏、会员和单片权益都保存在账号中。</p>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后查看个人中心')">登录</button>
  </div>
  <template v-else>
    <h1 class="sr-only">个人中心</h1>
    <div class="profile">
      <span class="avatar">
        <img v-if="state.user.avatar" :src="mediaUrl(state.user.avatar)" alt="" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover" />
        <template v-else>{{ (state.user.nickname || state.user.email || '影')[0] }}</template>
      </span>
      <div class="profile-copy">
        <h2>{{ state.user.nickname || state.user.email }}</h2>
        <p>{{ state.user.email }}</p>
        <div class="completeness" style="margin-top: 10px">
          <div class="row-between">
            <span class="meta">资料完整度</span>
            <strong>{{ state.me?.completion?.percent ?? 0 }}%</strong>
          </div>
          <div class="completeness-track">
            <span :style="{ width: `${state.me?.completion?.percent ?? 0}%` }"></span>
          </div>
        </div>
      </div>
      <div class="toolbar">
        <a class="btn btn--ghost btn--sm" :href="href('/profile-edit')">编辑资料</a>
        <a class="btn btn--ghost btn--sm" :href="href('/vip')">管理会员</a>
      </div>
    </div>
    <div class="stat-strip">
      <div class="stat"><strong class="num">{{ daysLeft }}</strong><span>会员剩余天数</span></div>
      <div class="stat"><strong class="date">{{ formatDate(state.me?.subscription?.validTo) }}</strong><span>会员到期</span></div>
      <div class="stat"><strong>{{ state.me?.subscription ? '全站' : '未开通' }}</strong><span>畅看范围</span></div>
    </div>
    <div class="admin-grid">
      <a class="panel" :href="href('/history')">
        <div class="panel-head"><h3>观看历史</h3><Icon name="chevron" /></div>
        <p class="small muted">{{ state.me?.history?.length ?? 0 }} 条最近记录</p>
      </a>
      <a class="panel" :href="href('/favorites')">
        <div class="panel-head"><h3>我的收藏</h3><Icon name="chevron" /></div>
        <p class="small muted">{{ state.me?.favorites?.length ?? 0 }} 部已收藏</p>
      </a>
      <a class="panel" :href="href('/messages')">
        <div class="panel-head"><h3>消息</h3><Icon name="chevron" /></div>
        <p class="small muted">会员到期与订单状态通知</p>
      </a>
      <a class="panel" :href="href('/orders')">
        <div class="panel-head"><h3>我的订单</h3><Icon name="chevron" /></div>
        <p class="small muted">支付记录与待支付订单</p>
      </a>
    </div>
    <section>
      <div class="section-head">
        <div><h2>我的片单</h2><p>最近收藏</p></div>
        <a class="section-link" :href="href('/favorites')">查看全部<Icon name="chevron" /></a>
      </div>
      <div v-if="favorites.length" class="film-grid">
        <PosterCard v-for="film in favorites" :key="film.id" :film="film" />
      </div>
      <div v-else class="empty">
        <Icon name="heart" />
        <h3>还没有收藏</h3>
        <p>在详情页收藏后，最近加入的片子会显示在这里。</p>
      </div>
    </section>
    <section v-if="purchases.length" class="panel">
      <div class="panel-head"><h3>已购单片</h3><span class="meta">{{ purchases.length }} 部</span></div>
      <div class="todo-list">
        <div v-for="item in purchases" :key="item.dramaId" class="todo">
          <span class="todo-mark"><Icon name="check" /></span>
          <span class="todo-copy">
            <strong>{{ item.title }}</strong>
            <span>{{ item.kind === 'rental' ? `租赁至 ${formatDate(item.expiresAt)}` : '永久买断' }}</span>
          </span>
          <a class="btn btn--quiet btn--sm" :href="href(`/detail/${item.dramaId}`)">查看</a>
        </div>
      </div>
    </section>
    <div class="toolbar">
      <button v-if="!state.me?.subscription" class="btn btn--primary" type="button" @click="checkoutOpen = true">
        开通会员
      </button>
      <button class="btn btn--ghost" type="button" @click="signOut">
        <Icon name="logout" />退出登录
      </button>
    </div>
    <p v-if="error" class="field error">{{ error }}</p>
  </template>
  <CheckoutDialog v-model="checkoutOpen" title="开通会员" subtitle="全站畅看 · 成人专区同权" />
</template>
