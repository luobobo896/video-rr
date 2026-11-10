# 影巢（mh-clone）· 视频站全栈复刻

对标 `https://mh.yichengwlkj.com/pc` 的功能级复刻，**C 端 + 运营后台 + 视频转码 + 直播推流**一整条链，零外部依赖（Node 内置 `http`/`sqlite`/`crypto`，ffmpeg 只做转码）。

```
C 端  public/            /api/*             ← 首页/分类/榜单/搜索/详情/播放/我的/直播
后台  admin/             /admin/api/*       ← 剧集/分集/上传/转码/运营/榜单/审核/订单/直播
媒体  上传 → ffmpeg → HLS 720p → /media/hls/<episodeId>/index.m3u8
直播  OBS/ffmpeg --rtmp--> MediaMTX:1935 --> HLS:8888 --> /live/<key>/index.m3u8（本站反代）
数据  storage/app.db (SQLite)
```

## 启动

```bash
cd mh-clone
node server/index.mjs          # 或 npm start
```

| 入口 | 地址 | 账号 |
|---|---|---|
| C 端 | <http://127.0.0.1:8787/> | 手机号直接登录（演示，任意 `1xxxxxxxxxx`） |
| 后台 | <http://127.0.0.1:8787/admin> | `admin` / `admin123` |
| 数据库 | `storage/app.db` | `npm run reset-db` 可清库重建 |

首次启动会用 `data/seed.json`（抓包归一）建库：33 部剧 / 198 集 / 4 个首页楼层 / 4 个榜单。

## 已实现

### C 端
- 首页：Banner + 多楼层海报流 +「换一换」；左侧频道导航；顶部搜索
- 分类 / 榜单（容器 + 名次）/ 搜索（含热搜词与空态）
- 详情：评分/年份/地区/演员位/简介/选集（VIP 标记）
- 播放：**真实 HLS 播放**（hls.js），VIP 集需登录；播放进度写历史
- 我的：登录后同步观看历史 / 收藏；直播页播放 HLS 直播流
- 右下 VIP 订阅卡、登录弹窗

### 运营后台
- 概览：剧集/分集/就绪数、转码队列、待审数量、用户与收入、直播状态
- 剧集管理：增删改查、封面/简介/收费/上下架
- 分集与视频：新增分集、**上传视频自动转码**、生成示例视频、进度条、失败原因、删除
- 首页运营：Banner 增删/启停、楼层增删、往楼层挂剧集
- 榜单：榜单增删、按名次加条目
- 内容审核：弹幕/评论 通过/驳回
- 用户与订单：用户列表（VIP 状态）、新建订单、标记已支付（自动开通 VIP）
- 直播推流：一键启停 MediaMTX、频道增删、复制推流地址、RTMP/HLS 地址展示

### 视频链路
- 上传：`POST /admin/api/episodes/:id/upload`（原始二进制，流式落盘）
- 探测：`ffprobe` 取时长/分辨率 → 写库
- 转码：`ffmpeg` → H.264 720p + AAC，4 秒切片，`-progress pipe:1` 进度回写数据库
- 播放：`/media/hls/<id>/index.m3u8`，静态服务带 **Range** 支持
- 直播：MediaMTX（`storage/tools/mediamtx.exe`）RTMP 入流、HLS 出流，本站 `/live/*` 反代

## 实测记录（本机）

| 项目 | 结果 |
|---|---|
| 示例视频转码 | 20s 源 → `index.m3u8` + 5 个 `.ts`（约 7.6 MB），进度 0→100，耗时 ~15s |
| 播放 | C 端播放页出画面（hls.js + `<video>`，时间码在走） |
| 直播 | `ffmpeg -re -f lavfi ... -f flv rtmp://127.0.0.1:1935/live/demo` 推流 → `/live/demo/index.m3u8` HTTP 200 → C 端直播页出画面 |
| 后台 | 登录 → 概览/剧集/分集/直播页均正常，队列与状态实时刷新 |

## 目录

