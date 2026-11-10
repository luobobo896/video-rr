# 影巢 · 本轮（内容导入 + 标签 + C 端走查）架构与接口契约

作者：Software Architect（task-7）｜性质：静态勘察结论 + 建议方案
**证据等级说明**：本文所有"已执行验证"= 我读过对应源码/配置的原文（行号可复核）；**本轮未运行任何测试、未启动服务、未访问线上环境**，凡涉及运行时行为（并发、ffmpeg 实际产物、HTTP 状态实测）一律标为「推测/待实测」。

---

## 0. 结论先行

1. **本轮缺的不是代码量，是一条"导入流水线"这条腿**：仓库里 `scripts/` 只有 reset/mirror-images/rewrite-cover-urls/reset-admin-password/sync-tokens，**没有任何内容导入或转码批处理脚本**（已执行验证，目录列举）；后台也只有「单集手动上传」和「单条标签 CRUD」（`admin/app.js:420`、`admin/app.js:1650-1700`），没有批量入口。因此导入必须以**独立 CLI 进程直连同一个 SQLite 文件**的方式落地，而不是走 HTTP。
2. **导入进程与线上 Node 服务会争抢 SQLite 写锁，而 `db.mjs:19` 只设了 `journal_mode=WAL` 与 `foreign_keys=ON`，没有 `busy_timeout`**（已执行验证）。这是本轮引入的第一风险：批处理写入期间任意一次并发写都会立刻 `SQLITE_BUSY`，表现为 C 端 500 或导入中断。最小修复一行：`PRAGMA busy_timeout = 5000`，并把所有多语句写事务改成 `BEGIN IMMEDIATE`。
3. **`dramas.status` 默认 `'published'`、`episodes.status` 默认 `'ready'`（`db.mjs:142`、`db.mjs:154`）**，而 `resolveAccess`/`decideEpisodes` 完全不看 `episode.status`（`entitlements.mjs:63-90`、`entitlements.mjs:130-146`），`/api/play` 也不校验（`api-public.mjs:261-316`）。结论：**导入脚本必须显式写 `status='draft'` 与 `status='pending'`**，否则半成品内容立刻对 C 端可见且"看着能播、点了黑屏"。
4. **标签体系目前是"入库即死"**：`/api/tags` 与 `/api/search?tag=` 服务端已实现（`api-public.mjs:207-229`），但 C 端 37 处 api 调用里零调用（已执行验证，全量 grep），详情响应里的 `tags` 字段从未渲染。所以「补全所有标签」若只做 DB，用户侧看不到任何变化——必须同时补前端两个消费点（详情标签 + 筛选入口）。
5. **`/api/play` 的响应体是契约缺口中心**：缺顶层 `episodeId`（前端 `public/app.js:837` 在用它）、缺 `episodeStatus`（无法区分"转码中/转码失败/没片源"）、试看分支要求 `?trial=1` 而前端从不传（`api-public.mjs:271-283` vs 前端零 `trial=1`）。三项都在同一个 handler 里，一次改完。

---

## 1. 组件划分、职责边界、依赖方向

```
┌ 交付面 ────────────────────────────────────────────────┐
│ nginx（deploy/nginx-video.snippet.conf）                │
│   /video/         → public/ 静态                        │
│   /video/api/     → 127.0.0.1:8787/api/                 │
│   /video/media/hls/ → auth_request=/video/_auth_media   │
│                       → 通过后 alias storage/hls/$tail  │
│   /video/media/uploads/ → return 403（源片永不出网）    │
│   /video-admin/api/ → 8787/admin/api/（client_max 2048m）│
└────────────────────────────────────────────────────────┘
        │ HTTP                          │ HTTP
┌ 接口层 ────────────────────────────────────────────────┐
│ server/index.mjs（403 行，唯一入口）                     │
│   限流/反爬 inspect → /media-auth → /media/hls/*(dev)   │
│   → /media/uploads/* 403 → /media/placeholder.svg       │
│   → /pay/mock|alipay-sim 收银台 → /admin/api/*          │
│   → /api/* → 静态                                        │
│   api-public.mjs（635 行）  api-admin.mjs（881 行）      │
└────────────────────────────────────────────────────────┘
        │ 单向依赖（无反向 import）
┌ 应用层 ────────────────────────────────────────────────┐
│ entitlements.mjs 权益真值 + 播放签名（唯一入口）        │
│ commerce.mjs     订单/支付/退款/对账（状态机唯一写入者）│
│ tags.mjs         标签读写                                │
│ media.mjs        ffprobe/ffmpeg 串行转码队列             │
│ analytics.mjs    play_events / track_events 写入与报表   │
│ auth/otp/rbac/mail-*/secretbox/ratelimit/usdt-watch     │
└────────────────────────────────────────────────────────┘
        │
┌ 数据层 ────────────────────────────────────────────────┐
│ db.mjs：schema + 幂等迁移 + seed；node:sqlite DatabaseSync│
│ storage/app.db（WAL，线上 417KB）                        │
│ storage/hls/<episodeId>/{index.m3u8,480p/,720p/}  ← 第二真值（磁盘）│
│ storage/uploads/  源片（仅内部）                          │
└────────────────────────────────────────────────────────┘
        ▲
        │ 同一 DB 文件（本轮新增，独立进程）
┌ 批处理面（当前不存在，本轮要建）───────────────────────┐
│ scripts/import/*  manifest → fetch → probe → DB → transcode → verify │
└────────────────────────────────────────────────────────┘
```

