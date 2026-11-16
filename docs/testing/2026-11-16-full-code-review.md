# 全仓深度代码审查（impeccable + code-review 双技能）

- 日期：2026-11-16
- 审查固定点：`f415821`（`git diff f415821...HEAD` = 105 文件 / +8899 −376）+ 工作区未提交 3 文件
- 分支：`main`，HEAD `d7c4675`
- 基线：`npm test` 261 passed / 0 failed；`npm run check` 通过（tokens hash `4d6750134546`，asset version `20261112ops3`）
- 方法：8 个并行子代理（Standards 轴、Spec 轴、服务端核心、服务端 API/DB、媒体链路、C 端、后台、脚本与部署）+ 汇总方逐条回读关键行复核
- 范围约定：**支付网关配置不审**（用户指定）；支付相关的**订单状态机、退款状态机、分账口径**仍审，因为属业务逻辑而非网关配置

## 结论

| 项 | 数值 |
|---|---|
| 上报条目 | 175（6 域 152 + Standards 14 + Spec 9） |
| 合并去重后 | 约 165 |
| **P0（立刻修）** | **6** |
| P1 | 27 |
| P2 | 72 |
| P3 | 60 |
| 复核后剔除的误报 | 5（含 3 条被上报为 P0 的误判，见 §8） |

一句话结论：**功能骨架和测试覆盖是健康的（261 用例全绿），真正的风险不在"写错了某个函数"，而在四类系统性缺口——付费墙的服务端计量、媒体网关的异常路径、脚本的破坏性默认值、以及新旧两套前端实现并存带来的生命周期失控。**

impeccable 五维评分：C 端 **10 / 20**（a11y 2 / 性能 2 / 主题 token 2 / 响应式 2 / 一致性 2），后台 **11 / 20**（2 / 2 / 2 / 3 / 2）。均处"可接受区下沿"。

---

## §2 P0：立刻修（6 条）

### P0-1 试看签发的是"整集访问权"，登录用户零计量 → 付费内容可无限白看

**位置**：`server/api-public.mjs:929-952`、`server/entitlements.mjs:321-326`

**证据**（已回读，行号为当前工作区）：

```js
// server/api-public.mjs:929
if (!access.allow && access.trialSeconds > 0 && trialWanted) {
  let trialSeconds = Number(access.trialSeconds)
  if (!userId) {                       // ← 931：只有匿名才写 guest_trials 并倒计时
    ...
  }
  // 947-951：签名 TTL 取 max(120, trialSeconds+60)，且签的是整集前缀
  const trialTtl = Math.min(PLAY_TTL_MAX, Math.max(120, trialSeconds + 60))
```
```js
// server/entitlements.mjs:321-326 —— 签名 scope 归一为整个分片目录
const linkScope = (uri) => /^(\/media\/(?:hls|remote)\/[^/?#]+\/)/.test(uri) ? RegExp.$1 : uri
```

**触发**：任意登录账号对任一 `trial_seconds > 0` 的付费集反复 `GET /api/play/<dramaId>/<no>?trial=1`。

**影响**：三重叠加 ——
1. `secureLink` 签的是 `/media/hls/<episodeId>/` 整目录，**该集所有分片都能取**；
2. `trialSeconds` 只在前端截断播放，服务端不限制可拉取的内容长度；
3. 登录态既不入 `guest_trials` 也无任何计数，重复请求即无限续期。

子代理在临时 `MH_DB` + 独立端口实测：`access_mode=paid, trial_seconds=360` 的剧连打 3 次，全部 `200 {"source":"trial","trialSeconds":360,"expiresIn":420,"hls":"/media/hls/603/index.m3u8"}`，无任何限额记录落库。

**修复**：① 试看必落库计时（登录用户同样写 `guest_trials` 或独立 `trial_uses`）；② TTL 收敛到 `trialSeconds + 5`；③ 分片请求校验"剩余试看时长"；④ 根本方案是签发只含前 N 秒分片的试看清单。

---

### P0-2 访客试看标识取自请求头，可无限重置

**位置**：`server/api-public.mjs:931-945`、`server/index.mjs:271`

```js
// api-public.mjs:269 —— 完全由客户端决定
const visitorId = String(req.headers['x-mh-visitor'] ?? '').trim().slice(0, 64)
// :932-944
if (!visitorId) return fail(res, '0400', '缺少访客标识', 400)
trialSeconds = Math.min(15, trialSeconds)
const latest = one(`SELECT * FROM guest_trials WHERE visitor_id = ? AND drama_id = ? AND started_at >= datetime('now','-24 hours') ...`)
...
VALUES (?, ?, ?, datetime('now', '+15 seconds'), ?, ?)
```

**影响**：匿名请求带随机 `x-mh-visitor` 即每次命中"无记录"分支拿到新 15s 窗口；而签名 TTL 是 120s 且覆盖整集（同 P0-1）。实测访客甲乙连续请求均 `200 {"trialSeconds":15,"expiresIn":120}`。

**修复**：访客标识改服务端签发并签名的 HttpOnly Cookie（或 `IP+UA` 派生键），TTL 与 `trialSeconds` 对齐。

---

### P0-3 `MH_OTP_TEST=1` 时验证码明文回显 → 任意邮箱账号接管

**位置**：`server/otp.mjs:111,114-115,154`、`server/api-public.mjs:1187-1191`、`server/index.mjs:613-617`

```js
// server/otp.mjs:111 / 154
const testHook = process.env.MH_OTP_TEST === '1'
if (testHook) payload.testCode = code
```
```js
// server/api-public.mjs:1187-1191（/api/auth/email/send 在 OPEN_PATHS 内，无需登录）
return send(res, { email: result.email, ..., ...(result.testCode ? { testCode: result.testCode } : {}) })
```

**影响**：环境变量一旦在生产残留（部署模板/CI 复用 `.env` 很常见），任何人 `POST /api/auth/email/send {"email":"victim@x.com"}` 即拿到 6 位码，再 `POST /api/auth/email/login` 登录受害者（含管理员邮箱账号）。启动只打告警不拒绝启动。

**修复**：`testCode` 仅在 `NODE_ENV==='test'` **且** 请求来自回环地址时返回；生产启动检测到 `MH_OTP_TEST` 直接退出。

---

### P0-4 四处流没有 `error` 监听 → 一次读失败 = 整个 API 进程退出

**位置**：`server/index.mjs:118、136、153`（`createReadStream(...).pipe(res)`）、`server/stream-proxy.mjs:529-552`（上游 `body` 落盘分支）

**证据**：同文件 L101-103 与 L505-527 是正确写法（有 `on('error')`、有 `res.on('close')`），唯独这四处漏了：

```js
// server/stream-proxy.mjs:529-552
const sink = createWriteStream(tmp)
body.on('data', ...)          // 有 data
const done = new Promise((resolve) => { ... sink.on('close', tick); res.on('close', tick); sink.on('error', ...) })
body.pipe(sink)
body.pipe(res)
await done                    // ← body 上没有 'error'，done 也可能永不 resolve
```

子代理实测：假上游声明 `content-length: 1000` 只发 10 字节后 `socket.destroy()` → 网关抛 `uncaughtException: TypeError: terminated`（栈在 undici `Fetch.onAborted`）**进程退出**；护住进程后该分片永久 3s 超时无响应、`inflight` 条目永久占位。全仓 `process.on('uncaughtException'|'unhandledRejection')` 零命中。

