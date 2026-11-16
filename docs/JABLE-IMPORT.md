# Jable 片源与贴图导入

把 jable.tv 的**直链 m3u8**（不是播放页 HTML）和封面/预览贴图抓进站内成人片库，
播放时由 `/media/remote/<episodeId>/` 转码代理，前端只看到本站地址。

## 为什么必须用浏览器

jable.tv 全站在 Cloudflare managed challenge 后面：

| 方式 | 结果 |
| --- | --- |
| `curl` / `Invoke-WebRequest` | 403，返回 `Just a moment...` |
| `r.jina.ai` 文本代理 | 403 |
| 无头 headless Edge | 挑战不通过 |
| **本机 Edge + CDP** | 通过，t+3s 放行，t+9s DOM 稳定 |

`scripts/jable-import.mjs` 因此启动一个真实 Edge（`--remote-debugging-port`），
`Page.navigate` 后用 `Runtime.evaluate` 取 `document.documentElement.outerHTML`，
解析全部在 `server/jable.mjs` 里做纯函数处理。

## 直链是"有保鲜期的凭证"

页面里内联着播放地址：

```js
var hlsUrl = 'https://<子域>.mushroomtrack.com/hls/<TOKEN>/<EXP>/<a>/<b>/<b>.m3u8'
var vttUrl = '.../thumbvtt.ts'; var hasVtt = 1
```

`<EXP>` 是 unix 秒（如 `1794769762`），参与签名。实测：

- 有效期约 **3 小时**；
- 把 EXP 改成当前时间或 +1 天，上游一律 **403**（响应体 552 字节）。

所以库里存的 `episodes.remote_url` 是**快照**，不是永久地址。
过期后靠 `--refresh` 重新解析页面换新链接。

## 为什么不能「同步他的算法」

想本地算出 `hlsUrl` 彻底绕开浏览器，是不成立的。三条实测证据：

1. **页面上没有生成代码。** `var hlsUrl = '...'` 是后端渲染进 HTML 的静态字符串，
   同一段脚本里只有 `hls.loadSource(hlsUrl)`。页面加载的 502KB `js` bundle 里，
   `m3u8` / `mushroomtrack` / `hlsUrl` / `/hls/` 的命中数全是 **0**。
2. **token 是带密钥的摘要。** `Y1oH4Dp1lgD3_jhQN07KwA` 是 base64url 编码的 16 字节
   （`635a07e03a759600f7fe3850374ecac0`，正好是 MD5 长度）。用 videoId / contentsId / exp /
   路径拼了 42 种无盐组合 × md5·sha1·sha256 × 4 种编码，命中 **0**。
   摘要里有服务端私钥，不是纯哈希。
3. **签名覆盖 exp。** 把 `1794769762` 改成当前时间或 +1 天，上游一律 403（响应体 552 字节），
   旧 token 续不了期。

`cf_clearance` 这条路同样堵死：过挑战后浏览器里只有 `PHPSESSID` / `kt_ips`，
没有 `cf_clearance`；把这两个 cookie 连同 Edge UA 交给 curl，仍然 403（5713 字节挑战页）。
判定发生在 TLS / JS 指纹层，不在 cookie。

所以链接只能由 jable 服务端签发。自动化要落在「浏览器解析 + 高频刷新」上 —— 而这条路很快。

## 刷新有多快（实测）

常驻一个 Edge 实例、连续导航 6 个影片页：

```
Edge 就绪                0.5s
第 1 页                  2.3s
第 2–6 页                各 0.7s（CF 放行后同会话直接过）
合计                     7.9s，成功 6/6
```

13 部全量刷新约 10 秒，几百部也就几分钟。贴图已存在则跳过，不重复下载。

长跑用守护模式：

```bash
node scripts/jable-import.mjs --refresh --every 60    # 每 60 分钟刷一轮，Ctrl+C 退出
```

守护模式下每轮只挑「30 分钟内到期」的源重解析，没到期直接跳过。

## 中文简介（本地模型批量生成）

`node scripts/jable-blurb.mjs` 把番号 / 女優 / 類別 / 標籤 / 日文原题拼成 prompt，
交给本机 EXL3 模型（`127.0.0.1:5000`）写 2–3 句中文简介，写到 `description` 最前面，
带 `簡介：` 标记，重复跑只补没写过的。