**依赖方向判断（已执行验证）**：`index → api-* → {entitlements | commerce | tags | media | analytics | db}`，反向无 import；`entitlements`/`commerce` 不 import 任何 HTTP 概念。方向是干净的。

**但缺一层"应用服务"**：三条共享语义没有单一出口——路由层直接写 SQL（如 `api-public.mjs:589-591` 的 history/favorites JOIN、`api-public.mjs:161-167` 的 home sections、`api-public.mjs:221-223` 的搜索），导致 4 处"同一概念双形态"（订单 DTO、episode allow、媒体路径、搜索 total）。**不建议本轮补 repository 抽象**（规模不够，YAGNI），只建议补 3 个**归一函数**：`orderDto(row)`、`playDto(episode, access, extras)`、`episodeDto(decided)`，让每个语义有唯一构造点。

**批处理面为什么要独立进程**：`media.mjs` 的队列是进程内内存结构（`queue[] + running + pump()`），只有 `enqueueEpisode()` 能入队；**服务重启会把 `transcoding|queued` 重置为 `pending`（`index.mjs:375`），但不会重新入队**——即重启后半成品集永久卡在 `pending`，无自动恢复路径（已执行验证，读完整个 index.mjs 无此逻辑）。批处理放在独立进程里，状态由 DB 承载，天然可断点续跑。

---

## 2. 关键数据流

### 2.1 内容导入（本轮新增，设计建议）

```
S0 manifest.json（声明式唯一事实源，进 git）
   └ 每部：slug, title, category(枚举!), year, area, tags[], episodes[{url, title, sha256, license, attribution, sourcePage}]
S1 fetch      → storage/ingest/<slug>/ep01.mp4   （断点续传 + sha256 校验 + 失败重试）
S2 probe      → ffprobe -v error -show_entries format=duration,size … → episodes.duration（秒，REAL）
S3 db.write   → dramas(status='draft') + episodes(status='pending', source_path='uploads/<file>')  ← 单事务批
S4 transcode  → 复用 media.mjs transcode()：storage/hls/<episodeId>/{index.m3u8,720p/,480p/}
              → episodes.status='ready', hls_path='/media/hls/<episodeId>/index.m3u8'
S5 verify     → ① hls_path 非空 ② master m3u8 引用的子列表存在 ③ 首档分片数 > 0
              ④ 用 secureLink 生成 URL 后 GET /media/hls/... 期望 200（走 Node，不经 nginx）
S6 publish    → tags upsert + drama_tags 批量 → content_policies 落库 → dramas.status='published'
```

- **S3 之前不可见**：因为 `dramas.status DEFAULT 'published'`（`db.mjs:142`），脚本必须**显式**写 `'draft'`，`/api/category`、`/api/home`、`/api/search` 全部带 `status='published'` 过滤（`api-public.mjs:176/165/215/221`），所以 draft 天然不出现在 C 端。
- **S6 是唯一发布点**，失败即回滚成 draft，不需要删数据。
- 幂等：以 `(drama.slug→dramas.id)` 和 `UNIQUE(drama_id,no)`（`db.mjs:158`）为幂等键；重跑同一 manifest 走 UPSERT，不产生重复剧。
- **并发约束**：转码串行（ffmpeg 单核吃满；`media.mjs` 两档 720p+480p 每集两次完整编码）。8–12 部 × 5–12 集 = 40–144 次 ffmpeg 调用，必须串行 + `nice -n 19`（或 `cpulimit`），详见部署侧结论。

### 2.2 播放链路（已执行验证的现有实现）

```
C 端 #/play/<dramaId>/<no>
  → GET /api/play/:id/:no（带登录 cookie）
    → resolveAccess(userId, dramaId, no)         entitlements.mjs:60-95
       顺序：activePurchase > (activeSubscription && access_mode!=='paid') > free > no<=free_episodes > 拒绝
    → 允许：playTtl = min(PLAY_TTL_MAX, max(LINK_TTL, duration+300))       api-public.mjs:298
            secureLink(hls_path, playTtl, uaFp) → Set-Cookie mh_link/mh_exp api-public.mjs:300
            recordPlay(source='play') → play_events                          analytics.mjs
            返回 {dramaId,title,episode{id,no,title},source,hls,expiresIn,trialSeconds:0,
                  resumePosition,nextEpisodeNo,danmu[]}                      api-public.mjs:306-315
    → 拒绝：HTTP 402 + code 0402 + {reason,trialSeconds,price,purchaseKind,plans,membership}
  → 前端 hls.js 请求 /video/media/hls/<episodeId>/index.m3u8（同域带 cookie）
    → nginx auth_request → Node /media-auth（X-Original-URI + cookie mh_link/mh_exp）
        → verifyLink：md5(expires+scope+uaFp+linkSecret) 对比，UA 指纹不符即 403
    → 204 后 alias 出文件；master → 子列表 → 分片全部落在同一前缀 scope 内，共用一次签名
```

