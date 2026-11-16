/**
 * 用本机 EXL3 模型给已入库的成人片批量写中文简介。
 *
 *   node scripts/jable-blurb.mjs            # 只补没写过的
 *   node scripts/jable-blurb.mjs --limit 5  # 先试 5 条
 *   node scripts/jable-blurb.mjs --dry      # 只打印，不写库
 *   node scripts/jable-blurb.mjs --force    # 全部重写
 *   node scripts/jable-blurb.mjs --jable    # 只处理 jable 条目（sub_title 带番号）
 *
 * 走 OpenAI 兼容端点（默认 127.0.0.1:5000），不需要 ai.bat 在 PATH 里。
 * 端点与模型可用 AI_BASE / AI_MODEL / AI_KEY 覆盖。
 */
import { DatabaseSync } from 'node:sqlite'

const BASE = (process.env.AI_BASE || 'http://127.0.0.1:5000/v1').replace(/\/+$/, '')
const MODEL = process.env.AI_MODEL || 'qwen3.8-27b-abliterated-exl3'
const KEY = process.env.AI_KEY || 'local-exl3'
const MARK = '簡介：'

const argv = process.argv.slice(2)
const argValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`))
  if (eq) return eq.slice(name.length + 1)
  const at = argv.indexOf(name)
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith('--') ? argv[at + 1] : ''
}
const limit = Number(argValue('--limit') || 0) || 0
const dry = argv.includes('--dry')
const force = argv.includes('--force')
// jable 条目的 sub_title 形如 `MIKR-134 · 女優`；黄果短剧没有番号，别混进来
const jableOnly = argv.includes('--jable')
const hasCode = (row) => /^[A-Za-z0-9_]+-\d+ · /.test(String(row.sub_title ?? ''))

const db = new DatabaseSync('storage/app.db')
const rows = db.prepare(`SELECT id, sub_title, title, description FROM dramas WHERE is_adult = 1 ORDER BY id`).all()
const todo = (force ? rows : rows.filter((r) => !String(r.description ?? '').includes(MARK)))
  .filter((r) => !jableOnly || hasCode(r))
  .slice(0, limit || undefined)
console.log(`待写简介 ${todo.length} 条（总 ${rows.length} 条，模型 ${MODEL}）`)
if (!todo.length) process.exit(0)

function fields(row) {
  const get = (label) => new RegExp(`${label}：(.+)`).exec(String(row.description ?? ''))?.[1]?.trim() ?? ''
  return {
    code: (String(row.sub_title ?? '').split('·')[0] ?? '').trim(),
    model: (String(row.sub_title ?? '').split('·')[1] ?? '').trim(),
    categories: get('類別'),
    tags: get('標籤'),
    title: String(row.title ?? '').trim(),
  }
}

function promptOf(f) {
  return `你在给成人影片站点录入资料。根据下面的字段写一段中文简介。

要求：
- 2 到 3 句，60 到 110 字；
- 写清楚场景设定、人物关系和主要看点；
- 不要复述番号，不要照搬日文原题的句子；
- 不用感叹号，不写评价和推销口吻；
- 只输出简介正文，不要任何前后缀、不要 markdown。

番号：${f.code}
女優：${f.model}
類別：${f.categories}
標籤：${f.tags}
日文原题：${f.title}`
}

function clean(text) {
  return String(text ?? '')
    .replace(/^```[\s\S]*?\n/, '').replace(/```$/g, '')
    .replace(new RegExp(`^\\s*${MARK}\\s*`), '')
    .replace(/^\s*简介[:：]/, '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

async function ask(f) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: promptOf(f) }],
      max_tokens: 300,
      temperature: 0.8,
      top_p: 0.8,
      stream: false,
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`)
  const data = await res.json()
  return clean(data.choices?.[0]?.message?.content ?? '')
}

let ok = 0
let failed = 0
const update = db.prepare('UPDATE dramas SET description = ?, updated_at = datetime(\'now\') WHERE id = ?')

async function one(row, slot) {
  const f = fields(row)
  const label = `[${slot}/${todo.length}] #${row.id} ${f.code || '(无番号)'} ${f.model}`
  const start = Date.now()
  try {
    let text = await ask(f)
    if (text.length < 20) text = await ask(f)
    if (!text) throw new Error('模型返回空文本')
    const seconds = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`${label} (${seconds}s)\n  ${text}`)
    if (!dry) {
      const body = `${MARK}${text}\n\n${row.description ?? ''}`
      update.run(body, row.id)
    }
    ok++
  } catch (error) {
    failed++
    console.log(`${label}\n  ✗ ${error.message}`)
  }
}

// 本地模型单 GPU，3 路左右吞吐最好；再多只会互相排队
const concurrency = Math.max(1, Number(argValue('--concurrency') || 0) || 3)
const queue = [...todo]
let started = 0
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  for (let row = queue.shift(); row; row = queue.shift()) {
    started++
    await one(row, started)
  }
}))

console.log(`\n完成：成功 ${ok}，失败 ${failed}${dry ? '（dry，未写库）' : ''}`)
