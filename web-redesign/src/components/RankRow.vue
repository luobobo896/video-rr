<script setup>
import { href } from '../router.js';

defineProps({
  to: { type: String, required: true },
  rank: { type: Number, required: true },
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
  score: { type: [String, Number], default: '' },
  action: { type: String, default: '查看' }
});
</script>

<template>
  <a class="rank-row" :href="href(to)">
    <span class="rank-no">{{ String(rank).padStart(2, '0') }}</span>
    <span class="rank-main">
      <strong>{{ title }}</strong>
      <span v-if="subtitle">{{ subtitle }}</span>
    </span>
    <span v-if="score !== ''" class="rank-score">{{ score }}</span>
    <span v-if="action" class="btn btn--ghost btn--sm">{{ action }}</span>
  </a>
</template>
