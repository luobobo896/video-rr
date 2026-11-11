# 影巢前后端深度评审（UI / 性能 / 规范）

- 评审日期：2026-11-10
- 代码基线：`60ceb77`
- 评审方式：源码审查 + 本地真实浏览器 + 线上只读复测
- 本地测试环境：Node `v24.19.0`，`http://127.0.0.1:8788`（复制库，不写入 `storage/app.db`）
- 浏览器视口：1440×900、1366×768、1024×768、900×844、390×844、320×700
- 回归基线：修复后 `npm test` **92/92 通过**

> 本文最初用于评审，随后已按以下状态表落地修复。当前工作库有 5 部剧 / 3 集，其中仅 1 部已上架；README 和既有验收报告写的是 33 部 / 723 集，数据口径本身已经不一致。

## 一、结论

没有发现权限绕过、支付数据写坏或明确的数据损坏问题。当前体验问题主要不是 SQLite 查询慢，而是：

1. 移动端多个页面存在真实横向溢出，按钮被推到屏幕外。
2. C 端和 B 端侧栏都有“菜单在视口外且没有可达提示”的问题。
3. 播放页工具条在 390px 宽度下覆盖大部分视频。
4. 线上慢链路下单次导航 1.6–2.5 秒，前端没有加载态、超时和请求取消，用户会感觉“点了没反应”。
5. 后台列表没有分页，且高频查询字段缺索引，数据增长后会明显变慢。
6. DESIGN.md 的控件/圆角规范和实际 CSS 已经漂移，规范里的验收脚本在仓库中不存在。

## 修复状态（2026-11-10 本轮已落地）

| 项目 | 状态 | 验证 |
|---|---|---|
| 390px 详情页按钮溢出 | 已修复 | `scrollWidth = 390`，四个按钮两列换行 |
| 390px 榜单 Tab 竖排/溢出 | 已修复 | `scrollWidth = 390`，Tab 横向滚动、49px 宽 |
| 后台 390px 页面溢出 | 已修复 | `scrollWidth = 375`（仅滚动条占位），内容区 375px |
| 320px 后台登录页溢出 | 已修复 | 卡片 288px，`scrollWidth = 320` |
| C 端侧栏 104px / 32px 项高 | 已修复 | 实测 104px / 32px，激活项自动滚入 |
| 后台侧栏 footer 被裁 | 已修复 | `#nav` 独立滚动，footer 在 900px 视口内可见 |
| 移动端底栏 24 项横向挤压 | 已修复 | 仅保留 5 个主入口：精选/分类/电影/榜单/我的 |
| 播放器工具条覆盖视频 | 已修复 | 390px 下工具条 54px / 视频 200px，单行不换行 |
| 顶部历史/收藏无 active、我的标题错 | 已修复 | `#/me?tab=history` active = 我的/历史收藏，标题为“我的 · 影巢” |
| 请求无超时/无取消 | 已修复 | 15s 超时、路由切换 AbortController、旧响应丢弃 |
| 后台列表无分页 | 已修复 | 订单 58 笔分 3 页、用户 22 人分 2 页、审计 451 条分 23 页 |
| 高频字段缺索引 | 已修复 | 新增 orders/subscriptions/section_items 等索引，测试断言通过 |
| 超限 JSON 无 413 | 已修复 | 2.1MB 后台请求与 4.1MB C 端请求均返回 413 |
| 500 泄漏内部异常 | 已修复 | 兜底响应统一为“服务器错误” |

仍需后续处理：后台复杂表格在 390px 采用面板内横向滚动而不是卡片化；DESIGN 的部分圆角/对比度仍需统一；当前工作库数据量与文档口径仍未对齐。
四终端（手机 / iPad / 安卓平板 / PC）的统一断点、组件与刮削刷新规范见 `docs/RESPONSIVE-DESIGN-SYSTEM.md`。

## 二、P1：用户可直接感知的问题

### 2.1 390px 详情页横向溢出 102px

- 视口：390×844
- 实测 `document.documentElement.scrollWidth = 492`
- `.detail-actions` 四个按钮单行不换行，最后两个按钮超出视口：
  - “＋ 收藏”右边界 416
  - “分享”右边界 492
