# 外部片源代理（remote source gateway）

在自己站点里挂别人的片源：剧集里填一条上游地址，播放时由本站服务器拉流、重写清单、转发分片，
播放器全程只看到本站域名。不做本地转码、不落整片。

```
浏览器 ── HLS ──▶ 本站 /media/remote/<episodeId>/index.m3u8
                         │  （签名 + Cookie，与本地 HLS 同一套）
                         ▼
                  Node stream-proxy
                   │  1. 上游可能是播放页 → 抽 m3u8
                   │  2. 带 Referer / UA / Cookie 请求上游
                   │  3. 把清单里所有 URI 改写成本站 seg/<hash>
                   ▼
              上游 /index.m3u8 ──▶ 分片 /seg/<hash> ──▶ 流式转发 + 冷缓存
```

上游按 IP / UA / Referer 做的绑定全部落在服务器这台机器上（HK 节点），所以浏览器侧不受影响。

## 数据字段

`episodes` 表（幂等迁移已在 `ensureOpsSchema()` 里，老库启动自动补列）：

| 列 | 说明 |
|---|---|
| `remote_url` | 上游播放页地址或 m3u8 直链；非空则优先于 `hls_path` |
| `remote_referer` | 请求上游时带的 Referer，留空则取源站首页 |
| `remote_ua` | 请求上游时的 User-Agent，留空用 Chrome 桌面 UA |
| `remote_cookie` | 需要登录态才能取流的站点，填 Cookie 串 |

`remote_url` 有值时，播放接口返回的 `hls` 为 `/media/remote/<episodeId>/index.m3u8`，
本地 `hls_path` 保持不动，随时可切回。

## 后台操作

后台 → 剧集 → 分集与视频 → 每行「外部片源」按钮：

1. 填播放页 URL（如 `https://example.com/videos/xxxx/`）或 m3u8 直链
2. 填 Referer（默认自动取源站首页）
3. 保存后该集状态置 `ready`，立即可以点播

接口（需要 `content.episode.write`）：

```
POST /admin/api/episodes/:id/remote
{ "url": "https://example.com/videos/xxxx/", "referer": "https://example.com/", "ua": "", "cookie": "" }
```

`url` 传空串即清除外部片源。

## 请求链路

```
GET /api/play/<dramaId>/<no>
  → { hls: "/media/remote/123/index.m3u8", expiresIn: 2700, ... }   // 同时下发签名 Cookie

GET /media/remote/123/index.m3u8?sign=..&expires=..
  → #EXTM3U
    #EXT-X-KEY:METHOD=AES-128,URI="seg/ab12....bin"     ← 密钥也走代理，不缓盘
    seg/1f3e....ts                                      ← 相对路径，自动继承 /video 子路径
    seg/9a02....ts
```

- 签名规则与 `/media/hls/` 完全相同（`entitlements.linkScope` 同时认 `hls` 与 `remote`），
  nginx 的 `auth_request` 分支不需要新增。
- 清单里的相对 URI 用清单自身地址解析，所以上游用相对路径、绝对路径、跨域 CDN 都能正确重写。
- 多码率 / 多音轨（master playlist）的变体清单同样被代理，分片继续由本站转发。

## 缓存

分片落盘在 `storage/remote-cache/<hash前2位>/<hash>.<ext>`：

- 同一分片只回源一次，之后直接本地读；Range 请求命中缓存时按区间切
- `#EXT-X-KEY` 的密钥**不缓存**（密钥会按会话轮换）
- Range 首次未命中时不落盘（跳转场景没必要写整段）
- 清理：直接删目录即可，播放器会重新拉清单自愈；容量统计 `remoteCacheStats()`

`MH_REMOTE_CACHE` 可改缓存目录，`MH_REMOTE_TIMEOUT_MS` 改上游超时（默认 15000）。

## nginx（HK 节点）

`deploy/nginx-video.snippet.conf` 已加 `location /video/media/remote/`：转发到 Node，
`proxy_buffering off` + 300s 读写超时，保证边下边发、不憋内存。部署时重新注入片段即可。

## 现实坑

