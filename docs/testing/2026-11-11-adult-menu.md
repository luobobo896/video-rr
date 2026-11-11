# 成人菜单与影剧导入验收

## 自动化

| 命令 | 结果 |
|---|---|
| `npm test` | 151/151 通过 |
| `npm run check` | token 与前端语法检查通过 |
| `npm run build` | C 端和后台生产构建通过 |

新增回归覆盖：

- 成人菜单配置独立保存，中英文标签写入 `/api/constants`。
- 普通分类、搜索和标签计数排除成人内容；成人分类只返回 `is_adult=1`。
- 首页楼层与定向横幅、榜单、相似推荐和海报墙均排除成人内容。
- 用户历史与收藏保留成人记录。
- URL 导入拒绝私网、回环、非 HTTP(S) 和带凭据地址。
- 成人菜单拒绝非布尔 `enabled`、空标签和超过 20 字的标签。

## 浏览器

使用 ego-browser 在同一 TaskSpace 验证：

- 后台“成人菜单”独立页面正常渲染，中文“成人”、英文“Adult”默认配置可保存。
- 将标签改为“18+ / Adults”后，C 端桌面侧栏立即显示 `Adults`，移动端底栏显示 `18+`；随后已恢复默认值。
- 390×844 下移动底栏为 6 项，CSS 网格为 6 列，无横向溢出。
- 英文年龄门显示 “Are you 18 or older?”；确认后进入成人列表，本会话内不再重复弹出。
- 直接访问成人 URL 时弹出年龄门；取消后回到首页。
- 成人列表标题和标签使用后台配置，列表仅显示 `成人回归预览片`。
- 后台剧集 #34 的“成人内容”复选框为已勾选。
- 分集页存在“URL 导入”按钮；私网 URL 返回“不允许导入本机或内网地址”。
- 后台当前路由高亮仅“剧集管理”，未误选中成人菜单。

截图证据：

- `C:/Users/hanson/.codex/ego/adult-menu-qa-20261111-1900/admin-adult-settings.png`
- `C:/Users/hanson/.codex/ego/adult-menu-qa-20261111-1900/admin-drama-adult-flag.png`
- `C:/Users/hanson/.codex/ego/adult-menu-qa-20261111-1900/admin-url-import-error.png`
- `C:/Users/hanson/.codex/ego/adult-menu-qa-20261111-1900/c-end-age-gate-adults.png`
- `C:/Users/hanson/.codex/ego/adult-menu-qa-20261111-1900/c-end-mobile-six-tabs.png`
- `C:/Users/hanson/.codex/ego/adult-menu-qa-20261111-1900/c-end-adult-list.png`

## URL 导入实测

使用公开样例：

`https://download.samplelib.com/mp4/sample-5s.mp4`

结果：

- 下载并探测成功：`duration=5.758549`、`1920x1080`、`h264`。
- 入队后转码完成，分集 #724 状态为 `ready`、进度 100%。
- HLS 路径：`/media/hls/724/index.m3u8`。
- 复测不存在的远端视频时返回 `0502`，不再落成通用 `0500`。

## 边界

- 年龄门是会话级前端确认，不是身份/KYC 验证。
- URL 导入当前为同步下载；本次未做大文件、慢链路和断点续传压测。
- 本机透明公网出口使用 `198.18.0.0/15`，因此该测试网段不按私网拦截；其余私网、回环、链路本地、CGNAT、组播地址仍拒绝。

## 评审修复复验

- SQL 脚本已明确为一次性人工迁移，实际启动由 `ensureOpsSchema()` 查列后幂等执行。
- URL 导入的 413/502/504 分别映射为 `0413/0502/0504`，下载流异常改为可读提示。
- 成人菜单保存严格校验 `enabled` 布尔类型及中英文 1–20 字标签。
- 成人可见性 SQL 收敛到 `server/content-visibility.mjs`，减少五处重复谓词。
- 年龄门按钮桌面 40px、移动端 48px，符合 `DESIGN.md` 的控件刻度。
- URL 导入改为单一 15 分钟总时限，重定向不再重复续期。
