<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { go, href } from '../../router.js';
import { confirmAdult, state, toast } from '../../authState.js';

const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 24;
const loading = ref(false);
const loadingMore = ref(false);
const error = ref('');
const facets = ref({ channels: [], sorts: [], tags: [] });
const adultTags = ref([]);
const filters = reactive({ type: 'ALL', sort: 'hot', tag: '' });
const adultEnabled = computed(() => state.constants?.adultMenu?.enabled !== false);

let requestSeq = 0;
const tagGroups = computed(() => {
  const parents = adultTags.value.filter((tag) => !tag.parent_id);
  return parents
    .map((parent) => ({
      ...parent,
      children: adultTags.value.filter(
        (tag) => Number(tag.parent_id) === Number(parent.id) && Number(tag.dramaCount ?? 0) > 0
      )
    }))
    .filter((group) => group.children.length);
});
const note = computed(() => {
  const channel = facets.value.channels.find((row) => row.value === filters.type)?.label ?? '全部';
  const sort = facets.value.sorts.find((row) => row.value === filters.sort)?.label ?? '最热';
  return `共 ${total.value} 部 · ${channel} · ${sort}`;
});
const canLoadMore = computed(() => items.value.length < total.value);

function query(nextPage) {
  const params = new URLSearchParams({
    audience: 'adult',
    type: filters.type,
    page: String(nextPage),
    pageSize: String(pageSize),
    sort: filters.sort
  });
  if (filters.tag) params.set('tag', String(filters.tag));
  return params;
}

async function load({ reset = true } = {}) {
  if (!state.adultConfirmed) return;
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
    const list = (data.list ?? []).map(normalizeCard);
    items.value = reset ? list : items.value.concat(list);
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

async function accept() {
  confirmAdult();
  toast('已进入成人专区');
  try {
    const tagData = await publicApi('/tags?scope=adult');
    adultTags.value = tagData.list ?? [];
  } catch {
    adultTags.value = [];
  }
  await load();
}

function deny() {
  go('/');
  toast('已返回精选');
}

function apply(key, value) {
  filters[key] = filters[key] === value ? (key === 'type' ? 'ALL' : key === 'sort' ? 'hot' : '') : value;
  void load();
}

onMounted(async () => {
  if (!state.adultConfirmed) return;
  try {
    const tagData = await publicApi('/tags?scope=adult');
    adultTags.value = tagData.list ?? [];
  } catch {
    adultTags.value = [];
  }
  await load();
});
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">成人 <span class="badge badge--18">18+</span></h1>
      <p class="meta">{{ note }}</p>
    </div>
    <div class="segmented" role="group" aria-label="成人频道排序">
      <button
        v-for="item in [{ value: 'hot', label: '最热' }, { value: 'new', label: '最新' }, { value: 'score', label: '好评' }]"
        :key="item.value"
        type="button"
        :aria-pressed="filters.sort === item.value"
        @click="apply('sort', item.value)"
      >
        {{ item.label }}
      </button>
    </div>
  </div>

  <div v-if="!adultEnabled" class="empty">
    <Icon name="lock" />
    <h3>成人频道暂未开放</h3>
    <p>运营已关闭该频道入口。</p>
    <a class="btn btn--ghost btn--sm" :href="href('/category')">返回片库</a>
  </div>
  <div v-else-if="!state.adultConfirmed" class="adult-gate">
    <span class="age-mark">18+</span>
    <h2>仅限成年用户</h2>
    <p>本频道包含成人向内容。请确认你已年满 18 岁，并愿意继续浏览。</p>
    <div class="age-actions">
      <button class="btn btn--ghost" type="button" @click="deny">未满 18 岁</button>
      <button class="btn btn--primary" type="button" @click="accept">已满 18 岁</button>
    </div>
    <p class="adult-foot">内容分级 · 请勿向未成年人传播</p>
  </div>

  <template v-else>
    <h2 class="sr-only">成人内容分类</h2>
    <div class="adult-filters">
      <div class="filter-group">
        <span class="filter-label">类型</span>
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
      <div v-for="group in tagGroups" :key="group.id" class="filter-group">
        <span class="filter-label">{{ group.label || group.name }}</span>
        <button
          v-for="tag in group.children"
          :key="tag.id"
          class="chip"
          type="button"
          :aria-pressed="String(filters.tag) === String(tag.id)"
          @click="apply('tag', tag.id)"
        >
          {{ tag.label || tag.name }}{{ tag.dramaCount ? ` ${tag.dramaCount}` : '' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="empty">
      <Icon name="lock" />
      <h3>正在加载成人频道</h3>
      <p>内容与标签来自服务端。</p>
    </div>
    <div v-else-if="error" class="empty">
      <Icon name="alert" />
      <h3>频道加载失败</h3>
      <p>{{ error }}</p>
      <button class="btn btn--ghost btn--sm" type="button" @click="load()">重试</button>
    </div>
    <template v-else>
      <div v-if="items.length" class="film-grid">
        <PosterCard v-for="film in items" :key="film.id" :film="film" />
      </div>
      <div v-else class="empty adult-empty">
        <span class="age-mark">18+</span>
        <h3>成人内容筹备中</h3>
        <p>当前筛选下没有已发布内容。你仍可以浏览普通片库。</p>
        <a class="btn btn--ghost btn--sm" :href="href('/category')">返回片库</a>
      </div>
      <div v-if="canLoadMore" class="toolbar" style="justify-content: center">
        <button class="btn btn--ghost" type="button" :disabled="loadingMore" @click="load({ reset: false })">
          {{ loadingMore ? '加载中' : '加载更多' }}
        </button>
      </div>
    </template>
    <p class="adult-foot" style="margin-top: 16px">18+ · 仅限成年用户 · 影片与短剧共用会员权益</p>
  </template>
</template>
