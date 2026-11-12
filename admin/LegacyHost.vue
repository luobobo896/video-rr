<script setup>
import AdminLogin from './components/AdminLogin.vue'
import AdminNav from './components/AdminNav.vue'
</script>

<template>
  <AdminLogin />

  <div id="shell" class="shell hidden">
    <button class="skip-link" type="button">跳到主要内容</button>
    <aside class="side" aria-label="运营后台侧栏">
      <a class="brand" href="#/dashboard" aria-label="影巢运营后台首页">
        <span class="brand-mark" aria-hidden="true">影</span>
        <span class="brand-name">影巢运营<span class="brand-sub">OPS CONSOLE</span></span>
      </a>
      <AdminNav aria-label="后台主导航" />
      <div class="side-foot">
        <div class="side-card">
          <div class="side-account">
            <span class="avatar" id="who-avatar" aria-hidden="true">管</span>
            <div class="side-account-copy">
              <strong id="side-user-name">管理员</strong>
              <span id="side-user-role">运营控制台</span>
            </div>
          </div>
          <div class="side-actions">
            <a id="open-site" class="side-link" href="/" target="_blank" rel="noopener">打开 C 端<svg class="icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M19 13v7H4V5h7"/></svg></a>
            <button id="change-pass" class="side-link" type="button">修改密码</button>
            <button id="logout" class="side-link side-link--danger" type="button">退出登录</button>
          </div>
        </div>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <div class="topbar-context">
          <span class="topbar-dot" aria-hidden="true"></span>
          <span>运营台在线</span>
          <span class="topbar-sep" aria-hidden="true">/</span>
          <span>数据与内容运营</span>
        </div>
        <div class="top-actions">
          <div class="account">
            <span class="avatar" id="top-avatar" aria-hidden="true">管</span>
            <span id="whoami" class="account-copy"></span>
          </div>
        </div>
      </header>
      <main class="content">
        <header class="top page-head">
          <div class="page-head-copy">
            <h1 id="page-title">概览</h1>
            <p class="page-sub">内容、交易与增长统一运营</p>
          </div>
          <div class="top-right" id="top-right"></div>
        </header>
        <section id="view" tabindex="-1" aria-labelledby="page-title"></section>
      </main>
    </div>
  </div>

  <div id="toast" class="toast hidden" role="status" aria-live="polite"></div>
</template>
