/**
 * scripts/ 与 deploy/ 修复的回归测试（对应 docs/testing/2026-11-16-full-code-review.md 的
 * P0-5 / P0-6 与 P1 脚本 + 部署条目）。
 *
 * 约定：
 *  - 纯函数直接 import；需要库的行为在 mkdtemp 临时目录里造库，绝不碰 storage/app.db；
 *  - 会写盘/删文件的脚本只用「被确认门拦下」或「--dry」两种路径跑；
 *  - .cmd / .service / nginx / cron 这类没法在 Windows 上执行的，读文件断言关键文本。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { REPO_ROOT, describeDbTarget, repoRoot, resolveDbPath, resolveRepoPath } from '../scripts/lib/repo.mjs'
import { CONFIRM_ENV, confirmGate, confirmHint, isTruthy } from '../scripts/lib/confirm.mjs'
import { EXIT_LOCK_BUSY, acquireLock, isPidAlive, lockBusyMessage, readLockPid } from '../scripts/lib/lock.mjs'
import { assertSafeToken, remoteEnvPrefix, shellQuote } from '../scripts/lib/shell.mjs'
import { ADULT_MODE_DEFAULT, ADULT_MODES, resolveAdultMode } from '../scripts/lib/adult-mode.mjs'
import {
  escapeLike,
  exitCodeFor,
  exitCodeHint,
  likeContains,
  normalizeCodeKey,
  parseMaxLeftMinutes,
  shouldAdoptTicket,
  shouldPruneEpisodes,
} from '../scripts/lib/import-guards.mjs'
import { masterVersionOf, rewriteMaster } from '../scripts/lib/hls-playlist.mjs'
import { forbiddenEntries, isForbiddenEntry } from '../scripts/lib/deploy-guard.mjs'
import { writeFileAtomicSync } from '../scripts/lib/fsx.mjs'
import { HELP_TEXT, planCli, onlyList, valueOf } from '../scripts/lib/import-catalog-cli.mjs'
import { TAG_MATCH_SQL, isLiteralSubstringMatch } from '../scripts/lib/tag-match.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath

void REPO_ROOT

function temp(prefix = 'mh-fix-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** 造一个假仓库根（assertRepoRoot 要求 package.json）。 */
function tempRoot() {
  const root = temp()
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}\n')
  return root
}

function run(script, args = [], env = {}) {
  const result = spawnSync(NODE, [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, MH_CONFIRM_RESET: '', ...env },
  })
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function read(relPath) {
  return readFileSync(join(ROOT, relPath), 'utf8')
}

