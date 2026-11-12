<script setup>
import { computed, onMounted, ref } from 'vue';
import CheckoutDialog from '../../components/CheckoutDialog.vue';
import FilmArt from '../../components/FilmArt.vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import { mediaUrl, publicApi } from '../../api.js';
import {
  formatCount,
  formatDate,
  formatScore,
  normalizeCard
} from '../../models.js';
import { go, href, route } from '../../router.js';
import {
  confirmAdult,
  isFavorite,
  requireLogin,
  state,
  toast,
  toggleFavorite
} from '../../authState.js';

const dramaId = Number(route.path.split('/')[2] || 0);
const detail = ref(null);
const loading = ref(true);
const error = ref('');
const checkoutOpen = ref(false);
const adultUnlocked = ref(!detail.value?.isAdult);
const favorite = ref(false);
const favoritePending = ref(false);

const film = computed(() => {
  if (!detail.value) return null;
  return normalizeCard(detail.value);
});
const similar = computed(() => (detail.value?.similar ?? []).map(normalizeCard));
const firstPlayable = computed(() => {
  if (!detail.value) return null;
  const resume = detail.value.resumeEpisodeNo
    ? detail.value.episodes.find((episode) => episode.no === detail.value.resumeEpisodeNo)
    : null;
  return resume ?? detail.value.episodes.find((episode) => episode.allow) ?? null;
});
const hasEntitlement = computed(() =>
  Boolean(detail.value?.hasSubscription || detail.value?.episodes?.some((episode) => episode.source === 'purchase'))
);
const primaryLabel = computed(() => {
  if (!detail.value?.episodes?.length) return '暂无剧集';
  if (hasEntitlement.value) return firstPlayable.value ? `继续观看第 ${firstPlayable.value.no} 集` : '开始观看';
  if (firstPlayable.value) return `免费看第 ${firstPlayable.value.no} 集`;
  return detail.value.accessMode === 'paid' ? `购买本片 ¥${Number(detail.value.singlePrice).toFixed(2)}` : '开通会员';
});
const freeNote = computed(() => {
  if (!detail.value) return '';
  if (detail.value.freeEpisodes > 0) return `前 ${detail.value.freeEpisodes} 集免费`;
  if (detail.value.trialSeconds > 0) return `可试看 ${detail.value.trialSeconds} 秒`;
  return detail.value.accessMode === 'paid' ? '单片付费' : '会员专享';
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await publicApi(`/drama/${dramaId}`);
    favorite.value = Boolean(detail.value.favorited);
    adultUnlocked.value = !detail.value.isAdult || state.adultConfirmed;
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    loading.value = false;
  }
}

function unlockAdult() {
  confirmAdult();
  adultUnlocked.value = true;
  toast('已进入成人专区');
}

function playTarget(episode) {
  if (!episode) {
    checkoutOpen.value = true;
    return;
  }
  if (!episode.allow && !(episode.trialSeconds > 0)) {
    checkoutOpen.value = true;
    return;
  }
  const trial = !state.user || !episode.allow ? '?trial=1' : '';
  go(`/play/${dramaId}/${episode.no}${trial}`);
}

function selectEpisode(episode) {
  playTarget(episode);
}

async function toggleFav() {
  if (!state.user) {
    requireLogin('登录后可以收藏');
    return;
  }
  if (favoritePending.value) return;
  favoritePending.value = true;
  try {
    favorite.value = await toggleFavorite(dramaId);
    toast(favorite.value ? '已加入我的片单' : '已取消收藏');
  } catch (requestError) {
    if (requestError.code === '0401') requireLogin('登录后可以收藏');
    else toast(requestError.message, 'bad');
  } finally {
    favoritePending.value = false;
  }
}

