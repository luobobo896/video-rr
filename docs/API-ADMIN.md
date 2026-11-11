# 后台接口（/admin/api/*）

全部要求请求头 `Authorization: Bearer <admin token>`，登录接口除外。响应统一为 `{requestId, code:"0000", msg, data}`。

## 认证
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/admin/api/login` | `{username,password}` → `{token,expiresAt,mustChangePassword}`。初始口令在部署时随机生成，落在 `storage/admin-initial-passwords.txt`（0600），首次登录 `mustChangePassword=true` |
| GET | `/admin/api/me` | 校验 token |
| POST | `/admin/api/password` | `{oldPassword,newPassword}` 改密（≥12 位、含字母数字、不含用户名、非常见口令、非重复字符；改完清 `must_change_password`，写审计 `admin.password.change`） |
| POST | `/admin/api/users/:id/login-code` | 后台代发 C 端登录码 `{reason}` → `{email,code,expiresIn}`（5 分钟一次性，权限 `user.login.assist`，写审计 `user.login.code.issue`） |
| GET | `/admin/api/security` | 风控概览：`redis`（限流存储）、`loginLock`（5 次失败锁 10 分钟）、`last24h` 拦截分类、`usdtWatch`、`events` |

登录失败 5 次锁 10 分钟（按用户名），返回 `429` + `retry-after`；失败响应带 `attemptsLeft`。口令策略与锁定阈值在 `server/api-admin.mjs`（`checkAdminPassword`）与 `server/ratelimit.mjs`（`LOGIN_MAX_FAILS` / `LOGIN_LOCK_SECONDS`）。

运维重置口令：`node scripts/reset-admin-password.mjs <用户名> [新口令]`（会重新置 `must_change_password=1`）。

## 概览
| GET | `/admin/api/stats` | 剧集/分集/就绪数、待审弹幕与评论、用户数、订单数与收入、转码队列、直播状态 |

## 剧集与分集
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/dramas?page=1&pageSize=20&keyword=&category=&status=` | 分页列表（含 `episodeCount`、`categoryCounts`、`statusCounts`） |
| POST | `/admin/api/dramas` | 新建 `{title,subTitle,coverUrl,description,year,area,category,score,isAdult,releaseDate,status}` |
| GET/PUT/DELETE | `/admin/api/dramas/:id` | 详情 / 更新 / 删除（级联分集） |
| GET | `/admin/api/dramas/:id/episodes` | 分集列表（含 `status/progress/hls_path/error`，过滤 `merged`，返回 `category`） |
| POST | `/admin/api/dramas/:id/episodes` | 新增分集（自动取下一个集号） |
| DELETE | `/admin/api/episodes/:id` | 删除分集 |
| POST | `/admin/api/episodes/:id/upload` | **原始二进制上传**（`fetch(url,{method:'POST',body:file})`），落盘后自动入转码队列 |
| POST | `/admin/api/episodes/:id/import-url` | `{url}` 下载 HTTP(S) 公开视频直链，探测成功并入转码队列；拒绝私网/回环/非 HTTP(S) 地址 |
| POST | `/admin/api/episodes/:id/sample` | 用 ffmpeg 生成 N 秒 testsrc 示例并发起转码 `{seconds}` |
| GET/POST | `/admin/api/episodes/:id/tracks` | 音轨/字幕列表 / 新增 `{kind,language,edition,label,source,uri,isDefault}` |
| PUT/DELETE | `/admin/api/tracks/:id` | 更新 / 删除轨道；删除默认轨道前需先指定新的默认轨道 |
| GET | `/admin/api/jobs` | 队列：`{queued,done,failed,pending,running,current,pendingItems}` |

分集状态机：`ready`（无片源或已就绪）→ `queued` → `transcoding`（progress 0-100）→ `ready`（`hls_path` 写库）/ `error`（带 `error` 文本）。
轨道状态：`ready` / `processing` / `error`；同一分集同类型最多一个默认轨道。

