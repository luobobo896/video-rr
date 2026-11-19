# 媒体静态资源与双 base 契约（video-rr）

> 本文只描述**接口与边界契约**，不替代实现与运维手册。所有「已实测」条目均给出命令与位置；未执行的验证单列在 §7。

## 1. 组件划分与依赖方向

```
浏览器
 ├─ /video/          SPA(C 端, Vue3, hash 路由)  base = MH_BASE_PATH
 ├─ /video-admin/    SPA(后台)                   base = /video-admin（前端硬编码）
 └─ /video/media/**  ← 只经由 nginx：
      images/        静态 alias → storage/images
      images/variants/ 静态 alias → storage/images/variants
      previews/ hls/ remote/ trial/ uploads/  → proxy 127.0.0.1:8787/media/**

nginx（/etc/nginx/snippets/video-rr.conf）
 ├─ 静态 alias：/video/ → dist/client/ ；/video-admin/ → dist/admin/
 ├─ 剥前缀反代：/video/api/ → 8787/api/ ；/video-admin/api/ → 8787/admin/api/
 └─ auth_request /video/_auth_media 保护 /video/media/hls/

Node（server/index.mjs，127.0.0.1:8787，MH_BASE_PATH=/video）
 ├─ serveStatic(CLIENT_BUILD|ADMIN_BUILD)  仅在无 nginx 的本地/回退场景使用
 ├─ /media/images/**  → ROOT/storage/images（existsSync 后 200，否则 404）
 ├─ /api/**           → api-public.mjs（含 OPEN_PATHS 登录门禁 + ratelimit）
 └─ /admin/api/**     → api-admin.mjs（preAuthorizeAdmin）
```

依赖方向是**单向**的：浏览器 → nginx → Node → SQLite/磁盘。前端不直连 Node 端口；Node 不认识 `/video` 前缀（前缀由 nginx `proxy_pass` 剥除），这是整体架构成立的前提。

## 2. 关键数据流

**首屏（C 端）**
`GET /video/` → nginx alias 读 `dist/client/index.html`（inline CSP + `./base.js` + `./assets/index-*.js`）
→ `window.__MH_BASE = '/video'`（`public/base.js`）
→ `api.js` 拼 `PUBLIC_BASE = /video/api`、`MEDIA_BASE = /video`
→ `GET /video/api/home?lang=zh` → Node `handlePublic` → SQLite（`dramas` published）→ 返回 `cards[].coverUrl = /media/images/<file>.jpg?v=<ts>`
→ 前端 `imageVariant(coverUrl,640)` 拼 `/media/images/variants/<file>-w640.webp`
→ 浏览器 `GET /video/media/images/variants/<file>-w640.webp` → nginx alias `storage/images/variants/`
→ 命中 200；未命中 404 → `FilmArt.onCoverError` 去掉 `srcset` 并回落到原 `coverUrl`。

**后台**
`GET /video-admin/` → `dist/admin/index.html`（`window.__MH_BASE='/video-admin'`）
→ `api.js` 因 base 以 `/video` 开头把 `ADMIN_BASE` 定为 `/video-admin/api`
→ `GET /video-admin/api/me` 无 token 时 Node 返 `0401 / 401`，前端据此显示登录页（属预期，不是故障）。

## 3. 资源路径与 Content-Type 契约

| 路径 | 归属 | Content-Type 契约 | 说明 |
|---|---|---|---|
| `/video/media/images/<name>.jpg` | nginx alias → `storage/images/` | 由 nginx `types` 推导 `image/jpeg` | `Cache-Control: public, max-age=604800` |
| `/video/media/images/variants/<name>-w{320,640,1280}.webp` | nginx alias → `storage/images/variants/` | `image/webp` | `Cache-Control: public, max-age=2592000, immutable` |
| `/video/media/**`（其余） | proxy → Node `/media/**` | Node MIME 表 | `nomedia` 类路径 404 由 Node 兜底 |
| `/video/api/**` | proxy → Node `/api/**` | `application/json` | — |
| `/video-admin/api/**` | proxy → Node `/admin/api/**` | `application/json` | — |
| `*.webmanifest` | **当前实际由 hash 化文件名提供**：`/video/assets/site-<hash>.webmanifest` | **现返回 `application/octet-stream`（违约）** | 见 §5 R2 |

### 3.1 变体存在性契约（这是本次故障的根因面）

契约本应是：**对任意 `coverUrl`，`imageVariant(coverUrl, w)` 返回的 URL 必然可取到 200**。
实际实现是：`scripts/build-image-variants.mjs:98`

```js
if (sourceWidth && sourceWidth <= width * 1.05) { stats.skipped += 1; continue }
```

→ 源图宽 480px 时不生成 w640/w1280；源图宽 673–1344px 时不生成 w1280。
→ 而前端 `imageSrcset` 默认宽度集 `[320,640,1280]` 与 `sizes` 声明会让浏览器在多数视口选 640 档。
→ 契约在**生成侧**被打破，前端只能靠 `onCoverError` 兜底。

