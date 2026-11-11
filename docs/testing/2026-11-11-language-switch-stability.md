# 中英文切换稳定性验证

日期：2026-11-11

## 问题

切换中英文后，顶栏品牌文字宽度从「影巢」变为 `Yingchao`，搜索框、语言胶囊和登录按钮随之横向移动；用户感知为页面左右跳动。英文顶栏动作标签长度不一致，也会改变整组按钮宽度。

## 调整

- 品牌槽固定 128px；≤599px 使用 44px 图标位。
- 四个顶栏动作固定 56px，英文标签统一为 `History / Saved / Inbox / VIP`。
- 语言胶囊固定 92px，两个选项等宽；登录按钮最小宽 86px。
- 保持语言切换不整页刷新，当前路由与滚动位置由现有路由恢复逻辑保留。

## 浏览器验证

环境：本机 Edge，`http://127.0.0.1:8792/`；样式版本 `20261111langfix`，脚本版本 `20261111langfix2`。

验证路径：`#/home`、`#/me`、`#/category/ALL`。

| 视口 | 操作 | 结果 |
|---|---|---|
| 1440×900 | 首页滚动到 `scrollY=500`，连续切换 中文/EN 四次 | 每次 `scrollY=500`；Logo `x=156`、搜索框 `x=302`、语言胶囊 `x=901`、登录按钮 `x=1307` 均不变 |
| 768×900 | 个人中心滚动到 `scrollY=120`，中文切英文 | 保持 `scrollY=120`；顶栏各控件横坐标不变，无横向溢出 |
| 390×844 | 个人中心滚动到 `scrollY=300`，英文切中文 | 保持 `scrollY=300`；Logo、搜索、语言胶囊、登录按钮横坐标不变 |
| 1200 / 1024 / 600 / 390 | 英文模式断点检查 | `scrollWidth <= innerWidth`，顶栏不重叠、不横向滚动 |

桌面端连续切换记录：

```text
zh: y=500 logoX=156 searchX=302 toggleX=901 loginX=1307
en: y=500 logoX=156 searchX=302 toggleX=901 loginX=1307
zh: y=500 logoX=156 searchX=302 toggleX=901 loginX=1307
en: y=500 logoX=156 searchX=302 toggleX=901 loginX=1307
```

## 静态检查

```text
node --check public/app.js public/i18n.js public/poster-wall-view.js
node --check server/i18n.mjs server/api-public.mjs
npm test                 # 121 passed
impeccable detect ...    # []
```

## HK 发布验证

发布对象：

- C 端：<https://hk.hsddns.com/video/?lang=en#/home>
- 后台：<https://hk.hsddns.com/video-admin/>

发布前备份：`/opt/video-rr/storage/backup/release-20261111-103949`。

服务重启后：

- `video-rr` 状态 `active`。
- `/video/`、`/video-admin/`、`/video/api/constants` 均返回 `200`。
- `/api/home`、`/api/category`、`/api/rank` 在 `x-mh-lang: en` 下返回英文枚举标签。
- 线上桌面 1440 宽，首页滚动到 `scrollY=800` 切换中文：Logo `x=156`、搜索框 `x=302`、语言胶囊 `x=1335.63`、登录按钮 `x=1741.63`，切换前后不变，`scrollY=800`。
- 线上手机 390 宽，首页滚动到 `scrollY=500` 切换中文：所有顶栏控件横坐标不变，`scrollY=500`，无横向溢出。
- 线上个人中心在 `scrollY=300` 切换中文：顶栏控件横坐标不变，`scrollY=300`。
- 线上排行榜页签读取接口 `label`，英文模式显示 `Trending / Most Searched / Rising / ...`。
- 浏览器 Console 无 `error` / `warn`。

发布文件 SHA-256：

```text
0a7842615d686d406d7b6691b6029fedb2599379420ac33c9ee076527260a632  public/index.html
dae5171a1be9c88a762646d9c13e0bc283e895c6e4ae8db11e659a2ed599d15d  public/app.js
7b90e9f362fcc0fba74e9432d5716bfe53b1d0286e863fbd9c97e5fd18b52748  public/styles.css
338c72c2bb5acda419cf2d7eb52f1e408f28089b02b8e290bdd1a80afd272054  public/i18n.js
c671f1781e8277624ce114fc42719bb27ba435f6bad62ef6e43bcfa33fbf18ac  public/poster-wall-view.js
5f099b3dc38a8fdb9a31a3ab3c3771d45bb8957fc5f8cf6e2beb7884eb91af38  server/i18n.mjs
fbff8361541fb4b2980f7b07a9051e5078a2fba0b4baed40490c809ef85e608f  server/api-public.mjs
```

## 2026-11-11 桌面侧栏语言即时切换修复

### 问题

桌面左侧栏点击 `EN` 后仍显示中文，刷新为 `?lang=en` 后才变英文；移动端底部导航正常。

### 根因

`public/components/AppSidebar.vue` 的 `groups` computed 只读取 `chromeState.hash`。内部虽然调用 `t(label)`，但 `t()` 读取模块级 `current`，不建立 Vue 响应式依赖，语言变化不会触发重算。

### 修复

- `groups` computed 显式读取 `chromeState.lang`，并通过局部 `tr()` 使用该值。
- `scripts/check-frontend.mjs` 增加静态约束：`AppSidebar` 的分组逻辑必须依赖 `chromeState.lang`。

### 浏览器验证

环境：`http://localhost:5173/?lang=zh#/home`。

| 视口 | 操作 | 结果 |
|---|---|---|
| 桌面 | 中文侧栏点击 `EN` | 立即变为 `Featured / Browse / Movies / TV Series / ...`，无需刷新 |
| 桌面 | 英文侧栏点击 `中文` | 立即恢复 `精选 / 分类 / 电影 / 电视剧 / ...` |
| 桌面 | 检查分组标题与无障碍标签 | `Channels / Rankings / My Account`；`aria-label="Sidebar navigation"` |
| 390×844 | 中文切英文 | 移动端 `Home / Browse / Wall / Ranks / Me` 正常，桌面侧栏同样即时更新 |
| 桌面 | 刷新 `?lang=en` | 结果与即时切换一致，无新增 Console error |

### 命令

```text
npm run check   # frontend checks: 9 files clean
npm test        # 133 passed, 0 failed
```