**影响**：① 上游断流/半包 = 全站 502；② `npm run build` 原子替换 `dist/`、转码清理、管理员删集，都会让已经 `statSync` 通过的文件在 `createReadStream` 时消失 → ENOENT 崩进程。

**修复**：统一 `pipeFile(stream, res)`：`stream.on('error', () => res.destroy())`；`done` 加 `AbortSignal.timeout()` 兜底；再加 `process.on('uncaughtException')` 记录后优雅退出。

---

### P0-5 `node scripts/import-catalog.mjs` 无参数 = 清库

**位置**：`scripts/import-catalog.mjs:480-485` → `resetDemo()`（`:253-270`）

```js
if (has('--reset') || has('--build') || argv.length === 0) {
  if (has('--reset') && !has('--build')) return resetDemo()
  resetDemo()
  await build()
```

**影响**：`resetDemo()` DELETE 30 张表（users / orders / payments / history / favorites / track_events / sessions / email_codes …）并 `rmSync` `storage/hls`、`uploads`、`images`。只要在带 `MH_DB=生产库` 的 shell 里手滑敲一次（或在 `deploy/` 目录里跑，见 P1-17 的相对路径问题）即不可逆清库。

**修复**：无参数时只打印帮助；`--reset` 要求 `--yes` 或 `MH_CONFIRM_RESET=1`，并在 `MH_DB` 指向非 `storage/app.db` 之外时二次确认。

---

### P0-6 `adult-migrate` 按标题认领 + 无下限 DELETE → 串剧、误删集

**位置**：`scripts/adult-migrate.mjs:122-124`、`:175-185`

```js
const hit = one('SELECT id FROM dramas WHERE is_adult = 1 AND (sub_title = ? OR title = ?)', ...)  // 无 ORDER/LIMIT、无 source_key 优先
...
run('DELETE FROM episodes WHERE drama_id = ? AND no NOT IN (' + nos.map(...) + ')')                // 无"导出集数 ≥ 库内集数"前置条件
```

**影响**：① `source_key` 为 NULL 的 jable 条目只要标题撞上任意成人剧即"认领"该行，接着按导入集的集号集合删掉原剧的其余集（`episodes` 有 `UNIQUE(drama_id,no)`，删了不会自动补回）；② 导出 JSON 若被分页截断/中断，只带部分集也会触发删除。

**修复**：有 `source_key` 时只按 `source_key` 匹配；无 `source_key` 只插不认领；清理残留集加"导出集数 ≥ 库内集数 且 本剧不是被认领来的"前置条件。

---

## §3 P1（27 条，按域）

### 3.1 鉴权与会话（服务端）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 1 | `server/api-admin.mjs:1709-1716` + `server/otp.mjs:190-195` | 客服代发登录码把**明文 6 位码**返回，且写的是普通 `purpose='login'` 记录 | 内置 `cs` 角色默认持 `user.login.assist`，点一次即可用 `/api/auth/email/login` 变成任意用户（含 VIP、大额订单用户），用户无通知 |
| 2 | `server/api-admin.mjs:1718-1731` | 补发权益只 guard `PERM.cs = 'cs.toolkit'`，而 `db.mjs` 里 `cs` 角色同时持有 `cs.toolkit.grant` —— **全仓无任何 guard 使用它**（死权限）；`days` 由请求体决定，负数/NaN 静默成功 | 任意有客服工具的账号可给任意用户塞任意时长会员（`days:36500` = 100 年），`order_id NULL` 无支付流水 |
| 3 | `server/api-admin.mjs:1765-1772`、`:1931-1933`、`server/rbac.mjs:146-155` | `updateRolePermissions` 整体替换且 codes 无白名单；`setAdminRoles` 同一权限即可发超管 | 任何持 `admin.write` 的账号可给自身角色写入 `system.admin`、或把任意账号设为 `super_admin` → 职责分离失效。（`'*'` 打不通：外键 + `permissions` 表无该行，实测 `FOREIGN KEY constraint failed`） |
| 4 | `server/api-public.mjs:1273-1290`、`server/auth.mjs:133-144` | 换邮箱只验"新邮箱验证码"，无旧邮箱验证码、无当前口令 | token 泄露后可把账号改绑到攻击者邮箱，原主被踢下线且无法用邮箱找回 = 持久化接管 |
| 5 | `server/api-public.mjs:1226-1237` | 邮箱密码登录失败**从不** `noteLoginFailure`（该机制只在后台登录用），限流仅 `auth 30/60s/IP` | 单 IP 约 43k 次/天可在线撞库；配合 #6 放大数百倍 |
| 6 | `server/ratelimit.mjs:54-69,136,167` | 桶键 = 单个 IP 字符串，无 IPv6 /64 聚合、无 IPv4-mapped 归一 | 公网 IPv6 在自己的 /64 内换源地址即得全新桶，`api 400/60s`、`auth 30/60s`、`media 600/60s` 与登录锁定全部失效 |
| 7 | `server/api-public.mjs:562-563,652,672` | 成人可见性由 query `audience=adult` 决定，服务端不看任何 cookie/token | 匿名 `curl '/api/category?audience=adult'` 即得全部成人库标题/封面/播放量。**注意**：`test/adult-visibility.test.mjs:146-147` 已把"匿名可读 `audience=adult`"写成契约，修之前需产品决策（要么加服务端年龄凭证，要么显式记录该风险并加 IP 限频） |
| 8 | `server/api-public.mjs:703-704`、`server/rank.mjs:70-72` | `/api/rank` 有榜时不校验 `d.status='published'`；`EXPECT` 策略主动收 `status IN ('published','draft')` | 下架/隐藏剧继续出现在公开榜单（含首页榜单楼层），点击进详情 404；draft 未上架内容被公开预告 |
| 9 | `server/otp.mjs:206-228` | attempts 是"读-改-写"，并发下 3 次上限可放大 | 100 并发把 6 位码的成功率放大 ~100 倍 |
| 10 | `server/api-public.mjs:1104-1110` | `/api/notify/alipay` 手工累积 body，**无大小上限、无超时**，且该路径在 OPEN_PATHS | 未认证 chunked 大体积全量进内存，数十路并发即占满堆 |
| 11 | `server/api-public.mjs:219-231`、`server/api-admin.mjs:238-250` | `readBody` 逐块把 Buffer 拼进字符串（跨块 UTF-8 被拆坏）；坏 JSON 静默变 `{}`；超限只 `pause()` 不 `destroy()` | 中文剧名/审核理由跨 64KB 边界落库乱码；传坏 JSON 时 handler 按默认值继续执行（下单走默认套餐、改资料返回成功） |
| 12 | `server/index.mjs:112-137` | Range 解析不合 RFC：`bytes=-100` 被当 `0-100`；`bytes=500-100` 写出负 `content-length`；`end` 越界回 416 而非截断 | 播放器 seek 到尾部拿到错数据；负 content-length 让客户端 `HPE_INVALID_CONTENT_LENGTH` 断流 |
| 13 | `server/api-public.mjs:1179-1191`、`server/otp.mjs:65-89` | 未登录即可对**任意第三方邮箱**发验证码，收件人集合不受限 | 邮件轰炸：发信域名信誉受损 + SMTP 配额被吃光，正常用户收不到码 |
| 14 | `server/auth.mjs:8-18` | `scryptSync` 同步阻塞事件循环（每次数十毫秒占满单线程） | 多 IP 并发登录即让所有 `/api/*` 与 `/media/*` 转发同步停摆 |

