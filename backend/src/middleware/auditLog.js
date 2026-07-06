// backend/src/middleware/auditLog.js
// Records every mutating API call (POST/PUT/DELETE/PATCH) into audit_logs:
// who (req.user, set by each router's authenticate), what (module/action/entity),
// when (created_at), and a sanitized copy of the request body.
// Mounted app-level BEFORE the routers; writes on res 'finish' so the actor and
// final status code are known. Fire-and-forget — auditing never breaks a request.

const { pool } = require('../config/db');
const { snapshotterFor, diffSnapshots, logChanges } = require('../services/changeTracker');

const SKIP_PREFIXES = ['/audit', '/health'];
const SECRET_KEYS = new Set([
  'password', 'new_password', 'current_password', 'old_password',
  'token', 'authorization', 'smtp_pass', 'file_data',
]);
const MAX_DETAILS_BYTES = 2048;

// Human-friendly module names by leading path segment(s).
const MODULE_MAP = [
  [/^\/auth\/login/,            'Authentication'],
  [/^\/auth\/(forgot|reset|change)-password/, 'Authentication'],
  [/^\/auth\/users/,            'Users'],
  [/^\/masters\/tankers/,       'Tankers'],
  [/^\/masters\/bmcus/,         'BMCUs'],
  [/^\/masters\/routes/,        'Route Master'],
  [/^\/masters\/starting-points/, 'Starting Points'],
  [/^\/masters\/testing-points/,  'Testing Points'],
  [/^\/masters\/delivery-points/, 'Delivery Points'],
  [/^\/masters\/email-config/,  'Email Config'],
  [/^\/plans\/email-config/,    'Plan Email Config'],
  [/^\/plans/,                  'Trip Plans'],
  [/^\/executions/,             'Executions'],
  [/^\/distances/,              'Distance Master'],
  [/^\/optimize/,               'Route Optimizer'],
  [/^\/vendors/,                'Vendors'],
  [/^\/documents/,              'Tanker Documents'],
  [/^\/reports/,                'Reports'],
];

function moduleOf(path) {
  for (const [re, name] of MODULE_MAP) if (re.test(path)) return name;
  return 'Other';
}

function actionOf(method, path, success) {
  if (/\/auth\/login/.test(path))            return success ? 'login' : 'login_failed';
  if (/-password/.test(path))                return 'password';
  if (/\/publish/.test(path))                return 'publish';
  if (/\/cancel/.test(path))                 return 'cancel';
  if (/\/upload/.test(path))                 return 'upload';
  if (/\/acknowledgements|\/submit-ack/.test(path)) return 'acknowledge';
  if (/\/save-as-plans/.test(path))          return 'create';
  if (method === 'POST')   return 'create';
  if (method === 'PUT' || method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';
  return 'other';
}

function entityIdOf(path) {
  // first purely-numeric path segment, e.g. /executions/123/cancel -> 123
  const m = path.match(/\/(\d+)(?:\/|$)/);
  return m ? m[1] : null;
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.has(k.toLowerCase())) continue;
      out[k] = sanitize(v);
    }
    return out;
  }
  return value;
}

function detailsOf(body) {
  try {
    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) return null;
    let s = JSON.stringify(sanitize(body));
    if (s.length > MAX_DETAILS_BYTES) s = s.slice(0, MAX_DETAILS_BYTES - 12) + '…truncated"}';
    return s;
  } catch { return null; }
}

async function auditLog(req, res, next) {
  const method = req.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();
  const path = req.path; // relative to /api mount
  if (SKIP_PREFIXES.some(p => path.startsWith(p))) return next();

  const details = detailsOf(req.body); // capture before handlers may mutate it
  const startedAt = new Date();

  // ── Field-level change tracking: BEFORE snapshot ──────────────────────────
  const snap = snapshotterFor(path);
  const pathEntityId = entityIdOf(path);
  let beforeSnap = null;
  if (snap && pathEntityId) {
    try { beforeSnap = await snap.read(pool, pathEntityId); } catch (e) { /* never block */ }
  }
  // Capture the created record's id from the response body (POST-create case).
  let createdId = null;
  if (snap && !pathEntityId && method === 'POST') {
    const origJson = res.json.bind(res);
    res.json = (body) => { try { createdId = body?.id ?? null; } catch {} return origJson(body); };
  }

  res.on('finish', () => {
    try {
      const success = res.statusCode < 400;
      const user = req.user || {};
      const userLogin = /\/auth\/login/.test(path)
        ? String(req.body?.user_id || req.body?.username || '')
        : (user.user_id || null);

      pool.query(
        `INSERT INTO audit_logs
           (user_id, user_name, user_login, method, path, module, action,
            entity_id, status_code, success, details, ip, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          user.id || null,
          user.full_name || null,
          userLogin || null,
          method,
          '/api' + path,
          moduleOf(path),
          actionOf(method, path, success),
          entityIdOf(path),
          res.statusCode,
          success,
          details,
          (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null,
          startedAt,
        ]
      ).catch(err => console.error('[audit] insert failed:', err.message));

      // ── Field-level change tracking: AFTER snapshot + diff (async, detached) ─
      if (snap && success) {
        const targetId = pathEntityId || createdId;
        if (targetId) {
          (async () => {
            try {
              const afterSnap = method === 'DELETE' ? await snap.read(pool, targetId) : await snap.read(pool, targetId);
              const rows = diffSnapshots(beforeSnap, afterSnap);
              const action = !beforeSnap && afterSnap ? 'create'
                : (beforeSnap && !afterSnap) || method === 'DELETE' ? 'delete'
                : 'update';
              logChanges({
                module: snap.module, entityId: targetId, action,
                userId: user.id || null, userName: user.full_name || null,
                userLogin: user.user_id || null, path: '/api' + path,
              }, rows);
            } catch (e) {
              console.error('[changeTracker] capture failed:', e.message);
            }
          })();
        }
      }
    } catch (err) {
      console.error('[audit] error:', err.message);
    }
  });

  next();
}

module.exports = auditLog;
