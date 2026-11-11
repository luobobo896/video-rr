<script setup>
import { ElButton, ElForm, ElFormItem, ElInput } from 'element-plus'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/form/style/css'
import 'element-plus/es/components/input/style/css'
</script>

<template>
  <div id="login" class="login">
    <el-form id="login-form" class="login-card" label-position="top" @submit.prevent>
      <h1>影巢 · 运营后台</h1>
      <p>内容 / 订阅 / 订单 / 运营 / 风控</p>
      <el-form-item label="账号">
        <el-input id="login-user" autocomplete="username" placeholder="账号" />
      </el-form-item>
      <el-form-item label="密码">
        <el-input id="login-pass" type="password" autocomplete="current-password" placeholder="请输入密码" show-password />
      </el-form-item>
      <el-button class="login-submit" type="primary" native-type="submit">登录</el-button>
      <div class="login-tip" id="login-tip" role="status" aria-live="polite"></div>
    </el-form>

    <el-form id="pass-form" class="login-card hidden" label-position="top" @submit.prevent>
      <h1>设置新密码</h1>
      <p>后台强制使用强口令（≥8 位，含字母与数字，不含用户名）</p>
      <el-form-item label="当前密码">
        <el-input id="pass-old" type="password" autocomplete="current-password" />
      </el-form-item>
      <el-form-item label="新密码">
        <el-input id="pass-new" type="password" autocomplete="new-password" />
      </el-form-item>
      <el-form-item label="确认新密码">
        <el-input id="pass-confirm" type="password" autocomplete="new-password" />
      </el-form-item>
      <el-button class="login-submit" type="primary" native-type="submit">保存并进入后台</el-button>
      <div class="login-tip" id="pass-tip" role="status" aria-live="polite"></div>
    </el-form>
  </div>
</template>