### 3.2 交易与资金（业务逻辑，非网关配置）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 15 | `server/commerce.mjs:447-448` | `approveRefund` 在 `tx()` **之外**置 `approved`，再调 `executeRefund` | 执行抛错 → 退款单永久卡 `approved`（审批要 `pending`、驳回也要 `pending`），既未退也未释放，只能手工改库。另：`refundEnabled=false` 分支（`:459-462`）返回"成功形状"，会掩盖"钱没退"，但属支付配置未启用场景，按约定不展开 |
| 16 | `server/commerce.mjs:529-537` + `:323` | 对账对 `fulfilled` 但无 `payments` 行的单调 `markPaid`，而 `markPaid` 在 `fulfilled` 时直接 `return {duplicate:true}` | 每次对账都把这些单列进"补录支付"，实际什么都**没做**，payments 永久缺失，财务口径长期失真 |
| 17 | `server/commerce.mjs:140-153,342` | 券无每用户限用、不预占额度，支付成功才 `used+1`；`coupon_redemptions` 唯一键只有 `(coupon_id,order_id)`；日期用 UTC | 同一账号可无限次用同一券；并发下 `used` 可超 `total` 超发；生效/过期在 +08 时区偏 8 小时 |
| 18 | `server/commerce.mjs:21-31` | 交易事务用 `BEGIN`（deferred），全仓无 `SQLITE_BUSY` 重试；`distribution.mjs:52-62` 用的是 `BEGIN IMMEDIATE` | 支付回调与客服确认/对账并发时锁升级冲突，`busy_timeout` 不生效 → 直接抛 `SQLITE_BUSY` |
| 19 | `server/distribution.mjs:561-569,631,654-666` | 2/3 级佣金的 `source_relation_id` 统一写成**直属关系** | 直属关系被风控冻结时，上上级的佣金被连带冻结；关系行被 `SET NULL` 时风控失效全部放行 |
| 20 | `server/api-admin.mjs:967` | 改剧 `status` 无 `DRAMA_STATUSES` 白名单（该常量只用于创建/筛选）；`published → draft` 不校验发布权限 | 传 `"Published"` 等非法值后该剧从所有 `status='published'` 查询里消失，看起来像"整站丢剧"；下架绕过 `dramaPublish` |
| 21 | `server/api-admin.mjs:2123-2125`、`server/analytics.mjs:176-179` | `days=abc` → `Number()` NaN 透传 → `new Date(NaN).toISOString()` 抛 RangeError | 后台数据页 `/admin/api/analytics?days=abc` 直接 500，运维误判为服务故障 |

### 3.3 媒体网关（`server/stream-proxy.mjs`）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 22 | `:107`、`:136` | `remote_url` 只校验 scheme，不校验 host/IP；`redirect: 'follow'` | SSRF 实测：`http://127.0.0.1:PORT/redir.m3u8` 302 到 `/secret.m3u8`，网关 200 把内网清单重写后原样回吐。可打 `169.254.169.254` 元数据 |
| 23 | `:220`、`:231`、`:620`、`:643` | 变体清单子 URI 一律 404（`:620` 的 `/^seg\/([^/]+)$/` 不容多斜杠）；`EXT-X-MEDIA` 的 URI 被当 `segment` 重写 | 所有多码率/多音轨源要么播不了要么没声音；单码率源掩盖了问题（测试只覆盖单层清单） |
| 24 | `:454-456`、`:551`、`:675-698` | 分片落盘无内容校验、无 TTL、无淘汰 | CDN 的签名过期页/维护页会被当分片**永久**缓存，只有人工删 `storage/remote-cache` 才恢复 |
| 25 | `:190-192` | 非 provider 源用完整 URL 算缓存名，而 jable 的 `EXP` 参与签名（约 3 小时轮换） | 换票后分片名全变 → 旧缓存成永久孤儿，同一部片反复全量落盘；`CACHE_DIR` 无任何删除路径 |
| 26 | `:470-479`、`:556-560` | `entry` 是闭包 `let`，`refreshTicket` 后重绑，`finally` 删的是**新** url 键 | `inflight` 无界增长（每换票周期泄漏一批），旧 URL 去重彻底失效 → 换票瞬间同一段可能被下载 N 次 |
| 27 | `:363-371`、`:617` | 预取只有 15s 头超时、无 body 超时；无 `content-length` 时不限量写盘；`warmAhead` 与"谁在看"无关，清单请求即触发 16 段跨境下载 | N 个并发观众 = N×16 次回源；配合 #25 写满磁盘 |

### 3.4 C 端（Vue）

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| 28 | `public/src/pages/c/SearchPage.vue:17-34` | 空关键词走早退分支 `return`，`loading` 停在 `true`（`finally` 到不了） | 永久"正在搜索" + 空白列表，只有刷新恢复 |
| 29 | `public/src/pages/c/PlayPage.vue:89-120` | `clearInterval` 只在成功路径，`catch` 与成人门槛早退都不清 | 切到 402/503 的第二集后，每 15s 继续给**第 1 集**发心跳 → 完播率/有效播放/结算口径被污染 |
| 30 | `public/src/track.js:216-219,63-74` | `pagehide` + `visibilitychange` 双路径发 `loose` 离开事件，配对缺失；`sendLoose` 不带 `x-mh-visitor` 且硬编码 `zh` | 一次进入对应 2 次以上退出、`stay_ms` 被切碎；未登录访客有进入无离开，归属断裂 |
| 31 | `public/src/components/AppShell.vue:89-96`（`LandingPage.vue:20-27` 同） | 语言切换 `setLang(); go(); window.location.reload()` | 白屏闪烁、**正在播放的视频中断**、滚动与筛选丢失；DESIGN.md 明确要求不整页刷新，i18n 侧已有 MutationObserver 可支撑 |

### 3.5 后台

| # | 位置 | 问题 |
|---|---|---|
| 32 | `admin/app.js:1640-1647` | 每次 `pageEpisodes` 都 push 一个 2.5s interval；新增集/操作后重入即累积（清空只在路由切换 `:192-193`）→ N 个 interval 同时 `api()` + 重建 `#ep-body` innerHTML，滚动/焦点被重置 |
| 33 | `admin/app.js:745-772` | 自定义菜单 route 无 final `else` → 永久骨架屏（`finishRoute:632-636` 已复位 `aria-busy`） |
| 34 | `admin/app.js:154,144-189` | 全局 `apiSignal` 无请求序号守卫，慢响应覆盖新结果（仅 `AdminUsersPage.vue:33` 有 `loadSeq`） |
| 35 | `admin/app.js:3671-3676` + `:304-309` | OAuth 轮询 interval，Esc/点遮罩走 `openOverlay` 的 `close()` 不调 `stop()` → 弹层关闭后仍轮询，`:3567-3572` 还会叠第二个 |
| 36 | `admin/app.js:3721-3727`、`:3714-3719` | 邮件通道删除/启停无二次确认、无 `try/catch` → 删掉唯一启用通道可让全站验证码失败；失败时无提示（无 catch 的 unhandled rejection） |
| 37 | `admin/app.js:1193-1210` | 上架/下架无 `disabled` 守卫（双击等于上架→下架）；删除剧集 `await api(DELETE)` 无 `try/catch` |
| 38 | `server/api-admin.mjs:1499-1503` + `AdminOrdersPage.vue:238` | `close-expired` 只 guard `PERM.orders`（`finance.order.read`）→ 只读财务可批量关单 |

