# HK 生产发布记录（2026-11-11）

## 发布信息

- 环境：HK 生产（`hk.hsddns.com`，`/opt/video-rr`）
- 时间：2026-11-11 14:27 CST（前端资源修复于 14:38 完成）
- 发布包：`mh-deploy-20261111-143943.tgz`
- SHA256：`1ec036ff5284c45af4200afe450872748d6972dd8276e2f3f7a44ef0dfb87fb7`
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261111-1426.tar.gz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261111-142743`

## 发布内容

- Vue 3 + Rolldown-Vite 构建产物由 nginx 直接提供：
  - `/video/` → `/opt/video-rr/dist/client/`
  - `/video-admin/` → `/opt/video-rr/dist/admin/`
- 恢复旧修复：中英切换、英文移动底栏、头像即时刷新、后台用户序号列、推广海报二维码。
- 修复 320px 英文底栏截断：`≤399px` 规则提升为 `.sidebar .mobile-tabs .nav-item`，实际生效字号 11px。
- 部署脚本强制 `npm ci --include=dev` + `npm run build`，并在重启前校验两端 `dist/index.html`。

## 验收结果

- `video-rr`：`active`，`NRestarts=0`，启动时间 `2026-11-11 14:27:57 CST`。
- `/video/`、`/video-admin/`、`/video/api/constants`：200。
- 未签名 HLS：403。
- 线上 C 端加载 `assets/index-BeRoah07.js`、`assets/index-DyFXqfV_.css`，Vue 根节点正常挂载。
- 线上后台加载 `assets/index-g59Vi9tS.js`，用户管理表头为 `序号 / 账号 / 显示名 / 角色 / 状态 / 口令 / 最近操作 / 操作`。
- 线上 320×700 英文首页：`Home / Browse / Wall / Ranks / Me` 全部完整显示，无重叠、无截断，页面无横向溢出。
- 浏览器 Console：无业务 JS error；仅 Edge 扩展自身的 port 通信 warning。
- `journalctl -u video-rr` 最近 15 分钟：无 error / exception / failed。
- 本机 `npm run check`：通过；`npm test`：133 通过，0 失败。

## 回滚

1. 恢复发布前源码：

```bash
cd /opt/video-rr
tar -xzf storage/backup/source-20261111-1426.tar.gz
```

2. 恢复数据库（仅在确认数据回滚必要且已有窗口内备份时执行）：

```bash
systemctl stop video-rr
cp storage/backup/app.db.20261111-142743 storage/app.db
cp storage/backup/app.db.20261111-142743-wal storage/app.db-wal 2>/dev/null || true
systemctl start video-rr
```

3. 恢复旧 nginx 片段并 `nginx -t && systemctl reload nginx`。
4. 回滚后检查 `/video/`、`/video-admin/`、API 和播放鉴权。

## 备注

- 磁盘发布前使用率 93%，发布后为 75%，当前余量约 13G。
- 后续发布统一使用 `npm run pack:deploy`，不要使用 `mh-deploy-20261111-025142.tgz`。

---

## 16:04 补充发布（顶栏图标 / 推广海报间距）

### 发布信息

- 时间：2026-11-11 16:04 CST
- 发布包：`mh-deploy-20261111-160252.tgz`
- SHA256：`ae85a52912fcd4581a4e0b1ed9ed4806d037b327ec6f06cb5308bd5a29050038`
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261111-160305.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261111-160412`
- 上传包：`/tmp/mh-deploy-20261111-160252.tgz`，远端校验 SHA256 与本地一致。

### 变更

- 顶栏显式导入 `ElIcon` 与图标样式，修复 `<el-icon>` 未注册导致四个动作图标为 `0×0`。
- 推广海报邀请码按左侧 320px 上限自动缩放，避免邀请码文字进入二维码白底区域。
- 前端静态检查新增 Vue 模板与 Element Plus 组件导入一致性检查。

### 验收结果

