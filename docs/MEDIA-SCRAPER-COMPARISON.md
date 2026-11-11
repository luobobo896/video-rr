# 媒体刮削与元数据接入对比：Kodi、飞牛影视、Emby、Plex、VidHub

> 结论：Kodi 的公开实现最完整，适合参考 NFO 优先级、文件名解析和字段模型；Emby、Plex 的字段锁、人工纠错和本地资源支持更成熟，但现代匹配器的分数、重试和内部排序不公开；飞牛影视公开确认了“本地 NFO/图片优先、TMDB、成人标签开关”，但解析细节没有公开；VidHub 只按文件名匹配 TMDB，文件夹结构和 NFO 不参与自动匹配。五个产品都没有原生的成人 scene/performer/studio 数据模型，专业参考应看 Stash/StashDB，但必须另做数据许可、同意与年龄验证审查。

来源口径：文中 `[Sxx]` 指第 10 节来源表；所有链接的访问日期均为 **2026-11-10**。`官方源码` 表示可读实现，`官方文档` 表示厂商说明，`可观察/可配置` 表示文档或界面确实存在该行为，`推断` 和 `未公开` 均会单独标注。未找到公开资料不等于产品一定没有该能力。

## 1. 执行摘要

### 1.1 五个产品对比

| 产品 | 公开程度 | 自动识别主依据 | 元数据与图片来源 | 本地 NFO/嵌入标签 | 人工纠错 | 多语言/地区 | 成人专项 |
|---|---|---|---|---|---|---|---|
| **Kodi** | 官方 Wiki 完整，电影和剧集 TMDB 刮削器源码公开 `[S01][S13][S17]` | 文件/文件夹标题、年份、TMDb/IMDb/TVDB ID；NFO 中的 ID 可直接锁定条目 `[S02][S04][S18]` | TMDb；可选 IMDb/Trakt 评分、Fanart.tv 图片 `[S14][S15][S19]` | NFO 始终优先；嵌入标签可开关，NFO 覆盖嵌入信息 `[S01][S10]` | 信息页 Refresh，选择候选或输入 ID；NFO Parsing 文件 `[S12]` | 详情语言、搜索语言、图片语言、认证国家分别配置 `[S16][S21]` | 无专门成人模型；只有通用电影/TMDB 字段 |
| **Emby** | 官方文档、公开 API schema、公开 NFO 解析器 `[S22][S31][S32]`；服务端核心本报告未找到官方公开源码 | 文件名、年份、TMDb/TVDB/IMDb ID、NFO、Identify 搜索 `[S24][S25]` | TMDb、TVDB；图片源包括 Fanart.tv、TMDb、OMDb、TVDB `[S23]` | 支持 NFO reader/saver；本地 reader、provider、image fetcher 顺序可配置 `[S27][S32]` | Identify、输入数据库 ID、字段/条目锁 `[S23][S24]` | 库级 metadata language、image language、country `[S32]` | LibraryOptions 含 `EnableAdultMetadata`，没有公开的成人专用 schema `[S32]` |
| **Plex** | 官方支持文档完整 `[S34][S36][S37]`；现代 agent 官方公开源码本报告未找到 | 文件名、文件夹、ID、`.plexmatch`、可选 NFO Agent `[S40][S41][S42]` | Plex 在线元数据；NFO Agent 可完全本地；评分源可选 `[S36][S40]` | 可选 NFO Agent（PMS 1.43.1+），不是所有库默认读 NFO `[S40]` | Fix Match、Unmatch、字段锁、手选海报 `[S38][S39][S51]` | 库语言、原始标题开关、按库语言选图、认证国家 `[S36][S37]` | `Allow matching to explicit content` 开关；通用电影字段 `[S36][S37]` |
| **飞牛影视 fnOS** | 官方帮助页为主；影视内部实现本报告未找到官方公开源码 `[S53]` | 文件名、TMDB、NFO；完整解析规则未公开 `[S53]` | 官方帮助只明确 TMDB；本地 NFO 和本地图片优先 `[S53]` | 有“优先读取本地 NFO 和图片”开关；其他视频类型也会读 NFO `[S53]` | 社区帖和官方回复确认存在手动匹配；官方帮助未系统说明 `[S54]` | 元数据下载语言；标题、简介、海报、演员受语言影响 `[S53]` | 按 TMDB 成人标签过滤，默认关闭；未标记的成人内容可能漏过 `[S53]` |
| **VidHub** | 官方教程完整 `[S55][S59]`；内部实现本报告未找到官方公开源码 | **只使用文件名**；文件夹名和结构不参与自动匹配 `[S55]` | TMDB `[S55]` | 官方文档没有说明 NFO 或嵌入标签支持 `[S55]` | Edit Information 重新搜索电影/剧集，或改文件名 `[S58]` | Online Metadata Language；可跟随系统 `[S56]` | 没有公开的成人开关或成人 schema |

### 1.2 官方文档、源码与推断边界

| 产品 | 官方明确 | 可观察/可配置 | 推断或未公开 |
|---|---|---|---|
| Kodi | NFO 顺序、字段、命名、版本、Extras、电影/剧集刮削流程 `[S01][S02][S03][S13][S17]` | NFO 覆盖嵌入标签；版本按重复 ID 或 Title+Year 归并 `[S08][S10]` | 刮削器没有数值置信度字段；Kodi 核心如何最终选中候选，本文不归因给 add-on `[S14]` |
| Emby | 刷新全部/仅缺失、替换图片、Identify、字段锁；NFO 解析映射；provider/fetcher 顺序配置 `[S22][S23][S27][S31]` | 本地 reader 顺序、metadata fetcher 顺序、image fetcher 顺序 `[S32]` | 匹配分数、重试次数、合并算法没有公开；官方明确拒绝给出“通用优先级表” `[S29][S30]` |
| Plex | 扫描与刷新区别、Fix Match、Unmatch、NFO Agent、PlexMatch、Editions/Versions、字段锁 `[S34][S38][S39][S40][S43][S45][S51]` | NFO Agent 本地图片优先，缺图时才联网；custom agent 可组合 provider `[S40]` | 现代 Plex 在线匹配器的 provider 列表、分数、重试、模糊匹配阈值未公开 |
| 飞牛影视 | 实时文件更新、NFO 优先、元数据语言、成人标签、首次扫描流程 `[S53]` | 手动匹配、重新匹配入口 `[S54]` | 文件名解析、匹配分数、重试、NFO 锁、版本/合集/Extras 模型未公开 |
| VidHub | 文件名唯一自动匹配依据、TMDB、SxxExx、S00、语言、手动纠错 `[S55][S56][S58]` | Rescan Files、Refresh Online Metadata、后台刮削 `[S57][S59]` | NFO、嵌入标签、hash、成人过滤、内部重试均未在官方文档中说明 |

## 2. 每个产品的抓取工作流

### 2.1 Kodi：扫描 → NFO/文件名 → TMDb → 本地库

