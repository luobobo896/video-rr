const lower = (value) => String(value ?? '').trim().toLowerCase()

export function matchTrack(tracks, preference, lang, { subtitle = false } = {}) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null
  if (preference === 'off') return null

  if (preference && typeof preference === 'object') {
    const language = lower(preference.language)
    const edition = lower(preference.edition)
    const candidates = tracks.filter((track) => !language || lower(track.language) === language)
    if (edition) {
      const exact = candidates.find((track) => lower(track.edition) === edition)
      if (exact) return exact
    }
    if (candidates.length) return candidates.find((track) => track.default) ?? candidates[0]
  }

  const base = lower(lang).split('-')[0]
  const languageMatches = base
    ? tracks.filter((track) => {
      const value = lower(track.language)
      return value === base || value.startsWith(`${base}-`)
    })
    : []
  const languagePick = languageMatches.find((track) => track.default) ?? languageMatches[0]
  if (languagePick) return languagePick

  const defaultTrack = tracks.find((track) => track.default)
  if (defaultTrack) return defaultTrack
  return subtitle ? null : tracks[0]
}
