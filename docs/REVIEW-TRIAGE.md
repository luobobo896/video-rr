# 外部评审报告的处置结论（2026-11-10）

> 评审来源：`outputs/review/影巢-video-rr-评审报告.md`（113 条原始 → 合并 47 条，P0 12 条）
> 复核基线：评审写于 `d5e8c37`，复核时 HEAD 为 `3300abb`，六个文件行数已漂移（`api-public.mjs` 793→880、`api-admin.mjs` 1038→1123、`usdt-watch.mjs` 189→210、`alipay.mjs` 150→164、`auth.mjs` 202→223、`index.mjs` 414→449）。**报告行号不可直接照抄，只能按语义复核。**
> 复核方式：静态读码 + 本地/生产实测（`node --test` 78/78、`verify-system.mjs` 80/80、`probe-hardening-fixes.mjs` 7/7、生产 `verify-hk.sh` 35/0、`verify-play.sh` 0 失败）。

## 1. 处置总表

| 类别 | 条数 | 说明 |
| --- | --- | --- |
| 采纳并已修 | 12 | 见 §2，全部本地自检 + 生产验收通过 |
| 采纳但延后（对外收款门控） | 5 | 见 §3，与「真实渠道接入」绑定，未接真钱不触发 |
| 已过时（当前代码已具备） | 11 | 见 §4，报告未看到近期改动 |
| 误判（结论不成立） | 3 | 见 §5，Q-13 / Q-04 / 后端权限泄露定级 |
| 明确不做（当期） | 5 | 见 §6，含理由 |

**总体判断**：报告的技术观察基本可信，但价值坐标系与产品阶段错位 —— 它在用「即将对外收款的生产标尺」给「模拟支付 + CC 授权内容 + 19 部片源的内测站」打分。12 条 P0 里 9 条落在真钱链路，在 `MH_ALLOW_SIM_PAY` 关闭、真实渠道未接之前根本不会触发；而内测期真实暴露的 6 条（XSS / 匿名上传 / 封禁不生效 / 编辑口越权 / 后台吞错 / 回调格式）反而被排在后面。因此按「内测阻断」与「对外收款门控」拆成两张表执行。

## 2. 已修（12 项，内测期即可验收）

