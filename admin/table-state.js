export function readHashQuery(hash = location.hash) {
  return Object.fromEntries(new URLSearchParams(String(hash).split('?')[1] ?? ''))
}

export function writeHashQuery(route, params = {}) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== '' && value !== null && value !== undefined) query.set(key, String(value))
  }
  const suffix = query.toString()
  history.replaceState(null, '', `#/${route}${suffix ? `?${suffix}` : ''}`)
}

export function pageNumbers(current, pages) {
  const total = Math.max(1, Number(pages) || 1)
  const active = Math.min(Math.max(1, Number(current) || 1), total)
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1)
  const values = new Set([1, total, active - 1, active, active + 1])
  if (active <= 4) [2, 3, 4, 5].forEach((value) => values.add(value))
  if (active >= total - 3) [total - 4, total - 3, total - 2, total - 1].forEach((value) => values.add(value))
  const sorted = [...values].filter((value) => value >= 1 && value <= total).sort((a, b) => a - b)
  const result = []
  for (const value of sorted) {
    if (result.length && value - result[result.length - 1] > 1) result.push('…')
    result.push(value)
  }
  return result
}
