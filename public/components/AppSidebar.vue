<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { t } from '../i18n.js'
import { chromeState } from '../chrome.js'
import { NAV_MAIN, NAV_MOBILE, mobileNavLabel, navIsActive } from '../nav.js'

const root = ref(null)

const adultItem = computed(() => {
  const menu = chromeState.adultMenu
  if (!menu?.enabled) return null
  return {
    label: menu.labels?.[chromeState.lang] ?? menu.labels?.zh ?? '成人',
    href: '#/adult',
    active: navIsActive('#/adult', chromeState.hash),
    adult: true,
  }
})

const groups = computed(() => {
  const hash = chromeState.hash
  const lang = chromeState.lang
  const tr = (text) => (lang === 'en' ? t(text) : text)
  const links = (items) => items.map(([label, href]) => ({
    label: tr(label),
    href,
    active: navIsActive(href, hash),
  }))
  const navItems = links(NAV_MAIN)
  if (adultItem.value) {
    const documentaryIndex = navItems.findIndex((item) => item.href === '#/category/DOCUMENTARY')
    navItems.splice(documentaryIndex >= 0 ? documentaryIndex + 1 : navItems.length, 0, adultItem.value)
  }
  return [
    { title: tr('频道'), items: navItems },
    {
      title: tr('榜单'),
      items: [
        { label: tr('全部榜单'), href: '#/rank', active: navIsActive('#/rank', hash) },
        { label: tr('内容数据榜'), href: '#/content-rank', active: navIsActive('#/content-rank', hash) },
      ],
    },
    {
      title: tr('我的'),
      items: [
        { label: tr('个人中心'), href: '#/me', active: navIsActive('#/me', hash) },
        { label: tr('观看历史'), href: '#/history', active: navIsActive('#/history', hash) },
        { label: tr('我的收藏'), href: '#/favorites', active: navIsActive('#/favorites', hash) },
        { label: tr('佣金推广'), href: '#/promotion', active: navIsActive('#/promotion', hash) },
      ],
    },
  ]
})

const mobileItems = computed(() => {
  const hash = chromeState.hash
  const items = NAV_MOBILE.map(([label, href]) => ({
    label: mobileNavLabel(label, href, chromeState.lang),
    href,
    active: navIsActive(href, hash),
  }))
  if (adultItem.value) items.splice(2, 0, adultItem.value)
  return items
})

function handleNavClick(item, event) {
  if (!item.adult || !chromeState.actions.openAdult) return
  event.preventDefault()
  chromeState.actions.openAdult()
}

function revealActive() {
  const sidebar = root.value
  const active = sidebar?.querySelector('.nav-item.active')
  if (!sidebar || !active || sidebar.scrollHeight <= sidebar.clientHeight + 1) return
  const box = sidebar.getBoundingClientRect()
  const item = active.getBoundingClientRect()
  const padding = 8
  if (item.top < box.top + padding) sidebar.scrollTop -= box.top + padding - item.top
  else if (item.bottom > box.bottom - padding) sidebar.scrollTop += item.bottom - (box.bottom - padding)
}

watch([() => chromeState.hash, () => chromeState.lang], async () => {
  await nextTick()
  revealActive()
})
onMounted(revealActive)
</script>

<template>
  <aside ref="root" class="sidebar" id="sidebar" :aria-label="t('侧边导航')">
    <div v-for="group in groups" :key="group.title" class="nav-group">
      <div class="nav-title">{{ group.title }}</div>
      <a
        v-for="item in group.items"
        :key="item.href"
        class="nav-item"
        :class="{ active: item.active }"
        :href="item.href"
        :aria-current="item.active ? 'page' : undefined"
        @click="handleNavClick(item, $event)"
      ><span v-if="item.adult" data-i18n-ignore>{{ item.label }}</span><template v-else>{{ item.label }}</template></a>
    </div>
    <nav class="nav-group mobile-tabs" :class="{ 'has-adult': adultItem }" :aria-label="chromeState.lang === 'en' ? 'Mobile navigation' : '移动端主导航'">
      <a
        v-for="item in mobileItems"
        :key="item.href"
        class="nav-item"
        :class="{ active: item.active }"
        :href="item.href"
        :aria-current="item.active ? 'page' : undefined"
        @click="handleNavClick(item, $event)"
      ><span data-i18n-ignore>{{ item.label }}</span></a>
    </nav>
  </aside>
</template>
