# 影巢系统验收报告（C 端 / B 端）

- 验收时间：2026-11-10
- 验收方式：`node outputs/mh-recon/verify-system.mjs <BASE>`（75 项断言，可重复执行）
  - 本地全量：**75/75 通过**（含下单、支付、订阅、单片、USDT 确认、标签、风控触发）
  - 线上只读：**44/44 通过**（`--readonly`，不产生业务数据）
- 另：单元测试 **51/51 全绿**（`npm test`）

## 一、C 端访问与登录

| 检查项 | 结果 | 证据 |
|---|---|---|
| 未登录可看首页 | ✅ | `/api/home` 200；`/` 返回 HTML |
| 未登录访问剧集/搜索/个人中心/订单/播放/标签/分类 | ✅ 全部 401 | 7 项逐一拦截 |
| 邮箱验证码登录（注册一体） | ✅ | 发码 → 登录 → `created=true` |
| 手机号登录下线 | ✅ | `/api/auth/login` 410 |

## 二、支付与订阅

| 检查项 | 结果 | 证据 |
|---|---|---|
| 套餐列表可见 | ✅ | `/api/plans` 返回可用套餐 |
| 未订阅禁止播放 | ✅ 402 + `reason` | 会员制剧集首集（free_episodes=0）被拒 |
| 订阅下单（支付宝/mock） | ✅ | 下单 → 支付 → 订单 paid |
| 订阅生效 | ✅ | `/api/me` 返回 `subscription.validTo` |
| 订阅后可播放 | ✅ `source=subscription` | 播放令牌签发成功 |
| 单片付费内容对订阅用户仍付费 | ✅ 402 `single_purchase_required` | 权益判定：单片 > 订阅，且 `access_mode=paid` 不被订阅覆盖 |
| 单片购买后可播放 | ✅ `source=purchase` | 购买记录写入且即时生效 |
| USDT 下单返回金额/汇率/地址 | ✅ | `usdt.amount / rate / address` |
| USDT 回调缺 txid 被拒 | ✅ 4xx | 防伪造回调 |
| USDT 人工确认到账（B 端） | ✅ | `POST /admin/api/orders/:id/confirm` → paid 并发放权益 |
| 优惠券校验 | ✅ | 无效码返回 `ok=false + 原因` |

## 三、安全与风控（本次新增）

| 检查项 | 结果 | 说明 |
|---|---|---|
| 空 UA 访问接口 | ✅ 403 | 正常浏览器必带 UA，空 UA 视为脚本 |
| 脚本 UA（python-requests 等） | ✅ 403 | 拦截 requests/scrapy/curl/wget/okhttp/axios 等 |
| 高频请求限流 | ✅ 429 + `Retry-After` | 分路由分档：验证码 10/min、认证 30/min、支付 40/min、播放 120/min、媒体 600/min、API 400/min |
| 单 IP 批量枚举内容 | ✅ 403 | 60 秒内访问 >60 个不同内容 ID 判定抓取 |
| 拦截留痕 | ✅ | `security_events` 表 + 后台 `/admin/api/security` |
| robots.txt | ✅ | 禁止 `/api/`、`/admin/`、`/media/` |
| 播放防盗链 | ✅ 原有能力保留 | 10 分钟签名 Cookie → nginx `auth_request` → Node 校验 |
| 本机回环放行 | ✅ | 127.0.0.1 跳过 UA 拦截，保证 nginx/健康检查可用 |

## 四、B 端处理逻辑

| 检查项 | 结果 |
|---|---|
| 后台登录、概览统计（含 commerce / mailReady / queue） | ✅ |
| 用户 / 订单 / 退款 / 支付渠道 / 支付设置 / 邮件通道 / 角色 / 菜单 / 审计 / 剧集 / 标签 / 经营数据 | ✅ 12 个接口均 200 |
| 剧集编辑页数据（drama/policy/episodes） | ✅（本次修复：原先缺 `GET /admin/api/dramas/:id`，编辑页会 404） |
| 付费策略读取/更新 | ✅ |
| 订单操作按状态区分 | ✅（已支付→退款；待支付→确认到账；其余→无操作） |

## 五、运营统计（本次新增）

`GET /admin/api/analytics?days=7|14|30` 输出 11 个维度：

| 维度 | 字段 | 状态 |
|---|---|---|
| 播放总量 / 独立观众 / 人均播放 | `totals.plays / viewers / playsPerViewer` | ✅ 实测播放后 +1 |
| 播放趋势（按日） | `playsByDay` | ✅ |
| 热门内容 Top10 | `topDramas`（播放/观众） | ✅ |
| 播放来源 | `sourceSplit`（正常/试看） | ✅ |
| 支付渠道分布 | `byChannel`（订单/收入） | ✅ 线上 2 个渠道 |
| 商品类型分布 | `byProduct` | ✅ |
| 转化漏斗 | `funnel`（下单/支付/关闭/退款 + 支付率） | ✅ 线上 87.5% |
| 金额 | `money`（收入/客单价/退款/待审退款） | ✅ 线上 ¥175 / AOV ¥25 |
| 用户 | `users`（累计/新增/付费用户/按日新增） | ✅ 线上 10 人 |
| 订阅 | `subscriptions`（活跃数 + 按套餐） | ✅ 线上 7 个 |
| 内容 | `content`（在架/分集/就绪/待审） | ✅ 33 部 / 723 集 |

