/**
 * Retry-After 解析（RFC 9110 §10.2.3）：值可能是「秒数」也可能是 HTTP-date。
 * 之前只做 Number(raw)，遇到 HTTP-date 就得到 NaN → 退避固定 30s。
 * 统一在这里解析并夹到 [min, max]，各调用方（hls.js 致命错误、原生 error）共用一套口径。
 */
export const RETRY_AFTER_FALLBACK = 30;
export const RETRY_AFTER_MIN = 5;
export const RETRY_AFTER_MAX = 120;

export function parseRetryAfter(value, options = {}) {
  const {
    now = Date.now(),
    fallback = RETRY_AFTER_FALLBACK,
    min = RETRY_AFTER_MIN,
    max = RETRY_AFTER_MAX
  } = options;
  const clamp = (seconds) => Math.max(min, Math.min(max, seconds));
  const raw = typeof value === 'number' ? value : String(value ?? '').trim();
  if (raw === '') return clamp(fallback);
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    // 0 与负数都不代表「马上重试」，按兜底处理，避免疯狂打上游
    return clamp(numeric > 0 ? numeric : fallback);
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return clamp(Math.round((at - Number(now)) / 1000) || fallback);
  }
  return clamp(fallback);
}

/** 从 hls.js 的错误 payload 里取 Retry-After：headers 可能是 Headers 对象，也可能是普通对象 */
export function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    const direct = headers.get(name);
    if (direct !== null && direct !== undefined) return direct;
    const lower = headers.get(name.toLowerCase());
    if (lower !== null && lower !== undefined) return lower;
    return '';
  }
  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name.toLowerCase()) return value;
    }
  }
  return '';
}

export function retryAfterOf(payload, now = Date.now()) {
  const headers = payload?.response?.headers ?? payload?.headers ?? null;
  return parseRetryAfter(headerValue(headers, 'retry-after'), { now });
}
