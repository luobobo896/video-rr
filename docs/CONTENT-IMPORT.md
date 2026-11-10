# 内容导入与片源运营

本项目的片源不再来自镜像站点，而是由 `data/catalog.json` 驱动、从公开授权渠道下载后本地转码成双码率 HLS。

## 1. 常用命令

```bash
cd /opt/video-rr

node scripts/import-catalog.mjs --list            # 看清单（剧名/分类/集数/授权）
node scripts/import-catalog.mjs --check           # 只做一致性自检，不写库
node scripts/import-catalog.mjs --reset           # 只清演示数据与媒体文件（保留管理员/套餐/支付/邮件设置）
node scripts/import-catalog.mjs --build           # 清空并重建全部内容（默认动作）
node scripts/import-catalog.mjs --build --only sintel,bbb   # 只重建指定剧
node scripts/rebind-tags.mjs                      # 按 catalog 合并回绑标签（不覆盖已有绑定）
```

`--build` 会先 `resetDemo()`：清 26 张业务表（含 users / orders / play_events / track_events / sessions）、重置自增序列、清空 `storage/hls`、`storage/uploads`、`storage/images`。**这是破坏性操作**，线上执行前先跑一次 `deploy/install-hk.sh`（内含数据库备份到 `storage/backup/`）。

## 2. 片源与授权

`data/catalog.json` 里每部剧都带 `source.url / license / credit`，全部为 CC 或公有领域作品：

| slug | 作品 | 分类 | 集数 | 授权 |
|---|---|---|---|---|
| sintel | 辛特尔 | TV | 10 | CC BY 3.0（Blender Foundation） |
| tos | 钢铁之泪 | MOVIE | 1 | CC BY 3.0（Blender Foundation） |
| ed | 大象之梦 | MOVIE | 1 | CC BY 2.5（Blender Foundation） |
| bbb | 大雄兔 | TV | 7 | CC BY 3.0（Blender Foundation） |
| cosmos | 宇宙洗衣房 | PLAYLET | 8 | CC BY 4.0（Blender Animation Studio） |
| caminandes | 羊驼历险记 | PLAYLET | 2 | CC BY 4.0（Blender Animation Studio） |
| coffee | 咖啡跑 | PLAYLET | 3 | CC BY 4.0（Blender Animation Studio） |

CC BY 要求保留署名：C 端详情页与后台剧集编辑页都有 `credit` 字段展示位。**商用前请确认署名可见**，或换成自有版权内容后把 `source` 字段清空。

## 3. 流水线做了什么

1. **下载**：流式写入 `storage/sources/<slug>.<ext>`（`Readable.fromWeb` + `pipeline`，15 分钟超时；超过 1MB 的已存在文件直接复用）。
2. **探测**：`ffprobe` 取 `duration / width / height`。
3. **封面/横幅**：抽 12% 处画面裁 480×720 存 `storage/images/cover-<slug>.jpg`；22% 处裁 1600×900 存 `banner-<slug>.jpg`。
4. **切片**：按 `episodeCount` 均分整片，每集用输入侧 `-ss/-t` 精确 seek，避免重编码错位。
5. **转码**：每集两份（720p 与 480p，源高不足时降级为 480p + 360p），HLS 4 秒切片 + `independent_segments`，写 `storage/hls/<episodeId>/{index.m3u8,720p/,480p/}`。
6. **落库**：剧集先 `status='pending'`，转码成功才 `ready` 并写 `hls_path=/media/hls/<id>/index.m3u8`、`duration`（**秒，REAL**）。
7. **标签/分区/榜单**：catalog 的 `tags` 建 `tags` + `drama_tags`；`sections` / `ranks` 建首页楼层与榜单。

## 4. 导入后的验收

```bash
node scripts/import-catalog.mjs --check      # 期望：自检通过，playable 等于 episodes 总数
bash deploy/verify-hk.sh                     # 后台/权限/风控/签名/支付全链路
bash deploy/verify-play.sh                   # 真实播放链路：master → 子播放列表 → 分片
```

`verify-play.sh` 会自己找一部有片源的剧，走「登录 → 取签名 → 带 Cookie 请求 master/子列表/分片」，并验证无 Cookie、换 UA、源片路径都被拒。

## 5. 磁盘与带宽预算

- 源片：约 410MB（保留下次重切用，可删）
- HLS：约为源片时长的 0.18MB/s，7 部合计约 700MB–1GB
- 播放带宽：单机出口实测约 19Mbps → 480p 约 22 人、720p 约 8 人同时观看。要上千人必须上对象存储 + CDN（见 `docs/POSTGRES-ASSESSMENT.md` 的同类结论）。

## 6. 换成自有片源

1. 把文件放到 `storage/uploads/`（或直接在后台「剧集管理」按集上传）。
2. 在 `data/catalog.json` 复制一条记录，改 `slug / title / category / episodeCount / access / tags`，`source.url` 填 `file://storage/uploads/<name>.mp4` 或留空并手工建集。
3. `node scripts/import-catalog.mjs --build --only <slug>`。

后台单集上传接口仍然可用（`POST /admin/api/episodes/:id/upload`），适合零散补片；批量导入走 catalog 更快。
