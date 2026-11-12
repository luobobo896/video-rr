<script setup>
defineProps({
  film: { type: Object, required: true },
  badge: { type: Boolean, default: true },
  ratio: { type: String, default: 'portrait' }
});

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
    <span v-else class="film-cjk">{{ film.title[0] }}</span>
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
