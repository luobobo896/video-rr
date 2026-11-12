import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const REQUIRED = [
  'admin/index.html',
  'admin/main.js',
  'admin/LegacyHost.vue',
  'public/index.html',
  'public/main.js',
  'public/LegacyHost.vue',
  'web-redesign/index.html',
  'web-redesign/src/main.js',
  'package-lock.json',
  'vite.client.config.mjs',
  'vite.admin.config.mjs',
  'vite.redesign.config.mjs',
  'deploy/install-hk.sh',
]
const ENTRIES = [
  'admin',
  'public',
  'web-redesign',
  'server',
  'shared',
  'scripts',
  'deploy',
  'data',
  'package.json',
  'package-lock.json',
  'vite.client.config.mjs',
  'vite.admin.config.mjs',
  'vite.redesign.config.mjs',
  'README.md',
  'PRODUCT.md',
  'API.md',
  'DESIGN.md',
]

for (const file of REQUIRED) {
  if (!existsSync(join(ROOT, file))) throw new Error(`发布包缺少必要文件：${file}`)
}

execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })

const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
const output = join(ROOT, `mh-deploy-${stamp}.tgz`)

execFileSync('tar', ['-czf', output, ...ENTRIES], { cwd: ROOT, stdio: 'inherit' })

const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
const missing = REQUIRED.filter((file) => !entries.includes(file))
if (missing.length) throw new Error(`发布包校验失败，缺少：${missing.join(', ')}`)
for (const forbidden of ['node_modules/', 'storage/', 'dist/', '.env']) {
  if (entries.some((entry) => entry === forbidden || entry.startsWith(forbidden))) {
    throw new Error(`发布包不应包含：${forbidden}`)
  }
}

const hash = createHash('sha256').update(readFileSync(output)).digest('hex')
console.log(`发布包：${output}`)
console.log(`大小：${statSync(output).size} bytes`)
console.log(`SHA256：${hash}`)
