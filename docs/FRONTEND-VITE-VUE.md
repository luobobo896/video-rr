# 前端构建迁移：Vue 3 + Rolldown-Vite

## 结论

前端现在有两个 Vite 构建入口：

- C 端：`public/index.html` → `public/main.js` → `public/LegacyHost.vue` → `public/app.js`
- 后台：`admin/index.html` → `admin/main.js` → `admin/LegacyHost.vue` → `admin/app.js`

构建产物分别输出到 `dist/client`、`dist/admin`。Node 服务优先提供构建产物；没有构建产物时回退到 `public/legacy.html`、`admin/legacy.html`，因此不会因为漏构建而加载未编译的 Vue 入口。

HK 的 nginx 也必须直接指向构建产物：

- `/video/` → `/opt/video-rr/dist/client/`
- `/video-admin/` → `/opt/video-rr/dist/admin/`

不能让 nginx 直接 alias 到 `public/`、`admin/` 源码目录，否则浏览器会拿到含裸模块导入的 `main.js` 并白屏。

## 为什么先放兼容宿主

现有 C 端渲染器约 154KB、后台约 288KB，覆盖路由、支付、分销、RBAC、媒体、弹层和大量业务状态。直接一次性重写所有页面会违反“逻辑不要改变”的约束，也会让回归面失控。

当前迁移保证：

- Vue 3 负责根挂载和页面壳层；
- 既有业务渲染器保持原样运行；
- 现有修复、i18n、弹层、路由和后台权限逻辑不被改写；
- 后续可以按 `Home → Category → Detail → Account → Admin Pages` 的粒度逐页拆 Vue 组件。

## 组件库

选用 **Element Plus**（含 `@element-plus/icons-vue`）。理由是后台的表单、菜单、表格、弹窗与分页覆盖完整，C 端也能只复用输入、分段控件和按钮，不需要引入第二套设计体系。

- C 端：顶栏使用 `ElInput`、`ElSegmented`、`ElButton` 与 Element Plus 图标；海报、Hero、播放器、付费墙仍使用品牌专属实现。
- 后台：登录页使用 `ElForm` / `ElInput` / `ElButton`，侧栏使用 `ElMenu` / `ElSubMenu` / `ElMenuItem`；页面数据渲染仍由 `admin/app.js` 驱动。
- 主题：组件只通过 `--el-*` 变量映射到 `shared/tokens.css`，不直接使用 Element Plus 默认蓝；品牌渐变和 C/B 两套主色保持不变。
- 边界：不重写支付、权益、RBAC、路由和埋点逻辑；组件迁移只改变壳层与通用控件。

## 命令

```bash
npm install
npm run dev             # Node + C 端 Vite 5173 + 后台 Vite 5174
npm run dev:client      # 只起 C 端 Vite
npm run dev:admin       # 只起后台 Vite
npm run build           # 两端生产构建 + 静态素材复制
npm start               # 先构建，再启动 Node 服务
npm test                # 现有服务端/业务回归
```

生产环境不要直接执行 `node server/index.mjs` 后假设前端已更新；应使用 `npm start` 或先执行 `npm run build`。

## 发布包

```bash
npm run pack:deploy
```

该命令先完整构建，再生成 `mh-deploy-YYYYMMDD-HHmmss.tgz`。发布包必须包含：

- `package-lock.json`
- `public/main.js`、`public/LegacyHost.vue`
- `admin/main.js`、`admin/LegacyHost.vue`
- `vite.client.config.mjs`、`vite.admin.config.mjs`
- 当前 `public/app.js`、`admin/app.js` 和业务源码

部署脚本会执行 `npm ci --include=dev` 和 `npm run build`，构建失败时在重启服务前退出，避免继续提供旧前端。

根目录旧的 `mh-deploy-20261111-025142.tgz` 生成于中英切换、二维码海报、头像即时刷新和后台序号列修复之前，禁止用于发布。
