<script setup>
import { onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { href } from '../../router.js';

const films = ref([]);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    const data = await publicApi('/category?type=ALL&page=1&pageSize=24&sort=upcoming');
    films.value = (data.list ?? []).map(normalizeCard);
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
      <h1 class="h1">即将上线</h1>
      <p class="meta">按上线时间排序 · {{ films.length }} 部</p>
    </div>
    <a class="section-link" :href="href('/category')">片库<Icon name="chevron" /></a>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="clock" />
    <h3>正在加载待播片单</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>片单加载失败</h3>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="films.length" class="film-grid">
    <PosterCard v-for="film in films" :key="film.id" :film="film" />
  </div>
  <div v-else class="empty">
    <Icon name="clock" />
    <h3>暂无待播内容</h3>
    <p>后台发布待播片单后会显示在这里。</p>
  </div>
</template>
