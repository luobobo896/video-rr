<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import Icon from '../../components/Icon.vue';
import { mediaUrl } from '../../api.js';
import { href } from '../../router.js';
import {
  changeEmail,
  changePassword,
  refreshMe,
  requireLogin,
  saveProfile,
  sendEmailChangeCode,
  sendPasswordChangeCode,
  state,
  toast,
  uploadAvatar
} from '../../authState.js';

const form = reactive({
  nickname: '',
  birthday: '',
  gender: '',
  bio: ''
});
const error = ref('');
const saving = ref(false);
const uploading = ref(false);
const passwordCode = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const passwordSending = ref(false);
const passwordChanging = ref(false);
const passwordCooldown = ref(0);
const newEmail = ref('');
const emailCode = ref('');
const emailSending = ref(false);
const emailChanging = ref(false);
const emailCooldown = ref(0);

const completion = computed(() => state.me?.completion ?? { percent: 0, filled: 0, total: 6, missing: [] });
const avatarUrl = computed(() => (state.user?.avatar ? mediaUrl(state.user.avatar) : ''));
const currentEmail = computed(() => state.user?.email || '');

function syncForm() {
  form.nickname = state.user?.nickname || '';
  form.birthday = state.user?.birthday || '';
  form.gender = state.user?.gender || '';
  form.bio = state.user?.bio || '';
}

function startCooldown(target) {
  target.value = 60;
  const timer = window.setInterval(() => {
    target.value -= 1;
    if (target.value <= 0) window.clearInterval(timer);
  }, 1000);
}

async function load() {
  if (!state.user) return;
  try {
    await refreshMe();
    syncForm();
  } catch (requestError) {
    error.value = requestError.message;
  }
}

async function save() {
  error.value = '';
  if (form.nickname.trim().length < 2 || form.nickname.trim().length > 20) {
    error.value = '昵称需 2–20 个字符';
    return;
  }
  saving.value = true;
  try {
    await saveProfile({
      nickname: form.nickname.trim(),
      birthday: form.birthday,
      gender: form.gender,
      bio: form.bio.trim()
    });
    syncForm();
    toast('资料已保存');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    saving.value = false;
  }
}

async function pickAvatar(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) {
    error.value = '头像不能超过 1MB';
    return;
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('头像读取失败'));
    reader.readAsDataURL(file);
  }).catch((readError) => {
    error.value = readError.message;
    return null;
  });
  if (!dataUrl) return;
  uploading.value = true;
  error.value = '';
  try {
    await uploadAvatar(dataUrl);
    toast('头像已更新');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    uploading.value = false;
    event.target.value = '';
  }
}

async function sendPasswordCode() {
  passwordSending.value = true;
  error.value = '';
  try {
    const data = await sendPasswordChangeCode();
    toast('验证码已发送到注册邮箱');
    passwordCooldown.value = Number(data.resendAfter ?? 60);
    startCooldown(passwordCooldown);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    passwordSending.value = false;
  }
}

async function submitPassword() {
  error.value = '';
  if (!/^\d{6}$/.test(passwordCode.value.trim())) {
    error.value = '请输入 6 位数字验证码';
    return;
  }
  if (newPassword.value.length < 8 || !/[A-Za-z]/.test(newPassword.value) || !/\d/.test(newPassword.value)) {
    error.value = '新密码至少 8 位，并同时包含字母和数字';
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = '两次输入的新密码不一致';
    return;
  }
  passwordChanging.value = true;
  try {
    await changePassword({
      email: currentEmail.value,
      code: passwordCode.value.trim(),
      newPassword: newPassword.value
    });
    passwordCode.value = '';
    newPassword.value = '';
    confirmPassword.value = '';
    toast('密码已更新，其他设备需重新登录');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    passwordChanging.value = false;
  }
}

async function sendEmailCode() {
  if (!newEmail.value.includes('@')) {
    error.value = '请输入有效的新邮箱';
    return;
  }
  emailSending.value = true;
  error.value = '';
  try {
    const data = await sendEmailChangeCode(newEmail.value.trim());
    toast('验证码已发送到新邮箱');
    emailCooldown.value = Number(data.resendAfter ?? 60);
    startCooldown(emailCooldown);
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    emailSending.value = false;
  }
}

