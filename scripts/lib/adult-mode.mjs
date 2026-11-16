/**
 * 成人片访问模式的**唯一来源**。
 *
 * 事故背景：默认值曾经同时写在 deploy/sync-adult.cmd、deploy/sync-adult.sh、
 * scripts/adult-migrate.mjs 三处，改一处漏两处就会出现「同步脚本传 subscription、
 * migrate 默认又是 free」的自我矛盾。现在只认这里，其它地方引用常量。
 *
 * 覆盖优先级：命令行 --mode > 环境变量 MH_ADULT_MODE > ADULT_MODE_DEFAULT。
 */

export const ADULT_MODES = ['free', 'subscription', 'paid']

/** 默认：订阅制（与 docs/JABLE-IMPORT.md 的声明一致）。 */
export const ADULT_MODE_DEFAULT = 'subscription'

/** 每种模式写入 content_policies 的默认值。 */
export const ADULT_MODE_POLICIES = {
  free: { access_mode: 'free', trial_seconds: 0, price_cents: 0 },
  subscription: { access_mode: 'subscription', trial_seconds: 0, price_cents: 0 },
  paid: { access_mode: 'paid', trial_seconds: 0, price_cents: 0 },
}

/**
 * 解析最终模式。
 * @param {{ flag?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {{ ok: true, mode: string, source: 'flag' | 'env' | 'default' } | { ok: false, message: string }}
 */
export function resolveAdultMode({ flag = '', env = process.env } = {}) {
  const fromFlag = String(flag ?? '').trim()
  if (fromFlag) {
    if (!ADULT_MODES.includes(fromFlag)) return { ok: false, message: `--mode 只支持 ${ADULT_MODES.join(' / ')}` }
    return { ok: true, mode: fromFlag, source: 'flag' }
  }
  const fromEnv = String(env.MH_ADULT_MODE ?? '').trim()
  if (fromEnv) {
    if (!ADULT_MODES.includes(fromEnv)) return { ok: false, message: `MH_ADULT_MODE 只支持 ${ADULT_MODES.join(' / ')}` }
    return { ok: true, mode: fromEnv, source: 'env' }
  }
  return { ok: true, mode: ADULT_MODE_DEFAULT, source: 'default' }
}

/** 供 usage 文案复用，避免帮助信息里再写一份字面量。 */
export const ADULT_MODE_USAGE = `${ADULT_MODES.join('|')}（默认 ${ADULT_MODE_DEFAULT}，可用 MH_ADULT_MODE 覆盖）`
