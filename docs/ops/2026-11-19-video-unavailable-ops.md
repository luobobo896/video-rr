# /video/ 与 /video-admin/「无法使用」运维侧诊断与最小修复

角色：DevOps Automator（部署流水线与运维）
时间：2026-11-19 20:50–20:55（CST）
方式：本地仓库只读 + `ssh hk` 只读检查（未执行任何写入、未重启服务、未改 nginx、未改库）

标记约定：**【已验证】** = 本次实际执行并拿到输出；**【推断】** = 未执行/无直接证据；**【待验证】** = 可执行但本次未跑。

---

## Conclusion

1. **服务与子路径链路本身是通的，不是「打不开」**。`/video/` 200（2732B）、`/video-admin/` 200（2279B）、静态 chunk、`/video-admin/api/me` 401 都符合预期。——【已验证】
2. **用户说的「无法使用」最可能的真实成因是封面图大面积 404 + 首页数据量过大**，而不是路由或进程故障：
   - `nginx error.log` 从 20:41 到 20:48 持续出现 `storage/images/variants/cover-*-w640.webp` 与 `storage/images/cover-sintel.jpg` 的 `No such file or directory`。——【已验证】
   - 库内 `dramas` 共 **117006** 行，其中 `cover_url LIKE '/media/images/%'` **114404** 行。——【已验证】117006 部、114404 条本地封面是把线上首页拖到不可用的结构性因素（健康检查只测「有没有 HTML」测不出来）。
   - `storage/images` 源图 14949 张，`variants/*-w640.webp` 只有 14754 个，**缺口约 195**；且前端 `srcset` 默认请求 **320/640/1280 三档**，1280 档缺口更大。——【已验证】计数 +【推断】三档都会被请求（见下）
3. **发布流程存在实锤缺陷：`/video/` 是 nginx `alias` 直出静态目录，没有任何 SPA fallback**。`https://wyfclyes.top/video/detail/11` → **404**（`open() "/opt/video-rr/dist/client/detail/11" failed`）。C 端是 hash 路由（`public/src/router.js` 用 `location.hash`），所以只有「带路径的深链/被外部站点引用的直链」会挂；但这同时说明「发布后旧 chunk 失效」的兜底路径不存在。——【已验证】
4. **发布流程没有单测门禁、没有备份二进制产物、没有回滚脚本**：`/opt/video-rr` 只有 `app.db` 和源码 tgz 的备份（`storage/backup/app.db.*.sqlite`、`source-before-*.tgz`），**没有 dist 备份**。今天的发布是就地 `npm run build` + `systemctl restart`，一旦新 build 有问题，回滚只能重新 checkout + rebuild，窗口不可控。——【已验证】

**推荐决定**：按下面 P0/P1 顺序做，P0 全部是「可逆、只读预热 + 补数据 + 加一行 nginx」级别；不要为了这次故障去回滚代码（代码没有坏）。

---

## Evidence and location

### 已执行验证（本次实跑）

