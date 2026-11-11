<script setup>
import AdminLogin from './components/AdminLogin.vue'
import AdminNav from './components/AdminNav.vue'
</script>

<template>
  <AdminLogin />

  <div id="shell" class="shell hidden">
    <h1 class="sr-only">影巢运营后台</h1>
    <button class="skip-link" type="button">跳到主要内容</button>
    <aside class="side">
      <div class="brand"><img class="brand-mark" src="./icons/icon-96x96.png" alt="" width="26" height="26" />影巢后台</div>
      <AdminNav aria-label="后台主导航" />
      <div class="side-foot">
        <a id="open-site" href="/" target="_blank" rel="noopener">打开 C 端<svg class="icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M19 13v7H4V5h7"/></svg></a>
        <button id="change-pass">修改密码</button>
        <button id="logout">退出登录</button>
      </div>
    </aside>
    <main class="content">
      <header class="top">
        <h2 id="page-title">概览</h2>
        <div class="top-right" id="top-right"></div>
        <div class="muted" id="whoami" style="font-size:12px;margin-left:14px"></div>
      </header>
      <section id="view" tabindex="-1" aria-labelledby="page-title"></section>
    </main>
  </div>

  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
</template>
