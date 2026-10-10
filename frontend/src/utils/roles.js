// frontend/src/utils/roles.js
// Multiple roles per user (migration 053): `user.roles` is the full set,
// `user.role` the primary ('admin' whenever admin is among them).
export const rolesOf = u => (Array.isArray(u?.roles) && u.roles.length ? u.roles : [u?.role].filter(Boolean));
export const hasRole = (u, ...names) => rolesOf(u).some(r => names.includes(r));
export const isOnlyRole = (u, name) => { const r = rolesOf(u); return r.length === 1 && r[0] === name; };
export const rolesLabel = u => rolesOf(u).join(', ');
// roles.read_only (migration 057): the login response carries user.read_only
export const isReadOnly = u => u?.read_only === true;
// Per-module access level (migration 060): user.access = {module: 'none'|'view'|'edit'}.
// canEdit: admin, or Edit on the module, or (no level given and the user is not
// read-only — legacy role names). The server is the real gate.
export const accessLevel = (u, m) => u?.access?.[m] || 'none';
export const canEdit = (u, m) => hasRole(u, 'admin') || accessLevel(u, m) === 'edit'
  || (accessLevel(u, m) === 'none' && !isReadOnly(u));