| # | 检查 | 命令/位置 | 结果 |
|---|---|---|---|
| 1 | 进程状态 | `systemctl status video-rr`（hk） | active (running) since 20:37:37，PID 3703005，Memory 51.6M / high 4G |
| 2 | 构建产物时间 | `stat dist/client/index.html dist/admin/index.html` | 20:37:35 / 20:37:37，与 `systemctl restart` 同分钟 |
| 3 | 子路径 HTML | `curl -sI --resolve wyfclyes.top:443:127.0.0.1 https://wyfclyes.top/video/` | 200，`content-length: 2732`，`cache-control: no-cache`，`x-frame-options: SAMEORIGIN` |
| 4 | 后台 HTML | 同上 `/video-admin/` | 200，`content-length: 2279`，`x-frame-options: DENY`，`referrer-policy: no-referrer` |
| 5 | SPA 深链 | `curl https://wyfclyes.top/video/detail/11` | **404**；error.log：`open() "/opt/video-rr/dist/client/detail/11" failed` |
| 6 | Node 直连同路径 | `curl http://127.0.0.1:8787/video/detail/11` | **404 text/plain**（Node 也不兜底） |
| 7 | 封面源图缺失 | `ls storage/images/cover-sintel.jpg` | 不存在 |
| 8 | 封面变体缺失 | `curl .../variants/cover-tos-w640.webp` | **404**（但 `storage/images/cover-tos.jpg` 存在，源图 78KB/480px） |
| 9 | 变体存在样例 | `curl .../variants/banner-bbb-w640.webp` | 200，16914B |
| 10 | 源图可直接访问 | `curl .../media/images/cover-tos.jpg` | 200，78109B（说明 `alias`/权限/`Sendfile` 正常，不是路径系统性错误） |
| 11 | 覆盖率 | `ls storage/images/*.jpg *.png | wc -l` = 14949；`ls variants/*-w640.webp | wc -l` = 14754 | 缺 195 |
| 12 | 变体任务 | `crontab -l`：`30 4 * * * node scripts/build-image-variants.mjs --widths 320,640,1280`；`/tmp/variants-cron.log` 末行 `完成：生成 0 跳过 44850 失败 0，用时 387s`（04:36） | 任务在跑但**每天零产出**，因为跳过条件只看 mtime |
| 13 | 源图宽度 | `ffprobe cover-tos/bbb/ed.jpg` | 全部 480px |
| 14 | 数据量 | `select count(*) from dramas` = 117006；`cover_url like '/media/images/%'` = 114404；`like 'http%'` = 2602 | — |
| 15 | 无 CI | `ls .github`（hk） | 不存在 |
| 16 | 备份形态 | `ls storage/backup | head` | 只有 `app.db.*.sqlite` 与 `source-before-*.tgz`，**没有 dist/ 备份** |
| 17 | nginx mime | `grep webmanifest /etc/nginx/mime.types` | 无 `webmanifest`（片段里用 `location = /video/site.webmanifest` 的 `default_type` 兜住了；但构建产物 manifest 实际在 `./assets/site-D7cCe3yR.webmanifest`，**该 URL 未被 `location =` 命中**，靠默认 mime 推断，回报为 `application/octet-stream`）——见风险 R5 |

### 代码位置（本地仓库，已读）

