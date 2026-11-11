# 影巢前端全仓代码审核（2026-11-11）

> 本报告的 P0/P1 已按 `docs/testing/2026-11-11-frontend-fixes.md` 修复；该文件保留原始问题与证据，便于追溯。

## 0. 结论

- 审核基线：`2026-11-11 10:15` 左右的工作区。审核期间 `public/app.js`、`public/i18n.js`、`public/styles.css` 被并发修改，行号以本报告写入时为准。
- 审核范围：C 端 `public/`、后台 `admin/`、共享令牌 `shared/`、`DESIGN.md` 与响应式规范。
- 结论：**不可直接发布**。发现 **3 个 P0、13 个 P1、16 个 P2、4 个 P3**。
- 静态 `node --check`、`npm test`（120/120）、`impeccable detect`（静态 0 条）和 `@google/design.md lint` 均通过，但这些门禁没有覆盖运行时未定义函数、存储型 XSS、15 秒上传超时、移动端样式覆盖和权限映射错位。

| # | 维度 | 分数 | 关键问题 |
|---|---|---:|---|
| 1 | Accessibility | 2/4 | 自动轮播无持久暂停；移动端输入 14px 会触发 iOS 缩放；路由后焦点与 `aria-current` 不完整；后台 RBAC 树丢焦点。 |
| 2 | Performance | 2/4 | 视频上传被 15 秒超时截断；曝光观察器、弹层监听和 USDT 定时器泄漏；HLS 失败结果永久缓存。 |
| 3 | Theming | 2/4 | 令牌生成器正确，但页面仍有大量直接色值和内联样式；重复根变量和后加载令牌覆盖了移动端规则。 |
| 4 | Responsive Design | 2/4 | 390/768 实测无页面级横向滚动，但移动输入字号、后台触控目标和多套断点仍不符合文档。 |
| 5 | Implementation Integrity | 1/4 | 提现调用未定义函数；后台存储型 XSS；上传超时；权限映射、分页和金额处理存在系统性缺口。 |
| **总分** | | **9/20** | **Poor：需要重大整改** |

### Implementation Integrity Verdict

**FAIL。** 视觉方向和产品身份是连贯的，但工程实现不具备发布级完整性：存在可复现的阻断功能、存储型 XSS 和核心上传失败链路。现有自动化门禁无法在提交前发现这些问题。

## 1. 审核范围与方法

- C 端：`public/index.html`、`public/app.js`、`public/i18n.js`、`public/styles.css`、`public/poster-wall.css`、`public/poster-wall-view.js`。
- 后台：`admin/index.html`、`admin/app.js`、`admin/styles.css`。
- 共享：`shared/tokens.css`、`public/tokens.css`、`admin/tokens.css`、`scripts/sync-tokens.mjs`。
- 源码审查：安全边界、异步竞态、事件生命周期、认证会话、路由、表单、表格、响应式、可访问性、设计系统漂移。
- 运行验证：隔离 SQLite 副本 + 本地端口 `8790`；真实 Edge/Chromium 渲染；390×844、768×1024、1280×720、1440×900 视口；键盘、焦点、弹层、提现、移动端输入。
- 机械检查：`node --check`、`npm test`、`impeccable detect`、`@google/design.md lint`。

### 验证结果

- `node --check public/app.js public/i18n.js public/poster-wall-view.js admin/app.js`：通过。
- `npm test`：120 项通过，0 失败。
- 静态 `impeccable detect`：0 条。
- 运行态 `impeccable detect --cdp`：命中 `ReferenceError: openOverlay is not defined`。
- `@google/design.md lint DESIGN.md`：0 error。
- 390×844 C 端首页、榜单、海报墙无页面级横向滚动；后台概览无页面级横向滚动。
- C 端登录弹层：`role="dialog"`、`aria-modal`、初始焦点、Esc 关闭、焦点回触发按钮均有效。

> 审计期间 `public/i18n.js` 曾在 10:07 左右短暂无法解析，导致 C 端白屏；该文件在 10:09 后恢复并通过语法检查，因此不作为最终缺陷记录。

## 2. P0：阻断发布

### P0-1 C 端提现调用未定义函数

- 位置：`public/app.js:1769`、`public/app.js:1776-1779`
- 类别：正确性 / 核心商业链路
- 影响：有可提现余额的用户点击「申请提现」后触发 `ReferenceError`，弹窗不出现，佣金提现完全不可用，也没有用户可见错误。
- 证据：`openWithdrawalDialog()` 调用 `openOverlay()`；`public/app.js` 没有该函数声明，也没有导入；`openOverlay()` 只存在于 `admin/app.js:219`。真实浏览器复现：