/** 最小可用的成人库（列名与 adult-migrate 的 ADULT_COLUMNS / EPISODE_COLUMNS 对齐）。 */
function makeDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, sub_title TEXT, category TEXT,
      is_adult INTEGER DEFAULT 0, source_key TEXT, status TEXT DEFAULT 'published',
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, drama_id INTEGER, no INTEGER, title TEXT,
      duration INTEGER, status TEXT, progress INTEGER, created_at TEXT,
      UNIQUE(drama_id, no)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, scope TEXT, sort INTEGER,
      status TEXT, parent_id INTEGER
    );
    CREATE TABLE drama_tags (drama_id INTEGER, tag_id INTEGER, PRIMARY KEY (drama_id, tag_id));
    CREATE TABLE content_policies (
      drama_id INTEGER PRIMARY KEY, access_mode TEXT, free_episodes INTEGER,
      trial_seconds INTEGER, single_price_cny INTEGER, purchase_kind TEXT,
      rental_hours INTEGER, updated_at TEXT
    );
  `)
  return db
}

function columnsOf(file, table) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)
  } finally {
    db.close()
  }
}

function countOf(file, sql, ...params) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).get(...params)?.n ?? 0
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------- 路径解析（P0-6）

test('未设置 MH_DB 时默认指向 <仓库根>/storage/app.db 且标记为默认', () => {
  const info = resolveDbPath({})
  assert.equal(info.path, join(REPO_ROOT, 'storage', 'app.db'))
  assert.equal(info.isDefault, true)
  assert.equal(info.fromEnv, false)
  assert.match(describeDbTarget(info), /（默认）$/)
})

test('MH_DB 的相对路径按仓库根展开而不是当前目录', () => {
  const info = resolveDbPath({ MH_DB: 'storage/tmp-test.db' })
  assert.equal(info.path, join(REPO_ROOT, 'storage', 'tmp-test.db'))
  assert.equal(info.isDefault, false)
  assert.match(describeDbTarget(info), /（MH_DB）$/)
})

test('MH_ROOT 覆盖仓库根，测试因此不会碰真实库', () => {
  const root = temp()
  const info = resolveDbPath({ MH_ROOT: root, MH_DB: 'storage/app.db' })
  assert.equal(info.root, root)
  assert.equal(info.path, join(root, 'storage', 'app.db'))
  assert.equal(info.isDefault, true)
  assert.equal(repoRoot({ MH_ROOT: root }), root)
})

test('resolveRepoPath 只在相对路径时拼仓库根', () => {
  const root = temp()
  assert.equal(resolveRepoPath('storage/x.json', root), join(root, 'storage', 'x.json'))
  const absolute = join(root, 'abs.json')
  assert.equal(resolveRepoPath(absolute, root), absolute)
  assert.equal(resolveRepoPath('', root), '')
})

// ---------------------------------------------------------------- 确认门（P0-5）

test('isTruthy 只认 1/true/yes/y/on', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' y ']) assert.equal(isTruthy(value), true)
  for (const value of ['', '0', 'no', 'off', 'maybe', undefined]) assert.equal(isTruthy(value), false)
})

test('确认门：默认库只要 --yes 或环境变量之一', () => {
  assert.equal(confirmGate({ args: [], env: {} }).ok, false)
  assert.equal(confirmGate({ args: ['--yes'], env: {} }).ok, true)
  assert.equal(confirmGate({ args: [], env: { [CONFIRM_ENV]: '1' } }).ok, true)
  assert.deepEqual(confirmGate({ args: [], env: {} }).missing, ['--yes', CONFIRM_ENV])
})

test('确认门：非默认目标库必须 --yes 与环境变量同时具备', () => {
  const only = confirmGate({ args: ['--yes'], env: {}, requireBoth: true })
  assert.equal(only.ok, false)
  assert.deepEqual(only.missing, [CONFIRM_ENV])
  const both = confirmGate({ args: ['--yes'], env: { [CONFIRM_ENV]: '1' }, requireBoth: true })
  assert.equal(both.ok, true)
  assert.deepEqual(both.via, ['--yes', CONFIRM_ENV])
})

test('拒绝提示列出全部删除目标并说明双重确认', () => {
  const hint = confirmHint({ targets: ['/tmp/a.db', '/tmp/hls'], requireBoth: true })
  assert.match(hint, /不可回滚/)
  assert.match(hint, /\/tmp\/a\.db/)
  assert.match(hint, /双重确认/)
})

// ---------------------------------------------------------------- 进程锁（P1：--every 与计划任务重叠）

test('锁文件：首次拿到、他人持锁拿不到、持锁进程已死可接管', () => {
  const dir = temp()
  const path = join(dir, 'jable.lock')
  const lock = acquireLock(path, { pid: process.pid, label: 'test' })
  assert.equal(lock.ok, true)
  assert.equal(readLockPid(path), process.pid)

  const busy = acquireLock(path, { pid: process.ppid, label: 'other' })
  assert.equal(busy.ok, false)
  assert.equal(busy.reason, 'running')
  assert.equal(busy.holder, process.pid)
  assert.match(lockBusyMessage(path, process.pid), /MH_LOCK/)

  assert.equal(lock.release(), true)
  assert.equal(existsSync(path), false)

  // 伪造一把「持锁进程早已不在」的锁
  writeFileSync(path, '99999999 died\n')
  const stale = acquireLock(path, { pid: process.pid, label: 'takeover' })
  assert.equal(stale.ok, true)
  assert.equal(stale.stale, true)
  stale.release()
  assert.equal(existsSync(path), false)
})

test('抢锁失败退出码 99 与 cron 的 flock -E 99 一致', () => {
  assert.equal(EXIT_LOCK_BUSY, 99)
  assert.equal(isPidAlive(process.pid), true)
  assert.equal(isPidAlive(0), false)
  assert.equal(isPidAlive(99999999), false)
})

// ---------------------------------------------------------------- 远端命令拼接（deploy 注入）

test('shellQuote 单引号转义，白名单拒绝含空格的取值', () => {
  assert.equal(shellQuote('a'), "'a'")
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
  assert.equal(assertSafeToken('HOST', 'hk'), 'hk')
  assert.throws(() => assertSafeToken('HOST', 'hk; rm -rf /'), /含有不允许的字符/)
  assert.throws(() => assertSafeToken('MODE', ''), /含有不允许的字符/)
  assert.equal(remoteEnvPrefix({ MH_SHARD: '0/2', EMPTY: '' }), "MH_SHARD='0/2'")
})

// ---------------------------------------------------------------- 成人模式单一来源

test('成人模式默认 subscription，优先级 --mode > MH_ADULT_MODE > 默认', () => {
  assert.equal(ADULT_MODE_DEFAULT, 'subscription')
  assert.deepEqual(ADULT_MODES, ['free', 'subscription', 'paid'])
  assert.deepEqual(resolveAdultMode({ flag: 'paid', env: {} }), { ok: true, mode: 'paid', source: 'flag' })
  assert.deepEqual(resolveAdultMode({ flag: '', env: { MH_ADULT_MODE: 'free' } }), { ok: true, mode: 'free', source: 'env' })
  assert.deepEqual(resolveAdultMode({ flag: '', env: {} }), { ok: true, mode: 'subscription', source: 'default' })
  assert.equal(resolveAdultMode({ flag: 'trial', env: {} }).ok, false)
  assert.equal(resolveAdultMode({ flag: '', env: { MH_ADULT_MODE: 'freeish' } }).ok, false)
})

test('adult-mode 命令行为 shell 提供默认值与校验', () => {
  const printed = run('adult-mode.mjs', ['--print-default'])
  assert.equal(printed.code, 0)
  assert.equal(printed.stdout.trim(), 'subscription')

  const bad = run('adult-mode.mjs', ['--validate', 'whatever'])
  assert.equal(bad.code, 2)
  assert.match(bad.stderr, /非法的成人频道模式/)
})

// ---------------------------------------------------------------- 导入守卫（纯函数）

test('--max-left 必须是正整数分钟，0 与负数报错而不是静默空跑', () => {
  assert.deepEqual(parseMaxLeftMinutes(''), { ok: true, minutes: 30, seconds: 1800, defaulted: true })
  assert.deepEqual(parseMaxLeftMinutes('45'), { ok: true, minutes: 45, seconds: 2700, defaulted: false })
  for (const bad of ['0', '-5', '1.5', 'abc']) {
    const parsed = parseMaxLeftMinutes(bad)
    assert.equal(parsed.ok, false, `应拒绝 ${bad}`)
    assert.match(parsed.message, /--max-left/)
  }
})

test('集号清理的三条下限：导出非空、非标题认领、导出集数不少于库内', () => {
  assert.equal(shouldPruneEpisodes({ exportedNos: [], dbNos: [1, 2, 3] }), false)
  assert.equal(shouldPruneEpisodes({ exportedNos: [1], dbNos: [1, 2, 3] }), false)
  assert.equal(shouldPruneEpisodes({ exportedNos: [1, 2, 3], dbNos: [1, 2, 3], claimedByTitle: true }), false)
  assert.equal(shouldPruneEpisodes({ exportedNos: [1, 2, 3, 4], dbNos: [1, 2, 3] }), true)
})

test('换票只在新票更晚过期时发生', () => {
  assert.equal(shouldAdoptTicket({ currentExpiry: 100, candidateExpiry: 200 }), true)
  assert.equal(shouldAdoptTicket({ currentExpiry: 200, candidateExpiry: 100 }), false)
  assert.equal(shouldAdoptTicket({ currentExpiry: 0, candidateExpiry: 0 }), false)
})

test('番号归一化与 LIKE 转义', () => {
  assert.equal(normalizeCodeKey('abc_123'), 'ABC-123')
  assert.equal(normalizeCodeKey(' ABC-123 '), 'ABC-123')
  assert.equal(escapeLike('100%_a\\b'), '100\\%\\_a\\\\b')
  assert.equal(likeContains('a%b'), '%a\\%b%')
})

test('退出码区分部分失败与整轮失败', () => {
  assert.equal(exitCodeFor({ ok: 3, failed: 0 }), 0)
  assert.equal(exitCodeFor({ ok: 3, failed: 1 }), 1)
  assert.equal(exitCodeFor({ ok: 0, failed: 2 }), 2)
  assert.equal(exitCodeHint(0), '')
  assert.match(exitCodeHint(1), /部分失败/)
  assert.match(exitCodeHint(2), /整轮失败/)
})

// ---------------------------------------------------------------- HLS master 重写

test('rewriteMaster 保留原 VERSION 且只留一条 DEFAULT=YES', () => {
  const source = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720',
    '720p/index.m3u8',
    '',
  ].join('\n')
  const tracks = [
    { kind: 'audio', language: 'zho', label: '国语', is_default: 1, uri: 'audio/0.m3u8' },
    { kind: 'audio', language: 'jpn', label: '日语', is_default: 1, uri: 'audio/1.m3u8' },
  ]
  const master = rewriteMaster(source, tracks)
  assert.match(master, /^#EXT-X-VERSION:6$/m)
  assert.equal((master.match(/DEFAULT=YES/g) ?? []).length, 1)
  assert.match(master, /TYPE=AUDIO/)
  assert.match(master, /720p\/index\.m3u8/)
  assert.equal(masterVersionOf(source), 6)
  assert.equal(masterVersionOf('#EXTM3U\n'), null)
  assert.throws(() => rewriteMaster('#EXTM3U\n', []), /没有清晰度流/)
})

// ---------------------------------------------------------------- 打包守卫

test('打包守卫递归识别 .env*，旧的顶层字符串比较已修掉', () => {
  assert.equal(isForbiddenEntry('server/.env'), true)
  assert.equal(isForbiddenEntry('deploy/.env.production'), true)
  assert.equal(isForbiddenEntry('public/.env.local'), true)
  assert.equal(isForbiddenEntry('storage/app.db'), true)
  assert.equal(isForbiddenEntry('node_modules/x/index.js'), true)
  assert.equal(isForbiddenEntry('scripts/push-images.mjs'), false)
  assert.equal(isForbiddenEntry('README.md'), false)
  assert.deepEqual(forbiddenEntries(['b/.env', 'a.mjs', 'storage/x']), ['b/.env', 'storage/x'])
})

// ---------------------------------------------------------------- 原子写

test('writeFileAtomicSync 原子写并可选备份，不留 .tmp 残骸', () => {
  const dir = temp()
  const target = join(dir, 'data.json')
  writeFileAtomicSync(target, '{"a":1}')
  assert.equal(readFileSync(target, 'utf8'), '{"a":1}')
  writeFileAtomicSync(target, '{"a":2}', { backup: true })
  assert.equal(readFileSync(target, 'utf8'), '{"a":2}')
  assert.equal(readFileSync(`${target}.bak`, 'utf8'), '{"a":1}')
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
})

// ---------------------------------------------------------------- 标签字面匹配

test('标签匹配按字面子串：% 与 _ 不再当通配符', () => {
  assert.equal(isLiteralSubstringMatch('素人_妻', '素人_妻'), true)
  assert.equal(isLiteralSubstringMatch('素人X妻', '素人_妻'), false)
  assert.equal(isLiteralSubstringMatch('100%爱情', '100%'), true)
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT, scope TEXT)')
    const insert = db.prepare('INSERT INTO tags (name, scope) VALUES (?, ?)')
    insert.run('素人_妻', 'adult')
    insert.run('素人X妻', 'adult')
    const rows = db.prepare(TAG_MATCH_SQL).all('adult', '素人_妻', '素人_妻')
    assert.equal(rows.length, 1)
    assert.equal(db.prepare('SELECT name FROM tags WHERE id = ?').get(rows[0].id).name, '素人_妻')
  } finally {
    db.close()
  }
})

// ---------------------------------------------------------------- import-catalog 参数规划（P0-5）

test('import-catalog 无参数只打印帮助，--reset 需要确认', () => {
  assert.deepEqual(planCli([]).action, 'help')
  assert.equal(HELP_TEXT.includes('不带参数只打印本帮助'), true)
  assert.equal(HELP_TEXT.includes('--reset'), true)

  const blocked = planCli(['--reset'], { env: {}, isDefaultDb: true })
  assert.equal(blocked.action, 'reset')
  assert.equal(blocked.confirm.ok, false)
  assert.equal(blocked.requireBoth, false)

  const allowed = planCli(['--reset'], { env: { [CONFIRM_ENV]: '1' }, isDefaultDb: true })
  assert.equal(allowed.confirm.ok, true)

  const otherDb = planCli(['--reset', '--yes'], { env: {}, isDefaultDb: false })
  assert.equal(otherDb.confirm.ok, false)
  assert.equal(otherDb.requireBoth, true)
  assert.deepEqual(otherDb.confirm.missing, [CONFIRM_ENV])
})

test('import-catalog 未知参数与纯选项组合都有确定动作', () => {
  assert.equal(planCli(['--nope']).action, 'unknown')
  assert.equal(planCli(['--list']).action, 'list')
  assert.equal(planCli(['--check']).action, 'check')
  assert.equal(planCli(['--dry']).action, 'help')
  assert.equal(planCli(['--build', '--dry']).action, 'build')
  assert.deepEqual(onlyList(['--only', 'a', '--only=b']), ['a', 'b'])
  assert.equal(valueOf(['--only', 'a'], '--only', ''), 'a')
})

test('import-catalog 无参数运行只打印帮助、不建目录（真跑一次）', () => {
  const root = tempRoot()
  const result = run('import-catalog.mjs', [], { MH_ROOT: root })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /用法：node scripts\/import-catalog\.mjs/)
  assert.equal(existsSync(join(root, 'storage')), false, '无参数不应创建 storage 目录')
})

test('import-catalog --reset 没有确认时拒绝执行且不改库', () => {
  const root = tempRoot()
  const result = run('import-catalog.mjs', ['--reset'], { MH_ROOT: root })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /拒绝执行/)
  assert.match(result.stderr, /MH_CONFIRM_RESET/)
  assert.equal(existsSync(join(root, 'storage')), false)
})

test('import-catalog --dry --reset 即使确认了也只打印计划', () => {
  const root = tempRoot()
  const result = run('import-catalog.mjs', ['--reset', '--yes', '--dry'], { MH_ROOT: root, MH_CONFIRM_RESET: '1' })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /\[dry\]/)
  assert.equal(existsSync(join(root, 'storage')), false, '--dry 不应创建目录')
})

// ---------------------------------------------------------------- reset-db 确认门

test('reset-db 无确认时退出码 1 且文件都还在', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  writeFileSync(dbPath, 'x')
  mkdirSync(join(root, 'storage', 'remote-cache'), { recursive: true })
  writeFileSync(join(root, 'storage', 'remote-cache', 'a.bin'), 'x')

  const result = run('reset-db.mjs', [], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /拒绝执行/)
  assert.match(result.stderr, /storage/)
  assert.equal(existsSync(dbPath), true)
  assert.equal(existsSync(join(root, 'storage', 'remote-cache', 'a.bin')), true)
})

test('reset-db --yes 会连 images、remote-cache 与 -journal 一起清理', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  for (const name of ['app.db', 'app.db-journal', 'app.db-wal']) writeFileSync(join(root, 'storage', name), 'x')
  mkdirSync(join(root, 'storage', 'remote-cache'), { recursive: true })
  writeFileSync(join(root, 'storage', 'remote-cache', 'a.bin'), 'x')
  mkdirSync(join(root, 'storage', 'images'), { recursive: true })
  writeFileSync(join(root, 'storage', 'images', 'cover.jpg'), 'x')

  const result = run('reset-db.mjs', ['--yes'], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(existsSync(dbPath), false)
  assert.equal(existsSync(join(root, 'storage', 'app.db-journal')), false)
  assert.equal(existsSync(join(root, 'storage', 'remote-cache')), false)
  assert.equal(existsSync(join(root, 'storage', 'images')), false)
})

// ---------------------------------------------------------------- copy-frontend-assets

test('copy-frontend-assets 找不到源目录时报错退出 1（不再静默成功）', () => {
  const root = tempRoot()
  const result = run('copy-frontend-assets.mjs', [], { MH_ROOT: root })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /源目录不存在/)
})

test('copy-frontend-assets 以仓库根为基准输出 dist 路径', () => {
  const source = read('scripts/copy-frontend-assets.mjs')
  assert.match(source, /repoRoot\(\)/)
  assert.match(source, /assertRepoRoot/)
  assert.doesNotMatch(source, /await mkdir\('dist\/client'/)
})

// ---------------------------------------------------------------- jable-import

test('jable-import --max-left 0 / 负数直接报错退出 2', () => {
  const root = tempRoot()
  mkdirSync(join(root, 'storage'), { recursive: true })
  // 库交给 server/db.mjs 自己初始化（全新空库），避免夹具缺列导致建表就失败
  const dbPath = join(root, 'storage', 'app.db')
  for (const bad of ['0', '-5']) {
    const result = run('jable-import.mjs', ['--refresh', '--max-left', bad], { MH_ROOT: root, MH_DB: dbPath })
    assert.equal(result.code, 2, `--max-left ${bad} 应退出 2：${result.stderr}`)
    assert.match(result.stderr, /--max-left/)
  }
})

test('jable-import 覆盖两批 CDN 域名并归一化番号查重', () => {
  const source = read('scripts/jable-import.mjs')
  assert.match(source, /CDN_HOSTS = \['mushroomtrack\.com', 'alonestreaming\.com'\]/)
  assert.match(source, /CDN_SQL/)
  assert.match(source, /upper\(replace\(sub_title, '_', '-'\)\)/)
  assert.equal((source.match(/CDN_SQL/g) ?? []).length >= 2, true, 'refreshTargets 与 scoreTargets 都应使用 CDN_SQL')
  assert.match(source, /markGone\(url, \{ persist = !dry \}/)
  assert.match(source, /process\.exitCode = EXIT_LOCK_BUSY|exitCode = EXIT_LOCK_BUSY/)
  assert.match(source, /shouldAdoptTicket/)
  assert.match(source, /exitCodeFor\(totals\)/)
})

// ---------------------------------------------------------------- adult-export

function seedExportDb(root) {
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = makeDb(dbPath)
  db.exec(`
    ALTER TABLE episodes ADD COLUMN remote_url TEXT;
    ALTER TABLE episodes ADD COLUMN remote_referer TEXT;
  `)
  db.prepare("INSERT INTO dramas (title, sub_title, is_adult, source_key) VALUES ('片名', 'ABC-123', 1, 'jable:ABC-123')").run()
  db.prepare("INSERT INTO episodes (drama_id, no, remote_url) VALUES (1, 1, 'https://cdn.x/hls/abc/1999999999/1/1.m3u8')").run()
  db.close()
  return dbPath
}

test('adult-export --dry 不写文件，也不再生成叫 --dry 的输出文件', () => {
  const root = tempRoot()
  const dbPath = seedExportDb(root)
  const out = join(root, 'storage', 'adult-export.json')
  const result = run('adult-export.mjs', ['--dry'], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /\[dry\] 不写文件/)
  assert.equal(existsSync(out), false)
  assert.equal(existsSync(join(ROOT, '--dry')), false)
})

test('adult-export 原子写目标文件，内容可解析且无 .tmp 残留', () => {
  const root = tempRoot()
  const dbPath = seedExportDb(root)
  const out = join(root, 'out.json')
  const result = run('adult-export.mjs', [out], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /导出 1 部/)
  const payload = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(payload.length, 1)
  assert.equal(payload[0].drama.source_key, 'jable:ABC-123')
  assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.tmp')), [])
})

// ---------------------------------------------------------------- adult-migrate（P0-6）

function writeExport(file, items) {
  writeFileSync(file, JSON.stringify(items, null, 1))
  return file
}

test('adult-migrate --dry 只打印 DDL，不给临时库加列', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  makeDb(dbPath).close()
  const before = columnsOf(dbPath, 'episodes')
  assert.equal(before.includes('remote_url'), false)

  const file = writeExport(join(root, 'export.json'), [
    { drama: { title: '片名', sub_title: 'ABC-123', is_adult: 1, source_key: 'jable:ABC-123' }, episodes: [{ no: 1 }], tags: [] },
  ])
  const result = run('adult-migrate.mjs', [file, '--dry'], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /\[dry\] 将执行 DDL/)
  assert.match(result.stdout, /ALTER TABLE episodes ADD COLUMN remote_url/)
  assert.equal(columnsOf(dbPath, 'episodes').includes('remote_url'), false, '--dry 之后不应多出列')
  assert.equal(countOf(dbPath, 'SELECT count(*) AS n FROM dramas'), 0)
})

test('adult-migrate 真实运行时 DDL 与数据一起提交', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  makeDb(dbPath).close()
  const file = writeExport(join(root, 'export.json'), [
    { drama: { title: '片名', sub_title: 'ABC-123', is_adult: 1, source_key: 'jable:ABC-123' }, episodes: [{ no: 1, remote_url: 'https://cdn/hls/a/1999999999/1/1.m3u8' }], tags: [] },
  ])
  const result = run('adult-migrate.mjs', [file], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(columnsOf(dbPath, 'episodes').includes('remote_url'), true)
  assert.equal(columnsOf(dbPath, 'dramas').includes('source_key'), true)
  assert.equal(countOf(dbPath, 'SELECT count(*) AS n FROM dramas'), 1)
  assert.equal(countOf(dbPath, 'SELECT count(*) AS n FROM episodes'), 1)
})

test('adult-migrate 只按 source_key 认领，标题相同也不会覆盖别人的剧', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = makeDb(dbPath)
  db.prepare("INSERT INTO dramas (title, sub_title, is_adult, source_key) VALUES ('同作者合集', 'AI成人短剧 · 作者', 1, 'jable:AAA-001')").run()
  db.close()

  // 同标题、无 source_key → 必须插新行，而不是认领上面那部
  const file = writeExport(join(root, 'export.json'), [
    { drama: { title: '同作者合集', sub_title: 'AI成人短剧 · 作者', is_adult: 1 }, episodes: [{ no: 1 }], tags: [] },
  ])
  const result = run('adult-migrate.mjs', [file], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /无 source_key/)
  assert.equal(countOf(dbPath, 'SELECT count(*) AS n FROM dramas'), 2)
  assert.equal(countOf(dbPath, "SELECT count(*) AS n FROM dramas WHERE source_key = 'jable:AAA-001'"), 1)
})

test('adult-migrate 导出集数少于库内集数时跳过残留集清理', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = makeDb(dbPath)
  db.prepare("INSERT INTO dramas (title, is_adult, source_key) VALUES ('40 集短剧', 1, 'huangguo:9001')").run()
  for (let no = 1; no <= 5; no += 1) db.prepare('INSERT INTO episodes (drama_id, no) VALUES (1, ?)').run(no)
  db.close()

  const file = writeExport(join(root, 'export.json'), [
    { drama: { title: '40 集短剧', is_adult: 1, source_key: 'huangguo:9001' }, episodes: [{ no: 1 }], tags: [] },
  ])
  const result = run('adult-migrate.mjs', [file], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /跳过残留集清理/)
  assert.equal(countOf(dbPath, 'SELECT count(*) AS n FROM episodes'), 5, '导出比库内少时绝不能删集')
})

test('adult-migrate 导出集数不少于库内时才清理源站已删掉的集', () => {
  const root = tempRoot()
  const dbPath = join(root, 'storage', 'app.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = makeDb(dbPath)
  db.prepare("INSERT INTO dramas (title, is_adult, source_key) VALUES ('换集短剧', 1, 'huangguo:9002')").run()
  for (let no = 1; no <= 5; no += 1) db.prepare('INSERT INTO episodes (drama_id, no) VALUES (1, ?)').run(no)
  db.close()

  const file = writeExport(join(root, 'export.json'), [
    {
      drama: { title: '换集短剧', is_adult: 1, source_key: 'huangguo:9002' },
      episodes: [{ no: 1 }, { no: 2 }, { no: 3 }, { no: 4 }, { no: 6 }],
      tags: [],
    },
  ])
  const result = run('adult-migrate.mjs', [file], { MH_ROOT: root, MH_DB: dbPath })
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /清理残留集 1 条/)
  assert.deepEqual(
    (() => {
      const check = new DatabaseSync(dbPath, { readOnly: true })
      try {
        return check.prepare('SELECT no FROM episodes ORDER BY no').all().map((row) => row.no)
      } finally {
        check.close()
      }
    })(),
    [1, 2, 3, 4, 6]
  )
})

// ---------------------------------------------------------------- 其余脚本的静态保证

test('huangguo-import 同片换 id 命中后把历史条目置 hidden，dry 不下载素材', () => {
  const source = read('scripts/huangguo-import.mjs')
  assert.match(source, /hideDuplicateRows/)
  assert.match(source, /status = 'hidden'/)
  assert.match(source, /TAG_MATCH_SQL/)
  assert.doesNotMatch(source, /LIKE \? OR \? LIKE '%' \|\| name \|\| '%'/)
  assert.match(source, /shouldPruneEpisodes/)
  assert.match(source, /exitCodeFor/)
  const dryIndex = source.indexOf("if (dry) return { dry: true, meta }")
  const artworkIndex = source.indexOf('await grabArtwork(meta)')
  assert.equal(dryIndex > 0 && artworkIndex > 0 && dryIndex < artworkIndex, true, 'dry 必须在下载封面之前返回')
})

test('archive-import 标签唯一冲突复用已有 id，并清理源站已删的集', () => {
  const source = read('scripts/archive-import.mjs')
  assert.match(source, /UNIQUE/)
  assert.match(source, /SELECT id, scope FROM tags WHERE name = \?/)
  assert.match(source, /shouldPruneEpisodes/)
  assert.match(source, /exitCodeFor/)
})

test('push-images 区分 ssh 失败、清理临时目录、远端命令走白名单与引号', () => {
  const source = read('scripts/push-images.mjs')
  assert.doesNotMatch(source, /2>\/dev\/null \|\| true/)
  assert.match(source, /No such file or directory/)
  assert.match(source, /assertSafeToken\('HOST'/)
  assert.match(source, /assertSafeToken\('REMOTE_APP'/)
  assert.match(source, /shellQuote\(/)
  assert.match(source, /finally/)
  assert.match(source, /rmSync\(tmp/)
})

test('migrate-movie-episodes 整库单事务并用保存点隔离单片失败', () => {
  const source = read('scripts/migrate-movie-episodes.mjs')
  assert.match(source, /db\.exec\('BEGIN'\)/)
  assert.match(source, /SAVEPOINT mh_movie/)
  assert.match(source, /ROLLBACK TO/)
  assert.match(source, /process\.exitCode = 1/)
})

test('normalize-taxonomy 改完题材后复跑短剧成人不变量', () => {
  const source = read('scripts/normalize-taxonomy.mjs')
  assert.match(source, /enforceAdultInvariant/)
  assert.match(source, /UPDATE dramas SET is_adult = 1/)
  const order = source.indexOf('normalizeDramas(data)') >= 0 ? source.indexOf('normalizeDramas(data)') : source.indexOf('normalizeDramas(')
  assert.equal(order >= 0, true)
})

test('package-deploy 用递归路径段判定，而非根级字符串前缀', () => {
  const source = read('scripts/package-deploy.mjs')
  assert.match(source, /forbiddenEntries/)
  assert.doesNotMatch(source, /\['node_modules\/', 'storage\/', 'dist\/', '\.env'\]/)
})

// ---------------------------------------------------------------- deploy 静态检查

test('sync-adult.cmd：push-images 后必须判 errorlevel，且不再写死 --mode', () => {
  const source = read('deploy/sync-adult.cmd')
  assert.match(source, /node scripts\\push-images\.mjs[\s\S]{0,200}?if errorlevel 1/)
  assert.doesNotMatch(source, /--mode subscription/)
  assert.doesNotMatch(source, /--mode free/)
  assert.match(source, /adult-mode\.mjs --print-default/)
  assert.match(source, /findstr \/r/)
})

test('sync-adult.sh：默认模式取自单一来源，远端参数走白名单与引号', () => {
  const source = read('deploy/sync-adult.sh')
  assert.match(source, /MODE=\$\{MODE:-\$\(node scripts\/adult-mode\.mjs --print-default\)\}/)
  assert.doesNotMatch(source, /MODE=\$\{MODE:-free\}/)
  assert.match(source, /want_host/)
  assert.match(source, /want_abs_path/)
  assert.match(source, /q "?\$REMOTE_APP/)
})

test('cron：两轮刷新都用 flock -E 99，且各用独立进程锁', () => {
  const source = read('deploy/cron.d/video-refresh')
  const lines = source.split('\n').filter((line) => line.includes('flock -n'))
  assert.equal(lines.length, 2)
  for (const line of lines) assert.match(line, /flock -n -E 99 /)
  assert.match(source, /MH_LOCK=\/opt\/video-rr\/storage\/\.jable-import-0\.lock/)
  assert.match(source, /MH_LOCK=\/opt\/video-rr\/storage\/\.jable-import-1\.lock/)
  assert.equal(source.endsWith('\n'), true, 'cron 文件末尾必须有换行')
})

test('续期 cron 只刷新已有直链，不导新片，并给播放让路', () => {
  const source = read('deploy/cron.d/video-renew')
  const lines = source.split('\n').filter((line) => line.includes('jable-import.mjs'))
  assert.equal(lines.length, 1)
  assert.match(lines[0], /--refresh/)
  assert.match(lines[0], /--max-left 60/)
  assert.match(lines[0], /--no-images/)
  assert.match(lines[0], /--no-preview/)
  assert.match(lines[0], /nice -n 19/)
  assert.match(lines[0], /ionice -c 3/)
  assert.match(lines[0], /\.jable-chrome-renew/)
  assert.match(lines[0], /\.jable-renew\.lock/)
  assert.doesNotMatch(lines[0], /--page|--skip-existing|--every/)
  assert.equal(source.endsWith('\n'), true, 'cron 文件末尾必须有换行')
})

test('jable-health 把 99 当“上一轮仍在跑”，并按 rename 链轮转日志', () => {
  const source = read('scripts/jable-health.mjs')
  assert.match(source, /EXIT_LOCK_BUSY|99/)
  assert.match(source, /refreshLocked/)
  assert.match(source, /renameSync\(LOG/)
  assert.doesNotMatch(source, /buffer\.subarray\(size - LOG_KEEP_BYTES\)/)
  assert.match(source, /describeDbTarget/)
})

test('video-rr.service 不再以 root 运行且内存上限容得下上传 + 转码', () => {
  const source = read('deploy/video-rr.service')
  assert.match(source, /^User=/m)
  assert.match(source, /^Group=/m)
  assert.match(source, /^MemoryHigh=/m)
  assert.match(source, /^MemoryMax=6G$/m)
  assert.doesNotMatch(source, /^MemoryMax=3G$/m)
  assert.match(source, /useradd --system/)
})

test('install-hk.sh：注入失败报错退出、健康检查断言 200、http2 冲突检测', () => {
  const source = read('deploy/install-hk.sh')
  assert.match(source, /sys\.exit\(3\)/)
  assert.match(source, /nginx include 注入失败/)
  assert.match(source, /want_code \/video\/ 200/)
  assert.match(source, /health_failed/)
  assert.match(source, /listen\[\^;\]\*http2/)
  assert.match(source, /sed -i '\/\^http2 on;\$\/d'/)
})

test('nginx 片段给 http2 指令写了与旧 listen 参数冲突的说明', () => {
  const source = read('deploy/nginx-video.snippet.conf')
  assert.match(source, /http2 on;/)
  assert.match(source, /duplicate listen options/)
})

test('.gitattributes：cmd 必须 CRLF 且规则排在 deploy/* 之后', () => {
  const lines = read('.gitattributes')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  const cmdIndex = lines.findIndex((line) => line.startsWith('*.cmd'))
  const deployIndex = lines.findIndex((line) => line.startsWith('deploy/*'))
  assert.equal(cmdIndex >= 0, true, '缺少 *.cmd 规则')
  assert.equal(deployIndex >= 0, true, '缺少 deploy/* 规则')
  assert.equal(cmdIndex > deployIndex, true, '*.cmd 必须排在 deploy/* 之后才能覆盖 LF')
  assert.match(lines[cmdIndex], /text eol=crlf/)
  assert.equal(lines.some((line) => /^\*\.(mjs|sh)\s+text eol=lf$/.test(line)), true)
})

test('import-catalog 的帮助与确认文案写明非默认库要双重确认', () => {
  assert.match(HELP_TEXT, /双重确认/)
  assert.match(read('scripts/import-catalog.mjs'), /describeDbTarget/)
})
