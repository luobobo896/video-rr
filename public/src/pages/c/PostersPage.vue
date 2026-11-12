<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { mediaUrl, publicApi } from '../../api.js';
import { CATEGORY_LABEL, normalizeCard } from '../../models.js';
import { href } from '../../router.js';

const films = ref([]);
const loading = ref(true);
const error = ref('');
const activeType = ref('ALL');
const ratio = ref('portrait');

const CATEGORY_ORDER = ['MOVIE', 'TV', 'PLAYLET', 'ANIME', 'VARIETY', 'DOCUMENTARY'];
const RATIOS = [
  { key: 'portrait', label: '2:3' },
  { key: 'wide', label: '16:9' },
  { key: 'square', label: '1:1' }
];

const typeOf = (film) => film.type || film.raw?.category || '';
const filterList = computed(() => {
  const counts = new Map();
  const labels = new Map();
  for (const film of films.value) {
    const type = typeOf(film);
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    labels.set(type, film.typeLabel || CATEGORY_LABEL[type] || type);
  }
  const ordered = CATEGORY_ORDER.filter((key) => counts.has(key));
  const rest = [...counts.keys()].filter((key) => !CATEGORY_ORDER.includes(key));
  return [
    { key: 'ALL', label: '全部', count: films.value.length },
    ...ordered.concat(rest).map((key) => ({
      key,
      label: labels.get(key) || key,
      count: counts.get(key)
    }))
  ];
});

const visibleFilms = computed(() =>
  activeType.value === 'ALL'
    ? films.value
    : films.value.filter((film) => typeOf(film) === activeType.value)
);

const displayFilms = computed(() =>
  visibleFilms.value.map((film) => {
    const variant = film.variants?.find((row) => row.key === ratio.value);
    return variant ? { ...film, coverUrl: mediaUrl(variant.url) } : film;
  })
);

onMounted(async () => {
  const [wall, catalog] = await Promise.all([
    publicApi('/poster-wall').catch(() => null),
    publicApi('/category?type=ALL&page=1&pageSize=60&sort=hot').catch(() => null)
  ]);
  if (wall?.items?.length) {
    films.value = wall.items.map((item) => ({
      ...normalizeCard({
        ...item,
        id: item.dramaId,
        dramaType: item.category,
        dramaTypeLabel: CATEGORY_LABEL[item.category] ?? item.category
      }),
      variants: item.variants ?? []
    }));
  } else if (catalog) {
    films.value = (catalog.list ?? []).map(normalizeCard);
  } else {
    error.value = '海报墙暂时无法加载，请稍后重试';
  }
  loading.value = false;
});
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">海报墙</h1>
      <p class="meta" aria-live="polite">
        全部已发布内容 · {{ visibleFilms.length }} / {{ films.length }} 部
      </p>
    </div>
    <a class="section-link" :href="href('/category')">片库<Icon name="chevron" /></a>
  </div>
  <div v-if="!loading && !error && films.length" class="poster-toolbar">
    <div class="poster-filters" role="group" aria-label="按内容类型筛选">
      <button
        v-for="filter in filterList"
        :key="filter.key"
        class="chip"
        type="button"
        :aria-pressed="activeType === filter.key"
        @click="activeType = filter.key"
      >
        {{ filter.label }}<span class="poster-filter-count">{{ filter.count }}</span>
      </button>
    </div>
    <div class="segmented" role="group" aria-label="海报尺寸">
      <button
        v-for="option in RATIOS"
        :key="option.key"
        type="button"
        :aria-pressed="ratio === option.key"
        @click="ratio = option.key"
      >
        {{ option.label }}
      </button>
    </div>
  </div>
  <div v-if="loading" class="empty">
    <Icon name="grid" />
    <h3>正在加载海报</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>海报墙加载失败</h3>
    <p>{{ error }}</p>
  </div>
  <div v-else-if="displayFilms.length" class="poster-grid" :class="`poster-grid--${ratio}`">
    <PosterCard v-for="film in displayFilms" :key="film.id" :film="film" :ratio="ratio" />
  </div>
  <div v-else class="empty">
    <Icon name="grid" />
    <h3>{{ films.length ? '这类内容还没有上架' : '还没有已发布内容' }}</h3>
  </div>
</template>
