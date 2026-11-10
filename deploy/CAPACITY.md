# 1000 人同时在线的容量设计

## 结论先说

**并发连接**不是瓶颈（nginx 单机 1 万+ 很容易）；**出口带宽**才是。

| 清晰度 | 单路码率 | 1000 人所需带宽 | 4 秒切片大小 |
|---|---|---|---|
| 480p（默认） | ~0.85 Mbps | **≈ 0.85 Gbps（105 MB/s）** | ≈ 0.42 MB |
| 720p | ~2.2 Mbps | **≈ 2.2 Gbps（275 MB/s）** | ≈ 1.1 MB |

所以：
1. **必须开多码率**（已实现 480p + 720p，master playlist 自适应；弱网/移动端自动落 480p）。
2. 如果 HK 机器出口 < 1 Gbps，**必上 CDN**（切片放对象存储 + CDN 回源到本机 /video/media/hls/）。
3. 后台/API 走 Node（每请求几 KB），1000 在线播放时 API QPS 通常 < 50，Node 单进程足够；转码另算 CPU。

## 本方案怎么扛

| 层 | 做法 |
|---|---|
| 视频字节 | **不经过 Node**：`/video/media/hls/**` 由 nginx `sendfile + aio + directio` 直接吐文件；`open_file_cache` 缓存元数据 |
| 连接数 | `worker_connections 65535` + `worker_rlimit_nofile 100000`（install 脚本自动改，带备份） |
| 切片缓存 | 切片 `Cache-Control: public, max-age=3600`，客户端/CDN 都可缓存；playlist 短缓存 |
| 码率 | 480p 默认，HLS master 自适应；1000 人按 480p ≈ 0.85 Gbps |
| 转码 | 单机串行队列（避免抢占带宽/CPU），8 核机器一次转 720p+480p 约 1.5× 实时 |
| 直播 | MediaMTX 单实例数十路 720p；播放走 `/video/live/` 反代到 127.0.0.1:8890 |
| 数据库 | SQLite（WAL），读多写少；播放路径不查库（切片静态） |

## 压测

```bash
# 在 HK 服务器本机（测服务端承载）
node /opt/video-rr/deploy/loadtest.mjs \
  --url http://127.0.0.1:8787/video/media/hls/193/index.m3u8 \
  --concurrent 1000 --seconds 30
```

读法：
- `req/s`、`流量 Mbps`、`错误`、`p95` —— loopback 下测的是 nginx 并发与磁盘吞吐；
- 真实公网带宽要另外用外部多机（或多地）压，或直接接 CDN 后看 CDN 回源带宽。

## 到 5000+ 人时再做什么

1. CDN 全量承载切片（回源鉴权 + 边缘缓存），本机只做回源。
2. 切片上对象存储（OSS/S3），nginx 只做 API 与后台。
3. 转码独立机器/队列（Redis + worker），不要和播放服务抢 CPU。
4. 直播用多边缘（MediaMTX 转推多节点）+ WebRTC 低延迟。
5. 数据库换 PostgreSQL（本机已装），会话/历史分表。
