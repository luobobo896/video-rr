<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { go, route } from '../../router.js';

const query = computed(() => route.query.q || '');
const input = ref(query.value);
const results = ref([]);
const hotwords = ref([]);
const loading = ref(false);
const error = ref('');
let requestSeq = 0;

async function search(keyword) {
  const seq = ++requestSeq;
  if (!keyword.trim()) {
    results.value = [];
    error.value = '';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const data = await publicApi(`/search?keyword=${encodeURIComponent(keyword.trim())}`);
    if (seq !== requestSeq) return;
    results.value = (data.list ?? []).map(normalizeCard);
  } catch (requestError) {
    if (seq === requestSeq) error.value = requestError.message;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function submit() {
  const value = input.value.trim();
  if (value) go(`/search?q=${encodeURIComponent(value)}`);
}

function pickHotword(word) {
  input.value = word;
  go(`/search?q=${encodeURIComponent(word)}`);
}

watch(query, (value) => {
  input.value = value;
  search(value);
}, { immediate: true });

onMounted(async () => {
  try {
    const data = await publicApi('/home');
    hotwords.value = data.hotwords ?? [];
  } catch {
    hotwords.value = [];
  }
});
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">搜索</h1>
      <p class="meta">
        {{ query ? `“${query}” · ${results.length} 个结果` : '输入片名、类型或标签' }}
      </p>
    </div>
  </div>
  <h2 class="sr-only">搜索结果</h2>
  <form class="toolbar" style="max-width: 560px" @submit.prevent="submit">
    <label class="search" style="flex: 1">
      <Icon name="search" />
      <input v-model="input" placeholder="搜索片库" aria-label="搜索片库" />
    </label>
    <button class="btn btn--primary btn--sm" type="submit">搜索</button>
  </form>
  <div v-if="!query && hotwords.length" class="toolbar" style="margin-top: 12px">
    <span class="meta">热门搜索</span>
    <button
      v-for="word in hotwords.slice(0, 8)"
      :key="word"
      class="chip"
      type="button"
      @click="pickHotword(word)"
    >
      {{ word }}
    </button>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="search" />
    <h3>正在搜索</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>搜索失败</h3>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="results.length" class="film-grid" style="margin-top: 24px">
    <PosterCard v-for="film in results" :key="film.id" :film="film" />
  </div>
  <div v-else-if="query" class="empty">
    <Icon name="search" />
    <h3>没有找到匹配的片子</h3>
    <p>换个关键词再试。</p>
  </div>
</template>
