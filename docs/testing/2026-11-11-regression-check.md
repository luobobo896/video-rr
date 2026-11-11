# 旧修复回退排查（2026-11-11）

## 现象

重新部署后，之前已完成的中英切换、英文手机底栏、头像即时刷新、后台用户序号列和推广海报二维码看起来消失。

## 结论

**当前工作区源码没有回退。** 回退发生在发布物：根目录 `mh-deploy-20261111-025142.tgz` 是 02:51 生成的旧快照，生成时间早于后续修复，且没有 Vue/Vite 文件。

## 证据

- 当前源码包含：
  - `public/app.js` 的 `downloadDistributionPoster()`、`drawQrCode()` 和海报二维码调用；
  - 头像上传成功后的 `#me-avatar` 即时替换；
  - `admin/app.js` 的独立「序号」表头；
  - `public/app.js` 的 `data-lang-choice` 和移动底栏短标签；
  - `public/main.js`、`admin/main.js` 以及两份 `LegacyHost.vue`。
- 旧 tgz：
  - `public/app.js` 没有 `drawQrCode`、`data-lang-choice` 或 `mobileNavLabel`；
  - `admin/app.js` 没有独立的 `<th>序号</th>`；
  - 不包含 `main.js`、`LegacyHost.vue`、`package-lock.json`、Vite 配置或 `dist/`；
  - 与当前文件的 SHA256 全部不同。
- 旧 `deploy/install-hk.sh` 只重启 Node 服务，不执行 `npm ci` 或 `npm run build`，因此即使换了源码也可能继续提供旧构建。

## 本次加固

- `deploy/install-hk.sh` 在重启前执行 `npm ci --include=dev` 和 `npm run build`；
- 构建产物缺失时直接失败，不重启服务；
- 上线后检查 `/` 和 `/admin/` 返回的 HTML 必须包含 Vue 挂载点；
- 新增 `npm run pack:deploy`，打包前构建、打包后校验必要文件，并禁止包含 `node_modules/`、`storage/`、`dist/`、`.env`；
- 前后端静态检查覆盖两个 `main.js` 和两个 `base.js`。

## 验证

- `npm run check`：通过。
- `npm test`：133 通过，0 失败。
- `npm run build`：C 端和后台均构建成功。
- 构建版 320×700 英文首页：底栏为 `Home / Browse / Wall / Ranks / Me`，5 项无重叠，`scrollWidth=320`，搜索框宽 232px。
- 构建版 390×844 后台用户页：表头顺序为 `序号 / 账号 / 显示名 / 角色 / 状态 / 口令 / 最近操作 / 操作`，`scrollWidth=390`。
