<script setup>
import { ElButton, ElForm, ElFormItem } from 'element-plus'
import 'element-plus/es/components/button/style/css'
import 'element-plus/es/components/form/style/css'
</script>

<template>
  <div id="login" class="login admin-login">
    <aside class="login-aside" aria-hidden="true">
      <div class="login-brand">
        <span class="brand-mark">影</span>
        <span class="brand-name">影巢运营<span class="brand-sub">OPS CONSOLE</span></span>
      </div>
      <div class="login-aside-copy">
        <span class="login-eyebrow">CONTENT · COMMERCE · GROWTH</span>
        <h1>让内容、交易与增长<br />汇聚同一张运营台。</h1>
        <p>从片库到订阅，从渠道归因到退款复核，把每天需要判断的事情放在同一处。</p>
      </div>
      <ul class="login-points">
        <li><span class="login-point-mark"></span>完整经营分析与埋点数据</li>
        <li><span class="login-point-mark"></span>内容、订单、渠道与用户统一管理</li>
        <li><span class="login-point-mark"></span>服务端 RBAC 权限与操作审计</li>
      </ul>
    </aside>

    <div class="login-form-wrap">
      <el-form id="login-form" class="login-card login-form" label-position="top" @submit.prevent>
        <div class="login-form-head">
          <span class="login-eyebrow">影巢运营后台</span>
          <h2>登录运营后台</h2>
          <p>使用后台管理员账号继续。</p>
        </div>
        <el-form-item label="账号">
          <input id="login-user" autocomplete="username" placeholder="请输入账号" />
        </el-form-item>
        <el-form-item label="密码">
          <input id="login-pass" type="password" autocomplete="current-password" placeholder="请输入密码" />
        </el-form-item>
        <el-button class="login-submit" type="primary" native-type="submit">登录</el-button>
        <div class="login-tip" id="login-tip" role="status" aria-live="polite"></div>
        <p class="login-footnote">菜单可见性不等于接口授权，所有敏感操作均由服务端校验。</p>
      </el-form>

      <el-form id="pass-form" class="login-card login-form hidden" label-position="top" @submit.prevent>
        <div class="login-form-head">
          <span class="login-eyebrow">SECURITY CHECK</span>
          <h2>设置新密码</h2>
          <p>后台强制使用强口令（≥8 位，含字母与数字，不含用户名）。</p>
        </div>
        <el-form-item label="当前密码">
          <input id="pass-old" type="password" autocomplete="current-password" />
        </el-form-item>
        <el-form-item label="新密码">
          <input id="pass-new" type="password" autocomplete="new-password" />
        </el-form-item>
        <el-form-item label="确认新密码">
          <input id="pass-confirm" type="password" autocomplete="new-password" />
        </el-form-item>
        <el-button class="login-submit" type="primary" native-type="submit">保存并进入后台</el-button>
        <div class="login-tip" id="pass-tip" role="status" aria-live="polite"></div>
      </el-form>
    </div>
  </div>
</template>