```text
ReferenceError: openOverlay is not defined
    at openWithdrawalDialog (public/app.js:1779)
    at HTMLButtonElement.<anonymous> (public/app.js:1769)
```

- 建议：改用 C 端已有的 `openDialog()` 体系，或抽取共享 overlay 模块；为提现弹层增加浏览器运行时回归。

### P0-2 后台菜单分组键存储型 XSS

- 位置：`admin/app.js:342-343`、`server/rbac.mjs:266-293`、`admin/app.js:5090-5118`、`admin/app.js:91/270`
- 类别：安全 / 权限提升
- 影响：具备 `system.menu.write` 的账号可以在菜单分组键中写入 HTML；`renderNav()` 未转义地拼入 `data-group` 和 `data-toggle`，其他后台账号（包括超管）打开页面时执行脚本。由于后台 token 存在 `localStorage` 且部署未设置 CSP，脚本可直接读取会话。
- 证据：`saveAdminMenuGroup()` 会校验 `^[a-z0-9_-]{1,40}$`，但单条菜单的 `saveAdminMenu()` 对 `groupKey` 没有校验；`renderNav()` 的 `group.id` 既未 `esc()` 也未用 `setAttribute()`。
- 建议：`group.id` 使用 `esc()` 或 DOM API；`saveAdminMenu()` 复用分组键校验；token 迁移到 HttpOnly Cookie；补 CSP。

### P0-3 后台视频上传被 15 秒默认超时截断

- 位置：`admin/app.js:117`、`admin/app.js:1255-1270`
- 类别：正确性 / 内容入库
- 影响：正常视频上传超过 15 秒即被 `AbortController` 中止，核心内容入库失败，尤其是大文件和慢链路。
- 证据：`api()` 默认 `timeoutMs = 15000`；分集上传调用 `api('/admin/api/episodes/:id/upload', { method: 'POST', body: file })` 没有覆盖超时值。
- 建议：上传使用独立的长超时或无墙钟超时，提供进度、取消和幂等/分片能力；不要把普通 API 的 15 秒超时复用到文件上传。

## 3. P1：发布前修复

### P1-1 损坏的 `mh-user` 会让 C 端白屏

- 位置：`public/app.js:118`
- 影响：`JSON.parse(localStorage.getItem('mh-user'))` 在模块顶层直接执行；损坏值抛出 `SyntaxError`，`route()` 永不执行，页面停在「影巢 · 正在加载」。
- 证据：真实浏览器写入 `mh-user = "{bad-json"` 后刷新，出现 `SyntaxError: Expected property name`，`#boot` 保持可见。
- 建议：`try/catch` 清理损坏值，校验对象结构；解析失败回退匿名态。

### P1-2 移动端输入框仍为 14px，触发 iOS 自动缩放

- 位置：`public/index.html:26-27`、`public/styles.css:747-748`、`shared/tokens.css:144-169`
- 影响：390px 实测搜索框和登录邮箱输入框为 14px；iOS Safari 聚焦时自动放大，破坏布局。项目规范要求手机输入 16px。
- 证据：`styles.css` 先加载，`tokens.css` 后加载；`.field input` 在令牌层以同优先级覆盖 `styles.css` 中的移动端 16px 规则。390px 实测搜索框 `14px / 42px`、登录邮箱 `14px / 40px`。
- 建议：调整加载顺序为令牌优先、页面覆写在后；或提高移动端规则优先级，统一覆盖 `.field input`、搜索框、选择器和 textarea。

### P1-3 Hero 自动轮播没有持久暂停控制

- 位置：`public/app.js:1188`、`public/app.js:1209-1222`
- 影响：Hero 每 7 秒自动切换，页面没有可见暂停/停止按钮；hover/focus 只清除切换定时器，已播放的视频不会暂停，离开后立即恢复。属于 WCAG 2.2.2 自动播放问题。
- 证据：`pause()` 只执行 `paused = true; clearTimeout(timer)`，没有暂停视频，也没有用户可持续保留的暂停状态。
- 建议：提供可见暂停/播放按钮；暂停时同步暂停 Hero 视频，且不因鼠标移出自动恢复。

### P1-4 退出登录不吊销服务端会话

- 位置：`public/app.js:308-317`、`admin/app.js:312-319`、`server/auth.mjs:44-50`
- 影响：退出只清本地 `localStorage`，已签发 token 在 7 天内仍有效；被复制的 token 无法通过「退出」失效。后台退出也不清理轮询、弹层和进行中的请求。
- 证据：全仓没有 `/logout` 或对应服务端吊销调用；`issueToken()` 的 TTL 为 7 天。
- 建议：增加服务端会话吊销接口；退出时 abort 请求、清定时器、关闭弹层，并清空 `state.me`。

