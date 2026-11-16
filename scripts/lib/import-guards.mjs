/**
 * 导入链路的通用守卫（纯函数，全部有测试）。
 *
 * 三条来自事故的规则：
 *  1. 集号清理必须有下限：导出集数少于库内集数时一律不删（曾经把 40 集的剧
 *     砍成 1 集，用户侧表现是「第 5 集一直转圈」）。
 *  2. LIKE 里的用户/来源数据必须转义 `%` `_`，否则 `100%_爱情` 会匹配到一大片。
 *  3. 退出码要说清「部分失败」和「整轮失败」：0 全好 / 1 部分失败 / 2 全失败。
 */

/** 转义 LIKE 的通配符（配合 SQL 里的 `ESCAPE '\'` 使用）。 */
export function escapeLike(value) {
  return String(value ?? '').replace(/[\\%_]/g, (token) => `\\${token}`)
}

/** `%关键词%` 包头尾通配，内部转义。 */
export function likeContains(value) {
  return `%${escapeLike(value)}%`
}

/** 番号归一化：`ABC_123` 与 `ABC-123` 是同一部，SQL 侧对应 upper(replace(x,'_','-'))。 */
export function normalizeCodeKey(code) {
  return String(code ?? '').trim().toUpperCase().replace(/_/g, '-')
}

/**
 * 解析 `--max-left`（还剩多少分钟就停止抓取）。
 * 语义收紧：必须是正整数分钟；缺省 30；`0` / 负数 / 非数字一律报错。
 * 旧实现 `(Number(v) || 30) * 60` 把 0 悄悄当 30 分钟、负数当成负秒，
 * 结果整轮静默空跑还退 0。
 * @param {string | undefined | null} raw
 * @param {{ fallbackMinutes?: number }} [options]
 * @returns {{ ok: true, minutes: number, seconds: number, defaulted: boolean } | { ok: false, message: string }}
 */
export function parseMaxLeftMinutes(raw, { fallbackMinutes = 30 } = {}) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: true, minutes: fallbackMinutes, seconds: fallbackMinutes * 60, defaulted: true }
  if (!/^\d+$/.test(text)) {
    return { ok: false, message: `--max-left 只接受正整数分钟，收到 ${JSON.stringify(text)}` }
  }
  const minutes = Number(text)
  if (!Number.isSafeInteger(minutes) || minutes <= 0) {
    return { ok: false, message: `--max-left 必须大于 0（单位：分钟），收到 ${JSON.stringify(text)}` }
  }
  return { ok: true, minutes, seconds: minutes * 60, defaulted: false }
}

/**
 * 是否需要清理「源站已经没有的集」。
 * 只有同时满足下面三条才允许：导出集号非空、本剧不是被标题认领来的、导出集数 ≥ 库内集数。
 * @param {{ exportedNos?: number[], dbNos?: number[], claimedByTitle?: boolean }} options
 */
export function shouldPruneEpisodes({ exportedNos = [], dbNos = [], claimedByTitle = false } = {}) {
  const exported = exportedNos.filter((no) => Number.isInteger(no) && no > 0)
  if (!exported.length) return false
  if (claimedByTitle) return false
  return exported.length >= dbNos.length
}

/**
 * 同番号换票：只有「新票比旧票更新鲜」才抄给其它条目。
 * 直链的 EXP 参与签名，抄一张更旧的票等于把能播的条目改成不能播。
 * @param {{ currentExpiry?: number, candidateExpiry?: number }} options
 */
export function shouldAdoptTicket({ currentExpiry = 0, candidateExpiry = 0 } = {}) {
  const current = Number(currentExpiry) || 0
  const candidate = Number(candidateExpiry) || 0
  if (!candidate) return false
  return candidate > current
}

/**
 * 按导入结果算退出码：0 全成功 / 1 部分失败 / 2 全失败（另有 99 = 抢锁失败）。
 * @param {{ ok?: number, failed?: number }} counts
 */
export function exitCodeFor({ ok = 0, failed = 0 } = {}) {
  const good = Number(ok) || 0
  const bad = Number(failed) || 0
  if (bad <= 0) return 0
  if (good > 0) return 1
  return 2
}

/** 汇总行的统一尾注，告诉运维退出码代表什么。 */
export function exitCodeHint(code) {
  if (code === 0) return ''
  if (code === 1) return '（部分失败，退出码 1）'
  return '（整轮失败，退出码 2）'
}
