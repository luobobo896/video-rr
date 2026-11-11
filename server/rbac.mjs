/** RBAC：角色/权限/数据域 + 审计日志。 */
import { db } from './db.mjs'
import { buildMenuTree, expandWithAncestors, menuNode } from './db.mjs'

const all = (sql, ...args) => db.prepare(sql).all(...args)
const one = (sql, ...args) => db.prepare(sql).get(...args)

/** 管理员 → { roles: [{id,code,name}], permissions: Set<code> } */
export function loadPrincipal(adminId) {
  const admin = one('SELECT * FROM admins WHERE id = ?', adminId)
  if (!admin || admin.status !== 'active') return undefined
  const roles = all(`SELECT r.* FROM admin_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.admin_id = ?`, adminId)
  const permissions = new Set(
    all(`SELECT DISTINCT rp.permission_code FROM admin_roles ar
      JOIN role_permissions rp ON rp.role_id = ar.role_id WHERE ar.admin_id = ?`, adminId)
      .map((row) => row.permission_code),
  )
  return { admin, roles, permissions }
}

export function hasPermission(principal, code) {
  if (!principal) return false
  if (principal.permissions.has('*')) return true
  return principal.permissions.has(code)
}

/** 任一权限命中即可。 */
export function hasAny(principal, codes) {
  return codes.some((code) => hasPermission(principal, code))
}