```bash
node scripts/jable-blurb.mjs                      # 补没写过的
node scripts/jable-blurb.mjs --limit 5            # 先试 5 条
node scripts/jable-blurb.mjs --dry                # 只看不写
node scripts/jable-blurb.mjs --force              # 全部重写
node scripts/jable-blurb.mjs --concurrency 3      # 默认 3 路（单卡最优）
```

13 条实测：每条 1.3–2.1 秒，13/13 成功，总耗时约 25 秒。三路并发下每条 3–6 秒、整体吞吐约 2 倍，上百条时差别明显。

走 OpenAI 兼容端点，`AI_BASE` / `AI_MODEL` / `AI_KEY` 可覆盖。为什么要本地模型而不是主会话：这是纯「一段文本进、一段文本出」的活，一次几百条，交给主会话会白吃上下文，而且还要逐条等。本地模型无状态、不花钱、可并发，主会话只留最后的统计。

## 贴图三件套

| 文件 | 来源 | 尺寸 | 用途 |
| --- | --- | --- | --- |
| `cover-<slug>.jpg` | `assets-cdn.jable.tv/contents/videos_screenshots/<id千位>/<videoId>/preview.jpg` | 800×538 横版 | 详情页海报、列表封面 |
| `banner-<slug>.jpg` | 上面同一张图经 ffmpeg 裁切 | 1600×900 | 详情页大图 |
| `preview-<slug>.jpg` | HLS 同目录 `/thumb.ts` | 2130×2040，10×17 帧，每帧 213×120 | 进度条预览雪碧图 |

注意：

- `cover.jpg` / `preview.webp` / `thumbs1.jpg` 全部 404，**只有 `preview.jpg` 存在**；
- `/thumb.ts` 的 `content-type` 谎报 `video/mp2t`，实际是 JPEG（magic `ff d8 ff e0`）；
- 帧坐标来自 `thumbvtt.ts`（WebVTT），每 60 秒一帧，格式 `thumb.ts#xywh=x,y,213,120`，
  可用 `parseThumbVtt()` 得到时间轴映射。

落盘位置 `storage/images/`，对外地址 `/media/images/<文件名>`。

## 用法

```bash
# 单集
node scripts/jable-import.mjs "https://jable.tv/videos/mikr-134/"

# 列表页批量（默认取页面里全部影片链接）
node scripts/jable-import.mjs --page "https://jable.tv/latest-updates/" --limit 8

# 连续翻 10 页（每页 24 部，去重后约 240 部）
node scripts/jable-import.mjs --page "https://jable.tv/latest-updates/" --pages 10

# 只看解析结果，不写库不下载
node scripts/jable-import.mjs "https://jable.tv/videos/mikr-134/" --dry

# 只更新元数据，不重新下贴图
node scripts/jable-import.mjs "https://jable.tv/videos/mikr-134/" --no-images

# 大批量：跳过雪碧图（单张 1.5MB，2000 部就是 3GB），只下封面 + banner
node scripts/jable-import.mjs --page "https://jable.tv/latest-updates/" --pages 87 --start-page 14 --skip-existing --no-preview

# 刷新所有已入库条目的直链（链接过期后用这个）
node scripts/jable-import.mjs --refresh
```

分页是路径形式 `/latest-updates/2/`（`?page=2` 无效，会返回第一页）。站点现有 1668 页，全站约 4 万部，量力而行：单部约 4 秒、三张图约 1.4MB，240 部≈16 分钟 + 340MB。

实测规模参考：**100 页 = 2376 部**，全程约 1 小时 33 分（含 Cloudflare 挑战页重试），
番号零重复，贴图 4752 张（`--no-preview`）约 650MB。CF 挑战页命中时按 8s/16s/24s 退避重试，
连续 3 页空才停，别指望一次跑完不断。

**`--no-preview` 是大批量的默认选择**：雪碧图只用于进度条缩略预览，一张 1.5MB，几百部就上 GB；
封面（171KB）和 banner（124KB，本地 ffmpeg 从封面上裁）几乎免费。实测 2000+ 部时不开它，
导入会被跨境下载拖到 30 秒/部，开了回到数秒/部。

