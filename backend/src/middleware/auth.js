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

function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

module.exports = { authenticate, authorize };
