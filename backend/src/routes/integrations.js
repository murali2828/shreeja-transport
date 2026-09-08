// backend/src/routes/integrations.js
// Shreeja Assure integration API — read-only JSON feed of trips / loadings /
// receipts for the milk-reconciliation module. Contract: docs/assure-handover/
// API_SPEC_v1.md (column names are the contract; do not rename aliases).
//
// Mounted at /api/integrations/assure/*. The caller is a server, not a TMS
// user: auth is a shared-secret header (X-Assure-Key), never the JWT.
// Every SELECT here is derived from the reference queries in
// docs/assure-handover/scripts/export_samples.sh (same joins, same WHERE on
// tp.plan_for_date) so the endpoints return exactly the rows the sample CSVs
// held, plus the extra columns the spec asks for.
const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const { query } = require('../config/db');

const CONTRACT     = 'assure-v1';
const DEFAULT_LIMIT = 500;
const MAX_LIMIT     = 2000;
const MAX_RANGE_DAYS = 62;
const TZ = 'Asia/Kolkata';

// ─── Helpers ─────────────────────────────────────────────────────────────────
const sendError = (res, status, code, message) => res.status(status).json({ error: message, code });

// Timestamp columns are rendered in SQL as ISO 8601 with the +05:30 offset
// (spec §1.4). Doing it in SQL avoids node-postgres turning timestamptz into a
// JS Date that JSON.stringify would emit in UTC "Z" form. The TMS columns are
// bare TIMESTAMP holding IST wall-clock (the DB session timezone is
// Asia/Kolkata, as tripDocs.js already relies on); the ::timestamptz cast
// makes the expression work unchanged if a column ever becomes timestamptz.
// NULL in → NULL out (|| with NULL yields NULL).
const TS = col => `to_char((${col})::timestamptz AT TIME ZONE '${TZ}', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+05:30'`;

// Same form for server_time, computed in JS.
function nowIst() {
  const d = new Date(Date.now() + 330 * 60 * 1000);           // shift to IST
  return d.toISOString().replace('Z', '+05:30');
}
function todayIst() { return nowIst().slice(0, 10); }

const isIsoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(`${s}T00:00:00Z`));
const num = v => (v == null ? null : parseFloat(v));
const int = v => (v == null ? null : Number(v));

// ─── Auth: X-Assure-Key ──────────────────────────────────────────────────────
function configuredKeys() {
  const keys = [];
  if (process.env.ASSURE_API_KEY)      keys.push(['primary', process.env.ASSURE_API_KEY]);
  if (process.env.ASSURE_API_KEY_NEXT) keys.push(['next',    process.env.ASSURE_API_KEY_NEXT]);
  return keys;
}
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;               // timingSafeEqual throws on length mismatch
  return crypto.timingSafeEqual(ba, bb);
}
function requireAssureKey(req, res, next) {
  const keys = configuredKeys();
  if (!keys.length) return sendError(res, 503, 'FEATURE_DISABLED', 'Assure integration not configured');
  const presented = req.get('X-Assure-Key');
  let matched = null;
  if (presented) for (const [id, k] of keys) { if (safeEqual(presented, k)) { matched = id; break; } }
  if (!matched) return sendError(res, 401, 'UNAUTHORIZED', 'Invalid API key');
  const allowed = (process.env.ASSURE_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(req.ip))
    return sendError(res, 403, 'FORBIDDEN', 'IP not allowed');
  req.assureKeyId = matched;
  next();
}

// ─── Per-call log line (path, key id — never the key value, IP, rows, ms) ────
function logCall(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`[assure] ${req.method} ${req.path} key=${req.assureKeyId || '-'} ip=${req.ip} ` +
                `rows=${res.locals.rowCount ?? '-'} status=${res.statusCode} ms=${Date.now() - started}`);
  });
  next();
}

