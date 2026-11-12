<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { publicApi } from '../../api.js';
import { formatDateTime, formatMoney, STATUS_LABEL, statusClass } from '../../models.js';
import { requireLogin, state, toast } from '../../authState.js';

const orders = ref([]);
const loading = ref(true);
const error = ref('');
const filter = ref('all');
const expanded = ref('');
const paying = ref('');
const payLinks = reactive({});
const groups = [
  { value: 'all', label: '全部' },
  { value: 'created', label: '待支付' },
  { value: 'pending', label: '处理中' },
  { value: 'paid', label: '已支付' },
  { value: 'fulfilled', label: '已完成' },
  { value: 'refunded', label: '已退款' }
];

const filtered = computed(() =>
  filter.value === 'all' ? orders.value : orders.value.filter((row) => row.status === filter.value)
);
const pendingCount = computed(() =>
  orders.value.filter((row) => ['created', 'pending'].includes(row.status)).length
);

async function load() {
  if (!state.user) {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await publicApi('/orders');
    orders.value = data.list ?? [];
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

async function continuePay(row) {
  if (paying.value) return;
  paying.value = row.outTradeNo;
  try {
    const data = await publicApi(`/orders/${encodeURIComponent(row.outTradeNo)}`);
    payLinks[row.outTradeNo] = data.payUrl || '';
    if (data.payUrl) {
      window.open(data.payUrl, '_blank', 'noopener');
      toast('支付页已打开');
    } else {
      toast(data.payReason || '当前渠道暂时无法支付', 'bad');
    }
  } catch (requestError) {
    toast(requestError.message, 'bad');
  } finally {
    paying.value = '';
  }
}

function titleOf(row) {
  if (row.productType === 'subscription') return row.planName || '会员订阅';
  return row.dramaTitle || '单片购买';
}

onMounted(load);
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">我的订单</h1>
      <p class="meta">{{ orders.length }} 笔订单 · {{ pendingCount }} 笔待支付</p>
    </div>
    <div class="toolbar">
      <a class="section-link" href="#/vip">去开通会员<Icon name="chevron" /></a>
      <button class="btn btn--ghost btn--sm" type="button" @click="load">刷新</button>
    </div>
  </div>
  <h2 class="sr-only">订单列表</h2>
  <div class="toolbar">
    <button
      v-for="item in groups"
      :key="item.value"
      class="chip"
      type="button"
      :aria-pressed="filter === item.value"
      @click="filter = item.value"
    >{{ item.label }}</button>
  </div>

  <div v-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后查看订单</h3>
    <p>会员订阅与单片购买记录会保存在账号中。</p>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后查看订单')">登录</button>
  </div>
  <div v-else-if="loading" class="empty">
    <Icon name="orders" />
    <h3>正在加载订单</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>订单加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>
  <div v-else-if="filtered.length" class="order-list">
    <article v-for="row in filtered" :key="row.id" class="order-card">
      <div>
        <h3>{{ titleOf(row) }}</h3>
        <p>{{ row.outTradeNo }} · {{ formatDateTime(row.createdAt) }} · {{ row.channel }}</p>
      </div>
      <div class="order-side">
        <span class="badge" :class="statusClass(row.status)">{{ row.statusLabel || STATUS_LABEL[row.status] || row.status }}</span>
        <strong class="order-amount">{{ formatMoney(row.amount) }}</strong>
        <div class="order-actions">
          <button
            v-if="['created', 'pending'].includes(row.status)"
            class="btn btn--primary btn--sm"
            type="button"
            :disabled="paying === row.outTradeNo"
            @click="continuePay(row)"
          >{{ paying === row.outTradeNo ? '获取中…' : '继续支付' }}</button>
          <a
            v-if="payLinks[row.outTradeNo]"
            class="btn btn--quiet btn--sm"
            :href="payLinks[row.outTradeNo]"
            target="_blank"
            rel="noopener"
          >打开支付页</a>
          <button class="btn btn--ghost btn--sm" type="button" @click="expanded = expanded === row.outTradeNo ? '' : row.outTradeNo">
            {{ expanded === row.outTradeNo ? '收起' : '订单详情' }}
          </button>
        </div>
      </div>
      <div v-if="expanded === row.outTradeNo" class="detail-facts" style="grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 12px">
        <span><strong>订单号</strong> {{ row.outTradeNo }}</span>
        <span><strong>支付渠道</strong> {{ row.channel || '—' }}</span>
        <span><strong>支付时间</strong> {{ formatDateTime(row.paidAt) }}</span>
        <span><strong>关闭时间</strong> {{ formatDateTime(row.closedAt) }}</span>
      </div>
    </article>
  </div>
  <div v-else class="empty">
    <Icon name="orders" />
    <h3>暂无订单</h3>
    <p>会员订阅或单片购买记录会出现在这里。</p>
    <a class="btn btn--ghost btn--sm" href="#/vip">去开通会员</a>
  </div>
</template>
