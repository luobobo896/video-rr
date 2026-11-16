#!/usr/bin/env node
/**
 * 成人频道播放模式的命令行入口，给 shell / .cmd 部署脚本用。
 *
 * 背景：默认值曾经在 deploy/sync-adult.cmd、deploy/sync-adult.sh、scripts/adult-migrate.mjs
 * 三处各写一份字面量。现在只认 scripts/lib/adult-mode.mjs，部署脚本从这里取值并校验。
 *
 *   node scripts/adult-mode.mjs --print-default      # subscription
 *   node scripts/adult-mode.mjs --validate paid      # 合法：exit 0
 *   node scripts/adult-mode.mjs --validate whatever  # 非法：exit 2
 *   node scripts/adult-mode.mjs --resolve --mode subscription --env MH_ADULT_MODE=paid
 */
import { ADULT_MODES, ADULT_MODE_DEFAULT, ADULT_MODE_USAGE, resolveAdultMode } from './lib/adult-mode.mjs'

const argv = process.argv.slice(2)

function valueAfter(flag) {
  const index = argv.indexOf(flag)
  if (index < 0) return null
  return String(argv[index + 1] ?? '')
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`用法：
  node scripts/adult-mode.mjs --print-default
  node scripts/adult-mode.mjs --validate <mode>
  node scripts/adult-mode.mjs --resolve [--mode <mode>]
模式：${ADULT_MODE_USAGE}`)
} else if (argv.includes('--print-default')) {
  console.log(ADULT_MODE_DEFAULT)
} else if (argv.includes('--validate')) {
  const value = valueAfter('--validate')
  if (!value || !ADULT_MODES.includes(value)) {
    console.error(`非法的成人频道模式：${value === null ? '(未提供)' : value || '(空)'}；可选 ${ADULT_MODE_USAGE}`)
    process.exit(2)
  }
} else if (argv.includes('--resolve')) {
  const result = resolveAdultMode({ flag: valueAfter('--mode') ?? '', env: process.env })
  if (!result.ok) {
    console.error(result.message)
    process.exit(2)
  }
  console.log(result.mode)
} else {
  console.log(ADULT_MODE_DEFAULT)
}
