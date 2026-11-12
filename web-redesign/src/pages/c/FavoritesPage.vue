<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { normalizeCard } from '../../models.js';
import { href } from '../../router.js';
import { refreshMe, requireLogin, state } from '../../authState.js';

const loading = ref(true);
const error = ref('');
const favorites = computed(() => (state.me?.favorites ?? []).map(normalizeCard));

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
      <h1 class="h1">我的收藏</h1>
      <p class="meta">{{ favorites.length }} 部已收藏</p>
    </div>
    <a class="section-link" :href="href('/category')">片库<Icon name="chevron" /></a>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="heart" />
    <h3>正在加载收藏</h3>
  </div>
  <div v-else-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后查看收藏</h3>
    <p>收藏记录保存在服务端账号中。</p>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后查看收藏')">登录</button>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>收藏加载失败</h3>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="favorites.length" class="film-grid">
    <PosterCard v-for="film in favorites" :key="film.id" :film="film" />
  </div>
  <div v-else class="empty">
    <Icon name="heart" />
    <h3>还没有收藏</h3>
    <p>在详情页收藏喜欢的片子，之后会出现在这里。</p>
    <a class="btn btn--ghost btn--sm" :href="href('/category')">去片库看看</a>
  </div>
</template>
