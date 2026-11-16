/**
 * 远端命令拼装：`MODE`、`TRIAL`、`REMOTE_APP` 这些变量最终会进远端 shell，
 * 直接插值等于把本地环境变量当远端命令执行。这里统一「白名单 + 单引号转义」。
 */

/** POSIX 单引号转义：' → '\'' ，其余原样包进单引号。 */
export function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`
}

/**
 * 白名单校验。不匹配就抛出，宁可让同步脚本当场失败，也不要把脏值送进远端 shell。
 * @param {string} name 变量名（用于报错）
 * @param {string} value
 * @param {RegExp} [pattern]
 */
export function assertSafeToken(name, value, pattern = /^[A-Za-z0-9._@:/+-]+$/) {
  const text = String(value ?? '')
  if (!text || !pattern.test(text)) {
    throw new Error(`${name} 含有不允许的字符，已拒绝执行：${JSON.stringify(text)}`)
  }
  return text
}

/**
 * 把「KEY=value」形式的远端环境变量前缀拼好（键走白名单，值一律单引号）。
 * @param {Record<string, string>} vars
 */
export function remoteEnvPrefix(vars) {
  return Object.entries(vars)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => `${assertSafeToken('变量名', key, /^[A-Z_][A-Z0-9_]*$/).replace(/=/g, '')}=${shellQuote(value)}`)
    .join(' ')
}