export function audit({ actorType = 'admin', actorId, actorName, action, targetType, targetId, before, after, reason, ip, result = 'ok' }) {
  db.prepare(`INSERT INTO audit_logs (actor_type, actor_id, actor_name, action, target_type, target_id, before_json, after_json, reason, ip, result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    actorType, actorId ?? null, actorName ?? null, action,
    targetType ?? null, targetId === undefined ? null : String(targetId),
    before === undefined ? null : JSON.stringify(before).slice(0, 4000),
    after === undefined ? null : JSON.stringify(after).slice(0, 4000),
    reason ?? null, ip ?? null, result,
  )
}

export function listAudit({ limit = 100, offset = 0, action, actorId } = {}) {
  const clauses = []
  const args = []
  if (action) { clauses.push('action LIKE ?'); args.push(`%${action}%`) }
  if (actorId) { clauses.push('actor_id = ?'); args.push(Number(actorId)) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...args, Math.min(500, Number(limit) || 100), Math.max(0, Number(offset) || 0))
}

export function listRoles() {
  return all('SELECT * FROM roles ORDER BY id').map((role) => ({
    ...role,
    permissions: all('SELECT permission_code FROM role_permissions WHERE role_id = ?', role.id).map((row) => row.permission_code),
  }))
}

const normalizeRoleCode = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32)

export function createRole(payload = {}) {
  const code = normalizeRoleCode(payload.code)
  const name = String(payload.name ?? '').trim()
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(code)) {
    throw Object.assign(new Error('角色编码需为 2–32 位小写字母、数字或下划线，并以字母开头'), { status: 400 })
  }
  if (!name) throw Object.assign(new Error('角色名称必填'), { status: 400 })
  if (one('SELECT id FROM roles WHERE code = ?', code)) {
    throw Object.assign(new Error('角色编码已存在'), { status: 409 })
  }
  const info = db.prepare('INSERT INTO roles (code, name, description, is_system) VALUES (?, ?, ?, 0)')
    .run(code, name.slice(0, 50), String(payload.description ?? '').trim().slice(0, 200) || null)
  return listRoles().find((role) => role.id === Number(info.lastInsertRowid))
}

export function updateRole(roleId, payload = {}) {
  const role = one('SELECT * FROM roles WHERE id = ?', Number(roleId))
  if (!role) throw Object.assign(new Error('角色不存在'), { status: 404 })
  const name = String(payload.name ?? role.name).trim()
  if (!name) throw Object.assign(new Error('角色名称必填'), { status: 400 })
  db.prepare('UPDATE roles SET name = ?, description = ? WHERE id = ?')
    .run(name.slice(0, 50), String(payload.description ?? role.description ?? '').trim().slice(0, 200) || null, role.id)
  return listRoles().find((item) => item.id === role.id)
}

export function deleteRole(roleId) {
  const role = one('SELECT * FROM roles WHERE id = ?', Number(roleId))
  if (!role) throw Object.assign(new Error('角色不存在'), { status: 404 })
  if (role.is_system) throw Object.assign(new Error('内置角色不能删除'), { status: 400 })
  const used = one('SELECT COUNT(*) AS n FROM admin_roles WHERE role_id = ?', role.id)?.n ?? 0
  if (used > 0) {
    throw Object.assign(new Error(`该角色仍分配给 ${used} 个后台账号，请先解除分配`), { status: 409 })
  }
  db.prepare('DELETE FROM roles WHERE id = ?').run(role.id)
  return { ok: true, id: role.id, code: role.code }
}

export function listPermissionCatalog() {
  return all('SELECT * FROM permissions ORDER BY domain, sort, code')
}

/* ---------------- 树形菜单权限 ---------------- */

/** 只读的完整菜单树（前端 el-tree 的数据源）。 */
export function menuTree() {
  return buildMenuTree()
}

/** 角色已勾选的菜单/按钮 code（含父级，前端回显用）。 */
export function roleMenuCodes(roleId) {
  return all('SELECT permission_code FROM role_permissions WHERE role_id = ?', Number(roleId)).map((row) => row.permission_code)
}

/** 角色 + 完整树 + 已勾选集合，一次返回，减少前端往返。 */
export function roleMenuBinding(roleId) {
  return {
    roleId: Number(roleId),
    checked: roleMenuCodes(roleId),
    tree: buildMenuTree(),
  }
}

/**
 * 保存角色菜单：入参为勾选 code（前端可只传叶子），
 * 后端自动补齐父级，保证树完整性；目录节点不可单独授权给"只有子节点"的角色。
 */
export function updateRoleMenus(roleId, codes) {
  const normalized = expandWithAncestors((codes ?? []).filter((code) => menuNode(code)))
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(Number(roleId))
    const insert = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
    for (const code of normalized) insert.run(Number(roleId), code)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { roleId: Number(roleId), checked: normalized }
}

export function updateRolePermissions(roleId, codes) {
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(roleId)
    const insert = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_code) VALUES (?, ?)')
    for (const code of codes) insert.run(roleId, code)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return listRoles().find((role) => role.id === Number(roleId))
}

export function listAdmins() {
  return all('SELECT id, username, display_name, status, must_change_password, password_updated_at, created_at FROM admins ORDER BY id').map((admin) => ({
    ...admin,
    mustChangePassword: Boolean(admin.must_change_password),
    roles: all('SELECT r.code, r.name FROM admin_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.admin_id = ?', admin.id),
  }))
}

export function setAdminRoles(adminId, roleCodes) {
  const admin = one('SELECT status FROM admins WHERE id = ?', Number(adminId))
  if (admin?.status === 'active' && isSuper(adminId) && !roleCodes.includes('super_admin')
    && activeAdminsOfRole('super_admin') <= 1) {
    throw Object.assign(new Error('这是最后一个启用中的超级管理员，不能摘掉超管角色'), { status: 400 })
  }
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM admin_roles WHERE admin_id = ?').run(adminId)
    const insert = db.prepare('INSERT OR IGNORE INTO admin_roles (admin_id, role_id) SELECT ?, id FROM roles WHERE code = ?')
    for (const code of roleCodes) insert.run(adminId, code)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return listAdmins().find((admin) => admin.id === Number(adminId))
}

/* ---------------- 后台账号：增删改 + 口令重置 ---------------- */

/** 某个角色当前还有几个在用（用于「不能删掉最后一个超管」这类保护）。 */
export function activeAdminsOfRole(roleCode) {
  return one(`SELECT COUNT(*) AS n FROM admin_roles ar JOIN roles r ON r.id = ar.role_id
    JOIN admins a ON a.id = ar.admin_id WHERE r.code = ? AND a.status = 'active'`, roleCode).n
}

export function createAdmin({ username, displayName, passwordHash, salt, roleCodes = [], mustChange = 1 }) {
  const name = String(username ?? '').trim()
  if (!/^[A-Za-z0-9_.-]{3,32}$/.test(name)) throw Object.assign(new Error('账号需为 3–32 位字母、数字、下划线'), { status: 400 })
  if (one('SELECT id FROM admins WHERE username = ?', name)) throw Object.assign(new Error('该账号已存在'), { status: 409 })
  const info = db.prepare(`INSERT INTO admins (username, password_hash, salt, display_name, status, must_change_password, password_updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, datetime('now'))`).run(name, passwordHash, salt, displayName?.trim() || name, mustChange ? 1 : 0)
  const adminId = Number(info.lastInsertRowid)
  if (roleCodes.length) setAdminRoles(adminId, roleCodes)
  return listAdmins().find((admin) => admin.id === adminId)
}

export function updateAdminBasic(adminId, { displayName, status, roleCodes }) {
  const before = one('SELECT * FROM admins WHERE id = ?', Number(adminId))
  if (!before) throw Object.assign(new Error('管理员不存在'), { status: 404 })
  if (status && !['active', 'disabled'].includes(status)) throw Object.assign(new Error('状态只能是 active 或 disabled'), { status: 400 })
  const nextRoles = Array.isArray(roleCodes) ? roleCodes : null
  // 保护：不允许把唯一启用中的超级管理员停用或摘掉超管角色
  const losesSuper = before.status === 'active'
    && ((status === 'disabled' && activeAdminsOfRole('super_admin') <= 1 && isSuper(before.id))
      || (nextRoles && !nextRoles.includes('super_admin') && activeAdminsOfRole('super_admin') <= 1 && isSuper(before.id)))
  if (losesSuper) throw Object.assign(new Error('这是最后一个启用中的超级管理员，不能停用或摘掉超管角色'), { status: 400 })
  db.prepare('UPDATE admins SET display_name = COALESCE(?, display_name), status = COALESCE(?, status) WHERE id = ?')
    .run(displayName?.trim() ?? null, status ?? null, Number(adminId))
  if (nextRoles) setAdminRoles(Number(adminId), nextRoles)
  return listAdmins().find((admin) => admin.id === Number(adminId))
}

function isSuper(adminId) {
  return Boolean(one(`SELECT 1 AS ok FROM admin_roles ar JOIN roles r ON r.id = ar.role_id
    WHERE ar.admin_id = ? AND r.code = 'super_admin'`, Number(adminId)))
}

export function deleteAdminById(adminId) {
  const admin = one('SELECT * FROM admins WHERE id = ?', Number(adminId))
  if (!admin) throw Object.assign(new Error('管理员不存在'), { status: 404 })
  if (isSuper(adminId) && activeAdminsOfRole('super_admin') <= 1) {
    throw Object.assign(new Error('这是最后一个超级管理员，不能删除'), { status: 400 })
  }
  db.prepare('DELETE FROM admin_roles WHERE admin_id = ?').run(Number(adminId))
  db.prepare('DELETE FROM admins WHERE id = ?').run(Number(adminId))
  return { ok: true, id: Number(adminId), username: admin.username }
}

export function setAdminPassword(adminId, passwordHash, salt, { mustChange = 1 } = {}) {
  const info = db.prepare(`UPDATE admins SET password_hash = ?, salt = ?, must_change_password = ?, password_updated_at = datetime('now')
    WHERE id = ?`).run(passwordHash, salt, mustChange ? 1 : 0, Number(adminId))
  if (!info.changes) throw Object.assign(new Error('管理员不存在'), { status: 404 })
  return { ok: true, id: Number(adminId) }
}

/* ---------------- 后台菜单（与权限独立） ---------------- */

export function listAdminMenus({ includeHidden = true } = {}) {
  const rows = all(`SELECT * FROM admin_menus ${includeHidden ? '' : 'WHERE visible = 1'}
    ORDER BY group_sort, group_key, sort, id`)
  const groups = []
  const index = new Map()
  for (const row of rows) {
    if (!index.has(row.group_key)) {
      const group = { key: row.group_key, label: row.group_label, sort: row.group_sort, items: [] }
      index.set(row.group_key, group)
      groups.push(group)
    }
    index.get(row.group_key).items.push({
      id: row.id,
      label: row.label,
      route: row.route,
      icon: row.icon,
      permCode: row.perm_code,
      sort: row.sort,
      visible: Boolean(row.visible),
      isSystem: Boolean(row.is_system),
      updatedAt: row.updated_at,
    })
  }
  return groups
}

/** 新增或修改一条菜单（id 存在即更新）。路由以 / 开头，权限码可空表示「只要登录就能看」。 */
export function saveAdminMenu(input, id) {
  const label = String(input.label ?? '').trim()
  const route = String(input.route ?? '').trim()
  if (!label) throw Object.assign(new Error('菜单名称必填'), { status: 400 })
  if (!/^\/[A-Za-z0-9/_-]*$/.test(route)) throw Object.assign(new Error('路由需以 / 开头，例如 /dramas'), { status: 400 })
  const groupKey = String(input.groupKey ?? '').trim() || 'custom'
  if (!/^[a-z0-9_-]{1,40}$/.test(groupKey)) {
    throw Object.assign(new Error('分组键只能使用小写字母、数字、下划线或短横线'), { status: 400 })
  }
  const groupLabel = String(input.groupLabel ?? '').trim() || '自定义'
  const permCode = String(input.permCode ?? '').trim() || null
  if (permCode && !one('SELECT code FROM permissions WHERE code = ?', permCode)) {
    throw Object.assign(new Error(`权限码 ${permCode} 不存在，请先在「角色权限」里看到它`), { status: 400 })
  }
  const sort = Number(input.sort ?? 0) || 0
  const groupSort = Number(input.groupSort ?? 0) || 0
  const visible = input.visible === false || input.visible === 0 ? 0 : 1
  if (id) {
    const before = one('SELECT * FROM admin_menus WHERE id = ?', Number(id))
    if (!before) throw Object.assign(new Error('菜单不存在'), { status: 404 })
    db.prepare(`UPDATE admin_menus SET group_key = ?, group_label = ?, group_sort = ?, label = ?, route = ?,
      icon = ?, perm_code = ?, sort = ?, visible = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(groupKey, groupLabel, groupSort, label, route, String(input.icon ?? '').trim() || null, permCode, sort, visible, Number(id))
    return { id: Number(id), before }
  }
  if (one('SELECT id FROM admin_menus WHERE route = ? AND group_key = ?', route, groupKey)) {
    throw Object.assign(new Error('同一分组下已有相同路由的菜单'), { status: 409 })
  }
  const info = db.prepare(`INSERT INTO admin_menus (group_key, group_label, group_sort, label, route, icon, perm_code, sort, visible, is_system, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`)
    .run(groupKey, groupLabel, groupSort, label, route, String(input.icon ?? '').trim() || null, permCode, sort, visible)
  return { id: Number(info.lastInsertRowid) }
}

