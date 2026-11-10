# 邮件通道（厂家无关）

验证码发信不绑定任何邮箱厂商。后台「邮件通道」里可以并存多条通道，按 `优先级` 从小到大依次尝试，**前一条失败自动回退**，全部失败才报错。

## 1. 三种通道类型

| 类型 | 适用厂家 | 需要填什么 | 认证 |
|---|---|---|---|
| `smtp` | Gmail、QQ、163、阿里云、腾讯云、Zoho、Yandex、Mailgun、SendGrid-SMTP、自建 | host / port / SSL / 账号 / 密码或授权码 | `AUTH LOGIN`、`AUTH PLAIN`、`auto`（按服务器 EHLO 能力选）、`none` |
| `oauth2` | Outlook / Hotmail / Live、任何支持 XOAUTH2 的厂家 | tokenUrl / deviceUrl / clientId / clientSecret(可选) / scope | 设备码授权拿 refresh_token → 换 access_token → `AUTH XOAUTH2` |
| `http` | Resend、SendGrid、Mailgun API、自建发信服务 | url / method / headers(JSON) / body 模板 / apiKey | 模板里用 `{{apiKey}}` |

## 2. 内置预设（18 个）

| 预设 | 类型 | 关键参数 | 备注 |
|---|---|---|---|
| Gmail / Google Workspace | smtp | smtp.gmail.com:465 SSL | 需应用专用密码 |
| Outlook / Hotmail（OAuth2） | oauth2 | smtp-mail.outlook.com:587 STARTTLS | 微软只接受 OAuth2 或应用密码 |
| Outlook / Hotmail（应用专用密码） | smtp | 同上 | 在 account.live.com/proofs/AppPassword 生成 16 位密码 |
| QQ 邮箱 | smtp | smtp.qq.com:465 SSL | 用授权码 |
| 腾讯企业邮 | smtp | smtp.exmail.qq.com:465 | 密码或专用密码 |
| 网易 163 / 126 | smtp | smtp.163.com / smtp.126.com:465 | 用授权码 |
| 阿里云邮件推送 | smtp | smtpdm.aliyun.com:465 | 用户名=发信地址，需先验证域名 |
| 腾讯云 SES | smtp | smtp.qcloudmail.com:465 | 发信地址需验证 |
| Zoho / Yandex / mail.com | smtp | 各自 465 SSL | 应用专用密码 |
| SendGrid / Mailgun / Brevo（SMTP） | smtp | 587 STARTTLS | 用户名/密码按各家规则 |
| Resend / SendGrid（HTTP） | http | 官方 API + Bearer 头 | 模板已内置 |
| 自定义 SMTP / 自定义 HTTP | smtp / http | 空白模板 | 任意厂家 |

## 3. HTTP 模板占位符

```
{{apiKey}} {{from}} {{fromName}} {{to}} {{subject}} {{text}} {{html}} {{user}} {{timestamp}}
```

Body 会被识别为 JSON 时（以 `{` 或 `[` 开头），占位值按 **JSON 字符串转义** 注入，正文里的换行、引号不会破坏请求体。这是真实的坑：不转义时 `text` 带换行会导致对方 API 报 400。

## 4. 优先级与回退

- `优先级` 数字越小越先尝试；「置顶」按钮会把该通道设为 `当前最小值 - 10`
- 每条通道记录 `最近测试`（时间/成功与否/错误原文），失败信息会显示在列表里
- 全部通道停用或全部失败 = **验证码发不出去**：此时 `POST /api/auth/email/send` 返回 `503 mail_not_configured`（无通道）或 `502 mail_failed`（通道都失败了），**不会**降级成本地回显验证码。上线前必须在后台至少配置一条可用通道并用「测试」按钮验证通过。
- 唯一例外是本地自动化测试：`MH_OTP_TEST=1` 时跳过投递并把验证码放在响应的 `testCode` 字段。该变量只能在测试进程里设置，生产 `.env` 中没有它。

## 5. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/email-channels` | 通道列表 + 预设 + 默认发件人 + `mailMissing`（是否缺可用通道） |
| POST | `/admin/api/email-channels` | 新增/更新通道（`id` 存在则更新；口令/Key 留空表示不修改） |
| DELETE | `/admin/api/email-channels/:id` | 删除通道 |
| POST | `/admin/api/email-channels/:id/test` | 连接自检 + 发测试邮件（`{to}`） |
| POST | `/admin/api/email-channels/:id/oauth/start` | 申请设备码 |
| POST | `/admin/api/email-channels/:id/oauth/poll` | 轮询授权结果，成功即写入 refresh_token |
| PUT | `/admin/api/email-settings` | 保存默认发件邮箱与名称 |

权限：读取 `email.read`，改动 `email.write`。

## 6. 换厂家的操作步骤

1. 后台 → 系统管理 → 邮件设置
2. 顶部下拉选厂家预设 → 「新增通道」→ 表单已预填 host/端口/加密/认证方式
3. 填账号与凭据（密码/授权码/API Key/clientId）→ 保存
4. 点「测试」发一封到自己的邮箱，`最近测试` 显示「可用」即成功
5. 点「置顶」把它设为第一优先级，需要时把旧通道「停用」

全程不需要改代码、不需要重启（配置存数据库，读取即生效）。

## 7. 数据与安全

- 存储：`settings.email`（JSON），口令 / API Key / client_secret / refresh_token 全部 AES-256-GCM 加密（`v` 前缀密文），接口只返回 `passSet / keySet / refreshTokenSet` 布尔
- 审计：`audit_logs` 记录 `admin.email.channel.save / remove / test / oauth`
- 传输：SMTP 465 隐式 TLS 或 587 STARTTLS；`rejectUnauthorized` 在 STARTTLS 后按需保留（当前为兼容自签证书设为 false，接正式域名建议收紧）

