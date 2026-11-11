<script setup>
import { computed, ref } from 'vue'
import { t } from './i18n.js'
import { chromeState } from './chrome.js'
import AppSidebar from './components/AppSidebar.vue'
import AppTopbar from './components/AppTopbar.vue'

const view = ref(null)
const lang = computed(() => chromeState.lang)
const skipText = computed(() => (lang.value, t('跳到主要内容')))
const loadingText = computed(() => (lang.value, t('影巢 · 正在加载')))

function focusMain() {
  view.value?.focus()
  view.value?.scrollIntoView({ block: 'start' })
}
</script>

<template>
  <button class="skip-link" type="button" @click="focusMain">{{ skipText }}</button>
  <div id="app">
    <AppSidebar />
    <div class="main">
      <AppTopbar />
      <main ref="view" id="view" class="view" tabindex="-1"><div id="boot">{{ loadingText }}</div></main>
    </div>
    <div id="modal" class="modal hidden" aria-hidden="true"></div>
    <div id="toast" class="toast hidden" role="status" aria-live="polite" aria-atomic="true"></div>
  </div>
</template>
