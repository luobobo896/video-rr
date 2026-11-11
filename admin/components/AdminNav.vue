<script setup>
import { nextTick, ref, watch } from 'vue'
import { ElMenu, ElMenuItem, ElSubMenu } from 'element-plus'
import 'element-plus/es/components/menu/style/css'
import { adminUi } from '../ui.js'

const OPEN_KEY = 'mh-admin-nav-open'
const menuRef = ref()

function saveOpen(keys) {
  adminUi.openKeys = keys
  localStorage.setItem(OPEN_KEY, JSON.stringify(keys))
}

function openGroup(index) {
  const keys = new Set(adminUi.openKeys)
  keys.add(index)
  saveOpen([...keys])
}

function closeGroup(index) {
  const keys = new Set(adminUi.openKeys)
  keys.delete(index)
  saveOpen([...keys])
}

function select(index) {
  location.hash = `#/${index}`
}

watch(() => [...adminUi.openKeys], async (next, previous = []) => {
  await nextTick()
  const open = new Set(next)
  const known = new Set(adminUi.groups.map((group) => group.id))
  for (const key of previous) if (!open.has(key)) menuRef.value?.close(key)
  for (const key of next) if (known.has(key)) menuRef.value?.open(key)
})
</script>

<template>
  <el-menu
    ref="menuRef"
    id="nav"
    class="admin-menu"
    :default-active="adminUi.active"
    :default-openeds="adminUi.openKeys"
    @select="select"
    @open="openGroup"
    @close="closeGroup"
  >
    <el-sub-menu v-for="group in adminUi.groups" :key="group.id" :index="group.id">
      <template #title>{{ group.title }}</template>
      <el-menu-item v-for="item in group.items" :key="item.key" :index="item.key">
        {{ item.label }}
      </el-menu-item>
    </el-sub-menu>
  </el-menu>
</template>