async function share() {
  const url = `${window.location.origin}${window.location.pathname}#/detail/${dramaId}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制');
  } catch {
    toast(url);
  }
}

onMounted(load);
</script>

<template>
  <div v-if="loading" class="empty">
    <Icon name="film" />
    <h3>正在加载详情</h3>
  </div>
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>详情加载失败</h3>
    <p>{{ error }}</p>
    <button class="btn btn--ghost btn--sm" type="button" @click="load">重试</button>
  </div>
  <div v-else-if="!adultUnlocked" class="adult-gate">
    <span class="age-mark">18+</span>
    <h2>仅限成年用户</h2>
    <p>本内容包含成人向信息。请确认你已年满 18 岁。</p>
    <div class="age-actions">
      <a class="btn btn--ghost" :href="href('/')">未满 18 岁</a>
      <button class="btn btn--primary" type="button" @click="unlockAdult">已满 18 岁</button>
    </div>
  </div>
  <template v-else-if="detail">
    <section class="detail-head">
      <div class="detail-cover">
        <img v-if="detail.coverUrl" :src="mediaUrl(detail.coverUrl)" alt="" />
        <div v-else class="film-art" style="height: 100%"><span class="film-cjk">{{ detail.title[0] }}</span></div>
      </div>
      <div class="detail-copy">
        <div>
          <h1 id="detail-title" class="detail-title">{{ detail.title }}</h1>
          <p class="detail-sub">{{ detail.subTitle }} · {{ detail.year }}</p>
        </div>
        <div class="detail-meta">
          <span class="accent num" style="font-weight: 600">{{ formatScore(detail.score) }}</span>
          <span>{{ detail.year }}</span>
          <span>{{ detail.areaLabel || detail.area }}</span>
          <span>{{ detail.dramaTypeLabel }}</span>
          <span class="badge badge--accent">{{ freeNote }}</span>
          <span>{{ detail.episodes?.length ?? 0 }} 集</span>
          <span>{{ formatCount(detail.playCount) }} 次播放</span>
        </div>
        <p class="detail-desc">{{ detail.description }}</p>
        <div class="detail-actions">
          <button class="btn btn--primary btn--lg" type="button" @click="playTarget(firstPlayable)">
            <Icon name="play" />{{ primaryLabel }}
          </button>
          <button
            id="fav-btn"
            class="btn btn--ghost btn--lg"
            :class="{ 'is-on': favorite }"
            type="button"
            :aria-pressed="favorite"
            :disabled="favoritePending"
            @click="toggleFav"
          >
            <Icon name="heart" /><span>{{ favorite ? '已收藏' : '收藏' }}</span>
          </button>
          <button class="btn btn--ghost btn--lg" type="button" @click="share">
            <Icon name="share" />分享
          </button>
        </div>
        <div class="detail-facts">
          <span><strong>类型</strong> {{ detail.dramaTypeLabel }}</span>
          <span><strong>地区</strong> {{ detail.areaLabel || detail.area || '—' }}</span>
          <span><strong>发行</strong> {{ formatDate(detail.releaseDate) }}</span>
          <span><strong>更新</strong> {{ formatDate(detail.updatedAt) }}</span>
        </div>
      </div>
    </section>

    <section>
      <div class="section-head">
        <div>
          <h2>选集</h2>
          <p>{{ hasEntitlement ? '会员或已购权益生效中' : freeNote }}</p>
        </div>
        <span class="badge" :class="hasEntitlement ? 'badge--ok' : 'badge--muted'">
          {{ hasEntitlement ? '已解锁' : '按集权限' }}
        </span>
      </div>
      <div v-if="detail.episodes?.length" class="episode-grid">
        <button
          v-for="episode in detail.episodes"
          :key="episode.id"
          class="ep"
          type="button"
          :aria-current="firstPlayable?.no === episode.no"
          @click="selectEpisode(episode)"
        >
          {{ episode.no }}
          <Icon v-if="!episode.allow" name="lock" className="lock" />
        </button>
      </div>
      <div v-else class="empty" style="padding: 32px 12px">
        <h3>暂无分集</h3>
        <p>片源处理后会自动显示。</p>
      </div>
      <p class="ep-note"><Icon name="clock" />观看进度会自动同步到服务端</p>
    </section>

    <section class="admin-grid">
      <div class="panel">
        <div class="panel-head"><h3>简介</h3></div>
        <p class="body">{{ detail.description }}</p>
        <div v-if="detail.tags?.length" class="toolbar" style="margin-top: 16px">
          <span v-for="tag in detail.tags" :key="tag.id" class="chip">{{ tag.label || tag.name }}</span>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>影片信息</h3></div>
        <div class="detail-facts" style="border-top: 0; padding-top: 0">
          <span><strong>年份</strong> {{ detail.year || '—' }}</span>
          <span><strong>类型</strong> {{ detail.dramaTypeLabel }}</span>
          <span><strong>集数</strong> {{ detail.episodes?.length ?? 0 }}</span>
          <span><strong>付费模式</strong> {{ detail.priceInfo?.purchaseKind === 'single' ? '单片 / 订阅' : '订阅' }}</span>
        </div>
      </div>
    </section>

    <section v-if="similar.length">
      <div class="section-head">
        <div><h2>看过这部的人也在看</h2><p>服务端同类型推荐</p></div>
        <a class="section-link" :href="href('/category')">去片库<Icon name="chevron" /></a>
      </div>
      <div class="film-grid">
        <PosterCard v-for="item in similar" :key="item.id" :film="item" />
      </div>
    </section>
  </template>
  <CheckoutDialog
    v-model="checkoutOpen"
    :title="hasEntitlement ? '会员续费' : '解锁内容'"
    :subtitle="detail?.title || ''"
    :allow-single="detail?.accessMode === 'paid'"
    :drama-id="dramaId"
    :single-price="Number(detail?.singlePrice ?? 0)"
  />
</template>
