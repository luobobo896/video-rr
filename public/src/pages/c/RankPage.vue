<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import RankRow from '../../components/RankRow.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { go, route } from '../../router.js';

const activeType = computed(() => route.query.type || 'HOT');
const lists = ref([]);
const items = ref([]);
const listName = ref('榜单');
const loading = ref(true);
const error = ref('');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const data = await publicApi(`/rank?type=${encodeURIComponent(activeType.value)}`);
    listName.value = data.listName || '榜单';
    lists.value = data.lists ?? [];
    items.value = (data.items ?? []).map(normalizeCard);
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
      <h1 class="h1">{{ listName }}</h1>
      <p class="meta">榜单由服务端生成 · 当前 {{ items.length }} 条</p>
    </div>
    <div class="segmented" style="max-width: 70vw; overflow-x: auto" role="group" aria-label="榜单类型">
      <button
        v-for="item in lists"
        :key="item.type"
        type="button"
        :aria-pressed="activeType === item.type"
        @click="go(`/rank?type=${encodeURIComponent(item.type)}`)"
      >
        {{ item.label || item.name }}
      </button>
    </div>
  </div>
  <h2 class="sr-only">榜单内容</h2>
  <div v-if="loading" class="empty">
    <Icon name="chart" />
    <h3>正在加载榜单</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>榜单加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>
  <div v-else-if="items.length" class="panel">
    <div class="rank-list">
      <RankRow
        v-for="(film, index) in items"
        :key="film.id"
        :to="`/detail/${film.id}`"
        :rank="film.rankNo || index + 1"
        :title="film.title"
        :subtitle="[film.typeLabel, film.year, film.area, film.playCount ? `${film.playCount} 次播放` : ''].filter(Boolean).join(' · ')"
        :score="film.score ? film.score.toFixed(1) : ''"
      />
    </div>
  </div>
  <div v-else class="empty">
    <Icon name="chart" />
    <h3>该榜单暂无内容</h3>
    <p>后台生成榜单后会自动显示。</p>
  </div>
</template>
