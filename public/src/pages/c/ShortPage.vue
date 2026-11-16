<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PagerBar from '../../components/PagerBar.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { go, href } from '../../router.js';
import { confirmAdult, state, toast } from '../../authState.js';

// 短剧频道：与成人电影（category=MOVIE）分开的独立入口。
// 数据来自 /api/category?audience=adult&type=PLAYLET，题材取自「短劇」标签分组。
const DRAMA_ROOT = '短劇';
const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 30;
const loading = ref(false);
const error = ref('');
const genres = ref([]);
const filters = reactive({ sort: 'new', tag: '' });

let requestSeq = 0;

const genreLabel = computed(() => {
  const hit = genres.value.find((row) => String(row.id) === String(filters.tag));
  return hit ? hit.label || hit.name : '';
});
const note = computed(() => {
  const parts = [`共 ${total.value} 部`];
  parts.push(filters.sort === 'hot' ? '最热' : '最新');
  if (genreLabel.value) parts.push(genreLabel.value);
  return parts.join(' · ');
});
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));
// 数量为 0 的题材点了只会得到空列表，直接不渲染
const genreRows = computed(() =>
  genres.value.filter((row) => Number(row.dramaCount) > 0 || String(filters.tag) === String(row.id))
);
// 短剧频道是成人内容：成人菜单关掉时整页不再取数据，也不接受「已满 18 岁」解锁
const adultEnabled = computed(() => state.constants?.adultMenu?.enabled !== false);

function query(nextPage) {
  const params = new URLSearchParams({
    audience: 'adult',
    type: 'PLAYLET',
    page: String(nextPage),
    pageSize: String(pageSize),
    sort: filters.sort
  });
  if (filters.tag) params.set('tag', String(filters.tag));
  return params;
}

async function load(target = 1) {
  if (!adultEnabled.value || !state.adultConfirmed) return;
  const seq = ++requestSeq;
  const next = Math.min(Math.max(1, Number(target) || 1), totalPages.value);
  page.value = next;
  loading.value = true;
  error.value = '';
  try {
    const data = await publicApi(`/category?${query(next)}`);
    if (seq !== requestSeq) return;
    items.value = (data.list ?? []).map(normalizeCard);
    total.value = Number(data.total ?? 0);
    page.value = Number(data.page ?? next);
  } catch (requestError) {
    if (seq === requestSeq) error.value = requestError.message;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function goPage(next) {
  void load(next);
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function loadGenres() {
  try {
    const data = await publicApi('/tags?scope=adult');
    const list = data.list ?? [];
    const root = list.find((tag) => !tag.parent_id && (tag.name === DRAMA_ROOT || tag.label === DRAMA_ROOT));
    // 只认「短劇」分组下的题材；找不到就留空，避免把衣著/身材这类顶层分组当成题材
    genres.value = root ? list.filter((tag) => Number(tag.parent_id) === Number(root.id)) : [];
  } catch {
    genres.value = [];
  }
}

async function accept() {
  if (!adultEnabled.value) return;
  confirmAdult();
  toast('已进入短剧频道');
  await loadGenres();
  await load();
}

function deny() {
  go('/adult');
  toast('已返回成人频道');
}

function applyTag(id) {
  filters.tag = String(filters.tag) === String(id) ? '' : id;
  void load(1);
}

function applySort(sort) {
  filters.sort = sort;
  void load(1);
}

function resetFilters() {
  filters.sort = 'new';
  filters.tag = '';
  void load(1);
}

onMounted(async () => {
  if (!adultEnabled.value || !state.adultConfirmed) return;
  await loadGenres();
  await load();
});
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">短剧 <span class="badge badge--18">AI</span></h1>
      <p class="meta">{{ note }}</p>
    </div>
    <a class="btn btn--ghost btn--sm" :href="href('/adult')">成人电影</a>
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
    <p>短剧频道包含成人向内容，请确认你已年满 18 岁。</p>
    <div class="age-actions">
      <button class="btn btn--ghost" type="button" @click="deny">未满 18 岁</button>
      <button class="btn btn--primary" type="button" @click="accept">已满 18 岁</button>
    </div>
    <p class="adult-foot">内容分级 · 请勿向未成年人传播</p>
  </div>

  <template v-else>
    <div class="adult-filters" data-fold="all">
      <div class="filter-body">
        <div class="filter-group">
          <span class="filter-label">排序</span>
          <button class="chip" type="button" :aria-pressed="filters.sort === 'new'" @click="applySort('new')">最新</button>
          <button class="chip" type="button" :aria-pressed="filters.sort === 'hot'" @click="applySort('hot')">最热</button>
        </div>
        <div v-if="genreRows.length" class="filter-group">
          <span class="filter-label">题材</span>
          <button
            v-for="tag in genreRows"
            :key="tag.id"
            class="chip"
            type="button"
            :aria-pressed="String(filters.tag) === String(tag.id)"
            @click="applyTag(tag.id)"
          >
            {{ tag.label || tag.name }}{{ tag.dramaCount ? ` ${tag.dramaCount}` : '' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="loading" class="empty">
      <Icon name="film" />
      <h3>正在加载短剧</h3>
      <p>数据来自短剧片库。</p>
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
      <div v-else class="empty">
        <Icon name="film" />
        <h3>当前筛选下没有短剧</h3>
        <p>换一个题材，或者回到全部短剧。</p>
        <button class="btn btn--ghost btn--sm" type="button" @click="resetFilters">重置筛选</button>
      </div>
      <PagerBar
        :page="page"
        :total="total"
        :page-size="pageSize"
        :loading="loading"
        @change="goPage"
      />
    </template>
    <p class="adult-foot" style="margin-top: 16px">AI 短剧 · 自制剧集 · 与电影共用会员权益</p>
  </template>
</template>