已实测证据：`/video/media/images/variants/cover-tos-w640.webp` → 404，`-w320.webp` → 200；`cover-tos.jpg` 为 480×720。全站 `cover-*.jpg` 中 195 张缺 w640（139 张 `cover-archive-*` 为 180×124），w1280 只覆盖 5513/14949。

## 4. 接口契约（等价 schema）

### 4.1 统一响应包封

```jsonc
// 成功
{ "requestId": "<uuid>", "code": "0000", "msg": "", "data": { } }
// 失败
{ "requestId": "<uuid>", "code": "04xx", "msg": "<中文可展示文案>", "data": { } }
```

前端 `api.js` 的判定（已实测于构建产物）：`code === '0401' || status === 401` → `unauthorized`（清 token 并派发 `mh:unauthorized`）；`code !== '0000'` → `error`；否则 `ok`。

### 4.2 C 端核心接口（base = `/video/api`）

| 方法 | 路径 | 登录 | 关键入参 | 关键出参（`data`） | 错误码 |
|---|---|---|---|---|---|
| GET | `/api/home` | 否（OPEN） | `lang` | `{ banners[], sections[{id,title,items[]}], hotwords[] }`，`items[].coverUrl` 形如 `/media/images/<f>.jpg?v=<ts>` | 0500 |
| GET | `/api/constants` | 否 | — | `{ categories[], taxonomy{channels[]}, adultMenu{enabled}, vipPrice }` | 0500 |
| GET | `/api/category` | 否 | `channel`,`tag`,`year`,`sort`,`page` | `{ items[], facets{channels[]}, total }` | 0400/0500 |
| GET | `/api/rank` | 否 | `type=HOT` | `{ items[{id,title,coverUrl,score,rankNo}] }` | 0500 |
| GET | `/api/plans` | 否 | — | `{ plans[{id,name,price,description}] }` | 0500 |
| GET | `/api/drama/:id` | 否（PREFIX） | — | 剧目详情 + `episodes[]` | 0404 |
| GET | `/api/me` | **是** | Bearer | `{ user, subscription, purchases[], history[], favorites[], completion }` | 0401 |
| POST | `/api/track` | 否 | `type,eventType,eventOp,eventCode,pageUrl,action,description,stayMs` | `{ ok }` | 0403（交易事件由服务端记）/0400 |
| GET | `/api/play/:id/:no` | 是 | — | 播放票据 + `sources[]` | 0401/0409（签名过期 409） |

`/api/track` **只接受 POST**（`server/api-public.mjs:1885`）。`GET /video/api/track` 实测 404 —— 这是实现现状，不是缺陷；真实会话中的 2 次 GET 404 无功能影响，但**契约文档应显式声明「仅 POST」**，避免抓取器/预取误判。

### 4.3 后台核心接口（base = `/video-admin/api`，全部需管理员 Bearer）

| 方法 | 路径 | 出参/说明 | 错误码 |
|---|---|---|---|
| GET | `/admin/api/me` | 管理员身份 + `mustChangePassword` | 0401 / 0403 |
| GET | `/admin/api/orders` | 订单分页 | 0401 |
| GET | `/admin/api/dramas` | 剧目分页（含 `cover_url`） | 0401 |
| GET | `/admin/api/track-events` | 埋点分页（`track_events` 12 业务字段） | 0401 |
| POST | `/admin/api/episodes/:id/upload` | 流式落盘，`client_max_body_size 2048m`，Node `MH_UPLOAD_MAX_BYTES` 2GB | 0401/0408 |

已实测（无 token，带浏览器 UA）：`/video-admin/api/{me,orders,dramas,track-events,stats}` 全部 **401 + `{"code":"0401","msg":"需要管理员登录"}`** —— 门禁与契约一致。

### 4.4 前后端共享类型（前端实际消费的字段）

```ts
type Card = {
  id: number
  title: string
  subtitle?: string
  typeLabel?: string        // 来自 category 映射：MOVIE/TV/PLAYLET/ANIME/VARIETY/DOCUMENTARY
  area?: string
  year?: number
  score: number             // 0 表示无评分，前端 >0 才显示
  coverUrl: string          // 必非空：缺省为 /media/placeholder.svg?t=<title>
  previewUrl?: string       // 仅当 storage/previews/preview-<slug>.mp4 存在
  isNew?: boolean
  a?: string; b?: string    // 海报渐变色
}
```

**契约要点**：`coverUrl` 保证非空且形如 `/media/images/**` 或 `/media/placeholder.svg**` 或外部 `http(s)://**`。前端 `IMAGE_VARIANT_RE` 只对 `/media/images/*.{jpg,jpeg,png}` 做变体重写，其它形态原样使用——因此**服务端不得返回已经带 `variants/` 的 URL**（当前 DB 0 行，符合）。

## 5. 跨模块耦合点与风险清单