**签名作用域**：`linkScope(uri)` 取 `^(\/media\/hls\/[^/?#]+\/)`（`entitlements.mjs`），即**按集目录**作用域，master/子列表/分片一起有效；有效期默认 300s、最长 7200s（`MH_PLAY_TTL_MAX`）且自动 ≥ 集时长+300。

### 2.3 标签与筛选（现有 + 本轮要补）

```
写：B 端 POST /admin/api/dramas/:id/tags {tagIds} → setDramaTags（BEGIN/DELETE/INSERT OR IGNORE/COMMIT，逐条校验存在）
读：GET /api/tags                → listTags({withCount}) → [{id,name,sort,count}]
    GET /api/drama/:id           → tags: tagsOfDrama(id).map({id,name})   ← 已返回，前端未渲染
    GET /api/search?tag=<tagId>  → dramaIdsByTag(tagId) → id IN (...) ORDER BY score LIMIT 60
```
**缺陷（已执行验证）**：`tag` 与 `keyword` 是**互斥分支**（`api-public.mjs:211` vs `:220`），不能"标签 + 关键词"组合；`keyword` 只 LIKE title/sub_title/description（`:221-223`），**不搜标签名**，所以用户搜"悬疑"搜不到只带悬疑标签的片。

### 2.4 搜索数据流现状

`title LIKE '%kw%' OR sub_title LIKE '%kw%' OR description LIKE '%kw%'`，`ORDER BY score DESC LIMIT 30`（`api-public.mjs:221-224`）——**前导通配符使 B-tree 索引完全不可用，必然全表扫**；`total: rows.length`（`:224`）是"本页条数"冒充总数。当前 12 部剧无感，但标签补全后搜索会被更多入口使用，建议本轮就改：加 `total` 真值 + 引入标签名匹配（union）。

---

## 3. 导入脚本必须遵守的 5 条硬契约（交给主理人落地）

| # | 契约 | 依据 | 违反后果 |
|---|---|---|---|
| C1 | `dramas.category` 只能取 `TV \| MOVIE \| PLAYLET \| VARIETY` | 硬编码于 `api-public.mjs:134-137`；分类页 `WHERE category = ?`（`:176`） | 写成 `'短剧'/'Anime'` 等：片存在，但**任何分类页都进不去**，只能靠首页楼层撞见 |
| C2 | `episodes.hls_path` 固定 `/media/hls/<episodeId>/index.m3u8`，磁盘目录 `storage/hls/<episodeId>/`，档位子目录 `480p/720p` | 写库 `media.mjs`（transcode 末尾）；nginx `alias /opt/video-rr/storage/hls/$hls_tail` 直接映射磁盘 | 路径不一致 → 签名 OK 但 404，表现为播放器黑屏 |
| C3 | 插入 `dramas` 显式 `status='draft'`，插入 `episodes` 显式 `status='pending'`，转码完成才 `'ready'` | 默认值 `'published'` / `'ready'`（`db.mjs:142,154`），且播放/权益判定**不看** episode.status | 未转码的集立刻对 C 端"可播"，点击 200 + `hls:null` 黑屏 |
| C4 | `episodes.duration` 写**秒数（REAL）**，非毫秒非"45:00" | `playTtl = max(LINK_TTL, duration+300)`（`api-public.mjs:298`） | 写毫秒 → TTL 被 PLAY_TTL_MAX 截到 7200 或异常放大；写字符串 → NaN → 落回 300s，长片中途 403 |
| C5 | 源片只放 `storage/uploads/`（`/media/uploads/*` 由 nginx 与 Node 双重 403） | `nginx-video.snippet.conf:50-53`、`index.mjs` | 放到 `public/` 下 = 整片无鉴权直链，等于免费送源 |

---

## 4. 接口清单（现状 + 错误码）

统一信封 `{requestId, code, msg, data}`（`api-public.mjs:27-33`），成功 `code='0000'`；`Cache-Control: no-store`。
**错误码命名空间不统一（已执行验证）**：数字业务码 `04xx` 与 snake_case 混用（`api-public.mjs:624-627` 同时透传 `OtpError.code`、`CommerceError.code`、`password_weak/email_taken/user_banned/avatar_invalid`）。

