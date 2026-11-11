import { getSetting, setSetting } from './db.mjs'

export const DEFAULT_ADULT_MENU = Object.freeze({
  enabled: true,
  labelZh: '成人',
  labelEn: 'Adult',
})

const labelOf = (value, fallback) => {
  const label = String(value ?? '').trim()
  return label || fallback
}

export function adultMenuSettings() {
  const saved = getSetting('adultMenu', {}) ?? {}
  return {
    enabled: saved.enabled !== false,
    labelZh: labelOf(saved.labelZh, DEFAULT_ADULT_MENU.labelZh),
    labelEn: labelOf(saved.labelEn, DEFAULT_ADULT_MENU.labelEn),
  }
}

export function saveAdultMenuSettings(input = {}) {
  if (typeof input.enabled !== 'boolean') {
    throw Object.assign(new Error('enabled 必须是布尔值'), { status: 400 })
  }
  const labelZh = String(input.labelZh ?? '').trim()
  const labelEn = String(input.labelEn ?? '').trim()
  if (!labelZh || !labelEn || labelZh.length > 20 || labelEn.length > 20) {
    throw Object.assign(new Error('中英文标签都需为 1–20 个字符'), { status: 400 })
  }
  const settings = {
    enabled: input.enabled,
    labelZh,
    labelEn,
  }
  setSetting('adultMenu', settings)
  return settings
}
