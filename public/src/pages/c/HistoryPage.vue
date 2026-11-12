<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import RankRow from '../../components/RankRow.vue';
import { href } from '../../router.js';
import { refreshMe, requireLogin, state } from '../../authState.js';

const loading = ref(true);
const error = ref('');
const history = computed(() => state.me?.history ?? []);

onMounted(async () => {
  try {
    await refreshMe();
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">观看历史</h1>
      <p class="meta">{{ history.length }} 条记录</p>
    </div>
    <a class="section-link" :href="href('/favorites')">我的收藏<Icon name="chevron" /></a>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="history" />
    <h3>正在加载观看记录</h3>
  </div>
  <div v-else-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后同步观看记录</h3>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后查看观看记录')">登录</button>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>记录加载失败</h3>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="history.length" class="panel">
    <div class="rank-list">
      <RankRow
        v-for="(row, index) in history"
        :key="row.dramaId"
        :to="`/play/${row.dramaId}/${row.episode}`"
        :rank="index + 1"
        :title="`${row.title} · 第 ${row.episode} 集`"
        :subtitle="`观看至 ${Number(row.position ?? 0).toFixed(0)} 秒`"
        action="继续"
      />
    </div>
  </div>
  <div v-else class="empty">
    <Icon name="history" />
    <h3>还没有观看记录</h3>
    <a class="btn btn--ghost btn--sm" :href="href('/category')">去片库看看</a>
  </div>
</template>