/** 分组是 admin_menus 的树根；改名/排序会同步该组全部子菜单。 */
export function saveAdminMenuGroup(originalKey, input = {}) {
  const key = String(input.groupKey ?? originalKey ?? '').trim()
  const label = String(input.groupLabel ?? '').trim()
  const sort = Number(input.groupSort ?? 0) || 0
  if (!/^[a-z0-9_-]{1,40}$/.test(key)) throw Object.assign(new Error('分组键只能使用小写字母、数字、下划线或短横线'), { status: 400 })
  if (!label) throw Object.assign(new Error('分组名称必填'), { status: 400 })
  const current = one('SELECT COUNT(*) AS n FROM admin_menus WHERE group_key = ?', String(originalKey ?? '').trim())
  if (!current?.n) throw Object.assign(new Error('分组不存在'), { status: 404 })
  if (key !== originalKey && one('SELECT id FROM admin_menus WHERE group_key = ? LIMIT 1', key)) {
    throw Object.assign(new Error('分组键已存在'), { status: 409 })
  }
  db.prepare(`UPDATE admin_menus SET group_key = ?, group_label = ?, group_sort = ?, updated_at = datetime('now')
    WHERE group_key = ?`).run(key, label, sort, String(originalKey ?? '').trim())
  return { groupKey: key, groupLabel: label, groupSort: sort, items: Number(current.n) }
}

export function deleteAdminMenu(id) {
  const row = one('SELECT * FROM admin_menus WHERE id = ?', Number(id))
  if (!row) throw Object.assign(new Error('菜单不存在'), { status: 404 })
  if (row.is_system) throw Object.assign(new Error('系统菜单不能删除，可以改成「隐藏」'), { status: 400 })
  db.prepare('DELETE FROM admin_menus WHERE id = ?').run(Number(id))
  return { ok: true, id: Number(id) }
}

/** 恢复出厂菜单（清空后按 DEFAULT_ADMIN_MENUS 重建）。 */
export function resetAdminMenus(defaults) {
  db.exec('DELETE FROM admin_menus')
  const insert = db.prepare(`INSERT INTO admin_menus (group_key, group_label, group_sort, label, route, icon, perm_code, sort, visible, is_system)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`)
  for (const [groupKey, groupLabel, groupSort, items] of defaults) {
    items.forEach(([label, route, permCode, icon], index) => {
      insert.run(groupKey, groupLabel, groupSort, label, route, icon ?? null, permCode, (index + 1) * 10)
    })
  }
  return listAdminMenus()
}
