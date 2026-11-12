# 双端视觉改版 HK 审核发布（2026-11-12）

> 后续变更：改版已并入 `/video/` 主站，`/video-redesign/` 入口与
> `web-redesign/` 源码目录已移除；本文保留为历史发布记录。
> 后台只读限制已被 `docs/testing/2026-11-12-admin-function-restore.md` 取代。

## 发布信息

- 环境：HK 生产（`hk.hsddns.com`，`/opt/video-rr`）
- 时间：2026-11-12 13:35 CST
- Git 提交：`5e5ed78`
- 发布包：`mh-deploy-20261112-133401.tgz`
- SHA256：`35ea5ca3e2609bbc528f049747751b836e668994d226c370aa537ce92eb9d39b`
- 远端上传：`/tmp/mh-deploy-20261112-133401.tgz`，校验一致，验收后已删除。
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261112-133445.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261112-133455`
- 审核入口：<https://hk.hsddns.com/video-redesign/>
- 审核后台：<https://hk.hsddns.com/video-redesign/#/admin/login>

## 变更

- 新增独立 Vue 改版审核入口 `/video-redesign/`，现有 `/video/` 与
  `/video-admin/` 保持原实现。
- C 端接入真实登录、首页、分类、搜索、榜单、详情、HLS 播放、收藏、历史、
  套餐下单和分销接口。
- 改版后台接入真实管理员登录、RBAC 数据、成人菜单、审核、订单、退款、
  用户、审计、支付与邮件读取。
- 后台改版当前以读取和关键审核动作为主；复杂内容 CRUD 保留「完整后台」
  入口。
- 修复游客播放免费集时使用空用户 ID 查询观看进度的 500 错误，并补回归测试。
- 部署脚本、发布包和 nginx 片段已包含改版产物与审核子路径。

## 代码审核结论

### Standards

- 未发现会阻断发布的正确性问题。
- 改版仍保留 Open Design 的主题令牌、少量模板内联样式和独立请求层，
  与旧前端存在并行实现；这是本次视觉替换的明确取舍，后续应合并到
  `shared/tokens.css` 与单一请求层。
- 新增页面注册分散在 `App.vue` 的页面表和标题表，后续可抽成统一路由表。

### Spec

- 已修复审核发现的成人菜单开关失效、服务端 Banner 未渲染、游客心跳缺失
  和发布链路缺失。
- 后台复杂编辑仍为只读并跳转现有完整后台，属于本次审核版的已知范围限制。

## 验收结果

- `video-rr`：`active/running`，`NRestarts=0`，启动时间 `2026-11-12 13:35:12 CST`。
- `/video/`、`/video-admin/`、`/video-redesign/`、`/video/api/constants`：200。
- 未签名 HLS：403。
- 审核首页加载真实片库数据，`window.__MH_BASE=/video`。
- 游客播放真实免费集：HLS `readyState=4`，时长 `88.79s`，无播放错误。
- 改版后台登录页可正常渲染。
- 375px 移动端：无横向溢出，侧栏隐藏，底部导航显示。
- 本机 `npm test`：154/154 通过。
- 本机 `npm run build:redesign`：通过。
- `journalctl -u video-rr --since '10 min ago'`：无 error/exception/failed。
- 磁盘：76% 使用，剩余约 12G。

## 回滚

```bash
cd /opt/video-rr
systemctl stop video-rr
tar -xzf storage/backup/source-20261112-133445.tgz
cp storage/backup/app.db.20261112-133455 storage/app.db
cp storage/backup/app.db.20261112-133455-wal storage/app.db-wal 2>/dev/null || true
systemctl start video-rr
nginx -t && systemctl reload nginx
```

回滚后检查 `/video/`、`/video-admin/`、`/video/api/constants`、未签名 HLS 403
和服务日志。

## 14:02 审核反馈修复

- Git 提交：`a1a6fc7 fix: 移除C端运营入口并恢复中英文切换`
- 发布包：`mh-deploy-20261112-140142.tgz`
- SHA256：`fa9fdd34eb71df67d405ccea3d7dba89ad050382aa34129d9e0d37a6dc2bc0cd`
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261112-140209.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261112-140219`

修复内容：

- 移除 C 端侧栏和顶栏的运营后台入口。
- 恢复中英文切换，复用 `public/i18n.js`；切换后重新拉取服务端语言数据。
- 会员页恢复月卡 / 季卡 / 年卡三档并排展示，侧栏套餐入口改为多档文案。
- 补齐改版页面的英文导航、套餐、空态和关键按钮文案。

验收结果：

- 英文模式：`Featured / Library / Adult / Rankings / Collections / Poster Wall`
  等导航正常；会员页显示 3 档套餐和英文价格单位。
- 中文模式：导航与会员页正常，C 端无运营入口。
- `/video-redesign/`、`/video/`、`/video-admin/`、`/video/api/constants`：200。
- 未签名 HLS：403。
- `video-rr`：`active/running`，`NRestarts=0`，启动时间 `2026-11-12 14:02:33 CST`。
- 最近 10 分钟日志：error/exception/failed 计数 0。
- `npm run check`：通过。
- `npm test`：154/154 通过。
