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
| GET | `/admin/api/dramas?keyword=` | 列表（含 `episodeCount`） |
| POST | `/admin/api/dramas` | 新建 `{title,subTitle,coverUrl,description,year,area,category,score,feeMode,status}` |
| GET/PUT/DELETE | `/admin/api/dramas/:id` | 详情 / 更新 / 删除（级联分集） |
| GET | `/admin/api/dramas/:id/episodes` | 分集列表（含 `status/progress/hls_path/error`） |
| POST | `/admin/api/dramas/:id/episodes` | 新增分集（自动取下一个集号） |
| DELETE | `/admin/api/episodes/:id` | 删除分集 |
| POST | `/admin/api/episodes/:id/upload` | **原始二进制上传**（`fetch(url,{method:'POST',body:file})`），落盘后自动入转码队列 |
| POST | `/admin/api/episodes/:id/sample` | 用 ffmpeg 生成 N 秒 testsrc 示例并发起转码 `{seconds}` |
| GET | `/admin/api/jobs` | 队列：`{queued,done,failed,pending,running,current,pendingItems}` |

分集状态机：`ready`（无片源或已就绪）→ `queued` → `transcoding`（progress 0-100）→ `ready`（`hls_path` 写库）/ `error`（带 `error` 文本）。

## 首页运营
| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/admin/api/banners` | 列表 / 新建 `{name,title,image,targetDramaId,sort,enabled}` |
| PUT/DELETE | `/admin/api/banners/:id` | 更新（含启停）/ 删除 |
| GET/POST | `/admin/api/sections` | 列表（含 items）/ 新建；`{action:'attach',sectionId,dramaId,sort}` 往楼层挂剧 |
| DELETE | `/admin/api/sections?id=` | 删除楼层 |

## 榜单
| GET/POST | `/admin/api/ranks` | 列表（含 items）/ 新建；`{action:'attach',listId,dramaId,rankNo}` 加榜单项 |

## 审核
| GET | `/admin/api/danmus?status=pending` | 弹幕列表 |
| GET | `/admin/api/comments?status=pending` | 评论列表 |
| POST | `/admin/api/danmus/:id/approve|reject` | 审核弹幕 |
| POST | `/admin/api/comments/:id/approve|reject` | 审核评论 |

## 用户与订单
| GET | `/admin/api/users` | 用户列表（手机号/昵称/VIP/到期） |
| GET | `/admin/api/orders` | 订单列表 + `revenue` |
| POST | `/admin/api/orders` | 新建订单 `{userId,sku,amount}` |
| POST | `/admin/api/orders/:id/pay` | 标记已支付并给用户开 365 天 VIP |

## 直播
| GET | `/admin/api/live` | `{installed,running,pid,rtmpBase,hlsBase,streams,lastError}` |
| POST | `/admin/api/live` | `{action:'start'|'stop'}` 启停 MediaMTX；`{action:'create',name,key}` 建频道；`{action:'delete',id}` 删频道 |

## C 端对应接口
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/home` | Banner + 楼层 + 热搜 |
| GET | `/api/category?type=&page=&pageSize=` | 分类分页 |
| GET | `/api/rank?type=HOT|SEARCH|RISE|CLASSIC` | 榜单 |
| GET | `/api/search?keyword=` | 搜索 |
| GET | `/api/drama/:id` | 详情 + 分集（含 `status/hls`） |
| GET | `/api/play/:id/:no` | 播放信息 `{hls,danmu}`；VIP 集未登录返回 `0401` |
| GET | `/api/live` | 直播频道（`rtmp`/`hls`） |
| POST | `/api/auth/login` | `{phone}` → `{token,user}` |
| GET | `/api/me` | 历史 + 收藏（需用户 token） |
| POST | `/api/me/history` | 上报进度 `{seasonId,episode,position}` |
| POST | `/api/me/favorite` | 收藏切换 `{seasonId}` |
