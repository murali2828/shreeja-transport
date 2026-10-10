// backend/src/middleware/auth.js
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// is_active re-check cache: JWTs are stateless (8h), so without this a
// deactivated user keeps access until expiry. A 60s TTL cache keeps the cost
// to at most one indexed PK lookup per user per minute.
const activeCache = new Map(); // userId -> { active, until }
const ACTIVE_TTL_MS = 60 * 1000;

async function isUserActive(userId) {
  const hit = activeCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.active;
  const r = await query('SELECT is_active FROM users WHERE id = $1', [userId]);
  const active = r.rows.length > 0 && r.rows[0].is_active !== false;
  activeCache.set(userId, { active, until: Date.now() + ACTIVE_TTL_MS });
  return active;
}

async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  try {
    if (!(await isUserActive(req.user.id))) {
      return res.status(401).json({ error: 'Account is deactivated' });
    }
  } catch (err) {
    // DB hiccup on the activity check must not take the whole API down —
    // token signature already verified above.
    console.error('[auth] is_active check failed:', err.message);
  }
  next();
}

// Multiple roles per user (migration 053): the JWT carries `roles`; `role`
// is the primary one and is 'admin' whenever admin is among them.
const rolesOf = u => (Array.isArray(u?.roles) && u.roles.length ? u.roles : [u?.role].filter(Boolean));
const hasRole = (u, ...names) => rolesOf(u).some(r => names.includes(r));

// Read-only roles (roles.read_only, migration 057; the built-in viewer is
// one): a user whose roles are ALL read-only may only GET, whatever module
// flags those roles carry. Any held role that is not read-only lifts the
// restriction. Looked up per role with a 60 s cache; applied by every gate.
const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const readOnlyCache = new Map(); // role name -> { ro, until }
async function isReadOnlyUser(u) {
  const names = rolesOf(u);
  if (!names.length) return false;
  if (names.includes('admin')) return false;
  const missing = names.filter(n => !(readOnlyCache.get(n)?.until > Date.now()));
  if (missing.length) {
    const r = await query('SELECT name, read_only FROM roles WHERE name = ANY($1)', [missing]);
    const until = Date.now() + ACTIVE_TTL_MS;
    for (const n of missing) readOnlyCache.set(n, { ro: false, until });
    for (const row of r.rows) readOnlyCache.set(row.name, { ro: row.read_only === true, until });
  }
  return names.every(n => readOnlyCache.get(n)?.ro === true);
}
async function denyIfReadOnlyWrite(req, res) {
  if (READ_METHODS.includes(req.method)) return false;
  let ro = false;
  try { ro = await isReadOnlyUser(req.user); } catch (err) { console.error('[auth] read-only check failed:', err.message); }
  if (ro) { res.status(403).json({ error: 'Your role is read-only — you can view transactions and reports but not change them' }); return true; }
  return false;
}

// Per-module access level (migration 060): roles.access = {module: 'none'|'view'|'edit'};
// a role without the column filled falls back to its boolean permissions
// (true = edit, or view when the role is read-only). A user's level per
// module is the highest over all roles they hold.
const RANK = { none: 0, view: 1, edit: 2 };
function roleLevels(row) {
  const out = {};
  const acc = row.access && Object.keys(row.access).length ? row.access : null;
  for (const [k, v] of Object.entries(acc || row.permissions || {})) {
    out[k] = acc ? (RANK[v] !== undefined ? v : 'none') : (v === true ? (row.read_only ? 'view' : 'edit') : 'none');
  }
  return out;
}
async function accessFor(roleNames) {
  const r = await query('SELECT permissions, access, read_only FROM roles WHERE name = ANY($1)', [roleNames]);
  const out = {};
  for (const row of r.rows) for (const [k, lvl] of Object.entries(roleLevels(row))) {
    if (RANK[lvl] > RANK[out[k] || 'none']) out[k] = lvl;
  }
  return out;
}
// Union of the module permissions of every role the user holds (true = view or edit).
async function permissionsFor(roleNames) {
  const lv = await accessFor(roleNames);
  const out = {};
  for (const [k, v] of Object.entries(lv)) if (v !== 'none') out[k] = true;
  return out;
}
// A write to a module where the user's best level is View is refused, even
// when a legacy role name would otherwise let it through.
const viewOnlyMsg = m => `You have view-only access to ${m} — you can see the data but not create or change it`;

function authorize(...roles) {
  return async (req, res, next) => {
    if (await denyIfReadOnlyWrite(req, res)) return;
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!hasRole(req.user, ...roles)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

const MODULES = ['masters', 'planning', 'execution', 'billing', 'reports', 'quality']; // quality: QA dispatch entry (migration 052)

// authorizeModule(moduleKey): module-level access gate backed by the `roles`
// table's `permissions` JSON. Admin is always allowed via a hardcoded check —
// this must never depend solely on the DB row, so a missing/corrupted
// 'admin' roles row can never lock the admin account out.
function authorizeModule(moduleKey) {
  return async (req, res, next) => {
    if (await denyIfReadOnlyWrite(req, res)) return;
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasRole(req.user, 'admin')) return next();
    try {
      const lvl = (await accessFor(rolesOf(req.user)))[moduleKey] || 'none';
      if (lvl === 'none') return res.status(403).json({ error: 'Insufficient permissions' });
      if (lvl === 'view' && !READ_METHODS.includes(req.method)) return res.status(403).json({ error: viewOnlyMsg(moduleKey) });
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// authorizeOrModule(moduleKey, ...roles): additive OR-composition of the two
// existing checks above. Grants access if EITHER req.user.role is one of
// `roles` (identical to authorize(...roles)) OR the user's role has
// permissions[moduleKey] === true in the `roles` table (identical to
// authorizeModule(moduleKey)). Admin is always allowed via the same hardcoded
// safety net as authorizeModule. This never restricts anything the old
// authorize(...roles) already allowed — it only adds custom-role users.
function authorizeOrModule(moduleKey, ...roles) {
  return async (req, res, next) => {
    if (await denyIfReadOnlyWrite(req, res)) return;
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasRole(req.user, 'admin')) return next();
    try {
      const lvl = (await accessFor(rolesOf(req.user)))[moduleKey] || 'none';
      const write = !READ_METHODS.includes(req.method);
      if (lvl === 'view' && write) return res.status(403).json({ error: viewOnlyMsg(moduleKey) });
      if (hasRole(req.user, ...roles)) return next();
      if (lvl === 'none') return res.status(403).json({ error: 'Insufficient permissions' });
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { authenticate, authorize, authorizeModule, authorizeOrModule, MODULES, rolesOf, hasRole, permissionsFor, accessFor, isReadOnlyUser };
