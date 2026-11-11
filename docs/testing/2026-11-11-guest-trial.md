# 游客 15 秒试看验证

日期：2026-11-11

## 自动化

```text
node --test test/guest-trial.test.mjs  # 2 passed
npm test                               # 147 passed, 0 failed
npm run check                          # frontend checks: 10 files clean
```

覆盖：

- 游客无 token 可通过 `?trial=1` 获取试看播放信息。
- 首次试看返回 15 秒，活跃期内重发返回剩余秒数。
- 到期后 24 小时内再次请求返回 403「试看已结束，请购买后观看」。
- 缺少 visitor 标识返回 400。

## 浏览器验证

环境：临时 SQLite DB + 合成 20 秒 HLS，Chrome 游客会话。

- 直达 `#/play/34/1?trial=1` 不再出现登录墙，播放器显示「Preview left: 00:15」。
- 15 秒后自动暂停并打开付费墙，展示 `Preview ended`、会员套餐和单片购买。
- 刷新后服务端返回 403「试看已结束，请购买后观看」，页面提供购买入口。
- 详情页选集和试看按钮对游客自动带 `?trial=1`；免费内容仍由服务端判定为完整播放。

## 边界

- 试看仍依赖短时签名 HLS + 前端截断；有能力的抓取者仍可能读取签名内剩余内容，需切片级 DRM 才能彻底解决。
- 多标签共享同一 visitor 额度，但 V1 没有逐分片计时；刷新后按服务端剩余时长继续。
- 游客支付、自动建号、claim token 和用户名登录尚未实现，见 `docs/requirements/GUEST-TRIAL-CHECKOUT.md`。
