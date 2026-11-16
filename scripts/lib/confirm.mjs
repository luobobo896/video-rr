/**
 * 破坏性操作的确认门。
 *
 * 事故背景：`node scripts/import-catalog.mjs` 不带参数 = 清空 30 张表 + 删掉
 * storage/{hls,uploads,images}，一次手滑就没了整站内容。现在统一走这里：
 * 必须显式 `--yes` 或 `MH_CONFIRM_RESET=1`，指向非默认库时还要两个都具备。
 */

export const CONFIRM_ENV = 'MH_CONFIRM_RESET'

/** 环境变量里的「是」：1/true/yes/on 都算，其余（含 0/空）都不算。 */
export function isTruthy(value) {
  return /^(1|true|yes|y|on)$/i.test(String(value ?? '').trim())
}

/**
 * 确认门（纯函数，便于测试）。
 * @param {object} options
 * @param {string[]} [options.args] 命令行参数
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.flag] 命令行确认开关
 * @param {string} [options.envName]
 * @param {boolean} [options.requireBoth] 需要「命令行 + 环境变量」双重确认（非默认目标库时）
 * @returns {{ ok: boolean, via: string[], missing: string[] }}
 */
export function confirmGate({
  args = [],
  env = process.env,
  flag = '--yes',
  envName = CONFIRM_ENV,
  requireBoth = false,
} = {}) {
  const via = []
  if (args.includes(flag)) via.push(flag)
  if (isTruthy(env[envName])) via.push(envName)
  const missing = []
  if (!via.includes(flag)) missing.push(flag)
  if (!via.includes(envName)) missing.push(envName)
  const ok = requireBoth ? missing.length === 0 : via.length > 0
  return { ok, via, missing }
}

/**
 * 拒绝时的提示文案：一次说清「要删什么」「怎么确认」。
 * @param {object} options
 * @param {string[]} options.targets 将被删除的绝对路径
 * @param {boolean} [options.requireBoth]
 * @param {string} [options.flag]
 * @param {string} [options.envName]
 */
export function confirmHint({ targets, requireBoth = false, flag = '--yes', envName = CONFIRM_ENV }) {
  const lines = ['拒绝执行：这是不可回滚的破坏性操作，需要显式确认。', '将删除：']
  for (const target of targets) lines.push(`  - ${target}`)
  if (requireBoth) {
    lines.push(`确认方式（目标库不是仓库默认库，需要双重确认）：同时给出 ${flag} 且设置 ${envName}=1`)
  } else {
    lines.push(`确认方式：加 ${flag}，或设置 ${envName}=1`)
  }
  return lines.join('\n')
}
