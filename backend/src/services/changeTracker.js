// backend/src/services/changeTracker.js
// Field-level change tracking: before/after snapshots of business entities,
// a generic differ producing one row per changed field, and a fire-and-forget
// logger into data_change_logs. Used by the audit middleware (all mutating
// API calls) and the change-request approval flow.

const { pool } = require('../config/db');

// Columns never snapshotted / never diffed.
const GLOBAL_EXCLUDE = new Set([
  'id', 'created_at', 'updated_at', 'password_hash', 'file_data',
  'approval_token', 'must_change_password',
]);

// ─── Snapshot shape ───────────────────────────────────────────────────────────
// { scalars: {field: value}, children: [{ name, rows, keyOf(r), labelOf(r), fields? }] }
// fields (optional) limits which child columns are diffed.

const strip = (row, extra = []) => {
  if (!row) return null;
  const out = {};
  const ex = new Set([...GLOBAL_EXCLUDE, ...extra]);
  for (const [k, v] of Object.entries(row)) if (!ex.has(k)) out[k] = v;
  return out;
};

async function singleRow(db, table, id, extraExclude = []) {
  const r = await db.query(`SELECT * FROM ${table} WHERE id=$1`, [id]);
  if (!r.rows.length) return null;
  return { scalars: strip(r.rows[0], extraExclude), children: [] };
}

async function planSnapshot(db, id) {
  const p = await db.query('SELECT * FROM trip_plans WHERE id=$1', [id]);
  if (!p.rows.length) return null;
  const bm = await db.query(`
    SELECT tpb.seq_no, b.bmcu_code, tpb.shift_code, tpb.expected_qty, tpb.description
    FROM trip_plan_bmcus tpb LEFT JOIN bmcus b ON b.id=tpb.bmcu_id
    WHERE tpb.trip_plan_id=$1 ORDER BY tpb.seq_no`, [id]);
  return {
    scalars: strip(p.rows[0], ['created_by']),
    children: [{
      name: 'BMCU', rows: bm.rows,
      keyOf: r => String(r.seq_no),
      labelOf: r => `BMCU #${r.seq_no} ${r.bmcu_code || ''}`.trim(),
    }],
  };
}

async function executionSnapshot(db, id) {
  const e = await db.query('SELECT * FROM trip_executions WHERE id=$1', [id]);
  if (!e.rows.length) return null;
  const bmcus = await db.query(`
    SELECT teb.seq_no, b.bmcu_code, teb.milk_date, teb.shift, teb.qty_litres,
           teb.fat_pct, teb.snf_pct, teb.description, teb.chamber, teb.dps_qty_litres
    FROM trip_execution_bmcus teb JOIN bmcus b ON b.id=teb.bmcu_id
    WHERE teb.execution_id=$1 AND teb.is_deleted=FALSE ORDER BY teb.seq_no`, [id]);
  const shifts = await db.query(`
    SELECT bmcu_seq_no, milk_date, shift, rmrd_qty, rmrd_fat_pct, rmrd_snf_pct
    FROM trip_execution_bmcu_shifts WHERE execution_id=$1 ORDER BY bmcu_seq_no, id`, [id]);
  const entries = await db.query(`
    SELECT bmcu_seq_no, kind, category, source_bmcu_id, qty_litres, fat_pct, snf_pct, remarks
    FROM trip_execution_bmcu_entries WHERE execution_id=$1 ORDER BY bmcu_seq_no, id`, [id]);
  const acks = await db.query(`
    SELECT chamber, ack_date, qty_litres, fat_pct, snf_pct, temperature, description
    FROM trip_acknowledgements WHERE execution_id=$1 ORDER BY chamber`, [id]);

  return {
    scalars: {
      status: e.rows[0].status,
      actual_km: e.rows[0].actual_km,
      dc_number: e.rows[0].dc_number,
    },
    children: [
      { name: 'BMCU row', rows: bmcus.rows,
        keyOf: r => String(r.seq_no),
        labelOf: r => `BMCU #${r.seq_no} ${r.bmcu_code || ''}`.trim() },
      { name: 'Shift row', rows: shifts.rows,
        keyOf: r => `${r.bmcu_seq_no}|${String(r.milk_date).slice(0, 10)}|${r.shift || ''}`,
        labelOf: r => `BMCU #${r.bmcu_seq_no} shift ${r.shift || ''} ${String(r.milk_date).slice(0, 10)}` },
      { name: 'Entry', rows: entries.rows,
        keyOf: r => `${r.bmcu_seq_no}|${r.kind}|${r.category || ''}|${r.source_bmcu_id || ''}`,
        labelOf: r => `BMCU #${r.bmcu_seq_no} ${r.kind}${r.category ? ' ' + r.category : ''}` },
      { name: 'Acknowledgement', rows: acks.rows,
        keyOf: r => r.chamber,
        labelOf: r => `Chamber ${r.chamber}` },
    ],
  };
}