| 方法 | 路径 | 入参 | 出参（关键字段） | 错误 |
|---|---|---|---|---|
| GET | /api/constants | — | site,supportEmail,vipPrice,categories[4],pay{channels[],alipay,usdt,mock,usdtNetwork,defaultChannel},auth | — |
| GET | /api/home | — | banners[],sections[{id,title,items:Card[]}],hotwords[8] | — |
| GET | /api/category | type,page,pageSize(≤60) | page,pageSize,total,list:Card[] | — |
| GET | /api/rank | type | type,listName,lists[],items:Card[]+rankNo | — |
| GET | /api/feed | section? | sectionId,items[12]（RANDOM） | — |
| GET | /api/search | keyword 或 tag | keyword,tagId,total(**假值**),list:Card[] | — |
| GET | /api/tags | withCount 隐含 | list:[{id,name,sort,count}] | — |
| GET | /api/drama/:id | — | Card + description,episodes[{id,no,title,duration,status,allow,source,trialSeconds,price}],priceInfo,tags[{id,name}],hasSubscription | 0404/404 |
| GET | /api/play/:id/:no | trial=1? | dramaId,title,episode{id,no,title},source,hls,expiresIn,trialSeconds,resumePosition,nextEpisodeNo,danmu[] | 0401/0402(402)/0404 |
| GET | /api/orders | — | **{list: orders 原始 snake_case 行}** ← 与下一行不一致 | 0401 |
| GET | /api/orders/:no | — | outTradeNo,status,amount,channel,paidAt,usdt | 0401/0404 |
| POST | /api/orders | productType,planId,dramaId,channel,couponCode | outTradeNo,amount,channel,status,expiresAt,payUrl,simulated,usdt | 0401, 409 channel_not_configured, not_purchasable |
| GET | /api/plans | — | plans[{id,code,name,price,days,scope,description}],currency | — |
| POST | /api/coupons/validate | code,amount | {ok,discount,coupon} 或 {ok:false,message} | — |
| POST | /api/track | type,path|term,value,position,duration,meta | {ok} | — |
| GET | /api/me | — | user,subscription{planId,scope,validTo},purchases[],history[],favorites:Card[],completion | 0401 |
| POST | /api/me/history | **seasonId??dramaId**,episode,position | {ok} | 0401 |
| POST | /api/me/favorite | **seasonId??dramaId** | {favorited} | 0401 |
| GET | /api/access/:dramaId/:no | — | resolveAccess 原始结果 | — **死接口，无调用方** |

补充实测差异：
- `POST /api/orders` 与 `GET /api/orders/:no` 是 camelCase，`GET /api/orders`（列表）是 **snake_case 原始行**（`api-public.mjs:359` → `commerce.mjs:428` `SELECT o.*, u.nickname, u.phone, p.name AS plan_name, d.title AS drama_title`）。前端「我的」页恰好按 snake_case 取值（`public/app.js:915-918`），所以**能跑但契约是错的**：任何一次列表 DTO 归一都会静默打断我的页。
- `GET /api/orders/:no` **不含 `expiresAt`**，而 POST 与列表都有；前端"继续支付"靠状态判断，暂未踩雷。
- `/api/me/history`、`/api/me/favorite` 接受 `seasonId ?? dramaId` 双字段名（`api-public.mjs:608,615`）——原站遗留，属"同一概念两个名字"。

---

## 5. 前后端共享类型定义（建议落地 `shared/contracts.d.ts`，纯类型零运行时代价）

```ts
export type ApiCode = '0000' | '0400' | '0401' | '0402' | '0403' | '0404' | '0409' | '0410' | '0413' | '0429' | '0500'
  | 'channel_not_configured' | 'not_purchasable' | 'amount_mismatch' | 'order_closed' | 'order_refunded'
  | 'duplicate' | 'password_weak' | 'email_taken' | 'user_banned' | 'avatar_invalid'
export interface Envelope<T> { requestId: string; code: ApiCode; msg: string; data: T }

export type AccessKind = 'paid' | 'free' | 'subscription' | 'owned' | 'subscribed'
export type AccessMode = 'free' | 'subscription' | 'paid'

/** 卡片：首页/分类/榜单/搜索/我的收藏 共用（cardOf 唯一构造点） */
export interface Card {
  dramaId: number; title: string; subTitle: string | null; coverUrl: string
  dramaType: string; score: number | null; year: number | null; area: string | null
  access: AccessKind; accessMode: AccessMode; freeEpisodes: number
  trialSeconds: number; singlePrice: number
}

export interface EpisodeBrief {
  id: number; no: number; title: string | null; duration: number | null
  status: 'pending' | 'queued' | 'transcoding' | 'ready' | 'error'
  allow: boolean; source?: 'purchase' | 'subscription' | 'free'
  trialSeconds: number; price: number
}

export interface DramaDetail extends Card {
  description: string | null
  episodes: EpisodeBrief[]
  priceInfo: PriceInfo
  tags: { id: number; name: string }[]   // 已返回；前端待消费
  hasSubscription: boolean
}

export interface PriceInfo {
  accessMode: AccessMode; freeEpisodes: number; trialSeconds: number
  singlePrice: number; purchaseKind: 'single' | 'rental'; plans: Plan[]
}

/** 播放成功：本轮建议新增 episodeId / episodeStatus，避免前端猜 */
export interface PlayPayload {
  dramaId: number; title: string
  episode: { id: number; no: number; title: string | null }
  episodeId: number            // ← 新增（前端 play_end 已在读）
  episodeStatus: EpisodeBrief['status']  // ← 新增
  source: 'purchase' | 'subscription' | 'free' | 'trial'
  hls: string | null           // null = 片源未就绪
  expiresIn: number; trialSeconds: number
  resumePosition: number; nextEpisodeNo: number | null
  danmu: { time: number; text: string }[]
}

/** 402 拒绝体（data 部分） */
export interface PaywallDenial {
  reason: 'single_purchase_required' | 'subscription_required'
  trialSeconds: number; price: number; purchaseKind: 'single' | 'rental'
  plans: Plan[]; membership: boolean
}

/** 订单：三种形态必须归一（建议服务端 orderDto） */
export interface Order {
  outTradeNo: string; status: OrderStatus; amount: number; channel: string
  expiresAt?: string; paidAt?: string | null; simulated?: boolean
  usdt?: { amount: number; rate: number; address: string; confirmations: number } | null
  // 列表特有（仅 /api/orders 需要）：nickname/phone/planName/dramaTitle
}
export type OrderStatus = 'created' | 'pending' | 'paid' | 'fulfilled' | 'closed' | 'refunding' | 'refunded'

export interface TagItem { id: number; name: string; sort: number; count?: number }
export interface Plan { id: number; code: string; name: string; price: number; days: number; scope: string; description: string | null }

export type TrackType = 'impression' | 'detail_view' | 'paywall_view' | 'paywall_click'
  | 'play_end' | 'search' | 'share'
```

