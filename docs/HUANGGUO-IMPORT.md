# 黄果短剧（huangguoai.com）接入

本站的短剧频道（`#/short`）数据来自 `huangguoai.com`。它和 jable 那套成人电影是两条独立生产线：

| | jable.tv | huangguoai.com |
|---|---|---|
| 内容 | 成人电影（单片） | AI 短剧（多集） |
| `dramas.category` | `MOVIE` | `PLAYLET` |
| `dramas.content_type` | `movie` | `drama` |
| `episodes` | 每部 1 条 | 每集 1 条，`no` = 集号 |
| `episodes.remote_url` | CDN 直链 m3u8 | `huangguo://<videoId>/<ep>` |
| 抓取 | 需要 Edge 过 Cloudflare | 直接 HTTP，无 Cloudflare |
| 链接寿命 | 约 3 小时（`exp` 参与签名） | 每集现取票，票短命但可随取随用 |
| 落库命令 | `scripts/jable-import.mjs` | `scripts/huangguo-import.mjs` |

## 为什么短剧能直接抓、电影不能

`huangguoai.com` 没有 Cloudflare 挑战，`/video/<id>/` 是服务端渲染的 HTML，里面直接内嵌了 `videoInitialData`：

```html
<script id="videoInitialData" type="application/json">
{ "id": 12166, "title": "微信性爱系统", "tags": ["大男主","都市","系统","逆袭"],
  "coverSrc": "https://pic.drleao.cn/...", "author": "陈霖",
  "tracking": { "drama_type_name": "AI短剧", "total_episode": 3 },
  "trackingEpisodes": { "1": {"drama_duration": 670}, "2": {...}, "3": {...} } }
</script>
```

所以元数据不需要碰它那套加密接口：`parseHuangguoPage()` 直接从这个 JSON 取。

## 播放：现取票，不落库

`episodes.remote_url` 只存 `huangguo://12166/2` 这种站内引用。真正播放时：

1. `stream-proxy.mjs` 的 `remoteSourceOf()` 认出 `huangguo://`，标记 `provider: 'huangguo'`；
2. 拉清单前调 `POST /api/videos/<id>/episodes/<ep>/playback` 换一张 CDN 票（`{cdn.authValue, cdn.app, streams.main}`）；
3. 清单与分片都带上 `x-cdn-auth` / `x-cdn-app` 两个头；
4. 票过期（session 3 分钟未动）或上游 502 时，`refreshTicket()` 强制换票并重建 session 重试一次。

接口本身在加密通道后面（`dx150-edge-v1`）：ECDH P-256 握手 → HKDF-SHA256 派生 req/res 两把 AES-256-GCM → 每个请求是 `{v,type:'call',kid,sid,seq,ts,ciphertext}`。`server/huangguo.mjs` 把这套完整复刻了，服务端自己就能换票，不需要浏览器。

## 图片是加密的

`pic.drleao.cn` 上的封面不是普通 JPEG，是 AES-128-CBC / NoPadding 密文。凭据在 `static/web/js/plugins/crypto-image-protocol.js` 里是公开的：

```js
window.CryptoImageProtocol = { decryptEnabled: true,
  decryptKey: "f5d965df75336270", decryptIV: "97b60394abc2fbe1" }
```

导入脚本下载后先试 magic（`ff d8 ff` / `89 50 4e 47` / `RIFF`），不是图片才解密，再用 ffmpeg 统一转成 **720 宽的 3:4 竖版 JPEG**（原图 1440×1920 / 3.4MB → 约 150–280KB）。

## 导入

```bash
# 单部试跑
node scripts/huangguo-import.mjs --id 12166 --dry

# 原创页全部分页（/original/ → /original/2/ … 共 7 页，每页 48 部）
node scripts/huangguo-import.mjs --page /original/ --pages 7 --skip-existing

# 全站补齐：自动发现全部题材（当前 42 个）并翻完每个题材的分页，已入库的跳过
node scripts/huangguo-import.mjs --discover --pages 30 --skip-existing

# 先算好差集，再按 id 清单导入（省掉重复的列表抓取）
node scripts/huangguo-import.mjs --ids-file .tmp/hg-missing.json --skip-existing
```

| 参数 | 作用 |
|---|---|
| `--page /original/` | 列表页；原创页分页是 `/original/2/`，题材页是 `/tag/dushi/page/2/`（脚本自动区分） |
| `--tags` | 遍历内置题材清单 |
| `--discover` | 从站点导航抓全部题材（比内置清单全，新题材自动跟上） |
| `--pages N` | 每个列表翻 N 页（xiandai 有 30 页，是最大的） |
| `--id 12166` | 直接指定，可重复 |
| `--ids-file path` | 从 JSON 数组或逗号/换行分隔的文件读 id |
| `--skip-existing` | 库里有 `source_key`（或同片换 id）就跳过，不重抓详情页 |
| `--no-images` | 跳过封面（批量试跑用） |
| `--dry` | 只解析不写库 |
| `--concurrency N` | 并发，默认 4（站点没限流，4 很稳） |

落库规则：

- `dramas.source_key = 'huangguo:<videoId>'` 是去重键（`idx_dramas_source_key`），改标题不会重复建条目；
- `category='PLAYLET'`、`content_type='drama'`、`area='中国'`、`is_adult=1`；
- 每集一条 `episodes`，`no` = 集号，`title='第 N 集'`，`duration` 取 `trackingEpisodes[n].drama_duration`；
- 标签按名字匹配已有 `tags.scope='adult'`；新词（大男主/都市/系统/逆袭…）自动建，统一挂在自建的「短劇」根分组下，不污染 jable 那 8 个分组。

## 两级去重

