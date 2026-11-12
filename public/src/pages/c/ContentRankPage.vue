<script setup>
import { computed, onMounted, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { mediaUrl, publicApi } from '../../api.js';
import { CATEGORY_LABEL, formatCount, formatDateTime } from '../../models.js';

const data = ref(null);
const loading = ref(true);
const error = ref('');
const type = ref('hot');
const contentType = ref('all');
const contentTypes = [
  { value: 'all', label: '全部内容' },
  { value: 'movie', label: '电影' },
  { value: 'series', label: '剧集' },
  { value: 'comic_drama', label: '动漫短剧' }
];
const fallbackTypes = [
  { value: 'hot', label: '热播榜' },
  { value: 'favorite', label: '收藏榜' },
  { value: 'completion', label: '完播榜' },
  { value: 'new', label: '新片榜' },
  { value: 'recommend', label: '推荐榜' }
];
const typeOptions = computed(() => (data.value?.lists?.length ? data.value.lists : fallbackTypes));
const rows = computed(() => data.value?.items ?? []);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await publicApi(`/content/rank?type=${encodeURIComponent(type.value)}&contentType=${encodeURIComponent(contentType.value)}`);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

function selectType(value) {
  if (type.value === value) return;
  type.value = value;
  void load();
}

function selectContentType(value) {
  if (contentType.value === value) return;
  contentType.value = value;
  void load();
}

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

onMounted(load);
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">内容数据榜</h1>
      <p class="meta">{{ data?.label || '按服务端有效观看与收藏数据排序' }}</p>
    </div>
    <div class="segmented" role="group" aria-label="榜单类型">
      <button
        v-for="item in typeOptions"
        :key="item.value"
        type="button"
        :aria-pressed="type === item.value"
        @click="selectType(item.value)"
      >{{ item.label }}</button>
    </div>
  </div>
  <h2 class="sr-only">榜单内容</h2>
  <div class="toolbar">
    <button
      v-for="item in contentTypes"
      :key="item.value"
      class="chip"
      type="button"
      :aria-pressed="contentType === item.value"
      @click="selectContentType(item.value)"
    >{{ item.label }}</button>
    <span class="spacer"></span>
    <span v-if="data?.generatedAt" class="meta">生成于 {{ formatDateTime(data.generatedAt) }}</span>
  </div>

  <div v-if="loading" class="empty">
    <Icon name="chart" />
    <h3>正在加载内容榜单</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>榜单加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>
  <div v-else-if="rows.length" class="panel">
    <div class="panel-head"><h3>{{ data.label }}</h3><span class="meta">{{ rows.length }} 部内容</span></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>排名</th><th>内容</th><th>类型</th><th class="num">有效观众</th><th class="num">完播率</th><th class="num">收藏</th></tr></thead>
        <tbody>
          <tr v-for="row in rows" :key="row.dramaId">
            <td><span class="rank-no">{{ String(row.rankNo).padStart(2, '0') }}</span></td>
            <td>
              <a class="cell-main" :href="`#/detail/${row.dramaId}`">
                <div class="thumb">
                  <img v-if="row.coverUrl" :src="mediaUrl(row.coverUrl)" alt="" loading="lazy" />
                  <span v-else class="film-cjk">{{ row.title?.[0] }}</span>
                </div>
                <div class="cell-title"><strong>{{ row.title }}</strong><span>{{ row.subTitle || row.year || '内容详情' }}</span></div>
              </a>
            </td>
            <td>{{ CATEGORY_LABEL[row.dramaType] || row.dramaType || '—' }}</td>
            <td class="num">{{ formatCount(row.metrics?.viewerCount) }}</td>
            <td class="num">{{ percent(row.metrics?.completionRate) }}</td>
            <td class="num">{{ formatCount(row.metrics?.favoriteCount) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <div v-else class="empty">
    <Icon name="chart" />
    <h3>榜单暂无快照</h3>
    <p>有效观看与收藏数据积累后，运营端刷新榜单即可显示。</p>
    <a class="btn btn--ghost btn--sm" href="#/category">去片库看看</a>
  </div>
</template>