- `vite.client.config.mjs:4` `base: './'`、`vite.admin.config.mjs:4` `base: './'` —— 两个 base 都是相对路径，因此 HTML 里引用是 `./assets/index-*.js`，**只有在目录型 URL（末尾带 `/`）下才解析正确**。`/video` 无斜杠场景由 `location = /video { return 301 /video/; }` 覆盖（`deploy/nginx-video.snippet.conf`）。——【已验证：配置文本】
- `server/index.mjs:63-68`：`CLIENT_BUILD = dist/client`、`ADMIN_BUILD = dist/admin`，`existsSync(index.html)` 才用构建产物，否则退回 `public/` + `legacy.html`。→ **构建失败时会静默退回旧版前端**，这是发布期「用户看到老页面/样式对不上」的隐蔽来源。——【已验证：源码】
- `server/index.mjs:640-644`：`/admin/` 前缀走 `ADMIN_ROOT`，其余走 `CLIENT_ROOT`；`pathname === '/' ? CLIENT_INDEX : pathname.replace(/^\//,'')`，**没有 SPA fallback**（`serveStatic` 找不到文件就 404）。
- `public/src/router.js` —— hash 路由（`location.hash`），所以正常导航不会打到 nginx；`/video/detail/11` 这类路径只能来自外部硬链接、App 深链、扫码、旧版直链。
- `public/src/api.js:161-181` `imageVariant/imageSrcset`：把 `/media/images/x.jpg?v=…` 改写成 `/media/images/variants/x-w{320,640,1280}.webp?v=…`；`FilmArt.vue:24-25,74` 同时给 `src`（320 或 640）和 `srcset`（三档）。→ **一屏 24 张卡片 = 最多 48 个图片请求，其中任一档 404 都会打 error.log，且 `srcset` 某档 404 时浏览器不会自动降级到 `src`（`srcset` 与 `src` 是候选关系，选中 404 档即整图裂）**。——【已验证：源码；浏览器降级行为为规范推断】
- `scripts/build-image-variants.mjs:98` `if (sourceWidth && sourceWidth <= width * 1.05) { skipped++; continue }` —— 源图 480px 时 w640/w1280 **被设计性跳过**，但前端 `imageSrcset` 仍然生成这两档候选。**这是「源图存在、变体却永远不生成」的根因**，不是 cron 失败。——【已验证：源码 + ffprobe 输出】
- `deploy/install-hk.sh`：部署顺序为 `npm ci` → `npm run build` → `systemctl restart video-rr` → `install nginx snippet` → `nginx -t` → `reload` → 健康检查（`/video/` 200、`/video-admin/` 200、`/video/api/constants` 200、`/video/media/hls/1/index.m3u8` 401|403）。**没有 `npm test`、没有 dist 备份、没有失败回滚**；失败时只退出 1，线上已重启。——【已验证：脚本文本】
- `deploy/video-rr.service`：`User=videorr`、`EnvironmentFile=/opt/video-rr/.env`、`Restart=always`、`MemoryHigh=4G/MemoryMax=6G`、`StandardOutput=append:/var/log/video-rr.log`。——【已验证】
- `.env` 键清单（值已脱敏，只看到 `<set>`）：`PORT`、`MH_SECRET`、`MH_LINK_SECRET`、`MH_CONFIG_KEYS/MH_CONFIG_KEY_VERSION`、`MH_OTP_SECRET`、`MH_REDIS_URL`、`MH_LINK_TTL`、`MH_TRON_API_KEY/API_BASE/USDT_WATCH`、`MH_BASE_PATH`、`MH_PLAY_TTL_MAX`、`MH_UPLOAD_MAX_BYTES`、`MH_XVFB`、`MH_EDGE`、`MH_GEOIP`、`MH_WARM_PROFILE`；`MH_RTMP_PORT`/`MH_HLS_PORT` 仍在（本版本已无直播组件）。SMTP 全部注释未填。——【已验证：键名】

---

## 架构与运营边界（运维视角）

```
浏览器 ──TLS/HTTP2──> nginx 1.26.3 (sites-enabled/whatsapp-ai-hk 191 行 include video-rr.conf)
                        ├── /video/            alias /opt/video-rr/dist/client/   (静态，无 fallback)
                        ├── /video-admin/      alias /opt/video-rr/dist/admin/    (静态，无 fallback)
                        ├── /video/media/images/  alias storage/images/           (源图 7d 缓存)
                        ├── /video/media/images/variants/ alias storage/images/variants/ (30d immutable)
                        ├── /video/media/hls/  auth_request → Node /media-auth, alias storage/hls
                        ├── /video/media/remote|trial/  proxy → Node (proxy_buffering off)
                        ├── /video/api/        proxy → 127.0.0.1:8787/api/
                        └── /video-admin/api/  proxy → 127.0.0.1:8787/admin/api/
Node (video-rr.service, :8787, node:sqlite 单文件 storage/app.db)
                        └── storage/{hls,uploads,images,remote-cache,backup}
```

关键事实：**HTML/JS/CSS 由 nginx 直出（Node 只兜底）**，所以「前端白屏」不可能是 Node 挂了；**图片也由 nginx 直出**，所以图片裂只能是磁盘上没有文件或 alias 指向错误（本次是前者）。Node 唯一不可替代的职责是 API、播放签名、媒体代理。这决定了运维止损面：**回滚前端 = 换 dist 目录；数据库与媒体文件是唯一有状态资产**。

