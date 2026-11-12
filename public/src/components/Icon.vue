<script setup>
import { ICON_PATHS } from '../icons.js';

defineProps({
  name: { type: String, required: true },
  className: { type: String, default: '' }
});
</script>

<template>
  <svg
    class="icon"
    :class="className"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <g v-html="ICON_PATHS[name] || ''" />
  </svg>
</template>