### 3.6 脚本与部署

| # | 位置 | 问题 |
|---|---|---|
| 39 | `scripts/adult-migrate.mjs:58-71` | DDL（ALTER 加 `remote_*`、`source_key`、CREATE INDEX）在 `--dry` 判定与 `BEGIN` **之前**；实测 `--dry` 后临时库已多 4 列且无法回滚 |
| 40 | `scripts/jable-import.mjs:420-425` | `refreshTargets` 只匹配 `remote_referer=? OR remote_url LIKE '%mushroomtrack.com%'`，漏 `alonestreaming.com`（`scoreTargets:457-469` 两批都有）→ 该批直链 3 小时后失效 |
| 41 | `scripts/jable-import.mjs:270` | 番号查重未做 `_`→`-` 归一化（对比 `shareTicket:408-409` 用 `upper(replace(sub_title,'_','-'))`）；`:533` 注释自承历史 194 组重复 |
| 42 | `deploy/sync-adult.cmd:20` | `node scripts\push-images.mjs` 后缺 `if errorlevel 1`（上下两步都有） |
| 43 | `scripts/push-images.mjs:25` | `ssh ... 'ls ... 2>/dev/null || true'` 把 ssh 失败洗成空 → 全量重传；`:42-49` mkdtemp 目录全程不清理 |
| 44 | `deploy/cron.d/video-refresh:13-14` | `flock -n` 无 `-E 99`（`docs/REMOTE-SOURCE.md:142` 要求一律带），抢锁失败与抓页失败同为 exit 1，`jable-health.mjs:111-119` 无法区分 |
| 45 | `scripts/archive-import.mjs:91-98` + `server/db.mjs:461` | `tags.name` 全局 UNIQUE，但裸插 `scope='general'` → 与成人侧同名标签即 `SQLITE_CONSTRAINT_UNIQUE`，`writeTags` 无 try → 整轮中断，已导入剧目成半成品 |
| 46 | `server/db.mjs:154,801` + 三个 import 脚本 | `dramas.source_key` 只有普通索引、无 UNIQUE，所有导入都是"先查后插"；`flock` 只保护 refresh 不保护 import | 计划任务撞手工 `--refresh` 即产出重复剧目 |
| 47 | `scripts/{archive,huangguo,jable}-import.mjs` 结尾 | 失败只计数，退出码仍是 0 | Windows 计划任务/cron 把"整轮抓取失败（Cloudflare 挑战/断网）"当成功，静默停更 |
| 48 | `scripts/{adult-migrate:37,adult-export:16,jable-health:53}` | `MH_DB || 'storage/app.db'` 相对 cwd，错目录会**新建空库**并写入 |
| 49 | `scripts/jable-import.mjs:559-655` | 无进程锁；`--every` 常驻循环会与计划任务重叠，双开 Edge CDP 抢同一 `MH_CHROME_PROFILE` |
| 50 | `deploy/video-rr.service:6-18` | 无 `User=`/`Group=`（root 运行）；`MemoryMax=3G` 与 2GB 上传 + ffmpeg 同进程 → OOM 会杀转码 |
| 51 | `server/huangguo.mjs:36-37` | 图片解密密钥硬编码在源码（进 git 即公开）；应为 `MH_*` 环境变量 |
| 52 | Spec：工作区未提交改动把默认切成 `--mode subscription` + `--trial 0` | `docs/JABLE-IMPORT.md:184` 声明默认 `subscription`，但已提交版本是 `free`；且 `server/db.mjs:2060` 的成人策略不变式会在重启时纠回，两边打架；`deploy/verify-adult.sh:82-85` 必失败 |

**P1 计数修正**：上表实际 52 行（部分行内含 2 个子项），按"独立缺陷"计 27 条（原报告口径），此处按域展开以便定位。

---

## §4 P2 摘要（72 条，仅列代表，完整清单见各域附录）

**服务端（22）**
- `server/index.mjs:296-305` `/media-auth` 用 `original.replace(/^\/video/, '')` 硬编码 `/video` 子路径，与可配置 `MH_BASE_PATH` 脱钩 → 换子路径部署播放签名全 403
- `server/index.mjs:600` `server.listen` 无 `.on('error')` → 端口占用直接崩（实测 `EADDRINUSE` + `Emitted 'error' event`）；`:311,426` `decodeURIComponent` 未包 try
- `server/api-admin.mjs:1167-1169` `/admin/api/options` 全量段路由里**唯一**不带 `guard()` 的一条
- `server/db.mjs:695,1319` + `api-admin.mjs:429` 菜单 `perm_code = 'ops.banner.write&ops.section.write'` 是复合串，`hasPermission` 只做精确匹配且全仓无 `split('&')` → 「首页运营」对所有人（含超管）永久不可见
- `server/rbac.mjs:21-25` `if (principal.permissions.has('*'))` 是死代码（`permissions` 表无 `'*'` 行，外键禁止写入）
- `server/auth.mjs:32`、`entitlements.mjs:362` 用 `!==` 比较 MAC（应 `timingSafeEqual`）；`sessions` 表只增不删（过期 token 从不清理）
- `server/api-public.mjs:1330-1339,1397-1404` `/api/danmu` 不校验剧集状态与权益；`/api/me/history` 不校验 drama/episode 存在 → 可给未上线剧灌待审弹幕、可写任意 `(dramaId,episodeNo)`
- `server/api-public.mjs:858-861` `/api/access/<id>/0` 对 `free_episodes>0` 的剧返回 `allow:true`
- `server/api-public.mjs:882,902-925` `/api/play` 在鉴权**之前**探测片源并触发上游续期 → 可枚举任意剧（含 draft/hidden）的"有无片源/是否 ready"，并可放大上游请求
- `server/api-public.mjs:1299-1326` 头像按 `Content-Type` 定扩展名、无魔数校验、旧文件永不清理、无配额
- `server/api-public.mjs:1154-1160` 消息中心把过期订阅显示成"剩 -30 天"，且只取最新一条 `active` 不过滤 `valid_to`
- `server/entitlements.mjs:71-88` 按集定价 `toNo:"abc"` → `Number()` NaN → 落库 NULL = 无上限，配 `mode:'free'` 让整部剧免费（`NaN < from` 校验通过）
- `server/api-admin.mjs:1725-1731` 客服发权益负数天数静默成功、不校验 user/drama 存在、`purchases` 无 `(user_id,drama_id)` 唯一约束 → 可重复发放
- `server/tracks.mjs:134-141` 改 kind 时只清**新** kind 的默认标记 → 旧 kind 组失去默认轨；查重在事务外
- `server/api-admin.mjs:1520-1524,1536-1540,1318-1325` banner 改不存在项 500、section 挂不存在剧、删集不存在也报成功
- `server/api-public.mjs:559,1338,1401,api-admin:1177,2139,tags:56` 一组 `Number()` NaN 直入 SQL/计算（`LIMIT NULL` 等价不限，一次拉全表 `security_events`）
- `server/api-public.mjs:735,750` `/api/search?keyword=constructor` 命中原型链 → 绑定抛错 500；`%`/`_` 未转义
- `server/{api-admin:933-950,1052-1056,1304-1376,distribution:654-666,content-stats:313-365}` 多写路径无事务 → "有剧无策略"、集号空洞/500、佣金状态与事件不一致
- `server/api-public.mjs:625-669` `/api/category` 单请求 40–70 次带聚合子查询的 SQL（facets 每条 COUNT） → P95 秒级，`busy_timeout=5000` 下连锁超时
- `server/api-admin.mjs:782-791` 后台剧集列表 N+1（100 行 = 400+ 查询）
- `server/content-stats.mjs:238-301` 内容分析单 SQL 10 个标量子查询 + 每行再跑 INTERSECT，无分页；`avgWatchSeconds` 是均值再平均（口径错）
- `server/content-stats.mjs:100,116` + `api-public.mjs:1343-1356` 完播率可伪造（`positionSeconds:1e9`）；匿名可写搜索埋点污染榜单（`rank.mjs:39-47` 的 `OR ... LIKE` 还会把同名剧全计数）
- `server/analytics.mjs:226-232`、`commerce.mjs:558-565`、`api-admin.mjs:487` 统计口径错（部分退款不计、`readyEpisodes` 漏 `remote_url`、`purchases` 含过期租赁）
- `server/distribution.mjs:1029-1042` `LIMIT 200` 后在 JS 汇总 → 推广员 >200 时 totals 偏低

