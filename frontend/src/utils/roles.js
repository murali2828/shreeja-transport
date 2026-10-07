// frontend/src/utils/roles.js
// Multiple roles per user (migration 053): `user.roles` is the full set,
// `user.role` the primary ('admin' whenever admin is among them).
export const rolesOf = u => (Array.isArray(u?.roles) && u.roles.length ? u.roles : [u?.role].filter(Boolean));
export const hasRole = (u, ...names) => rolesOf(u).some(r => names.includes(r));
export const isOnlyRole = (u, name) => { const r = rolesOf(u); return r.length === 1 && r[0] === name; };
export const rolesLabel = u => rolesOf(u).join(', ');