1. **触发与扫描**：执行 Update Library 或对来源执行 Scan for new content；Kodi 先找 NFO，再按 Source 的 scraper 设置联网。NFO 存在时优先于 scraper 和嵌入标签 `[S01][S10]`。
2. **识别**：扫描器把标题、年份和可选 ID 交给 add-on。电影先精确匹配 title+year；无结果时依次尝试 year-1、year+1、不限制年份；首页没有高热度精确匹配时再查第 2 页 `[S14]`。NFO 中的 TMDb/IMDb ID 可直接形成精确 lookup `[S18][S20]`。
3. **元数据抓取**：电影请求 TMDb details，并附带 trailers、images、releases、credits、keywords；剧集附带 credits、aggregate credits、content ratings、external IDs、images、videos、keywords `[S14][S19]`。可选 IMDb/Trakt 评分，Fanart.tv 是独立可选图片源 `[S14][S15][S19]`。
4. **图片抓取**：TMDb poster/backdrop/logo 先按详情语言、再按英文、再任意语言；本地图片由 Kodi 素材规则处理，在线图片默认进入缓存 `[S11][S14]`。
5. **持久化与刷新**：元数据进入 MyVideos 数据库，图片进 artwork cache；刷新单个条目时重新调用 scraper。v21 的版本集合把子版本移入 `videoversion` 表，子版本复用父条目元数据 `[S08]`。

### 2.2 Emby：实时监控 → local reader/provider → 字段合并 → 可选 NFO 回写

1. **触发与扫描**：库可开启实时监控（仅支持的文件系统），文件新增或变化时触发更新；也支持定时任务和手动 Refresh Metadata `[S22]`。
2. **识别**：文件名/文件夹名、`[tmdbid=...]` 等 ID 标签、NFO、Identify 搜索都可参与。管理员可在 Identify 中输入标题、年份、ID 等信息搜索候选 `[S24][S25][S26]`。
3. **元数据抓取**：官方把流程拆成 local reader、remote provider、image provider、selection/merge、saver；具体 provider 和 image fetcher 顺序由 LibraryOptions 配置 `[S27][S28][S32]`。元数据主源是 TMDb/TheTVDB，图片源包括 Fanart.tv、TMDb、OMDb、TheTVDB `[S23]`。
4. **图片抓取**：库设置控制图片下载、语言和图片类型；每个条目可编辑图片、搜索其他图片源或填 URL `[S23][S33]`。
5. **持久化与刷新**：写入服务端数据库；可配置把 NFO 和图片保存到媒体目录。Refresh 分“覆盖全部字段”和“只补缺失字段”，替换图片会删除现有图片；手动改过的字段可锁住 `[S23]`。

### 2.3 Plex：扫描 → match → 在线/本地 provider → 数据库 → 刷新

1. **触发与扫描**：新增内容、自动监控、周期扫描或手动 Scan Library Files 会把文件纳入库；Refresh Metadata 则对已有条目重新取元数据 `[S34]`。
2. **识别**：Plex 先扫描技术属性并生成缩略图，再由 agent 匹配。匹配输入包括文件名、文件夹、`{tmdb-...}`/`{imdb-...}`、`.plexmatch`，或使用 NFO Agent 从 `uniqueid` 直接建立身份 `[S34][S40][S41][S42]`。
3. **元数据抓取**：Plex Movie/Series agent 从在线源取标题、简介、年份、海报、演职员等；评分源可选 Rotten Tomatoes、IMDb、TMDb。选择 NFO Agent 时可由 NFO/本地资源独立提供，或用 custom agent 与 Plex provider 组合 `[S36][S40]`。
4. **图片抓取**：本地 assets 开关打开时优先本地 poster/background/logo；按库语言偏好本地化海报；缺图时才从在线 provider 取 `[S36][S37][S46][S47][S48]`。
5. **持久化与刷新**：写入 Plex 数据库；手改字段会加锁，刷新不会覆盖锁定字段。电影 Editions、电影/TV Versions 分别表达不同剪辑和同剪辑的不同编码版本 `[S43][S44][S45][S51]`。

### 2.4 飞牛影视：首次扫描 → 本地 NFO/图片 → TMDB → 元数据目录

1. **触发与扫描**：创建媒体库后自动开始首次扫描，包含识别文件、刮削、识别内嵌字幕和下载字幕；开启实时监控后，文件变化会主动推送更新，官方称不会频繁轮询影响硬盘休眠 `[S53]`。
2. **识别**：官方只说明按文件名搜索 TMDB，并支持本地 NFO；具体文件名解析器、候选排序和模糊匹配规则未公开 `[S53]`。
3. **元数据抓取**：官方帮助明确列出 TMDB；元数据下载语言影响名称、介绍、海报、演员信息。内容类型只用于管理媒体库，不影响刮削；选“其他视频”时不联网刮削，但仍读本地 NFO `[S53]`。
4. **图片抓取**：开启“优先读取本地 NFO 和图片”后，本地目录图片优先，只从互联网补缺失信息；未发现官方文档列出独立图片 provider `[S53]`。
5. **持久化与刷新**：安装时选择影视刮削元数据保存的存储空间；本地 NFO/图片与在线元数据共同进入影视库。NFO 锁、字段锁和重试策略没有公开说明 `[S53]`。

### 2.5 VidHub：文件源导入 → 文件名匹配 TMDB → 手动纠错

1. **触发与扫描**：添加文件夹作为文件源后自动搜索并导入视频；Rescan Files 处理新增、删除、改名；App Store 版本记录显示 3.1.1 支持后台刮削 `[S57][S59][S60]`。
2. **识别**：**文件名是唯一自动匹配依据**，文件夹名和目录结构不影响匹配；电影用标题和可选年份，剧集用标题、年份和 SxxExx `[S55]`。
3. **元数据抓取**：官方明确来自 TMDB；“Refresh Online Metadata”会在修改 Online Metadata Language 后重新获取电影和剧集信息 `[S55][S56]`。
4. **图片抓取**：官方只明确刮削封面/海报和演员信息，没有公开图片类型、语言和尺寸选择规则 `[S55]`。
5. **持久化与刷新**：媒体库信息可通过 iCloud 同步；改名会重新刮削；手动 Edit Information 可改电影/剧集身份，剧集某一季的修改会更新同季其他集 `[S56][S57][S58]`。

## 3. 数据来源与匹配