**媒体网关（7）**
- `:529,551` tmp 名只由 `name` 决定 → 换票瞬间两个任务写同一 `.part`，先完成者把半截文件 rename 进缓存（静态推断，未构造确定性时序）
- `:309-316` `parseRange` 语义错误：`bytes=-N` 当 `0-N`、越界回 200 而非 416、多段整段丢弃、无 `if-range`/`etag`
- `:43,210-214` `sessions`/`failing` Map 无界；`order` 数组不随 `segments` 裁剪 → `warmAhead` 用 `order[start+i]` 取下标错位
- `:141-149,647-663` 上游 404/500 全被映射成"签名过期" → 下架片被持续判定为可自愈、反复换票，日志看不到真实上游码
- `scripts/archive-import.mjs:96`（见 P1-45）
- `:161-169` `Object.assign(source.extraHeaders, play.headers)` 只增不清 → 旧 CDN 的 `x-cdn-auth` 会发到新 CDN 主机（跨域泄漏 + 部分 CDN 403）
- `:532-550`（P0-4 同源）`done` 永不 resolve 时 `task` 永不 settle → `inflight` 条目永久占位

**C 端（8）**
- `models.js:64-69` `validTo` 已带 `Z` 时拼成 `ZZ` = Invalid Date → 永远"剩余 0 天"（需确认后端格式）
- `models.js:45-48` `formatDate` 直接 `slice(0,10)`：ISO+Z 下 +08 用户早一天；`MessagesPage.vue:20-25` 排序按本地时间解析、展示按 UTC → 列表顺序与显示时间互相矛盾
- `LoginPage.vue:32-35`、`LoginDialog.vue:46-49`、`ProfileEditPage.vue:51-57` 三处验证码倒计时 interval 无清理（重开时新旧 timer 同时改同一 ref，倒计时跳变）
- `i18n.js` 缺 9 个键（`页面不存在`、`返回精选`、`暂无待播内容`、`正在加载片单`、`正在加载榜单`、`榜单加载失败`、`海报墙加载失败`、`这类内容还没有上架`、`还没有已发布内容`）→ 切 EN 后标题英文正文中文
- `CategoryPage.vue:71-72,43`、`AdultPage.vue:72` 分页 `concat` 不去重；用切换筛选前的 `total` 夹 `page` → 重复卡片（duplicate key）、"第 3 页点不动"
- `CategoryPage.vue:24-31` 筛选条件不入 URL（`table-state.js` 的 `readHashQuery`/`writeHashQuery` 只有 `AdminUsersPage.vue:54-63` 在用）→ 刷新/后退即丢
- `ContentRankPage.vue:28-50` 全站唯一没有 `requestSeq`/abort 的列表 → 快速连点 tab 显示先发后到的旧榜单
- `api.js:73-116` 非 raw 分支不校验 `response.ok`，仅凭 `json.code` → 反代 200+错误 JSON 或 5xx 带 `code:'0000'` 都当成功

**后台（10）**
- `app.js:4394`/`:4400` 的 `yuan(row.paidAmount * 100)` 复核后**不是 bug**（见 §8），但同屏 `yuan(row.commissionFen)` 与 `¥${fmt(row.paidAmount)}` 混用三种口径，读代码极易误判
- 筛选与页码不进 URL：`pageDramas:989-1015`、`pageTags:5227-5241`、`pageEvents:5306+`、`pageAudit:3019-3035` → 刷新/后退即丢
- `app.js:1079-1107` 批量分配策略组本地全改 select、toast 用 `result.updated ?? result.matched ?? ids.length`，部分失败无提示无回滚
- `app.js:1034` + `AdminDataTable.vue:34` 勾选/排序只在当前页（`:checked` 语义、`hiddenKeys`/`searchDraft` 翻页不重置）→ 跨页批量只作用于最后一页
- `app.js:4499-4537` 分销结算/批准/驳回/冻结前端无权限门禁，原因写死「后台风险处理」
- `AdminOrdersPage.vue:43` 列头按 `created_at` 排序、`:249` 显示 `paid_at`；`:51-52` 两个「待支付」option 对应不同 status（`created`/`pending`）
- `app.js:802` 「更新于」用浏览器本地时区、`fmtTs:127-134` 用 `Asia/Shanghai` → 同屏双时区
- `app.js:3838-4030` 经营数据页 `data.funnel/range/totals/users.newByDay` 无默认值 → 缺字段整页崩；`:3839` `days` 从 localStorage 无校验进 query
- `app.js:2820-2826` `Promise.all([roles,admins])` 使"仅角色查看权"账号整页 500；`canWrite` 用 `admin.write` 而菜单键是 `admin.read`
- `app.js:2671-2670` 优惠券 `validTo` 写死 `'2027-12-31'`；`Number(value||0)` 可落 0 元券

**脚本（9）**
- `--dry` 仍写盘：`huangguo-import.mjs:372-373` 真下载封面 + ffmpeg；`jable-import.mjs:355,360` 写 `storage/jable-gone.json`；`adult-export.mjs:15` 把 `--dry` 当输出文件名
- `jable-import.mjs:628` `(Number(valueOf('--max-left','0'))||30)*60`：0→30 分钟、负数→-300 秒，静默空跑 exit 0
- `deploy/install-hk.sh:139-157` nginx 注入只匹配 `listen 443 ssl;`，不匹配也写回并打印 `injected`；`:166-173` 健康检查只打印状态码不断言 200
- `deploy/nginx-video.snippet.conf:6` `http2 on;` 可能与旧 `listen ... http2` 冲突
- `.gitattributes` 未覆盖 `deploy/*.cmd`、`scripts/*.mjs`（`git ls-files --eol` 显示 `attr/`），CRLF 会破坏 shebang
- `normalize-taxonomy.mjs:75-77` 按 title 改 category，不维护 `PLAYLET → is_adult=1` 不变量
- `add-episode-track.mjs:181-183` 原地 `writeFileSync` master m3u8（无 tmp/rename/bak）、`VERSION:3` 硬编码
- `jable-health.mjs:99-109` 日志轮转整读整写与 cron `>>` 并发 → 覆盖丢日志
- `huangguo-import.mjs:310-327`、`archive-import.mjs:126-144` upsert 无 DELETE → 源站删集后库里留空集（用户看到"第 5 集一直转"）

