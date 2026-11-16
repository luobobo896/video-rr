<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { appendUnique, clampPage, totalPagesOf } from '../../list-utils.js';
import { readListState, writeHashParams } from '../../table-state.js';

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
const canLoadMore = computed(
  () => page.value < totalPagesOf(total.value, pageSize) && items.value.length < total.value
);

// 筛选与页码写进 URL hash query（条目 10）：刷新 / 后退能还原，沿用 table-state.js 的 API
const STATE_KEYS = ['type', 'sort', 'region', 'year', 'genre', 'tag', 'page'];

function syncUrl() {
  writeHashParams({
    type: filters.type,
    sort: filters.sort,
    region: filters.region,
    year: filters.year,
    genre: filters.genre,
    tag: filters.tag,
    page: page.value > 1 ? page.value : ''
  });
}

function readUrlState() {
  const saved = readListState(STATE_KEYS, globalThis.location?.hash ?? '');
  for (const key of ['type', 'sort', 'region', 'year', 'genre', 'tag']) {
    if (saved[key]) filters[key] = saved[key];
  }
  return Math.max(1, Math.floor(Number(saved.page) || 1));
}

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

async function load({ reset = true, targetPage = 0, quiet = false } = {}) {
  const seq = ++requestSeq;
  const nextPage = reset ? 1 : Math.max(1, targetPage || page.value + 1);
  if (reset) {
    if (!quiet) loading.value = true;
  } else if (!quiet) {
    loadingMore.value = true;
  }
  error.value = '';
  try {
    const data = await publicApi(`/category?${query(nextPage)}`);
    if (seq !== requestSeq) return;
    const incoming = (data.list ?? []).map(normalizeCard);
    total.value = Number(data.total ?? 0);
    // 追加时按 id 去重：服务端分页在数据变动时会把同一部片放进相邻两页
    items.value = reset ? appendUnique([], incoming) : appendUnique(items.value, incoming);
    // page 用本次响应的 total 夹：切换筛选后旧 total 会把页码夹到不存在的页（“第 3 页点不动”）
    page.value = clampPage(Number(data.page ?? nextPage), total.value, pageSize);
    facets.value = { ...facets.value, ...(data.facets ?? {}) };
    syncUrl();
  } catch (requestError) {
    if (seq === requestSeq) error.value = requestError.message;
  } finally {
    if (seq === requestSeq) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
}

/** 挂载时按 URL 还原：页码 > 1 时顺序补齐前面的页，滚动到底自然接上。 */
async function restoreFromUrl() {
  const target = readUrlState();
  if (target <= 1) {
    await load({ reset: true });
    return;
  }
  for (let p = 1; p <= target; p += 1) {
    await load({ reset: p === 1, targetPage: p, quiet: p !== target });
  }
}

function apply(key, value) {
  filters[key] = filters[key] === value ? (key === 'type' ? 'ALL' : key === 'sort' ? 'hot' : '') : value;
  // 筛选变更与页码复位同步发生，避免用上一组筛选的 total 夹页
  page.value = 1;
  void load({ reset: true });
}

function resetFilters() {
  Object.assign(filters, { type: 'ALL', sort: 'hot', region: '', year: '', genre: '', tag: '' });
  page.value = 1;
  void load({ reset: true });
}

onMounted(() => restoreFromUrl());
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

  <div class="adult-filters" :data-fold="expanded ? 'all' : 'half'">
    <div id="category-filter-body" class="filter-body">
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
          v-for="row in facets.genres"
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
          v-for="row in facets.years"
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
    </div>
    <button
      class="btn btn--quiet btn--sm filter-toggle"
      type="button"
      aria-controls="category-filter-body"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>{{ expanded ? '收起筛选' : '展开全部筛选' }}</span>
      <Icon name="down" :class-name="expanded ? 'is-flipped' : ''" />
    </button>
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
