# 开放影像海报墙

## 目标

为影巢补充一个可直接访问的海报墙页面，使用公有领域与 Creative Commons 开放许可影片素材，提升内容页的视觉陈列，同时保留授权和来源信息。

入口：`/video/#/posters`

旧地址 `/video/posters.html` 保留重定向，不再承载独立页面。

接口：`GET /video/api/poster-wall`

## 数据口径

- 只展示 `dramas.status = 'published'` 且有本地封面的作品。
- 作品必须能在 `data/catalog.json` 中匹配到来源与许可。
- 许可含 `ND` / `NoDerivatives` 的作品不生成派生海报。
- 公有领域条目标注为「公有领域」；CC BY 条目标注具体版本并链接到 Creative Commons 许可页。
- `Coffee Run` 采用 Blender Studio 官方许可页：<https://studio.blender.org/projects/coffee-run/pages/licensing/>，许可为 CC BY 4.0。
- 页面中的海报是站内根据已有封面/横幅裁切生成的陈列图，不是官方发行海报。

## 画幅与页面规则

| Key | 尺寸 | 比例 | 源素材 |
|---|---:|---|---|
| `portrait` | 360×540 | 2:3 | `cover-<slug>.jpg` |
| `square` | 480×480 | 1:1 | `cover-<slug>.jpg` |
| `wide` | 960×540 | 16:9 | `banner-<slug>.jpg`，缺失时回退封面 |

主海报墙只使用统一的 `portrait` 2:3 画幅，按 6/5/4/3/2 列响应式密铺；`square` 与 `wide` 保留给站内其他素材位，不混排进主墙。

页面作为主站 SPA 内部视图，复用桌面侧栏、移动底栏和站点导航；面向观众展示海报、类型筛选和播放入口，不展示素材派生、图床等技术说明。授权与署名收进页脚「内容来源」弹层。

输出文件名固定为 `storage/images/poster-<slug>-<key>.jpg`，由现有 `/media/images/` 路由直接提供，不新增 nginx 规则。

## 磁盘保护

生成脚本不下载视频、不读取视频源、不重跑 HLS 转码，只处理 `storage/images/` 中已有的封面/横幅。

```bash
node scripts/build-poster-wall.mjs          # 只补齐缺失图
node scripts/build-poster-wall.mjs --force  # 重生成
node scripts/build-poster-wall.mjs --check  # 只检查，不写文件
```

保护条件：

- 默认至少保留 1024 MB 磁盘余量（`MH_POSTER_RESERVE_MB`）。
- 单次最多写入 32 MB（`MH_POSTER_MAX_MB`）。
- 先写临时目录，体积或磁盘余量不满足时整体放弃。
- 已存在文件默认跳过，重复执行不增加占用。

按当前 19 部片、每部 3 张估算，产物通常在数 MB 范围；实际体积以 `--check` 输出为准。

## 部署

上传新增页面、服务模块和生成脚本后：

```bash
cd /opt/video-rr
node scripts/build-poster-wall.mjs
systemctl restart video-rr
curl -fsS https://hk.hsddns.com/video/api/poster-wall | head -c 200
```

`deploy/install-hk.sh` 也会在海报墙脚本存在时尝试补齐，失败不阻断主站启动。