| # | 问题 | 落点 | 修法 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 模拟收银台订单号 XSS + 无前置开关 | `server/index.mjs` `mockPayPage` / `alipaySimPage` | 订单号走 `ORDER_NO_RE = /^[A-Za-z0-9_-]{4,64}$/`、HTML 全部 `escapeHtml`、JS 内改用 `JSON.stringify`；`/pay/mock/` 增加 `SIM_PAY_OPEN()` 前置（未开即 404） | 非法订单号 → 404；生产 `/video/pay/mock/abc123` → 404 |
| 2 | 上传先落盘后鉴权（匿名可写 2GB） | `server/index.mjs` 上传路由 | 新增 `preAuthorizeAdmin(req, 'episode.write')`，先鉴权再 `streamToUpload`，失败直接断开 | 匿名 POST → 401 且 `storage/uploads` 无新增 |
| 3 | 封禁不生效（token 仍可用 7 天） | `server/auth.mjs` `authOf` | 解 token 后查 `admins.status` / `users.status`，非 active 返回 undefined；封禁接口同时 `revokeSessions` | `alive=200 banned=401 restored=200` |
| 4 | 编辑接口可绕过上架校验 | `server/api-admin.mjs` `PUT /admin/api/dramas/:id` | `status` 变为 `published` 时先 `guard(PERM.dramaPublish)` 再 `dramaCompleteness`，缺项回 400 | 缺海报/类型的剧 PUT published → 400「以下信息未补全，无法上架：…」 |
| 5 | 支付宝回调返回 JSON 信封 | `server/api-public.mjs` `/api/notify/alipay` | 改 `text/plain` 回 `success`/`failure`，异常也回 `failure` | 本地 body=`failure`；生产 `Content-Type: text/plain` |
| 6 | 后台 `api()` 吞错（502 HTML 伪造成空表） | `admin/app.js` `api()` | 先 `res.text()` 再 parse，非 JSON/非 2xx 抛可见错误 | 人为 502 → 错误卡而非空表 |
| 7 | 后台页面无权限守卫 | `admin/app.js` `route()` | 取页面声明的 perm，缺权限直接渲染「无权限访问」不发请求 | 低权账号进付费策略页 → 拦截页 |
| 8 | 退款通过无需确认（与驳回要求相反） | `admin/app.js` `pageRefunds()` | 通过按钮 `window.confirm` 带「单号 · 用户 · 金额 + 后果说明」 | 弹确认框后才发请求 |
| 9 | 支付弹窗被拦即掉单 | `public/app.js` `openPaywall()` | 弹窗返回 null 时 `location.href = target`（原来又调一次 `window.open`） | 微信/内嵌浏览器可落到收银台 |
| 10 | 连点下单多单 | `public/app.js` `go()` + `server/commerce.mjs` `createOrder` | 前端 `busy` 置灰；服务端 120 秒内同用户同渠道同商品同金额复用未支付订单 | 连点 3 次同一单号 |
| 11 | USDT 收银台不可自助 | `public/app.js` `showUsdt()` | 地址复制、金额与汇率、网络与确认数（取自渠道 `minConfirmations`，不再写死 19）、15 分钟倒计时 | 实测 `.usdt-box` 出现：`TQn9Y2…` / `3.47 USDT` / `14:57` / 复制按钮 |
| 12 | 顶栏四入口全指 `#/me` | `public/app.js` | 改 `#/me?tab=history|favorite|message|vip` + 区块锚点滚动 | `TOPBAR` 四项各自带 tab，`#me-history` 锚点存在 |

## 3. 采纳但延后：对外收款门控（5 条，不接真钱不启动）

| # | 问题 | 落点 | 成本 | 为什么延后 |
| --- | --- | --- | --- | --- |
| G1 | 支付宝签名时区（UTC → GMT+8）与空参数拼接导致签名串≠URL | `server/payments/alipay.mjs:51/74` | ≤1h 代码 | **没有真实 appId/私钥无法终验**，代码便宜、验证昂贵 |
| G2 | 退款闭环：`executeRefund` 不调 `refundTrade`、部分退款整单置 refunded、approved 无驳回 | `server/commerce.mjs:342-377` | 半天 | 需真实渠道退款接口配合 |
| G3 | USDT 撮合三连：同额错配（`usdt_amount` 两位小数 + 最近单优先）、确认数用时间估算、无 cursor 翻页且水位无条件推进 | `commerce.mjs:186`、`usdt-watch.mjs:19/44-47/49-52/74-91/150-194` | 1–2 天 | **需真实链上流水才能验收**，改完没流水等于没验证 |
| G4 | 内容合规状态机：`review_status` / `license_from` / `license_to`、到期下架 | `db.mjs`、`entitlements.mjs` | 半天–1 天 | 当前 19 部全为 CC 授权，无版权窗口 |
| G5 | 权益唯一约束（`purchases(user_id, drama_id)`、`subscriptions` + `order_id` 唯一索引） | `server/db.mjs:254-275` | ≤1h + 一次存量查重 | 现在靠事务 + `channel_txn_id` 去重兜住，属「代码纪律」 |

门控口径：以上 5 条与「关掉 `MH_ALLOW_SIM_PAY`、配置真实渠道」同一道闸，未闭环不得对外收款（内测不受影响）。

## 4. 已过时（报告未看到，当前代码已具备）

