<script setup>
import { computed, onMounted, ref } from 'vue';
import CheckoutDialog from '../../components/CheckoutDialog.vue';
import Icon from '../../components/Icon.vue';
import { formatMoney, subscriptionDaysLeft } from '../../models.js';
import { href } from '../../router.js';
import {
  isVip,
  loadPlans,
  refreshMe,
  requireLogin,
  state
} from '../../authState.js';

const loading = ref(true);
const error = ref('');
const checkoutOpen = ref(false);
const plans = computed(() => state.plans);
const daysLeft = computed(() => subscriptionDaysLeft(state.me?.subscription));

onMounted(async () => {
  try {
    await Promise.all([loadPlans(), refreshMe().catch(() => null)]);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
});

function openCheckout() {
  if (!state.user) {
    requireLogin('登录后即可开通会员');
    return;
  }
  checkoutOpen.value = true;
}
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">会员</h1>
      <p class="meta">全站畅看 · 成人专区同权</p>
    </div>
  </div>
  <h2 class="sr-only">会员权益与开通</h2>
  <div v-if="loading" class="empty">
    <Icon name="crown" />
    <h3>正在加载会员套餐</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>套餐加载失败</h3>
    <p>{{ error }}</p>
  </div>
  <template v-else>
    <div class="admin-grid">
      <div class="panel">
        <div class="panel-head">
          <h3>会员权益</h3>
          <span class="badge" :class="isVip ? 'badge--ok' : 'badge--muted'">
            {{ isVip ? `剩余 ${daysLeft} 天` : '当前可开通' }}
          </span>
        </div>
        <ul class="checklist">
          <li><Icon name="check" />全站剧集畅看</li>
          <li><Icon name="check" />4K 原画与双端同步</li>
          <li><Icon name="check" />成人专区同权</li>
          <li><Icon name="check" />服务端权益实时生效</li>
        </ul>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>在售套餐</h3><span class="meta">{{ plans.length }} 个</span></div>
        <div class="plan-grid" style="grid-template-columns: 1fr">
          <div v-for="plan in plans" :key="plan.id" class="plan">
            <strong>{{ plan.name }}</strong>
            <span>{{ plan.description }}</span>
            <b>{{ formatMoney(plan.price) }} / {{ plan.days }} 天</b>
          </div>
        </div>
        <button class="btn btn--primary btn--block" style="margin-top: 16px" type="button" @click="openCheckout">
          {{ state.user ? (isVip ? '立即续费' : '立即开通') : '登录后开通' }}
        </button>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h3>支付说明</h3></div>
      <p class="small muted">价格与可用支付渠道由服务端返回。下单后跳转收银台，会员权益仅在支付确认后发放。</p>
      <p class="meta" style="margin-top: 8px">
        账号：{{ state.user?.email || '未登录' }}
        <template v-if="!state.user"> · <a :href="href('/login')">去登录</a></template>
      </p>
    </div>
  </template>
  <CheckoutDialog v-model="checkoutOpen" title="开通会员" subtitle="全站畅看 · 成人专区同权" />
</template>
