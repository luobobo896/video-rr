# 多音轨播放器与偏好验证

日期：2026-11-11

## 自动化测试

```text
node --test test/track-match.test.mjs       # 4 passed
node --test test/tracks.test.mjs            # 2 passed
node --test test/episode-track-ingest.test.mjs  # 3 passed
npm test                                    # 143 passed, 0 failed
npm run check                               # frontend checks: 10 files clean
```

覆盖：

- 显式语言 + 版本优先于默认项。
- 同语言多版本按默认项选择。
- 无匹配时音轨回退、字幕关闭。
- 轨道 CRUD、重复轨道、默认唯一、删除默认保护。
- 音频 HLS、字幕 WebVTT 播放列表、master `EXT-X-MEDIA` 重写。
- 登录用户轨道偏好按剧集保存、读取和校验。

## 浏览器端到端

环境：临时 SQLite DB + 合成 HLS（2 条音轨、1 条字幕），通过 Vite 代理到临时 API 服务。

- 音轨菜单：`粤语原声 · original`、`国语配音 · mandarin-dub`。
- 字幕菜单：`Off`、`简体中文 · official`。
- 选择国语 + 简体中文后刷新，两个选择都保留。
- 390×844：播放器工具条自动换行，`scrollWidth 375 <= innerWidth 390`。
- `track_change` 事件写入成功：音频 `zh-Hans/mandarin-dub`，字幕 `zh-Hans/official`。
- 多轨时优先 hls.js，避免 Edge/Chromium 原生 HLS 绕过自定义菜单；hls.js 不可用时回退原生播放。

临时 DB、HLS 和测试脚本在验证后已清理。

## 限制

- 合成测试片只有 1 集；跨集复用由同一 `drama_id` 的偏好 key 保证，未做真实第二集点击。
- Safari 原生 HLS 的系统音轨菜单未实测。
- 图形字幕 OCR、自动提取源文件多音轨不在本轮范围。
