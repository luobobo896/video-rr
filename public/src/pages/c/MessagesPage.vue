<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { publicApi } from '../../api.js';
import { formatDateTime } from '../../models.js';
import { requireLogin, state } from '../../authState.js';

const messages = ref([]);
const loading = ref(true);
const error = ref('');
const type = ref('all');
const types = [
  { value: 'all', label: '全部' },
  { value: 'subscription', label: '会员通知' },
  { value: 'order', label: '订单通知' }
];
const labels = { subscription: '会员通知', order: '订单通知' };
const icons = { subscription: '会', order: '单' };

const filtered = computed(() => {
  const rows = [...messages.value].sort(
    (a, b) => new Date(String(b.createdAt || '').replace(' ', 'T')) - new Date(String(a.createdAt || '').replace(' ', 'T'))
  );
  return type.value === 'all' ? rows : rows.filter((row) => row.type === type.value);
});

async function load() {
  if (!state.user) {
    loading.value = false;
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await publicApi('/me/messages');
    messages.value = data.messages ?? [];
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">消息</h1>
      <p class="meta">{{ messages.length }} 条消息 · 会员与订单通知</p>
    </div>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">刷新</button>
  </div>
  <h2 class="sr-only">消息列表</h2>

  <div v-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后查看消息</h3>
    <p>会员到期提醒与订单状态会显示在这里。</p>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后查看消息')">登录</button>
  </div>
  <div v-else-if="loading" class="empty">
    <Icon name="bell" />
    <h3>正在加载消息</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>消息加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>
  <template v-else>
    <div class="toolbar">
      <button
        v-for="item in types"
        :key="item.value"
        class="chip"
        type="button"
        :aria-pressed="type === item.value"
        @click="type = item.value"
      >{{ item.label }}</button>
    </div>
    <div class="panel">
      <div v-if="filtered.length" class="message-list">
        <article v-for="(item, index) in filtered" :key="`${item.type}-${item.createdAt}-${index}`" class="message-item">
          <span class="message-icon" aria-hidden="true">{{ icons[item.type] || '讯' }}</span>
          <div class="message-copy">
            <strong>{{ item.title }}</strong>
            <p>{{ item.body }}</p>
            <time>{{ formatDateTime(item.createdAt) }}</time>
          </div>
          <a v-if="item.type === 'order'" class="btn btn--quiet btn--sm" href="#/orders">查看订单</a>
          <a v-else-if="item.type === 'subscription'" class="btn btn--quiet btn--sm" href="#/vip">会员套餐</a>
          <span v-else class="badge badge--muted">{{ labels[item.type] || '通知' }}</span>
        </article>
      </div>
      <div v-else class="empty">
        <Icon name="bell" />
        <h3>暂无消息</h3>
        <p>这个分类下还没有通知。</p>
      </div>
    </div>
    <p class="meta">消息由服务端根据会员与订单状态生成；需要人工协助请联系客服邮箱。</p>
  </template>
</template>
