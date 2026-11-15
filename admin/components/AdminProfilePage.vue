<script setup>
const props = defineProps({
  me: { type: Object, default: () => ({}) },
  onChangePassword: { type: Function, required: true },
})
</script>

<template>
  <div class="profile-layout">
    <section class="panel">
      <h3>账号信息</h3>
      <dl class="profile-facts">
        <div><dt>登录账号</dt><dd class="mono">{{ me.admin?.username ?? '—' }}</dd></div>
        <div><dt>显示名</dt><dd>{{ me.admin?.displayName || '未设置' }}</dd></div>
        <div>
          <dt>角色</dt>
          <dd>
            <span v-for="role in me.roles ?? []" :key="role.code" class="pill">{{ role.name }}</span>
            <span v-if="!me.roles?.length" class="muted">未分配角色</span>
          </dd>
        </div>
        <div><dt>权限点</dt><dd>{{ me.permissions?.length ?? 0 }} 个</dd></div>
      </dl>
    </section>

    <section class="panel">
      <h3>安全设置</h3>
      <p>管理后台使用强口令，改密后会吊销其他设备上的会话。敏感操作仍由服务端逐次校验权限。</p>
      <div class="form-row">
        <button class="btn primary" type="button" @click="onChangePassword">修改密码</button>
        <a class="btn" href="#/audit">查看审计日志</a>
      </div>
    </section>
  </div>
</template>
