# 刮削与海报

## 来源

- Kodi 官方电影刮削器：`https://github.com/xbmc/metadata.themoviedb.org.python`
- 实现：`server/tmdb.mjs`
- 默认使用 Kodi add-on 公开 API key；生产可用 `TMDB_API_KEY` 或 `TMDB_READ_TOKEN` 覆盖。

## 匹配与素材

1. 中文标题、副标题原名，结合年份和内容类型加权。
2. 普通补齐：已有本地文件 → 源片抽帧 → archive.org → TMDB 海报/backdrop → Wikipedia 页面主图 → 远程封面。
3. 强制重刮：TMDB 海报/backdrop → Wikipedia 页面主图 → 远程封面 → 高清源片抽帧 → archive.org → 失败时保留原图。
4. 只有完全找不到海报才报错；横幅失败不阻断封面。
5. 成功后给 URL 加版本参数绕过 nginx 7 天缓存。

## 已确认的无图条目

- `About Bananas (1935)`：TMDB ID 222914 存在，但没有 poster/backdrop；Wikipedia 页面也没有主图。回退到本地高清源片抽帧。
- `From the Ground Up (1954)`：TMDB ID 1507278 存在，但没有图片；Wikipedia 电影页有 lobby card，可作封面/横幅。

## 日志

匹配、未命中、Wikipedia 回退、单剧刮削结果和批次汇总均以 JSON 事件写入服务日志，字段包括 `tmdbId/mediaType/from/durationMs/error`。