浏览器路径可用 `MH_EDGE` 覆盖，默认
`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。

抓图与时长探测是并行的（`Promise.all`），封面和雪碧图也同时下——跨境下载是整条链路里最慢的一环，串行会白等一个来回。

## 落库规则

`dramas`：

- `title` 存去掉番号的正文，`sub_title` 存 `CODE · 女優`，两者都由解析器给出；
- `category='MOVIE'`、`content_type='movie'`、`area='日本'`、`is_adult=1`；
- 查重条件 `title LIKE 'CODE%'` 且 `is_adult=1`，命中则原地更新。

`episodes`：固定 `no=1`、`title='正片'`，
`remote_url` 存直链、`remote_referer='https://jable.tv/'`、`remote_ua` 用 Chrome 131 桌面 UA、
`status='ready'`、`progress=100`。`duration` 由清单累加 `#EXTINF` 得到。

标签：站点已有 119 条 `tags.scope='adult'` 播种标签。导入时用繁简归一表匹配，
命中即写 `drama_tags`，不新增标签，避免标签表被 jable 的原始词表污染。

## 播放链路

```
浏览器 <video> → /media/remote/1/index.m3u8   （本站签名地址）
      → server/stream-proxy.mjs 拉上游清单
      → 重写 #EXT-X-KEY 与所有分片为 seg/<sha1>.ts 并递归转发
      → /media/remote/1/seg/xxx.ts 命中磁盘缓存（AES key 不缓存）
```

上游是 AES-128：key 文件伪装成 `.ts` 与分片同目录，实测 16 字节。
`ffprobe` 直连本站代理清单可解出 `h264 1280x720 + aac`，
`ffmpeg -t 20 -i ... -f null -` 返回 0，说明取 key、解密、解码全通。

## 让内容可播

导入的片默认落 `subscription` 策略（无 `content_policies` 记录时 `resolveAccess` 的缺省），
也就是只有会员能播、试看 0 秒。按需选一种：

```sql
-- A. 整站成人区免费（自己先验证链路最快）
INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind)
SELECT id, 'free', 1, 0, 0, 'single' FROM dramas WHERE is_adult = 1
ON CONFLICT(drama_id) DO UPDATE SET access_mode = 'free', free_episodes = 1;

-- B. 会员可看 + 游客试看 60 秒（商业化推荐）
INSERT INTO content_policies (drama_id, access_mode, free_episodes, trial_seconds, single_price_cny, purchase_kind)
SELECT id, 'subscription', 0, 60, 0, 'single' FROM dramas WHERE is_adult = 1
ON CONFLICT(drama_id) DO UPDATE SET trial_seconds = 60;
```

游客试看必须带 `?trial=1`，且未登录时被压到 15 秒上限（`guest_trials` 表按 visitor 限一次）。

## 运营流程

1. **每天定时刷新**：直链 3 小时就过期，建议每日（或每 6 小时）
   跑 `node scripts/jable-import.mjs --refresh`。
   Windows 计划任务示例：

   ```powershell
   schtasks /create /tn "jable-refresh" /sc hourly /mo 6 `
     /tr "node E:\video-rr\scripts\jable-import.mjs --refresh" /ru SYSTEM
   ```

2. **新增片目**：`--page <列表页> --limit N`，列表页可以是
   `/latest-updates/`、`/hot/`、`/categories/<slug>/`。

3. **重复导入是幂等的**：查重键是 `dramas.sub_title LIKE 'CODE%'`（番号存在 sub_title 里，
   title 已被去掉番号）。同一部片重复导入只会原地更新，不会再建一条。
   `--refresh` 反推地址也是从 `sub_title` 取番号，再转成小写连字符形式。

4. **过期报错**：链接失效时上游 403，代理返回 502 且响应体写明
   `source rejected (403) 直链签名过期或凭证失效……`，后台看到该集 `status` 仍为 `ready` 时先跑 `--refresh`。

## 已知坑

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 403 `Just a moment...` | Cloudflare 挑战 | 只能走 Edge + CDP，代理换 IP 无用 |
| 直链突然 403 | EXP 过期（约 3 小时） | `--refresh` 重解析 |
| 分片 403 | 上游要求 `Referer: https://jable.tv/` | 脚本已写入 `remote_referer` |
| 播放进度条没有预览图 | 未下载 `thumb.ts` 雪碧图 | 去掉 `--no-images` 重跑 |
| 番号里带 `_`（如 `ABC_123`） | URL 形如 `abc-123` | `slugOf()` 已归一，反推 URL 时按 slug 匹配 |
| 图片 404 | 用了 `cover.jpg` 等不存在的命名 | 只用 `preview.jpg` 与 `/thumb.ts` |
| 统计直链条数偏少一半 | 只过滤 `mushroomtrack.com` | 上游 CDN 域名会换（现有 `*.mushroomtrack.com` 与 `*.alonestreaming.com` 两批），按 `remote_url <> ''` 统计，别按域名 |
| 简介变回日文原文 | `upsertDrama` 用原始描述盖掉了「簡介：」 | 已修（`keepBlurb`）；旧数据跑 `node scripts/jable-blurb.mjs` 重生成 |