---

## §5 P3 摘要（60 条）

`import-catalog.mjs:294-297` 删 dramas 被外键挡但 HLS 已删 / `migrate-movie-episodes.mjs:211-212` 每片一事务不回滚 / `adult-export.mjs:32` 非原子写整份 JSON / `package-deploy.mjs:54-58` `.env` 守卫只匹配根级 / `reset-db.mjs:7-8` 无确认且不清 images/remote-cache/-journal / `copy-frontend-assets.mjs:9-27` 全相对 cwd 错目录静默 exit 0 / `withdrawal` 复核人≠申请人未校验（表无 `created_by`）/ `archive.mjs:28` 无 `ogm` 反收 `mpeg` / `archive.mjs:146` `_meta.mp4` 会被当正片 / `archive.mjs:67-78` `releaseYearOf` 取 min 导致年份偏早 / `huangguo-import.mjs:213-243` 标签 `LIKE '%'||name||'%'` 双向未转义误挂 / `add-episode-track.mjs:70-73` 可多轨同时 `DEFAULT=YES` / 后台图表只有 `role="img"` 无数据表替代 / `app.js:3731` `Math.min(...[])` → Infinity 写入 DOM / SVG 点击埋点 eventCode 出现 `[object SVGAnimatedString]` / 首页续播进度条把"秒"当百分比（`HomePage.vue:312`）/ 详情页简介重复渲染（`DetailPage.vue:200` 与 `:265`）/ 换集后 `autoRetries` 不重置（`VideoPlayer.vue:103`）/ `Retry-After` 读不到导致退避固定 30s / chip 36px、segmented 30px、pager 34px 低于自家 44px 规范 / 底部导航 6 项 vs 文档 5 项、侧栏 224px vs 124px / 无 skip link / 播放器无 `<track>`（WCAG 1.2.2 A 级）/ 购买单选组无 `fieldset/legend` / 22 页面静态 import 无分包 / `FilmArt.vue:47-56` 每卡一个 `<video>` / 两套 token 词表（`public/src/styles.css:1-66` 不在 `sync-tokens.mjs` 管线内）

---

## §6 Standards 轴（仓库文档明文规定，3 条硬违规）

1. **`public/src/components/PagerBar.vue:75`** 只渲染「第 X / Y 页」，缺「共 N 条」——与 `docs/RESPONSIVE-DESIGN-SYSTEM.md §6.6` 直接冲突；组件已持有 `total` prop，修复成本极低。
2. **`public/src/styles.css:1489-1490`** `.pager__step/.pager__num{height:34px;min-width:34px}`，≤640px 只隐藏文字、无 44px 兜底——违反 `DESIGN.md §8.5.1`（控件高度仅 32/40/48，**34 被点名违规**）与 RESPONSIVE §6.6/§1.4。
3. **`public/src/styles.css:1210`** `.filter-toggle{height:38px}`（只在移动端出现的筛选按钮）——同上违规。

**代码 smell（判断题）**
- **重复代码**：`stream-proxy.mjs` 的头簇（`:330-335,443-448,487-492,571-576`）与"重置清单状态"（`:404-407,630-633`）各重复 2–4 份；`expiryOf` 在 `server/jable.mjs:109` 与 `server/jable-refresh.mjs:38` 各写一份且正则已漂移（`\d{9,11}` vs `\d{9,}`）；Chrome UA 字面量 4 份（`huangguo.mjs:24`、`stream-proxy.mjs:40`、`scripts/huangguo-import.mjs:33`、`scripts/jable-import.mjs:32`）。
- **魔法数与配置不统一**：`stream-proxy.mjs:425` 队列上限硬编码 `40`，而相邻 `PREFETCH_AHEAD/CONCURRENCY/WARM_ON_MANIFEST`（`:352-354`）全走 `MH_*`——AGENTS.md 要求运行配置用 `MH_*`。
- **重复守卫**：`api-admin.mjs` 的 `policyValidationError` 判错返回重复 6 次、`if (movieDrama) policy.freeEpisodes = 0` 重复 3 次，宜并入 `normalizePolicy`。
- **Shotgun Surgery**：默认 `--mode` 由 `free` 改 `subscription` 散在 `deploy/sync-adult.cmd`、`deploy/sync-adult.sh`、`scripts/adult-migrate.mjs` 三处字面量，无单一来源。
- **日志缺口**：`docs/LOGGING.md` 要求请求字段与 `[REDACTED]`，但 `stream-proxy`、`jable-refresh`、`huangguo`、`geoip`、`archive` 五个新模块零日志调用；`api-public.mjs:923` 的 `logWarn('play.refresh_failed', {..., error})` 传 error 对象而非 message/stack。
- **格式**：`stream-proxy.mjs:301` `function sendText(...) {  res.writeHead(` 两条语句同处一行（AGENTS.md 两空格缩进、follow nearby files）。
- **PII**：`server/geoip.mjs:4` 用 `http://ip-api.com/batch` **明文**外发用户 IP。

**核对通过、不误报**：`api-admin.mjs` 新端点 `episodes/:id/remote` 有 `guard(PERM.episodeWrite)`，符合 AGENTS.md「API handlers 授权」；`public/src` 既有文件普遍带分号（`HomePage` 73 行等），分号不算违规；13 个新测试用例名均为中文场景+预期且用隔离 `MH_DB`；token 由 `npm run check` 强制。

---

## §7 Spec 轴（文档要求 vs 实现）

**(a) 文档要求但缺失**
1. `docs/HUANGGUO-IMPORT.md:94` 要求同片换 id 命中后把已入库旧条目置 `status='hidden'`；`scripts/huangguo-import.mjs:369-370` 只 `return { duplicate }`，**全仓无导入侧写 hidden**。
2. `docs/REMOTE-SOURCE.md:120` 要求导入脚本提供 `shareTicket()`；只有 `server/jable-refresh.mjs:146` 的 `adoptFresherTicket()`，批量刷新后同番号条目不跟着换票。
3. `docs/requirements/ADULT-MENU.md:12` 指定中英文门禁文案；`public/src/pages/c/AdultPage.vue:154-158` 写死中文，`public/src/i18n.js:87` 的词条只被旧渲染 `public/app.js:895` 使用。

**(b) 未被要求的行为（自造）**
4. `server/api-public.mjs:532-551` 自造四个首页楼层（最新上架/电影精选/剧集与纪录/动漫与综艺）、`:691-700` 自造「热门榜」；`docs/CONTENT-IMPORT.md:70-74` 只要求补片库，未要求兜底编排。

