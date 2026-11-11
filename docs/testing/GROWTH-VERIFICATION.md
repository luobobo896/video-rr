# 增长域开发验证记录

日期：2026-11-11

## 自动化测试

```bash
npm test
```

结果：119 项全部通过，包含既有权益/订单/支付/邮件/RBAC/埋点测试，以及归因、内容统计、多级分销、退款冲回、负余额抵扣、双人结算、提现方式编码和分销菜单权限测试。

## HTTP 冒烟

临时服务验证以下链路均返回 `0000`：

- 后台登录、首次改密、渠道/域名创建、渠道分析。
- 匿名归因触达，返回 `matchRule=domain`。
- 邮箱验证码登录，`created=true`、`acquisitionBonded=true`。
- 佣金推广申请、推广码生成、内容点击、内容榜读取。
- 后台内容统计、内容榜、分销配置、规则、概览、关系、佣金、结算、团队树、佣金转可用。
- 分销配置保存自动审核、归因窗口和启停状态后，重新读取配置值一致。

## 浏览器验证

Codex 内置浏览器实际访问隔离临时服务：

- 桌面导航出现“佣金推广”，不再出现“分销中心”。
- `#/promotion` 页面标题为“佣金推广”，显示推广码、复制推广链接、保存推广海报、推广数据、佣金和推广层级。
- 自动通过后提示“佣金推广已开通”，空态显示“暂无推广数据”。
- `#/content-rank` 显示热播/收藏/完播/新片/推荐榜和内容指标。
- 后台「交易与财务」分组包含「分销分析」和「分销配置」；`#/distribution-config` 可保存启停、审核方式、归因窗口、级数、冻结期和最低结算。
- 后台「分销分析」不再因提现配置变量缺失而整页报错；提现方式表显示 `cny_bank`、`usd_bank`、`usdt_trc20`，可正常编辑。
- 后台「经营数据」右上角出现「分销分析」「分销配置」快捷入口；「渠道分析」「内容统计」页面可正常打开。
- 页面 Console 无 error/warn 日志。

## 2026-11-11 补丁验证

- 修复分销分析页引用未加载 `payoutConfig` 导致整页渲染失败。
- 修复提现方式编码被强制转大写后查不到 `cny_bank` 的问题；编辑提现方式按原记录更新，不再新增重复编码。
- 修复新库种子内容 `content_type` 为空导致内容统计榜无法生成的问题；种子与目录导入分别写入 `content_type`、`published_at`。
- 增长域角色同步版本升到 `2`，老库升级时会为财务角色补 `growth.distribution.write` 和分销配置菜单。

## 2026-11-11 HK 发布验证

- 发布对象：`https://hk.hsddns.com/video/`、`https://hk.hsddns.com/video-admin/`。
- 发布方式：源码包覆盖 `/opt/video-rr`，执行 `bash deploy/install-hk.sh` 完成数据库备份、服务重启、nginx 配置更新和健康检查。
- 发布前源码备份：`/opt/video-rr/storage/backup/source-20261111-0251.tar.gz`。
- 数据库备份：`/opt/video-rr/storage/backup/app.db.20261111-025213`。
- 发布后服务：`video-rr` 处于 active，`NRestarts=0`；C 端首页、后台首页、公开接口均返回 200，未签名 HLS 返回 403。
- 线上只读验收：`READONLY=1 bash deploy/verify-hk.sh` 通过 21 项，失败 0 项。
- 生产登录核验：admin 为 `super_admin`，菜单返回“分销分析 / 分销配置”，分销权限完整；配置接口返回 `status=active`、`max_enabled_level=3`、`freeze_days=7`。
- 生产库核验：`growth.roleSyncVersion=2`，内容类型回填为 `comic_drama=7 / movie=3 / series=9`，提现方式为 `cny_bank / usd_bank / usdt_trc20`。
- 待运营配置：`commission_rules` 当前为 0 条；在后台“交易与财务 → 分销配置”新增逐级佣金规则前，付费订单不会生成佣金。

## 未通过项

`python C:\Users\hanson\.config\ai-rules\bin\fe_lint.py public\index.html` 和 `admin\index.html` 仍报告项目存量样式层的字号档位、断点数量、硬编码颜色和部分控件高度问题。本次新增页面复用现有 `panel`、`table`、`card`、`me-card` 和设计 token，没有新增独立 CSS 或第二套组件。`npx @google/design.md lint DESIGN.md` 在本地 npx 拉取阶段长时间无输出，已中止，未取得 lint 结果。