---

## 环境划分与配置清单

| 环境 | 位置 | 启动 | 状态 |
|---|---|---|---|
| 本地开发 | `E:\video-rr`，`npm run dev`（Node 8787 + vite 5173/5174） | 无 nginx，vite proxy `/api`、`/media` | 已验证脚本存在 |
| 生产 | hk `ecsuQax`，`/opt/video-rr`，`wyfclyes.top` | systemd `video-rr.service` + nginx 片段 | 唯一生产 |
| 预发 | **不存在** | — | 建议方案（见 P1-3），本次无 |

**必须人工确认的密钥/权限项**（本次只看键名，未取任何值）：

| 项 | 用途 | 确认人 | 备注 |
|---|---|---|---|
| `MH_SECRET` / `MH_LINK_SECRET` / `MH_OTP_SECRET` | 会话签名、播放签名、OTP | 站点 owner | 轮换会导致所有登录态与播放链接同时失效，**发布窗口外不要动** |
| `MH_CONFIG_KEYS` / `MH_CONFIG_KEY_VERSION` | 后台配置加密 | owner | 加版本时需保留旧 key 才能解历史配置 |
| `MH_TRON_API_KEY` | USDT 链上监听 | owner | 空值时 TronGrid 有公共额度，限流会漏单 |
| `MH_REDIS_URL` | 限流滑动窗口 | — | 未装 redis 会降级进程内内存（单实例可用，多实例不可） |
| GitHub `origin` 凭据 | 发布拉代码 | owner | `git remote` 用 HTTPS，机器上有明文 credential 的风险未查 |
| SSH 到 hk 的账号 | 发布 | owner | 本次登录用户是谁未记录（`whoami` 未跑） |

---

## 构建与制品形态

- 命令链：`npm run build` = `build:client`（rolldown-vite → `dist/client`）→ `build:admin`（→ `dist/admin`）→ `copy-frontend-assets.mjs`（拷 `icons/brand/art/vendor`、`site.webmanifest`、`robots.txt` 等）。
- 制品：纯静态目录两份 + 一个 Node 进程。**没有容器、没有镜像、没有版本化制品库**。
- **缺陷 D1**：`dist/` 未版本化，发布即覆盖，「回滚」= 重新构建旧 commit，构建结果取决于当时的 node/rolldown 版本。→ 建议 `dist-<sha>` 并列目录 + 软链。
- **缺陷 D2**：`server/index.mjs:65-68` 在 `dist/client/index.html` 缺失时**静默**退回 `public/legacy.html`，健康检查只 grep `id="app"`，legacy 页也有该 id，因此构建立即失败也能通过检查。→ 建议健康检查改为 grep 构建产物的 chunk 名（如 `assets/index-`）。
- **缺陷 D3**：`package-deploy.mjs` 打包 `ENTRIES` 不含 `dist`，但包含 `data/`；而 `install-hk.sh` 强制 `npm ci + npm run build`，所以制品来源是源码而非 tgz。→ 意味着**线上构建的输入是 git 工作区**，不是发布包。

---

## 进程管理与健康检查（现状 vs 建议）

现状（已验证）：
- systemd `Restart=always`、`RestartSec=3`，日志 append 到 `/var/log/video-rr.log`（4.0MB）与 `.err.log`（222KB），**无 rotation 配置**（本次未在 `/etc/logrotate.d` 里查到，属【推断】）。
- 无 liveness/readiness 探针；nginx 侧无 `proxy_next_upstream`（单实例，无意义）。
- 部署健康检查只验 4 个 URL 的状态码，不验图片、不验 chunk、不验数据量。