| 产品 | 本地 NFO | 嵌入标签 | 文件名 | Provider API | ID/哈希 | 置信度与模糊匹配 | 手动识别 |
|---|---|---|---|---|---|---|---|
| **Kodi** | 有，且始终先查 `[S01]` | 有，`Use video tags` 默认关闭，NFO 覆盖 `[S10]` | 标题（年份）、SxxEyy、ID 标签 `[S04][S07]` | TMDb、IMDb/Trakt 评分、Fanart.tv `[S14][S15]` | TMDb/IMDb/TVDB；无内容哈希 `[S02][S14]` | 无公开数值分数；精确 title+year、年份降级、热度排序 `[S14]` | Refresh 后选候选或输入 ID `[S12]` |
| **Emby** | reader/saver；顺序可配置 `[S27][S32]` | “Prefer embedded titles over filenames” `[S22]` | 标题、年份、ID 标签 `[S24][S25]` | TMDb、TVDB；图片 Fanart.tv/TMDb/OMDb/TVDB `[S23]` | TMDb/TVDB/IMDb；无公开内容哈希 | 内部匹配分数和重试未公开；官方明确不发布通用优先级 `[S29][S30]` | Identify、输入 ID、锁字段 `[S23][S24]` |
| **Plex** | 可选 NFO Agent；支持 Kodi NFO `[S40]` | “Prefer local metadata” `[S36][S37]` | 标题（年份）、SxxExx、ID、`.plexmatch` `[S41][S42]` | Plex 在线源；NFO/local；评分源可选 `[S36][S40]` | TMDb/TVDB/IMDb；`.plexmatch` GUID；无公开内容哈希 | 现代 agent 无公开分数；Fix Match 只展示候选 `[S38]` | Fix Match、Unmatch `[S38][S39]` |
| **飞牛影视** | 有，优先本地 NFO/图片 `[S53]` | 未公开 | 文件名；解析细节未公开 `[S53]` | 官方只明确 TMDB `[S53]` | 未公开 | 无公开分数/阈值 | 手动匹配存在，官方帮助未系统说明 `[S54]` |
| **VidHub** | 官方文档未提及 | 官方文档未提及 | **唯一依据**；文件夹无效 `[S55]` | TMDB `[S55]` | 未公开 | 无公开分数/阈值 | Edit Information `[S58]` |
| **Stash（外部参考）** | 官方 scraping 文档未把 Kodi NFO 列为主路径 | 官方 scraping 文档未列为主路径 | Filename parser、查询、URL/fragment `[S61]` | stash-box GraphQL、社区 scrapers、站点 scraper `[S61][S62]` | pHash、oshash、md5 + duration `[S61]` | 指纹匹配数量 + 人工选择；Identify 首个命中源 `[S61][S67]` | Tagger、Identify task `[S61]` |

补充判断：

- **ID 是最强证据**。五个通用产品都支持 TMDb/IMDb/TVDB 一类的外部 ID；NFO 中的 `uniqueid` 和 Plex `.plexmatch` 都比标题模糊匹配稳定 `[S02][S24][S40][S41]`。
- **标题模糊匹配不是公开概率**。Kodi 的 add-on 只有“精确标题+年份”“标题包含”“热度”等启发式规则 `[S14]`；Emby、Plex、飞牛、VidHub 没有公开可校准的分数。
- **哈希不是通用媒体库的默认能力**。Kodi、Emby、Plex、飞牛、VidHub 的公开文档没有把内容 hash 作为主匹配依据；Stash 把 pHash/oshash/md5 作为核心证据 `[S61]`。

## 4. 元数据字段覆盖

“完整”表示官方字段表或公开源码确认有对应字段；“部分”表示只确认部分字段，完整 schema 未公开。provider 不一定填满所有字段，字段是否存在与实际是否有值要分开看。

| 字段组 | Kodi | Emby | Plex | 飞牛影视 | VidHub |
|---|---|---|---|---|---|
| 标题、原名、排序名 | 完整 `[S02]` | 完整 `[S27][S31]` | 完整 `[S40]` | 部分：名称已明确 `[S53]` | 部分：标题/年份 `[S55]` |
| 简介、标语 | 完整 `[S02]` | 完整 `[S27]` | 完整 `[S40]` | 部分：介绍 `[S53]` | 部分：影视信息 `[S55]` |
| 年份、首映/发行日期、时长 | 完整 `[S02]` | 完整 `[S27]` | 完整 `[S40]` | 部分：年份/时长未明确 `[S53]` | 部分：年份 `[S55]` |
| 类型、标签 | 完整 `[S02]` | 完整 `[S27]` | 完整 `[S40]` | 部分：未列完整字段 | 部分：未列完整字段 |
| 评分、内容分级 | 完整，支持多评分源 `[S02]` | 完整 `[S23]` | 完整，评分源可选 `[S36]` | 未公开 | 未公开 |
| 演员、导演、编剧、制片厂/电视网、国家 | 完整 `[S02][S03]` | 完整 `[S27]` | 完整 `[S40]` | 部分：演员已明确 `[S53]` | 部分：演员已明确 `[S55]` |
| 合集/系列 | 完整 `[S02]` | 完整 `[S27]` | 完整 `[S40]` | 未公开 | 未公开 |
| 外部 ID | 完整 `[S02]` | 完整 `[S32]` | 完整 `[S40]` | 未公开 | 未公开 |
| 海报、背景、Logo、Banner 等 | 完整 `[S11]` | 完整 `[S33]` | 完整 `[S46][S47]` | 部分：海报/图片 `[S53]` | 部分：封面/海报 `[S55]` |
| 预告片、Extras | 完整，v21 电影 Extras `[S09]` | 完整 `[S25][S26]` | 完整 `[S49][S50]` | 未公开 | 未公开 |
| Editions、Versions | 完整，v21 电影版本集合 `[S08]` | 部分：多版本标签，不是独立 Edition 实体 `[S25][S26]` | 完整，电影/TV Editions + Versions `[S43][S44][S45]` | 未公开 | 未公开 |
| 成人专用字段 | 无 | 有成人开关，无公开 schema `[S32]` | 有成人匹配开关，无公开 schema `[S36]` | 有成人标签过滤，无公开 schema `[S53]` | 未公开 |

## 5. 文件名与目录解析

| 产品 | 电影 | 剧集/季/集 | Edition 与多版本 | Extras | 动漫绝对编号 |
|---|---|---|---|---|---|
| **Kodi** | `Movie Name (Year)`；可选 `{tmdb=...}` 等 ID `[S04]` | 剧集文件夹 `Show Name (Year)`；季文件夹名称不参与刮削；`S01E02` 最准确 `[S05][S06]` | v21 父/子版本集合；电影不同剪辑可作版本；子版本复用父元数据 `[S08]` | 电影目录下的 `Extras` 文件夹；v21 仅电影 `[S09]` | 支持无季的 `ep02.ext`、`102.ext`，官方说明常用于动漫；支持 TMDb Episode Groups `[S06]` |
| **Emby** | `MovieName (Year)`；ID 标签；多版本必须在同一电影文件夹，文件名以 ` - label` 区分 `[S25]` | `Series (Year)/Season N/Episode`；支持 `S01E01`、`1x02`、`102`、日期等 `[S26]` | 电影多版本最多 8 个；剧集多版本也最多 8 个，` - Display Name` 进入版本选择器 `[S25][S26]` | 电影、剧集、季、集级 `extras/interviews/...` 或 `-behindthescenes` 等后缀 `[S25][S26]` | 官方只列出 `102` 形式，没有独立 Absolute Order 语义 `[S26]` |
| **Plex** | `MovieName (Year)`；`{imdb-...}`/`{tmdb-...}`；可用于匹配 `[S42]` | `ShowName (Year)/Season 01/Show - s01e01`；日期式、迷你剧、Specials `[S43]` | 电影 `{edition-...}` 区分剪辑；` - ArbitraryText` 合并同剪辑版本；TV 支持 show 级 edition `[S44][S45][S46]` | `-behindthescenes` 等后缀或 Extras 子目录 `[S49][S50]` | TVDB `Absolute` order；`.plexmatch` 可覆盖季/集提示 `[S41][S42]` |
| **飞牛影视** | 未公开；官方只说明文件名参与 TMDB 搜索 `[S53]` | 未公开 | 未公开 | 未公开 | 未公开 |
| **VidHub** | 文件名以完整标题开头，歧义时加年份 `[S55]` | 文件名必须含 `SxxExx`；歧义时加首播年份 `[S55]` | 未公开；文件夹名不参与 | Specials/Extras 统一以 `S00E01` 形式当特别篇 `[S55]` | 未公开；仅 SxxExx |

