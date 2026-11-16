# 环境变量

所有运行时配置都用 `MH_` 前缀，放在 `.env`（已被 `.gitignore` 忽略）。本文是唯一清单：新增变量必须在这里登记，删改变量必须同步表格里的默认值。

约定：

- **默认值以代码为准**。表格里的「默认」是代码在变量缺失时的取值；服务器上 `.env` 的实际值以运维记录为准。
- 标「生产必设」的变量在缺失时会退回仅供本地调试的行为，上线前必须显式配置。
- 布尔开关一律用字符串 `1` / `0` 表示，不要写 `true`：代码里普遍是 `=== '1'` 比较。
- 带毫秒单位的变量名以 `_MS` 结尾，带容量单位的是字节数或 MB（名字里标了 `_MB` 的才是 MB）。

## 1. 基础与存储路径

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_DB` | `storage/app.db` | SQLite 库路径。相对路径按**进程 cwd** 解析，运维脚本必须显式传绝对路径，否则会在别处新建空库 |
| `MH_BASE_PATH` | 空 | 站点子路径前缀（如 `/video`），nginx 与前端 `window.__MH_BASE` 必须与之一致 |
| `MH_UPLOAD_DIR` | `storage/uploads` | 用户上传目录（头像、封面） |
| `MH_HLS_DIR` | `storage/hls` | 转码产物目录，`/media/hls/<剧集>/<name>` 与试看截断都读这里 |
| `MH_REMOTE_CACHE` | `storage/remote-cache/` | 远端片源中转缓存目录 |
| `MH_CONFIG_KEY_FILE` | `storage/config.key` | 支付渠道密钥加密用的主密钥文件，**权限 600，不进版本库** |
| `MH_CONFIG_KEYS` | 空 | 主密钥轮换：`版本号:密钥` 逗号分隔的集合，用于平滑换钥 |
| `MH_CONFIG_KEY_VERSION` | 最大版本号 | 当前写库用的密钥版本 |

## 2. 凭据与签名（生产必设）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_SECRET` | 站点设置里的 `linkSecret`，再缺省为开发值 | 访客/成人门 cookie 的 HMAC 密钥。缺省会退回开发常量，**生产必设** |
| `MH_LINK_SECRET` | 自动生成后写库 | 播放签名密钥。`dev-link-secret` 会被自动轮换成随机值 |
| `MH_LINK_TTL` | `300` | 播放签名有效期（秒），夹在 60–1800 |
| `MH_PLAY_TTL_MAX` | `7200` | 单次播放链接的 TTL 上限（秒），夹在 `LINK_TTL`–14400 |
| `MH_OTP_SECRET` | 取 `MH_SECRET` | 邮箱验证码的哈希密钥 |
| `MH_ADMIN_INIT_PASSWORD` | 空 | 首次建库时超管口令（仅安装脚本使用）；轮换超管口令后旧值失效 |
| `MH_SKIP_ADMIN_ROTATION` | 空 | `1` 时不自动轮换内置超管口令（调试用） |
| `MH_ALLOW_UNSIGNED` | 空 | `1` 时允许未签名支付回调（**仅本地调试**） |
| `MH_ALLOW_SIM_PAY` | 空 | `1` 时开启模拟收银台（**生产禁止**） |
| `MH_ALLOW_VISITOR_HEADER` | 空 | `1` 时接受 `x-mh-visitor` 请求头当作访客身份。默认只认 HttpOnly cookie，头部可被脚本无限重置 |
| `MH_CS_ASSIST_PLAINTEXT` | 空 | `1` 时客服代发验证码在接口响应里回明文（后台运维应急）。默认只在测试钩子下回显 |
| `MH_OTP_TEST` | 空 | 验证码明文钩子，需同时满足 `MH_OTP_TEST=1` **和** `NODE_ENV=test`；生产环境设置它会在模块加载时直接抛错 |