| ID | 位置 | 触发条件 | 影响 | 最小修复 |
|---|---|---|---|---|
| R1 | `scripts/build-image-variants.mjs:98` + `public/src/api.js:imageSrcset`（默认 `[320,640,1280]`） | 源图宽 ≤ 目标宽 ×1.05（480 宽封面 → 无 w640；673–1344 宽 → 无 w1280） | 首屏每个卡片先 404 再回退；`cover-sintel.jpg` 缺源图 → 永久裂图。已实测 error.log 200 次、真实 iPhone 会话 6 张全 404 | 生成侧改为「小图也产出变体」或前端按源图可用宽度裁剪 `srcset`；两侧取其一。回归：`test/image-variants.test.mjs` 需同步改断言 |
| R2 | `dist/*/index.html` 引 `./assets/site-<hash>.webmanifest`，nginx 只对精确路径 `= /video/site.webmanifest`、`= /video-admin/admin.webmanifest` 设 MIME | 任何 PWA 安装/图标解析 | 实测两个 hash 化 manifest 均返回 `200 application/octet-stream` → 浏览器拒绝解析，PWA 不可安装 | nginx 增加 `location ~ ^/video(-admin)?/assets/.*\.webmanifest$ { default_type application/manifest+json; }`；或让 Vite 不 hash 该文件 |
| R3 | `storage/images/cover-sintel.jpg`（DB id=11「辛特尔」） | 该剧目卡片渲染 | 唯一一个真缺源图的封面 → 回退也失败，卡片永久裂图；`/api/home` 里出现 2 次 | 补图或用 `banner-sintel.jpg`/`poster-sintel-*.jpg` 之一改名落地；无需改代码 |
| R4 | nginx `:145 location /video/ { alias ...; }` **无 try_files** | 直接访问 `/video/home`、`/video/detail/11`、`/video-admin/users` 等非 `#` 路径 | 实测全部 404。hash 路由本身不受影响，但外链、分享、服务端 301 会撞 404 | `try_files $uri $uri/ /index.html;`（admin 同理）——反向风险：会让任意不存在的静态路径也回 200 |
| R5 | `server/ratelimit.mjs:223-228` 对 `/api/` 与 `/media/` 空/黑名单 UA 返 403 `automated_access_denied` | 监控、curl 冒烟、部分内置浏览器 WebView UA 为空 | 已验证：无 UA 请求 `/video/api/category` → 403，带 UA → 200 | 运维脚本统一带 UA；监控探针加入 `PLAYER_UA_ALLOW` 或豁免内网网段 |
| R6 | `/video/media/previews/*.mp4` 同上门禁 | hover 预览视频 | 无 UA 403；带 UA 200。`access.log` 中 0 次实际请求（只在 hover 挂 `<video>`），当前无用户可见影响 | 与 R5 同源，随 R5 一并处理 |
| R7 | `/var/log/nginx/error.log` 有 3 次 `upstream timed out POST /video/api/track`（60s） | Node 事件循环被长任务阻塞 | 埋点丢失；access.log 对应 `499`/`504` | 埋点改为非阻塞写（批量 flush）或 nginx 对该 location 单独放宽/缩短 timeout |
| R8 | 磁盘 `/dev/vda1` 96%（剩 2.1G） | `storage/hls` 4.2G 持续增长 | 写满后 SQLite WAL/上传/构建全部失败，属最高等级可用性风险 | 清理 `storage/hls` 过期分片 + `storage/backup` 保留 3 份 + `storage/sources` 归档；非本次故障根因 |

## 6. 可扩展性与降级路径

- **变体降级**：`FilmArt.onCoverError` 已是运行期降级（去 `srcset` → 回原图）。**架构级降级应放在交付侧**：`srcset` 只列服务端确实存在的宽度（可由 `/api/home` 附 `coverWidths`，或生成侧补齐），把「每次请求都靠 onError 兜」换成「首次就选对」。
- **manifest 降级**：非 http(s) 也可用 `default_type application/manifest+json` 通配匹配，避免新增 hash 文件时再次漏配。
- **双 base 可扩展性**：`public/base.js` 用 `/^\/(video|video-admin)$/` 白名单推断 base；新增第三套前端（如 `/video-m`）必须同时改 `base.js`、`api.js` 的 `ADMIN_BASE` 判定和 nginx snippet，是三处硬耦合。建议后续抽出 `window.__MH_BASE` 为唯一真源（`base.js` 已支持，放开白名单即可）。
- **深链**：hash 路由导致所有子页面共用 `/video/` 一个 HTML，缓存粒度粗（`Cache-Control: no-cache` 已合适），但 SEO/分享能力受限；若要走 history 路由，必须先落 R4 的 `try_files`。

## 7. 未执行/未验证（不得视为通过）

- 未在真实浏览器里跑完整的 PWA 安装流程（仅用响应头推断 manifest 会被拒）。
- 未测 Safari/iOS 对 `srcset` + `sizes` 的档位选择是否与 Chrome 一致（仅用 Chrome 会话日志反推选了 640 档）。
- 未测 nginx 加 `try_files` 后的实际行为（仅给出建议配置，未应用）。
- 未测后台登录后的完整业务流程（无 token，全部只验证了 401 门禁）。
- 未做任何写入性验证（补图、改脚本、重启服务均未执行）。
