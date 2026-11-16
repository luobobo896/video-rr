/**
 * LIKE 模式的转义与参数拼装。
 * 用户输入直接塞进 `%...%` 时，`%` 和 `_` 会被 SQLite 当成通配符：
 * 搜 "100%" 变成"以 100 开头"，搜 "_" 变成"任意一个字符"，命中集和预期完全不符；
 * 反向也成立——攻击者可以用 `%` 探测表内是否存在某串。统一走这里，SQL 侧记得加 `ESCAPE '\'`。
 */
export const escapeLike = (text) => String(text ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`)

/** 包含匹配用的绑定参数：`%关键词%`。 */
export const likeContains = (text) => `%${escapeLike(text)}%`
