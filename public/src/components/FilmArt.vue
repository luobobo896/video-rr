<script setup>
defineProps({
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

function playPreview(event) {
  const video = event.currentTarget.querySelector('video');
  if (video) video.play().catch(() => {});
}

function stopPreview(event) {
  const video = event.currentTarget.querySelector('video');
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
    <img v-if="film.coverUrl" :src="film.coverUrl" alt="" loading="lazy" />
    <template v-else>
      <img class="film-fallback" :src="fallbackArt(film)" alt="" loading="lazy" />
      <span class="film-cjk">{{ film.title[0] }}</span>
    </template>
    <video
      v-if="film.previewUrl"
      class="film-hover-video"
      :src="film.previewUrl"
      muted
      loop
      playsinline
      preload="none"
      aria-hidden="true"
    ></video>
    <span class="film-en">{{ film.subtitle || film.typeLabel }}</span>
    <span v-if="badge && film.isNew" class="film-badge">NEW</span>
  </div>
</template>