## 3. 请求、限流与上传

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_BODY_TIMEOUT_MS` | `15000` | 请求体读取超时，夹在 1s–120s |
| `MH_NOTIFY_MAX_BYTES` | `65536` | 支付通知/Webhook 请求体上限，超限 413 |
| `MH_UPLOAD_MAX_BYTES` | `2147483648` | 单次上传上限（2GB） |
| `MH_REDIS_URL` | 空 | 限流与 OTP 计数的共享存储；不配则退回进程内存（多实例下配额不共享） |
| `MH_SESSION_PRUNE` | 空 | `0` 关闭登录会话的过期清理（默认开启） |
| `MH_SLOW_MS` | `800` | 慢请求日志阈值 |
| `MH_DEBUG` | 空 | 打印脚本异常的调用栈 |

## 4. 远端片源代理（`/media/remote/...`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_REMOTE_ALLOW_PRIVATE` | 空 | `1` 时允许代理访问私网/回环地址。**只在测试和本机联调用**，生产开着等于开放 SSRF |
| `MH_REMOTE_TIMEOUT_MS` | `15000` | 上游首包/清单请求超时 |
| `MH_REMOTE_STREAM_TIMEOUT_MS` | `120000` | 单条分片流的总时长上限 |
| `MH_UPSTREAM_QUEUE` | `40` | 同时回源的并发上限，超出排队 |
| `MH_REMOTE_SESSIONS` | `200` | 上游会话（Cookie/Referer 组合）LRU 容量 |
| `MH_HG_SESSION_TTL_MS` | `180000` | 芒果（huangguo）会话缓存存活时间 |
| `MH_REMOTE_CACHE_TTL` | `21600000`（6h） | 中转缓存文件存活时间；**0 表示不缓存** |
| `MH_REMOTE_CACHE_MAX_MB` | `4096` | 缓存目录容量上限，超出按 LRU 淘汰 |
| `MH_REMOTE_GONE_TTL` | `600000` | 上游 404/410 的负缓存时长 |
| `MH_REMOTE_GONE_MAX` | `500` | 负缓存条目上限 |
| `MH_REMOTE_PREFETCH` | `10` | 清单返回后预取的分片数，`0` 关闭 |
| `MH_REMOTE_PREFETCH_CONCURRENCY` | `3` | 预取并发 |
| `MH_REMOTE_WARM` | `16` | 主清单里预热前 N 个分片 |
| `MH_PREFETCH_TIMEOUT_MS` | `20000` | 单个预取请求超时 |
| `MH_PREFETCH_MAX_BYTES` | `33554432` | 单个预取响应的字节上限，超出丢弃 |
| `MH_PREFETCH_BUDGET` | `8` | 单个清单一次最多排在队列里的预取任务数 |

缓存与负缓存都读环境变量即时求值，改 `.env` 重启即生效；预取预算按清单计算，不会跨清单累积。

