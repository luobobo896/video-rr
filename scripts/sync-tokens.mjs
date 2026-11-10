/**
 * 设计令牌同步：shared/tokens.css 是唯一来源，
 * 生成 public/tokens.css（C 端品牌）与 admin/tokens.css（B 端品牌）。
 * 用法：node scripts/sync-tokens.mjs   （改完 shared 必跑）
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(ROOT, 'shared', 'tokens.css'), 'utf8')

const BRAND_ADMIN = `/* @brand-start */
  /* B 端（运营台）：功能蓝，几何令牌与 C 端完全一致 */
  --bg: #0d0f14;
  --bg-soft: #11151d;
  --bg-elev: #141821;
  --surface: #1a1f2b;
  --surface-2: #1a1f2b;
  --panel: #141821;
  --panel-2: #1a1f2b;
  --line: rgba(255, 255, 255, 0.08);
  --line-strong: rgba(255, 255, 255, 0.16);
  --text: #e8ebf2;
  --text-2: #98a0b3;
  --text-3: #6b7484;
  --brand: #4f7cff;
  --brand-2: #22d3ee;
  --brand-contrast: #06121a;
  --vip: #f59e0b;
  --ok: #22c55e;
  --warn: #f59e0b;
  --bad: #ef4444;
  --shadow: 0 12px 36px rgba(0, 0, 0, 0.5);
  --sans: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
/* @brand-end */`

const brandPattern = /\/\* @brand-start \*\/[\s\S]*?\/\* @brand-end \*\//
if (!brandPattern.test(source)) throw new Error('shared/tokens.css 缺少 @brand-start / @brand-end 标记')

const cEnd = source
const bEnd = source.replace(brandPattern, BRAND_ADMIN)

writeFileSync(join(ROOT, 'public', 'tokens.css'), cEnd, 'utf8')
writeFileSync(join(ROOT, 'admin', 'tokens.css'), bEnd, 'utf8')

const hash = createHash('sha256').update(source).digest('hex').slice(0, 12)
mkdirSync(join(ROOT, 'shared'), { recursive: true })
writeFileSync(join(ROOT, 'shared', 'tokens.version.json'), JSON.stringify({
  source: 'shared/tokens.css',
  hash,
  generated: ['public/tokens.css', 'admin/tokens.css'],
  generatedAt: new Date().toISOString(),
}, null, 2), 'utf8')

console.log(`tokens 同步完成 hash=${hash}`)
console.log(`  public/tokens.css  ${cEnd.length} bytes（C 端品牌）`)
console.log(`  admin/tokens.css   ${bEnd.length} bytes（B 端品牌）`)
