# HK 埋点四区间统计 + 投诉反馈闭环发布（2026-11-17）

## 发布信息

- Git 提交：`3f0c12b`（`main`）
- 时间：2026-11-17 08:43 CST
- 发布包：`mh-deploy-20261117-084209.tgz`
- SHA256：`f7d9c51674af061fa553ba737ce55effa8cd89c756f0de3568822b45988f8721`
- 远端上传：`/tmp/mh-deploy-20261117-084209.tgz`，SHA256 与本地一致。
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261117-084306.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261117-084316`

## 变更

- 埋点统计支持今天/昨天/近 7 天/近 30 天四个北京时区日历窗口，新增 `/admin/api/events/stats?range=`；访客去重改为 `user_id → visitor_id → IP`，登录用户换设备、换 IP 不重复计数。
- 新增投诉反馈域：`feedbacks` 表 + `server/feedback.mjs`；C 端 `/#/feedback` 提交与「我的反馈」，B 端「投诉反馈」页支持回复、状态流转与发起退款；退款复用 `commerce.createRefund`，仍需财务二次复核。
- 权限新增 `cs.feedback`、`cs.feedback.read`、`cs.feedback.write`、`cs.feedback.refund`，客服角色默认只拿前三个。

## 发布前磁盘处理

`/` 使用率 94%（可用 3.1G），先清理 `/tmp/mh-jable-*` 残留导入目录与 `/tmp/mh-deploy-*.tgz` 历史包、`storage/backup` 超期源码包后部署，发布后可用 3.5G。

## 验收结果

- `video-rr`：`active`，`NRestarts=0`，启动时间 `2026-11-17 08:43:28 CST`。
- `/video/`、`/video-admin/`：200；`/video-admin/api/feedbacks/stats?range=today`、`/video-admin/api/events/stats?range=30d` 未带登录态返回 401（路由已生效），`/video/api/feedback/meta` 返回 7 个分类。
- 线上 C 端资源：`index-B1gwwAs2.js`；后台：`index-CaD7pamx.js`，与本地构建一致。
- 生产库自检：`feedbacks` 表与 5 个索引存在，`permissions` 有 4 个 `cs.feedback*`，`admin_menus` 有 `/feedbacks`，`cs` 角色拿到 `cs.feedback`、`cs.feedback.read`、`cs.feedback.write`。
- 四区间实测（生产库）：今天事件 81 / 访客 77；昨天 301 / 42；近 7 天 1999 / 127；近 30 天 2243 / 131。
- 端到端：`POST /video/api/feedback` 返回 `FB20261117-0001`（pending），验证后已删除该自检工单，`feedbacks` 计数归 0。
- `journalctl -u video-rr --since '6 min ago' -p err`：无记录。

## 回滚

```bash
cd /opt/video-rr
systemctl stop video-rr
tar -xzf storage/backup/source-20261117-084306.tgz
cp storage/backup/app.db.20261117-084316 storage/app.db
cp storage/backup/app.db.20261117-084316-wal storage/app.db-wal 2>/dev/null || true
systemctl start video-rr
```

回滚后检查 `/video/`、`/video-admin/`、`/video/api/feedback/meta`（旧版本应为 404）与未签名 HLS 403。