1. **业务键**：`source_key = huangguo:<videoId>`，同一部抓两次只会 UPDATE 不会新增；
2. **同片换 id**：源站会把同一部片换 videoId 重发（`画家和模特` 3685 与 5685、`师尊秘法` 1605 与 6048、`我的无敌男友` 8050 与 8106、`家庭乱交教学` 13136 与 13502）。`--skip-existing` 时会比对「标题相同 + 集数相同 + 总时长差 ≤3s」，命中就整部跳过，不建第二条。

已经进库的同片历史条目置 `status='hidden'`（前端只查 `published`），数据留着可回滚，不要硬删——`history`/`favorites`/`orders` 里可能有引用。

## 短剧频道

- 路由 `#/short`，组件 `public/src/pages/c/ShortPage.vue`；
- 数据走 `GET /api/category?audience=adult&type=PLAYLET&sort=new|hot&tag=<id>`，频道值 `PLAYLET` 本来就在 `CATEGORY_CHANNELS` 里；
- 题材筛选取 `/api/tags?scope=adult` 里「短劇」根分组的子标签；
- 侧栏「发现 → 短剧」与成人频道互相有入口；
- 复用 `/detail/<id>` 与 `/play/<id>`，多集时详情页自带选集。

## 上生产

短剧和电影共用一套代理与迁移工具，区别只在 `category` 与去重键：

```bash
# 1. 打包（含 server/huangguo.mjs、dist/client 的短剧频道）
npm run pack:deploy

# 2. 导出全部成人条目（jable + 短剧，按 is_adult = 1）
node scripts/adult-export.mjs .tmp-remote/adult-export.json

# 3. 上传并解包
scp mh-deploy-*.tgz hk:/tmp/ && ssh hk 'tar xzf /tmp/mh-deploy-*.tgz -C /opt/video-rr'
ssh hk 'setsid nohup bash /opt/video-rr/deploy/install-hk.sh > /tmp/install.log 2>&1 &'

# 4. 迁数据（幂等；--mode free 让所有条目免会员）
scp .tmp-remote/adult-export.json hk:/tmp/
ssh hk 'cd /opt/video-rr && node scripts/adult-migrate.mjs /tmp/adult-export.json --mode free'

# 5. 增量推图（只传远程没有的）
node scripts/push-images.mjs
```

`adult-migrate` 认条目靠 `source_key`（短剧写 `huangguo:<videoId>`）：
**带 `source_key` 的条目绝不再按标题回退查重**，否则「AI成人短剧 · 黄果官方」这种同作者
`sub_title` 会让几十部互相覆盖（第一次上生产时踩过：1353 部只落库 36 部）。

短剧标签统一挂到 `tags` 里的「短劇」根分组（`sort = 90`）。迁移脚本会自动建根、并把
老库里平铺的题材标签补上 `parent_id`——短剧频道的题材筛选就靠这层父子关系。

生产验收（15 项，含登录、清单、分片、AES key、解密解码、防盗链、ffprobe 全长）：

```bash
# 服务器上执行；WHERE_EXTRA 用来只挑短剧
cd /opt/video-rr
DOMAIN=www.wyfclyes.top ADMIN_PASSWORD=<后台密码> USER_EMAIL=<C 端邮箱> \
  WHERE_EXTRA="remote_url LIKE 'huangguo://%'" bash deploy/verify-adult.sh
```

2026-11-16 实测：1353 部 / 6693 集全部就绪，列表 `total 1353`，封面 720×960，
验收 15/15 通过（清单 3927 字节、分片 2.1MB、key 16 字节、解密 `h264 1280x720`、ffprobe 430.533s）。

同日全站补齐（`--discover` 覆盖 42 个题材、207 页列表 + `/original/` 7 页）：全站 1734 部被识别，
新增 381 部 / 1722 集，零失败，库内共 **1734 部 / 8415 集**，`source_key` 零重复、封面 1734 张齐全；
另有 4 条同片换 id 的重复置 `hidden`，短剧频道可见 **1730 部**。

短剧的票是**服务器端现取**（HK 直连 `huangguoai.com` 200），所以不需要像 jable 那样
在本机挂计划任务刷新；本机 `deploy/sync-adult.cmd` 每 30 分钟那套只服务 jable。

## 已知问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 某一集 `duration = 0` | 源站 `trackingEpisodes` 里该集没给 `drama_duration` | 播放页按清单实际时长显示；不影响播放 |
| 封面 404 | 封面 URL 带时效参数或站群换域名 | 重跑该部（`--id`）会重下图 |
| 播放 502 `upstream rejected` | 票过期或 CDN 换 key | 代理层已自动换票重试一次；仍失败就重跑导入刷新 |
| 标签数量爆炸 | 每部都带 3–5 个题材词 | 新词统一挂「短劇」根，可在后台合并 |

## 评分补齐（--score-only）

短剧在源站有播放、点赞、收藏三个真实数字，评分按三者加权折算（6.0–9.6）：

```
reach = min(3, max(0, (log10(播放量+1) - 3) × 0.75))
save  = min(2, 收藏/播放 × 20)
like  = min(2, 点赞/播放 × 300)
score = 5.2 + reach + save + like
```

```bash
node scripts/huangguo-import.mjs --score-only --limit 5 --dry
node scripts/huangguo-import.mjs --score-only --concurrency 6
```

* 只写 `score`，不动其它字段；已经填过的不会覆盖。
* 实测 1734 部并发 6 用时 114 秒，1734/1734 成功（2026-11-16）。
* 播放量解析支持 `10.1w` / `246.7万` / `3.8k` / `1.2亿`（`parseCount()`），折算函数 `scoreOf()`。
* 顺带说明：`viewsNum` 原来恒为 0（源站 JSON 里没有这个字段），现在改为从 `data.views` 解析。