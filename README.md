# 影巢（video-rr）· C 端内容付费平台

对标 `https://mh.yichengwlkj.com/pc` 的**付费点播**全栈实现：内容 → 权益判定 → 套餐/单片 → 订单支付 → 退款对账 → 后台 RBAC，全部可跑通。**无直播模块**（无直播场景，已整体移除）。

```
C 端  public/         /api/*            首页/分类/榜单/搜索/详情/播放/购买/我的
后台  admin/          /admin/api/*      内容/付费策略/套餐/优惠券/订单/退款/对账/权限/审计
媒体  上传 → ffmpeg → HLS 720p+480p → 签名播放（Cookie secure_link）
数据  SQLite（WAL）
```

## 启动

```bash
cd mh-clone
npm start                 # node server/index.mjs
npm test                  # node --test（12 项：权益矩阵/订单幂等/优惠券/双人复核/RBAC/签名）
```

| 入口 | 地址 | 账号 |
|---|---|---|
| C 端 | <http://127.0.0.1:8787/> | 任意 `1xxxxxxxxxx` 手机号登录 |
| 后台 | <http://127.0.0.1:8787/admin> | `admin/admin123`（超管）、`ops01`（内容运营）、`fin01`（财务）、`cs01`（客服） |
| 线上 | <https://hk.hsddns.com/video/> · <https://hk.hsddns.com/video-admin/> | 同上 |

## 商业化规则（已实现）

| 规则 | 实现 |
|---|---|
| 免费 1 集 | `content_policies.free_episodes`，默认剧集 1 集、电影可配 |
| 订阅看全站剧集 | `plans`（月/季/年，scope=all）+ `subscriptions`（有效期、续费顺延） |
| 高价值单独购买 | `content_policies.access_mode='paid'` + `single_price_cny` + `purchases`（买断/租赁） |
| 判定顺序 | 单片所有权 > 订阅 > 免费集 > 试看 > 拒绝（`server/entitlements.mjs` 唯一入口） |
| 播放防盗链 | 播放接口下发 10 分钟签名 Cookie，nginx `secure_link` 校验，直连切片 403 |
| 订单状态机 | `created → created/paid → fulfilled`；15 分钟未付自动关单；回调按 `channel_txn_id` 幂等 |
| 支付渠道 | 支付宝（RSA2 验签，需配置商户参数）、USDT（TRC20，确认数 ≥19）、mock（仅演示） |
| 退款 | 发起 → **双人复核**（发起人不能审批）→ 回收权益 → 订单标记已退款 |
| 对账 | `/admin/api/reconcile`：补支付、补权益、发现孤儿支付 |
| 优惠券 | 满减/折扣、门槛、总量、有效期，下单核销并计数 |

## 后台权限（RBAC）

- 6 个角色：超管 / 内容运营 / 财务 / 客服 / 审核员 / 数据分析
- 权限点 `<域>.<对象>.<动作>`（24 个），**接口层校验是唯一可信层**，菜单按权限渲染
- 审计：每次写操作记录人、IP、动作、对象、改前/改后、原因、结果；越权尝试记为 `rbac.denied`
- 敏感操作：删除/退款/禁用/改策略需填原因；退款 ≥ 任意金额都需第二位管理员审批

## 目录

```
server/
  index.mjs       入口：静态 + 路由 + 上传流 + 媒体签名校验
  db.mjs          表结构 + 种子（权限/角色/管理员/内容策略/套餐/优惠券）
  entitlements.mjs 权益判定 + 播放签名（secure_link 兼容）
  commerce.mjs    下单/支付回调/发放/退款/对账/关单
  rbac.mjs        角色权限 + 审计
  media.mjs       ffprobe / ffmpeg 多码率 HLS 队列
  api-public.mjs  C 端接口
  api-admin.mjs   后台接口
public/ admin/    两个 SPA（原生 ESM，无构建）
deploy/            HK 部署脚本、nginx 片段、压测、容量评估
docs/              COMMERCE.md（资金与权益设计）、API-ADMIN.md、REVIEW-paid-product.md（评审）
test/              node:test 回归
```

## 部署（HK 已验证）

```bash
git clone https://github.com/luobobo896/video-rr.git /opt/video-rr
cd /opt/video-rr && bash deploy/install-hk.sh    # 幂等：服务 + nginx 子路径 + 播放签名密钥
```

nginx：`/video/` 静态、`/video/api/` 反代、`/video/media/hls/` 走 `secure_link`、`/video-admin/*` 后台。
播放签名密钥在 `.env` 的 `MH_LINK_SECRET`，安装脚本注入 nginx。

## 容量

实测出口 **19 Mbps**（1000 人 480p 需 850 Mbps），单机约 22 人 480p。软件并发已验证 1000/3000 连接 0 错误。
要 1000–5000 人必须「切片上对象存储 + CDN」或 ≥1 Gbps 独服，详见 [deploy/CAPACITY.md](deploy/CAPACITY.md)。

## 已知边界

- 支付宝/USDT 为**真实协议实现但未配置商户参数**，线上仍需填 appId/私钥/公钥、收款地址；mock 渠道生产必须关闭。
- 试看（trial）为前端按秒截断 + 180 秒短签名，属防君子不防小人；要硬防需切片级加密。
- 素材为原站海报镜像，正式运营前替换为自有版权内容。