**配套动作（建议，最小成本）**：新增 `test/contract.test.mjs`，用真实 handler 起一个临时 DB，断言：① `GET /api/orders` 与 `GET /api/orders/:no` 的键集一致；② `/api/play` 含 `episodeId/episodeStatus`；③ `detail.episodes[i].allow === resolveAccess(user,i,no).allow` 全矩阵（免费剧/单片/订阅/已购/未登录）；④ 每个 `Card` 的 12 个键齐备。**这是唯一能阻止 4 处双形态再次漂移的机制**，比写文档有效。

---

## 6. 标签模型判断（该不该扩、怎么扩、要不要冗余计数）

### 6.1 模型：维持多对多，扩三样东西

| 维度 | 现状 | 判断 | 依据 |
|---|---|---|---|
| 多对多 | `tags` + `drama_tags(drama_id,tag_id)` PK 复合（`db.mjs:371-382`） | **保持**，不要改成 JSON 列 | 需要"按标签反查剧"（筛选/搜索/相关推荐），JSON 无法索引 |
| 排序 | `tags.sort` 人工序 | **保持**，但明确三层语义：运营序（`sort`）/ 热度（聚合计算，不落列）/ 展示字母序（仅在后台管理列表用） | 现有 `listTags` 已按 sort（`tags.mjs`），语义别混 |
| 别名 | 无 | **建议新增表** `tag_aliases(tag_id, alias UNIQUE, created_at)`，不要塞 JSON 列 | 别名要能反查（用户搜"悬疑剧"→ 命中"悬疑"标签）；JSON 列无法 UNIQUE、无法索引 |
| SEO | 无；且 C 端是 hash 路由（`#/drama/1`） | **本轮只加 `tags.slug TEXT UNIQUE`，不做标签落地页** | hash 路由对爬虫无独立 URL，做 SEO 页必须 SSR/预渲染——那是**另一个决定**，成本远大于本轮；先把 slug 占好位（加列成本 1 行迁移，事后加要回填） |
| 权重 | 无 | **不加** `weight` 列 | 本轮没有"人工置顶某标签"的产品需求；`sort` 已能满足 |

**触发条件（何时才值得动）**：需要"标签页独立 URL 且被收录"→ 才引入 SSR/预渲染；需要"标签自动提取/同义合并"→ 才建别名表之外的 `tag_merge` 流程。

### 6.2 冗余计数字段：**不上**（明确结论）

`listTags({withCount})` 目前是 JOIN 聚合计算（`tags.mjs`），我建议**保持计算，不加 `tags.drama_count` 列**。理由：

1. **量级不成立**：本轮 8–12 部 × 5–6 标签 ≈ 60–72 行；即使做到 700 部 × 6 ≈ 4200 行。`SELECT tag_id, COUNT(*) FROM drama_tags GROUP BY tag_id` 在 4200 行上是微秒级，收益无法测量。
2. **维护面有 5 个写路径**：`createTag`/`deleteTag`（`tags.mjs`）、`setDramaTags`（DELETE+INSERT）、删除剧（`ON DELETE CASCADE`，`db.mjs:379`）、后台改 `dramas.status`（`api-admin.mjs` publish）—— 计数字段要在 5 处同步，漏一处就是脏数据，而脏数据在 C 端表现为"标签显示 12 部、点进去 11 部"。
3. **清理成本不对称**：加列一行迁移，事后回填与对账要写脚本 + 双写过渡。
4. **唯一需要的索引**：`CREATE INDEX idx_drama_tags_tag ON drama_tags(tag_id)`（现有 PK 是 `(drama_id,tag_id)`，**按 tag_id 聚合时用不上最左前缀**）。这是本轮唯一必须加的标签索引。

