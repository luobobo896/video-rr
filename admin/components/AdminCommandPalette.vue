<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { adminUi } from '../ui.js'

const dialogRef = ref()
const inputRef = ref()
const query = ref('')

const commands = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  const matches = (text) => !keyword || String(text).toLowerCase().includes(keyword)
  const groups = adminUi.groups
    .map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.filter((item) => matches(item.label) || matches(group.title)),
    }))
    .filter((group) => group.items.length)
  const actions = [
    { key: 'profile', label: '个人设置', run: () => navigate('profile') },
    { key: 'site', label: '打开 C 端', run: openSite },
    { key: 'password', label: '修改密码', run: () => document.getElementById('change-pass')?.click() },
    { key: 'logout', label: '退出登录', run: () => document.getElementById('logout')?.click() },
  ].filter((action) => matches(action.label))
  return { groups, actions }
})

function open() {
  if (document.getElementById('shell')?.classList.contains('hidden')) return
  if (!dialogRef.value || dialogRef.value.open) return
  query.value = ''
  dialogRef.value.showModal()
  nextTick(() => inputRef.value?.focus())
}

function close() {
  dialogRef.value?.close()
}

function navigate(key) {
  close()
  location.hash = `#/${key}`
}

function openSite() {
  const target = document.getElementById('open-site')?.href
  if (target) window.open(target, '_blank', 'noopener')
}

function run(action) {
  close()
  action.run()
}

function onGlobalKeydown(event) {
  if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    if (dialogRef.value?.open) close()
    else open()
  }
}

function onOpenEvent() {
  open()
}

function onBackdrop(event) {
  if (event.target === dialogRef.value) close()
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('mh-admin-open-command', onOpenEvent)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('mh-admin-open-command', onOpenEvent)
})
</script>

<template>
  <dialog ref="dialogRef" class="admin-command-dialog" aria-labelledby="admin-command-title" @click="onBackdrop">
    <div class="admin-command-box">
      <h2 id="admin-command-title" class="sr-only">搜索后台功能</h2>
      <label class="admin-command-search">
        <span class="sr-only">搜索页面或操作</span>
        <input ref="inputRef" v-model="query" type="search" placeholder="搜索页面或操作…" autocomplete="off" />
        <kbd>Esc</kbd>
      </label>
      <div class="admin-command-list">
        <section v-for="group in commands.groups" :key="group.id" class="admin-command-group">
          <h3>{{ group.title }}</h3>
          <button v-for="item in group.items" :key="item.key" type="button" @click="navigate(item.key)">
            <span>{{ item.label }}</span>
            <span aria-hidden="true">→</span>
          </button>
        </section>
        <section v-if="commands.actions.length" class="admin-command-group">
          <h3>操作</h3>
          <button v-for="action in commands.actions" :key="action.key" type="button" @click="run(action)">
            <span>{{ action.label }}</span>
            <span aria-hidden="true">→</span>
          </button>
        </section>
        <p v-if="!commands.groups.length && !commands.actions.length" class="admin-command-empty">没有匹配的页面或操作</p>
      </div>
    </div>
  </dialog>
</template>