- 根因：`.detail-actions { display: flex; gap: 10px; }`，移动端断点没有改成换行或栅格。
- 相关位置：
  - `public/styles.css` `.detail-actions`
  - `public/app.js` 详情页按钮组
- 影响：移动端收藏、分享不可见；整页可横向拖动。

### 2.2 390px 榜单页横向溢出，9 个 Tab 被压成 19px

- 视口：390×844
- 实测 `scrollWidth = 411`
- 9 个 `.tab` 每个宽度仅 `19px`，中文逐字竖排；最后一个“冷门佳作”完全在视口外。
- 根因：`.tabs { display:flex; gap:26px; }`，子项允许收缩，且没有横向滚动容器。
- 相关位置：
  - `public/styles.css` `.tabs` / `.tab`
  - `public/app.js` 榜单页 Tab 模板
- 影响：390px 下榜单导航几乎不可读。

### 2.3 后台 390px 全站横向溢出

- 视口：390×844
- 实测 `scrollWidth = 478`，内容区只剩 `165px`
- 侧栏固定占 `210px`，卡片宽 `160px` 后右边界到达 `396px`，顶部“看经营数据”右边界 `436px`
- 320×700 登录页：`.login-card` 固定 `360px`，`scrollWidth = 360`
- 根因：
  - 后台没有 ≤900px 的布局断点；只有 `.split` 的 1100px 断点。
  - `.login-card { width: 360px; }` 没有 `max-width`。
- 相关位置：
  - `admin/styles.css` `.side`、`.login-card`
- 影响：手机上后台整页横向滚动，主要操作区被侧栏挤没。

### 2.4 C 端桌面侧栏底部菜单不可见

- 1366×768：
  - 侧栏 `scrollHeight = 973`，`clientHeight = 768`
  - “季度榜 / 高分榜 / 冷门佳作 / 历史 / 收藏”在视口外
  - 打开 `#/me` 后，激活项“历史 / 收藏”的 `bottom = 918.8`，`scrollTop` 仍为 `0`
- 1440×900 仍有 73px 内容被裁掉。
- 侧栏滚动条被 `scrollbar-width: none` 和 `::-webkit-scrollbar { display:none }` 隐藏，用户不知道这里能滚。
- 根因：
  - 24 个一级菜单仍使用固定 112px 宽、单列滚动侧栏。
  - 路由切换只切 `.active`，没有把激活项 `scrollIntoView({ block: 'nearest' })`。
- 相关位置：
  - `public/styles.css` `.sidebar`
  - `public/app.js` `renderChrome()` / `navIsActive()`

### 2.5 后台侧栏展开后底部菜单和退出按钮被裁掉

- 1440×900，展开全部分组：
  - `#nav.scrollHeight = 994`
  - 侧栏内容总高度 `1168`
  - 4 个链接在视口外；“打开 C 端 / 修改密码 / 退出登录”在 `y = 1065`，页脚不可见
- 1366×768：
  - 6 个链接被裁掉
- 根因：
  - `.side` 是 `height:100vh`，但 `overflow` 是 `visible`。
  - `#nav` 不是独立滚动容器。
  - `highlightNav()` 给 `nav.scrollTop` 赋值，但 `#nav` 本身不可滚动，这个补偿实际无效。
- 相关位置：
  - `admin/styles.css` `.side`、`#nav`
  - `admin/app.js` `highlightNav()`

### 2.6 C 端 390px 底部导航把“我的”推到 870px

- 视口：390×844
- 24 个菜单项中，15 个在首屏可见
- 第一组频道宽度 `856px`，第三组“历史 / 收藏”起点 `x = 870`
- 底部栏虽然可横向滑动，但无滚动提示；“我的”必须先滑过全部频道。
- 根因：移动端仍把 14 个频道和“我的”全部塞进一个横向 flex 容器。

### 2.7 390px 播放页工具条遮挡 84.5% 视频

- 视口：390×844
- `.player` 高度 `182.3px`
- `.player-tools` 高度 `154px`，`top = 144.8`，`bottom = 298.8`
- 工具条覆盖了视频主体的大部分区域。
- 根因：`.player-tools` 绝对定位在播放器底部，移动端继续 `flex-wrap: wrap`，但播放器高度固定为 16:9，没有给多行工具条留空间。
- 建议：≤900px 时工具条移出 `.player`，放在播放器下方；或限制为单行并给按钮图标化。

