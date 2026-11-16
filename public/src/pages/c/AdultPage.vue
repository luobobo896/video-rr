<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import PagerBar from '../../components/PagerBar.vue';
import PosterCard from '../../components/PosterCard.vue';
import { publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { go, href } from '../../router.js';
import { confirmAdult, state, toast } from '../../authState.js';
import { appendUnique, clampPage } from '../../list-utils.js';
import { adultGateOf, needsAdultGate } from '../../adult-gate.js';
import { t } from '../../i18n.js';

const items = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = 24;
const loading = ref(false);
const error = ref('');
const facets = ref({ channels: [], sorts: [], tags: [] });
const adultTags = ref([]);
const filters = reactive({ type: 'ALL', sort: 'hot', tag: '' });
const expanded = ref(false);
/**
 * 门禁状态由服务端裁决（契约：GET /api/adult/state → {enabled}；
 * 未确认时带 audience=adult 的列表接口回 {gated:true}）：
 * checking 校验中 / gate 待确认 / open 已放行 / closed 运营关闭。
 */
const gateState = ref('checking');
const confirming = ref(false);
const adultEnabled = computed(() => state.constants?.adultMenu?.enabled !== false);

let requestSeq = 0;
const tagGroups = computed(() => {
  const parents = adultTags.value.filter((tag) => !tag.parent_id);
  return parents
    .map((parent) => ({
      ...parent,
      // 没有作品的标签不渲染：点了必然是空列表，只会让人以为坏了
      children: adultTags.value.filter(
        (tag) =>
          Number(tag.parent_id) === Number(parent.id) &&
          (Number(tag.dramaCount) > 0 || String(filters.tag) === String(tag.id))
      )
    }))
    .filter((group) => group.children.length);
});
/** 频道筛选项同理：数量为 0 的不显示，但当前选中项要留着，否则无法取消 */
const channelRows = computed(() =>
  (facets.value.channels ?? []).filter(
    (row) => row.count === undefined || Number(row.count) > 0 || filters.type === row.value
  )
);
const tagLabel = computed(() => {
  const tag = adultTags.value.find((row) => String(row.id) === String(filters.tag));
  return tag ? tag.label || tag.name : '';
});
const note = computed(() => {
  const channel = facets.value.channels.find((row) => row.value === filters.type)?.label ?? '全部';
  const sort = facets.value.sorts.find((row) => row.value === filters.sort)?.label ?? '最热';
  const parts = [`共 ${total.value} 部`, channel, sort];
  if (tagLabel.value) parts.push(tagLabel.value);
  return parts.join(' · ');
});
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

async function load(target = 1) {
  if (gateState.value === 'gate' || gateState.value === 'closed') return;
  const seq = ++requestSeq;
  const next = Math.max(1, Number(target) || 1);
  page.value = next;
  loading.value = true;
  error.value = '';
  try {
    const data = await publicApi(`/category?${query(next)}`);
    if (seq !== requestSeq) return;
    // 服务端认为还没确认年龄：丢掉本地乐观状态，回到门禁
    if (adultGateOf(data, 'open') === 'gate') {
      gateState.value = 'gate';
      items.value = [];
      total.value = 0;
      return;
    }
    items.value = appendUnique([], (data.list ?? data.items ?? []).map(normalizeCard));
    total.value = Number(data.total ?? 0);
    // 页码用本次响应的 total 夹：旧 total 会把页码夹到不存在的页（“第 3 页点不动”）
    page.value = clampPage(Number(data.page ?? next), total.value, pageSize);
    facets.value = { ...facets.value, ...(data.facets ?? {}) };
  } catch (requestError) {
    if (seq === requestSeq) error.value = requestError.message;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

async function loadTags() {
  try {
    const tagData = await publicApi('/tags?scope=adult');
    adultTags.value = tagData.list ?? [];
  } catch {
    adultTags.value = [];
  }
}

/** 挂载先问服务端：未确认就只显示门禁，不去拉成人列表。 */
async function checkGate() {
  try {
    const info = await publicApi('/adult/state');
    const next = needsAdultGate(info, state.adultConfirmed);
    if (next === 'closed') {
      gateState.value = 'closed';
      return;
    }
    if (next === 'gate') {
      gateState.value = 'gate';
      return;
    }
    gateState.value = 'open';
  } catch {
    // 接口不可用时退回本地同意状态，不把整个频道卡死
    gateState.value = state.adultConfirmed ? 'open' : 'gate';
  }
  if (gateState.value !== 'open') return;
  await loadTags();
  await load();
}

// 换页时回到列表顶部，避免停在半空
function goPage(next) {
  void load(next);
  if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function accept() {
  if (confirming.value) return;
  confirming.value = true;
  try {
    // 服务端种 HttpOnly 签名 cookie（mh_adult，30 天），客户端不再自带年龄凭证
    await publicApi('/adult/confirm', { method: 'POST', body: {} });
  } catch {
    // 接口暂时不可用时仍放行本次浏览，下一次列表请求会由 gated 标记拉回门禁
  } finally {
    confirming.value = false;
  }
  confirmAdult();
  gateState.value = 'open';
  toast('已进入成人专区');
  await loadTags();
  await load();
}

function deny() {
  go('/');
  toast('已返回精选');
}

function apply(key, value) {
  filters[key] = filters[key] === value ? (key === 'type' ? 'ALL' : key === 'sort' ? 'hot' : '') : value;
  void load(1);
}

function resetFilters() {
  filters.type = 'ALL';
  filters.sort = 'hot';
  filters.tag = '';
  void load(1);
}

onMounted(() => checkGate());
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">成人 <span class="badge badge--18">18+</span></h1>
      <p class="meta">{{ note }}</p>
    </div>
    <a class="btn btn--ghost btn--sm" :href="href('/short')">短剧频道</a>
  </div>

  <div v-if="!adultEnabled || gateState === 'closed'" class="empty">
    <Icon name="lock" />
    <h3>{{ t('成人频道暂未开放') }}</h3>
    <p>{{ t('运营已关闭该频道入口。') }}</p>
    <a class="btn btn--ghost btn--sm" :href="href('/category')">{{ t('返回片库') }}</a>
  </div>
  <div v-else-if="gateState === 'checking'" class="empty">
    <Icon name="lock" />
    <h3>{{ t('正在校验年龄凭证') }}</h3>
    <p>{{ t('内容分级 · 请勿向未成年人传播') }}</p>
  </div>
  <div v-else-if="gateState === 'gate'" class="adult-gate">
    <span class="age-mark">18+</span>
    <h2>{{ t('是否年满18岁') }}</h2>
    <p>{{ t('本频道包含成人向内容。请确认你已年满 18 岁，并愿意继续浏览。') }}</p>
    <div class="age-actions">
      <button class="btn btn--ghost" type="button" @click="deny">{{ t('未满 18 岁') }}</button>
      <button class="btn btn--primary" type="button" :disabled="confirming" @click="accept">
        {{ confirming ? t('确认中') : t('已满 18 岁') }}
      </button>
    </div>
    <p class="adult-foot">{{ t('内容分级 · 请勿向未成年人传播') }}</p>
  </div>

  <template v-else>
    <h2 class="sr-only">成人内容分类</h2>
    <div class="adult-filters" :data-fold="expanded ? 'all' : 'half'">
      <div id="adult-filter-body" class="filter-body">
        <div class="filter-group">
          <span class="filter-label">类型</span>
          <button
            v-for="row in channelRows"
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
      <button
        class="btn btn--quiet btn--sm filter-toggle"
        type="button"
        aria-controls="adult-filter-body"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span>{{ expanded ? '收起筛选' : '展开全部筛选' }}</span>
        <Icon name="down" :class-name="expanded ? 'is-flipped' : ''" />
      </button>
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
        <h3>当前筛选下没有内容</h3>
        <p>换一个类型或题材，也可以回到全部成人内容。</p>
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
    <p class="adult-foot" style="margin-top: 16px">18+ · 仅限成年用户 · 影片与短剧共用会员权益</p>
  </template>
</template>