**(c) 看似实现但方式错误**
5. `docs/REMOTE-SOURCE.md:110` 规定换不上时 `retryAfterSeconds` 4～6 秒；`server/api-public.mjs:918` 冷却期返回 60/180/300 秒，超出同文档 `:178` 的 3～15 秒。
6. `docs/JABLE-IMPORT.md:184` 声明导入默认 `subscription`，已提交版本是 `free`，仅工作区未提交改动才改回，且与 `server/db.mjs:2060` 的成人策略不变式互撞（重启被纠回）。
7. `docs/REMOTE-SOURCE.md:142`「`flock` 一律加 `-E 99`」；`deploy/cron.d/video-refresh:13-14` 只有 `flock -n`。
8. `docs/JABLE-IMPORT.md:392-393` 定为每 3 小时、约 1100 次/小时、「别再往上加」；实现每 5 分钟两路并发（`docs/REMOTE-SOURCE.md:130`），请求量约 10 倍。
9. `docs/ARCHIVE-IMPORT.md:42` 收 `ogm`、按伴生文件排除；`server/archive.mjs:28` 无 `ogm` 反收 `mpeg/mpg`，`:146` 只按 `file.format` 判伴生 → `_meta.mp4` 当正片入库。

---

## §8 复核后剔除的误报（重要）

汇总方逐条回读关键行，以下 5 条**不成立**，勿再当缺陷处理：

| 上报 | 上报等级 | 实际 |
|---|---|---|
| `admin/app.js:4394,4400` `yuan(row.paidAmount * 100)` 金额放大 100 倍 | P0 | **不成立**。`yuan = (fen) => ¥(fen/100)`（`app.js:4335`），而 `paidAmount = SUM(o.amount_cny)` 是**元**（`distribution.mjs:1123-1140`，另有 `paidAmountFen` 单独给分）。`yuan(元×100)` 恰好抵消，输出正确。仅口径混用（同屏还有 `¥${fmt(row.paidAmount)}`），建议统一用 `paidAmountFen` 提升可读性 |
| `admin/app.js:3721` 删除邮件通道无二次确认 | P0 | 降为 **P1**。`pageEmail` 有新增通道表单，可重建；真实缺陷是**无 `try/catch`**（失败时 unhandled rejection、无提示），不是"不可逆数据丢失" |
| `admin/app.js:1640` interval 累积 | P0 | 降为 **P1**。`admin/app.js:192-193` 在路由切换时 `clearInterval` 全部 timer，只在**同页重入**（新增集/操作后）累积，后果是重复刷新 + innerHTML 重建重置焦点，不是内存泄漏级 P0 |
| `CheckoutDialog.vue:76-78` `await` 后 `window.open` 被拦 → 订单丢失 | P0 | 降为 **P2**。`:118`/`:134-136` 在 `order` 落地后切换到摘要页并提供「去支付」按钮（`openPayPage()`），用户在**点击手势内**可正常打开支付页，仅自动弹窗可能被拦 |
| `admin/app.js` CSV 导出注入 / `openEmailForm` id 类型 / `clearFieldError` 空指针 | — | 均核实不成立 |

另核实**无问题**、不必再排查的面：

- **无可用 SQL 注入点**：全仓 40 处模板插值均为白名单常量（`api-admin.mjs:1643-1667` 走 `Object.hasOwn` + `ASC|DESC`、`api-public.mjs:618-635` 三元常量、`api-public.mjs:539-541` 常量数组、`commerce.mjs:579-585`），其余全 `?` 绑定。
- **无 IDOR**：`/api/orders/:outTradeNo` 用 `out_trade_no AND user_id`；`/api/me/*` 全用 auth 的 userId；`/api/play/session/*` 心跳有 `session_forbidden` 归属校验（`content-stats.mjs:84-88`）。
- **后台鉴权无缺失**：`api-admin.mjs` 全部 64 条 `if (pathname ...)` 分支，8 行内均有 `guard(PERM.*)` 或 `preAuthorizeAdmin`（例外只有 `login/logout/me/password`；`/options` 见 P2）。
- **无路径穿越**：`serveStatic`/`/media/*` 全经 `resolveInside`；`stream-proxy` 的 `rest` 只匹配 `file.<ext>` 与 `seg/<name>`，磁盘名由服务端 sha1 生成。
- **AES key 不落盘**（只进内存 `keyCache` ≤4096B/5 分钟）；**并发同段只回源 1 次**（正常路径有效）；**分段缓存不会因客户端中断而截断**（整段下完才 `renameSync`）；**签名不可重放**（长度守卫 + UA 指纹 + `timingSafeEqual`）。
- **佣金不重复发放**：`db.mjs:1795` 有 `UNIQUE(order_id, distributor_user_id)` + `INSERT OR IGNORE`。
- **分页无 off-by-one**：`(page-1)*pageSize` 全仓一致。
- **后台登录锁定顺序正确**：先验口令再判锁（`api-admin.mjs:348-362`），不会被攻击者锁死账号。
- **`/api/drama/:id` 不泄漏片源**：只回 `id/no/title/duration/status/allow/source/reason/rule/trialSeconds/price/stale`。

---

## §9 修复顺序（建议）

1. **P0-1 / P0-2 付费墙计量**（收入直接漏损）；随后 **P0-3 验证码回显**（账号接管）。
2. **P0-4 流错误处理**——一处 `pipeFile()` 收口，改 4 个调用点，防"一次读失败全站 502"。
3. **P0-5 / P0-6 破坏性脚本**——`--reset` 加确认、`adult-migrate` 改 `source_key` 优先 + 清理加下限。
4. **P1 资金类**（退款事务、对账空操作、券并发、`BEGIN IMMEDIATE`）——先于任何营销活动上线。
5. **P1 媒体网关**（SSRF、变体清单、缓存 TTL、`inflight` 键）——决定多码率源能否上线。
6. **P1 鉴权**（代发码独立 purpose、`cs.toolkit.grant` 真校验、角色权限白名单、换邮箱双验证、登录失败锁定、IPv6 桶）。
7. **P2 前端生命周期三件套**（`SearchPage` loading 收口、`PlayPage` 定时器、`track` 配对）——埋点数据可信度。
8. **P3 规范收口**（44px、skip link、token 管线、页面分包）。

## §10 验证方式与未覆盖面

```powershell
# 每次改动后回归（261 用例 + token/前端语法）
npm test; npm run check

# 临时库复现（不碰 storage/app.db）
$env:MH_DB="$env:TEMP\mh-audit.db"; $env:MH_SECRET="audit"; $env:MH_ADMIN_INIT_PASSWORD="admin123"
node --input-type=module -e "import {db} from './server/db.mjs'; console.log(db.prepare(\"SELECT count(*) c FROM sqlite_master WHERE type='table'\").get())"
```

关键复现 SQL：
```sql
-- P1-16 对账空操作
SELECT o.id, o.status FROM orders o LEFT JOIN payments p ON p.order_id = o.id
 WHERE o.status = 'fulfilled' AND p.id IS NULL;
-- P1-17 券重复使用
SELECT user_id, coupon_id, COUNT(*) c FROM coupon_redemptions GROUP BY 1,2 HAVING c > 1;
-- P1-8 榜单泄漏下架内容
SELECT d.id, d.status FROM rank_items ri JOIN dramas d ON d.id = ri.drama_id
 WHERE d.status <> 'published' LIMIT 10;
```

