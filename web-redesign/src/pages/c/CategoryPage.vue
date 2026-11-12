<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';

const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 24;
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const expanded = ref(false);
const facets = ref({
  channels: [],
  sorts: [],
  regions: [],
  genres: [],
  years: [],
  tags: []
});
const filters = reactive({
  type: 'ALL',
  sort: 'hot',
  region: '',
  year: '',
  genre: '',
  tag: ''
});

let requestSeq = 0;
const currentChannel = computed(
  () => facets.value.channels.find((row) => row.value === filters.type) ?? { label: '全部' }
);
const sortLabel = computed(
  () => facets.value.sorts.find((row) => row.value === filters.sort)?.label ?? '最热'
);
const hasFilter = computed(() =>
  Boolean(filters.region || filters.year || filters.genre || filters.tag || filters.type !== 'ALL')
);
const canLoadMore = computed(() => items.value.length < total.value);

function query(nextPage) {
  const params = new URLSearchParams({
    type: filters.type,
    page: String(nextPage),
    pageSize: String(pageSize),
    sort: filters.sort
  });
  for (const key of ['region', 'year', 'genre', 'tag']) {
    if (filters[key]) params.set(key, filters[key]);
  }
  return params;
}

async function load({ reset = true } = {}) {
  const seq = ++requestSeq;
  if (reset) {
    page.value = 1;
    loading.value = true;
  } else {
    loadingMore.value = true;
  }
  error.value = '';
  try {
    const data = await publicApi(`/category?${query(reset ? 1 : page.value + 1)}`);
    if (seq !== requestSeq) return;
    items.value = reset
      ? (data.list ?? []).map(normalizeCard)
      : items.value.concat((data.list ?? []).map(normalizeCard));
    total.value = Number(data.total ?? 0);
    page.value = Number(data.page ?? page.value);
    facets.value = { ...facets.value, ...(data.facets ?? {}) };
  } catch (requestError) {
    if (seq === requestSeq) error.value = requestError.message;
  } finally {
    if (seq === requestSeq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

function apply(key, value) {
  filters[key] = filters[key] === value ? (key === 'type' ? 'ALL' : key === 'sort' ? 'hot' : '') : value;
  void load();
}

function resetFilters() {
  Object.assign(filters, { type: 'ALL', sort: 'hot', region: '', year: '', genre: '', tag: '' });
  void load();
}

onMounted(() => load());
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">{{ filters.type === 'ALL' ? '片库' : currentChannel.label }}</h1>
      <p class="meta">
        共 {{ total }} 部 · 按{{ sortLabel }}
        <template v-if="filters.region"> · {{ facets.regions.find((row) => row.value === filters.region)?.label }}</template>
        <template v-if="filters.year"> · {{ facets.years.find((row) => row.value === filters.year)?.label }}</template>
        <template v-if="filters.genre"> · {{ filters.genre }}</template>
      </p>
    </div>
    <button v-if="hasFilter" class="btn btn--ghost btn--sm" type="button" @click="resetFilters">
      清空筛选
    </button>
  </div>

  <div class="adult-filters">
    <div class="filter-group">
      <span class="filter-label">频道</span>
      <button
        v-for="row in facets.channels"
        :key="row.value"
        class="chip"
        type="button"
        :aria-pressed="filters.type === row.value"
        @click="apply('type', row.value)"
      >
        {{ row.label }}{{ row.count !== undefined ? ` ${row.count}` : '' }}
      </button>
    </div>
    <div class="filter-group">
      <span class="filter-label">排序</span>
      <button
        v-for="row in facets.sorts"
        :key="row.value"
        class="chip"
        type="button"
        :aria-pressed="filters.sort === row.value"
        @click="apply('sort', row.value)"
      >
        {{ row.label }}
      </button>
    </div>
    <div class="filter-group">
      <span class="filter-label">地区</span>
      <button
        v-for="row in facets.regions"
        :key="row.value"
        class="chip"
        type="button"
        :aria-pressed="filters.region === row.value"
        @click="apply('region', row.value)"
      >
        {{ row.label }}{{ row.count ? ` ${row.count}` : '' }}
      </button>
    </div>
    <div class="filter-group">
      <span class="filter-label">类型</span>
      <button
        v-for="row in (expanded ? facets.genres : facets.genres.slice(0, 8))"
        :key="row.value"
        class="chip"
        type="button"
        :aria-pressed="filters.genre === row.value"
        @click="apply('genre', row.value)"
      >
        {{ row.label }}{{ row.count ? ` ${row.count}` : '' }}
      </button>
    </div>
    <div class="filter-group">
      <span class="filter-label">年份</span>
      <button
        v-for="row in facets.years.slice(0, expanded ? facets.years.length : 5)"
        :key="row.value"
        class="chip"
        type="button"
        :aria-pressed="filters.year === row.value"
        @click="apply('year', row.value)"
      >
        {{ row.label }}
      </button>
    </div>
    <div v-if="expanded && facets.tags.length" class="filter-group">
      <span class="filter-label">标签</span>
      <button
        v-for="row in facets.tags"
        :key="row.value"
        class="chip"
        type="button"
        :aria-pressed="String(filters.tag) === String(row.value)"
        @click="apply('tag', row.value)"
      >
        {{ row.label }}{{ row.count ? ` ${row.count}` : '' }}
      </button>
    </div>
    <div class="toolbar">
      <button class="btn btn--quiet btn--sm" type="button" @click="expanded = !expanded">
        {{ expanded ? '收起筛选' : '更多筛选' }}
      </button>
    </div>
  </div>

  <h2 class="sr-only">片库内容</h2>
  <div v-if="loading" class="empty">
    <Icon name="film" />
    <h3>正在加载片库</h3>
    <p>筛选结果来自服务端。</p>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>片库加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load()">重试</button>
  </div>
  <template v-else>
    <div v-if="items.length" class="film-grid">
      <PosterCard v-for="film in items" :key="film.id" :film="film" />
    </div>
    <div v-else class="empty">
      <Icon name="search" />
      <h3>没有匹配的内容</h3>
      <p>换一个筛选条件看看。</p>
      <button class="btn btn--ghost btn--sm" type="button" @click="resetFilters">清空筛选</button>
    </div>
    <div v-if="canLoadMore" class="toolbar" style="justify-content: center">
      <button class="btn btn--ghost" type="button" :disabled="loadingMore" @click="load({ reset: false })">
        {{ loadingMore ? '加载中' : '加载更多' }}
      </button>
    </div>
  </template>
</template>
