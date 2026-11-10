# RBAC（RuoYi 风格，无组织架构）与多支付渠道设计

> 参考 RuoYi-Vue 的权限模型，去掉部门/岗位/数据权限中的"部门树"，只保留 **用户 · 角色 · 菜单/权限** 三主体；
> 支付侧把"一个 settings JSON"升级为 **多渠道配置表 + 敏感字段加密 + 默认渠道路由**。
> 本文的设计已经在当前系统落地（SQLite 版本），MySQL 目标 DDL 见 `deploy/sql/rbac-payment.mysql.sql`。

---

## 一、RBAC 三主体与表关系

```
sys_user ──< sys_user_role >── sys_role ──< sys_role_menu >── sys_menu
   ↑                                                          ↑
   └── 登录 → 角色集合 → 权限集合（perms）→ 接口 @PreAuthorize 校验
                                      └── 菜单树（M 目录 / C 菜单 / F 按钮）
```

| 表 | 作用 | 关键约定 |
|---|---|---|
| `sys_user` | 管理端用户（无 dept_id、无 post） | 口令 BCrypt；停用即失效；建议 2FA |
| `sys_role` | 角色 | `role_key` 唯一，业务用 key 不用名字；`data_scope` 只保留 1=全部 / 2=仅本人 |
| `sys_menu` | 菜单 + 权限二合一（RuoYi 的做法） | `menu_type`：`M` 目录 / `C` 菜单 / `F` 按钮；按钮行只填 `perms` |
| `sys_role_menu` | 角色 ↔ 菜单节点 | 保存时**必须连带父节点**，否则树渲染断裂 |
| `sys_user_role` | 用户 ↔ 角色 | 多角色取并集 |

**为什么菜单和权限共用一张表**：RuoYi 的核心取舍——一个菜单天然带一个 `perms` 字符串，角色授权就是"给这个节点"，不需要维护两套 ID。代价是"权限点"不能脱离菜单独立存在，对我们这种后台系统完全够用。

### 数据权限（无部门版）

- `1` 全部：看全站数据
- `2` 仅本人：`create_by = 当前用户`
- 不实现 `3 本部门 / 4 本部门及以下 / 5 自定义`——没有组织架构，这几档没有意义。

---

## 二、树形菜单：数据结构与层级

### 2.1 表结构（当前实现等价字段）

```sql
sys_menu(
  menu_id     BIGINT PK,
  menu_name   VARCHAR(50),
  parent_id   BIGINT NOT NULL DEFAULT 0,   -- 0 = 顶级
  ancestors   VARCHAR(500) DEFAULT '0',    -- 祖级路径 0,1,3（子树查询用 LIKE '0,1,%'）
  order_num   INT DEFAULT 0,
  menu_type   CHAR(1) CHECK (menu_type IN ('M','C','F')),  -- 目录/菜单/按钮
  path        VARCHAR(200),                -- 前端路由，如 /content/drama
  component   VARCHAR(255),                -- 视图组件，如 system/role/index
  perms       VARCHAR(200),                -- 权限标识，如 content.drama.write
  icon        VARCHAR(100),
  visible     CHAR(1) DEFAULT '0',         -- 0 显示 1 隐藏
  status      CHAR(1) DEFAULT '0'          -- 0 正常 1 停用
)
```

当前系统（SQLite）用 `permissions(code PK, name, type(dir|menu|button), parent_code, sort, path, icon, visible)` 表达同一模型，`code` 同时是菜单标识与权限点。

### 2.2 三层结构示例（真实数据）

