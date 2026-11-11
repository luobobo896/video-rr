import { cp, copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const copy = async (from, to) => {
  if (existsSync(from)) await cp(from, to, { recursive: true, force: true })
}

await mkdir('dist/client', { recursive: true })
for (const dir of ['icons', 'brand', 'vendor']) await copy(join('public', dir), join('dist/client', dir))
await copy(join('public', 'icons'), join('dist/client', 'assets', 'icons'))
for (const file of [
  'base.js', 'apple-touch-icon.png', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png',
  'site.webmanifest', 'browserconfig.xml', 'posters.html', 'robots.txt',
]) {
  if (existsSync(join('public', file))) await copyFile(join('public', file), join('dist/client', file))
}

await mkdir('dist/admin', { recursive: true })
await copy(join('admin', 'icons'), join('dist/admin', 'icons'))
await copy(join('admin', 'icons'), join('dist/admin', 'assets', 'icons'))
for (const file of [
  'base.js', 'apple-touch-icon.png', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png',
  'admin.webmanifest', 'browserconfig.xml',
]) {
  if (existsSync(join('admin', file))) await copyFile(join('admin', file), join('dist/admin', file))
}

console.log('frontend static assets copied')
