/**
 * 接口响应判定（纯函数，便于单测；不依赖 window/fetch）。
 *
 * 关键规则：HTTP 状态先于业务码。反代回 200 + 错误 JSON、或 5xx 里带 code:'0000'，
 * 都必须以 HTTP 状态为准判失败，不能只凭 json.code 就当成功。
 */
export function apiOutcome({ ok, status, json } = {}) {
  const code = json?.code;
  if (code === '0401' || status === 401) {
    return {
      kind: 'unauthorized',
      code: code ?? '0401',
      message: json?.msg || '登录已过期，请重新登录',
      data: json?.data
    };
  }
  if (!ok) {
    return {
      kind: 'error',
      code: code ?? `http_${status}`,
      message: json?.msg || `请求失败（${status}）`,
      data: json?.data
    };
  }
  if (!json || code !== '0000') {
    return {
      kind: 'error',
      code: code ?? 'bad_response',
      message: json?.msg || '接口失败',
      data: json?.data
    };
  }
  return { kind: 'ok', code, message: '', data: json.data };
}
