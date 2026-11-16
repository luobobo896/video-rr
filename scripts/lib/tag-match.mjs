/**
 * 标签名字匹配：字面子串，别当 LIKE 模式用。
 *
 * 旧实现是 `name LIKE '%' || ? || '%'`，标签里的 `%`/`_` 会被当通配符：
 * 标签「素人_妻」能匹配上「素人X妻」，于是导入的剧被挂到完全无关的题材下面，
 * 而且这种错挂不会报错，只能靠人眼在频道里发现。
 *
 * 这里改用 instr(lower(x), lower(y)) 做字面子串匹配，双向都比，
 * 语义等同「对 %/_ 做转义」，但不需要拼 ESCAPE 子句。
 */

/** `SELECT id FROM tags WHERE ...` 的字面匹配语句；参数顺序 (scope, label, label)。 */
export const TAG_MATCH_SQL =
  "SELECT id FROM tags WHERE scope = ? AND (instr(lower(name), lower(?)) > 0 OR instr(lower(?), lower(name)) > 0) ORDER BY length(name) DESC LIMIT 1"

/** 纯逻辑版：给测试用，语义与 TAG_MATCH_SQL 一致（% 和 _ 都是普通字符）。 */
export function isLiteralSubstringMatch(haystack, needle) {
  const a = String(haystack ?? '').toLowerCase()
  const b = String(needle ?? '').toLowerCase()
  if (!a || !b) return false
  return a.includes(b) || b.includes(a)
}