**反例条件（何时推翻我）**：`drama_tags` > 50,000 行，或 `/api/tags` p95 > 50ms（需实测，非估算）——届时加列 + 事务内维护，并用一次全量重算脚本兜底。

### 6.3 必须一起改的两条（否则标签做了也白做）

1. `POST /admin/api/tags/bulk`（或脚本内批量 upsert）：现在只能一条条 `POST /admin/api/tags`（`admin/app.js:1680`），60 个标签 = 60 次请求。
2. `/api/search` 的标签语义合并：`keyword` 命中 `tags.name`/`tag_aliases.alias` 时并入结果（union 而非替换），否则"标签体系"对搜索零贡献。

---

## 7. 跨模块耦合点 / 可扩展性 / 降级路径

| 耦合点 | 现状（已执行验证） | 影响 | 建议 |
|---|---|---|---|
| 媒体路径三方约定 | DB `hls_path` ↔ 磁盘目录名 `<episodeId>` ↔ nginx alias | 任一方偏离 → 签名通过但 404 | 把"路径构造"收进 `media.mjs` 单一函数 `hlsPathOf(episodeId)`，导入脚本 import 它，禁止手写字符串 |
| 分类枚举硬编码 | `api-public.mjs:134-137` | 导入写错 category → 片不可发现 | 把 4 个 code 提到 `shared/taxonomy.mjs`，前后端与脚本共用；或落 settings |
| 首页 sections 无 limit | `api-public.mjs:161-167` 每区全量 | 导入 12 部后首屏几百张卡片、首屏 JSON 膨胀 | 每区 `LIMIT 12`（与 `/api/feed` 一致），或前端虚拟列表 |
| 权益双实现 | `resolveAccess`（单集） vs `decideEpisodes`（批量） | 两套代码同一规则，易漂移 | 已用 `decideEpisodes` 派生详情，**加契约测试锁定两者一致** |
| 播放签名与 UA 绑定 | `uaFingerprint(lower UA)` | UA 变化 → 403；页面无自动重取（文案却写"过期自动续签"`public/app.js:722`） | 前端 hls.js `ERROR` 事件 + 403 → 重取一次 `/api/play`；或去掉该文案 |
| 埋点 `path` 双语义 | 搜索词塞 `path`（`api-public.mjs:579` `path ?? term`） | 报表 `searchTerms` 依赖 path，路由与词混用 | 新增 `meta.term`，`path` 只放路由；报表兼容读两处 |
| 无缓存层 | 全站 `no-store` / 静态 `max-age=60~604800` | 导入后无需清缓存（是优点） | 保持；若将来加 CDN，需要引入 `settings.cacheVersion` 参与 key |

**降级路径（按发生概率排序）**

1. **转码未完成**：`/api/play` 返回 200 且 `hls:null` → 前端已显示"片源正在处理中"。**建议补 `episodeStatus`**，让前端能区分"处理中（可等）"与"失败（联系客服）"。
2. **SQLite 写锁竞争**：无 `busy_timeout` → 立即抛错 → `/api/*` 500。**必修**。
3. **server 重启瞬间**：nginx `auth_request` 打到未就绪的 8787 → 5xx → 全站视频 403/500（**推测**：需实测 auth_request 对 5xx 的传递行为）。缓解：导入窗口 + 重启窗口错开；前端播放器加"重试"。
4. **磁盘写满**：ffmpeg 失败 → `status='error'`，且**半成品目录不清理**（`media.mjs` transcode 失败分支无 rmdir）→ 重复重跑继续叠加。建议失败时 `rmSync(outDir,{recursive:true,force:true})`。
5. **支付渠道全不可用**：`paymentOptions` 全 `usable:false` → 前端"暂无可用支付渠道"（`public/app.js:336`）。本轮 mock 支付可承担，但 `MH_ALLOW_SIM_PAY=1` 是**启动期一次性判定**（`ensurePaySafety`），生产必须关——环境变量契约见部署侧。
6. **带宽**：README 实测出口 19 Mbps ≈ 22 人 480p；片源变多不改变并发上限（属容量，非架构）。

---

## 8. 风险清单（位置 / 触发 / 影响 / 最小修复 / 验证）