## 发布到生产

生产是独立一台 HK 机器（`ssh hk` → `/opt/video-rr`，systemd `video-rr`，端口 8787，nginx 子路径 `/video`）。三类东西要分开推：

```bash
npm run pack:deploy                                  # 代码包 mh-deploy-*.tgz
node scripts/push-images.mjs                         # 贴图（增量，只传生产没有的）
node scripts/adult-export.mjs storage/adult-export.json  # 数据
```

`push-images.mjs` 会先 `ssh ls` 看远程有哪些图，只把本地多出来的打包（200 张一批，tar+scp+远程解包）。首次全量走一次流量，之后稳定状态基本是「秒过」。别用 `scp -r storage/images`，图会越来越多，每次全传几百兆。

上传解包后跑 `deploy/install-hk.sh`（幂等：npm ci → build → 补 `.env` → 装 nginx 片段 → restart → 重写封面路径 → 海报墙），应看到 `/video/ 200`、`/video-admin/ 200`、`unsigned hls 403`。

数据用 `scripts/adult-migrate.mjs` 写入，按 `sub_title` 番号查重，重复跑是 `更新` 而不是新增：

```bash
ssh hk 'cd /opt/video-rr && MH_DB=/opt/video-rr/storage/app.db \
  node scripts/adult-migrate.mjs /tmp/adult-export.json --mode free --trial 0'
```

`--mode` 决定这批片能不能看：`free` 全站可播，`subscription` 要会员，`paid` 单片付费。默认 `subscription` 且 `trial 0` 时**站长自己也播不了**，别被「后台显示 ready」误导。

### 为什么刷新必须在本机做

| 机器 | 浏览器 | 直连 jable.tv | 直连 CDN |
| --- | --- | --- | --- |
| 本机 Windows | Edge，能过挑战 | 200 | 200 |
| HK 服务器 | 无 | **403**（Cloudflare） | 200 |

服务器过不了挑战，也装不了浏览器会话，所以**解析新链接只能在本机**；分片代理在服务器上没问题。流程是「本机刷新 → 导出 → scp → 远程写库」。

## 自动刷新

`deploy/sync-adult.cmd` 把上面四步串起来（Windows 版，给计划任务用；`deploy/sync-adult.sh` 是同样的 bash 版，给能跑 bash 的机器）：

```
node scripts\jable-import.mjs --refresh --max-left 40   # 只重解析剩不到 40 分钟的
node scripts\adult-export.mjs
node scripts\push-images.mjs                            # 增量，只传生产还没有的图
scp storage\adult-export.json hk:/tmp/
ssh hk "... adult-migrate.mjs /tmp/adult-export.json --mode free"
```

挂到 Windows 计划任务，每 30 分钟一次：

```powershell
schtasks /Create /TN "video-rr-adult-refresh" `
  /TR "cmd /c E:\video-rr\deploy\sync-adult.cmd" /SC MINUTE /MO 30 /F
