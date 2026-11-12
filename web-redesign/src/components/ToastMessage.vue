<script setup>
import Icon from './Icon.vue';
import { toastState } from '../authState.js';
</script>

<template>
  <div
    id="toast"
    class="toast"
    :class="{ show: toastState.show }"
    :data-kind="toastState.kind"
    role="status"
    aria-live="polite"
  >
    <Icon :name="toastState.kind === 'bad' ? 'alert' : 'check'" />
    <span>{{ toastState.message }}</span>
  </div>
</template>
