/**
 * 成人频道门禁状态判定（纯函数，便于回归测试）。
 *
 * 服务端契约（docs/requirements/ADULT-MENU.md + 服务端并行实现）：
 * - GET /api/adult/state → { enabled: boolean }
 * - POST /api/adult/confirm → 种 HttpOnly 签名 cookie mh_adult（30 天），返回 { enabled: true }
 * - 带 audience=adult 的列表接口未确认时返回 { items: [], gated: true, ... }
 */
export const ADULT_GATE_STATES = ['checking', 'open', 'gate', 'closed'];

/**
 * 把服务端响应映射成门禁状态。
 * @param {object|null|undefined} payload
 * @param {'open'|'gate'|'closed'} [fallback] 响应缺少门禁字段时的回落值
 * @returns {'open'|'gate'|'closed'}
 */
export function adultGateOf(payload, fallback = 'open') {
  if (payload && typeof payload === 'object') {
    // 注意：/api/adult/state 的 enabled 是「服务端是否已有年龄凭证」，
    // 不是「频道是否开放」。频道开关看 constants.adultMenu.enabled（AdultPage 的 adultEnabled）。
    if (payload.closed === true || payload.available === false) return 'closed';
    if (payload.gated === true) return 'gate';
    if (payload.confirmed === false) return 'gate';
    if (payload.confirmed === true) return 'open';
    if (payload.enabled === true) return 'open';
    if (payload.enabled === false) return 'gate';
  }
  return fallback;
}

/**
 * 挂载时是否需要显示门禁：服务端说 gate，或本地还没有同意记录。
 * @param {object|null|undefined} statePayload /api/adult/state 的响应
 * @param {boolean} localConfirmed 本地 sessionStorage 里的同意状态
 */
export function needsAdultGate(statePayload, localConfirmed) {
  const gate = adultGateOf(statePayload, 'open');
  if (gate !== 'open') return gate;
  // 服务端明确说 enabled=true（已有 mh_adult 凭证）时不再看本地 sessionStorage：
  // 换浏览器/清缓存后 cookie 仍然有效，不该重复弹年龄确认。
  if (statePayload && typeof statePayload === 'object' && statePayload.enabled === true) return 'open';
  return localConfirmed ? 'open' : 'gate';
}