### 2.8 “我的”页侧栏高亮丢失，浏览器标题还是上一页

- 打开 `#/me?tab=history` 后：
  - `.sidebar .nav-item.active` 数量为 **0**
  - `document.title = "全部分类 · 影巢"`
- 根因：
  - `navIsActive()` 对“无 query 的 href”要求当前 hash 也没有 query；`#/me?tab=history` 因此不匹配 `#/me`。
  - `renderMe()` 没有设置 `document.title`。
- 影响：用户从顶栏进入历史/收藏/会员时，侧栏没有当前位置反馈，标签页标题保持上一页。

### 2.9 慢链路下“点击后不动”，且无超时/取消

- 线上同机复测：
  - 首页 → 分类：约 **1.6s** 才出现分类内容
  - 分类 → 电影：约 **2.45s**
- 本地同一交互约 **243ms**（含浏览器自动化开销）
- 线上 API 首字节：
  - `/api/home`：0.41–0.99s
  - `/api/category`：0.44–0.82s
  - `/api/rank`：0.40–1.04s
- 线上静态资源首字节：
  - C 端 `app.js`：约 0.9–1.25s（gzip 后 28,955B）
  - 后台 `app.js`：约 0.91–1.12s（gzip 后 37,965B）
- 这说明慢主要来自跨境链路/入口，不是本地 SQLite。
- 但前端放大了体感：
  - `api()` 没有超时、没有 `AbortController`；
  - `route()` 不显示 loading，旧页面一直保留，请求完成才 `scrollTo(0,0)`；
  - 路由与分类筛选没有请求序号/取消，快速点击时存在旧响应覆盖新状态的竞态。
- 相关位置：
  - `public/app.js` `api()`、`route()`、`renderCategory()` 的 `applyPatch()`
  - `admin/app.js` `api()`、`route()`

## 三、P2：后端与规模化风险

### 3.1 后台列表没有真正的分页

- `/admin/api/orders`：默认 100，最大 300；没有 `total/page` 返回。
- `/admin/api/users`：固定 `LIMIT 200`，没有分页参数。
- `/admin/api/audit`：默认 100，最大 500。
- `/admin/api/refunds`：固定 `LIMIT 100`。
- 前端订单页只写“最近 100 笔”，用户和审计页没有截断提示。
- 影响：超过上限的数据不可发现；表格一次性加载全部行，页面会越来越长。

### 3.2 高频查询缺索引

当前 SQLite 仅有以下业务索引：

- `play_events(created_at)`、`play_events(drama_id)`
- `drama_tags(tag_id)`
- `audit_logs(created_at)`
- `users(email)` 唯一索引
- `episode_price_rules(drama_id, from_no)`

缺索引的高频字段包括：

- `orders(user_id)`、`orders(status, id)`
- `subscriptions(user_id, status, valid_to)`
- `purchases(user_id, status)`
- `favorites(user_id, drama_id)`
- `history(user_id, drama_id)`
- `comments(drama_id, status)`、`danmus(episode_id, status)`
- `section_items(section_id, sort)`、`rank_items(list_id, rank_no)`

后台用户列表还有按用户逐行执行的订单数、累计付费、会员到期三个相关子查询；数据量上来后会形成近似 N+1 的扫描成本。

### 3.3 超限 JSON 请求不会返回 413

- C 端 `readBody` 在 4MB 时直接 `req.destroy()`，但 Promise 没有 `reject`。
- 后台 `readBody` 在 2MB 时同样直接 `req.destroy()`。
- 请求被断开，调用方拿不到明确的 413/4xx，服务端也没有可观察的结果。

### 3.4 500 错误把内部异常文本直接返回

- `server/index.mjs` 的兜底 500 响应使用 `String(error.message)` 作为 `msg`。
- 可能把 SQLite/文件路径/内部实现细节暴露给客户端。
- 应返回稳定错误码和通用文案，详细信息只进日志。

## 四、规范对照

