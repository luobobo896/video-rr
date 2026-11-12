<script setup>
defineProps({
  film: { type: Object, required: true },
  badge: { type: Boolean, default: true }
});
</script>

<template>
  <div
    class="film-art"
    :style="{ '--a': film.a, '--b': film.b }"
  >
    <img v-if="film.coverUrl" :src="film.coverUrl" alt="" loading="lazy" />
    <span v-else class="film-cjk">{{ film.title[0] }}</span>
    <span class="film-en">{{ film.subtitle || film.typeLabel }}</span>
    <span v-if="badge && film.isNew" class="film-badge">NEW</span>
  </div>
</template>
