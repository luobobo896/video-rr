# 运营后台使用说明（2026-11 改版）

面向：运营 / 财务 / 客服。对应代码 `server/api-admin.mjs` 与 `admin/app.js`。

## 1. 登录与账号

- 入口：`https://<域名>/video-admin/`（**必须带尾斜杠**；不带会 301 补斜杠）。
- 后台账号（B 端）与 C 端注册用户是两张表、两个登录入口，互不通用：
  - B 端账号在「系统设置 → 管理员账号」；
  - C 端用户在「用户 → C 端用户」。
- 口令策略：**≥8 位，同时含字母与数字，不含用户名，不能是常见弱口令，至少 4 种不同字符**（实现见 `server/api-admin.mjs` 的 `checkAdminPassword`）。
- 首次登录 / 被重置后登录会强制改密；改完请同步更新服务器上的 `storage/admin-initial-passwords.txt`。
- 连续输错会按用户名 + IP 锁 10 分钟（计数存在 Redis 的 `mh:login-fail*`，运维可清）。

### 1.1 管理员账号（增删改 + 分配角色）

「系统设置 → 管理员账号」列的是 **B 端后台账号**，不是 C 端用户。每行可「编辑 / 分配角色 / 重置口令 / 停用 / 删除」，表头「＋ 新建后台账号」。

- 角色决定权限（`roles` + `role_permissions`）：超级管理员 / 内容运营 / 财务 / 客服 / 审核员 / 数据分析，新建时必须至少勾一个。
- 重置口令、停用都会**吊销该账号所有在线会话**（旧 token 立刻 401），不需要等 token 过期。
- 安全阀：最后一个启用中的超级管理员不能被停用、不能被摘掉超管角色、不能被删除；也不能删除当前登录的自己。
- 接口：`POST /admin/api/admins`、`PUT /admin/api/admins/:id`、`POST /admin/api/admins/:id/password`、`DELETE /admin/api/admins/:id`（权限 `system.admin`），异常由 `rbac.mjs` 抛带 `status` 的错误、`api-admin.mjs` 的 `fail()` 映射成 400/404/409。

### 1.2 菜单管理（与角色权限分开）

权限回答「谁能做什么」，菜单回答「后台长什么样」，两者独立建模：

- 权限树在 `permissions` 表（含 `system.menu`、`system.menu.write` 节点）。
- 侧栏菜单在 `admin_menus` 表（`group_key / group_label / group_sort / label / route / icon / perm_code / sort / visible / is_system`），首次启动按 `DEFAULT_ADMIN_MENUS` 播种 20 条（概览 3 / 内容 6 / 交易 4 / 用户 1 / 系统 6）。
- 「系统设置 → 菜单管理」（`#/menus`）可新增菜单、改名称/路由/图标/排序、隐藏、删除、恢复出厂菜单。`perm_code` 必须是 `permissions` 里已存在的权限码；同分组同路由拒绝重复；`is_system` 的内置菜单只能隐藏不能删。
- `GET /admin/api/me` 只下发当前账号**有权限**的菜单项，因此换角色后侧栏立即变化；改菜单不需要改代码、也不影响任何角色授权。
- 接口：`GET /admin/api/admin-menus`、`POST`、`PUT/DELETE /admin/api/admin-menus/:id`、`POST /admin/api/admin-menus/reset`（权限 `system.menu` / `system.menu.write`）。

## 2. 新建剧集（向导）

「内容运营 → 剧集管理 → ＋ 新建剧集」：

1. 只填标题（电影/剧集原名），点「自动搜刮」。
2. 搜刮来源三级：`data/catalog.json` 内置片库 → 本地缓存 `scrape_cache` → 可选外部 `MH_SCRAPE_URL`。
   都查不到时会明确提示「没查到，按草稿填」，**不会编造字段**。
3. 搜刮只补空字段，手动改过的值不会被覆盖；同名词条会提示「站内已有：XXX（#id）」。
4. 底部实时显示「还缺：…」。**字段不全只能存草稿，不能上架**：
   必填 = 标题 / 内容类型 / 付费模式 / 封面 / 年份 / 地区 / 评分。
5. 封面/横幅批量补齐：`内容运营 → 剧集管理` 表头「🖼 一键搜刮素材」（`POST /admin/api/artwork/refresh`）。
   规则：本地 `storage/images/cover-<slug>.jpg` 与 `banner-<slug>.jpg` 直接复用 → 有源片 `storage/sources/<slug>.*` 时用 ffmpeg 抽帧（封面 12% 处、横幅 22% 处）→ 再退回 archive.org 缩略图并本地化。
   横幅只补 `banners` 表里有图可用的已上架剧，不会编造无图横幅（`POST /admin/api/banners/autofill` 同理）。

## 3. 付费策略与按集定价

「内容运营 → 付费策略」：

- 整体策略（三选一，中文）：免费 / 会员免费 / 单独收费，配免费集数、试看秒数、单片价。
- 「按集规则」用于组合策略，例如「VIP 免费，但最后 2 集要单独买」：
  - 规则从上到下匹配，命中第一条即生效，未命中的集走整体策略；
  - 起始集必填，结束集留空 = 到最后一集；
  - 规则三种：免费观看 / 需会员 / 需单集购买（会员也要单独买），单集价可单独设；
  - 新增一行默认给「最后两集单独收费」，不会因为忘记改而把整部剧变成会员专享。
- 判定优先级（`server/entitlements.mjs` 的 `resolveAccess`）：
  已购单片 → 按集规则 → 会员覆盖 → 免费集/免费库 → 拒绝。

## 4. 标签

「内容运营 → 标签管理」：

- 支持一级/二级（最多两级），列表分页，启停开关即时生效（C 端筛选立刻看不到停用标签）。
- 改名、换父级走「编辑」弹层；删除二级标签会先解挂，不会留下孤儿绑定。

## 5. 榜单

「内容运营 → 榜单」：

- 自动榜每天按用户行为重算（服务启动 60 秒后跑一次，之后每 6 小时一次）：
  热播 = 播放 + 完播×2 + 收藏×3 + 成交×5（近 30 天）；飙升 = 近 7 天同比；搜索 = 搜索词命中；口碑 = 评分 + 收藏。
- 人工插入或想固定的条目点「锁定」，重算时原位保留；「刷新此榜 / 立即刷新全部」可手动触发。

## 6. 数据

- 概览（`#/dashboard`）只放平台资产：已上架剧集、分集可播数、标签、C 端用户、转码队列、待审弹幕/评论、内容结构。
- 收款、订阅、退款在「数据概览 → 经营数据」（`#/analytics`）。
- 埋点明细在「数据概览 → 埋点数据」（`#/events`）：曝光、详情页浏览、付费墙展示/点击、播放结束、搜索、分享、分类筛选、榜单浏览、打开登录。

## 7. 验证脚本

```bash
# 本地
MH_OTP_TEST=1 node --test                      # 单元/接口测试
node ../outputs/mh-recon/verify-system.mjs http://127.0.0.1:8791
node ../outputs/mh-recon/probe-admin-ops.mjs   # 后台接口 25 项断言
node ../outputs/mh-recon/probe-admin-rbac.mjs  # 账号 CRUD + 菜单管理 23 项断言
node ../outputs/mh-recon/probe-hardening-fixes.mjs  # 评审整改 7 项断言

# 线上（HK）
ADMIN_PASSWORD='<后台口令>' bash deploy/verify-hk.sh
bash deploy/verify-play.sh
```