补充：

- Kodi 的季文件夹名称不重要，集文件名中的 `SxxEyy` 才是核心；NFO 不能设置季/集编号 `[S06]`。电影 `movie.nfo` 只有在“电影在独立文件夹中”设置开启时才扫描，`<VideoFileName>.nfo` 更稳 `[S02]`。
- Emby 的多版本标签用于区分同一作品的画质或剪辑，官方提醒不同剪辑可能有功能限制；没有像 Plex Editions 那样的独立实体 `[S25]`。
- Plex 的 Extras、Editions 和 Versions 是三个不同层次：Extras 是附加视频，Editions 是不同发行剪辑，Versions 是同一剪辑的不同编码/清晰度 `[S43][S44][S49]`。
- 飞牛影视公开帮助没有给出完整命名规范。官方仅确认内容类型不影响刮削、其他视频类型不联网但读 NFO；不能从这份文档推断其季集正则或版本模型 `[S53]`。
- VidHub 明确放弃文件夹结构参与匹配，因此同一剧集分散在多个目录、多个版本或本地 Extras 目录时，自动归并能力弱于 Kodi/Plex/Emby `[S55]`。

## 6. 多语言与地区

| 产品 | 元数据语言 | 标题/简介回退 | 图片语言 | 认证/地区 |
|---|---|---|---|---|
| **Kodi** | `language` 控制详情，`searchlanguage` 可单独控制搜索 `[S16]` | 电影缺 overview/tagline 时回退英文；剧集缺 overview、季名、集名时回退 en-US `[S14][S19]` | 图片按详情语言、英文、任意语言排序；Fanart.tv 有独立语言设置 `[S14][S19]` | `tmdbcertcountry` 指定认证国家，`certprefix` 控制显示前缀 `[S16]` |
| **Emby** | 库级 `PreferredMetadataLanguage`；国家 `MetadataCountryCode` `[S32]` | 官方没有公开逐字段回退顺序；NFO 和 provider 可同时提供候选 `[S29][S30]` | `PreferredImageLanguage`；图片 provider 可配置顺序 `[S32]` | 认证字段属于条目 metadata，实际 provider 覆盖取决于库配置 `[S27]` |
| **Plex** | 库语言，可勾选 Use original titles `[S36][S37][S52]` | 官方没有公开标题/简介回退链；Fix Match 可改搜索语言 `[S38]` | `Prefer artwork based on library language` `[S36][S37]` | `Certification Country` 影响使用的分级体系 `[S36][S37]` |
| **飞牛影视** | 媒体库“媒体元数据下载语言” `[S53]` | 官方没有公开回退链；语言影响名称、简介、海报、演员 `[S53]` | 官方把海报纳入元数据语言影响范围 `[S53]` | 没有公开认证国家设置 |
| **VidHub** | `Online Metadata Language`，可跟随系统 `[S56]` | 没有公开回退链；改语言后需 Refresh Online Metadata `[S56]` | 没有公开图片语言规则 | 没有公开认证设置 |

结论：只有 Kodi 的回退链能从公开源码逐字段确认；Emby、Plex、飞牛、VidHub 都有语言配置，但公开资料不足以证明“标题用 A 语言、简介用 B 语言、图片用 C 语言”的具体顺序。

## 7. 失败兜底与人工修正

| 产品 | 重试/Provider 回退 | 未匹配状态 | 人工修正 | 覆盖保护 |
|---|---|---|---|---|
| **Kodi** | 电影搜索 year±1、无年份、第 2 页；缺简介回退英文；可选 IMDb/Trakt/Fanart provider `[S14][S15][S19]` | 没有独立 `unmatched` API；事件日志记录未刮削文件 `[S12]` | Refresh 条目，选择候选，输入 TMDb/IMDb ID，或建 Parsing NFO `[S12]` | NFO 优先；没有通用字段锁；NFO 本身可作为覆盖层 |
| **Emby** | 刷新全部/仅缺失、替换图片；provider/fetcher 顺序可配 `[S23][S32]` | Identify 页面可重新搜索；错误匹配可换 ID `[S23][S24]` | Identify、输入数据库 ID、编辑字段 `[S23][S24]` | 字段锁或整条锁定，刷新不覆盖 `[S23]` |
| **Plex** | Refresh、自定义 agent 顺序；NFO Agent 无本地图时联网补图 `[S35][S40]` | Unmatch 回到未匹配状态；可手填信息 `[S39]` | Fix Match、Unmatch、手选海报 `[S38][S39][S51]` | 编辑字段自动加锁，刷新不覆盖锁定字段 `[S51]` |
| **飞牛影视** | 本地 NFO/图片优先，只补互联网缺失；重试策略未公开 `[S53]` | 官方帮助未系统说明 | 手动匹配入口存在，官方论坛回复提到会优化 `[S54]` | 未公开 |
| **VidHub** | Rescan Files、Refresh Online Metadata；重试策略未公开 `[S56][S57]` | 未匹配/归为“Other”，可 Edit Information 改类别 `[S58]` | 改文件名或 Edit Information 重新搜索 `[S55][S58]` | 没有 NFO 锁；文档未说明字段锁 |

失败处理的关键差异：

1. **Kodi 把 NFO 当成最终覆盖层**，因此“修好 NFO 再 Refresh”是最可控的路径 `[S01][S02]`。
2. **Emby 和 Plex 把“锁定”做成产品能力**，适合人工修正后防止刷新回退 `[S23][S51]`。
3. **飞牛的本地优先是一个库开关**，不是无条件 NFO-first；NFO 锁和回退顺序没有公开 `[S53]`。
4. **VidHub 没有本地元数据侧车机制**，改名是最快的重新匹配方式 `[S55][S58]`。

## 8. 成人视频元数据支持（技术边界）

本节只讨论字段、匹配来源和合规边界，不描述具体内容。

### 8.1 五个产品的能力边界