```
📊 概览                        menu   dashboard /dashboard
🎬 内容管理                    dir    dir:content /content
   📺 剧集管理                 menu   content.drama /dramas
      · 查看剧集              button content.drama.read
      · 新建/编辑剧集          button content.drama.write
      · 上架/下架              button content.drama.publish
      · 删除剧集              button content.drama.delete
   🎞️ 分集与视频               menu   content.episode /episodes
      · 管理分集与上传         button content.episode.write
   💳 付费策略                 menu   content.policy /policies
      · 编辑付费策略           button content.policy.write
💰 交易管理                    dir    dir:commerce /commerce
   🏷️ 套餐定价                 menu   commerce.plan /plans
      · 管理套餐              button commerce.plan.write
   ↩️ 退款审核                 menu   commerce.refund /refunds
      · 发起退款              button finance.refund.create
      · 审批退款（双人复核）    button finance.refund.approve
⚙️ 系统管理                    dir    dir:system /system
   💳 支付渠道                 menu   system.paychannel /pay
      · 查看支付渠道           button payment.channel.read
      · 管理支付渠道（含密钥）  button payment.channel.write
```

规则：
1. **目录**只做分组，不挂权限；**菜单**对应一个页面并带 `perms`；**按钮**只做权限点。
2. 层级固定三层，超过三层不建（RuoYi 也建议 ≤3）。
3. 停用/隐藏的节点不参与前端路由，但权限点仍可被角色持有（便于灰度）。

### 2.3 树形接口

| 接口 | 方法 | 说明 |
|---|---|---|
| `/admin/api/menus` | GET | 返回 `{ tree, flat }`：`tree` 为嵌套结构，`flat` 供检索 |
| `/admin/api/roles/:id/menus` | GET | `{ roleId, checked: string[], tree }`，一次给全，前端直接回显 |
| `/admin/api/roles/:id/menus` | PUT | `{ codes: string[] }`，只传叶子也行，后端 `expandWithAncestors` 自动补父级 |
| `/admin/api/roles` | GET | 角色列表（含已授权 code） |
| `/admin/api/roles/:id` | PUT | 兼容旧接口（按权限码替换） |
| `/admin/api/menus`（新增菜单） | POST | 建目录/菜单/按钮，`parentCode` 指定父节点 |

当前实现的核心：`buildMenuTree()`（db.mjs）递归组装；`expandWithAncestors()` 保证无孤儿节点；保存走事务，失败回滚。

### 2.4 前端展示（树形，不是卡片）

- 组件：`el-tree`（Vue）或当前实现的原生递归树，关键参数：
  - `node-key="code"`、`show-checkbox`、`check-strictly=false`（父子联动）
  - `default-expanded-keys`：默认展开所有目录与菜单
  - `default-checked-keys`：**只传叶子**（避免半选态被误判为全选）
  - `getHalfCheckedKeys()`：保存时一并提交，或交给后端补父级
- 交互：搜索过滤（命中节点连同祖先展示）、展开/收起全部、全选/清空、已选计数、保存。
- 权限落地点：
  - 菜单：`/getRouters` 返回按权限过滤的路由，前端动态注册
  - 按钮：`v-hasPermi="['content.drama.write']"` 指令隐藏
  - 接口：`@PreAuthorize("@ss.hasPermi('content.drama.write')")` —— **唯一可信层**

当前实现（admin/app.js `pageRoles`）已按上述结构渲染：目录/菜单/按钮三类标签、缩进层级、父子联动、半选标记、搜索、全选/清空、保存后回显。

### 2.5 后端校验链

```
请求 → 解析 Bearer token → loadPrincipal(adminId)
     → roles → permissions Set（含 dir/menu/button 全部 code）
     → guard('content.drama.write') 命中则放行，否则 403 + audit(rbac.denied)
```

`hasPermission` 只匹配按钮级 code；菜单/目录 code 只用于渲染，不用于接口判断（避免"有菜单就能调接口"）。

---

## 三、支付渠道配置

### 3.1 为什么不用一个 JSON 配置