// ─── Common query parameters (spec §3) ───────────────────────────────────────
// Returns { from, to, updatedSince, afterId, limit } or { error: [status, code, message] }.
function parseCommon(req) {
  const q = req.query || {};
  const err = (code, message) => ({ error: [400, code, message] });

  let from = null, to = null;
  if (q.from_date != null && q.from_date !== '') {
    if (!isIsoDate(q.from_date)) return err('BAD_DATE', 'from_date must be YYYY-MM-DD');
    from = String(q.from_date);
    if (q.to_date != null && q.to_date !== '') {
      if (!isIsoDate(q.to_date)) return err('BAD_DATE', 'to_date must be YYYY-MM-DD');
      to = String(q.to_date);
    } else {
      to = todayIst();
    }
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000;
    if (days < 0) return err('BAD_DATE', 'to_date is before from_date');
    if (days > MAX_RANGE_DAYS) return err('RANGE_TOO_WIDE', `to_date - from_date must be <= ${MAX_RANGE_DAYS} days`);
  } else if (q.to_date != null && q.to_date !== '' && !isIsoDate(q.to_date)) {
    return err('BAD_DATE', 'to_date must be YYYY-MM-DD');
  }

  let updatedSince = null;
  if (q.updated_since != null && q.updated_since !== '') {
    const d = new Date(String(q.updated_since));
    if (isNaN(d)) return err('BAD_TIMESTAMP', 'updated_since must be an ISO 8601 timestamp');
    updatedSince = d.toISOString();
  }

  if (!from && !updatedSince) return err('MISSING_FILTER', 'from_date or updated_since is required');

  let afterId = 0;
  if (q.after_id != null && q.after_id !== '') {
    if (!/^\d+$/.test(String(q.after_id))) return err('BAD_CURSOR', 'after_id must be an integer >= 0');
    afterId = parseInt(q.after_id, 10);
  }

  let limit = DEFAULT_LIMIT;
  if (q.limit != null && q.limit !== '') {
    const n = parseInt(q.limit, 10);
    if (!isNaN(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }

  return { from, to, updatedSince, afterId, limit };
}

// ─── Envelope (spec §4) ──────────────────────────────────────────────────────
function envelope(rows, limit, idKey) {
  const count = rows.length;
  return {
    data: rows,
    count,
    next_after_id: count === limit && count > 0 ? rows[count - 1][idKey] : null,
    server_time: nowIst(),
  };
}

// Builds the WHERE tail + params shared by the three list endpoints.
// dateCol / updatedExpr / idCol are SQL fragments chosen per endpoint.
function buildFilters(p, { dateCol, updatedExpr, idCol }) {
  const args = [];
  const where = [];
  if (p.from) { args.push(p.from, p.to); where.push(`${dateCol} BETWEEN $${args.length - 1} AND $${args.length}`); }
  if (p.updatedSince) { args.push(p.updatedSince); where.push(`${updatedExpr} >= $${args.length}::timestamptz`); }
  args.push(p.afterId); where.push(`${idCol} > $${args.length}`);
  args.push(p.limit);
  return { whereSql: where.join(' AND '), limitSql: `$${args.length}`, args };
}

async function runList(req, res, spec) {
  const p = parseCommon(req);
  if (p.error) return sendError(res, ...p.error);
  const f = buildFilters(p, spec);
  const r = await query(`${spec.sql} WHERE ${f.whereSql} ORDER BY ${spec.idCol} LIMIT ${f.limitSql}`, f.args);
  const rows = r.rows.map(spec.map);
  res.locals.rowCount = rows.length;
  res.json(envelope(rows, p.limit, spec.idKey));
}

// ─── Router wiring ───────────────────────────────────────────────────────────
// Per-IP rate limit (spec §2): 120 requests / minute → 429 { error, code }.
router.use(rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMITED' },
}));
router.use(requireAssureKey);
router.use(logCall);

// GET /api/integrations/assure/ping (spec §5.1)
router.get('/ping', (_req, res) => {
  res.locals.rowCount = 0;
  res.json({
    ok: true, contract: CONTRACT,
    tms_version: process.env.TMS_GIT_SHA || require('../../package.json').version,
    server_time: nowIst(),
  });
});