| 产品 | 成人开关/策略 | 是否有场景、表演者、厂牌的原生模型 | 主要来源 | 结论 |
|---|---|---|---|---|
| **Kodi** | 没有专门成人开关；TMDB 电影 scraper 设置中没有成人参数 `[S14][S16]` | 没有；只有通用 movie/TV 字段 | TMDb、NFO | 可存 title/studio/actor 等通用字段，无法表达场景编号、表演者关系、同意记录 |
| **Emby** | LibraryOptions 含 `EnableAdultMetadata` `[S32]` | 没有公开 schema；使用通用 movie/TV/NFO | TMDb/TVDB/NFO/第三方插件 | 有开关，不等于有成人数据模型 |
| **Plex** | `Allow matching to explicit content`，会影响 Fix Match 结果 `[S36][S37]` | 没有公开 schema；使用通用 movie/NFO | Plex 在线源/NFO | 可打开匹配，但元数据仍是通用电影字段 |
| **飞牛影视** | “媒体元数据允许成人内容”，默认关闭；按 TMDB 成人标签判断 `[S53]` | 没有公开 schema | TMDB | 依赖 TMDB 标签，未标记的成人内容可能漏过 `[S53]` |
| **VidHub** | 官方文档没有成人开关 | 没有 | TMDB | 未公开，不能推断 |
| **Stash（外部参考）** | 不是五产品之一；专业场景管理器 | 有 Scene、Performer、Studio、Group、Tag、StashID | StashDB、stash-box、社区 scraper、站点 scraper | 可作为 schema 参考，不是现成合规来源 |

### 8.2 请求字段在 Stash 中的落点

Stash 的 Scene 包含 `title`、`code`、`details`、`director`、`urls`、`date`、`production_date`、`studio`、`performers`、`tags`、`groups`、`stash_ids` 等字段 `[S63]`。以下是“业务字段 → 模型落点”的对照。

| 字段 | Stash 原生落点 | 适配判断 |
|---|---|---|
| 标题 | `Scene.title` | 原生 |
| 厂牌 studio | `Scene.studio → Studio` `[S65]` | 原生 |
| 发行标签 label | 没有一等 `label` 字段；只能用 `Studio.parent_studio/child_studios` 或 `custom_fields` `[S65]` | 需要独立 label 实体或合同映射 |
| 系列/合集 | `Scene.groups → Group`；旧 `movies` 已弃用 `[S63][S66]` | 原生，但语义是分组，不保证等于发行系列 |
| 表演者 | `Scene.performers → Performer[]` `[S64]` | 原生；不要只存名字字符串 |
| 导演 | `Scene.director` | 原生，单值 |
| 发行日期 | `Scene.date` / `production_date` | 原生，两个日期含义不同 |
| 时长 | 从视频文件对象的 `duration` 派生 | 文件属性，不是 Scene 根字段 |
| 场景/作品编号 code | `Scene.code` | 原生 |
| 类型/标签 | `Scene.tags → Tag[]` | 原生 |
| 国家/地区 | `Performer.country`；Scene 没有国家字段 `[S64]` | 部分；需要自定义字段或作品级地区 |
| 语言 | Scene 没有语言字段；字幕对象有 `VideoCaption.language_code` `[S63]` | 部分；不能当作品主语言 |
| 封面/剧照 | `cover_image` 写入；`paths.screenshot/preview` 输出 `[S63]` | 原生，但属于场景素材 |
| Fanart | Scene 没有 fanart 字段 `[S63]` | 需要外部素材或自定义 |
| 预告片 trailer | Scene 没有 trailer 字段；`urls` 可存源链接，但语义不受约束 | 不是一等字段 |
| 内容分级 | Scene 没有 content rating 字段 | 需要策略层或外部分级 |
| 来源 URL | `Scene.urls` | 原生 |
| Provider IDs | `Scene.stash_ids → StashID(endpoint, stash_id)` `[S68]` | 原生，但不是 TMDb/IMDb 通用 ID |

这张表说明：Stash 比通用媒体库更接近成人场景语义，但仍缺 label、作品语言、内容分级、fanart 和 trailer 的一等字段。若项目要做成人适配，不能直接把通用 `dramas` 表加几个字段了事，至少要独立 `scene/performer/studio/label/group` 关系。

### 8.3 来源类型与匹配方式

| 来源类型 | 代表 | 优势 | 风险与边界 |
|---|---|---|---|
| 结构化 Provider API | TMDb、TVDB、Plex 在线源、stash-box GraphQL `[S36][S67]` | 稳定 ID、语言参数、可重复查询 | 许可、速率、字段覆盖、成人内容政策 |
| 社区数据库 | StashDB、ThePornDB `[S61][S62]` | 覆盖面、人工校对、指纹关联 | 数据许可不清、质量波动、删除/撤回机制 |
| NFO/本地元数据 | Kodi、Emby、Plex NFO Agent、飞牛 `[S01][S27][S40][S53]` | 离线、可控、可版本化 | 通用字段无法表达成人场景语义 |
| 嵌入文件标签 | Kodi、Emby、Plex `[S10][S22][S36]` | 随文件移动、离线可用 | 字段少、易被错误写入、缺少关系模型 |
| Hash/指纹 | Stash/StashDB 的 pHash、oshash、md5 + duration `[S61][S71]` | 对文件名不敏感，适合重复文件 | 转码/剪辑会改变指纹；不是作品身份；需要隐私和滥用控制 |
| 人工匹配 | 五个产品都支持某种形式 `[S12][S24][S38][S54][S58]` | 精度最高，能处理长尾 | 人力成本、权限审计、错误传播 |

匹配证据强度可以按以下顺序落地：**合同范围内的一等 ID > NFO `uniqueid` > 精确标题+年份 > 标题近似+年份±1 > 纯模糊搜索 > 人工确认**。Stash 的 Identify 任务也是“按顺序尝试来源，首个命中的来源生效”，并允许字段级 `MERGE/OVERWRITE/IGNORE` 和跳过多个匹配 `[S67]`。

### 8.4 合规、同意与数据许可

1. **年龄与同意不是普通元数据字段**。StashDB 明确表示自身无法逐一验证表演者年龄和同意，只能依赖专业工作室或经年龄/身份验证的平台；任何已知涉及未成年人的内容一律不允许 `[S70]`。这说明成人适配必须把 `age_verified`、`consent_evidence`、`source_license`、`takedown_contact` 做成合规数据，不能只存标题和海报。
2. **数据许可与软件许可要分开看**。stash-box 软件是 MIT，StashDB 文档仓库是 AGPL，但这不等于 StashDB 数据库内容可以自由商用；本报告没有找到明确的开放数据许可声明，不能把“代码开源”当成“数据可商用” `[S69][S72]`。
3. **TMDb 条款是硬约束**。TMDb API 条款要求署名、默认缓存不超过 6 个月、商业使用需单独书面协议，并限制将 API 用于 pornographic 等材料；这会直接影响本项目以及任何把 TMDb 当成人主源的方案 `[S73]`。
4. **成人内容还涉及内容许可、表演者肖像/隐私、地区法律和记录保存义务**。这些义务因司法辖区而异，必须由法务确认；本报告不构成法律意见。
5. **不要抓取任意成人站点**。站点条款、版权、同意范围和删除机制都可能不同；没有书面许可时，优先使用有合同的 provider，或只保存用户本地文件的元数据引用。
6. **不做成人图像生成或再分发**。如果素材许可不包括缓存/转码/公开展示，最多保存来源 URL 和授权状态，不把图片复制到自有 CDN。

