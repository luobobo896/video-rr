/**
 * 把 storage/images 里生产还没的图片推上去（增量，只传缺的）。
 *
 *   node scripts/push-images.mjs            # HOST=hk REMOTE_APP=/opt/video-rr
 *   HOST=hk REMOTE_APP=/opt/video-rr node scripts/push-images.mjs --dry
 *
 * 为什么不用 scp -r：图会越来越多（几千张、几个 G），每次全传太浪费。
 * 这里先问远程 ls 一遍，只打包本地多出来的文件名，按 200 个一批压缩上传解包。
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const host = process.env.HOST ?? 'hk'
const remote = process.env.REMOTE_APP ?? '/opt/video-rr'
const localDir = 'storage/images'
const dry = process.argv.includes('--dry')
const CHUNK = 200

const run = async (cmd, args) => (await exec(cmd, args, { maxBuffer: 64 * 1024 * 1024 })).stdout

const remoteList = await run('ssh', [host, `ls ${remote}/${localDir} 2>/dev/null || true`])
const have = new Set(remoteList.split('\n').map((line) => line.trim()).filter(Boolean))
const localFiles = readdirSync(localDir).filter((name) => statSync(join(localDir, name)).isFile())
const missing = localFiles.filter((name) => !have.has(name))
const bytes = missing.reduce((sum, name) => sum + statSync(join(localDir, name)).size, 0)

console.log(`本地 ${localFiles.length} 张 · 远程 ${have.size} 张 · 待传 ${missing.length} 张 ${(bytes / 1048576).toFixed(1)}MB`)
if (!missing.length) process.exit(0)
if (dry) {
  console.log(missing.slice(0, 10).join('\n'))
  process.exit(0)
}

const tmp = mkdtempSync(join(tmpdir(), 'mh-img-'))
const batches = []
for (let i = 0; i < missing.length; i += CHUNK) batches.push(missing.slice(i, i + CHUNK))

for (const [index, batch] of batches.entries()) {
  const tgz = join(tmp, `img-${index}.tgz`)
  await run('tar', ['-czf', tgz, '-C', localDir, ...batch])
  const size = (statSync(tgz).size / 1048576).toFixed(1)
  await run('scp', ['-q', tgz, `${host}:/tmp/${`img-${index}.tgz`}`])
  await run('ssh', [host, `mkdir -p ${remote}/${localDir} && tar -xzf /tmp/img-${index}.tgz -C ${remote}/${localDir} && rm -f /tmp/img-${index}.tgz`])
  console.log(`  批次 ${index + 1}/${batches.length}：${batch.length} 张 ${size}MB 已上传解包`)
}

const after = await run('ssh', [host, `ls ${remote}/${localDir} | wc -l`])
console.log(`完成，远程现有 ${String(after).trim()} 张`)
