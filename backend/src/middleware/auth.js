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

// Union of the module permissions of every role the user holds.
async function permissionsFor(roleNames) {
  const r = await query('SELECT permissions FROM roles WHERE name = ANY($1)', [roleNames]);
  const out = {};
  for (const row of r.rows) for (const [k, v] of Object.entries(row.permissions || {})) if (v === true) out[k] = true;
  return out;
}

function authorize(...roles) {
  return (req, res, next) => {
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
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasRole(req.user, 'admin')) return next();
    try {
      const r = { rows: [{ permissions: await permissionsFor(rolesOf(req.user)) }] };
      const perms = r.rows[0]?.permissions;
      if (!perms || perms[moduleKey] !== true) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
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
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (hasRole(req.user, 'admin')) return next();
    if (hasRole(req.user, ...roles)) return next();
    try {
      const r = { rows: [{ permissions: await permissionsFor(rolesOf(req.user)) }] };
      const perms = r.rows[0]?.permissions;
      if (!perms || perms[moduleKey] !== true) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { authenticate, authorize, authorizeModule, authorizeOrModule, MODULES, rolesOf, hasRole, permissionsFor };
