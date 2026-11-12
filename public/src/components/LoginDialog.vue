<script setup>
import { nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import {
  loginWithCode,
  loginWithPassword,
  sendLoginCode,
  toast,
  ui
} from '../authState.js';

const props = defineProps({
  modelValue: { type: Boolean, default: false }
});

const emit = defineEmits(['update:modelValue']);
const dialog = ref(null);
const mode = ref('code');
const email = ref('');
const code = ref('');
const password = ref('');
const error = ref('');
const sending = ref(false);
const submitting = ref(false);
const cooldown = ref(0);

function close() {
  emit('update:modelValue', false);
}

function setMode(nextMode) {
  mode.value = nextMode;
}

async function sendCode() {
  error.value = '';
  if (!email.value.includes('@')) {
    error.value = '请输入有效邮箱';
    return;
  }
  sending.value = true;
  try {
    const result = await sendLoginCode(email.value);
    toast('验证码已发送，请查收邮箱');
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
  submitting.value = true;
  try {
    if (mode.value === 'code') {
      if (!/^\d{6}$/.test(code.value.trim())) {
        error.value = '请输入 6 位数字验证码';
        return;
      }
      await loginWithCode(email.value, code.value);
    } else {
      if (!password.value.trim()) {
        error.value = '请输入密码';
        return;
      }
      await loginWithPassword(email.value, password.value);
    }
    close();
    toast('已登录，欢迎回来');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    submitting.value = false;
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    await nextTick();
    if (!dialog.value) return;
    if (open && !dialog.value.open) {
      error.value = '';
      dialog.value.showModal();
      setTimeout(() => dialog.value?.querySelector('input')?.focus(), 30);
    } else if (!open && dialog.value.open) {
      dialog.value.close();
    }
  }
);
</script>

<template>
  <dialog
    ref="dialog"
    aria-labelledby="login-title"
    @close="close"
    @click.self="close"
  >
    <div class="dialog-head">
      <div>
        <h2 id="login-title">登录影巢</h2>
        <p>登录后同步观看记录与片单</p>
      </div>
      <button class="icon-btn dialog-close" type="button" aria-label="关闭" @click="close">
        <Icon name="close" />
      </button>
    </div>
    <form @submit.prevent="submit">
      <div class="dialog-body">
        <div class="segmented" role="group" aria-label="登录方式">
          <button type="button" :aria-pressed="mode === 'code'" @click="setMode('code')">验证码登录</button>
          <button type="button" :aria-pressed="mode === 'pass'" @click="setMode('pass')">密码登录</button>
        </div>
        <div class="field">
          <label for="login-email">邮箱</label>
          <input
            id="login-email"
            v-model="email"
            type="email"
            placeholder="you@example.com"
            autocomplete="email"
            required
          />
        </div>
        <div v-if="mode === 'code'" class="field">
          <label for="login-code">验证码</label>
          <div style="display:flex;gap:8px">
            <input
              id="login-code"
              v-model="code"
              inputmode="numeric"
              placeholder="6 位数字"
              autocomplete="one-time-code"
              required
            />
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
        <div v-else class="field">
          <label for="login-pass">密码</label>
          <input
            id="login-pass"
            v-model="password"
            type="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            required
          />
        </div>
        <p v-if="error" class="field error" role="alert">{{ error }}</p>
        <p v-else-if="ui.loginMessage" class="dialog-note">
          <Icon name="alert" />
          <span>{{ ui.loginMessage }}</span>
        </p>
      </div>
      <div class="dialog-foot">
        <button type="button" class="btn btn--ghost" @click="close">取消</button>
        <button class="btn btn--primary" type="submit" :disabled="submitting">
          {{ submitting ? '登录中' : '登录' }}
        </button>
      </div>
    </form>
  </dialog>
</template>
