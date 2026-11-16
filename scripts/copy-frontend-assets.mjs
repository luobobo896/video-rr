/**
 * 把 C 端 / 后台的静态资源塞进 dist。
 *
 * 旧实现所有路径都相对 cwd，在 scripts/ 或任意子目录里跑会静默 exit 0（什么都没拷），
 * 于是构建产物缺图标、缺 robots.txt，而构建脚本仍然「成功」。现在一律以仓库根为基准，
 * 源目录不存在直接报错退非 0。
 */
import { cp, copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertRepoRoot, repoRoot } from './lib/repo.mjs'

const ROOT = repoRoot()
assertRepoRoot(ROOT)
const at = (...parts) => join(ROOT, ...parts)

const copy = async (from, to) => {
  if (existsSync(from)) await cp(from, to, { recursive: true, force: true })
}

async function main() {
  const missing = [at('public'), at('admin')].filter((dir) => !existsSync(dir))
  if (missing.length) {
    console.error(`[失败] 源目录不存在：${missing.join('、')}（仓库根 ${ROOT}）`)
    process.exitCode = 1
    return
  }

  await mkdir(at('dist', 'client'), { recursive: true })
  for (const dir of ['icons', 'brand', 'art', 'vendor']) await copy(at('public', dir), at('dist', 'client', dir))
  await copy(at('public', 'icons'), at('dist', 'client', 'assets', 'icons'))
  for (const file of [
    'base.js', 'apple-touch-icon.png', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png',
    'site.webmanifest', 'browserconfig.xml', 'posters.html', 'robots.txt',
  ]) {
    if (existsSync(at('public', file))) await copyFile(at('public', file), at('dist', 'client', file))
  }

  await mkdir(at('dist', 'admin'), { recursive: true })
  await copy(at('admin', 'icons'), at('dist', 'admin', 'icons'))
  await copy(at('admin', 'icons'), at('dist', 'admin', 'assets', 'icons'))
  for (const file of [
    'base.js', 'apple-touch-icon.png', 'favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png',
    'admin.webmanifest', 'browserconfig.xml',
  ]) {
    if (existsSync(at('admin', file))) await copyFile(at('admin', file), at('dist', 'admin', file))
  }

  console.log(`frontend static assets copied → ${at('dist')}`)
}

await main()
