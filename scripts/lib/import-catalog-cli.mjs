/**
 * import-catalog 的参数规划（纯函数，先算清楚再决定要不要连库）。
 *
 * 事故背景：`node scripts/import-catalog.mjs` 不带任何参数时走的是
 * `resetDemo()` —— DELETE 30 张表 + rmSync storage/{hls,uploads,images}。
 * 谁在 repo 根随手敲一下，整站内容和转码产物就没了。现在：
 *   - 无参数 = 只打印帮助，exit 0；
 *   - resetDemo 只在显式 `--reset` 且（`--yes` 或 `MH_CONFIRM_RESET=1`）时执行；
 *   - 库不是 <repo>/storage/app.db 时还要环境变量 + `--yes` 双重确认；
 *   - `--dry` 只打印将要执行的语句，绝不写盘。
 */
import { confirmGate } from './confirm.mjs'

export const HELP_TEXT = `用法：node scripts/import-catalog.mjs <命令> [选项]

命令（必须显式给出，不带参数只打印本帮助）：
  --list              列出目录清单，不写库
  --check             校验库内数据与 media 文件是否对得上
  --build             按 data/catalog.json 构建/更新条目（会下载素材并转码）
  --reset             清空演示数据与 storage/{hls,uploads,images}（破坏性，需确认）

选项：
  --only <id>         只处理指定条目（可重复）
  --force             已存在也重新下载/转码
  --keep              保留已有 media 文件
  --dry               只打印将要做的事，不写库、不删文件、不建目录
  --yes               破坏性操作的确认开关（等同 MH_CONFIRM_RESET=1）

注意：--reset 的目标库不是 <仓库根>/storage/app.db 时，需要 --yes 并且 MH_CONFIRM_RESET=1
      双重确认，运行前会把目标库绝对路径打印出来。
`

const KNOWN_FLAGS = new Set([
  '--list', '--check', '--build', '--reset', '--only', '--force', '--keep', '--dry', '--yes',
])

/**
 * @param {string[]} argv 不含 node/脚本名
 * @param {{ env?: Record<string, string | undefined>, isDefaultDb?: boolean }} [options]
 */
export function planCli(argv = [], { env = process.env, isDefaultDb = true } = {}) {
  const flags = argv.filter((item) => item.startsWith('--')).map((item) => item.split('=')[0])
  const dry = flags.includes('--dry')
  const unknown = flags.filter((flag) => !KNOWN_FLAGS.has(flag))
  const only = onlyList(argv)
  const force = flags.includes('--force')
  const keep = flags.includes('--keep')

  if (!argv.length) return { action: 'help', dry, only, force, keep, unknown }
  if (unknown.length) return { action: 'unknown', dry, only, force, keep, unknown }
  if (flags.includes('--list')) return { action: 'list', dry, only, force, keep, unknown }
  if (flags.includes('--check') && !flags.includes('--build') && !flags.includes('--reset')) {
    return { action: 'check', dry, only, force, keep, unknown }
  }

  const reset = flags.includes('--reset')
  const build = flags.includes('--build')
  if (!reset && !build) return { action: 'help', dry, only, force, keep, unknown }

  const confirm = confirmGate({ args: argv, env, requireBoth: !isDefaultDb })
  const steps = []
  if (reset) steps.push('清空演示数据（DELETE 30 张表）')
  if (reset) steps.push('删除 storage/hls、storage/uploads、storage/images 下的媒体文件')
  if (build) steps.push('按 data/catalog.json 构建（下载素材 + 转码）')
  if (build) steps.push('校验数据与 media')
  return {
    action: reset ? 'reset' : 'build',
    dry,
    only,
    force,
    keep,
    unknown,
    reset,
    build,
    confirm,
    steps,
    requireBoth: !isDefaultDb,
  }
}

/** 取 `--flag value` 或 `--flag=value` 的最后一个值。 */
export function valueOf(argv, flag, fallback = '') {
  const inline = argv.filter((item) => item.startsWith(`${flag}=`)).pop()
  if (inline) return String(inline.slice(flag.length + 1)) || fallback
  const index = argv.lastIndexOf(flag)
  if (index < 0) return fallback
  const next = argv[index + 1]
  return next && !next.startsWith('--') ? String(next) : fallback
}

/** `--only` 可能出现多次，收集全部。 */
export function onlyList(argv) {
  const values = []
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--only') {
      const next = argv[index + 1]
      if (next && !next.startsWith('--')) values.push(String(next))
    } else if (item.startsWith('--only=')) {
      values.push(String(item.slice('--only='.length)))
    }
  }
  return values
}
