// backend/src/routes/audit.js
// User-activity report over audit_logs. Admin only.
const express = require('express');
const router  = express.Router();
const ExcelJS = require('exceljs');
const { pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

function buildWhere(q) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$X', `$${params.length}`)); };

  if (q.from_date) add('created_at >= $X::date', q.from_date);
  if (q.to_date)   add("created_at < ($X::date + INTERVAL '1 day')", q.to_date);
  if (q.user_id)   add('user_id = $X', parseInt(q.user_id));
  if (q.module)    add('module = $X', q.module);
  if (q.action)    add('action = $X', q.action);
  if (q.q) {
    params.push(`%${q.q}%`);
    const n = params.length;
    where.push(`(path ILIKE $${n} OR entity_id ILIKE $${n} OR user_name ILIKE $${n} OR user_login ILIKE $${n} OR details::text ILIKE $${n})`);
  }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// GET /api/audit — paginated activity list
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const { whereSql, params } = buildWhere(req.query);

    const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM audit_logs ${whereSql}`, params);
    const total = totalRes.rows[0].n;

    const rows = await pool.query(
      `SELECT id, user_id, user_name, user_login, method, path, module, action,
              entity_id, status_code, success, details, ip, created_at
       FROM audit_logs ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);

    res.json({ rows: rows.rows, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/audit/filters — dropdown values
router.get('/filters', authenticate, authorize('admin'), async (_req, res) => {
  try {
    const users = await pool.query(
      `SELECT DISTINCT user_id, user_name FROM audit_logs
       WHERE user_id IS NOT NULL ORDER BY user_name`);
    const modules = await pool.query(
      `SELECT DISTINCT module FROM audit_logs WHERE module IS NOT NULL ORDER BY module`);
    const actions = await pool.query(
      `SELECT DISTINCT action FROM audit_logs WHERE action IS NOT NULL ORDER BY action`);
    res.json({
      users:   users.rows,
      modules: modules.rows.map(r => r.module),
      actions: actions.rows.map(r => r.action),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/audit/export — Excel with the same filters (no pagination, capped)
router.get('/export', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { whereSql, params } = buildWhere(req.query);
    const rows = await pool.query(
      `SELECT created_at, user_name, user_login, action, module, entity_id,
              method, path, status_code, success, details, ip
       FROM audit_logs ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT 20000`, params);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('User Activity');
    ws.columns = [
      { header: 'Timestamp',  key: 'ts',     width: 22 },
      { header: 'User',       key: 'user',   width: 22 },
      { header: 'Login ID',   key: 'login',  width: 16 },
      { header: 'Action',     key: 'action', width: 12 },
      { header: 'Module',     key: 'module', width: 18 },
      { header: 'Record #',   key: 'entity', width: 10 },
      { header: 'Method',     key: 'method', width: 8 },
      { header: 'API Path',   key: 'path',   width: 36 },
      { header: 'Status',     key: 'status', width: 8 },
      { header: 'Success',    key: 'ok',     width: 8 },
      { header: 'Details',    key: 'details', width: 60 },
      { header: 'IP',         key: 'ip',     width: 15 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const r of rows.rows) {
      ws.addRow({
        ts: new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        user: r.user_name || '—', login: r.user_login || '',
        action: r.action, module: r.module, entity: r.entity_id || '',
        method: r.method, path: r.path, status: r.status_code,
        ok: r.success ? 'YES' : 'NO',
        details: r.details ? JSON.stringify(r.details) : '',
        ip: r.ip || '',
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename=user_activity_report.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// FIELD-LEVEL CHANGE HISTORY (data_change_logs) — one row per changed field
// ═════════════════════════════════════════════════════════════════════════════
function buildChangesWhere(q) {
  const where = [];
  const params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace('$X', `$${params.length}`)); };
  if (q.from_date) add('created_at >= $X::date', q.from_date);
  if (q.to_date)   add("created_at < ($X::date + INTERVAL '1 day')", q.to_date);
  if (q.user_id)   add('user_id = $X', parseInt(q.user_id));
  if (q.module)    add('module = $X', q.module);
  if (q.entity_id) add('entity_id = $X', String(q.entity_id));
  if (q.q) {
    params.push(`%${q.q}%`);
    const n = params.length;
    where.push(`(field ILIKE $${n} OR row_label ILIKE $${n} OR old_value ILIKE $${n} OR new_value ILIKE $${n} OR user_name ILIKE $${n} OR entity_id ILIKE $${n})`);
  }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// GET /api/audit/changes — paginated field-level change rows
router.get('/changes', authenticate, authorize('admin'), async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const { whereSql, params } = buildChangesWhere(req.query);

    const totalRes = await pool.query(`SELECT COUNT(*)::int AS n FROM data_change_logs ${whereSql}`, params);
    const rows = await pool.query(
      `SELECT id, module, entity_id, row_label, field, old_value, new_value,
              action, user_id, user_name, user_login, created_at
       FROM data_change_logs ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params);

    res.json({ rows: rows.rows, total: totalRes.rows[0].n, page,
               pages: Math.max(1, Math.ceil(totalRes.rows[0].n / limit)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/audit/changes/export — styled Excel (capped)
router.get('/changes/export', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { whereSql, params } = buildChangesWhere(req.query);
    const rows = await pool.query(
      `SELECT created_at, user_name, user_login, module, entity_id, row_label,
              field, old_value, new_value, action
       FROM data_change_logs ${whereSql}
       ORDER BY created_at DESC, id DESC LIMIT 20000`, params);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Change History', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Timestamp', key: 'ts', width: 22 },
      { header: 'User',      key: 'user', width: 20 },
      { header: 'User ID',   key: 'login', width: 14 },
      { header: 'Module',    key: 'module', width: 16 },
      { header: 'Record #',  key: 'entity', width: 10 },
      { header: 'Row',       key: 'row', width: 28 },
      { header: 'Field',     key: 'field', width: 18 },
      { header: 'Old Value', key: 'old', width: 30 },
      { header: 'New Value', key: 'new', width: 30 },
      { header: 'Action',    key: 'action', width: 10 },
    ];
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    for (const r of rows.rows) {
      const row = ws.addRow({
        ts: new Date(r.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        user: r.user_name || '—', login: r.user_login || '',
        module: r.module, entity: r.entity_id, row: r.row_label,
        field: r.field, old: r.old_value ?? '', new: r.new_value ?? '', action: r.action,
      });
      row.getCell('old').font = { color: { argb: 'FFC0392B' } };
      row.getCell('new').font = { color: { argb: 'FF1E8449' } };
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Disposition', 'attachment; filename=change_history_report.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(buf));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
