# 品牌与站点图标

## 资产来源

- 原始品牌图：`C:\Users\hanson\Downloads\yingchao-assets\影巢影视平台\02-icon.png`
- 原始组合 Logo：`C:\Users\hanson\Downloads\yingchao-assets\影巢影视平台\01-logo.png`
- 生成脚本：`scripts/generate-site-icons.py`（Pillow 12）
- 生成产物：`public/icons/`、`public/brand/`、`admin/icons/`

## 已覆盖的图标

| 场景 | 产物 |
|---|---|
| 浏览器 favicon | `favicon.ico`（16/24/32/48）、`favicon-16x16.png`、`favicon-32x32.png` |
| Chrome / Android / PWA | `icon-36` 到 `icon-512`、`icon-maskable-512.png`、`icon-1024.png` |
| iOS / iPadOS | `apple-touch-icon.png`（180）、57/60/72/76/114/120/144/152/167/180 |
| Windows 固定站点 | 70/150 方形磁贴、`mstile-310x150.png`、`browserconfig.xml` |
| 分享预览 | `public/brand/og-cover.jpg`（1200×630） |
| 两端入口 | `public/site.webmanifest`、`admin/admin.webmanifest` |

C 端与后台各自保留一份图标文件，保证 `/video/`、`/video-admin/` 两个子路径部署时不跨目录引用。顶栏和后台侧栏使用方形应用图标；完整 Logo 仅用于品牌源文件与社交分享图，不在小尺寸导航中强行塞入文字。

## 重新生成

```powershell
python scripts/generate-site-icons.py
```

素材不在默认下载目录时显式传入：

```powershell
python scripts/generate-site-icons.py --icon <icon.png> --logo <logo.png>
```

图标接入由 `test/icons.test.mjs` 校验：关键尺寸、ICO、Apple Touch、C/B 两端 manifest 以及 manifest 内所有图标路径必须存在。
