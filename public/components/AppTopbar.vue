<script setup>
import { computed, ref } from 'vue'
import { ElButton, ElIcon, ElInput, ElSegmented } from 'element-plus'
import { Clock, Message, Search, Star, Trophy } from '@element-plus/icons-vue'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/icon/style/css'
import 'element-plus/es/components/input/style/css'
import 'element-plus/es/components/segmented/style/css'
import { t } from '../i18n.js'
import { chromeState } from '../chrome.js'

const keyword = ref('')
const languageOptions = [
  { label: '中文', value: 'zh' },
  { label: 'EN', value: 'en' },
]
const user = computed(() => chromeState.user)
const copy = computed(() => {
  const en = chromeState.lang === 'en'
  const nickname = user.value?.nickname ?? t('我的账号')
  return {
    brand: en ? 'Yingchao' : t('影巢'),
    search: t('搜索剧名、简介、标签'),
    language: t('语言切换'),
    history: t('历史'),
    favorites: en ? 'Saved' : t('收藏'),
    messages: en ? 'Inbox' : t('消息'),
    vip: en ? 'VIP' : t('会员'),
    login: user.value ? nickname : t('登录'),
    loginTitle: user.value ? (en ? 'Open profile' : '进入个人中心') : t('登录 / 注册'),
    loginAria: user.value
      ? (en ? `Open profile (${nickname})` : `进入个人中心（当前账号 ${nickname}）`)
      : (en ? 'Log in or sign up' : '登录或注册'),
  }
})

function submitSearch() {
  chromeState.actions.search?.(keyword.value.trim())
}

function switchLanguage(lang) {
  chromeState.actions.switchLanguage?.(lang)
}
</script>

<template>
  <header class="topbar" id="topbar">
    <a class="logo" href="#/home">
      <img class="logo-mark" src="../icons/icon-64x64.png" alt="" width="26" height="26" />{{ copy.brand }}
    </a>
    <form class="search" role="search" @submit.prevent="submitSearch">
      <el-input
        v-model="keyword"
        :aria-label="copy.search"
        :placeholder="copy.search"
        autocomplete="off"
      >
        <template #prefix><el-icon><Search /></el-icon></template>
      </el-input>
    </form>
    <div class="top-actions">
      <el-segmented
        class="lang-switch"
        data-i18n-ignore
        :aria-label="copy.language"
        :model-value="chromeState.lang"
        :options="languageOptions"
        @change="switchLanguage"
      />
      <a class="top-action" href="#/history">
        <span class="ico" aria-hidden="true">
          <el-icon><Clock /></el-icon>
        </span>{{ copy.history }}
      </a>
      <a class="top-action" href="#/favorites">
        <span class="ico" aria-hidden="true">
          <el-icon><Star /></el-icon>
        </span>{{ copy.favorites }}
      </a>
      <a class="top-action" href="#/me?tab=message">
        <span class="ico" aria-hidden="true">
          <el-icon><Message /></el-icon>
        </span>{{ copy.messages }}
      </a>
      <a class="top-action" href="#/me?tab=vip">
        <span class="ico" aria-hidden="true">
          <el-icon><Trophy /></el-icon>
        </span>{{ copy.vip }}
      </a>
      <el-button
        class="btn-login"
        id="login-btn"
        round
        :title="copy.loginTitle"
        :aria-label="copy.loginAria"
        :aria-haspopup="user ? undefined : 'dialog'"
        @click="chromeState.actions.openProfile?.()"
      >{{ copy.login }}</el-button>
    </div>
  </header>
</template>