// Path prefix (relative to /api) → snapshotter. First match wins.
const SNAPSHOTTERS = [
  { prefix: '/masters/tankers',         module: 'Tankers',          read: (db, id) => singleRow(db, 'tankers', id) },
  { prefix: '/masters/bmcus',           module: 'BMCUs',            read: (db, id) => singleRow(db, 'bmcus', id) },
  { prefix: '/masters/routes',          module: 'Route Master',     read: (db, id) => singleRow(db, 'route_masters', id) },
  { prefix: '/masters/starting-points', module: 'Starting Points',  read: (db, id) => singleRow(db, 'starting_points', id) },
  { prefix: '/masters/testing-points',  module: 'Testing Points',   read: (db, id) => singleRow(db, 'testing_points', id) },
  { prefix: '/masters/delivery-points', module: 'Delivery Points',  read: (db, id) => singleRow(db, 'delivery_points', id) },
  { prefix: '/auth/users',              module: 'Users',            read: (db, id) => singleRow(db, 'users', id) },
  { prefix: '/vendors',                 module: 'Vendors',          read: (db, id) => singleRow(db, 'vendors', id) },
  { prefix: '/documents',               module: 'Tanker Documents', read: (db, id) => singleRow(db, 'tanker_documents', id, ['file_name', 'file_mime', 'file_size', 'file_path']) },
  { prefix: '/distances',               module: 'Distance Master',  read: (db, id) => singleRow(db, 'distance_master', id, ['created_by', 'updated_by']) },
  { prefix: '/plans',                   module: 'Trip Plans',       read: planSnapshot },
  { prefix: '/executions',              module: 'Executions',       read: executionSnapshot },
];

function snapshotterFor(path) {
  // skip sub-resources that are their own module
  if (path.startsWith('/plans/email-config') || path.startsWith('/change-requests')) return null;
  return SNAPSHOTTERS.find(s => path.startsWith(s.prefix)) || null;
}

// ─── Diff ─────────────────────────────────────────────────────────────────────
const norm = v => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const n = parseFloat(v);
  if (Number.isFinite(n) && String(v).trim() !== '' && !isNaN(v)) return String(n);
  return String(v);
};
const MAX_ROWS = 80;

function diffSnapshots(before, after) {
  const rows = [];
  const push = (row_label, field, oldV, newV) => {
    if (rows.length >= MAX_ROWS) return;
    rows.push({ row_label, field, old_value: norm(oldV), new_value: norm(newV) });
  };

  if (!before && !after) return rows;
  if (!before && after) { // created
    for (const [k, v] of Object.entries(after.scalars || {})) {
      if (norm(v) != null) push('(record)', k, null, v);
    }
    for (const ch of (after.children || [])) {
      for (const r of ch.rows) push(ch.labelOf(r), '(added)', null, summarize(r, ch));
    }
    return rows;
  }
  if (before && !after) { // deleted
    push('(record)', '(deleted)', 'record existed', null);
    return rows;
  }

  // scalars
  const keys = new Set([...Object.keys(before.scalars || {}), ...Object.keys(after.scalars || {})]);
  for (const k of keys) {
    const o = norm(before.scalars?.[k]);
    const n = norm(after.scalars?.[k]);
    if (o !== n) push('(record)', k, before.scalars?.[k], after.scalars?.[k]);
  }

  // children by name
  const byName = arr => Object.fromEntries((arr || []).map(c => [c.name, c]));
  const bC = byName(before.children), aC = byName(after.children);
  for (const name of new Set([...Object.keys(bC), ...Object.keys(aC)])) {
    const b = bC[name], a = aC[name];
    const keyOf = (a || b).keyOf, labelOf = (a || b).labelOf;
    const bBy = new Map((b?.rows || []).map(r => [keyOf(r), r]));
    const aBy = new Map((a?.rows || []).map(r => [keyOf(r), r]));
    for (const k of new Set([...bBy.keys(), ...aBy.keys()])) {
      const oR = bBy.get(k), nR = aBy.get(k);
      if (oR && !nR) { push(labelOf(oR), '(removed)', summarize(oR, b), null); continue; }
      if (!oR && nR) { push(labelOf(nR), '(added)', null, summarize(nR, a)); continue; }
      const fKeys = new Set([...Object.keys(oR), ...Object.keys(nR)]);
      for (const f of fKeys) {
        if (GLOBAL_EXCLUDE.has(f)) continue;
        if (norm(oR[f]) !== norm(nR[f])) push(labelOf(nR), f, oR[f], nR[f]);
      }
    }
  }
  return rows;
}

function summarize(row, ch) {
  return Object.entries(row)
    .filter(([k, v]) => !GLOBAL_EXCLUDE.has(k) && norm(v) != null)
    .map(([k, v]) => `${k}=${norm(v)}`)
    .join(', ').slice(0, 300);
}

// ─── Logger (fire-and-forget, batched) ────────────────────────────────────────
function logChanges(ctx, diffRows) {
  if (!diffRows?.length) return;
  const values = [];
  const params = [];
  for (const d of diffRows) {
    const base = params.length;
    params.push(ctx.module, ctx.entityType || ctx.module, String(ctx.entityId ?? ''),
      d.row_label, d.field, d.old_value, d.new_value, ctx.action || 'update',
      ctx.userId ?? null, ctx.userName ?? null, ctx.userLogin ?? null, ctx.path ?? null);
    values.push(`(${Array.from({ length: 12 }, (_, i) => `$${base + i + 1}`).join(',')})`);
  }
  pool.query(
    `INSERT INTO data_change_logs
       (module, entity_type, entity_id, row_label, field, old_value, new_value,
        action, user_id, user_name, user_login, audit_path)
     VALUES ${values.join(',')}`, params
  ).catch(err => console.error('[changeTracker] insert failed:', err.message));
}

module.exports = { snapshotterFor, diffSnapshots, logChanges, executionSnapshot };
