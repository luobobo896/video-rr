<script setup>
import { ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { adminApi } from '../../api.js';
import { go, href } from '../../router.js';
import {
  adminState,
  loadAdminMe,
  loginAdmin,
  toast
} from '../../authState.js';

const account = ref('');
const password = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const needsPasswordChange = ref(false);
const error = ref('');
const submitting = ref(false);

async function submitLogin() {
  error.value = '';
  if (!account.value.trim() || !password.value) {
    error.value = '请输入账号与密码';
    return;
  }
  submitting.value = true;
  try {
    const data = await loginAdmin(account.value, password.value);
    if (data.mustChangePassword) {
      needsPasswordChange.value = true;
      toast('首次登录请先设置新密码');
      return;
    }
    toast('登录成功');
    go('/admin/overview');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    submitting.value = false;
  }
}

async function changePassword() {
  error.value = '';
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致';
    return;
  }
  if (newPassword.value.length < 12) {
    error.value = '后台密码至少 12 位';
    return;
  }
  submitting.value = true;
  try {
    const data = await adminApi('/password', {
      method: 'POST',
      body: { oldPassword: password.value, newPassword: newPassword.value }
    });
    adminState.token = data.token;
    localStorage.setItem('mh-admin-token', data.token);
    await loadAdminMe();
    toast('密码已更新');
    go('/admin/overview');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="admin-login" style="grid-template-columns: 1fr">
    <div class="login-form-wrap">
      <form class="login-form" @submit.prevent="needsPasswordChange ? changePassword() : submitLogin()">
        <a class="brand" :href="href('/admin/login')" style="margin-bottom: 12px">
          <span class="brand-mark">影</span>
          <span class="brand-name">影巢运营<span class="brand-sub">OPS CONSOLE</span></span>
        </a>
        <h2>{{ needsPasswordChange ? '设置新密码' : '登录运营后台' }}</h2>
        <p>{{ needsPasswordChange ? '首次登录必须修改初始密码。' : '使用后台管理员账号继续。' }}</p>

        <template v-if="!needsPasswordChange">
          <div class="field">
            <label for="admin-user">账号</label>
            <input id="admin-user" v-model="account" placeholder="请输入账号" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="admin-pass">密码</label>
            <input id="admin-pass" v-model="password" type="password" placeholder="请输入密码" autocomplete="current-password" required />
          </div>
        </template>

        <template v-else>
          <div class="field">
            <label for="admin-new-pass">新密码</label>
            <input id="admin-new-pass" v-model="newPassword" type="password" placeholder="至少 12 位，含字母和数字" autocomplete="new-password" required />
          </div>
          <div class="field">
            <label for="admin-confirm-pass">确认新密码</label>
            <input id="admin-confirm-pass" v-model="confirmPassword" type="password" placeholder="再次输入新密码" autocomplete="new-password" required />
          </div>
        </template>

        <p v-if="error" class="field error" role="alert">{{ error }}</p>
        <button class="btn btn--primary btn--lg btn--block" type="submit" :disabled="submitting">
          {{ submitting ? '提交中' : needsPasswordChange ? '保存新密码' : '登录' }}
        </button>
        <a class="btn btn--quiet btn--block" :href="href('/')"><Icon name="back" />返回 C 端</a>
        <p class="demo-hint">后台权限由服务端 RBAC 校验；页面菜单可见性不等于接口授权。</p>
      </form>
    </div>
  </section>
</template>