## 5. 片源刷新与抓取

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_PLAY_REFRESH_WAIT_MS` | `8000` | 播放时等一次同步刷新的最长时间，`0` 表示不等（直接返回 402/占位） |
| `MH_REFRESH_AHEAD_MS` | `600000` | 提前多久判定直链将要过期并触发刷新 |
| `MH_REFRESH_TIMEOUT_MS` | `120000` | 单次刷新（起浏览器）超时 |
| `MH_REFRESH_COOLDOWN_MS` | `300000` | 刷新失败后的冷却时间 |
| `MH_REFRESH_CONCURRENCY` | `2` | 并发刷新数 |
| `MH_REFRESH_FAILING_MAX` | `5000` | 失败冷却表的条目上限（LRU），防止长期运行内存爬升 |
| `MH_REFRESH_LOCK` | `/tmp/jable-refresh-ondemand.lock` | 按需刷新的文件锁 |
| `MH_REFRESH_PROFILE` | `storage/.jable-chrome-od` | 刷新用的浏览器 profile 目录 |
| `MH_XVFB` | 空 | 设置后经 `xvfb-run` 跑有头浏览器 |
| `MH_CHROME_PROFILE` | 由脚本注入 | 传给子进程的 profile 路径 |
| `MH_HEADLESS` | 空 | 抓取脚本是否加 `--headless=new` |
| `MH_EDGE` | `/usr/bin/chromium` | 健康检查用的浏览器可执行文件 |
| `MH_HG_BASE` | `https://huangguoai.com` | 芒果站源地址 |
| `MH_HG_TTL_MS` | `90000` | 芒果直链有效期（默认 90 秒） |
| `MH_HUANGGUO_IMG_KEY` | 源码内公开默认值 | 芒果封面图解密密钥（16 字节）。用默认值会打 warn，生产必设 |
| `MH_HUANGGUO_IMG_IV` | 同上 | 封面图解密 IV |
| `MH_SCRAPE_URL` | 空 | 外部刮削服务地址，不配则用内置 TMDB |
| `MH_SCRAPE_ARCHIVE` | 空 | `0` 时刮削不写归档文件 |
| `MH_DOWNLOAD_TIMEOUT` | `1800000` | 导入时单个素材下载超时 |
| `MH_DOWNLOAD_RETRY` | `4` | 导入时下载重试次数 |
| `MH_SHARD` | 空 | 分片跑导入用 `i/n`，避免两个进程抢同一批片子 |
| `MH_LOCK` | 见 `scripts/lib/lock.mjs` | 覆盖脚本锁文件路径 |
| `MH_FFMPEG` / `MH_FFPROBE` | `ffmpeg` / `ffprobe` | 二进制路径 |

## 6. 统计、封面墙与其它

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_GEOIP` | 空 | `1` 才做 IP 归属地查询；默认**不外发**访客 IP |
| `MH_GEOIP_URL` | `https://pro.ip-api.com/batch` | 归属地接口，可换成自建 |
| `MH_POSTER_MAX_MB` | `32` | 封面墙单图上限 |
| `MH_POSTER_RESERVE_MB` | `1024` | 封面墙生成时预留的磁盘空间 |
| `MH_WARM_PROFILE` | 空 | `0` 时启动不做浏览器 profile 预热 |
| `MH_SUPPORT_EMAIL` | 站点设置 | 客服邮箱，覆盖站点配置里的值 |
| `MH_USDT_WATCH` | 空 | `0` 关闭 USDT 链上监听 |
| `MH_USDT_MIN_CONFIRMATIONS` | `19` | USDT 入账最小确认数 |
| `MH_TRON_API_BASE` | `https://api.trongrid.io` | TronGrid 地址 |
| `MH_TRON_API_KEY` | 空 | TronGrid API Key，缺失时受公共限流 |

## 7. 部署脚本专用

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MH_USER` | `videorr` | `deploy/install-hk.sh` 创建并运行服务的系统用户 |
| `MH_ADMIN_URL` | `http://127.0.0.1:5174/` | 后台冒烟脚本目标地址 |
| `MH_ADMIN_USER` / `MH_ADMIN_PASSWORD` | 空 | 后台冒烟脚本登录用 |

## 安全相关默认值速查

以下变量在**不配置**时的行为是「本地可跑、生产不安全」，上线前逐条确认：

1. `MH_SECRET`、`MH_LINK_SECRET`、`MH_OTP_SECRET` —— 必须换成随机值。
2. `MH_REMOTE_ALLOW_PRIVATE` —— 必须留空（否则代理可打内网）。
3. `MH_ALLOW_UNSIGNED`、`MH_ALLOW_SIM_PAY` —— 必须留空。
4. `MH_ALLOW_VISITOR_HEADER` —— 必须留空（否则试看额度可无限重置）。
5. `MH_OTP_TEST`、`MH_CS_ASSIST_PLAINTEXT` —— 生产必须留空。
6. `MH_DB` —— 部署脚本与 cron 里必须写绝对路径。
