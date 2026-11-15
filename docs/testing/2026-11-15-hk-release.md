# HK 首页轮播修复发布（2026-11-15）

## 发布信息

- Git 提交：`a7b7c54`（`main`）
- 时间：2026-11-15 22:12 CST
- 发布包：`mh-deploy-20261115-215158.tgz`
- SHA256：`13971fac34701833c483388ea9aaf81225f54606bd77744f63147adf61ccc189`
- 远端上传：`/tmp/mh-deploy-20261115-215158.tgz`，SHA256 与本地一致。
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261115-220848.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261115-220848`；安装脚本另备份 `app.db.20261115-221237`。

## 变更

- 移除首页 Hero 上一张箭头的额外 180° 旋转，修复两个箭头都指向右侧。
- 用户点击“继续轮播”时清除 hover/focus 临时暂停，修复按钮恢复为暂停态但轮播计时器未重新启动。

## 验收结果

- `video-rr`：`active`，`NRestarts=0`，启动时间 `2026-11-15 22:12:48 CST`。
- `/video/`、`/video-admin/`、`/video/api/constants`：200；未签名 HLS：403。
- 线上 C 端资源：`index-BB7nGEN9.js`、`index-CGfCXGVP.css`，与本地构建一致。
- 线上浏览器 1440px：上一张/下一张切换正常；暂停后点击继续，7 秒内自动切到下一张。
- `journalctl -u video-rr --since '15 min ago' -p err`：无记录。
- 磁盘：77% 使用，剩余约 12G。

## 回滚

```bash
cd /opt/video-rr
systemctl stop video-rr
tar -xzf storage/backup/source-20261115-220848.tgz
cp storage/backup/app.db.20261115-220848 storage/app.db
cp storage/backup/app.db.20261115-220848-wal storage/app.db-wal 2>/dev/null || true
systemctl start video-rr
```

回滚后检查 `/video/`、`/video-admin/`、`/video/api/constants` 与未签名 HLS 403。
