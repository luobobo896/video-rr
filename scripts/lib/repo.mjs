/**
 * 仓库路径解析：所有脚本里「相对路径」都必须以仓库根为基准，而不是 process.cwd()。
 *
 * 为什么单独抽出来：曾经 `MH_DB || 'storage/app.db'` 是相对 cwd 的，在别的目录
 * 下跑脚本会新建一个空库并往里写，看起来「导入成功」，线上却一条没变。测试用
 * MH_ROOT 指向 mkdtemp 临时仓库，绝不碰真实库。
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件位于 <repo>/scripts/lib/repo.mjs */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 默认库位置（相对仓库根） */
export const DEFAULT_DB_REL = join('storage', 'app.db')

/**
 * 仓库根：MH_ROOT 可覆盖（测试与多实例部署用），否则取脚本所在仓库。
 * @param {Record<string, string | undefined>} env
 */
export function repoRoot(env = process.env) {
  const override = String(env.MH_ROOT ?? '').trim()
  return override ? resolve(override) : REPO_ROOT
}

/**
 * 把配置里的路径钉到仓库根：绝对路径原样返回，相对路径按仓库根展开。
 * @param {string} value
 * @param {string} [root]
 */
export function resolveRepoPath(value, root = repoRoot()) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
}

/**
 * 解析数据库文件路径。
 *  - 未设置 MH_DB：<repo>/storage/app.db
 *  - 设置了相对路径：按仓库根展开（不是 cwd！）
 *  - 设置了绝对路径：原样
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveDbPath(env = process.env) {
  const root = repoRoot(env)
  const fallback = join(root, DEFAULT_DB_REL)
  const raw = String(env.MH_DB ?? '').trim()
  const path = raw ? (isAbsolute(raw) ? resolve(raw) : resolve(root, raw)) : fallback
  return {
    path,
    root,
    defaultPath: fallback,
    fromEnv: Boolean(raw),
    isDefault: path === fallback,
  }
}

/**
 * 启动时打印目标库：写错路径时第一眼就能看出来。
 * @param {{ path: string, isDefault: boolean, fromEnv: boolean }} info
 */
export function describeDbTarget(info) {
  const origin = info.isDefault ? '默认' : info.fromEnv ? 'MH_DB' : '默认'
  return `目标库：${info.path}（${origin}）`
}

/**
 * 仓库结构自检：误把 MH_ROOT 指到无关目录时，宁可报错也不要删别人的文件。
 * @param {string} root
 */
export function assertRepoRoot(root) {
  if (!existsSync(join(root, 'package.json'))) {
    throw new Error(`不是仓库根目录（缺少 package.json）：${root}`)
  }
  if (resolve(root) === resolve(root, '..')) throw new Error(`拒绝在文件系统根目录操作：${root}`)
  return root
}