// ─── /trips — one row per trip plan, with its (latest) execution (spec §5.2) ─
// Reference: export_samples.sh `trips` block + the execution join and the three
// trip_document_prints sub-selects from sql/assure_trips_v.sql. A plan can
// historically carry more than one execution (cancelled, then a fresh one), so
// the LATERAL picks the newest by id to keep the grain at one row per plan.
const TRIPS_SQL = `
  SELECT tp.id                    AS trip_plan_id,
         tp.trip_no               AS trip_no,
         tp.plan_date::text       AS plan_date,
         tp.plan_for_date::text   AS plan_for_date,
         tp.status                AS plan_status,
         te.id                    AS execution_id,
         te.status                AS execution_status,
         te.execution_date::text  AS execution_date,
         te.cancel_reason         AS cancel_reason,
         t.tanker_number          AS tanker_number,
         rm.route_no              AS route_no,
         rm.route_name            AS route_name,
         sp.name                  AS start_point,
         dpt.name                 AS testing_point,
         dp.id                    AS delivery_point_id,
         dp.name                  AS delivery_point,
         tp.is_sale_tanker        AS is_sale_tanker,
         tp.shifts_milk           AS shifts_milk,
         tp.expected_km           AS expected_km,
         te.actual_km             AS actual_km,
         tp.expected_total_qty    AS expected_total_qty,
         te.total_qty_litres      AS loaded_litres,
         te.total_qty_kgs         AS loaded_kg,
         te.avg_fat               AS loaded_avg_fat_pct,
         te.avg_snf               AS loaded_avg_snf_pct,
         te.dc_number             AS dc_number,
         tp.total_cost            AS total_cost,
         tp.per_liter_cost        AS per_liter_cost,
         tp.driver_name           AS driver_name,
         tp.loader_name           AS loader_name,
         tp.remarks               AS remarks,
         ${TS(`(SELECT MIN(p.printed_at) FROM trip_document_prints p WHERE p.trip_plan_id = tp.id AND p.doc_type = 'gate_pass')`)} AS gate_pass_at,
         ${TS(`(SELECT MIN(p.printed_at) FROM trip_document_prints p WHERE p.trip_plan_id = tp.id AND p.doc_type = 'coa')`)}       AS arrived_at,
         ${TS(`(SELECT MIN(p.printed_at) FROM trip_document_prints p WHERE p.trip_plan_id = tp.id AND p.doc_type = 'unloading')`)} AS unloaded_at,
         ${TS('tp.created_at')}   AS created_at,
         ${TS('GREATEST(tp.updated_at, te.updated_at)')} AS updated_at
  FROM trip_plans tp
  LEFT JOIN LATERAL (SELECT * FROM trip_executions x WHERE x.trip_plan_id = tp.id ORDER BY x.id DESC LIMIT 1) te ON TRUE
  LEFT JOIN tankers t          ON t.id = tp.tanker_id
  LEFT JOIN route_masters rm   ON rm.id = tp.route_id
  LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
  LEFT JOIN testing_points dpt ON dpt.id = tp.testing_point_id
  LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id`;

const mapTrip = r => ({
  trip_plan_id:       int(r.trip_plan_id),
  trip_no:            int(r.trip_no),
  plan_date:          r.plan_date,
  plan_for_date:      r.plan_for_date,
  plan_status:        r.plan_status,
  execution_id:       int(r.execution_id),
  execution_status:   r.execution_status,
  execution_date:     r.execution_date,
  cancel_reason:      r.cancel_reason,
  tanker_number:      r.tanker_number,
  route_no:           r.route_no,
  route_name:         r.route_name,
  start_point:        r.start_point,
  testing_point:      r.testing_point,
  delivery_point_id:  int(r.delivery_point_id),
  delivery_point:     r.delivery_point,
  is_sale_tanker:     r.is_sale_tanker,
  shifts_milk:        r.shifts_milk,
  expected_km:        num(r.expected_km),
  actual_km:          num(r.actual_km),
  expected_total_qty: num(r.expected_total_qty),
  loaded_litres:      num(r.loaded_litres),
  loaded_kg:          num(r.loaded_kg),
  loaded_avg_fat_pct: num(r.loaded_avg_fat_pct),
  loaded_avg_snf_pct: num(r.loaded_avg_snf_pct),
  dc_number:          r.dc_number,
  total_cost:         num(r.total_cost),
  per_liter_cost:     num(r.per_liter_cost),
  driver_name:        r.driver_name,
  loader_name:        r.loader_name,
  remarks:            r.remarks,
  gate_pass_at:       r.gate_pass_at,
  arrived_at:         r.arrived_at,
  unloaded_at:        r.unloaded_at,
  created_at:         r.created_at,
  updated_at:         r.updated_at,
});