## 9. 差异与本项目可借鉴的方案

### 9.1 关键差异

- **Kodi 最适合抄流程，不适合直接抄产品体验**：NFO-first、ID 解析、版本集合、字段表都可读；但 Kodi 核心的候选选择、刷新队列和 UI 纠错不在 add-on 源码里 `[S01][S14]`。
- **Emby 的强项是“可配置 + 可锁”**：本地 reader、provider、image fetcher 都有顺序配置，NFO reader/saver 和字段锁完整；代价是内部匹配算法不可见 `[S27][S32]`。
- **Plex 的强项是“身份修正和版本表达”**：Fix Match/Unmatch、字段锁、Editions/Versions、可选 NFO Agent 都很成熟；现代在线匹配器仍是黑盒 `[S38][S39][S43][S45]`。
- **飞牛影视的公开策略最简单**：NFO/图片优先，TMDB 补缺，成人标签过滤；适合参考库级开关，不适合照搬内部匹配 `[S53]`。
- **VidHub 适合轻量文件库**：文件名唯一、TMDB 唯一、手动改信息；对多版本、NFO、本地 Extras 和复杂目录的支撑明显弱 `[S55][S58]`。
- **成人元数据要走独立域**：五个产品都没有原生成人 schema；Stash 可作为字段参考，但无法替代许可、同意和年龄验证 `[S63][S70][S73]`。

### 9.2 Provider Adapter 抽象

当前项目 `server/tmdb.mjs` 已经借鉴了 Kodi 的标题/原名/年份/类型排序和图片语言偏好 `[S14]`；`server/scrape.mjs` 也有 catalog → TMDb → cache → remote → draft 的降级链。下一步应把这些行为放进稳定接口，而不是继续在单一函数里堆 provider 分支。

```ts
type MediaType = "movie" | "tv";

interface MetadataProvider {
  id: string;
  capabilities: {
    local?: boolean;
    externalIds?: Array<"tmdb" | "imdb" | "tvdb" | "stash">;
    artwork?: boolean;
    adult?: boolean;
    hashes?: boolean;
  };
  search(query: SearchQuery, locale: string): Promise<Candidate[]>;
  details(providerId: string, locale: string): Promise<MediaRecord>;
  artwork?(providerId: string, locale: string): Promise<Artwork[]>;
}

interface Candidate {
  provider: string;
  providerId: string;
  title: string;
  originalTitle?: string;
  year?: number;
  type: MediaType;
  evidence: {
    idMatch?: boolean;
    titleMatch?: "exact" | "normalized" | "partial";
    yearDelta?: number;
    popularity?: number;
  };
}
```

### 9.3 对本项目的具体建议

1. **先加本地 NFO provider，再查 TMDb**。按 Kodi/Emby/Plex 的共同点，解析 `title/originaltitle/plot/premiered/genre/studio/uniqueid/actor/director/credits`；NFO 的 `uniqueid` 直接进入 ID 匹配。不要让 NFO 失败后静默退回同名模糊匹配。
2. **把匹配证据写进数据，不只写一个 `source` 字符串**。当前 `dramas` 只有 `title/sub_title/cover_url/description/year/area/category/score` 等字段，`scrape_cache` 只存 JSON（见 `server/db.mjs`、`server/scrape.mjs`）。最小改动是增加 `match_status`、`match_method`、`match_score`、`matched_provider`、`matched_provider_id`、`candidate_json`；高置信度才自动发布，低置信度进入人工确认。
3. **区分 ID 匹配和标题模糊匹配**。TMDb/IMDb/TVDB ID 命中可直接视为强匹配；标题+年份精确命中共次；仅标题包含或年份相差 1 年应进入 `needs_review`。当前 `rankResult` 的加权分数可以保留，但必须输出每一分的证据，便于排错。
4. **多语言按字段存，不覆盖单一值**。现在 `server/tmdb.mjs` 只在 `overview` 缺失时回退 en-US；建议扩展到 title/originaltitle/tagline/overview，并保存 `locale` 和 `is_fallback`。图片同样按 `zh-CN → en → textless → any` 选，并记录语言、宽高、来源。
5. **图片先本地、后在线，且按类型建模**。当前 `server/artwork.mjs` 的“本地抽帧 → archive.org → TMDb → 远程封面”方向正确；下一步把 poster/backdrop/logo/banner/thumb 分表或至少分字段，记录 `kind/language/width/height/source/license`。不要把“用海报模糊放大成横幅”当成默认横幅，它应是明确标记的 fallback。
6. **人工纠错要做成状态机**。增加 `unmatched / needs_review / matched / manual_locked` 四态；支持按 TMDb/IMDb ID 重新匹配、取消匹配、锁定字段、恢复自动值。Plex 的字段锁和 Emby 的 Identify 都验证了这条路径 `[S23][S51]`。
7. **NFO 锁用内容 hash 实现**。保存 NFO 文件的 hash、mtime 和解析结果；hash 未变就跳过重新解析；用户在后台改过的字段写 `locked_fields`，刷新时只更新未锁字段。这样既能用 NFO 覆盖，又不会每次扫描把人工修正冲掉。
8. **成人能力隔离到独立 adapter**。不要给 `dramas` 表加 performer/studio 字段；单独建 `adult_scenes/adult_performers/adult_studios/adult_labels`，或独立 schema。Provider 必须白名单、合同化，禁止将成人查询路由到 TMDb。没有 `source_license`、`age_verification_evidence`、`consent_evidence` 的记录不进入可发布状态。
9. **TMDb 合规先于功能**。本项目有钱包/会员/单片购买，按 TMDb 条款可能构成商业使用；同时 `scrape_cache` 和业务表长期保存 TMDb 内容可能超过 6 个月缓存限制。需要法务确认 commercial agreement、署名展示、缓存周期和删除机制，不能把它当成纯技术配置 `[S73]`。
10. **验证集要覆盖“错配”而不是只覆盖“能匹配”**。至少准备：同名不同年、同名电影/剧集、S01E01 多集文件、S00 特别篇、双版本电影、NFO 与 TMDb 冲突、中文名/英文原名、无网络、低置信度人工确认。每次改动跑固定 golden corpus，检查匹配证据和字段来源。

## 10. 来源清单

> 所有来源均于 **2026-11-10** 访问。`官方` 指产品厂商/项目官方；`社区观察` 只用于补充可观察行为，不作为稳定接口承诺。

### 10.1 Kodi

