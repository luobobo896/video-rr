/**
 * 页面离开（loose）上报的纯逻辑，便于单测：
 * - looseHeaders：离开事件的请求头必须复用进入事件时的 visitor / lang，
 *   否则同一访客会被算成两个人（服务端按 visitor 归并会话）。
 * - createLooseGuard：pagehide 与 visibilitychange 是同一件事的两条路径，
 *   一次页面停留只允许发一条 loose；重新进入页面（或重新可见）时 reset。
 */
export function looseHeaders({ visitor = '', lang = 'zh', token = '' } = {}) {
  const headers = { 'content-type': 'application/json', 'x-mh-lang': lang || 'zh' };
  if (visitor) headers['x-mh-visitor'] = visitor;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function createLooseGuard() {
  let sent = false;
  const trySend = () => {
    if (sent) return false;
    sent = true;
    return true;
  };
  const reset = () => {
    sent = false;
  };
  const guard = { trySend, reset };
  Object.defineProperty(guard, 'sent', { enumerable: true, get: () => sent });
  return guard;
}