| DESIGN.md 要求 | 实际值 | 结论 |
|---|---|---|
| 侧栏 `104px` | C 端 `112px` | 不符合 |
| 侧栏项高 `32px` | 实测 `33.5px` | 不符合 |
| 控件高度只允许 32/40/48 | 导航 35.5、pill 27.5、播放器控件约 33.5 | 不符合 |
| 圆角只允许 8/10/14/999 | CSS 仍出现 2/4/5/6/12/16 | 不符合 |
| 一页一个主要按钮 | 后台权限/退款等页面多行都有 `.btn primary` | 规范与实际语义冲突 |
| 验证命令 `outputs/mh-recon/measure-all.mjs` | 文件不存在 | 验收不可复现 |
| 既有报告引用 `verify-system.mjs` / `check-perms.mjs` | 文件不存在 | 验收不可复现 |

另外：

- 评审前 README 仍写“任意手机号登录”“admin/admin123”，但当前实现是邮箱验证码/密码登录，弱口令会被轮换；本轮已同步修正。
- 评审前 README 写“12 项测试”，实际修复后 `npm test` 为 92 项；本轮已同步修正。
- README 写 33 部 / 723 集，当前本地库为 5 部 / 3 集 / 1 部已上架；`data/catalog.json` 只有 19 部。
- 页面大量使用 `--text-3`：C 端对比度约 4.09:1，后台约 3.77:1，低于 WCAG AA 的 4.5:1。
- C 端品牌渐变上的白字对比度约 3.42:1（#ff3d6e）/ 2.59:1（#ff7a45），主按钮文字不达标。
- 搜索输入框只有 placeholder，没有可访问名称；后台 `table input:focus` 移除了 outline，只留红色边框。

## 五、建议修复顺序

### 第一批：只改 CSS，先消灭溢出和遮挡

1. `.tabs` 加 `overflow-x:auto`，`.tab` 加 `flex:0 0 auto; white-space:nowrap`。
2. `.detail-actions` 在 ≤900px 改为 `display:grid; grid-template-columns:repeat(2,minmax(0,1fr))` 或 `flex-wrap:wrap`。
3. 后台增加 ≤900px 布局：侧栏改为抽屉或顶部条；`.login-card` 改 `width:min(360px, calc(100vw - 32px))`；表格外包 `overflow-x:auto`。
4. `.player-tools` 在 ≤900px 移出播放器，放在播放器下方。

### 第二批：侧栏可达性

1. C 端路由切换后对 `.nav-item.active` 执行 `scrollIntoView({ block: 'nearest' })`。
2. C 端移动端底栏只保留 5–6 个主入口，其余收进“更多”。
3. 后台 `.side` 设 `min-height:0`，`#nav` 设 `flex:1; overflow-y:auto; min-height:0`，`.side-foot` 设 `flex:0 0 auto`。

### 第三批：交互反馈与竞态

1. `api()` 增加 15s 超时和 `AbortController`。
2. `route()` 加请求序号，旧请求返回时直接丢弃；切换时显示 skeleton/`aria-busy`。
3. 分类筛选 `applyPatch()` 取消上一笔请求，或使用递增 `requestId` 丢弃旧响应。

### 第四批：后端规模化

1. 后台 orders/users/audit/refunds 增加 `page/pageSize/total` 契约和前端分页。
2. 按 3.2 补索引，并用 `EXPLAIN QUERY PLAN` 验证不再全表扫描。
3. `readBody` 超限时返回 413，不要只 `destroy()`。
4. 500 错误只返回通用文案，详细异常写日志。

## 六、可重复验证

```powershell
npm test

# 本地 API 基线（20 次）
# /api/home P50 1.2ms
# /api/category P50 5.2ms
# /api/rank P50 1.0ms
# /api/search P50 0.9ms

# 线上首字节
curl.exe -sS -o NUL -A "Mozilla/5.0" -H "Accept-Encoding: gzip, br" `
  -w "%{http_code} bytes=%{size_download} ttfb=%{time_starttransfer}s total=%{time_total}s" `
  https://hk.hsddns.com/video/api/category?type=ALL
```

浏览器复测重点：

- 390×844：`#/drama/1`、`#/rank?type=HOT`、`#/play/1/1`
- 320×700：`/admin` 登录页
- 390×844：登录后的 `/admin`
- 1366×768：C 端 `/me`、后台展开全部分组
