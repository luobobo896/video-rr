<script setup>
import { onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizedSection } from '../../models.js';
import { href } from '../../router.js';

const sections = ref([]);
const loading = ref(true);
const error = ref('');

onMounted(async () => {
  try {
    const data = await publicApi('/home');
    sections.value = (data.sections ?? [])
      .map(normalizedSection)
      .filter((section) => section.items.length);
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
      <h1 class="h1">片单广场</h1>
      <p class="meta">运营维护的首页片单</p>
    </div>
    <a class="section-link" :href="href('/posters')">海报墙<Icon name="chevron" /></a>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="film" />
    <h3>正在加载片单</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>片单加载失败</h3>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="sections.length" class="admin-grid">
    <div v-for="section in sections" :key="section.id" class="panel">
      <div class="panel-head">
        <h3>{{ section.title }}</h3>
        <span class="badge badge--muted">{{ section.items.length }} 部</span>
      </div>
      <div class="film-grid">
        <PosterCard v-for="film in section.items.slice(0, 6)" :key="film.id" :film="film" />
      </div>
    </div>
  </div>
  <div v-else class="empty">
    <Icon name="film" />
    <h3>还没有片单</h3>
    <p>后台在首页楼层添加内容后会显示在这里。</p>
  </div>
</template>