后台页面：系统管理 → **经营数据**（KPI + 趋势条图 + Top 榜 + 渠道/漏斗）。
播放埋点写入 `play_events`，每次成功播放或试看各一条，不影响播放主流程（异常静默）。

## 六、权限系统（RBAC）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 角色数量 | ✅ 6 个（super_admin / ops / finance / cs / content / analyst） | `/admin/api/roles` |
| 权限码总数 | ✅ 57 个 | `permissions.length` |
| 菜单树 | ✅ 6 个顶级节点（含新增「标签管理」「经营数据」） | `/admin/api/menus` |
| 受限角色被拒 | ✅ `ops01` 访问支付设置 → 403（required: admin.write） | 审计记录 `rbac.denied` |
| 受限角色可用授权模块 | ✅ 200 | |
| 无 token | ✅ 401 | |
| 超管权限码覆盖 | ✅ 51 个菜单节点 ↔ 30 个接口权限码，零缺失（`check-perms.mjs`） | |

## 七、配置能力（邮件）

| 检查项 | 结果 |
|---|---|
| 通道接口可用 | ✅ |
| 厂家预设 | ✅ 19 个（Gmail / Outlook(OAuth2) / Outlook(应用密码) / QQ / 企业邮 / 163 / 126 / 阿里云 / 腾讯云 / Zoho / Yandex / mail.com / SendGrid / Mailgun / Brevo / Resend / 自定义 SMTP / 自定义 HTTP） |
| 敏感字段不回显 | ✅ 仅 `passSet/keySet/refreshTokenSet` |
| 新增/删除通道 | ✅ |
| 连接失败返回具体错误 | ✅（本次修复：原先前端拿不到失败原因） |
| 多渠道回退 | ✅ 单元测试覆盖（首通道失败自动走次通道） |
| JSON 模板转义 | ✅ 单元测试覆盖（正文换行不再破坏请求体） |

> 微软 OAuth2 通道待你提供 clientId 完成设备码授权；授权后 C 端验证码走真实邮件。

## 八、业务管理模块

| 模块 | 状态 | 说明 |
|---|---|---|
| 订单管理 | ✅ | 列表/筛选/关闭超时/确认到账/退款入口 |
| 支付管理 | ✅ | 渠道 CRUD、默认渠道、密钥加密、连通性测试、对账（missingPayment=0 / orphanPayment=0） |
| 电影管理 | ✅ | 剧集 CRUD、上架/下架、封面上传、分集与转码、付费策略 |
| 电视剧管理 | ✅ | 同一剧集模型，按 `category` 区分 TV/MOVIE/PLAYLET |
| 标签管理 | ✅ 本次新增 | 标签 CRUD + 剧集打标（复选）+ C 端按标签筛选 + 详情展示标签 |
| 内容审核 | ✅ | 弹幕/评论审核队列 |
| 用户管理 | ✅ | 列表、订单数、累计付费、封禁 |
| 首页运营 / 榜单 | ✅ | 轮播、频道、榜单配置 |
| 优惠券 / 套餐定价 / 退款审核 / 审计日志 | ✅ | |

## 九、本次修复的缺陷

| # | 问题 | 影响 | 修复 |
|---|---|---|---|
| 1 | 概览页读取已下线的 `stats.live.installed` | 后台首页整体报「加载失败」 | 删除直播引用，改为「收款与订阅」面板 |
| 2 | 权限码 `dashboard.read` 不存在于权限树 | 超管访问概览也 403 | 补菜单节点 |
| 3 | 缺 `GET /admin/api/dramas/:id` | 后台「编辑剧集」页 404 | 新增详情接口（含政策与分集） |
| 4 | `POST /admin/api/dramas` 路由遮蔽 `/dramas/:id/tags` | 打标请求变成"新建剧集" | 加 `seg.length === 1` 守卫 |
| 5 | 邮件通道测试忽略失败结果 | 连接失败仍显示成功 | 按 `result.ok` 返回 502 与原因 |
| 6 | 无任何反爬/限流 | 可被脚本批量抓取、刷验证码 | 三层风控 + 留痕 + robots |
| 7 | 无播放埋点/多维统计 | 运营看不到播放与转化 | `play_events` + 经营数据页 11 维度 |
| 8 | 无标签管理 | 无法做内容标签运营 | 标签 CRUD + 打标 + C 端筛选 |
| 9 | USDT 无人工确认入口 | 链上到账后无法补单 | 订单页「确认到账」+ 审计 |
| 10 | 本机 curl 被 UA 拦截 | nginx/健康检查误报 403 | 回环地址放行 |

## 十、风险与建议（运营方 2026-11-10 决策后状态）

