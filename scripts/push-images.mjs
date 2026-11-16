/**
 * 把 storage/images 里生产还没的图片推上去（增量，只传缺的）。
 *
 *   node scripts/push-images.mjs            # HOST=hk REMOTE_APP=/opt/video-rr
 *   HOST=hk REMOTE_APP=/opt/video-rr node scripts/push-images.mjs --dry
 *
 * 为什么不用 scp -r：图会越来越多（几千张、几个 G），每次全传太浪费。
 * 这里先问远程 ls 一遍，只打包本地多出来的文件名，按 200 个一批压缩上传解包。
 *
 * 退出码：0 正常 / 1 ssh 或上传失败（直接中止，不会退化成「全量重传」）。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertSafeToken, shellQuote } from './lib/shell.mjs'

const host = process.env.HOST ?? 'hk'
const remote = process.env.REMOTE_APP ?? '/opt/video-rr'
const localDir = 'storage/images'
const dry = process.argv.includes('--dry')
const CHUNK = 200

/** 带退出码的 execFile：要区分「远程目录不存在」和「ssh 连不上」。 */
function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        code: error ? Number(error.code ?? 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        message: error?.message ?? '',
      })
    })
  })
}

function fail(message) {
  console.error(`[失败] ${message}`)
  process.exitCode = 1
}

/** 远程命令：这些值来自环境变量，会进远端 shell，先过白名单再拼单引号 */
function safeRemote(command) {
  assertSafeToken('HOST', host, /^[A-Za-z0-9._@-]+$/)
  assertSafeToken('REMOTE_APP', remote, /^[A-Za-z0-9._/-]+$/)
  return command
}

async function remoteNames(remotePath) {
  const command = safeRemote(`ls -1 ${shellQuote(remotePath)}`)
  const result = await run('ssh', [host, command])
  if (result.code === 0) return new Set(result.stdout.split('\n').map((line) => line.trim()).filter(Boolean))
  // 目录还不存在是正常情况（第一次推图），其它错误一律中止：
  // 旧实现用 `|| true` 把所有失败都洗成空列表，于是 ssh 一挂就变成「全量重传」。
  if (/No such file or directory|cannot access/i.test(result.stderr + result.message)) return new Set()
  throw new Error(`ssh ${host} 列目录失败（exit ${result.code}）：${(result.stderr || result.message).trim()}`)
}

async function main() {
  if (!existsSync(localDir)) {
    fail(`本地目录不存在：${join(process.cwd(), localDir)}`)
    return
  }
  assertSafeToken('HOST', host, /^[A-Za-z0-9._@-]+$/)
  assertSafeToken('REMOTE_APP', remote, /^[A-Za-z0-9._/-]+$/)
  const remotePath = `${remote}/${localDir}`
  const have = await remoteNames(remotePath)
  const localFiles = readdirSync(localDir).filter((name) => statSync(join(localDir, name)).isFile())
  const missing = localFiles.filter((name) => !have.has(name))
  const bytes = missing.reduce((sum, name) => sum + statSync(join(localDir, name)).size, 0)

  console.log(`本地 ${localFiles.length} 张 · 远程 ${have.size} 张 · 待传 ${missing.length} 张 ${(bytes / 1048576).toFixed(1)}MB`)
  if (!missing.length) return
  if (dry) {
    console.log(missing.slice(0, 10).join('\n'))
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'mh-img-'))
  try {
    const batches = []
    for (let i = 0; i < missing.length; i += CHUNK) batches.push(missing.slice(i, i + CHUNK))

    for (const [index, batch] of batches.entries()) {
      const tgz = join(tmp, `img-${index}.tgz`)
      const tarred = await run('tar', ['-czf', tgz, '-C', localDir, ...batch])
      if (tarred.code !== 0) throw new Error(`tar 打包失败：${(tarred.stderr || tarred.message).trim()}`)
      const size = (statSync(tgz).size / 1048576).toFixed(1)
      const copied = await run('scp', ['-q', tgz, `${host}:/tmp/img-${index}.tgz`])
      if (copied.code !== 0) throw new Error(`scp 上传失败：${(copied.stderr || copied.message).trim()}`)
      const unpacked = await run('ssh', [host, safeRemote(
        `mkdir -p ${shellQuote(remotePath)} && tar -xzf ${shellQuote(`/tmp/img-${index}.tgz`)} -C ${shellQuote(remotePath)} && rm -f ${shellQuote(`/tmp/img-${index}.tgz`)}`,
      )])
      if (unpacked.code !== 0) throw new Error(`ssh 解包失败：${(unpacked.stderr || unpacked.message).trim()}`)
      console.log(`  批次 ${index + 1}/${batches.length}：${batch.length} 张 ${size}MB 已上传解包`)
    }

    const after = await run('ssh', [host, safeRemote(`ls -1 ${shellQuote(remotePath)} | wc -l`)])
    if (after.code !== 0) throw new Error(`ssh 统计失败：${(after.stderr || after.message).trim()}`)
    console.log(`完成，远程现有 ${String(after.stdout).trim()} 张`)
  } finally {
    // 几个 G 的 tgz 留在 %TEMP% 里，不清理会把机器磁盘塞满
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((error) => fail(error.message))