- 渠道可用性闸门（`commerce.mjs:74-98` `channelUsable`：mock 需 `MH_ALLOW_SIM_PAY`、alipay 缺三要素判不可用、usdt 校 TRC20 地址；`createOrder` 抛 `channel_not_configured` 409）。
- 模拟收银台一次性支付票据（`entitlements.mjs` `signPayTicket` / `verifyPayTicket`）。
- 上游埋点（`track_events` + `analytics.mjs` `tracking.upstream` + 后台「埋点数据」页）。
- hero 收藏已真正落库、弹幕随机兜底已删除。
- 后台 5 组 19 页分组菜单、剧集向导、按集定价规则、标签层级、榜单自动刷新、埋点页、管理员页。
- 移动端 `window.open` 已前置开窗（本次又补了拦截兜底）。
- 匿名可浏览（`OPEN_PATHS` + `OPEN_PREFIXES`：详情/分类/榜单/搜索/标签免登录，仅播放/权益/订单/个人中心 401）。
- hls.js 已本地化到 `public/vendor/hls.mjs`，CDN 仅兜底。
- 六维筛选 / 9 个榜单 / 片单广场 / 类似影视 / 试看倒计时 / 续播连播 / 播放错误重签自愈。
- 后台 `route()` 已有兜底错误卡（本次又补了权限守卫）。
- `verify-hk.sh` / `verify-play.sh` / `probe-admin-ops.mjs` / `probe-hardening-fixes.mjs` 已作为「上线前必跑」。

## 5. 误判（结论不成立，建议报告更正）

1. **Q-13「guard fail-open」不成立**：`api-admin.mjs:203` 的 `guard = (perm) => (!perm || hasPermission(...))` 在全部 83 个调用点都写作 `if (!guard(PERM.x)) return deny(...)`，语义是 **fail-closed**；`!perm` 只服务 login/me 等无权限端点。
2. **Q-04 的「`?? 19` 对 0 不生效」论据错**：`0 ?? 19 === 0`；且 `usdt-watch.mjs:44-47` 本就有 `>0 ? value : DEFAULT` 保护。结论（确认数用时间估算不可靠）成立，论据需换。
3. **Q-20「前端路由无权限守卫＝越权」定级偏高**：后端每端点都有 guard+deny，低权账号进页面只看到 403，不构成数据泄露（本次仍补了前端守卫，属体验问题）。

另：UX 专家据**本地**库判定的「邮件通道是 `verify-capture`（127.0.0.1）、线上用户收不到码」不成立 —— 生产已配 QQ SMTP 且 `deploy/setup-channels.sh` 实测投递成功。

## 6. 明确不做（当期）

| 项 | 理由 |
| --- | --- |
| 金额改整数分（Q-41） | 模拟支付下零收益，但要动 orders/payments/purchases/refunds 全链路；应作为「接真钱第一个 PR」 |
| 并发流/设备限制（Q-45） | 内测 10 用户；正确做法在 CDN 侧（签名 URL 带并发数），Node 侧做设备指纹成本高且与 CDN 化冲突 |
| a11y 全量（Q-36） | 报告自身列 P2；保持 `esc()` + 键盘可达的最低限度 |
| 全端点 401/403 矩阵（Q-39） | 成本是「起服务遍历 60+ 端点的 harness」；改为 6 角色 × 关键 15 端点的 RBAC 矩阵 |
| 宽表横向滚动（Q-37） | P2，先按最小可用处理 |

## 7. 复核命令

```bash
# 本地
MH_OTP_TEST=1 node --test                                  # 78/78
node outputs/mh-recon/verify-system.mjs http://127.0.0.1:8791   # 80/80（需 ADMIN_PASSWORD）
node outputs/mh-recon/probe-admin-ops.mjs                 # 25/25
node outputs/mh-recon/probe-hardening-fixes.mjs           # 7/7（服务端需 MH_ALLOW_SIM_PAY=1）
# 生产
ADMIN_PASSWORD='…' bash deploy/verify-hk.sh               # 35/0
bash deploy/verify-play.sh                                # 0 失败
```
