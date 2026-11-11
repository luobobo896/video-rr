# 后台日志规范

服务日志使用单行 JSON，字段固定为 `ts`、`level`、`event`、`pid` 和事件上下文。

## HTTP

每个 API 请求记录 `requestId/method/path/status/durationMs/ip/userAgent`。`/api/*` 与 `/admin/api/*` 全量记录；状态 ≥500 或耗时 ≥`MH_SLOW_MS`（默认 800ms）记 `warn`。响应体 `requestId` 与日志一致，可直接串联。

## 邮件

- `mail.send.success`：通道、耗时、脱敏收件人。
- `mail.channel.fail`：逐通道失败原因和错误栈。
- `mail.send.failed`：全部通道失败汇总。
- `otp.mail.sent/failed`：验证码用途、耗时和失败类型（如 `smtp_auth_failed`）。

密码、Token、Cookie、SMTP 密码与 API Key 一律输出 `[REDACTED]`；邮箱只保留前两位和域名。

## 刮削

- `scraper.tmdb.match/no_match`
- `scraper.wikipedia.match/no_match`
- `artwork.drama` / `artwork.drama.failed`
- `artwork.batch`

这些事件足以判断失败发生在匹配、图片下载、转码还是回写阶段。
