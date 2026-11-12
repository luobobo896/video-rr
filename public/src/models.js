import { mediaUrl } from './api.js';

export function normalizeCard(raw = {}) {
  const dramaId = Number(raw.dramaId ?? raw.id ?? 0);
  return {
    id: dramaId,
    title: raw.title || '未命名内容',
    subtitle: raw.subTitle ?? '',
    coverUrl: mediaUrl(raw.coverUrl),
    previewUrl: mediaUrl(raw.previewUrl),
    score: Number(raw.score ?? 0),
    year: Number(raw.year ?? 0),
    area: raw.areaLabel ?? raw.area ?? '',
    type: raw.dramaType ?? '',
    typeLabel: raw.dramaTypeLabel ?? '',
    isAdult: Boolean(raw.isAdult),
    access: raw.access ?? raw.accessMode ?? '',
    accessLabel: raw.accessLabel ?? '',
    freeEpisodes: Number(raw.freeEpisodes ?? 0),
    singlePrice: Number(raw.singlePrice ?? 0),
    playCount: Number(raw.playCount ?? 0),
    rankNo: raw.rankNo ?? null,
    isNew: Boolean(raw.isNew),
    stats: raw.stats ?? null,
    raw
  };
}

export function normalizedSection(section = {}) {
  return {
    id: section.id,
    title: section.title || '精选',
    items: (section.items ?? []).map(normalizeCard)
  };
}

export function formatScore(score) {
  return Number(score ?? 0) > 0 ? Number(score).toFixed(1) : '—';
}

export function formatCount(value) {
  return Number(value ?? 0).toLocaleString('zh-CN');
}

export function formatDate(value) {
  if (!value) return '—';
  return String(value).slice(0, 10);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false
  });
}

export function formatMoney(value) {
  return `¥${Number(value ?? 0).toFixed(2)}`;
}

export function subscriptionDaysLeft(subscription) {
  if (!subscription?.validTo) return 0;
  const end = new Date(String(subscription.validTo).replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.ceil((end - Date.now()) / 86400000));
}

export function statusClass(status) {
  if (['paid', 'fulfilled', 'active', 'approved', 'ready', 'ok'].includes(status)) return 'badge--ok';
  if (['pending', 'created', 'refunding', 'queued', 'transcoding', 'draft'].includes(status)) return 'badge--warn';
  if (['failed', 'rejected', 'refunded', 'banned', 'error'].includes(status)) return 'badge--bad';
  return 'badge--muted';
}

export const STATUS_LABEL = {
  created: '待支付',
  pending: '处理中',
  paid: '已支付',
  fulfilled: '已完成',
  closed: '已关闭',
  failed: '失败',
  refunded: '已退款',
  refunding: '退款中',
  refund_pending: '退款待审',
  approved: '已通过',
  rejected: '已驳回',
  active: '启用',
  disabled: '停用',
  ready: '就绪',
  queued: '排队中',
  transcoding: '转码中',
  error: '异常',
  published: '已上架',
  draft: '草稿',
  offline: '已下架',
  banned: '已禁用'
};

export const CATEGORY_LABEL = {
  TV: '电视剧',
  MOVIE: '电影',
  PLAYLET: '短剧',
  ANIME: '动漫',
  VARIETY: '综艺',
  DOCUMENTARY: '纪录片'
};