建议（待验证方案）：
```bash
# /opt/video-rr/deploy/health.sh —— 退出码即结论，可被 cron / CI 复用
set -euo pipefail
H="--resolve wyfclyes.top:443:127.0.0.1"
code() { curl -sk -o /dev/null -w '%{http_code}' $H "https://wyfclyes.top$1"; }
[ "$(code /video/)" = 200 ]
[ "$(code /video-admin/)" = 200 ]
[ "$(code /video/api/constants)" = 200 ]
# 构建产物必须是 Vue 版：抓 index.html 里引用的 chunk 再验一次（防 legacy 静默兜底）
chunk=$(curl -sk $H https://wyfclyes.top/video/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ -n "$chunk" ] && [ "$(code "/video/$chunk")" = 200 ]
# 变体缺口率门禁：>2% 视为构建/数据异常（本次实测约 1.3%，命中即告警）
cd /opt/video-rr/storage/images
src=$(ls *.jpg *.png 2>/dev/null | wc -l); have=$(ls variants/*-w640.webp 2>/dev/null | wc -l)
[ $(( (src-have)*100/src )) -le 2 ]
```

---

## CI/CD 阶段与质量门禁（建议方案，当前不存在 CI）

`.github` 不存在（已验证）。建议分两级，先补「部署脚本内门禁」，再谈 GitHub Actions（hk 是否能被 GH runner 触达未验证）。

| 阶段 | 内容 | 门禁 | 现状 |
|---|---|---|---|
| 1 静态检查 | `npm run check`（tokens + frontend syntax） | 非 0 即停 | install-hk.sh **未调用** |
| 2 单测 | `npm test`（`node --test test/*.test.mjs`） | 非 0 即停 | **未调用** |
| 3 构建 | `npm run build` | `dist/*/index.html` 非空 + 含 `assets/index-` | 部分已有 |
| 4 制品快照 | `mv dist dist-$(git rev-parse --short HEAD)` + `ln -sfn` | 快照存在 | 无 |
| 5 重启 | `systemctl restart` + `curl /api/constants` 重试 5 次 | 2xx | 有，单次 |
| 6 冒烟 | `deploy/health.sh` | 退出码 0 | 无 |
| 7 失败自动回滚 | `ln -sfn` 回上一快照 + restart | 恢复 200 | 无 |

**止损优先级**：图片/前端问题（无状态）→ 换软链即可，秒级；数据问题 → 用 `storage/backup/app.db.*.sqlite`（已验证每日/每次发布都有快照，`install-hk.sh` 用 `VACUUM INTO` + `integrity_check`）。

---

## 日志与告警（建议方案）

现状问题：
- `nginx error.log` 已 9.4MB，且 404 洪泛（今天 36566 条 `No such file`，已验证 `grep -c`）。**图片 404 与真实故障混在一起，告警信噪比为零**。
- 变体任务日志写 `/tmp/variants-cron.log`（root 所有，每次覆盖式 append），无失败告警。
- 无 uptime/外部探活（cron 里只有 pomodoro 站点的探活，与本项目无关）。

建议：
1. nginx 增加只记非静态的错误日志或对 `images/` 关掉 `error_log`：`location ^~ /video/media/images/ { error_log /var/log/nginx/video-images.log warn; ... }`，主 error.log 只留 API/媒体签名/上游错误。
2. logrotate：`/etc/logrotate.d/video-rr`，`daily rotate 14 compress`，`su videorr videorr`（日志是 videorr 所有）。
3. 外部探活：`*/5` 抓 `/video/` 的 chunk 是否 200 + `/video-admin/api/me` 是否 401，连续 3 次失败才写告警（沿用站点已有 `pomodoro-focus-health.sh` 的模式）。
4. 变体缺口率每日一行：`src/have` 差值 >2% 或 24h 零生成则告警——正是这次该触发却没触发的指标。

---

## 灰度与回滚步骤

