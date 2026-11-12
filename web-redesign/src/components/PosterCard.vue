<script setup>
import FilmArt from './FilmArt.vue';
import { href } from '../router.js';

defineProps({
  film: { type: Object, required: true },
  badge: { type: Boolean, default: true }
});
</script>

<template>
  <a class="film" :href="href(`/detail/${film.id}`)" :aria-label="film.title">
    <FilmArt :film="film" :badge="badge" />
    <span class="film-title truncate">{{ film.title }}</span>
    <span class="film-meta">
      <span class="score">{{ film.score.toFixed(1) }}</span>
      <span>{{ film.typeLabel }}{{ film.area ? ` · ${film.area}` : '' }}</span>
    </span>
  </a>
</template>