```

为什么带 `--max-left 40`：直链活 3 小时，239 部全量重解析要十几分钟，每轮都全刷太浪费。带上这个参数每轮只处理快到期的那批（通常几十部、两三分钟），到期节奏也和 30 分钟的巡检对得上。不带参数（或 `--refresh` 裸跑）仍是全量刷新，手工补刷时用。

`push-images.mjs` 先 `ssh ls` 一遍远程，只把本地多出来的文件名打包上传（200 张一批），所以稳定状态下每轮是「秒过」，新增片时才真的走流量。

日志在 `storage/logs/adult-sync.log`，每次四段：`start` → 13 条解析结果 → 远程库 `更新 13` → `done`。任务只在当前用户登录时运行（`Interactive only`）——Edge 需要桌面会话，这是预期行为，别改成「不管用户是否登录」。

注意 `.cmd` 文件必须存成 ANSI 或只写英文注释：UTF-8 中文注释会被 cmd 按 GBK 解析成乱码命令，表现为「日志不生成、Last Result 却是 0」。文件开头已加 `chcp 65001`。

## 生产验收

`deploy/verify-adult.sh` 走一遍完整链路，15 项：

```bash
ADMIN_PASSWORD=*** USER_EMAIL=*** bash deploy/verify-adult.sh
```

覆盖：后台登录 → 代发 C 端登录码 → C 端 email 登录 → `GET /api/play/<dramaId>/1` 返回 `/media/remote/<episodeId>/index.m3u8` → 带 Cookie 拉清单 200 且是 EXTM3U → 清单里 `#EXT-X-KEY` 与分片都已改写成 `seg/xxx.ts` → 清单不含 `mushroomtrack`/`jable` 域名 → 首分片 200 → AES key 16 字节 → 用清单 IV 手工解密后 `ffprobe` 认出 `h264` → 无 Cookie 403 → 换 UA 403 → `ffprobe` 直拉整条 m3u8 得到时长。

预期尾巴：`结果：失败 0 项`，时长与库里 `duration` 一致（MIKR-134 是 `9799.020335s`）。

## 播放几秒后停住：成因与修法

用户报「播几秒钟就无法播放」。整条链路逐段拆开测，结论不是链路坏，是**回源速度踩在播放速度的临界线上**。

实测（生产 HK → 上游 CDN，单段 4 秒视频）：

| 指标 | 数值 |
|---|---|
| 单段体积 | 0.85–1.38 MB |
| 单段回源耗时 | 1.82–2.05 s |
| 单段播放时长 | 4 s |
| 服务端整条 ffmpeg 连续读 120 s | 6.8x 速度，零错误 |
| 浏览器 60 s | 缓冲始终领先 8–9 s，0 失败 |
| 生产 `storage/remote-cache` | **只有 10 个文件 5.7 MB** |

最后一行是关键：几乎每段都在回源，等于没有缓存。每段 2 秒、只播 4 秒，正常情况下刚好够；一旦并发多几个或链路抖一下，缓冲就吃光，hls.js 报 `fragLoadError`/`bufferStall`，用户看到的就是「播几秒停住」。

另外两个缺陷会放大它：

1. **AES key 每段都跨境回源**（200–330 ms），而且 key 不落盘；
2. **session 用固定 30 分钟 TTL**，过期后内存里的分片映射丢失，请求直接 410。

修法（`server/stream-proxy.mjs`）：

- **清单返回即预热**：`WARM_ON_MANIFEST=16`，头 16 段（约 64 秒）立刻进磁盘缓存；
- **追播预取**：`PREFETCH_AHEAD=10`、`PREFETCH_CONCURRENCY=3`，每取一段就把后面 10 段排进队列，队列上限 40 防止抢带宽；
- **key 内存缓存**：`KEY_CACHE_TTL_MS=5min`、上限 512 条，命中直接回 16 字节；
- **session 滑动续期 + 段表自愈**：每次请求 `expiresAt` 顺延；`seg/` 找不到或 entry 过期时自动重新拉清单重建映射，重建失败才 410；
- **前端 hls.js 加缓冲与重试**（`public/src/components/VideoPlayer.vue`）：`maxBufferLength:30`、`maxMaxBufferLength:60`、`maxBufferSize:60MB`、`fragLoadingMaxRetry:8`、`manifestLoadingMaxRetry:6`。

修完实测：

- 清单返回后 8 秒内落盘 **8 个分片 3.0 MB**；
- 同一个分片：首次 1.82 s → 缓存命中 **0.012 s**；
- 浏览器连播 **100 秒**：`t` 稳步推进，缓冲领先 5–12 s，卡顿采样 0 次、错误 0 次。