- `video-rr`：`active`，`NRestarts=0`，启动时间 `2026-11-11 16:04:23 CST`。
- 线上 C 端加载 `assets/index-CPKj2way.js`、`assets/index-DMrGJMxx.css`，与本地构建 SHA256 一致；后台仍为 `assets/index-BenyTPCn.js`、`assets/index-DZ3capyf.css`。
- C 端、后台、公开常量接口：200；未签名 master/分片/源片：403；路径穿越：404。
- 匿名搜索 200；匿名个人中心/播放 401；手机号登录 410；匿名模拟支付 404。
- 线上浏览器实际打开首页：中文与英文顶栏 `History / Saved / Inbox / VIP` 四个图标均为 `16×16`，无横向溢出。
- `journalctl -u video-rr --since '10 min ago'`：error/exception/failed 计数为 0。
- 构建产物未发现未解析的 `el-icon` 引用；推广海报 720×1080 本地验证二维码可解码为推广链接。
- 后台登录态相关断言未执行：远端 `storage/admin-initial-passwords.txt` 仍是最初口令，当前 admin 口令已变更；本次未做任何后台写操作。

### 回滚

```bash
cd /opt/video-rr
tar -xzf storage/backup/source-20261111-160305.tgz
systemctl stop video-rr
cp storage/backup/app.db.20261111-160412 storage/app.db
cp storage/backup/app.db.20261111-160412-wal storage/app.db-wal 2>/dev/null || true
systemctl start video-rr
```

恢复后用 `READONLY=1 bash deploy/verify-hk.sh` 和线上首页/后台冒烟确认；仅前端回滚时无需恢复数据库。

---

## 23:23 成人菜单发布

### 发布信息

- Git 提交：`91146ea`（`codex/adult-menu`）
- 时间：2026-11-11 23:23 CST
- 发布包：`mh-deploy-20261111-232229.tgz`
- SHA256：`d926f3821ac82be2bd5adf55cdc6412625eb83454a5aa025b1b084d454be4a22`
- 远端上传：`/tmp/mh-deploy-20261111-232229.tgz`，SHA256 与本地一致。
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261111-232255.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261111-232331`

### 变更

- 新增成人内容标记、独立中英文菜单配置和会话年龄确认。
- 成人内容从普通首页、分类、搜索、榜单、海报墙、内容榜及相似推荐中排除。
- 新增 HTTP(S) 视频直链导入，带 SSRF、重定向、大小、总超时和视频探测校验。
- 同步当前 Vue 前端、内容运营、测试和发布脚本快照。

### 验收结果

- `video-rr`：`active/running`，`NRestarts=0`，启动时间 `2026-11-11 23:23:43 CST`。
- `/video/`、`/video-admin/`、`/video/api/constants`：200。
- 未签名 HLS：403。
- `/video/api/constants` 返回 `adultMenu={enabled:true,labels:{zh:"成人",en:"Adult"}}`。
- `/video/api/category?audience=adult`：业务码 `0000`，`active.audience=adult`。
- 数据库已迁移：`dramas.is_adult INTEGER NOT NULL DEFAULT 0`；`settings.adultMenu` 已写入默认配置。
- 线上 C 端资源为 `index-CkhkyYrj.js`、`index-BpzeNqdW.css`；后台资源为 `index-DQ-v1jXK.js`、`index-G7krLnQr.css`，与本地构建一致。
- `journalctl -u video-rr --since '10 min ago'`：未发现 error/exception/failed。
- 磁盘：`76%` 使用，剩余约 12G。

### 回滚

```bash
cd /opt/video-rr
tar -xzf storage/backup/source-20261111-232255.tgz
systemctl stop video-rr
cp storage/backup/app.db.20261111-232331 storage/app.db
cp storage/backup/app.db.20261111-232331-wal storage/app.db-wal 2>/dev/null || true
systemctl start video-rr
```

回滚后依次检查 `/video/`、`/video-admin/`、`/video/api/constants`、未签名 HLS 403 和日志。