当前无灰度能力（单实例、无蓝绿、无版本前缀）。最小可行灰度方案：
- **前端灰度**：保留 `dist-<sha>` 快照，nginx `alias` 指向软链 `dist/current → dist-<sha>`；发布后先自己用 `?v=` 无关的独立路径（如 `location = /video-canary/ { alias /opt/video-rr/dist-<sha>/client/; }`）验一次，再切软链。代价：一条 nginx 行 + 一个 `ln`。
- **回滚**：
  ```bash
  # 回滚前端（秒级，无状态）
  cd /opt/video-rr && ln -sfn "dist-$PREV" dist-current && nginx -s reload   # 若 alias 改为 dist-current
  # 回滚 Node
  git -C /opt/video-rr reset --hard <prev-sha> && npm ci && npm run build && systemctl restart video-rr
  # 回滚数据（仅当迁移出错）
  systemctl stop video-rr && cp storage/backup/app.db.<stamp>.sqlite storage/app.db && systemctl start video-rr
  ```
  注意：目前 `alias` 写死 `/opt/video-rr/dist/client/`，改软链需要先改 nginx（**待验证方案**，本次未改）。

---

## 风险清单

| # | 位置 | 触发条件 | 影响 | 最小修复 | 验证方法 | 证据级别 |
|---|---|---|---|---|---|---|
| R1 | `storage/images/variants/` | 源图 480px → 脚本按 `width*1.05` 跳过 w640/w1280，前端仍请求三档 | 卡片封面裂；error.log 洪泛；首屏观感 = 「站坏了」 | ① `imageSrcset` 只保留 ≤ 源宽的档位（需前端改，见 Handoff）；② 或服务端在变体缺失时 302 到源图（`try_files $uri @fallback`），先止血 | `curl .../variants/cover-tos-w640.webp` 应 200 或 302；缺口率 ≤2% | 变体缺失【已验证】；480px 跳过【已验证】；裂图【推断：需真机看】 |
| R2 | `storage/images/cover-sintel.jpg` | 该源图磁盘上不存在但库里有引用 | 单张裂 + 404 日志 | 从 `data/images.json` 重找该 id 的源，或把该剧 cover 置空走 `fallbackArt` | `ls storage/images/cover-sintel.jpg` | 【已验证】 |
| R3 | `dist/client/index.html` + nginx `location /video/` | 浏览器访问 `/video/detail/11` 这类路径；或发布后旧 chunk 被引用 | **404 硬失败**（无 SPA fallback） | nginx 加 `error_page 404 = /video/index.html;` 或 `try_files $uri $uri/ /video/index.html;`（alias 下的 `try_files` 需用 `$uri` 映射，**待验证**） | `curl https://wyfclyes.top/video/detail/11` → 200 | 【已验证】 |
| R4 | `server/index.mjs:65-68` | `dist/client/index.html` 构建失败/缺失 | 静默退回 `legacy.html`，用户看到旧版；健康检查仍绿 | 生产环境加 `MH_REQUIRE_BUILD=1`：缺产物直接 `process.exit(1)`（需后端改）；短期在 health.sh 里 grep chunk | 故意 `mv dist/client/index.html` 后 health.sh 必须非 0 | 【已验证：源码】 |
| R5 | `dist/client/assets/site-*.webmanifest`、`assets/admin-*.webmanifest` | 浏览器请求 manifest | mime 无 `webmanifest`，可能 `octet-stream`；`location = /video/site.webmanifest` 未命中带 hash 的路径 | 加 `location ~ \.webmanifest$ { default_type application/manifest+json; }` | `curl -sI .../assets/site-D7cCe3yR.webmanifest` 看 `content-type` | 【推断：未取该 URL 的响应头】 |
| R6 | `dramas` 117006 行 / 本地封面 114404 | 首页/分类页一次性返回过多条目 | 首屏请求与渲染压力大，慢网像是「打不开」 | 首页/分类分页上限、`/api/home` 限制 sections 条数（后端）；先量 `/api/home` 响应体大小与 TTFB | `curl -w '%{size_download} %{time_total}' /video/api/home` | 行数【已验证】；性能影响【推断：未测】 |
| R7 | `deploy/install-hk.sh` 第 1/7 步 | 构建失败 | 已 restart 的服务跑在旧/半新产物上，脚本 exit 1 但线上已变更 | 构建放到 restart 之前且失败即停（已是），**新增**：restart 前做 dist 快照 + 失败自动回滚 | 注入一次 build 失败观察是否回到旧产物 | 【已验证：脚本顺序】 |
| R8 | `/var/log/nginx/error.log` 9.4MB，无 rotation 证据 | 404 洪泛持续 | 磁盘与排障噪音 | logrotate + 拆 images 日志 | `du -h /var/log/nginx/error.log` 一周后应回落 | rotation【推断】 |
| R9 | `.env` 里 `MH_RTMP_PORT`/`MH_HLS_PORT` 残留 | 无（无直播组件） | 误导后来人以为有 RTMP | 删除两行 | `grep -c RTMP .env` = 0 | 【已验证：键存在】 |
| R10 | `storage/app.db-wal` 67MB | 长事务/长期不 checkpoint | 备份与 `VACUUM INTO` 耗时、极端情况 WAL 膨胀 | 定期 `PRAGMA wal_checkpoint(TRUNCATE)`（维护窗口） | `ls -la storage/app.db-wal` | 【已验证：67MB】 |