| ID | 位置 | 触发条件 | 影响 | 最小修复 | 验证方法 | 等级 |
|---|---|---|---|---|---|---|
| R1 | `db.mjs:19` | 导入脚本与线上服务同时写 | `SQLITE_BUSY` → 500 或导入中断 | `PRAGMA busy_timeout=5000` + 写事务 `BEGIN IMMEDIATE` | 脚本跑批量写时并发压 `/api/home`、`/api/track` | 已验证（代码）/影响待实测 |
| R2 | `db.mjs:142,154` | 导入脚本漏写 status | 未完成内容立刻上架、点击黑屏 | 显式 `draft`/`pending`（契约 C3） | 导入中断后检查 C 端是否可见 | 已验证 |
| R3 | `api-public.mjs:306-315` | 前端 `play_end` 埋点 | 完播分析丢 episode 维度 | 响应加 `episodeId`（+`episodeStatus`） | `test/contract.test.mjs` 断言键存在 | 已验证 |
| R4 | `api-public.mjs:271-283` vs 前端 | 用户点带"试看"的锁定集 | 试看不可达，直接 402 → 付费墙 | 详情/播放页拼 `?trial=1`；或在详情直接给"试看 N 秒"按钮 | 手动点一集配置了 trial_seconds 的锁定集 | 已验证 |
| R5 | `api-public.mjs:227-229, 250` | C 端渲染 | 标签零曝光，本轮工作不可见 | 详情渲染 `detail.tags` + 分类/搜索加标签筛选 chips | 打开详情页检查标签可见 | 已验证 |
| R6 | `api-public.mjs:359` vs `372-377` | 我的页订单列表 | DTO 双形态，归一即断 | 服务端 `orderDto()` 统一（两边都 camelCase，前端同步改 4 处取值） | 契约测试比对键集 | 已验证 |
| R7 | `api-public.mjs:217,224` | 命中 >30 条 | `total` 假值 → "命中 N 部"错 | 另跑 `SELECT COUNT(*)`（同 where） | 造 40 条关键词命中 | 已验证 |
| R8 | `admin/app.js:514` | 后台删楼层 | 404，楼层删不掉 | 后端补 `DELETE /admin/api/sections?id=` 兼容，或前端改 `/:id` | 后台点删除 | 已验证 |
| R9 | `index.mjs:375` | 转码中重启 | 集卡 `pending` 永不恢复 | 启动后扫描 `status IN ('pending','queued') AND source_path IS NOT NULL` 重新入队（限 5 条） | 转码中 `systemctl restart` 后观察 | 已验证（代码）/行为待实测 |
| R10 | `api-public.mjs:134-137` | 导入写非枚举 category | 片在分类页不可见 | 提 `shared/taxonomy.mjs` 校验，脚本启动即断言 | 脚本对非法值直接 exit 1 | 已验证 |
| R11 | `api-public.mjs:161-167` | 内容量上来 | 首屏 JSON 膨胀、渲染卡 | 每区 `LIMIT 12` | 12 部片时测 `/api/home` 响应大小 | 已验证 |
| R12 | `public/app.js:722` | 播放超过 `expiresIn` | 文案承诺"自动续签"但无实现 → 403 黑屏 | 加 403 重取一次，或删掉该措辞 | 手动把 `MH_LINK_TTL=60` 看长片 | 已验证 |
| R13 | `public/app.js:327` vs `commerce.createOrder` | 用优惠券且选非第一档套餐 | 前端显示减免 ≠ 实际减免 | 前端基准金额改用所选套餐价（`payload.basePrice`）或服务端回显 discount | 选季度套餐 + VIP15 对账 | 已验证 |
| R14 | `api-public.mjs:608,615` | 调用方传 seasonId | 双字段名，语义模糊 | 只保留 `dramaId`（旧名保留 1 个版本并记日志） | grep 调用方 | 已验证 |
| R15 | `media.mjs` 失败分支 | ffmpeg 退出码非 0 | 半成品目录残留占盘 | 失败 `rmSync(outDir,{recursive:true,force:true})` | 故意给一个坏源片 | 推测（未跑） |
| R16 | `analytics.mjs` | 数据量增长 | `date(created_at)>=date(?)` 使索引失效，报表全表扫 | 改 `created_at >= date('now','-N days')` 字符串比较 | `EXPLAIN QUERY PLAN` | 已验证（写法）/性能待实测 |

---

## 9. 验收清单（可直接勾选）

**前置**：`storage/app.db` 已备份（`cp app.db app.db.bak-$(date +%F)`）；`MH_ALLOW_SIM_PAY=1` 仅在验收环境；导入脚本 dry-run 通过。

