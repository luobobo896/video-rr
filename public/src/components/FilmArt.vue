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
const coverSrc = computed(() => imageVariant(props.film?.coverUrl, props.ratio === 'portrait' ? 320 : 640) || props.film?.coverUrl)
// 竖版卡片一格约 180px 宽，横版/大图按视口宽度走。
const coverSizes = computed(() => (props.ratio === 'portrait' ? '(max-width: 520px) 45vw, 200px' : '(max-width: 900px) 100vw, 900px'))

// 封面还在路上时先把卡片留在渐变占位上，别让格子先闪白再填图。
const coverLoaded = ref(false);
const coverFailed = ref(false);

function onCoverError(event) {
  const img = event?.target;
  if (!img || img.dataset.fallback === '1') {
    coverFailed.value = true;
    return;
  }
  img.dataset.fallback = '1';
  img.removeAttribute('srcset');
  img.src = props.film?.coverUrl ?? img.src;
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
      v-if="film.coverUrl"
      :src="coverSrc"
      :srcset="coverSrcset || undefined"
      :sizes="coverSrcset ? coverSizes : undefined"
      :class="{ 'is-loading': !coverLoaded, 'is-failed': coverFailed }"
      alt=""
      loading="lazy"
      decoding="async"
      @load="coverLoaded = true"
      @error="onCoverError"
    />
    <template v-else>
      <img class="film-fallback" :src="fallbackArt(film)" alt="" loading="lazy" />
      <span class="film-cjk">{{ film.title[0] }}</span>
    </template>
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