### 还有一种「播几秒停」：链接过期

上游直链只有约 3 小时有效期。过期后已缓存的段还能播，没缓存的段直接 403，表现和上面一模一样。判断办法：

```bash
node scripts/jable-import.mjs --refresh --dry    # 看剩余分钟
```

正常应该显示剩余 100 分钟以上。整站都在 60 分钟以下，说明刷新计划任务没跑起来。运营靠 Windows 计划任务 `video-rr-adult-refresh` 每 30 分钟 `--refresh --max-left 40`，只刷快过期的几十部。

## 评分补齐（--score-only）

后台「剧集管理」的「缺 N 项」里 `score` 是最常见的缺失项。jable 没有用户打分，只有站内播放量，
所以评分按播放量折算：`6.0 + min(3, max(0, (log10(播放量+1) - 3) × 1.15))`，上限 9.0。

```bash
node scripts/jable-import.mjs --score-only --limit 5 --dry   # 先看折算结果
node scripts/jable-import.mjs --score-only                   # 全量补
```

* 只挑 `is_adult=1 AND category='MOVIE' AND score 为空` 且能反推番号的片子，已经有分的不覆盖。
* 走的是同一套 Edge/CDP，单部约 1.4–2.8 秒；三千部要跑一到三小时，建议挂着让它自己跑。
* 折算函数 `scoreOfViews()` 在 `server/jable.mjs`（纯函数，`test/score-fill.test.mjs` 覆盖）。
* 列表页卡片上没有播放量，只能进详情页取，所以没法用翻页加速。
## 刷新搬到服务器（2026-11-16 起）

本机家宽 IP 在批量补评分时被 jable 升级成硬挑战：连续抓了约 1500 个详情页之后，
所有请求都停在 `Just a moment`，连每 30 分钟的直链刷新也开始全失败（40 部全挂）。
表现是 `✗ 页面没拿到 hlsUrl（挑战没过或页面改版）`，等 10 分钟重试仍失败，
而同一时刻生产 HK 服务器换个思路就能过——判断是 IP 级限流，不是页面改版。

于是刷新链路整体搬到 HK 服务器：

```bash
# 服务器装浏览器与虚拟显示（Debian 13，root 运行必须 --no-sandbox，脚本已内置）
apt-get install -y chromium xvfb

# 手动验证（headful 通过 xvfb 跑，headless 会被 Cloudflare 挡）
cd /opt/video-rr && MH_EDGE=/usr/bin/chromium xvfb-run -a \
  node scripts/jable-import.mjs --refresh --max-left 1 --dry
```

`/etc/cron.d/video-refresh`（每 3 小时，`flock` 防重入）：

```
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
# jable 直链 3 小时过期。每 3 小时全量刷新一轮（约 1.8 小时跑完），
# 请求量约 1100 次/小时，是维持 3383 部可播的最低频率，别再往上加。
0 */3 * * * root cd /opt/video-rr && flock -n /tmp/jable-refresh.lock env MH_EDGE=/usr/bin/chromium xvfb-run -a node scripts/jable-import.mjs --refresh --max-left 200 >> /var/log/video-refresh.log 2>&1
```

频率是被有效期倒推出来的：链接 3 小时过期，一轮全量约 1.8 小时，
所以 3 小时是能维持全部可播的最低频率。再密只会加速触发 Cloudflare 限流，
不会让播放更稳；真要减少请求量，唯一有效的办法是缩小需要保持可播的片量。

实测服务器端 167 部连续刷新 **0 失败**，约 21 部/分钟；1844 部待刷约 90 分钟跑完。

**关键配套**：`scripts/adult-migrate.mjs` 写 `remote_url` 前会比较两边的 `EXP`
（`expiryOfUrl()`，从 `/hls/<token>/<EXP>/` 取），只有本地更晚才覆盖。
否则本机导出的旧链接会把服务器刚刷好的新链接顶掉——这是这次差点踩的坑。

本机 `deploy/sync-adult.cmd` 因此去掉了 `--refresh` 一步，只剩
`adult-export → push-images → migrate`，计划任务间隔从 30 分钟放宽到 2 小时。