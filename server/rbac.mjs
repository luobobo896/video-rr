/** RBAC：角色/权限/数据域 + 审计日志。 */
import { db } from './db.mjs'

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

export function listAudit({ limit = 100, action, actorId } = {}) {
  const clauses = []
  const args = []
  if (action) { clauses.push('action LIKE ?'); args.push(`%${action}%`) }
  if (actorId) { clauses.push('actor_id = ?'); args.push(Number(actorId)) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return all(`SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ?`, ...args, Math.min(500, Number(limit) || 100))
}

export function listRoles() {
  return all('SELECT * FROM roles ORDER BY id').map((role) => ({
    ...role,
    permissions: all('SELECT permission_code FROM role_permissions WHERE role_id = ?', role.id).map((row) => row.permission_code),
  }))
}

export function listPermissionCatalog() {
  return all('SELECT * FROM permissions ORDER BY domain, code')
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
  return all('SELECT id, username, display_name, status, created_at FROM admins ORDER BY id').map((admin) => ({
    ...admin,
    roles: all('SELECT r.code, r.name FROM admin_roles ar JOIN roles r ON r.id = ar.role_id WHERE ar.admin_id = ?', admin.id),
  }))
}

export function setAdminRoles(adminId, roleCodes) {
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
