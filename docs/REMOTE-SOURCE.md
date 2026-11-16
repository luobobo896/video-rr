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

## 测试

`test/remote-source.test.mjs` 用本机 mock 上游覆盖：清单重写、Referer 伪装、分片转发、
冷缓存命中、Range 206、播放页抽 m3u8、上游 403 转 502。

```bash
node --test test/remote-source.test.mjs
```
