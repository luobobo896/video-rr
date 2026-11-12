<script setup>
import { ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { go, href } from '../../router.js';
import {
  loginWithCode,
  loginWithPassword,
  sendLoginCode,
  toast
} from '../../authState.js';

const email = ref('');
const code = ref('');
const password = ref('');
const mode = ref('code');
const error = ref('');
const sending = ref(false);
const submitting = ref(false);
const cooldown = ref(0);

async function sendCode() {
  error.value = '';
  if (!email.value.includes('@')) {
    error.value = '请输入有效邮箱';
    return;
  }
  sending.value = true;
  try {
    const result = await sendLoginCode(email.value);
    toast('验证码已发送');
    cooldown.value = Number(result.resendAfter ?? 60);
    const timer = window.setInterval(() => {
      cooldown.value -= 1;
      if (cooldown.value <= 0) window.clearInterval(timer);
    }, 1000);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    sending.value = false;
  }
}

async function submit() {
  error.value = '';
  if (!email.value.includes('@')) {
    error.value = '请输入有效邮箱';
    return;
  }
  if (mode.value === 'code' && !/^\d{6}$/.test(code.value.trim())) {
    error.value = '请输入 6 位数字验证码';
    return;
  }
  if (mode.value === 'pass' && !password.value) {
    error.value = '请输入密码';
    return;
  }
  submitting.value = true;
  try {
    if (mode.value === 'code') await loginWithCode(email.value, code.value);
    else await loginWithPassword(email.value, password.value);
    toast('已登录，欢迎回来');
    go('/me');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <main class="page" style="min-height: 100vh; place-content: center; max-width: 520px">
    <a class="brand" :href="href('/')" style="margin-bottom: 12px">
      <span class="brand-mark">影</span>
      <span class="brand-name">影巢<span class="brand-sub">CINEMA NEST</span></span>
    </a>
    <div class="panel" style="padding: 32px">
      <h1 class="h2" style="margin-bottom: 6px">登录影巢</h1>
      <p class="small muted" style="margin-bottom: 20px">登录后同步观看记录、收藏与会员权益。</p>
      <form @submit.prevent="submit">
        <div class="segmented" style="margin-bottom: 16px" role="group" aria-label="登录方式">
          <button type="button" :aria-pressed="mode === 'code'" @click="mode = 'code'">验证码登录</button>
          <button type="button" :aria-pressed="mode === 'pass'" @click="mode = 'pass'">密码登录</button>
        </div>
        <div class="field">
          <label for="email">邮箱</label>
          <input id="email" v-model="email" type="email" placeholder="you@example.com" required />
        </div>
        <div v-if="mode === 'code'" class="field" style="margin-top: 12px">
          <label for="code">验证码</label>
          <div style="display: flex; gap: 8px">
            <input id="code" v-model="code" inputmode="numeric" placeholder="6 位数字" required />
            <button
              class="btn btn--ghost"
              type="button"
              :disabled="sending || cooldown > 0"
              @click="sendCode"
            >
              {{ sending ? '发送中' : cooldown > 0 ? `${cooldown}s` : '发送验证码' }}
            </button>
          </div>
        </div>
        <div v-else class="field" style="margin-top: 12px">
          <label for="password">密码</label>
          <input id="password" v-model="password" type="password" placeholder="请输入密码" autocomplete="current-password" required />
        </div>
        <p v-if="error" class="field error" role="alert" style="margin-top: 12px">{{ error }}</p>
        <button class="btn btn--primary btn--block" style="margin-top: 16px" type="submit" :disabled="submitting">
          {{ submitting ? '登录中' : '登录 / 注册' }}
        </button>
      </form>
      <p class="meta" style="margin-top: 16px"><a :href="href('/')">返回首页</a></p>
    </div>
  </main>
</template>