原来的 `settings.pay` 是单个 JSON：多环境、多场景、多主体（支付宝/微信/USDT）无法并存，且私钥明文入库、一改全站生效、无法灰度。
改为 **一行一个渠道配置**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `channel_id` | BIGINT PK | |
| `channel_code` | VARCHAR(32) | `alipay` / `wechat` / `usdt` / `mock` |
| `channel_name` | VARCHAR(64) | 展示名 |
| `scene` | VARCHAR(32) | `all` / `subscription` / `single`，支持"订阅走支付宝、单片走 USDT" |
| `env` | VARCHAR(16) | `sandbox` / `prod`，同一个 code 可并存两套 |
| `status` | CHAR(1) | 启用/停用；停用自动清默认 |
| `is_default` | TINYINT | 同 `scene` 内唯一 |
| `priority` | INT | 数字越小越优先（默认渠道不可用时的兜底顺序） |
| `currency` / `min_amount` / `max_amount` | | 路由约束：币种与金额区间不满足直接跳过 |
| `config_cipher` | TEXT | **AES-256-GCM 密文**，明文是 JSON（AppID、私钥、公钥、商户号、APIv3 Key、收款地址…） |
| `config_preview` | JSON | 脱敏副本，供列表/详情回显（`2021****0000`、`----****TEST（已加密）`） |
| `key_version` | INT | 密文用的密钥版本，用于轮换 |

唯一约束：`UNIQUE(channel_code, env, scene)`；MySQL 另用生成列保证"同场景仅一个默认"：
`default_scene = IF(is_default=1, CONCAT(scene,':default'), NULL)` + `UNIQUE(default_scene)`。

### 3.2 敏感信息存储

**加密方式**：AES-256-GCM（认证加密，防篡改），逐字段的 JSON 整体加密成一个 `v<ver>:<iv>:<tag>:<cipher>` 串。

- 主密钥（KEK）**不入库**：来自环境变量 / KMS / 密钥管理服务，`MH_CONFIG_KEYS="1:<base64 32B>,2:<base64 32B>"`。
- 支持多版本：解密按密文里携带的版本取对应密钥；新增数据用 `MH_CONFIG_KEY_VERSION` 指定版本。
- 轮换流程：加入新版本密钥 → 批量重加密（读旧版本 + 写新版本，`key_version` 更新）→ 观察稳定后下线旧密钥。
- 代码：`server/secretbox.mjs`（`sealSecret` / `openSecret` / `maskConfig`）。

**访问控制**
1. `payment.channel.write` 才能改渠道；`payment.channel.read` 才能看列表（列表仍是掩码）。
2. 私钥类字段**只写不读**：编辑时留空 = 保持原值；任何接口都不返回明文。
3. `test` 接口只做配置完整性校验，不发起真实扣款。
4. 审计：`payment.channel.*` 全部落 `audit_logs`，`field_diff` 只记变更字段名，不记明文。
5. 日志：请求体不落盘；`config_cipher` 不打印。

**合规建议**：生产优先接 KMS（阿里云 KMS / AWS KMS / Vault），把主密钥放在 KMS 里，应用只拿信封密钥；数据库备份加密；密钥与代码分离（当前 `.env` 已经权限 600 且不入仓）。

### 3.3 多渠道管理与默认渠道

**路由算法**（`resolveChannel`）：

```
候选 = status='enabled' 且 (scene=all 或 scene=目标场景)
       且 币种匹配 且 min_amount ≤ 金额 ≤ (max_amount 或 ∞)
排序 = is_default DESC, priority ASC, id ASC
取第一个 → 返回渠道行 + 解密后的 config（仅在服务端内存）
无候选 → 业务错误 channel_unavailable（前端提示"暂无可支付方式"）
```

- 显式指定：用户在收银台选了渠道 → 优先按 `channel_code` 过滤；不满足约束则回落到默认（可配置为严格模式）。
- 场景化：订阅走支付宝、单片走 USDT 这类需求，用 `scene` 区分，无需改代码。
- 环境：`sandbox` / `prod` 并存，按 `NODE_ENV` 或渠道开关决定；切生产只改一行状态。

**默认渠道切换**（`setDefaultChannel`）：

```
BEGIN
  UPDATE sys_pay_channel SET is_default=0 WHERE scene=当前渠道的 scene
  UPDATE sys_pay_channel SET is_default=1 WHERE channel_id=?
COMMIT
→ 审计 payment.channel.setDefault（记录操作人、原因、IP）
→ 缓存失效（进程内 LRU / Redis key pay:channel:<scene>）
```

