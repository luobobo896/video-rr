# 商业化设计：权益、订单、支付、退款、对账

## 1. 权益判定（唯一入口 `resolveAccess`）

```
输入：userId, dramaId, episodeNo
1. purchases 命中（active 且未过期）           → allow, source=purchase
2. subscriptions 命中（active、未过期、scope 覆盖）→ allow, source=subscription
3. content_policies.access_mode = free          → allow, source=free
4. access_mode = subscription 且 no ≤ free_episodes → allow, source=free
5. 否则拒绝：reason=subscription_required | single_purchase_required
   附带 price / trialSeconds / plans（前端据此渲染购买弹窗）
```

- `plans.scope`：`all` 或 `category:TV`，用于「不同档位看不同内容池」。
- `content_policies.access_mode='paid'` 的内容，**订阅也不放行**，必须 `purchases`。
- 单个订阅按最长有效期判定；续费在 `valid_to` 基础上顺延（不覆盖剩余时长）。

## 2. 内容策略（后台「付费策略」）

| 字段 | 含义 | 示例 |
|---|---|---|
| access_mode | free / subscription / paid | 剧集=subscription，高价值电影=paid |
| free_episodes | 前 N 集免费 | 剧集 1，电影 0 |
| trial_seconds | 未授权试看秒数 | 电影 360（6 分钟） |
| single_price_cny | 单片价格 | 12.00 |
| purchase_kind | single（买断）/ rental（租赁） | single |
| rental_hours | 租赁时长 | 72 |

## 3. 订单状态机

```
created ──支付成功──▶ paid ──发放权益──▶ fulfilled
   │                    │                 │
   │15min 未付           │退款             │退款
   ▼                    ▼                 ▼
 closed            refunding ─▶ refunded（权益回收）
```

- `out_trade_no` 唯一；`payments.channel_txn_id` 唯一 → 回调重放天然幂等。
- 金额校验：回调金额与订单金额差 >0.01 直接拒绝。
- 发放失败进人工：`/admin/api/reconcile` 会补支付/补权益。

## 4. 支付渠道

### 支付宝（RSA2）
1. 后台「支付配置」填 `appId`、`privateKey`（商户私钥 PEM）、`publicKey`（支付宝公钥）、`notifyUrl`。
2. 下单返回 `gateway.do?...&sign=` 跳转支付；异步通知 `POST /api/notify/alipay` 验签后入账。
3. 退款：`pay.refundEnabled=true` 后才自动完成，否则退款单停在「已通过」等人工执行。

### USDT（TRC20）
1. 下单锁定汇率（`site.usdtRate`）与收款地址，15 分钟有效。
2. 回调 `POST /api/notify/usdt` `{outTradeNo, txid, amount, confirmations}`；`confirmations < minConfirmations(19)` 只记录不发放。
3. 金额容差 0.5%；txid 去重。

### mock（仅演示）
`/pay/mock/<outTradeNo>` 一键支付成功。生产在「支付配置」里把 `mock.enabled` 设为 false。

## 5. 退款与双人复核

```
财务 A 发起（原因必填）→ refunds.status=pending
财务 B 审批 → approved → 执行：回收 subscriptions/purchases → 订单 refunded
```

- 发起人 = 审批人时接口直接 400（`dual_control_required`）。
- 回收后用户再次访问该内容会重新被拦（判定实时查库，无缓存）。

## 6. 对账

每日跑 `/admin/api/reconcile`（可挂 cron）：

| 检查 | 处理 |
|---|---|
| 订单已支付但无 payments 记录 | 补录支付并发权益 |
| 订单停在 paid 未 fulfilled | 补发权益 |
| payments 存在但订单非支付态 | 列出人工核查 |

## 7. 播放鉴权

```
GET /api/play/:id/:no
  权益不足 → 402 {reason, price, plans, trialSeconds}
  通过     → Set-Cookie mh_link=<md5(expires+"/media/hls/<id>/index.m3u8"+secret)>
             Set-Cookie mh_exp=<expires>
             { hls: "/media/hls/<id>/index.m3u8", expiresIn: 600 }
nginx: secure_link $cookie_mh_link,$cookie_mh_expires;
       secure_link_md5 "$secure_link_expires/media/hls/$hls_tail<secret>";
       失败 → 403
```

- 用 Cookie 而不是 query，是因为 HLS 播放器请求分片时会丢掉 query 但会带 Cookie。
- 签名 10 分钟有效；播放器每次取流时由接口重签。
- 本地开发 `MH_ALLOW_UNSIGNED=1` 可关闭校验。

## 8. RBAC 矩阵（默认）

| 角色 | 关键权限 |
|---|---|
| super_admin | 全部（含 `finance.refund.approve`） |
| content_ops | 剧集/分集/付费策略/审核 |
| finance | 订单查看、退款发起 + 审批、对账、经营数据 |
| cs | 查单、补发权益、用户查看 |
| auditor | 内容审核、审计日志只读 |
| analyst | 经营数据、订单只读 |

权限点共 24 个，命名 `<域>.<对象>.<动作>`；后台「角色权限」页可勾选保存，接口即时生效（本人权限变更需重新登录）。
