/**
 * C 端时间工具：服务端时间串只有这一处解析口径。
 * 服务端（SQLite）时间是不带时区的 UTC 串，如 '2026-11-16 03:20:00'；部分接口会回
 * ISO 串（'2026-11-16T03:20:00Z' 或 '2026-11-16T03:20:00+08:00'）。
 * 规则：自带时区（Z / ±hh:mm）按原样解析，不带时区一律按 UTC 解释 —— 不要盲目再拼 'Z'，
 * 拼到已经带 Z 的串上会得到 'ZZ'，那是 Invalid Date。
 */
const TZ_SUFFIX = /(?:z|[+-]\d{2}:?\d{2})$/i;
const NAIVE = /^\d{4}-\d{2}-\d{2}(?:[ t]\d{2}:\d{2}(?::\d{2})?)?$/;
const SHANGHAI = 'Asia/Shanghai';
const DAY_MS = 86400000;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHANGHAI,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: SHANGHAI,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

export function hasTimeZone(value) {
  return TZ_SUFFIX.test(String(value ?? '').trim());
}

export function parseServerTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (!hasTimeZone(raw) && NAIVE.test(raw)) {
    const normalized = raw.replace(' ', 'T');
    const withTime = normalized.length <= 10 ? `${normalized}T00:00:00` : normalized;
    const naive = new Date(`${withTime}Z`);
    return Number.isNaN(naive.getTime()) ? null : naive;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 订阅剩余天数：validTo 是否自带时区都不影响结果。 */
export function daysLeft(validTo, now = Date.now()) {
  const end = parseServerTime(validTo);
  if (!end) return 0;
  return Math.max(0, Math.ceil((end.getTime() - Number(now)) / DAY_MS));
}

/** 日期（+08 视角的 YYYY-MM-DD），避免 slice(0,10) 把 UTC 当天算成前一天。 */
export function formatDay(value, fallback = '—') {
  const date = parseServerTime(value);
  return date ? dayFormatter.format(date) : fallback;
}

/** 日期时间（+08 视角，与列表排序同一口径）。 */
export function formatDateTime(value, fallback = '—') {
  const date = parseServerTime(value);
  return date ? dateTimeFormatter.format(date) : fallback;
}

/** 按时间倒序排（用统一解析口径，别在组件里各自 new Date）。 */
export function sortByTimeDesc(items = [], key = 'createdAt') {
  return [...items].sort((left, right) => {
    const a = parseServerTime(left?.[key]);
    const b = parseServerTime(right?.[key]);
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return b.getTime() - a.getTime();
  });
}

/** 已看秒数占全片百分比，缺时长时返回 null（由调用方决定是否隐藏进度条）。 */
export function watchedPercent(positionSeconds, durationSeconds) {
  const position = Number(positionSeconds ?? 0);
  const duration = Number(durationSeconds ?? 0);
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  if (position <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((position / duration) * 100)));
}

/** 时长展示（mm:ss / h:mm:ss）：秒数永远当时间用，绝不塞进百分比。 */
export function formatElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}