| ID | 来源 | 类型 | 链接 | 访问日期 |
|---|---|---|---|---|
| S01 | Kodi Wiki：NFO files | 官方 Wiki | https://kodi.wiki/view/NFO_files | 2026-11-10 |
| S02 | Kodi Wiki：NFO files/Movies | 官方 Wiki | https://kodi.wiki/view/NFO_files/Movies | 2026-11-10 |
| S03 | Kodi Wiki：NFO files/TV shows | 官方 Wiki | https://kodi.wiki/view/NFO_files/TV_shows | 2026-11-10 |
| S04 | Kodi Wiki：Naming video files/Movies | 官方 Wiki | https://kodi.wiki/view/Naming_video_files/Movies | 2026-11-10 |
| S05 | Kodi Wiki：Naming video files/TV shows | 官方 Wiki | https://kodi.wiki/view/Naming_video_files/TV_shows | 2026-11-10 |
| S06 | Kodi Wiki：Naming video files/Seasons | 官方 Wiki | https://kodi.wiki/view/Naming_video_files/Seasons | 2026-11-10 |
| S07 | Kodi Wiki：Naming video files/Episodes | 官方 Wiki | https://kodi.wiki/view/Naming_video_files/Episodes | 2026-11-10 |
| S08 | Kodi Wiki：Video versions | 官方 Wiki | https://kodi.wiki/view/Video_versions | 2026-11-10 |
| S09 | Kodi Wiki：Video extras | 官方 Wiki | https://kodi.wiki/view/Video_extras | 2026-11-10 |
| S10 | Kodi Wiki：Video file tagging | 官方 Wiki | https://kodi.wiki/view/Video_file_tagging | 2026-11-10 |
| S11 | Kodi Wiki：Artwork | 官方 Wiki | https://kodi.wiki/view/Artwork | 2026-11-10 |
| S12 | Kodi Wiki：Incorrect and missing videos | 官方 Wiki | https://kodi.wiki/view/Incorrect_and_missing_videos | 2026-11-10 |
| S13 | Kodi 官方电影刮削器仓库 | 官方源码 | https://github.com/xbmc/metadata.themoviedb.org.python | 2026-11-10 |
| S14 | Kodi 电影刮削器 `tmdb.py` | 官方源码 | https://github.com/xbmc/metadata.themoviedb.org.python/blob/master/python/lib/tmdbscraper/tmdb.py | 2026-11-10 |
| S15 | Kodi 电影刮削器 `scraper.py` | 官方源码 | https://github.com/xbmc/metadata.themoviedb.org.python/blob/master/python/scraper.py | 2026-11-10 |
| S16 | Kodi 电影刮削器 `settings.xml` | 官方源码 | https://github.com/xbmc/metadata.themoviedb.org.python/blob/master/resources/settings.xml | 2026-11-10 |
| S17 | Kodi 官方剧集刮削器仓库 | 官方源码 | https://github.com/xbmc/metadata.tvshows.themoviedb.org.python | 2026-11-10 |
| S18 | Kodi 剧集刮削器 `actions.py` | 官方源码 | https://github.com/xbmc/metadata.tvshows.themoviedb.org.python/blob/nexus/libs/actions.py | 2026-11-10 |
| S19 | Kodi 剧集刮削器 `tmdb.py` | 官方源码 | https://github.com/xbmc/metadata.tvshows.themoviedb.org.python/blob/nexus/libs/tmdb.py | 2026-11-10 |
| S20 | Kodi 剧集刮削器 `data_utils.py` | 官方源码 | https://github.com/xbmc/metadata.tvshows.themoviedb.org.python/blob/nexus/libs/data_utils.py | 2026-11-10 |
| S21 | Kodi 剧集刮削器 `settings.py` | 官方源码 | https://github.com/xbmc/metadata.tvshows.themoviedb.org.python/blob/nexus/libs/settings.py | 2026-11-10 |

### 10.2 Emby

| ID | 来源 | 类型 | 链接 | 访问日期 |
|---|---|---|---|---|
| S22 | Emby Library Setup | 官方文档 | https://emby.media/support/articles/Library-Setup.html | 2026-11-10 |
| S23 | Emby Metadata Manager | 官方文档 | https://emby.media/support/articles/Metadata-manager.html | 2026-11-10 |
| S24 | Emby Identify | 官方文档 | https://emby.media/support/articles/Identify.html | 2026-11-10 |
| S25 | Emby Movie Naming | 官方文档 | https://emby.media/support/articles/Movie-Naming.html | 2026-11-10 |
| S26 | Emby TV Naming | 官方文档 | https://emby.media/support/articles/TV-Naming.html | 2026-11-10 |
| S27 | Emby Learn：NFO metadata files | 官方文档 | https://emby.media/learn/articles/metadata-discovery/local-formats/Metadata-NFO.html | 2026-11-10 |
| S28 | Emby Learn：Metadata providers in Emby Server | 官方文档 | https://emby.media/learn/articles/metadata-discovery/services/Metadata-Providers-Emby.html | 2026-11-10 |
| S29 | Emby Learn：How metadata providers work | 官方文档 | https://emby.media/learn/articles/metadata-discovery/services/Metadata-Provider-Workflow.html | 2026-11-10 |
| S30 | Emby Learn：Metadata precedence | 官方文档 | https://emby.media/learn/articles/metadata-discovery/understanding/Metadata-Precedence.html | 2026-11-10 |
| S31 | Emby NFO parser `BaseNfoParser.cs` | 官方源码 | https://github.com/MediaBrowser/NfoMetadata/blob/master/NfoMetadata/Parsers/BaseNfoParser.cs | 2026-11-10 |
| S32 | Emby LibraryOptions API schema | 官方 API | https://dev.emby.media/reference/RestAPI/LibraryStructureService/postLibraryVirtualfolders.html | 2026-11-10 |
| S33 | Emby Image Editing | 官方文档 | https://emby.media/support/articles/Image-Editing.html | 2026-11-10 |

### 10.3 Plex

