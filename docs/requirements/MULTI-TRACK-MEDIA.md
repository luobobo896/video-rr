# 多音轨与多字幕匹配

日期：2026-11-11

## 目标

同一集可提供多条音轨和多条字幕。系统按语言、版本/片源和用户选择匹配，用户可在播放器中切换，选择结果在同一内容的后续分集继续生效。

## 现状

- 转码只保留第一条音轨：`scripts/import-catalog.mjs` 使用 `-map 0:v:0 -map 0:a:0?`，音频固定为双声道 AAC。
- 当前 HLS master 只有清晰度 rendition，没有 `EXT-X-MEDIA` 音轨/字幕组。
- 播放器只有清晰度选择；`hls.js` 1.5.2 已内置 `audioTracks` / `subtitleTracks` 能力，可以直接消费标准 HLS 音轨/字幕组。
- 数据库没有音轨/字幕表。

## 匹配依据

### 轨道身份

每条轨道用以下字段唯一描述：

| 字段 | 说明 | 示例 |
|---|---|---|
| `episode_id` | 所属分集 | `123` |
| `kind` | `audio` 或 `subtitle` | `audio` |
| `language` | BCP-47 语言标签 | `zh-Hans`、`zh-Hant`、`yue`、`en`、`ja` |
| `edition` | 版本/片源 | `original`、`mandarin-dub`、`director-cut`、`web-dl` |
| `label` | 展示名称 | `粤语原声`、`普通话配音`、`简体中文` |
| `source` | 来源说明，可选 | `蓝光`、`Web-DL`、`官方字幕` |

唯一约束建议：`(episode_id, kind, language, edition)`。

### 默认选择优先级

音轨：

1. 用户对当前内容的显式选择。
2. 用户语言偏好匹配的轨道。
3. 内容标记为 `default` 的轨道。
4. 第一条可用音轨。

字幕：

1. 用户对当前内容的显式选择（包括「关闭」）。
2. 用户语言偏好匹配的字幕。
3. 内容标记为 `default` 的字幕。
4. 无匹配时关闭，不自动显示第一条。

如果音轨语言与界面语言不一致，而存在界面语言字幕，可默认打开该字幕；用户关闭后记住「关闭」，不再自动打开。

### 歧义处理

- 同一语言有多条轨道时，不能只按语言自动选择；必须在选项里显示 `edition` / `source`，并用 `default` 标记推荐项。
- 例如 `zh-Hans + original` 和 `zh-Hans + mandarin-dub` 是两条不同音轨，展示为「国语原声」和「国语配音」。
- 没有完全匹配时按优先级回退，并在播放器内提示「已切换到可用音轨/字幕」，不阻断播放。

## 用户选择交互

- 播放器工具条增加「音轨」和「字幕」两个菜单。
- 音轨菜单列出：名称、语言、版本/片源、默认标记；当前项有选中态。
- 字幕菜单额外提供「关闭」；字幕文件加载失败时保留原选择并提示。
- 选择后立即切换，不重新加载整页。
- 登录用户的选择保存到服务端；游客保存在本机；同一内容后续分集优先复用。
- 换集时重新匹配：优先用户选择，其次语言，最后默认；目标轨道不存在时回退并提示。

## 数据与接口（提案）

新增 `episode_tracks` 表：

```sql
CREATE TABLE episode_tracks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'subtitle')),
  language TEXT NOT NULL,
  edition TEXT NOT NULL DEFAULT 'original',
  label TEXT NOT NULL,
  source TEXT,
  uri TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (episode_id, kind, language, edition)
);
```

约束：

- 同一分集、同一 `kind` 最多一个 `is_default=1`。
- 字幕 `uri` 指向 WebVTT；音轨 `uri` 指向 HLS 音频播放列表。
- HLS master 使用 `EXT-X-MEDIA`：
  - 音轨：`TYPE=AUDIO`、`GROUP-ID`、`LANGUAGE`、`NAME`、`DEFAULT`、`AUTOSELECT`、`URI`。
  - 字幕：`TYPE=SUBTITLES`、`GROUP-ID`、`LANGUAGE`、`NAME`、`DEFAULT`、`AUTOSELECT`、`FORCED=NO`、`URI`。

`/api/play` 增加返回：

```json
{
  "audioTracks": [{ "id": 1, "language": "yue", "edition": "original", "label": "粤语原声", "default": true }],
  "subtitleTracks": [{ "id": 2, "language": "zh-Hans", "edition": "official", "label": "简体中文", "default": false }],
  "preferredAudio": { "language": "yue", "edition": "original" },
  "preferredSubtitle": { "language": "zh-Hans", "edition": "official" }
}
```

## 转码与导入

1. `ffprobe` 枚举源文件的音频和字幕流，记录语言、标题、声道和 codec。
2. 音频逐条转 AAC，生成独立 HLS 音频播放列表。
3. 字幕转为 WebVTT；图形字幕需要先 OCR 或保留为独立处理任务。
4. 生成 master playlist 的 `EXT-X-MEDIA` 组。
5. 导入清单可显式声明轨道；未声明时按流元数据生成，语言缺失标记为 `und`。

V1 可以先支持「已有 HLS 音轨/字幕包 + 后台录入元数据」，再补自动提取；不要为了首发重写整条转码链路。

## 后台

- 分集详情增加「音轨/字幕」列表和上传入口。
- 字段：类型、语言、版本/片源、展示名、默认、文件/URI、状态。
- 校验：语言格式、同类型唯一性、默认唯一、字幕 WebVTT、文件可访问。
- 删除默认轨道前要求先指定新的默认轨道。

## 验收

- 同一集返回多条音轨和多条字幕，播放器能列出并切换。
- 中文界面 + 粤语原声 + 简体中文字幕：默认音轨按用户选择/语言匹配，字幕按规则显示。
- 同一语言两个版本时，选项显示版本差异，不自动误选。
- 换集后保持用户选择；目标轨道不存在时回退并提示。
- 游客选择在本机保留；登录后选择可跨设备恢复。
- HLS master、API、后台、测试和文档同步。

## 非目标

- 不自动生成配音或翻译字幕。
- 不在 V1 做逐轨 DRM。
- 不改变现有清晰度切换和播放签名机制。

## 实现状态（2026-11-11）

- 轨道元数据、后台 CRUD、`/api/play` 轨道返回：已完成。
- HLS 音轨/字幕接入 CLI、WebVTT 播放列表、master `EXT-X-MEDIA` 重写：已完成。
- 播放器音轨/字幕菜单、语言/版本匹配、游客本机记忆、`track_change` 埋点：已完成并通过合成多轨浏览器验证。
- 登录用户服务端偏好：API 与测试已完成；播放器已接入，跨设备浏览器复验待补。
- 待补：真实多音轨样片验证、自动从源文件提取轨道、Safari 原生 HLS 菜单适配。
