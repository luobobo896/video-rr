# archive.org 刮削导入（非短剧内容补全）

短剧频道只有成人内容（外层不展示），片库里的电影/剧集/动漫则需要持续补量。原来的 TMDB 刮削器对成人片无效（`findTmdb` 带 `include_adult:false`），本仓库又不再镜像第三方站，所以补量通道改为 **archive.org 公开馆藏**：检索 → 选片 → 直接拉直链播放，不下载不转码。

- 解析与网络层：`server/archive.mjs`（纯函数，可单测）
- 命令行：`scripts/archive-import.mjs`
- 测试：`test/archive.test.mjs`

## 1. 来源与授权

- 检索接口 `https://archive.org/advancedsearch.php`，元数据 `https://archive.org/metadata/<id>`，片源 `https://archive.org/download/<id>/<file>`。
- 默认查询 `DEFAULT_QUERY = mediatype:movies AND licenseurl:*`，即**只要带授权声明的条目**。`--collection feature_films` 是公有领域长片集合（约 9 千条）。
- 每部剧的 `source_key` 写成 `archive:<identifier>`，可用于幂等重跑与后续 `--refresh`。
- 导入前请遵守各条目自身的授权（`licenseurl`），公有领域以外要保留署名；后台详情页的 `credit` 位可放作者。

## 2. 命令

```bash
node scripts/archive-import.mjs --collection feature_films --rows 40 --limit 20   # 首批
node scripts/archive-import.mjs --query "夜访吸血鬼" --limit 5 --dry               # 只看候选，不写库
node scripts/archive-import.mjs --refresh --limit 500                            # 回抓已入库条目，补集/改元数据
node scripts/archive-import.mjs --rows 50 --pages 3 --limit 100 --no-cover        # 大批量、不下载封面
```

| 参数 | 说明 |
|---|---|
| `--rows` | 每页检索条数，默认 25 |
| `--pages` | 翻几页，默认 1 |
| `--limit` | 最多入库多少部，默认 10 |
| `--query` / `--collection` | 检索词 / 集合（二者可叠加） |
| `--category` | 强制分类，`PLAYLET` 会被降级成 `MOVIE` |
| `--year-from` / `--year-to` | 年份过滤 |
| `--sort` | 排序字段，默认 `downloads desc` |
| `--min-duration` / `--max-episodes` | 时长下限（默认 300 秒）/ 单部最多集数（默认 60） |
| `--no-cover` | 不下载封面，只用 archive.org 缩略图 URL |
| `--no-skip-existing` | 已入库的也重新处理（默认跳过） |
| `--refresh` | 只处理 `source_key LIKE 'archive:%'` 的已有条目 |
| `--dry` | 打印候选，不写库 |

## 3. 解析规则（`server/archive.mjs`）

- **选片**：`pickVideoFiles` 只收 `mp4/m4v/webm/mkv/mov/ogv/ogm/avi`，排除 `_meta`、缩略图、字幕、`.torrent` 等伴生文件，小于 512KB 的丢弃。
- **派生版收敛**：同一部片的转码副本（`x.mp4` 与 `x_512kb.mp4`）用 `canonicalNameOf` 归一（去分隔符 + 循环剥 `512kb/h264/mpeg4/xvid/ogg/hd/sd/restored` 等后缀），再按 `FORMAT_RANK`（h264/mpeg4=3 > mkv/webm=2 > avi/xvid=1，mp4 再加 1）挑最高质量，避免一部片被拆成两集、时长翻倍。
- **集号**：`episodeNumberIn` 只认带分隔符的 `s01e02`、`ep12`、`第3集`、`part 02`、`disc1`，读不到返回 0（否则「Rocky 2」「Chaplin-1915」会被当集号）；多季折成 `season*1000 + episode`。`groupEpisodes` 先按识别集号再自然序，重复集号自动递增。
- **分类**：`categoryOf` 把 `PLAYLET` 一律降级为 `MOVIE`——**刮削器绝不生产短剧**，短剧只有成人来源。
- **地区**：`areaOf` 优先 `country`，其次语言全称（English→美国、French→法国、Japanese→日本…），都认不出留空。
- **18+**：`adultHintOf` 用关键词（porn/xxx/erotic/nudist/nudity/naked/sexploitation/sex…）扫标题、标签与简介前 300 字，命中即 `is_adult=1`，只进成人专区，外层导航/首页/筛选栏/搜索都看不到。
- **简介**：archive 的 `description` 常带 HTML，`cleanText` 去标签压空白，截到 800 字；没有简介时生成「archive.org 公开馆藏收录的影片/剧集，19xx 年，关键词：…」。

## 4. 落库与播放

- `dramas`：写 `title / sub_title(作者 · 年份) / cover_url / description / year / area / category / is_adult / content_type / source_key / published_at`，`status='published'`。
- `episodes`：`ON CONFLICT(drama_id, no) DO UPDATE`，写 `remote_url=https://archive.org/download/<id>/<file>`、`remote_referer=https://archive.org/`、`status='ready'`、`duration`。
- 播放走直链：`remotePlaybackPath` 对直链源返回 `/media/remote/<episodeId>/file.<ext>`，`pipeDirectFile` 透传 `Range` 并回 `206 / content-range`，服务端不落盘缓存（单片几百 MB）。前端 `VideoPlayer` 认出直链扩展名后直接 `video.src`，不交给 hls.js。
- 直链签名、Cookie 与 m3u8 通道一致（`mh_link_<id>` / `mh_exp_<id>`，默认 300 秒，绑 UA）。

## 5. 验收

```bash
node --test test/archive.test.mjs          # 解析纯函数
node --test test/remote-source.test.mjs    # 直链 Range 代理
node --test test/adult-visibility.test.mjs # 短剧不出外层
npm test                                   # 全量
```

跑完导入后在外层站点确认：`/api/category` 的 `facets.channels` 只有 ALL 与非零计数的电影/电视剧等频道，`PLAYLET` 只在 `audience=adult` 下出现。