| # | 风险 | 决策 | 当前状态 |
|---|---|---|---|
| 1 | 邮件开发模式（验证码回显） | 去掉 | ✅ 已移除 `devCode` 与 `MH_EMAIL_DEV`；无可用通道时 `503 mail_not_configured`，投递失败 `502 mail_failed`；仅测试进程可用 `MH_OTP_TEST=1`。**上线前置：后台配一条可用通道并测试通过** |
| 2 | 管理员弱口令 | 改强口令、不展示密码、不上 2FA | ✅ 初始口令 16 位随机、落盘 `storage/admin-initial-passwords.txt`(0600)、首登强制改密；策略 ≥12 位含字母数字、不含用户名、非常见、非重复；失败 5 次锁 10 分钟；登录页不再预填账号密码 |
| 3 | 播放签名 10 分钟 | 缩短并绑 UA | ✅ `MH_LINK_TTL` 默认 300 秒（60–1800 可调），签名串含 UA 指纹，换 UA 立即失效；试看 120 秒 |
| 4 | 限流单机内存 | 接 Redis | ✅ `server/redis.mjs`（零依赖 RESP2）+ ZSET 滑动窗口；Redis 不可用自动降级内存并在启动日志与后台风控页标注 |
| 5 | USDT 靠人工确认 | 接链上监听 | ✅ `server/usdt-watch.mjs`（TronGrid TRC20 轮询、6 小时窗口、金额容差 0.01、`chain_txns` 去重），人工「确认到账」保留为兜底 |
| 6 | 统计基线为空 | 忽略 | — 播放埋点自 2026-11-10 起累计 |
| 7 | 素材版权 | 暂不变，后续后台批量上传替换 | ⏳ 待运营替换 |

仍未覆盖（运营方明确不做或延后）：后台 2FA、多实例部署、CDN、微信支付。

## 11. 安全加固（评审团 NO-GO 项闭环）

| 编号 | 问题 | 处置 |
|---|---|---|
| A1 | 支付回调无信任边界（`/api/notify/usdt`、`/api/pay/mock`、`/api/pay/alipay-sim` 匿名可核销） | USDT 回调下线，只由服务端链上监听调用；模拟支付需 `MH_ALLOW_SIM_PAY=1` 且校验订单归属，否则 404 |
| A2 | HLS 分片验签必 403 | 签名作用域改为 `/media/hls/<集>/` 前缀，master / 子播放列表 / 分片共用一次签名 |
| A4 | XFF 可伪造关掉限流 | 仅反代来源（socket 回环）才信 `x-real-ip`，XFF 只取最后一段；nginx 改 `$remote_addr`；回环豁免不再适用于带转发头的请求 |
| A5 | 登录锁可锁死账号 | 先验口令，错误才计数；按 `用户名:IP` + 账号全局双维度，Redis Lua 原子自增 |
| A6 | 强制改密只在前端 | 服务端闸门：`must_change_password=1` 时除 `/me`、`/password` 外一律 403 `password_change` |
| A7 | 老库不轮换口令与签名密钥 | `ensureAdminCredentials()` 幂等轮换历史账号（`password_updated_at IS NULL`）与 `admin123`；`ensureLinkSecret()` 把空/`dev-link-secret`/过短密钥换掉 |
| A8 | USDT pending 被记终态永不入账 | `pending:<确认数>/<阈值>` 只记中间态并下轮重试，`credited` 才是终态；迟付进 `late_payment` 告警 |
| R5 | `/media/uploads/` 直出源片 | nginx `return 403`，Node 侧同样拒绝 |
| R6 | 播放 5 分钟断流 | 播放有效期 `max(LINK_TTL, 时长+300)`，上限 `MH_PLAY_TTL_MAX`（默认 7200） |
| R7 | 邮件失败仍吃冷却 | 投递失败回滚 `email_send_log`，不占冷却与日限 |
| R9 | 原生播放器/TV 被 UA 拦 | `/media/` 对 ExoPlayer/ijklayer/VLC/Android/iOS 等放行，仅 `/api/` 严格 |
| R14 | 上传全量入内存 | `req.pipe(createWriteStream)` 流式落盘，超限 413，失败即删临时文件 |
| R16 | 代发登录码无限签发 | 同操作人 20 次/小时、同邮箱 60 秒冷却、5 分钟单次有效 |
| P1-1 | 用户列表泄露口令哈希 | 改显式列查询 |
| P1-2 | 会话不可吊销 | `verifyToken` 校验 `sessions`，改密/改邮箱即吊销并下发新 token |
| P1-4/S-8 | Cookie 与响应头 | 链接 Cookie 加 `HttpOnly`，HTTPS 下加 `Secure`；nginx 补 `nosniff` / `X-Frame-Options` / `Referrer-Policy`，HLS 缓存降到 60 秒 |

回归：`npm test` 73/73、`verify-system.mjs` 78/78、`verify-hk.sh` 带断言与退出码（含分片 200、伪造签名 403、源片 403、未改密 403、匿名模拟支付 404）。