```
mh-clone/
  server/
    index.mjs        入口：静态 + 路由 + 上传流 + 媒体 Range + 直播反代
    db.mjs           SQLite 建表与种子
    auth.mjs         scrypt 口令 + HMAC token
    media.mjs        ffprobe / ffmpeg HLS 转码队列
    live.mjs         MediaMTX 托管与状态
    api-public.mjs   C 端接口
    api-admin.mjs    后台接口
  public/            C 端 SPA
  admin/             后台 SPA
  data/seed.json     抓包归一的种子数据
  storage/           app.db / uploads / hls / tools(mediamtx)
  docs/API-ADMIN.md  后台接口清单
  docs/LIVE.md       直播部署与推流说明
```

## 线上部署（HK 已上线）

| 入口 | 地址 |
|---|---|
| C 端 | **https://hk.hsddns.com/video/** |
| 后台 | **https://hk.hsddns.com/video-admin/**（`admin` / `admin123`，**上线后请立刻改密码**） |
| 代码 | https://github.com/luobobo896/video-rr |

服务器：Debian 13 / 8 核 / 7.8G 内存 / Node v24.21 / nginx 1.26 / ffmpeg 7.1。部署方式：

```bash
git clone https://github.com/luobobo896/video-rr.git /opt/video-rr
cd /opt/video-rr && bash deploy/install-hk.sh      # 幂等：服务 + MediaMTX + nginx 子路径 + 并发参数
bash deploy/verify-hk.sh                            # 验证：子路径、登录、转码、HLS 可达
node deploy/loadtest.mjs --url https://127.0.0.1/video/media/hls/1/index.m3u8 \
  --host hk.hsddns.com --insecure --concurrent 1000 --seconds 20
```

nginx 侧：`/video/` 静态 + `/video/api/` 反代 Node + `/video/media/hls/` 直接吐切片（sendfile/aio）+ `/video/live/` 反代 MediaMTX；后台同套规则。`worker_connections` 由 768 提到 65535，`worker_rlimit_nofile 100000`（脚本自动改，带备份）。

**实测 1000 并发**（服务器本机 loopback，480p 切片）：8318 请求 / 0 错误 / 峰值并发 1000 / **845.7 Mbps** / p50 1.24s、p95 6.94s。
注意：客户端进程默认 `ulimit -n 1024` 会先把自己卡死（表现为大量 error），压测前 `ulimit -n 65535`。

素材：原站 CDN（`img.bwcgee.cn`）对 HK 服务器返回 403，且 HTTPS 页面不能加载 http 图片，所以封面/横幅已**镜像到本地** `storage/images/`（`scripts/mirror-images.mjs` + `scripts/rewrite-cover-urls.mjs`），线上走 `/video/media/images/`。缺封面的剧集自动用 `/media/placeholder.svg?t=剧名` 生成占位图。

## 上生产还缺什么

1. **多码率**：现在单档 720p；要 1080p/480p 就用同一份源跑三档 + 生成 master playlist（HLS `EXT-X-STREAM-INF`）。
2. **鉴权防盗链**：HLS 用短期签名 URL / token 或 AES-128 密钥轮换；VIP 集做服务端解密校验。
3. **CDN**：切片上对象存储 + CDN，回源鉴权；本地 `/media` 只用于开发。
4. **队列**：把 `media.mjs` 的串行队列换成 Redis/BullMQ + 多 worker，支持并发、重试、优先级。
5. **直播**：MediaMTX 用 NSSM/Windows 服务或 systemd 托管；加推流鉴权（`authHTTPAddress`）、录制、转推、低延迟 WebRTC。
6. **账号体系**：短信验证码、刷新 token、设备管理、风控。
7. **支付**：接真实渠道（微信/支付宝），订单状态机 + 回调验签 + 对账。
8. **弹幕**：WebSocket 实时下发 + 分片存储；现在是 HTTP 拉取审核通过的弹幕。
9. **可观测性**：结构化日志、指标、转码失败告警。

## 与原始抓包的关系

接口形状、字段命名、页面结构来自对原站公开页面的分析（见 `API.md`）；品牌已替换为「影巢」，封面仍指向原站 CDN —— **正式上线必须换成自有或已授权素材**。
