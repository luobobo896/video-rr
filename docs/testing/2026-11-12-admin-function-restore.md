# 后台功能恢复与新版视觉回归（2026-11-12）

## 目标

- B 端继续使用新版视觉，不再回到旧后台外观。
- 恢复只读 Vue 后台遗漏的经营数据、埋点数据、渠道分析、内容 CRUD、
  退款、RBAC、菜单管理和系统设置。
- 保留 C 端 `/video/`、后台 `/video-admin/` 两个生产入口，不再使用
  `/video-redesign/`。

## 实现

- `admin/LegacyHost.vue` 提供新版 Vue 3 外壳：品牌区、侧栏、在线状态、
  管理员身份、页面头和移动端横向导航。
- `admin/components/AdminNav.vue` 使用 Element Plus 线性图标恢复新版侧栏的
  菜单前缀图标；图标只做导航识别，不替代完整业务入口。
- `admin/app.js` 继续承担完整业务页面和接口调用；补回缺失的
  `navChevron()`，修复「菜单管理」加载失败。
- `admin/modern.css` 统一新版 B 端颜色、表面、按钮、表单、表格、图表、
  弹层和登录页；移动端保留 44px 触控目标。
- `admin/components/AdminLogin.vue` 改为双栏登录页，并提高输入占位文字对比度。
- 删除未挂载的只读后台副本：`public/src/AdminApp.vue`、`admin-main.js`、
  `AdminShell.vue`、`pages/admin/*`、`data/adminPages.js`。
- C 端 Hero 增加 hover / focus / 页面隐藏暂停；轮播指示器提高到
  28×44px（移动端 24×44px），箭头 44×44px；保留手动暂停与
  `aria-pressed`。
- C 端海报墙恢复类型筛选与 2:3 / 16:9 / 1:1 三档画幅切换。
- `prefers-reduced-motion` 不再把所有状态反馈压到 0.01ms，仅移除位移类动效，
  保留颜色、背景、边框和透明度反馈。

## 验证

### 构建与静态检查

```text
npm run build   通过
npm run check   通过（asset version 20261112ops3）
npm test        154 passed / 0 failed
```

### 后台真实浏览器

使用隔离库与临时超级管理员，在 1440px 与 390px 宽度逐项打开 25 个后台菜单：

- 所有页面均渲染出内容，无「加载失败」，侧栏高亮与页面标题一致。
- 经营数据：10 个 KPI、播放/访客/收入/事件图表、漏斗与 9 张明细表。
- 埋点数据：4 个 KPI、事件趋势、筛选、分页与 2 张表。
- 渠道分析：6 个 KPI、渠道转化、渠道配置、域名与推广码 3 张表。
- 菜单管理：5 个分组、25 个菜单，增删改入口完整。
- 每个页面只有 1 个 C 端入口；移动端「打开 C 端 / 修改密码 / 退出登录」可见。
- 390px：`scrollWidth = 390`；KPI 两列；后台导航横向滚动。

### C 端真实浏览器

- Hero 共 7 张，指示器 28×44px，箭头 44×44px；hover 7.2 秒保持同一张，
  移出后恢复自动轮播。
- 海报墙 33 部、5 个类型筛选项；切到「电视剧」后 25 部；
  16:9 画幅实际为 `aspect-ratio: 16 / 9`。
- 320px 与 390px：`scrollWidth` 等于视口宽度；移动端筛选/画幅按钮 44px。

## 运行

```bash
npm install
npm run dev          # Node :8787，C 端 :5173，后台 :5174
npm run build
npm run check
npm test
```

生产入口：

- C 端：<https://hk.hsddns.com/video/>
- B 端：<https://hk.hsddns.com/video-admin/>

## HK 发布记录

- Git 提交：`c9255d7`
- 发布包：`mh-deploy-20261112-180257.tgz`
- SHA256：`b9665ef3d8c666f6dbd3dc741d8c0233196d5d86771b1a1822afe04db701af68`
- 线上 C 端：`assets/index-BjxoIXDY.js`、`assets/index-Cy93oXEe.css`
- 线上后台：`assets/index-CWkBn2x1.js`、`assets/index-B-sl00SF.css`
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261112-175122.tgz`
- 发布前数据库备份：`/opt/video-rr/storage/backup/app.db.20261112-180344`
- 服务：`video-rr` 为 `active`，`NRestarts=0`
- `/video/`、`/video-admin/`、浏览器 UA 下的 `/video/api/constants`：200
- 未签名 HLS：403
- 生产海报墙：19 部、6 个类型筛选项、2:3 / 16:9 / 1:1 三档画幅
