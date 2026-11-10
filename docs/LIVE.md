# 直播推流部署（MediaMTX）

本站把 **RTMP 入流 → HLS 出流** 交给 [MediaMTX](https://github.com/bluenviron/mediamtx)（单文件，无依赖），后台一键启停。

## 端口

| 用途 | 端口 | 说明 |
|---|---|---|
| RTMP 推流 | 1935 | OBS「服务器」填 `rtmp://<主机>:1935/live`，「串流密钥」填频道 key |
| HLS 播放 | 8888 | `http://<主机>:8888/live/<key>/index.m3u8` |
| 本站反代 | 8787 | `http://<主机>:8787/live/<key>/index.m3u8`（同源，免 CORS） |

后台「直播推流」页会显示当前实际的推流/播放地址；端口可用环境变量覆盖：

```bash
set MH_RTMP_PORT=1935
set MH_HLS_PORT=8888
node server/index.mjs
```

## 本机验证（不装 OBS 也能测）

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 \
       -f lavfi -i sine=frequency=440 \
       -c:v libx264 -preset veryfast -g 60 -c:a aac \
       -f flv rtmp://127.0.0.1:1935/live/demo
```

推上去 2~4 秒后：

```bash
curl http://127.0.0.1:8888/live/demo/index.m3u8
curl http://127.0.0.1:8787/live/demo/index.m3u8     # 经本站反代
```

C 端「直播」页会自动加载 HLS 播放。

## OBS 设置

- 服务：自定义
- 服务器：`rtmp://<你的主机>:1935/live`
- 串流密钥：后台创建的频道 key（默认种子数据里是 `demo`）
- 输出：编码器 x264，关键帧间隔 2s（HLS 切片更平滑），码率按带宽 2500~6000 kbps

## 生产化建议

1. **推流鉴权**：`mediamtx.yml` 里开 `authMethod: http` + `authHTTPAddress: http://127.0.0.1:8787/api/live/auth`，由本站校验 key 与来源 IP。或者给每个频道独立 key + 有效期。
2. **常驻**：Windows 用 NSSM 注册服务（`nssm install mediamtx <path>\mediamtx.exe <path>\mediamtx.yml`）；Linux 用 systemd。
3. **录制/转推**：`pathDefaults.record: yes` 落盘录制；`runOnReady` 触发转推多平台。
4. **低延迟**：启用 WebRTC（`webrtc: yes`，默认端口 8889）给需要 <1s 延迟的场景；HLS 延迟通常 4~8s。
5. **限流与防火墙**：只放行 1935/8888/8889，播放侧走 CDN 回源。
6. **多路并发**：MediaMTX 单实例可承载数十路 720p；更高并发按频道分片部署 + 前置负载均衡（RTMP 需按流粘性）。

## 排错

| 现象 | 排查 |
|---|---|
| 后台显示「已安装未启动」 | 点「启动 MediaMTX」，看 `lastError`（端口占用最常见） |
| OBS 推流失败 | `telnet <host> 1935`；检查 key 是否与频道一致 |
| HLS 404 | 推流是否真的在推（后台频道状态）；MediaMTX 日志 `storage/tools/mediamtx.yml` 同目录 |
| 播放黑屏 | 浏览器需 hls.js（本站已从 CDN 引入）；离线环境改用 Safari/原生 HLS 或把 hls.js 本地化 |