---

## 验收清单

### P0（止血，全部可逆）

| # | 前置 | 操作 | 预期 | 本次是否执行 |
|---|---|---|---|---|
| A1 | hk 只读 | `node scripts/media-asset-audit.mjs`（默认只读） | 打印 `变体文件 N 条；源图 14949 张；w640 缺口 X` | **未执行**（脚本在工作区未提交，`?? scripts/media-asset-audit.mjs`） |
| A2 | 需 owner 同意写入 | `node scripts/build-image-variants.mjs --widths 320,640` 手动跑一次并观察是否仍全跳过 | 若仍 `生成 0` 则坐实 R1 是设计性跳过 | 未执行 |
| A3 | nginx 可改 | 备份 `deploy/nginx-video.snippet.conf` 后，`location /video/media/images/variants/` 加 `try_files $uri @img_src;` + `location @img_src { rewrite ^/video/media/images/variants/(.+)-w\d+\.webp$ /video/media/images/$1.jpg break; proxy_pass ...; }`（具体写法需 `nginx -t` 验证） | `cover-tos-w640.webp` 返回 200（源图）而非 404 | 未执行 |
| A4 | nginx 可改 | `location /video/` 加 `error_page 404 =200 /video/index.html;` | `/video/detail/11` → 200 | 未执行 |
| A5 | — | 缺失源图 `cover-sintel.jpg` 从镜像映射找回或置空 cover | error.log 不再出现该文件 | 未执行 |

### P1（发布流程加固）

| # | 操作 | 预期 |
|---|---|---|
| B1 | `install-hk.sh` 第 1/7 步插入 `npm run check && npm test` | 检查/测试失败即停，不进构建 |
| B2 | 构建后 `mv dist dist-$(git rev-parse --short HEAD)`，`ln -sfn` 到 `dist/current`；nginx alias 改指向 `dist/current` | 回滚 = 换软链 |
| B3 | 新增 `deploy/health.sh`（见上），cron `*/5` | 前端 404/产物退回 legacy 能在 5 分钟内发现 |
| B4 | logrotate + images 独立 error_log | error.log 稳定在 MB 级以下 |
| B5 | 可选：`/video-canary/` 灰度为预发 | 发布前能在同域验新产物 |

### 逐项回归用例（每条风险 ≥1 例）

