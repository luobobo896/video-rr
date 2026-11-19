<script setup>
import { computed, nextTick, ref } from 'vue';
import { imageSrcset, imageVariant } from '../api.js';
const props = defineProps({
  film: { type: Object, required: true },
  badge: { type: Boolean, default: true },
  ratio: { type: String, default: 'portrait' }
});

const FALLBACK_ART = [
  'poster-scifi', 'poster-period', 'poster-suspense', 'poster-romance',
  'poster-animation', 'poster-documentary', 'poster-comedy', 'poster-action'
]

/** 无封面时按片名散列轮换占位插画，避免整页重复同一张。 */
function fallbackArt(film) {
  const text = String(film?.title ?? '')
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 9973
  return `./art/${FALLBACK_ART[hash % FALLBACK_ART.length]}.jpg`
}

// 原图平均 384KB（最大 2.9MB），一页 24 张就是 9MB；优先取 WebP 变体，取不到再回退原图。
const coverSrcset = computed(() => imageSrcset(props.film?.coverUrl))
// 竖版卡片一格约 180px 宽，横版/大图按视口宽度走。
const coverSizes = computed(() => (props.ratio === 'portrait' ? '(max-width: 520px) 45vw, 200px' : '(max-width: 900px) 100vw, 900px'))

// 封面还在路上时先把卡片留在渐变占位上，别让格子先闪白再填图。
const coverLoaded = ref(false);
const coverFailed = ref(false);

// 源图缺失/变体没生成时按 320→640→1280→原图→占位插画 逐级退，
// 一次 error 只退一档；全挂之后走 fallbackArt，不再留白框。
const FALLBACK_CHAIN = ['w320', 'w640', 'w1280', 'source', 'art'];
const fallbackStep = ref(0);

// 没有 coverUrl 时直接从占位插画起步。
const displaySrcset = computed(() => (props.film?.coverUrl && fallbackStep.value < 3 ? coverSrcset.value : ''));
const displaySrc = computed(() => {
  const step = FALLBACK_CHAIN[fallbackStep.value];
  if (step === 'art' || !props.film?.coverUrl) return fallbackArt(props.film);
  if (step === 'source') return props.film.coverUrl;
  return imageVariant(props.film.coverUrl, Number(step.slice(1))) || fallbackArt(props.film);
});

function nextRetryStep(from) {
  for (let i = from + 1; i < FALLBACK_CHAIN.length; i += 1) {
    const step = FALLBACK_CHAIN[i];
    // 原图就是 src 的兜底对象；取不到封面地址时直接跳到占位插画。
    if (step === 'source' && props.film?.coverUrl) return i;
    if (step !== 'source') return i;
  }
  return FALLBACK_CHAIN.length - 1;
}

function onCoverError() {
  const next = nextRetryStep(fallbackStep.value);
  fallbackStep.value = next;
  if (FALLBACK_CHAIN[next] === 'art') coverFailed.value = true;
  else coverLoaded.value = true;
}

// 每张卡一个 <video> 会让首屏同时挂几十个空标签（多出几十个媒体元素与连接）：
// 默认只渲染静态封面（img + poster），首次 hover 才把 <video> 挂上并播放。
const previewReady = ref(false);

async function playPreview(event) {
  previewReady.value = true;
  await nextTick();
  const video = event?.currentTarget?.querySelector('video');
  if (video) video.play().catch(() => {});
}

function stopPreview(event) {
  const video = event?.currentTarget?.querySelector('video');
  if (!video) return;
  video.pause();
  video.currentTime = 0;
}
</script>

<template>
  <div
    class="film-art"
    :class="`film-art--${ratio}`"
    :style="{ '--a': film.a, '--b': film.b }"
    @mouseenter="playPreview"
    @mouseleave="stopPreview"
  >
    <img
      :src="displaySrc"
      :srcset="displaySrcset || undefined"
      :sizes="displaySrcset ? coverSizes : undefined"
      :class="['film-fallback', { 'is-loading': !coverLoaded, 'is-failed': coverFailed }]"
      alt=""
      loading="lazy"
      decoding="async"
      @load="coverLoaded = true"
      @error="onCoverError"
    />
    <span class="film-cjk" :class="{ 'is-fading': coverLoaded && !coverFailed }">{{ film.title[0] }}</span>
    <video
      v-if="film.previewUrl && previewReady"
      class="film-hover-video"
      :src="film.previewUrl"
      :poster="imageVariant(film.coverUrl, 640) || film.coverUrl || ''"
      muted
      loop
      playsinline
      preload="none"
      aria-hidden="true"
      @mouseenter="playPreview"
      @mouseleave="stopPreview"
    ></video>
    <span class="film-en">{{ film.subtitle || film.typeLabel }}</span>
    <span v-if="badge && film.isNew" class="film-badge">NEW</span>
  </div>
</template>