- 事务保证"任何时刻同场景最多一个默认"，MySQL 侧再由生成列唯一索引兜底。
- 停用渠道时自动清掉默认标记，避免"默认渠道不可用"。
- 灰度：把新渠道 `priority` 调高 + 不设默认 → 只在用户主动选择时命中；观察 `orders.channel` 分布后再切默认。

### 3.4 订单快照（配置变更不影响对账）

下单时把渠道信息写进订单，而不是运行时再查：

```sql
orders(channel, channel_id, channel_env, channel_key_version, channel_txn_id, usdt_rate, usdt_amount ...)
```

- 渠道改价/换密钥/停用后，历史订单仍能按当时的配置对账。
- `channel_txn_id` 唯一 → 回调幂等；`channel_key_version` 便于排查"当时用的哪把密钥"。

### 3.5 接口清单

| 接口 | 方法 | 权限 | 说明 |
|---|---|---|---|
| `/admin/api/pay-channels` | GET | `payment.channel.read` | 列表（掩码）+ 可用渠道 + 密钥版本 |
| `/admin/api/pay-channels` | POST | `payment.channel.write` | 新建（config 明文只进不出） |
| `/admin/api/pay-channels/:id` | PUT | `payment.channel.write` | 更新；私钥留空=不改 |
| `/admin/api/pay-channels/:id/status` | POST | `payment.channel.write` | 启停（原因必填） |
| `/admin/api/pay-channels/:id/default` | POST | `payment.channel.write` | 设为默认（原因必填） |
| `/admin/api/pay-channels/:id/test` | POST | `payment.channel.read` | 配置完整性自检 |
| `/admin/api/pay-channels/:id` | DELETE | `payment.channel.write` | 删除（默认渠道禁止删） |
| `/api/constants` | GET | 公开 | 返回可用渠道与默认渠道（前端渲染收银台） |

后端内部：`paymentOptions(scene)` 给 C 端；`resolveChannel({scene, channelCode, amount})` 给下单；`channelConfig(row)` 只在服务端解密。

---

## 四、与当前系统的落地映射

| 设计 | 当前实现 |
|---|---|
| `sys_user / sys_role / sys_menu / sys_role_menu / sys_user_role` | `admins / roles / permissions / role_permissions / admin_roles` |
| `menu_type M/C/F` | `permissions.type = dir / menu / button`，`parent_code` 表达父子 |
| `ancestors` 加速子树 | 规模小（50 节点），直接内存递归组树 |
| `el-tree` 父子联动 | admin/app.js 原生树：`setSubtree` 下钻、`computeHalf` 半选 |
| `@PreAuthorize` | `handleAdmin` 内 `guard(perm)` + `hasPermission(principal, perm)` |
| `sys_pay_channel` | `pay_channels`（同字段，JSON 用 TEXT） |
| MySQL 生成列唯一默认 | SQLite 靠 `setDefaultChannel` 事务 + 应用校验 |
| 密钥轮换 | `MH_CONFIG_KEYS` 多版本 + `key_version` 列 |

迁移脚本：`syncMenuCatalog()` 每次启动幂等补齐树节点并给超管全量授权；`migratePayChannels()` 把旧的 `settings.pay` JSON 拆成渠道行并按新密钥加密。

---

## 五、风险与后续

| 风险 | 现状 | 建议 |
|---|---|---|
| 主密钥泄露 | 存在 `.env`（600 权限） | 接 KMS，密钥不下磁盘；定期轮换并重加密 |
| 渠道密钥进日志 | 已规避（不回传、不打印） | 加日志脱敏中间件兜底 |
| 默认渠道被误切 | 有审计 + 原因必填 + 二次确认 | 生产环境加"双人复核"（参照退款） |
| 多环境混用 | `env` 字段隔离 | 生产库禁用 sandbox 渠道（启动自检） |
| 无组织架构的数据隔离 | 只有 all/self | 如未来有多主体运营，再加 `owner_id`，不要再引入部门树 |
| 树节点过多 | 当前 49 个节点 | 超过 200 时给 `sys_menu` 加 `ancestors` 并做缓存 |
