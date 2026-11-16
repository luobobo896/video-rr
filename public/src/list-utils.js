/**
 * 列表页公共纯函数：分页累加去重、页码跟随当前筛选的总数夹取。
 * 「加载更多」用 concat 叠加时，服务端在翻页期间改了数据会重复下发同一条，
 * 不去重就会撞 Vue 的 duplicate key；页码则必须用**这一次响应**的 total 夹，
 * 拿切换筛选前的旧 total 夹会算出一个不存在的页，按钮点了没反应。
 */
export function totalPagesOf(total, pageSize = 24) {
  const size = Number(pageSize) > 0 ? Number(pageSize) : 24;
  return Math.max(1, Math.ceil(Math.max(0, Number(total) || 0) / size));
}

export function clampPage(page, total, pageSize = 24) {
  const pages = totalPagesOf(total, pageSize);
  const current = Math.round(Number(page) || 1);
  return Math.min(Math.max(1, current), pages);
}

/** 叠加分页结果并按 id 去重（保留先到的顺序），id 相同以新数据为准。 */
export function appendUnique(existing = [], incoming = [], keyOf = (item) => item?.id) {
  const merged = [];
  const index = new Map();
  for (const item of [...existing, ...incoming]) {
    const key = keyOf(item);
    if (key === null || key === undefined || key === '') {
      merged.push(item);
      continue;
    }
    if (index.has(key)) {
      merged[index.get(key)] = item;
      continue;
    }
    index.set(key, merged.length);
    merged.push(item);
  }
  return merged;
}

/** 同一批数据按 id 去重（首页/榜单等一次性渲染的列表）。 */
export function uniqueById(items = [], keyOf = (item) => item?.id) {
  return appendUnique([], items, keyOf);
}