## 首页运营
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/admin/api/banners` | 列表 / 新建 `{name,title,image,targetDramaId,sort,enabled}` |
| PUT/DELETE | `/admin/api/banners/:id` | 更新（含启停）/ 删除 |
| GET/POST | `/admin/api/sections` | 列表（含 items）/ 新建；`{action:'attach',sectionId,dramaId,sort}` 往楼层挂剧 |
| DELETE | `/admin/api/sections?id=` | 删除楼层 |

## 榜单
| GET/POST | `/admin/api/ranks` | 列表（含 items）/ 新建；`{action:'attach',listId,dramaId,rankNo}` 加榜单项 |

## 付费策略与菜单
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/policy-groups` | 可复用策略组列表、分配数量与选项 |
| POST | `/admin/api/policies/bulk` | 兼容旧版的逐剧自定义批量设置；新后台不再调用 |
| POST | `/admin/api/policy-groups` | 新建策略组 |
| PUT/DELETE | `/admin/api/policy-groups/:id` | 编辑/删除策略组；有分配引用时删除返回 409 |
| POST | `/admin/api/policy-groups/:id/assign` | `{dramaIds}` 分配勾选剧集，或 `{filters:{keyword,category,status}}` 按筛选批量分配；支持 `dryRun` |
| PUT | `/admin/api/dramas/:id/policy` | `{policyGroupId}` 单剧改派策略组；传自定义字段时兼容旧版 |
| POST | `/admin/api/users/:id/password` | `{mode:'set'|'reset',password?,reason?}`；reset 生成临时密码并发邮件 |
| POST | `/admin/api/email-template/preview` | 返回验证码邮件 HTML/纯文本预览 |
| PUT | `/admin/api/admin-menu-groups/:key` | 修改菜单分组名称/键/排序，并同步全部子菜单 |
| GET | `/admin/api/admin-menus` | 分组树与可选权限码 |
| GET | `/admin/api/roles` | 角色列表、成员统计与权限目录 |
| POST | `/admin/api/roles` | 新建角色 `{code,name,description}` |
| PUT | `/admin/api/roles/:id` | 修改角色名称/说明；传 `permissions` 时兼容旧版权限覆盖 |
| DELETE | `/admin/api/roles/:id` | 删除未分配给账号的自定义角色；内置角色和在用角色返回 400/409 |
| GET/PUT | `/admin/api/roles/:id/menus` | 查询/保存角色权限树勾选 |

## 成人菜单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/adult-menu` | 返回 `{enabled,labelZh,labelEn}`，默认 `true/成人/Adult` |
| PUT | `/admin/api/adult-menu` | 保存同一结构；`enabled` 必须是布尔值，中英文标签去空白后各 1–20 字；写审计 `content.adultMenu.update` |
| GET | `/admin/api/adult-stats` | 成人内容统计：发行日期、最近更新、收藏、今日/本周/本月/总浏览 |

权限统一使用 `content.drama.write`。剧集创建、更新、详情和列表使用布尔字段 `isAdult`；数据库列为 `dramas.is_adult`。
剧集支持 `releaseDate`（`YYYY-MM-DD`）和只读 `updatedAt`；成人浏览统计取 `play_events`。

`GET /admin/api/tags?scope=general|adult|all` 按标签域查询；成人标签使用独立两级分组，保存时 `scope` 不可跨域修改。

## 审核
| GET | `/admin/api/danmus?status=pending` | 弹幕列表 |
| GET | `/admin/api/comments?status=pending` | 评论列表 |
| POST | `/admin/api/danmus/:id/approve|reject` | 审核弹幕 |
| POST | `/admin/api/comments/:id/approve|reject` | 审核评论 |

## 用户与订单
| GET | `/admin/api/users?page=1&pageSize=20` | 用户分页（邮箱/昵称/VIP/到期），返回 `{list,page,pageSize,total}` |
| GET | `/admin/api/orders?page=1&pageSize=20&status=` | 订单分页，返回 `{list,page,pageSize,total}` |
| POST | `/admin/api/orders` | 新建订单 `{userId,sku,amount}` |
| POST | `/admin/api/orders/:id/pay` | 标记已支付并给用户开 365 天 VIP |

## 审计
| GET | `/admin/api/audit?page=1&pageSize=20&action=` | 审计分页，返回 `{list,page,pageSize,total}` |

