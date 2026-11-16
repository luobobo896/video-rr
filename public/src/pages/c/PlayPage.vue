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
// 外部片源的直链带签名，过期时后端回 0409 + reason=source_link_expired：
// 这是临时状态，页面要自己等一会儿再拉一次，而不是让用户对着灰播放键发呆
const errorReason = ref('');
const retryCountdown = ref(0);
const playerIssue = ref('');
const checkoutOpen = ref(false);
const adultUnlocked = ref(true);
const retryToken = ref(0);

let heartbeatTimer = 0;
let heartbeatTick = 0;
let historyTimer = 0;
let lastHistorySecond = 0;
let countdownTimer = 0;

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
  errorReason.value = '';
  playerIssue.value = '';
  window.clearInterval(countdownTimer);
  retryCountdown.value = 0;
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
    errorReason.value = requestError.data?.reason || '';
    if (errorReason.value === 'source_link_expired') startCountdown(requestError.data?.retryAfterSeconds);
  } finally {
    loading.value = false;
  }
}

/** 片源续期期间：显示倒计时，到点自动重拉一次播放信息 */
function startCountdown(seconds) {
  // 后端换票通常 1～3 秒，所以下限给到 3 秒：过期就当场换，不让用户干等
  const wait = Math.max(3, Math.min(180, Number(seconds) || 6));
  retryCountdown.value = wait;
  window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    retryCountdown.value -= 1;
    if (retryCountdown.value > 0) return;
    window.clearInterval(countdownTimer);
    retryCountdown.value = 0;
    void load();
  }, 1000);
}

function retryNow() {
  window.clearInterval(countdownTimer);
  retryCountdown.value = 0;
  void load();
}

/** 播放器彻底失败（不是续期等待）时给一个手动重载入口，不把死画面留在那 */
function onPlayerFailed(payload) {
  playerIssue.value = payload?.status || '片源加载失败';
}

function reloadPlayer() {
  playerIssue.value = '';
  retryToken.value += 1;
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
  window.clearInterval(countdownTimer);
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
    <h3>
      {{ errorCode === '0402' || errorCode === '402'
        ? '需要解锁本集'
        : errorReason === 'source_link_expired' ? '片源正在续期'
          : errorReason === 'source_unavailable' ? '该集片源暂不可用' : '播放加载失败' }}
    </h3>
    <p v-if="errorReason === 'source_link_expired'">
      这一集的片源签名已过期，服务器正在自动换新链接。
      <template v-if="retryCountdown > 0">{{ retryCountdown }} 秒后自动重试…</template>
      <template v-else>稍后重试即可恢复播放。</template>
    </p>
    <p v-else-if="errorReason === 'source_unavailable'">
      这一集在源站已经拿不到片源了（多半是下架），换一集会更稳妥。
    </p>
    <p v-else>{{ error }}</p>
    <div class="toolbar" style="justify-content: center">
      <button v-if="errorCode === '0402' || errorCode === '402'" class="btn btn--primary" type="button" @click="openPaywall">
        查看购买选项
      </button>
      <button v-else-if="errorReason === 'source_link_expired'" class="btn btn--primary" type="button" @click="retryNow">
        立即重试
      </button>
      <button v-else-if="errorReason === 'source_unavailable'" class="btn btn--ghost" type="button" @click="retryNow">
        再试一次
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
      @failed="onPlayerFailed"
    />
    <div v-if="playerIssue" class="empty" style="padding: 20px">
      <p>{{ playerIssue }}</p>
      <div class="toolbar" style="justify-content: center">
        <button class="btn btn--primary" type="button" @click="reloadPlayer">重新加载播放器</button>
      </div>
    </div>
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
    title="解锁本片"
    :subtitle="detail?.title || ''"
    :allow-single="detail?.accessMode === 'paid'"
    :drama-id="dramaId"
    :single-price="Number(detail?.singlePrice ?? 0)"
    :purchase-kind="detail?.priceInfo?.purchaseKind ?? 'single'"
    :rental-hours="Number(detail?.priceInfo?.rentalHours ?? 0) || 72"
    :plans-allowed="detail?.accessMode !== 'paid'"
  />
</template>
