<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { adminUi } from '../ui.js'

const dialogRef = ref()

function open() {
  dialogRef.value?.showModal()
}

function close() {
  dialogRef.value?.close()
}

function onHashChange() {
  if (dialogRef.value?.open) close()
}

function onBackdrop(event) {
  if (event.target === dialogRef.value) close()
}

function openSite() {
  const target = document.getElementById('open-site')?.href
  close()
  if (target) window.open(target, '_blank', 'noopener')
}

function clickAction(id) {
  close()
  document.getElementById(id)?.click()
}

onMounted(() => window.addEventListener('hashchange', onHashChange))
onBeforeUnmount(() => window.removeEventListener('hashchange', onHashChange))
</script>

<template>
  <button class="mobile-nav-trigger" type="button" aria-label="打开全部功能菜单" aria-haspopup="dialog" @click="open">
    <span aria-hidden="true">☰</span>
    <span>菜单</span>
  </button>
  <dialog ref="dialogRef" class="admin-mobile-nav" aria-labelledby="admin-mobile-nav-title" @click="onBackdrop">
    <div class="admin-mobile-nav-box">
      <header>
        <h2 id="admin-mobile-nav-title">全部功能</h2>
        <button class="btn sm" type="button" @click="close">关闭</button>
      </header>
      <nav aria-label="后台完整导航">
        <section v-for="group in adminUi.groups" :key="group.id">
          <h3>{{ group.title }}</h3>
          <a v-for="item in group.items" :key="item.key" :href="`#/${item.key}`" @click="close">{{ item.label }}</a>
        </section>
      </nav>
      <footer class="admin-mobile-nav-actions">
        <a href="#/profile" @click="close">个人设置</a>
        <button type="button" @click="openSite">打开 C 端</button>
        <button type="button" @click="clickAction('change-pass')">修改密码</button>
        <button type="button" class="danger" @click="clickAction('logout')">退出登录</button>
      </footer>
    </div>
  </dialog>
</template>