**未覆盖 / 需真机或需产品决策**：
1. 浏览器实测（C 端与后台均只做了静态审计，未起 dev server）——触控尺寸、弹窗拦截、`Retry-After`、双时区渲染这类需真机确认。
2. `audience=adult` 匿名可读是否属有意契约（`test/adult-visibility.test.mjs:146` 已固化）。
3. 后端 `validTo`/`createdAt` 的实际序列化格式（决定 `models.js` 三个时间函数怎么修）。
4. 支付网关配置与回调签名（按约定不审）。
5. 生产环境 `MH_OTP_TEST`、`MH_LINK_SECRET`、`MH_DB` 的实际取值（脚本与部署面只能静态推断）。

## §11 修复落地状态（2026-11-16 完工）

**结论**：P0 6/6、P1 27/27、P2 72/72、P3 60/60 全部处置；Standards 轴 3 条硬违规 3/3 修复，smell 逐条收口；Spec 轴 (a) 3/3 补齐、(c) 6/6 纠正，(b) 1 条（首页楼层/热门榜）按产品有意行为保留。工作树 90 个文件 +6051/−1835，未提交（遵守仓库规则，等你确认后再分批 commit）。

### 11.1 各域落点摘要

| 域 | 条目 | 关键落点 |
|---|---|---|
| 服务端核心（db/entitlements/rank/analytics/tracks/tags） | 25 | `trial_uses` 表与 `trialBudget()`；`linkScope()` 支持 `/media/trial/<id>/<sec>/`；`secureLinkScoped()`；`verifyPlayToken` 改 `timingSafeEqual`；purchases/coupons/refunds 部分唯一索引 + 幂等补齐；`ensureAdultPolicyInvariant` 不再覆盖显式策略 |
| 媒体网关（index/stream-proxy/jable/geoip/archive） | 23 | `pipeFile()` 统一处理流错误；`fatalShutdown()` 接进程级异常；`parseRangeHeader()` 修 416/负长度；`isBlockedHost/assertPublicUrl` 挡 SSRF（含十进制/十六进制/映射地址）；`redirect:'manual'` 逐跳复检；缓存剔签名参数 + TTL/LRU；变体清单多斜杠归一；`trial-playlist.mjs` 截断 + 贴票 |
| 脚本与部署（scripts/deploy） | 25 | import-catalog 无参只打印帮助、`--reset` 需显式确认、`--dry` 不写盘；adult-migrate 只认 `source_key`、清理有下限且进事务；jable 番号归一 + `--max-left` 校验 + `flock -E 99`；push-images 区分 ssh 失败并 shellQuote；service 加 `User=`/内存上限；`.gitattributes` 统一换行 |
| 交易与分销（commerce/distribution） | 16 | `tx()` 带 busy 退避并在事务内做归因；退款 `approveRefund/performRefund/finishRefund` 全程在事务内；`reconcile` 补录 + `stuckPaid` 幂等；券占用行 + `COUPON_PER_USER_LIMIT`；`getUplineChain` 逐跳取真实层级；`commerceStats` 改净额 |
| 鉴权与限流（auth/otp/rbac/ratelimit） | 21 | `scrypt` 异步化；验证码 `otpTestHookEnabled()` 双条件 + 生产启动即失败；发送限制按邮箱/IP 分桶、`retryAfterSeconds` 真实剩余；`issueAssistCode` 独立 purpose + 操作人配额；角色权限白名单 + 超管保护集；IPv6 /64 归并 |
| 公网 API（api-public） | 30 | 试看改 `/media/trial/<id>/<sec>/` 服务端截断 + 24h 配额 402；访客身份改签名 Cookie；成人门 `mh_adult` 签名 Cookie；换邮箱双验证；`readBody` 跨块 UTF-8 + 超限 413；头像魔数校验；`/api/play` 权益前置；N+1 收口 |
| 后台 API（api-admin） | 21 | 客服代发码 `cs_assist` + `security_events` 审计 + 明文开关；`cs.toolkit.grant` 真权限 + days 1–3650；`replaceRolePermissions/setAdminRoles` 带 actor 与保护集；剧状态白名单；`close-expired` 改 `finance.order.confirm`；`/options` 补 guard；批量写操作进事务 |
| C 端前端（public/src） | 25 | SearchPage loading 收口；PlayPage 心跳三重清理；track loose 一次性 guard；语言切换不再整页 reload；成人门接服务端；时间解析统一 `time.js`；倒计时统一 `useCountdown`；分页去重/夹页；筛选写 URL；请求序号 + AbortController；PagerBar「共 N 条」；控件高度 32/40/48；路由级分包 |
| 后台前端（admin） | 24 | 页面定时器幂等；tbody 内容不变不重建；`api()` 序号守卫；OAuth 轮询随弹层关闭；上下架/删除 disabled；订单按钮按 `finance.order.confirm` 门禁；筛选写 URL；批量分配按逐条结果应用；跨页选择；图表加数据表替代；重复 tokens 删除 |

### 11.2 新增测试与验收

- 回归用例：**261 → 517**（新增 9 个 `test/fix-*.test.mjs` + `test/trial-scope.test.mjs` + `test/trial-http.test.mjs`），全绿。
- `npm test` → 517 pass / 0 fail；`npm run check` → tokens 同步、27 个前端文件 clean；`npm run build` → client/admin 均成功。
- 真机冒烟：临时 `MH_DB` + `PORT=8899` 启动 `server/index.mjs`，`/api/home`、`/api/adult/state`、`/api/rank?type=HOT` 均 200。
- **端到端抓到二次缺陷**：试看清单截断后 `#EXTM3U` 会被挪到文件中部（HLS 播放器会直接判非法）。已修 `server/trial-playlist.mjs`（`#EXTM3U` 归入头部标签 + `ensureHeader()` 兜底），并由 `test/trial-http.test.mjs` 起真进程验证：窗口内分片 200、越界 403、改 sec 403、额度用尽 402。

### 11.3 有意保留 / 已知边界

1. **支付网关配置**（`PUT /admin/api/pay-settings`、渠道密钥、回调）按你的要求未审未改。
2. **远端片源暂不支持试看**：有 `remote_url` 且无本地 HLS 的剧，`/api/play?trial=1` 返回 402 `trial_unavailable`（当前截断只对本地 HLS 生效），README「已知边界」已写明。
3. **分销团队口径**：`distributionSummary.teamPaidAmount`、`teamTree.paidAmount` 仍是团队 GMV 毛额，与个人净额口径不同，未改（避免影响现有报表）。
4. **券的 `used` 语义**仍按「支付成功 +1」——既有测试锁死该行为；并发超卖改由 `coupon_redemptions` 占用行 + 唯一索引兜底，未改成「下单即预占」。
5. **首页四楼层/热门榜**是产品自造行为（文档未要求），保留。
6. **后台两个测试按钮**（邮件通道、支付渠道）未按写权限隐藏，服务端已 403、前端会 toast；页面门仍是读权限。
7. **无头环境限制**：浏览器真机未跑，触控尺寸、弹窗拦截、Retry-After 渲染等靠静态断言 + 构建验证。
8. `index.mjs` 的进程级路径现在由 `test/trial-http.test.mjs` 覆盖主链路；预取预算、LRU 淘汰、`extraHeaders` 重建仍只有阅读级核对。

### 11.4 复核命令

```powershell
npm test        # 517 pass
npm run check   # tokens + 27 前端文件
npm run build   # dist/client + dist/admin
```