router.get('/trips', (req, res, next) => runList(req, res, {
  sql: TRIPS_SQL, idCol: 'tp.id', idKey: 'trip_plan_id', dateCol: 'tp.plan_for_date',
  updatedExpr: 'GREATEST(tp.updated_at, te.updated_at)', map: mapTrip,
}).catch(next));

// ─── /loadings — one row per BMCU pickup (spec §5.3) ─────────────────────────
// Reference: export_samples.sh `loadings` block + te.status, tp.plan_for_date,
// te.updated_at. trip_execution_bmcus has no timestamp of its own, so
// updated_since / updated_at use the parent execution's updated_at (proxy).
const LOADINGS_SQL = `
  SELECT teb.id                  AS loading_id,
         teb.execution_id        AS execution_id,
         te.trip_plan_id         AS trip_plan_id,
         tp.trip_no              AS trip_no,
         tp.plan_for_date::text  AS plan_for_date,
         te.status               AS execution_status,
         t.tanker_number         AS tanker_number,
         teb.seq_no              AS seq_no,
         b.bmcu_code             AS bmcu_code,
         b.bmcu_name             AS bmcu_name,
         teb.milk_date::text     AS milk_date,
         teb.shift               AS shift,
         teb.qty_litres          AS qty_litres,
         teb.qty_kgs             AS qty_kgs,
         teb.fat_pct             AS fat_pct,
         teb.snf_pct             AS snf_pct,
         teb.kg_fat              AS kg_fat,
         teb.kg_snf              AS kg_snf,
         teb.rmrd_qty            AS rmrd_qty,
         teb.chamber             AS chamber,
         teb.description         AS description,
         teb.is_deleted          AS is_deleted,
         ${TS('te.updated_at')}  AS updated_at
  FROM trip_execution_bmcus teb
  JOIN trip_executions te ON te.id = teb.execution_id
  JOIN trip_plans tp      ON tp.id = te.trip_plan_id
  LEFT JOIN tankers t     ON t.id = tp.tanker_id
  JOIN bmcus b            ON b.id = teb.bmcu_id`;

const mapLoading = r => ({
  loading_id:       int(r.loading_id),
  execution_id:     int(r.execution_id),
  trip_plan_id:     int(r.trip_plan_id),
  trip_no:          int(r.trip_no),
  plan_for_date:    r.plan_for_date,
  execution_status: r.execution_status,
  tanker_number:    r.tanker_number,
  seq_no:           int(r.seq_no),
  bmcu_code:        r.bmcu_code,
  bmcu_name:        r.bmcu_name,
  milk_date:        r.milk_date,
  shift:            r.shift,
  qty_litres:       num(r.qty_litres),
  qty_kgs:          num(r.qty_kgs),
  fat_pct:          num(r.fat_pct),
  snf_pct:          num(r.snf_pct),
  kg_fat:           num(r.kg_fat),
  kg_snf:           num(r.kg_snf),
  rmrd_qty:         num(r.rmrd_qty),
  chamber:          r.chamber,
  description:      r.description,
  is_deleted:       r.is_deleted,
  updated_at:       r.updated_at,
});