| ID | 来源 | 类型 | 链接 | 访问日期 |
|---|---|---|---|---|
| S34 | Plex Matching Process | 官方支持 | https://support.plex.tv/articles/200889878-matching-process/ | 2026-11-10 |
| S35 | Plex Scanning vs Refreshing | 官方支持 | https://support.plex.tv/articles/200289306-scanning-vs-refreshing-a-library/ | 2026-11-10 |
| S36 | Plex Movie Agent 高级设置 | 官方支持 | https://support.plex.tv/articles/advanced-settings-plex-movie-agent/ | 2026-11-10 |
| S37 | Plex Series Agent 高级设置 | 官方支持 | https://support.plex.tv/articles/advanced-setting-plex-tv-series-agent/ | 2026-11-10 |
| S38 | Plex Fix Match | 官方支持 | https://support.plex.tv/articles/201018497-fix-match-match/ | 2026-11-10 |
| S39 | Plex Unmatch | 官方支持 | https://support.plex.tv/articles/201101586-unmatch-an-item/ | 2026-11-10 |
| S40 | Plex NFO Agent | 官方支持 | https://support.plex.tv/articles/using-nfo-metadata-files-with-plex/ | 2026-11-10 |
| S41 | Plex `.plexmatch` | 官方支持 | https://support.plex.tv/articles/plexmatch/ | 2026-11-10 |
| S42 | Plex Movie Naming | 官方支持 | https://support.plex.tv/articles/naming-and-organizing-your-movie-media-files/ | 2026-11-10 |
| S43 | Plex TV Naming | 官方支持 | https://support.plex.tv/articles/naming-and-organizing-your-tv-show-files/ | 2026-11-10 |
| S44 | Plex Multiple Editions（电影） | 官方支持 | https://support.plex.tv/articles/multiple-editions/ | 2026-11-10 |
| S45 | Plex Multi-Version Movies | 官方支持 | https://support.plex.tv/articles/200381043-multi-version-movies/ | 2026-11-10 |
| S46 | Plex Multiple Editions（TV） | 官方支持 | https://support.plex.tv/articles/multiple-editions-tv-shows/ | 2026-11-10 |
| S47 | Plex Local Media Assets（电影） | 官方支持 | https://support.plex.tv/articles/200220677-local-media-assets-movies/ | 2026-11-10 |
| S48 | Plex Local Media Assets（TV） | 官方支持 | https://support.plex.tv/articles/200220717-local-media-assets-tv-shows/ | 2026-11-10 |
| S49 | Plex 本地电影 Trailers/Extras | 官方支持 | https://support.plex.tv/articles/local-files-for-trailers-and-extras/ | 2026-11-10 |
| S50 | Plex 本地 TV Trailers/Extras | 官方支持 | https://support.plex.tv/articles/local-files-for-tv-show-trailers-and-extras/ | 2026-11-10 |
| S51 | Plex Edit Details/字段锁 | 官方支持 | https://support.plex.tv/articles/201272763-edit-details/ | 2026-11-10 |
| S52 | Plex 升级到新版 Movie Agent | 官方支持 | https://support.plex.tv/articles/upgrading-a-movie-library-to-the-use-the-new-plex-movie-agent/ | 2026-11-10 |

### 10.4 飞牛影视与 VidHub

| ID | 来源 | 类型 | 链接 | 访问日期 |
|---|---|---|---|---|
| S53 | 飞牛帮助中心：安装飞牛影视和创建媒体库 | 官方帮助 | https://help.fnnas.com/articles/v1/media/media_install | 2026-11-10 |
| S54 | 飞牛社区：手动匹配电视剧集数后刷新跳转页面建议 | 社区观察（含官方回复） | https://club.fnnas.com/forum.php?mod=viewthread&tid=1217 | 2026-11-10 |
| S55 | VidHub Video File Naming Conventions | 官方文档 | https://vidhub.okaapps.com/vidhub-video-file-naming-conventions/ | 2026-11-10 |
| S56 | VidHub Settings Overview | 官方文档 | https://vidhub.okaapps.com/settings-overview/ | 2026-11-10 |
| S57 | VidHub Use File Sources | 官方文档 | https://vidhub.okaapps.com/use-file-source/ | 2026-11-10 |
| S58 | VidHub Edit video information | 官方文档 | https://vidhub.okaapps.com/edit-video-information-in-the-media-library-correction/ | 2026-11-10 |
| S59 | VidHub App Store 版本记录 | 官方商店 | https://apps.apple.com/cn/app/id1659622164 | 2026-11-10 |
| S60 | VidHub Beginner's Guide | 官方文档 | https://vidhub.okaapps.com/beginners-guide/ | 2026-11-10 |

### 10.5 成人元数据参考与法律条款

| ID | 来源 | 类型 | 链接 | 访问日期 |
|---|---|---|---|---|
| S61 | Stash：Metadata scraping | 外部参考 | https://docs.stashapp.cc/in-app-manual/scraping/ | 2026-11-10 |
| S62 | Stash：Metadata sources | 外部参考 | https://docs.stashapp.cc/metadata-sources/ | 2026-11-10 |
| S63 | Stash Scene GraphQL schema | 外部参考源码 | https://github.com/stashapp/stash/blob/develop/graphql/schema/types/scene.graphql | 2026-11-10 |
| S64 | Stash Performer GraphQL schema | 外部参考源码 | https://github.com/stashapp/stash/blob/develop/graphql/schema/types/performer.graphql | 2026-11-10 |
| S65 | Stash Studio GraphQL schema | 外部参考源码 | https://github.com/stashapp/stash/blob/develop/graphql/schema/types/studio.graphql | 2026-11-10 |
| S66 | Stash Group GraphQL schema | 外部参考源码 | https://github.com/stashapp/stash/blob/develop/graphql/schema/types/group.graphql | 2026-11-10 |
| S67 | Stash Identify Metadata GraphQL schema | 外部参考源码 | https://github.com/stashapp/stash/blob/develop/graphql/schema/types/metadata.graphql | 2026-11-10 |
| S68 | Stash StashID/StashBox GraphQL schema | 外部参考源码 | https://github.com/stashapp/stash/blob/develop/graphql/schema/types/stash-box.graphql | 2026-11-10 |
| S69 | stash-box 项目仓库 | 外部参考源码 | https://github.com/stashapp/stash-box | 2026-11-10 |
| S70 | StashDB：Performer Eligibility | 外部规范 | https://guidelines.stashdb.org/docs/performers/create/performer-eligibility/ | 2026-11-10 |
| S71 | StashDB：Contributing to StashDB | 外部规范 | https://guidelines.stashdb.org/docs/faq_getting-started/stashdb/contributing-to-stashdb/ | 2026-11-10 |
| S72 | StashDB Docs 仓库与许可证 | 外部参考 | https://github.com/stashapp/StashDB-Docs | 2026-11-10 |
| S73 | TMDb API Terms of Use | 官方条款 | https://www.themoviedb.org/api-terms-of-use | 2026-11-10 |

### 10.6 未验证、闭源或公开资料不足的区域

- **Plex 现代 agent**：官方支持文档确认匹配、NFO Agent、Editions/Versions 和字段锁，但没有公开 Plex Movie/Series 在线匹配器的 provider 权重、分数、重试、缓存和模糊阈值。
- **Emby 服务端**：公开 NFO parser 和 API schema，但服务端匹配分数、重试、provider 内部合并顺序没有公开；官方 Learn 文档也明确不提供“通用优先级表”。
- **飞牛影视**：公开帮助确认可配置的本地 NFO/图片优先、TMDB、语言、成人标签和实时更新；文件名解析、匹配分数、重试、NFO 锁、版本/合集模型未公开。
- **VidHub**：公开文档确认文件名/TMDB/手动纠错；NFO、嵌入标签、hash、成人过滤、内部重试和图片语言规则未公开。
- **Kodi 核心选择**：电影/剧集 add-on 源码可读，但 Kodi 核心在多个候选中最终如何自动选择，不在本报告的证据范围内；本文只描述 add-on 的搜索与 NFO 接口。
- **StashDB 数据许可**：stash-box 软件为 MIT，StashDB Docs 仓库为 AGPL；没有找到明确的数据库内容开放许可声明，商用前必须单独确认。
- **飞牛的 TMDB 合规安排**：官方帮助把成人标签归因于 TMDB，但 TMDb API 条款限制 pornographic 应用；飞牛是否通过独立授权或缓存安排满足条款，公开资料没有说明，不能推断其合规状态 `[S53][S73]`。
