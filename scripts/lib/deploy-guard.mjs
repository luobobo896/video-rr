/**
 * 打包守卫：判断某个路径是否属于「绝不能进部署包」的东西。
 *
 * 事故背景：旧实现只比对顶层字符串（`entries.some((e) => e === '.env')`），
 * 于是 `server/.env`、`deploy/.env.production`、`public/.env.local` 全部漏过，
 * 密钥跟着 tar 包上了服务器。
 */

const FORBIDDEN_DIRS = new Set(['node_modules', 'storage', 'dist', 'dist-old'])

/** 任一路径段是 `.env` 或以 `.env.` 开头就算敏感（含 `.env.local`、`.env.production`）。 */
export function isForbiddenEnvName(segment) {
  const name = String(segment ?? '')
  return name === '.env' || name.startsWith('.env.')
}

/**
 * @param {string} entry 相对路径（`/` 分隔）
 */
export function isForbiddenEntry(entry) {
  const normalized = String(entry ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) return false
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length) return false
  for (const segment of segments) {
    if (isForbiddenEnvName(segment)) return true
    // 目录段（含最外层）命中黑名单即拒绝；最后一层是文件名，只看 .env 规则。
    if (FORBIDDEN_DIRS.has(segment)) return true
  }
  return false
}

/** 给报错信息用：把命中的条目列出来。 */
export function forbiddenEntries(entries) {
  return [...entries].filter((entry) => isForbiddenEntry(entry)).sort()
}