| # | 前置条件 | 操作 | 预期结果 |
|---|---|---|---|
| A1 | 演示数据已清空 | `sqlite3 app.db "select count(*) from dramas"` | 0（或仅保留本轮真片源） |
| A2 | manifest 就绪 | 跑导入 S0–S3 | `dramas` 新增 N 部且 `status='draft'`；C 端首页看不到 |
| A3 | S4 完成 1 部 | `ls storage/hls/<id>/` | `index.m3u8` + `480p/` + `720p/`；master 引用了两个子列表 |
| A4 | S6 发布 | 访问 `/video/#/drama/<id>` | 详情 200、`tags` 非空、`episodes[i].status='ready'` |
| A5 | 已登录 | `GET /api/play/<id>/1` | 200，`hls` 非空，**含 `episodeId` 与 `episodeStatus`**，`expiresIn ≥ duration+300` |
| A6 | 拿到 cookie | 直接 `curl` 带 cookie 取 master/子列表/**分片** | 三者全 200（同签名跨目录生效） |
| A7 | 无 cookie / 改 UA / 改 sign | 同上三条 | 全 403 |
| A8 | 未登录 | 详情点播放入口 | 弹登录；登录后回到同集（`pendingRoute` 生效） |
| A9 | 配了 trial_seconds 的锁定集 | 点"试看" | 播放 `trialSeconds` 秒后进付费墙；`play_events.source='trial'` |
| A10 | 免费剧 / 单片剧 / 订阅剧 三态 | 分别走详情→播放 | 免费集可播；单片未购 402 进付费墙；订阅后可播全集 |
| A11 | mock 渠道可用 | 下单 → 收银台付款 → 回跳 | 订单 `fulfilled`；权益立即生效；重复付款回调返回 `duplicate` |
| A12 | 已购剧再下单 | 重复 `POST /api/orders` 同 dramaId | 明确拒绝（`not_purchasable` 或前端不显示购买按钮） |
| A13 | 0 集空剧 | 打开详情/触发播放 | 前端不白屏，显示空态；`/api/play` 返回 404 该集不存在 |
| A14 | 标签 30–60 个 | `GET /api/tags`；`GET /api/search?tag=<id>` | 每个 tag `count>0`；搜索返回非空且 `total` = 真实命中数 |
| A15 | 导入进程中 | 并发打 `/api/home`、`/api/track` 各 200 次 | 全 200，无 `SQLITE_BUSY`（R1 修复后） |
| A16 | 转码中重启服务 | `systemctl restart` 后等 60s | 卡住集自动恢复转码（R9 修复后）或至少状态可查 |
| A17 | 契约测试 | `node --test test/contract.test.mjs` | 全绿：订单键集一致、play 含新字段、allow 矩阵一致 |
| A18 | 全部完成后 | 关掉 `MH_ALLOW_SIM_PAY` 重启 | `constants.pay.mock=false`，前端不展示模拟支付 |

---

## 10. 交接给主理人（需要他人对齐的契约点）

**给前端（3 处必须先定契约）**
1. `/api/play` 增加 `episodeId` + `episodeStatus` 后，`play_end` 埋点改用 `data.episodeId`；`hls:null` 时按 `episodeStatus` 分文案（pending/transcoding=稍后再试，error=联系客服）——否则"片源正在处理中"会骗人。
2. 试看入口：详情锁定集要么给独立"试看"按钮（链接带 `trial=1`），要么播放页 402 时展示"试看 N 秒"二次入口（需先拿到 `trialSeconds`）。
3. 订单列表 DTO 归一后，「我的」页 4 处取值（`out_trade_no/amount_cny` → `outTradeNo/amount`）必须同批改；**这是破坏性变更，必须前后端同一提交**。

**给后端（3 个归一 + 2 个补齐）**
1. `orderDto(row)` 统一列表/详情；`GET /api/orders/:no` 补 `expiresAt`。
2. `/api/search` 的 `total` 用真实 `COUNT(*)`；并支持 `keyword + tag` 组合与标签名匹配（union）。
3. `/api/play` 增加 `episodeId`、`episodeStatus`；`episode.status != 'ready'` 时**建议返回 409/425 + 明确 code**（或前端按 `episodeStatus` 处理，二选一，别两边都猜）。
4. 合并标签语义后，`path`/`term` 双写收敛。
5. R1 的 `busy_timeout` + `BEGIN IMMEDIATE`（这不是优化，是导入的前提）。

**给数据库（4 项，按优先级）**
1. `PRAGMA busy_timeout` 不属于 DDL，但必须在 `db.mjs` 落地（与 DB 成员确认无冲突）。
2. `CREATE INDEX IF NOT EXISTS idx_drama_tags_tag ON drama_tags(tag_id)`（聚合计数与按标签反查都要它）。
3. `tags.slug TEXT`（+ 部分唯一索引 `WHERE slug IS NOT NULL`）、`tag_aliases(tag_id, alias UNIQUE, created_at)`。
4. `dramas.updated_at`、`dramas.published_at`（SEO/增量/排序都会要）；`episodes` 可考虑 `license/attribution/source_url`（公有领域片源的合规留痕）——**这条我建议做，但属于产品合规决策，需主理人拍板**。

**给部署（3 条硬约束）**
1. 导入进程 `nice -n 19`（或 `cpulimit --limit 80`）+ 串行转码 + 夜间窗口；与 `video-rr.service` 共存，禁止并发跑两个导入进程（加 `flock /tmp/mh-import.lock`）。
2. 磁盘预算：双码率 720p+480p ≈ 源片大小的 1.1–1.3 倍（HLS 有分片开销，**具体倍数需实测一集**，不估算）；144 集 × 平均 8 分钟 720p ≈ 需现场 `df -h` 核实后再排。
3. 回滚：导入前 `app.db` 快照 + `storage/hls` 只增不删（保留 `storage/hls.bak/`），失败只需 `dramas.status='draft'` 即可下线，不删文件。

**未覆盖/未知项（不编造）**
- ffmpeg 实际转码耗时与产物大小：本轮未跑，需实测 1 集外推。
- nginx `auth_request` 对上游 5xx 的传递行为：未实测。
- 线上 `storage/app.db` 的真实行数/章节分布：主理人已有数据（723 集），我未重复核对。
- `media.mjs` 队列在 40–144 集批量下的内存/FD 行为：未实测。
- 是否要为公有领域片源建"来源与许可"字段：产品/合规决策，不属架构判断。