### P1-5 HLS 运行时回退到未固定远程代码

- 位置：`public/app.js:24-29`
- 影响：本地 `vendor/hls.mjs` 失败时从 jsDelivr 动态导入代码。该代码可读取 `localStorage` 中的 Bearer token；没有 SRI 可用，站点也没有 CSP。
- 证据：`import('https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.mjs')`；C/B token 均存于 `localStorage`。
- 建议：只使用已 vendored 模块；如必须远程加载，迁移到 HttpOnly Cookie 并补 CSP/固定版本策略。

### P1-6 后台退款驳回在「取消」时反而提交

- 位置：`admin/app.js:2201`
- 影响：管理员在 `prompt()` 点取消时返回 `null`，代码用 `?? '未通过审核'` 继续调用驳回接口，财务状态被意外修改。
- 证据：`const reason = prompt('驳回原因') ?? '未通过审核'` 后直接发请求。
- 建议：`null` 必须立即 return；驳回原因必填，提交前展示退款摘要并二次确认。

### P1-7 后台页面权限与接口权限错配

- 位置：`admin/app.js:34/36/48`、`server/api-admin.mjs:230-250`、`server/api-admin.mjs:694/1216/1286`
- 影响：自定义角色可能看到菜单但进入即 403。例：付费策略菜单使用 `content.drama.read`，页面接口要求 `content.policy.write`；首页运营菜单使用 `ops.banner.write`，同时请求要求 `ops.section.write` 的楼层接口；退款菜单使用 `finance.refund.create`，退款列表 GET 却要求 `finance.order.read`。
- 证据：菜单权限、页面请求和 `PERM` 映射是三份独立配置，没有统一能力表。
- 建议：建立单一 `can(action)` 能力表；页面入口对齐读权限，写操作按按钮授权；同页多资源允许独立降级。

### P1-8 退款/审核列表在 100 条处静默截断

- 位置：`server/api-admin.mjs:1218/1341/1353`、`admin/app.js:1666/2174/1489`
- 影响：更早的待处理退款、弹幕和评论不可达；前端基于截断数组计算分页，「共 N 条」会低估真实积压。
- 证据：三个 GET 均使用 `LIMIT 100`，前端再用 `clientPage()` 切 20 条。
- 建议：服务端返回 `page/pageSize/total` 或游标；不要对已截断数组做客户端分页。

### P1-9 标签接口失败后保存可能清空剧集标签

- 位置：`admin/app.js:1094`、`admin/app.js:1154-1158`
- 影响：标签请求失败被 `.catch(() => [])` 吞掉，页面显示「还没有标签」，但「保存标签」仍可提交空数组，清除已有绑定。
- 证据：保存逻辑只读取当前勾选的 `.f-tag`，没有保留服务端快照或失败禁用状态。
- 建议：标签加载失败时显示错误并禁用保存；保存前对比原快照，失败时禁止覆盖。

### P1-10 金额/比例浮点转换可能差 1 分/1bp

- 位置：`admin/app.js:4037-4038`
- 影响：超过两位小数的输入经 `Math.round(Number(value) * 100)` 转换，`1.005` 等值可能得到 100 分而不是 101 分，影响佣金、手续费和结算。
- 证据：`distributionPercentToBp` 和 `distributionYuanToFen` 直接做浮点乘法后四舍五入。
- 建议：按字符串解析十进制，显式校验两位小数，或使用整数/大数运算。

### P1-11 后台视频上传不具备键盘路径

- 位置：`admin/app.js:1255`
- 影响：文件输入 `display:none`，外层只有 `<label class="btn sm">`，键盘用户无法聚焦或触发上传，核心内容操作不可达。
- 建议：使用可聚焦 `<button>` 打开隐藏 input，或使用 visually-hidden input + 可见焦点样式。

### P1-12 后台 RBAC 树重绘丢失焦点与半选语义

- 位置：`admin/app.js:2399`、`admin/app.js:2259-2271`
- 影响：每次勾选权限都重建整棵树，焦点回到 body，无法连续键盘操作；半选只写 `data-half` 和 outline，未设置 `indeterminate` 或 `aria-checked="mixed"`。
- 建议：原地更新节点，或按 `data-check` 恢复焦点；设置真实 `indeterminate` 并暴露 mixed 语义。

### P1-13 后台辅助文字的对比度不足

