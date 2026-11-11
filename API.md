# 原站接口契约（复刻依据）

> 来源：`https://mh.yichengwlkj.com/pc?channel=CHANNEL_INDEX` 的公开前端 bundle 静态分析 + 真实流量抓取。
> 客户端：Next.js App Router（`cdn.yichengwlkj.com/c-next/mapp/1.10.38/...`），接阿里云 API 网关风格签名 + 响应体 AES 加密。

## 1. 主机

| 用途 | 地址 |
|---|---|
| 业务 API | `https://api.yichengwlkj.com` |
| 静态/CDN | `https://cdn.yichengwlkj.com` |
| 图片 | `http://img.bwcgee.cn` |
| 弹幕 | `https://static-dm.yichengwlkj.com/v1/produce/danmu/EPISODE` |
| 埋点采集 | `https://collect-h5.yichengwlkj.com`（`/data/upload`） |
| VIP H5 | `https://mobile.yichengwlkj.com/h5` |
| ARMS 监控 | `https://arms-retcode.aliyuncs.com` |

## 2. 统一响应包

```json
{ "requestId": "76c906b3c9d54dd1837f6ab451545050", "code": "0000", "msg": "Success", "recordsTotal": null, "data": { } }
```

- `code = "0000"` 成功；`"0001"` 常见于「客户端版本过低」（缺签名/版本头时）。
- **响应体是加密的**：网络层拿到的是 Base64 字符串，前端用 AES-ECB/PKCS7 解出上面的 JSON（bundle 内 `L(e,t)` 辅助函数）。本次复刻没有硬编码密钥，而是用 `JSON.parse` 钩子把**解密后的报文**抓下来做数据契约。

## 3. 请求签名（x-ca-sign）

必须的请求头（大小写不敏感）：

```
aliId / umid / deviceId : 设备唯一 ID（首次访问生成 UUID，落 localStorage）
ct / clientType         : web_pc
cv / clientVersion      : 1.0.0
t                       : 毫秒时间戳
uet                     : "9"
token                   : 登录态（未登录传空串）
x-ca-sign               : 签名，见下
```

签名串（`\n` 分隔，参数按 key 排序后拼 query）：

```
{METHOD大写}
aliId:{aliId}
ct:{ct}
cv:{cv}
t:{t}
{url}{?query 已按 key 排序}
```

`x-ca-sign = Base64( HMAC-SHA256(签名串, SECRET) )`，`SECRET` 在 bundle 中可见（复刻站点不需要它，除非你要直连原站）。

## 4. 关键接口

### 首页
| 方法 | 路径 | 参数 | data 形状 |
|---|---|---|---|
| GET | `/m-station/app/page` | `position=CHANNEL_INDEX&pageNum=1&personalRecommend=0` | `{total,currentPage,isEnd,end,content:[{recommendContent:{...}}]}` |
| GET | `/m-station/top/home` | — | `{bannerTop:[{bannerId,name,title,imgUrl,webImgUrl,targetUrl,type,sequence}], ...}` |
| GET | `/m-station/app/category` | — | 频道分类树 |
| GET | `/constant/get/all` | — | 站点常量（下载地址、开关、文案） |
| GET | `/app/index/popup` | — | 首页弹窗配置 |

`recommendContent` 字段（海报卡）：`dramaId,title,subTitle,coverUrl,dramaType,score,feeMode,itemType,topInfoTag,specialLabelList,normalLabelList,favorite`。

### 详情 / 播放
| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/m-station/drama/intro` | `seasonId` |
| GET | `/m-station/drama/play` | `seasonId,episodeNo` |
| GET | `/m-station/drama/secondary` | `seasonId` |
| GET | `/m-station/drama/recommend` | `seasonId` |

`intro` 的 data：`dramaId,intro,title,subTitle,year,area,plotType,author,actorList`；
`play` 的 data：`authorityInfo,watchInfo,dramaInfo,episodeList,trailerList,sortedItems,newSign,dmSign,privilege`。

### 榜单
| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/m-station/top/drama/list` | `containerId,topId,pageNum,pageSize` |

`containerList`：`[{id,name,topList:[{id,name,type(HOT/SEARCH/RISE/CLASSIC),showRules}]}]`。