| 现象 | 原因 | 处置 |
|---|---|---|
| 502 / `upstream 403` | 上游校验 Referer / UA / Cookie | 后台补 `remote_referer`、`remote_ua`，需要登录态的补 `remote_cookie` |
| 502 / `no m3u8 found in page` | 播放页是 JS 动态加载，或源站改版 | 改成填 m3u8 直链；或更新 `stream-proxy.mjs` 的 `PAGE_CANDIDATES` |
| 分片 403 但清单正常 | 分片带一次性 token，且和请求 IP 绑定 | 本来就由服务器拉，正常可过；若 token 域与清单域不同，确认 `Referer` 与清单一致 |
| 播放卡在 0:00 | 上游用 AES-128 而 key 请求被拦 | 抓 `seg/*.bin` 那条的响应；key 与分片同样带 `Referer` |
| Cloudflare 5 秒盾 | 上游加人机校验 | 服务器侧拿不到干净 HTML，此时只能填已签好的 m3u8，或改用本地转码 |
| 集数多、带宽吃满 | 代理流量走 HK 出网 | 单集分片缓存在本地后重复观看不耗上游；预算按 `remoteCacheStats()` 的字节数估 |

## 签名续期（jable 直链）

jable 的 m3u8 直链签名写在 URL 里（`/hls/<token>/<exp>/...`），有效期约 3 小时。过期后上游回
401/403/410，网关统一翻成 502，用户看到的就是「播放按钮灰色、点不动」。所以可播率等于
**续期速度**是否跟得上**过期速度**：库内 3500 条外部源、3 小时有效，平均每分钟过期 19 条，
续期必须稳定跑在 19 条/分钟以上。

### 按需续期（用户侧）

**原则：票没过期就一次都不刷，过期了就当场换。** 用户点开一集，绝不为「几分钟后才过期」的票
先让他等一次换票；只有真的过期了才开浏览器，换好立刻播。

- `GET /api/play/:dramaId/:no` 走 `ensureFreshForPlay()`（严格按 `staleOf` 判断，不看提前量）：
  - 换上了 → 直接 200 返回新 `hls`，实测热 profile 单集 1～3 秒；
  - 换不上 → `409 / 0409`，body 带 `reason: 'source_link_expired'` 与 `retryAfterSeconds`（4～6 秒），
    前端倒计时自动重试；同一部失败 3 次才改回 `source_unavailable`（提示换一集）。
  - 请求最多等 `MH_PLAY_REFRESH_WAIT_MS`（默认 8 秒）。超时不杀子进程（冷启动要过 CF 挑战），
    让它继续跑，前端几秒后重试就拿到新票；超时也**不计失败**，不会把用户关进冷却。
- `/media/remote/:id/index.m3u8` 同样走严格判断，票还是旧的才回 `503` + `Retry-After`。
- 分片请求遇到上游 401/403/410 → 清掉该集 session 缓存，回 `503` + `Retry-After`。
- 前端 `VideoPlayer.vue` 收到 503/409 时倒计时自动重试（最多 3 次），`PlayPage.vue` 错误态显示
  「片源签名已过期，服务器正在自动换新链接，N 秒后自动重试」。
- **同一番号多条剧共用一张票**：库里 194 组重复番号（历史导入遗留，如 `MIDA-763` 同时存在 drama
  572 / 5551）。按番号刷新只更新其中一条，其余永远换不到 → 点进去一直「续期中」。所以
  `shareTicket()`（导入脚本刷新后）与 `adoptFresherTicket()`（服务端续期后）都会把最新鲜的票抄给同番号条目。
- 失败冷却逐级加长（1 分钟 → 3 分钟 → 5 分钟），偶发 Cloudflare 拦截不会一棍子打死。
- **profile 预热**：服务启动时与之后每 20 分钟跑一次 `jable-import.mjs --warm`（过一遍首页拿
  `cf_clearance`），否则冷 profile 的第一次点击要重吃 40 秒级挑战。`MH_WARM_PROFILE=0` 可关。

### 定时续期（服务器侧）

`deploy/cron.d/video-refresh`（装到 `/etc/cron.d/video-refresh`）三条：

