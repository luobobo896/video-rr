# C 端与后台主站切换验证（2026-11-12）

## 范围

- C 端 `public/` 改为挂载 `public/src` 的 Vue 3 改版应用。
- 后台 `admin/` 使用 Vue 3 壳层（登录、侧栏、身份区），业务页面继续由
  `admin/app.js` 驱动，并通过 `admin/modern.css` 套用新版 B 端视觉。
- 删除独立 `web-redesign/`、`vite.redesign.config.mjs`、`/video-redesign/` nginx 入口与发布清单引用。
- `/admin/` 仍是独立入口，但视觉和交互使用最新后台 UI。

## 命令结果

```text
npm run build           通过（dist/client + dist/admin）
npm run check           通过
npm test                通过（154 tests / 154 pass）
```

## 运行验证

使用隔离数据库：

```text
PORT=8790 MH_DB=/tmp/mh-redesign-integration.db MH_OTP_TEST=1 MH_ALLOW_SIM_PAY=1 node server/index.mjs
MH_DEV_API_ORIGIN=http://127.0.0.1:8790 npm run dev:client
MH_DEV_API_ORIGIN=http://127.0.0.1:8790 npm run dev:admin
```

已验证：

- C 端首页真实服务端 Banner、3 个楼层、图片加载与移动端无横向溢出。
- 后台首次登录强制改密、登录态持久化和 24 个后台菜单路由均可加载。
- 主站构建产物由 Node 静态服务直接提供时，C 端与后台入口均可打开。

## 边界

- 旧版 `public/legacy.html`、`admin/legacy.html` 只在构建产物缺失时作为回退保留。
- 后台不再维护第二套只读 Vue 页面；经营数据、埋点、渠道、内容 CRUD、退款、
  RBAC、菜单和系统设置统一收敛到 `admin/app.js`，避免两套后台漂移。

## 2026-11-12 功能恢复补记

后续审核发现只读 Vue 后台遗漏了经营数据、埋点、渠道和多项系统设置。现已在
保留新版 B 端视觉的前提下恢复完整业务控制台，并删除未挂载的只读后台副本。
详细验证见 `docs/testing/2026-11-12-admin-function-restore.md`。

## HK 生产发布

- 发布包：`mh-deploy-20261112-164017.tgz`
- SHA256：`b55bb3a7fcea3aff0bdc5ed83528c4743320bb7371b1957562b77edd91e6d8a8`
- 线上 C 端：<https://hk.hsddns.com/video/>
- 线上后台：<https://hk.hsddns.com/video-admin/>
- 服务：`video-rr` 为 `active`
- 线上 HTML：两端均输出 `id="app"`；C 端 `index-Dt4LcBEV.js`，后台
  `index-C-HN7V28.js`，共用 `index-DMyZYwhl.css`
- `/video/`、`/video-admin/`、`/video/api/constants`：200
- 未签名 HLS：403
- `/opt/video-rr/web-redesign`、`/opt/video-rr/dist/redesign` 已移除；
  nginx 配置无 `/video-redesign/` 引用
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261112-164052`
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261112-161334.tgz`

## 2026-11-12 16:40 视觉回归修复

- 会员弹层加宽到 920px，三档套餐固定一行展示；单片 + 三档套餐在宽屏也可同排。
- 成人频道恢复显示全部 8 个分组、111 个子标签，不再因内容计数为 0 被隐藏。
- 佣金推广恢复「下载推广海报」，实际生成 1080×1440 PNG。
- 首页首位恢复「午夜场」Banner；右上角频道与地区统一为 12px / 500。
- 线上验证：`/video/` 首屏为「午夜场」；线上两端资源 hash 已更新；
  `video-rr` 为 `active`。