### 搜索
| 方法 | 路径 | 参数 |
|---|---|---|
| GET | `/m-station/search/drama` | `keyword,pageNum,pageSize` |
| GET | `/m-station/search/lenovo` | `keyword`（联想） |
| GET | `/m-station/top/hot/search` | —（热搜词） |
| GET | `/search/comprehensive/precise-mixed` | 综合搜索 |

### 用户
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/m-station/user/send/code` | 发验证码 |
| POST | `/m-station/user/login` | 登录（返回 token） |
| GET | `/m-station/user/profile` | 资料（昵称/头像/VIP 到期） |
| GET | `/m-station/user/history` | 观看历史 |
| POST | `/user/history/save` | 上报进度（`seasonId,episodeId,episode,seekToPosition,totalLen`） |
| GET | `/m-station/user/message` / `/count` / `/read` | 消息中心 |
| POST | `/m-station/user/logout` | 退出 |

### 行为 / 互动
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/m-station/behavior/add` / `/delete` | 收藏/追剧 |
| POST | `/m-station/behavior/like/add` / `/cancel` | 点赞 |
| GET | `/m-station/drama/comment/list` | 评论列表 |
| POST | `/m-station/comment/create` / `/delete` | 发/删评论 |
| GET | `/m-station/danmu/list`、POST `/m-station/danmu/save` | 弹幕 |

### 商业化
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/vip/banner/content/list/channel` | VIP 页物料 |
| POST | `/m-station/create_common_purchase_h5` | 下单，返回收银台 URL |
| GET | `/m-station/selling/pay/polling` | 支付结果轮询 |
| GET | `/m-station/activity/fission/*` | 裂变拉新（领 VIP/红包） |

## 5. 复刻站怎么对应

`mh-clone/server.mjs` 实现了同形状的简化接口（明文 JSON，方便本地开发）：

| 原站 | 复刻站 | 数据来源 |
|---|---|---|
| `/m-station/app/page` + `/top/home` | `/api/home` | `data/seed.json` 的 banners/sections |
| `/m-station/drama/intro` | `/api/drama/:id` | seed.detail + 补足 24 集 |
| `/m-station/top/drama/list` | `/api/rank` | seed 池 |
| `/m-station/search/drama` | `/api/search?keyword=` | seed 池过滤 |
| `/m-station/user/history` | `/api/me` + `POST /api/me/history` | 内存 |
| `/m-station/behavior/add` | `POST /api/me/favorite` | 内存 |

上线时把 `server.mjs` 的 `/api/*` 换成真实实现，并恢复「AES 加密响应 + x-ca-sign 校验」，前端 `public/app.js` 只需改 `api()` 一处解密逻辑。

## 6. 增长域接口（实现版）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/attribution/touch` | `{visitorId,promoCode,referralCode,landingPath,referrer,utm}`；按推广码 → 域名 → direct 记录触达和归因快照 |
| POST | `/api/content/click` | `{contentId,episodeId,entryPage,sourceModule,position,requestId}`；30 分钟桶去重 |
| GET | `/api/content/rank?type=hot|favorite|completion|new|recommend&contentType=` | 内容统计榜快照 |
| GET | `/api/play/:id/:no` | 播放成功时增加 `viewSessionId`、心跳间隔和有效观看阈值 |
| POST | `/api/play/session/:id/heartbeat` | `{positionSeconds,durationSeconds,playing,visible,playbackRate}`；累计有效观看 |
| GET | `/api/distribution/me` | 登录用户查看推广码、推广数据、分层佣金；C 端文案为“佣金推广” |
| POST | `/api/distribution/apply` | 申请开通佣金推广；默认站点自动通过，写入 `distributor_profiles` |
| GET | `/i/:code` | 推广落地页，记录点击、写 `mh_ref` Cookie 并跳转 `/?ref=CODE` |

渠道归因字段落在 `orders` 的 `acquisition_*`、`promo_code`、`domain_source`、`first_enter_at`、`attributed_at` 等列；内容统计落在 `content_*` 表；分销落在 `distribution_*`、`commission_*` 表。完整 Schema 见 `docs/database/GROWTH-SCHEMA.sql`。