- 位置：`admin/styles.css:256`
- 影响：`.tpath` 使用 `#6b7484`，在 `--panel #141821` 上实测约 **3.77:1**；11px 文本低于 WCAG AA 4.5:1。
- 证据：对比度计算 `#6b7484` vs `#141821 = 3.77:1`；同类 `--text-3 #8a93a5` 为 5.75:1。
- 建议：改用 `--text-3` 或更亮的语义令牌；复核输入边框与控件的非文本对比度。

## 4. P2：下一轮修复

| 编号 | 问题 | 位置 | 影响 / 证据 | 建议 |
|---|---|---|---|---|
| P2-1 | HLS 加载失败永久缓存 `null` | `public/app.js:20-31` | 本地和 CDN 都失败后，重试仍拿缓存结果，只能刷新整页。 | 失败时清空 `hlsPromise`，或提供显式重新加载。 |
| P2-2 | 曝光观察器不释放旧节点 | `public/app.js:198-213` | 全局 `IntersectionObserver` 对旧页面卡片不 `unobserve`，长会话内存增长。 | 路由切换时 unobserve/disconnect 或重建观察器。 |
| P2-3 | 弹层 click 监听累积，USDT 定时器不清理 | `public/app.js:498/615/721` | 连续 5 次用 Esc 关闭登录弹层后，#modal 累积 5 个 `once` click 监听；USDT 倒计时可在弹层移除后继续运行最长 15 分钟。 | 弹层容器统一委托监听；所有弹层注册 `modal._cleanup`。 |
| P2-4 | 分类「加载更多」与筛选存在竞态 | `public/app.js:1481-1499`、`public/app.js:1506-1529` | 第 2 页请求未检查 `requestSeq`，晚到的旧页可能追加到新筛选结果。 | 加载更多复用同一 action token/AbortController。 |
| P2-5 | `aria-current` 在路由切换后陈旧 | `public/app.js:859-867` | 登录态不变时早退分支只切 `.active`，不更新 `aria-current`，读屏仍报告旧当前页。 | 每次导航同步 `aria-current`。 |
| P2-6 | 订阅剩余天数按本地时区解析 UTC 字符串 | `public/app.js:2598` | `Date.parse(String(sub.validTo).replace(' ', 'T'))` 少加 `Z`，在上海时区会偏移 8 小时，临近到期可能差一天。 | 统一用 `... + 'Z'` 或 ISO 时间与 `Asia/Shanghai` 格式化。 |
| P2-7 | 连播与未就绪自动刷新定时器不可靠 | `public/app.js:2286`、`public/app.js:2415` | `routeCleanups.includes(onCleanup)` 永远为 false，30 秒自动刷新不生效；连播 `setTimeout` 在用户离开后仍可能改 hash。 | 使用路由序号/cleanup token；登记所有延时任务。 |
| P2-8 | `openModal` 对传入 HTML 二次转义 | `public/app.js:574/936-939` | 无套餐且不可单片购买时，用户会看到字面量 `<p class="paywall-sub">`。 | 明确纯文本 API 或改用结构化节点。 |
| P2-9 | 令牌体系存在旧 CSS 与重复根变量 | `public/styles.css:2`、`admin/styles.css:2`、`public/index.html:26-27` | 页面有 150+ 直接色值和大量内联样式；`styles.css` 先于 `tokens.css` 加载，移动端规则被反向覆盖。 | 删除重复 `:root`，重排为 token → surface override，加入 lint。 |
| P2-10 | 令牌同步没有只读校验模式 | `scripts/sync-tokens.mjs:45-56`、`package.json:13` | 脚本总是写入并更新时间戳；`npm test` 实际不包含令牌同步；无法在 CI 只读检测漂移。 | 增加 `--check`，比较内存生成结果和两个产物哈希。 |
| P2-11 | i18n 仍有未翻译的界面语义 | `public/i18n.js:508-547`、`public/app.js:907` | 英文模式下侧栏 `aria-label="侧边导航"`、语言按钮 `aria-label="切换到中文"` 仍为中文；DOM 级翻译还可能改写特定用户/内容文本。 | 使用显式 `data-i18n`/消息键，避免对整棵 DOM 做字符串替换。 |
| P2-12 | 后台破坏性操作依赖原生 prompt/confirm | `admin/app.js:1331-1367`、`2129-2141`、`2191-2202`、`2668-2686` | 交互不一致、不可样式化、不可校验；多数 mutation 没有 busy/error 边界。 | 统一资金/删除确认弹层，显示对象、金额和后果；请求期间禁用。 |
| P2-13 | 后台移动端触控目标和表格仍偏小 | `admin/styles.css:556-557`、`admin/styles.css:693-708` | 390px 实测顶部动作 40px、筛选 pill 32-40px；通用表格仍 760px 横向滚动。 | 统一窄屏 44px 命中区；核心交易表卡片化或固定操作列。 |
| P2-14 | 隐藏菜单会封死直接路由 | `admin/app.js:73/442-445` | 路由表只从 `/me.menus`（可见菜单）构建；隐藏菜单后直接访问会落回概览。 | 独立静态路由/权限注册表，菜单可见性只影响展示。 |
| P2-15 | 邮件通道编辑可能重新启用已停用通道 | `admin/app.js:3057` | 保存 payload 固定 `enabled: true`，编辑已停用通道会恢复发信。 | 保留原状态或增加显式启停控件。 |
| P2-16 | 后台密码输入框使用 `type="text"` | `admin/app.js:1593-1594/4885/4942` | 初始口令、用户改密、后台重置口令可被旁观/截图。 | 默认 `password`，提供显式显示按钮。 |

