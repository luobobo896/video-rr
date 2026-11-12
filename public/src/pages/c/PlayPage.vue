<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import CheckoutDialog from '../../components/CheckoutDialog.vue';
import Icon from '../../components/Icon.vue';
import PosterCard from '../../components/PosterCard.vue';
import VideoPlayer from '../../components/VideoPlayer.vue';
import { hlsUrl, mediaUrl, publicApi } from '../../api.js';
import { normalizeCard } from '../../models.js';
import { go, href, route } from '../../router.js';
import { confirmAdult, requireLogin, state, toast } from '../../authState.js';

const segments = route.path.split('/');
const dramaId = Number(segments[2] || 0);
const episodeNo = Math.max(1, Number(segments[3] || 1));
const detail = ref(null);
const playback = ref(null);
const loading = ref(true);
const error = ref('');
const errorCode = ref('');
const checkoutOpen = ref(false);
const adultUnlocked = ref(true);
const retryToken = ref(0);

let heartbeatTimer = 0;
let heartbeatTick = 0;
let historyTimer = 0;
let lastHistorySecond = 0;

const trialMode = computed(() => route.query.trial === '1' || !state.user);
const episode = computed(
  () => detail.value?.episodes?.find((row) => Number(row.no) === episodeNo) ?? null
);
const title = computed(
  () => `${detail.value?.title || '播放'} · ${detail.value?.episodes?.length === 1 ? '正片' : `第 ${episodeNo} 集`}`
);
const related = computed(() => (detail.value?.similar ?? []).map(normalizeCard));
const playable = computed(() => Boolean(playback.value?.hls));

async function saveHistory(force = false) {
  if (!state.user || !detail.value) return;
  const seconds = Math.round(Number(playback.value?.position ?? lastHistorySecond ?? 0));
  if (!force && Math.abs(seconds - lastHistorySecond) < 20) return;
  lastHistorySecond = seconds;
  try {
    await publicApi('/me/history', {
      method: 'POST',
      body: { seasonId: dramaId, episode: episodeNo, position: seconds }
    });
  } catch {
    // Playback should not stop because a progress write failed.
  }
}

async function sendHeartbeat(event) {
  if (!playback.value?.viewSessionId) return;
  const video = event?.target;
  try {
    await publicApi(`/play/session/${playback.value.viewSessionId}/heartbeat`, {
      method: 'POST',
      body: {
        positionSeconds: Number(video?.currentTime ?? playback.value.position ?? playback.value.resumePosition ?? 0),
        durationSeconds: Number(video?.duration ?? playback.value.duration ?? 0),
        playing: !video?.paused,
        visible: !document.hidden,
        playbackRate: Number(video?.playbackRate ?? 1)
      }
    });
  } catch {
    // Heartbeats are best effort; they must not interrupt viewing.
  }
}

function onTimeUpdate(event) {
  playback.value.position = event.target.currentTime;
  void saveHistory();
}

function onEnded(event) {
  void sendHeartbeat(event);
  void saveHistory(true);
}

async function load() {
  loading.value = true;
  error.value = '';
  errorCode.value = '';
  try {
    detail.value = await publicApi(`/drama/${dramaId}`);
    adultUnlocked.value = !detail.value.isAdult || state.adultConfirmed;
    if (!adultUnlocked.value) return;
    const suffix = trialMode.value ? '?trial=1' : '';
    playback.value = await publicApi(`/play/${dramaId}/${episodeNo}${suffix}`);
    lastHistorySecond = Number(playback.value.resumePosition ?? 0);
    window.clearInterval(heartbeatTimer);
    if (playback.value.viewSessionId) {
      heartbeatTick = 0;
      heartbeatTimer = window.setInterval(() => {
        heartbeatTick += 15;
        void sendHeartbeat();
      }, 15000);
    }
  } catch (requestError) {
    error.value = requestError.message;
    errorCode.value = requestError.code || String(requestError.status || '');
  } finally {
    loading.value = false;
  }
}

function unlockAdult() {
  confirmAdult();
  adultUnlocked.value = true;
  void load();
}

function goEpisode(row) {
  const trial = !state.user || !row.allow ? '?trial=1' : '';
  go(`/play/${dramaId}/${row.no}${trial}`);
}

function openPaywall() {
  if (!state.user) {
    requireLogin('登录后购买或开通会员');
    return;
  }
  checkoutOpen.value = true;
}

onMounted(load);

onBeforeUnmount(() => {
  window.clearInterval(heartbeatTimer);
  void saveHistory(true);
});
</script>

<template>
  <div v-if="loading" class="empty">
    <Icon name="play" />
    <h3>正在加载播放信息</h3>
    <p>正在校验登录态和播放权益。</p>
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
  <div v-else-if="error" class="empty">
    <Icon name="alert" />
    <h3>{{ errorCode === '0402' || errorCode === '402' ? '需要解锁本集' : '播放加载失败' }}</h3>
    <p>{{ error }}</p>
    <div class="toolbar" style="justify-content: center">
      <button v-if="errorCode === '0402' || errorCode === '402'" class="btn btn--primary" type="button" @click="openPaywall">
        查看购买选项
      </button>
      <button v-else class="btn btn--ghost" type="button" @click="load">重新加载</button>
      <a class="btn btn--ghost" :href="href(`/detail/${dramaId}`)">返回详情</a>
    </div>
  </div>
  <template v-else-if="detail">
    <div class="section-head">
      <div>
        <h1 class="h1">{{ title }}</h1>
        <p class="meta">
          {{ playback?.source === 'trial' ? '试看' : playback?.source === 'purchase' ? '已购买' : playback?.source === 'subscription' ? '会员权益' : '免费观看' }}
          · 进度自动同步
        </p>
      </div>
      <a class="section-link" :href="href(`/detail/${dramaId}`)">返回详情<Icon name="chevron" /></a>
    </div>
    <VideoPlayer
      :key="`${playback?.hls || ''}-${retryToken}`"
      :src="hlsUrl(playback?.hls)"
      :poster="mediaUrl(detail.coverUrl)"
      :title="title"
      @timeupdate="onTimeUpdate"
      @ended="onEnded"
      @play="sendHeartbeat"
      @pause="sendHeartbeat"
    />
    <div v-if="!playable" class="empty" style="padding: 24px">
      <h3>片源暂不可用</h3>
      <p>该集可能仍在转码或转码失败。</p>
    </div>
    <div class="section-head" style="margin-top: 32px">
      <div><h2>选集</h2><p>{{ detail.episodes.length }} 集</p></div>
    </div>
    <div class="episode-grid">
      <button
        v-for="row in detail.episodes"
        :key="row.id"
        class="ep"
        type="button"
        :aria-current="row.no === episodeNo"
        @click="goEpisode(row)"
      >
        {{ row.no }}
        <Icon v-if="!row.allow" name="lock" className="lock" />
      </button>
    </div>
    <div v-if="related.length">
      <div class="section-head" style="margin-top: 40px">
        <div><h2>相关推荐</h2><p>同类型片单</p></div>
      </div>
      <div class="film-grid">
        <PosterCard v-for="item in related" :key="item.id" :film="item" />
      </div>
    </div>
  </template>
  <CheckoutDialog
    v-model="checkoutOpen"
    title="解锁本集"
    :subtitle="detail?.title || ''"
    :allow-single="detail?.accessMode === 'paid'"
    :drama-id="dramaId"
    :single-price="Number(detail?.singlePrice ?? 0)"
  />
</template>