## 经营数据与埋点
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/analytics?days=7` | 播放、用户、收入、订阅、内容、访客、逐级转化漏斗及日趋势。`conversion[]` 的 `rate` 以相邻阶段为分母 |
| GET | `/admin/api/events?days=7&type=&page=1&pageSize=20` | 埋点明细分页；返回 `{total,page,pageSize,visitors,byType,byDay,list}` |

`POST /api/track` 只接受白名单事件：`session_start`、`page_view`、`impression`、`detail_view`、`episode_click`、`play_start`、`play_end`、`play_error`、`paywall_view`、`paywall_click`、`login_open`、`login_success`、`favorite`、`search`、`share`、`category_filter`、`rank_view`、`track_change`、`lp_view`、`lp_cta_click`、`trial_start`、`trial_end`、`order_created`、`payment_success`。C 端通过 `x-mh-visitor` 请求头和请求体 `visitorId` 上报匿名访客，订单落库时保存同一 `visitor_id`。

## 直播
| GET | `/admin/api/live` | `{installed,running,pid,rtmpBase,hlsBase,streams,lastError}` |
| POST | `/admin/api/live` | `{action:'start'|'stop'}` 启停 MediaMTX；`{action:'create',name,key}` 建频道；`{action:'delete',id}` 删频道 |

## C 端对应接口
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/home` | Banner + 楼层 + 热搜 |
| GET | `/api/category?type=&page=&pageSize=&audience=adult` | 分类分页；默认只返回普通内容，`audience=adult` 只返回成人内容并附 `stats` |
| GET | `/api/rank?type=HOT|SEARCH|RISE|CLASSIC` | 榜单 |
| GET | `/api/search?keyword=&tag=` | 搜索标题、副标题、简介、地区、标签名和内容类型；可与标签 ID 叠加 |
| GET | `/api/plans` | 会员套餐公开价格；落地页未登录也可读取 |
| GET | `/api/drama/:id` | 详情 + 分集（含 `status/hls/isAdult/releaseDate/updatedAt/stats`） |
| GET | `/api/tags?scope=adult` | 成人标签列表（含分组父级、排序和成人内容计数） |
| GET | `/api/play/:id/:no` | 播放信息 `{hls,danmu,audioTracks,subtitleTracks,preferredAudio,preferredSubtitle}`；`?trial=1` 允许游客试看，其他情况未登录返回 `0401` |
| GET | `/api/live` | 直播频道（`rtmp`/`hls`） |
| POST | `/api/auth/login` | `{phone}` → `{token,user}` |
| GET | `/api/me` | 历史 + 收藏（需用户 token） |
| GET/PUT | `/api/me/track-preferences?dramaId=` | 登录用户音轨/字幕偏好；PUT `{dramaId,kind,language,edition}` 或字幕 `{dramaId,kind:'subtitle',off:true}` |
| POST | `/api/me/history` | 上报进度 `{seasonId,episode,position}` |
| POST | `/api/me/favorite` | 收藏切换 `{seasonId}` |

## 增长域后台接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/api/channels` | 渠道、域名、推广码列表 |
| GET | `/admin/api/channels/analytics?days=7` | 按渠道统计访客、注册、下单、支付、退款和访客到支付率 |
| GET/POST | `/admin/api/attribution/config` | 查看/切换首次归因或末次归因及归因窗口 |
| POST | `/admin/api/channels` | `{action:'channel'|'domain'|'promo',...}` 新增/更新渠道配置 |
| GET | `/admin/api/content-stats?days=7&contentType=&category=&contentId=` | 点击、有效观看、观看人数、完播率、收藏和互动率 |
| GET | `/admin/api/content-ranks?type=hot&contentType=all` | 内容榜快照 |
| POST | `/admin/api/content-stats/refresh` | 重算内容日聚合、总量和五类榜单（需 `growth.content.write`） |
| GET/POST | `/admin/api/distribution/config` | 分销启停、级数、总比例上限、冻结期、最低结算、自动审核、归因窗口 |
| GET/POST | `/admin/api/distribution/rules` | 逐级佣金规则 |
| GET | `/admin/api/distribution/overview?days=30` | 直邀、团队、佣金和可结算汇总 |
| GET | `/admin/api/distribution/relations?page=1&pageSize=20` | 团队关系与风险状态，返回服务端分页 |
| GET | `/admin/api/distribution/tree?rootUserId=&maxDepth=` | 团队树 |
| GET | `/admin/api/distribution/commissions?page=1&pageSize=20` | 分层佣金明细，返回服务端分页 |
| GET/POST | `/admin/api/distribution/settlements?page=1&pageSize=20` | 查询（服务端分页）/创建结算单 |
| GET | `/admin/api/distribution/withdrawals?page=1&pageSize=20` | 提现申请分页；响应含 `total` 和状态汇总 |
| POST | `/admin/api/distribution/settlements/:id/approve|pay|reject` | 结算复核、打款、驳回；创建人与复核人不能相同 |
| POST | `/admin/api/distribution/relations/:id/risk` | 冻结/解冻/阻断推广关系 |
| POST | `/admin/api/distribution/distributors/:id/status` | 启用、待审或停用推广员 |
| POST | `/admin/api/distribution/availability/run` | 手动把到期冻结佣金转为可结算 |

新增权限：`growth.channel.read/write`、`growth.content.read/write`、`growth.distribution.read/write/settle/risk`。C 端“佣金推广”与后台“分销佣金”使用同一数据域，不建立第二套模型。