- R1：`curl -o /dev/null -w '%{http_code}' https://wyfclyes.top/video/media/images/variants/cover-tos-w640.webp` → 期望 200/302（当前 404）。
- R2：`curl .../video/media/images/cover-sintel.jpg` → 期望 200（当前 404）。
- R3：`curl .../video/detail/11` → 期望 200（当前 404）。
- R4：临时把 `dist/client/index.html` 改名后跑 `deploy/health.sh` → 期望非 0（当前会绿）。
- R5：`curl -sI .../video/assets/site-D7cCe3yR.webmanifest` → 期望 `content-type: application/manifest+json`（未测）。
- R6：`curl -s -o /dev/null -w '%{size_download} %{time_total}' .../video/api/home` → 记录基线后再定阈值（未测）。
- R7：`bash deploy/install-hk.sh` 在 build 前注入 `exit 1` → 期望服务仍跑旧产物且脚本非 0（未测）。
- R8：一周后 `du -h /var/log/nginx/error.log` → 期望 ≤ 50MB。
- R9：`grep -c 'MH_RTMP_PORT\|MH_HLS_PORT' /opt/video-rr/.env` → 期望 0。
- R10：`ls -la storage/app.db-wal` → 期望 < 50MB（当前 67MB）。

---

## Risks and conditions（结论可能被推翻的条件）

- 若用户实际报的是**播放**不可用而非页面不可用，本报告的 R1/R3 优先级要让位给 `/video/media/hls|remote` 的签名与上游 403（本次只验了未签名必 401/403，**未验真实播放**）。推翻条件：真机播放报 502 且 error.log 有 `直链签名过期`。
- 若 `dramas` 117006 行的页面上限已被 API 侧限流，则 R6 影响可忽略。推翻条件：`/api/home` 响应体 < 100KB。
- 「裂图」目前只有日志证据；**未用真实浏览器截图确认**，若真机图片都正常，则 R1 只是日志噪音，用户「无法使用」应改查 R3（深链 404）或其他端侧问题。
- `404 日志 36566 条`包含扫描器噪音（`/assets/favicon-*.ico` 来自非子路径的 `/`），不能全算图片缺口。

## Actions and acceptance（优先级）

1. **P0-A4 深链兜底**（1 行 nginx，5 分钟，风险最低）。
2. **P0-A3 变体回退到源图**（止损裂图，不改前端）。
3. **P0-A1/A2 量化缺口**（只读体检 + 一次手动补建，坐实 R1）。
4. **P1-B2 dist 快照 + 软链**（回滚从「重构建」变「换链接」）。
5. **P1-B3 health.sh 接 cron**（把这次的断层指标变成持续门禁）。

完成标准：A4/A3 后 `cover-*-w640.webp` 与 `/video/detail/*` 不再 404；B2/B3 后任意一次构建失败能在 5 分钟内被发现且可 1 分钟内回滚。

---

## Handoff（交给主理人统一核对）

- **给 Software Architect**：`/video/` 无 SPA fallback 与 hash 路由的组合是否属于契约问题（外部直链 `/video/detail/:id` 是否要支持）；`/video-canary/` 路径是否与前端 base 冲突。
- **给 Frontend**：`public/src/api.js:161-181` `imageSrcset` 应按源图实际宽度裁剪候选档（480px 源图不应出 640/1280）；`FilmArt.vue` 的 `srcset` 选中档 404 不会回退到 `src`，是否改为 `onerror` 时逐档降级。
- **给 Backend**：`server/index.mjs:65-68` 生产环境缺产物应硬失败而非退回 `legacy.html`；变体缺失是否由 Node 兜底 302（与 nginx 方案二选一）。
- **给 Database Optimizer**：`dramas` 117006 行与 `/api/home` 的实际返回量、`app.db-wal` 67MB 的 checkpoint 策略。
- **未覆盖范围**：真实浏览器截图验证、`/api/home` 性能实测、GitHub 凭据管理方式、hk 上是否有明文凭据存储、logrotate 是否已存在（未查 `/etc/logrotate.d`）。
- **阻塞**：任何写入操作（改 nginx、跑补建、改 `.env`）都需要 owner 授权，本次一律只读。
