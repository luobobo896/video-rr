# 影巢发布前前后端审核（2026-11-11）

## 基线

- 代码固定点：`HEAD` = `fdac746`；审核对象是工作区未提交改动及 untracked 文件。
- 支付边界：按要求**排除支付宝/USDT 协议、签名、支付回调、支付渠道密钥**；订单非支付状态、退款、分销佣金、提现和结算仍在范围内。
- Spec 来源：`docs/testing/2026-11-11-frontend-code-audit.md`、`docs/testing/2026-11-11-frontend-fixes.md`、`PRODUCT.md`、`DESIGN.md`、本轮用户要求。
- Standards 来源：根 `AGENTS.md`、`C:\Users\hanson\.codex\rules\{00-core,19-code-development,11-frontend,27-frontend-design,05-api,12-testing,13-security,30-concurrency}.md`，以及 `code-review` 的 Fowler smell baseline。
- 前端运行态使用 `impeccable`；后端按认证、RBAC、内容、媒体、分销、退款、限流和路径安全审查。

## 本轮修复

### 前次 P2/P3

- HLS 失败清空缓存；曝光观察器在路由切换时断开。
- C 端弹层统一遮罩委托、清理定时器并在打开新弹层前执行旧 cleanup。
- 分类加载更多与旧筛选响应隔离；`aria-current` 同步；订阅日期按 UTC 解析。
- 播放器未就绪刷新与连播定时器绑定路由序号；`openModal` 不再二次转义纯文本。
- 后台原生 `prompt/confirm/alert` 全部替换为 Promise 弹层；原因校验、危险操作确认、一次性登录码展示和复制均有明确状态。
- 后台窄屏 `≤599px` 的按钮、筛选 pill、输入控件提升到 44px；核心表格操作列固定在右侧；弹层输入 16px。
- 隐藏菜单保留在 `/admin/api/me` 的路由数据中，直接访问不再回到概览。
- 令牌源只保留 `shared/tokens.css`；CSS 加载顺序改为 tokens → surface override；新增 `check:tokens`、静态 no-undef/版本一致性检查。
- 英文手机底栏使用 `Home / Browse / Wall / Ranks / Me`；英文英雄指示器、搜索标题、海报墙返回链接和用户内容排除翻译。
- 头像首次上传占位 `<div>` 会立即替换为 `<img>`，不再等待二次请求。
- 佣金推广海报新增 Canvas 二维码；二维码编码站点推广链接，不依赖远程二维码服务。

### 发布前审核发现并修复

- 出厂菜单 `/policies`、`/ops`、`/refunds` 的 `perm_code` 与接口权限对齐；旧库只迁移仍保留旧值的系统菜单。
- 视频上传在流式落盘后必须向 `handleAdmin` 传空 body，避免二次读取已结束请求而永久挂起。
- `access_mode='paid'` 不再被订阅覆盖；草稿/下架内容不可判权或通过详情接口读取。
- 封面远程下载增加域名白名单、重定向校验、大小上限和临时文件 `finally` 清理。
- 支付成功后佣金生成和退款后佣金冲减分别增加持久化 outbox，失败由定时器重试，不再仅记录日志。
- 提现打款会把佣金按 FIFO 写入 `settled_fen`；历史已打款提现启动时幂等补偿；提现不再永久阻断后续结算。
- 结算驳回恢复佣金时检查分销关系与风险状态，冻结中的佣金不会恢复为可提现。
- 推广归因窗口必须存在有效点击才绑定；后台分销列表改为服务端分页并移除 `account_cipher`。
- `/api/track` 拒绝客户端伪造 `order_created` / `payment_success`；内容统计重算使用独立 `growth.content.write` 权限。
- 后台直达角色分配接口也不能摘掉最后一个启用中的超级管理员。
- 静态文件路径统一使用 `resolveInside`，修复根目录前缀逃逸；新增路径安全回归测试。
- 管理端 CSP 元标签和外部 `base.js` 替代内联启动脚本；移除 `frame-ancestors` 的 meta 无效指令。

## 验证结果

- `npm run check`：通过；token hash `d8d7796db80d`，前端静态检查 5 个文件通过，资源版本 `20261111fix8`。
- `npm test`：**133 通过，0 失败**。
- 服务端 34 个 `.mjs` 文件 `node --check`：全部通过。
- `impeccable detect` 静态：C 端/后台目标 0 条；C 端运行态 `--cdp 9223`：0 条。
- 后台运行态 `impeccable detect --cdp`：仅 3 条 advisory（B 端既定蓝/青品牌渐变 2 条、运营 KPI 卡片分组 1 条），无 error；已用设计系统说明和分区栅格判定为可接受判断项。
- `@google/design.md lint` 直连缓存 CLI：0 error、1 warning（`DESIGN.md` 使用旧版标题式文档，无 YAML frontmatter）。
- 390×844 英文首页：`scrollWidth=390`，5 个底栏入口完整显示，搜索输入 16px，Hero 指示器 44px 高。
- 390px 后台用户页：按钮/输入/弹层控件 44px，操作列 `position:sticky`，自定义登录码弹层无原生 prompt。
- 二维码海报：720×1080 PNG；OpenCV `QRCodeDetector` 解码为 `http://127.0.0.1:8790/i/DL647CEF`；实际二维码位于白底静区且可扫码。

## 遗留项

- 根目录 `mh-deploy-20261111-025142.tgz` 是审计前生成的旧部署包，不能用于本次发布；正式发布必须重新打包，或直接部署当前源码树。
- C 端观看历史/收藏/订单仍以摘要列表展示（历史 12 条、订单 50 条），后台分销列表已分页；若要求“全部历史可分页浏览”，应补 C 端专用分页页面。
- 通过 `npx --yes @google/design.md lint DESIGN.md` 发起时当前 npm/npx 环境会挂起；已改用本地 npx 缓存中的 CLI 直连验证。发布前建议在 CI 固定版本环境重跑。
