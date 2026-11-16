# 品牌素材与插画

设计交付的 20 张 PNG（`00-overview` 到 `19-empty-404`）已经按用途压缩落到 `public/art/`，
构建时由 `scripts/copy-frontend-assets.mjs` 复制到 `dist/client/art/`，页面用相对路径
`./art/<文件名>` 引用（站点部署在 `/video/` 子路径下也能正确解析）。

## 文件与用途

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `logo-mark.png` | 256×256 | 侧栏 / 登录页品牌标（圆形胶片巢） |
| `logo-wide.png` | 720×405 | 横版组合标，备用（宣传图、邮件抬头） |
| `hero-scifi.jpg` | 1280×720 | 科幻频道头图 |
| `hero-period.jpg` | 1280×720 | 古装频道头图 |
| `hero-suspense.jpg` | 1280×720 | 悬疑频道头图 |
| `poster-*.jpg` ×8 | 480×720 | 无封面条目的占位插画（科幻/古装/悬疑/爱情/动画/纪录/喜剧/动作） |
| `category-*.jpg` ×4 | 640×360 | 电影 / 剧集 / 动漫 / 综艺频道卡 |
| `login-bg.jpg` | 1280×720 | 登录页背景（`opacity: 0.24` 虚化铺底） |
| `empty-404.jpg` | 960×540 | 404 与空态插画 |

## 当前接入位置

* `public/src/components/AppShell.vue` —— 侧栏品牌 `<span class="brand-mark brand-mark--logo">` 里的 `<img>`
* `public/src/pages/c/LoginPage.vue` —— 顶部品牌标 + `<img class="login-bg">` 背景
* `public/src/App.vue` —— 路由兜底的空态 `<img class="empty-art">`
* `public/src/components/FilmArt.vue` —— 条目没有 `cover_url` 时，按片名散列从 8 张 poster 里轮换一张
* `admin/LegacyHost.vue` + `admin/components/AdminLogin.vue` —— 运营后台侧栏与登录页改用
  `admin/icons/icon-96x96.png`（`.brand-mark--img` 去掉渐变底、圆角裁切铺满），不再是「影」字色块
* 样式集中在 `public/src/styles.css` 末尾「品牌与插画素材」段与 `admin/modern.css` 的 `.brand-mark--img`

> Vue 模板里图片必须写成 `:src="'./path/x.png'"` 绑定形式。写成 `src="./path/x.png"` 会被
> vite 当模块解析，`publicDir: false` 时直接构建失败（`UNRESOLVED_IMPORT`）。

## 重新生成

原始素材在 `C:\Users\hanson\Downloads\yingchao-assets\影巢影视平台\`，压缩命令：

```bash
ffmpeg -y -i 02-icon.png -vf scale=256:256 -q:v 3 public/art/logo-mark.png
ffmpeg -y -i 19-empty-404.png -vf scale=960:-1 -q:v 4 public/art/empty-404.jpg
```

全部 19 个成品合计约 1.25 MB，其中最大的是 `logo-wide.png`（225 KB）。

## 图标现状（不用改）

`public/icons/` 里 favicon 16/24/32/48/64/96/128/256、`icon-36…1024`、`icon-maskable-512`、
`mstile-310x150` 全套齐全，`public/site.webmanifest` 与 `public/index.html` 的引用都在；
`public/brand/logo.png`、`icon-1024.png`、`og-cover.jpg` 也已就位。缺的从来不是文件，
是页面里没用它们——本轮补的就是这部分。

回归测试：`test/art-assets.test.mjs` 断言 19 张素材存在、体积合理、构建脚本复制了 `art` 目录、
四个页面确实引用了对应文件。