```cron
*/5 * * * * root cd /opt/video-rr && flock -n /tmp/jable-refresh.lock env MH_EDGE=/usr/bin/chromium MH_CHROME_PROFILE=/opt/video-rr/storage/.jable-chrome MH_SHARD=0/2 xvfb-run -a node scripts/jable-import.mjs --refresh --max-left 45 --limit 600 >> /var/log/video-refresh.log 2>&1
2-59/5 * * * * root cd /opt/video-rr && flock -n /tmp/jable-refresh-2.lock env MH_EDGE=/usr/bin/chromium MH_CHROME_PROFILE=/opt/video-rr/storage/.jable-chrome-2 MH_SHARD=1/2 xvfb-run -a node scripts/jable-import.mjs --refresh --max-left 45 --limit 600 >> /var/log/video-refresh.log 2>&1
3,13,23,33,43,53 * * * * root cd /opt/video-rr && /usr/bin/node scripts/jable-health.mjs --fix >> /var/log/video-refresh.log 2>&1
```

- 两轮按 `MH_SHARD=i/N`（drama id 取模）分片，各用**独立 flock 与浏览器 profile**，互不抢同一批片子；
  单轮约 20～45 条/分钟，双轮并行才能追上「每分钟 19 条自然过期」。
- **文件末尾必须有换行**。少一个 `\n`，cron 会报
  `(*system*video-refresh) ERROR (Missing newline before EOF, this crontab file will be ignored)`
  并静默忽略整份配置 —— 线上真的因此断过 8 小时没人发现，改完一定要
  `tail -c 40 /etc/cron.d/video-refresh | od -c` 看一眼。
- 按需续期用**自己的锁**（`/tmp/jable-refresh-ondemand.lock`）和 profile（`storage/.jable-chrome-od`），
  否则批次一跑十几分钟，用户永远等不到。
- `scripts/jable-health.mjs` 统计过期比例、写 `storage/health/jable.json`，超阈值（默认 100 条或 3%）
  且没有刷新进程时自己拉起一轮。`--json` 给机器读，`--quiet` 只在告警时输出，告警退出码 2。

### 单部续期为什么能到 1 秒级

1. **持久 Chrome profile**（默认 `storage/.jable-chrome`）：Cloudflare 的 `cf_clearance` 存在
   cookie 里，每轮都换临时 profile 的话每页都要重过挑战，实测单页从 1.9 秒退化到 77 秒。
2. **先预热首页**再逐部跑，把 clearance 拿到手。
3. **页面内 fetch 取 HTML**（`fetch(url).then(r => r.text())`，不渲染）比 `Page.navigate` 快一个数量级；
   被拦时自动退回真导航。
4. **404 快速失败**：页面标题是「404 頁面丟失」就不重试、不再轮询，并把这个番号记进
   `storage/jable-gone.json`（`refreshTargets` 与体检都跳过它，否则它按到期时间永远占住队头）。
5. **熔断**：连续 8 次被挑战就提前结束本轮，别把 Cloudflare 惹毛。

### 排障

```bash
node scripts/jable-health.mjs            # 人读一行：总 / 已过期 / 20 分钟内到期 / 健康 / 下架
node scripts/jable-health.mjs --json     # 机器读，字段含 pct、alert、samples
tail -f /var/log/video-refresh.log       # cron 续期与体检输出
flock -n /tmp/jable-refresh.lock true && echo 空闲   # 有没有批次在跑
```

## 测试

`test/remote-source.test.mjs` 用本机 mock 上游覆盖：清单重写、Referer 伪装、分片转发、
冷缓存命中、Range 206、播放页抽 m3u8、上游 403 转 502（签名过期时是 503 + Retry-After）。

`test/jable-refresh.test.mjs` 覆盖签名判定与冷却：`签名时间已过的直链才算过期`、
`解析不出签名时间的片源永远不算过期（huangguo 引用、直链 mp4）`（`staleOf` 的正则取不到
`exp` 时必须判「不过期」，否则 `huangguo://` 这类本地源会被误标过期、接口直接 409）。

`test/remote-expiry.test.mjs` 覆盖按需续期契约：过期时播放接口回 `409` 且
`reason='source_link_expired'`、`retryAfterSeconds` 在 3～15 秒（前端据此倒计时，不再干等 30 秒）；
**没过期的直链点开就播、一次续期尝试都不发起**（`refreshStats().attempts` 不增加、响应 < 500ms）；
本地引用式片源照常 200；列表里的 `stale` 只对签名过期的直链亮起。

```bash
node --test test/remote-source.test.mjs
node --test test/jable-refresh.test.mjs
node --test test/remote-expiry.test.mjs
```
