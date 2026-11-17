# C 端封面加载优化（2026-11-17）

## 问题

C 端片库/成人频道点进去要好幾秒才出图。实测线上（香港 hk.hsddns.com）：

- `storage/images` 下 14950 张 jpg 共 5.6GB，平均 384KB，最大 2.9MB；
  其中 `preview-*.jpg` 3746 张就占 4.12GB。
- 片库一页 24 张卡（`CategoryPage` / `AdultPage` 的 `pageSize = 24`）首屏要下约 9MB 原图。
- 跨境链路实测只有 30–100KB/s：2.9MB 的封面要 29.6s，78KB 的也要 1.6s。
  → 结论：带宽是硬瓶颈，唯一有效手段是减少字节数，加缓存/换协议都救不回来。

## 做法

1. **封面 WebP 变体**：`scripts/build-image-variants.mjs` 用 ffmpeg 生成
   `storage/images/variants/<name>-w{320,640,1280}.webp`（质量 70，lanczos 缩放）。
   幂等：变体比源图新就跳过；窄图不放大；并发可调。
2. **前端按需取档**：`public/src/api.js` 的 `imageVariant()` / `imageSrcset()` 把
   `/media/images/x.jpg` 映射到 `variants/x-wNNN.webp`；`FilmArt.vue` 用 `srcset + sizes + loading=lazy`，
   320 档给竖版卡片、640 档给横版/大图；加载失败自动回退原图（新图还没转时不会白框）。
3. **渐变占位淡入**：封面未到位时保持卡片自带的渐变底（`is-loading` 透明，onload 淡入），
   失败则退成占位图（`is-failed`），不再先闪白再填图；hover 预览视频的 poster 也换成 640 变体。
4. **nginx**：`/video/media/images/variants/` 独立 location，`sendfile/tcp_nopush/aio/open_file_cache`，
   `Cache-Control: public, max-age=2592000, immutable`；原图仍 7 天。
5. **原图就地瘦身**：`scripts/squeeze-images.mjs` 把超大 jpg 重编码到最大宽 1280、`-q:v 4`，
   写临时文件后 `renameSync` 原子替换（文件名不变，数据库引用不用改），用来腾出磁盘给变体。
6. **新增图自动补变体**：服务器 crontab `30 4 * * *` 跑 `build-image-variants.mjs`（幂等，只补新图）。

## 结果（线上实测）

| 项目 | 优化前 | 优化后 |
| --- | --- | --- |
| `preview-*.jpg` 原图总量 | 4.12GB | 0.90GB（就地重压，省 3.23GB） |
| w320 变体平均体积 | — | 17.6KB（最大 54KB，共 14811 个） |
| 变体总量 | — | 1469.9MB（套裁自 5307MB 源图，35078 个，失败 0） |
| 封面卡片：原图 → w320 | 平均 132KB | 平均 19.1KB（缩小 6.9×） |
| 片库一页 24 张卡 | 3.09MB | 459KB |
| preview-jable-start-561 | 667KB / 8.83s | w320 55KB / 1.01s（w640 164KB / 2.07s） |
| cover-tos | 78KB | w320 20KB |

（时间均为 curl 单请求 `time_total`，跨境网络波动大，量级参考。）

## 验证与回归

- `test/image-variants.test.mjs`：变体命名、体积下降、幂等跳过、窄图不放大、演练不落盘、非图片跳过。
- `test/squeeze-images.test.mjs`：演练不改图、就地重压体积下降且文件名不变、glob 不越界、阈值跳过、目录缺失报错。
- `test/image-srcset.test.mjs`：URL 映射、srcset 三档、失败回退、`is-loading`/`is-failed` 静态断言。
- `npm test` 562/562 通过，`npm run check` 通过，`npm run build` 通过。

## 后续可做

- 域名解析目前在万网（`dns21/dns22.hichina.com`），如果上 Cloudflare 之类 CDN 缓存
  `/video/media/images/`，大陆访问还能再快一个量级——这需要动 DNS，属于另一件事。
- `scripts/measure-covers.mjs`（`npm run images:measure`）可随时复核封面平均体积与缺变体数量。