## 5. P3：低风险优化

- **内联 `onerror` 阻碍严格 CSP**：`public/app.js:800`、`admin/app.js:673/746/1304`。改为 `addEventListener('error')` 或统一图片 fallback。
- **静态资源版本不一致**：`public/index.html:26-28/53`、`public/app.js` 的动态 import；`styles/tokens` 无版本参数，`app.js`、`poster-wall.css`、动态 import 版本各不相同。
- **死代码/无静态检查**：C 端仍有未使用常量、空 `vipFloat()`；`package.json` 没有 lint/typecheck，`node --check` 无法发现 `openOverlay` 这类未定义引用。
- **语言按钮的英文 aria-label**：英文模式下仍显示「切换到中文」，应随语言切换使用英文标签。

## 6. 正向发现

- `shared/tokens.css` 是有效的单一几何令牌源；`scripts/sync-tokens.mjs` 当前产物与源一致。
- C 端和后台弹层均实现了 `role="dialog"`、`aria-modal`、标题关联、初始焦点、Tab 循环、Esc 关闭、背景 `inert` 和关闭回焦。
- `api()` 有超时、AbortController、0401 清理、非 JSON 响应处理；路由层有旧请求取消。
- 图片大多有尺寸、`loading="lazy"`/`decoding="async"`、首屏 `fetchpriority="high"`；海报墙使用了更完整的 token 化样式。
- 后台分页器已有总数、当前页、数字页码、首尾折叠和窄屏 44px 规则；服务端 RBAC 仍是最终授权边界。
- 真实浏览器 390×844、768×1024、1280×720、1440×900 未见 C 端/后台页面级横向滚动；弹层键盘路径在桌面端有效。

## 7. 建议修复顺序

1. **P0**：修复 C 端提现 `openOverlay` 引用、后台菜单分组键 XSS、上传超时。先让「提现」和「视频上传」真正可用。
2. **P1**：修复损坏 `mh-user` 白屏、移动端 14px 输入、轮播暂停、服务端登出、退款取消误提交、权限映射和 100 条截断。
3. **P2**：统一弹层生命周期、请求竞态和路由焦点；补齐标签/金额/日期/表格边界；收敛 token 与断点。
4. **P3**：增加 ESLint/`no-undef`、CSP、静态资源版本一致性和英文模式回归。

推荐命令（按优先级）：

1. **P0/P1** `$impeccable harden`：处理提现、上传、XSS、会话和错误态。
2. **P1** `$impeccable adapt`：修复 390px 输入字号、触控目标和后台表格。
3. **P2** `$impeccable optimize`：清理观察器、弹层监听、USDT 定时器和 HLS 缓存。
4. **P2** `$impeccable clarify`：英文模式、错误文案、原生 prompt/confirm 替换。
5. **最终** `$impeccable polish`：统一视觉细节后重新跑 `$impeccable audit`。

## 8. 验证边界与副作用

- 未修改业务源码、数据库、订单或账号；提现运行时测试使用隔离数据库副本。
- `node scripts/sync-tokens.mjs --check` 在当时版本的脚本中不支持 `--check`，实际执行了同步，只更新了 `shared/tokens.version.json` 的 `generatedAt`；`public/tokens.css`、`admin/tokens.css` 的 CSS 内容与源仍一致。未提交该副作用。
- 审核期间 `public/app.js`、`public/i18n.js`、`public/styles.css` 被并发修改；本报告基线为 2026-11-11 10:15 左右，若后续继续改动，需重新跑运行态验证。
- 静态对比度按 token 实色和面板背景计算；半透明叠层、图片背景和渐变端点的实际对比度仍需浏览器逐元素复核。