async function submitEmail() {
  error.value = '';
  if (!newEmail.value.includes('@')) {
    error.value = '请输入有效的新邮箱';
    return;
  }
  if (!/^\d{6}$/.test(emailCode.value.trim())) {
    error.value = '请输入 6 位数字验证码';
    return;
  }
  emailChanging.value = true;
  try {
    await changeEmail({ newEmail: newEmail.value.trim(), code: emailCode.value.trim() });
    newEmail.value = '';
    emailCode.value = '';
    toast('邮箱已更换');
  } catch (requestError) {
    error.value = requestError.message;
  } finally {
    emailChanging.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="section-head">
    <div>
      <h1 class="h1">编辑资料</h1>
      <p class="meta">资料只用于账号与推荐，不会公开展示邮箱</p>
    </div>
    <a class="section-link" :href="href('/me')">返回个人中心<Icon name="chevron" /></a>
  </div>
  <h2 class="sr-only">账号资料</h2>

  <div v-if="!state.user" class="empty">
    <Icon name="user" />
    <h3>登录后编辑资料</h3>
    <p>昵称、头像和账号安全设置保存在服务端。</p>
    <button class="btn btn--primary btn--sm" type="button" @click="requireLogin('登录后编辑资料')">登录</button>
  </div>
  <template v-else>
    <p v-if="error" class="field error" role="alert" style="margin: 0">{{ error }}</p>
    <div class="admin-grid">
      <form class="panel" @submit.prevent="save">
        <div class="panel-head"><h3>基本资料</h3><span class="meta">{{ completion.percent }}% 完整</span></div>
        <div class="avatar-edit">
          <span class="avatar" :style="avatarUrl ? { backgroundImage: `url(${avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : null">
            <template v-if="!avatarUrl">{{ (state.user.nickname || state.user.email || '影')[0] }}</template>
          </span>
          <div>
            <label class="btn btn--ghost btn--sm" for="avatar-file">{{ uploading ? '上传中…' : '上传头像' }}</label>
            <input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden :disabled="uploading" @change="pickAvatar" />
            <p class="small muted" style="margin-top: 6px">PNG / JPEG / WebP，小于 1MB。</p>
          </div>
        </div>
        <div class="form-grid" style="margin-top: 20px">
          <div class="field"><label for="nickname">昵称</label><input id="nickname" v-model="form.nickname" maxlength="20" /></div>
          <div class="field"><label for="birthday">生日</label><input id="birthday" v-model="form.birthday" type="date" /></div>
          <div class="field">
            <label for="gender">性别</label>
            <select id="gender" v-model="form.gender">
              <option value="">未填写</option>
              <option value="female">女</option>
              <option value="male">男</option>
              <option value="other">其他</option>
              <option value="secret">不愿透露</option>
            </select>
          </div>
          <div class="field"><label>邮箱</label><input :value="currentEmail" readonly /></div>
          <div class="field full"><label for="bio">简介</label><textarea id="bio" v-model="form.bio" maxlength="120" placeholder="一句话介绍自己"></textarea></div>
        </div>
        <div class="completeness" style="margin-top: 16px">
          <div class="row-between"><span class="meta">资料完整度</span><strong>{{ completion.percent }}%</strong></div>
          <div class="completeness-track"><span :style="{ width: `${completion.percent}%` }"></span></div>
          <p v-if="completion.missing?.length" class="small muted">待完善：{{ completion.missing.join('、') }}</p>
        </div>
        <button class="btn btn--primary" style="margin-top: 20px" type="submit" :disabled="saving">
          {{ saving ? '保存中…' : '保存资料' }}
        </button>
      </form>

      <div style="display: grid; gap: 16px; align-content: start">
        <form class="panel" @submit.prevent="submitPassword">
          <div class="panel-head"><h3>修改密码</h3><span class="meta">需邮箱验证</span></div>
          <p class="small muted">验证码发送到 {{ currentEmail }}，修改成功后其他设备会退出登录。</p>
          <div class="form-grid" style="grid-template-columns: 1fr; margin-top: 12px">
            <div class="field">
              <label for="password-code">验证码</label>
              <div style="display: flex; gap: 8px">
                <input id="password-code" v-model="passwordCode" inputmode="numeric" maxlength="6" />
                <button class="btn btn--ghost btn--sm" type="button" :disabled="passwordSending || passwordCooldown > 0" @click="sendPasswordCode">
                  {{ passwordSending ? '发送中' : passwordCooldown > 0 ? `${passwordCooldown}s` : '发送验证码' }}
                </button>
              </div>
            </div>
            <div class="field"><label for="new-password">新密码</label><input id="new-password" v-model="newPassword" type="password" autocomplete="new-password" /></div>
            <div class="field"><label for="confirm-password">确认新密码</label><input id="confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" /></div>
          </div>
          <button class="btn btn--ghost" style="margin-top: 12px" type="submit" :disabled="passwordChanging">
            {{ passwordChanging ? '提交中…' : '修改密码' }}
          </button>
        </form>

        <form class="panel" @submit.prevent="submitEmail">
          <div class="panel-head"><h3>更换邮箱</h3><span class="meta">当前 {{ currentEmail }}</span></div>
          <div class="form-grid" style="grid-template-columns: 1fr">
            <div class="field"><label for="new-email">新邮箱</label><input id="new-email" v-model="newEmail" type="email" /></div>
            <div class="field">
              <label for="email-code">验证码</label>
              <div style="display: flex; gap: 8px">
                <input id="email-code" v-model="emailCode" inputmode="numeric" maxlength="6" />
                <button class="btn btn--ghost btn--sm" type="button" :disabled="emailSending || emailCooldown > 0" @click="sendEmailCode">
                  {{ emailSending ? '发送中' : emailCooldown > 0 ? `${emailCooldown}s` : '发送验证码' }}
                </button>
              </div>
            </div>
          </div>
          <button class="btn btn--ghost" style="margin-top: 12px" type="submit" :disabled="emailChanging">
            {{ emailChanging ? '提交中…' : '更换邮箱' }}
          </button>
        </form>
      </div>
    </div>
  </template>
</template>