router.get('/loadings', (req, res, next) => runList(req, res, {
  sql: LOADINGS_SQL, idCol: 'teb.id', idKey: 'loading_id', dateCol: 'tp.plan_for_date',
  updatedExpr: 'te.updated_at', map: mapLoading,
}).catch(next));

// ─── /receipts — one row per acknowledgement chamber (spec §5.4, §6) ─────────
// Reference: export_samples.sh `receipts` block + te.status, tp.plan_for_date,
// dp.id, the users join and ta.created_at. trip_acknowledgements has no
// updated_at (a correction is delete + re-insert), so created_at is exposed
// as updated_at too. Empty chamber rows (all quantities null) are sent as-is.
// The user column is trip_acknowledgements.entered_by → users.full_name.
const RECEIPTS_SQL = `
  SELECT ta.id                   AS receipt_id,
         ta.execution_id         AS execution_id,
         te.trip_plan_id         AS trip_plan_id,
         tp.trip_no              AS trip_no,
         tp.plan_for_date::text  AS plan_for_date,
         te.status               AS execution_status,
         t.tanker_number         AS tanker_number,
         dp.id                   AS delivery_point_id,
         dp.name                 AS delivery_point,
         ta.ack_date::text       AS ack_date,
         ta.chamber              AS chamber,
         ta.qty_litres           AS qty_litres,
         ta.qty_kgs              AS qty_kgs,
         ta.fat_pct              AS fat_pct,
         ta.snf_pct              AS snf_pct,
         ta.kg_fat               AS kg_fat,
         ta.kg_snf               AS kg_snf,
         ta.temperature          AS temperature,
         ta.description          AS description,
         u.full_name             AS entered_by,
         ${TS('ta.created_at')}  AS created_at,
         ${TS('ta.created_at')}  AS updated_at
  FROM trip_acknowledgements ta
  JOIN trip_executions te      ON te.id = ta.execution_id
  JOIN trip_plans tp           ON tp.id = te.trip_plan_id
  LEFT JOIN tankers t          ON t.id = tp.tanker_id
  LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
  LEFT JOIN users u            ON u.id = ta.entered_by`;

const mapReceipt = r => ({
  receipt_id:        int(r.receipt_id),
  execution_id:      int(r.execution_id),
  trip_plan_id:      int(r.trip_plan_id),
  trip_no:           int(r.trip_no),
  plan_for_date:     r.plan_for_date,
  execution_status:  r.execution_status,
  tanker_number:     r.tanker_number,
  delivery_point_id: int(r.delivery_point_id),
  delivery_point:    r.delivery_point,
  ack_date:          r.ack_date,
  chamber:           r.chamber,
  qty_litres:        num(r.qty_litres),
  qty_kgs:           num(r.qty_kgs),
  fat_pct:           num(r.fat_pct),
  snf_pct:           num(r.snf_pct),
  kg_fat:            num(r.kg_fat),
  kg_snf:            num(r.kg_snf),
  temperature:       r.temperature == null ? null : String(r.temperature),
  description:       r.description,
  entered_by:        r.entered_by,
  created_at:        r.created_at,
  updated_at:        r.updated_at,
});

router.get('/receipts', (req, res, next) => runList(req, res, {
  sql: RECEIPTS_SQL, idCol: 'ta.id', idKey: 'receipt_id', dateCol: 'tp.plan_for_date',
  updatedExpr: 'ta.created_at', map: mapReceipt,
}).catch(next));

// Unknown paths under the mount → JSON error in the spec's shape.
router.use((_req, res) => sendError(res, 404, 'NOT_FOUND', 'Unknown Assure endpoint'));

// Errors inside this router keep the { error, code } shape (the app-level handler emits { error } only).
// eslint-disable-next-line no-unused-vars
router.use((err, _req, res, _next) => {
  console.error('[assure] error:', err);
  sendError(res, 500, 'INTERNAL', process.env.NODE_ENV === 'production' ? 'Internal server error' : (err.message || 'Internal server error'));
});

module.exports = router;
module.exports._internal = { requireAssureKey, parseCommon, envelope, buildFilters, safeEqual, nowIst, TS };
