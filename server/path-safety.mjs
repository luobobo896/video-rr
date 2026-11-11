import { resolve, sep } from 'node:path'

/** Resolve a relative path inside a trusted root; return null when it escapes. */
export function resolveInside(rootDir, relativePath = '') {
  const root = resolve(rootDir)
  const target = resolve(root, relativePath)
  return target === root || target.startsWith(root + sep) ? target : null
}
