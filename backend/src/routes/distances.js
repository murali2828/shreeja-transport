// backend/src/routes/distances.js
// Distance Master — CRUD + Excel bulk import/export
// Stores planner-entered road distances between BMCUs and location nodes

const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const multer  = require('multer');
const { pool } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');

const XL_FILTER = (req, file, cb) => {
  const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname || '');
  cb(ok ? null : new Error('Only .xlsx / .xls / .csv files are allowed'), ok);
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: XL_FILTER });

// ─── Helper: build human-readable node label ─────────────────────────────────
function nodeLabel(type, row) {
  if (!row) return `${type}:unknown`;
  switch (type) {
    case 'bmcu':           return `${row.bmcu_code} — ${row.bmcu_name}`;
    case 'starting_point': return `[Start] ${row.name}`;
    case 'delivery_point': return `[Plant] ${row.name}`;
    case 'testing_point':  return `[Test]  ${row.name}`;
    default: return row.name || String(row.id);
  }
}

// ─── Helper: normalise pair so from ≤ to (avoids duplicate rows) ─────────────
function normalisePair(fromType, fromId, toType, toId) {
  // Must match the DB constraint uq_distance_pair exactly:
  //   (from_type, from_id) < (to_type, to_id)  — SQL row-wise comparison,
  // i.e. types compare as strings but ids compare NUMERICALLY. The previous
  // string-key comparison ('bmcu:10' < 'bmcu:9') broke same-type pairs with
  // mixed digit lengths and violated the check constraint on insert.
  const a = Number(fromId), b = Number(toId);
  if (fromType < toType || (fromType === toType && a < b))
    return { fromType, fromId: a, toType, toId: b };
  return { fromType: toType, fromId: b, toType: fromType, toId: a };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/distances
// Returns all distances enriched with node names, optionally filtered
// Query: ?from_type=bmcu&from_id=5&to_type=bmcu
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { from_type, from_id, to_type, search } = req.query;

    let sql = `
      SELECT dm.*,
        -- From node resolved name
        CASE dm.from_type
          WHEN 'bmcu'           THEN (SELECT bmcu_code||' — '||bmcu_name FROM bmcus b WHERE b.id=dm.from_id)
          WHEN 'starting_point' THEN '[Start] '||(SELECT name FROM starting_points WHERE id=dm.from_id)
          WHEN 'delivery_point' THEN '[Plant] '||(SELECT name FROM delivery_points WHERE id=dm.from_id)
          WHEN 'testing_point'  THEN '[Test] ' ||(SELECT name FROM testing_points  WHERE id=dm.from_id)
        END AS from_name,
        -- To node resolved name
        CASE dm.to_type
          WHEN 'bmcu'           THEN (SELECT bmcu_code||' — '||bmcu_name FROM bmcus b WHERE b.id=dm.to_id)
          WHEN 'starting_point' THEN '[Start] '||(SELECT name FROM starting_points WHERE id=dm.to_id)
          WHEN 'delivery_point' THEN '[Plant] '||(SELECT name FROM delivery_points WHERE id=dm.to_id)
          WHEN 'testing_point'  THEN '[Test] ' ||(SELECT name FROM testing_points  WHERE id=dm.to_id)
        END AS to_name,
        u.full_name AS updated_by_name
      FROM distance_master dm
      LEFT JOIN users u ON u.id = dm.updated_by
      WHERE 1=1`;

    const params = [];
    if (from_type) { params.push(from_type); sql += ` AND (dm.from_type=$${params.length} OR dm.to_type=$${params.length})`; }
    if (from_id)   { params.push(from_id);   sql += ` AND (dm.from_id=$${params.length}  OR dm.to_id=$${params.length})`; }
    if (to_type)   { params.push(to_type);   sql += ` AND (dm.to_type=$${params.length}  OR dm.from_type=$${params.length})`; }
    sql += ' ORDER BY dm.from_type, dm.from_id, dm.to_type, dm.to_id';

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/distances/lookup?from_type=bmcu&from_id=5&to_type=bmcu&to_id=9
// Quick lookup used by optimizer
// ─────────────────────────────────────────────────────────────────────────────
router.get('/lookup', authenticate, async (req, res) => {
  try {
    const { from_type, from_id, to_type, to_id } = req.query;
    if (!from_type || !from_id || !to_type || !to_id)
      return res.status(400).json({ error: 'from_type, from_id, to_type, to_id all required' });

    const { fromType, fromId, toType, toId } = normalisePair(from_type, parseInt(from_id), to_type, parseInt(to_id));
    const r = await pool.query(
      `SELECT distance_km FROM distance_master
       WHERE from_type=$1 AND from_id=$2 AND to_type=$3 AND to_id=$4`,
      [fromType, fromId, toType, toId]
    );
    if (!r.rows.length) return res.json({ found: false, distance_km: null });
    res.json({ found: true, distance_km: parseFloat(r.rows[0].distance_km) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/distances/summary
// Returns coverage stats — how many BMCU pairs have distances entered
// ─────────────────────────────────────────────────────────────────────────────
router.get('/summary', authenticate, async (req, res) => {
  try {
    const totalBmcus = await pool.query('SELECT COUNT(*) FROM bmcus WHERE is_active=TRUE');
    const n = parseInt(totalBmcus.rows[0].count);
    const maxBmcuPairs = (n * (n - 1)) / 2;

    const enteredPairs = await pool.query(
      "SELECT COUNT(*) FROM distance_master WHERE from_type='bmcu' AND to_type='bmcu'"
    );
    const depotPairs = await pool.query(
      `SELECT COUNT(*) FROM distance_master
       WHERE (from_type='bmcu' AND to_type IN ('starting_point','delivery_point'))
          OR (to_type='bmcu' AND from_type IN ('starting_point','delivery_point'))`
    );

    res.json({
      total_active_bmcus: n,
      max_bmcu_pairs: maxBmcuPairs,
      entered_bmcu_pairs: parseInt(enteredPairs.rows[0].count),
      entered_depot_pairs: parseInt(depotPairs.rows[0].count),
      coverage_pct: maxBmcuPairs > 0
        ? Math.round(parseInt(enteredPairs.rows[0].count) / maxBmcuPairs * 100 * 10) / 10
        : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/distances
// Body: { from_type, from_id, to_type, to_id, distance_km, road_notes }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { from_type, from_id, to_type, to_id, distance_km, road_notes } = req.body;
    if (!from_type || !from_id || !to_type || !to_id || distance_km == null)
      return res.status(400).json({ error: 'from_type, from_id, to_type, to_id, distance_km required' });
    if (from_type === to_type && from_id === to_id)
      return res.status(400).json({ error: 'From and To cannot be the same node' });

    const { fromType, fromId, toType, toId } = normalisePair(from_type, parseInt(from_id), to_type, parseInt(to_id));

    const r = await pool.query(
      `INSERT INTO distance_master (from_type, from_id, to_type, to_id, distance_km, road_notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (from_type, from_id, to_type, to_id)
       DO UPDATE SET distance_km=$5, road_notes=$6, updated_by=$7, updated_at=NOW()
       RETURNING *`,
      [fromType, fromId, toType, toId, parseFloat(distance_km), road_notes || null, req.user.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/distances/:id
// ─────────────────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const { distance_km, road_notes } = req.body;
    const r = await pool.query(
      `UPDATE distance_master SET distance_km=$1, road_notes=$2, updated_by=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [parseFloat(distance_km), road_notes || null, req.user.id, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/distances/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, authorize('admin'), async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM distance_master WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/distances/template
// Downloads Excel template for bulk distance entry
// ─────────────────────────────────────────────────────────────────────────────
router.get('/template', authenticate, async (req, res) => {
  try {
    // Fetch all active nodes to help planner fill the template
    const bmcus  = await pool.query('SELECT id, bmcu_code, bmcu_name, district, state FROM bmcus WHERE is_active=TRUE ORDER BY bmcu_code');
    const starts = await pool.query('SELECT id, name FROM starting_points WHERE is_active=TRUE');
    const plants = await pool.query('SELECT id, name FROM delivery_points WHERE is_active=TRUE');

    const wb = XLSX.utils.book_new();

    // Sheet 1: BMCU-to-BMCU distances
    const bmcuHeaders = ['from_type','from_id','from_name','to_type','to_id','to_name','distance_km','road_notes'];
    const bmcuRows = [bmcuHeaders];
    // Pre-fill with all pairs so planner just enters km
    const bmcuList = bmcus.rows;
    for (let i = 0; i < bmcuList.length; i++) {
      for (let j = i + 1; j < bmcuList.length; j++) {
        bmcuRows.push([
          'bmcu', bmcuList[i].id, `${bmcuList[i].bmcu_code} - ${bmcuList[i].bmcu_name}`,
          'bmcu', bmcuList[j].id, `${bmcuList[j].bmcu_code} - ${bmcuList[j].bmcu_name}`,
          '', '' // planner fills distance_km and optional road_notes
        ]);
      }
    }
    const wsBmcu = XLSX.utils.aoa_to_sheet(bmcuRows);
    // Set column widths
    wsBmcu['!cols'] = [10,8,30,10,8,30,12,25].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsBmcu, 'BMCU-to-BMCU');

    // Sheet 2: Depot-to-BMCU distances (starts and plants to all BMCUs)
    const depotHeaders = ['from_type','from_id','from_name','to_type','to_id','to_name','distance_km','road_notes'];
    const depotRows = [depotHeaders];
    for (const sp of starts.rows) {
      for (const b of bmcuList) {
        depotRows.push(['starting_point', sp.id, `[Start] ${sp.name}`, 'bmcu', b.id, `${b.bmcu_code} - ${b.bmcu_name}`, '', '']);
      }
    }
    for (const dp of plants.rows) {
      for (const b of bmcuList) {
        depotRows.push(['delivery_point', dp.id, `[Plant] ${dp.name}`, 'bmcu', b.id, `${b.bmcu_code} - ${b.bmcu_name}`, '', '']);
      }
    }
    const wsDepot = XLSX.utils.aoa_to_sheet(depotRows);
    wsDepot['!cols'] = depotHeaders.map((_, i) => ({ wch: [16,8,25,10,8,30,12,25][i] }));
    XLSX.utils.book_append_sheet(wb, wsDepot, 'Depot-to-BMCU');

    // Sheet 3: Reference — all nodes
    const refRows = [['Type','ID','Code / Name','District','State']];
    for (const b of bmcuList) refRows.push(['bmcu', b.id, `${b.bmcu_code} - ${b.bmcu_name}`, b.district||'', b.state||'']);
    for (const s of starts.rows) refRows.push(['starting_point', s.id, s.name, '', '']);
    for (const d of plants.rows) refRows.push(['delivery_point', d.id, d.name, '', '']);
    const wsRef = XLSX.utils.aoa_to_sheet(refRows);
    wsRef['!cols'] = [16,8,35,15,10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsRef, 'Reference');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=distance_master_template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/distances/upload
// Bulk upload from the Excel template
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', authenticate, authorize('admin'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const client = await pool.connect();
  try {
    const wb    = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetNames = ['BMCU-to-BMCU', 'Depot-to-BMCU'];

    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    await client.query('BEGIN');

    for (const sheetName of sheetNames) {
      if (!wb.SheetNames.includes(sheetName)) continue;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 2; // 1-indexed + header

        const fromType = (row.from_type || '').trim();
        const fromId   = parseInt(row.from_id);
        const toType   = (row.to_type || '').trim();
        const toId     = parseInt(row.to_id);
        const distKm   = parseFloat(row.distance_km);

        // Skip empty rows
        if (!fromType || !fromId || !toType || !toId) { skipped++; continue; }
        if (isNaN(distKm) || distKm < 0) {
          errors.push(`Sheet "${sheetName}" Row ${rowNum}: invalid distance_km "${row.distance_km}"`);
          continue;
        }
        if (fromType === toType && fromId === toId) {
          errors.push(`Sheet "${sheetName}" Row ${rowNum}: from and to are the same node`);
          continue;
        }

        const validTypes = ['bmcu','starting_point','delivery_point','testing_point'];
        if (!validTypes.includes(fromType) || !validTypes.includes(toType)) {
          errors.push(`Sheet "${sheetName}" Row ${rowNum}: invalid node type`);
          continue;
        }

        const { fromType: ft, fromId: fi, toType: tt, toId: ti } = normalisePair(fromType, fromId, toType, toId);

        const r = await client.query(
          `INSERT INTO distance_master (from_type, from_id, to_type, to_id, distance_km, road_notes, created_by, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
           ON CONFLICT (from_type, from_id, to_type, to_id)
           DO UPDATE SET distance_km=$5, road_notes=$6, updated_by=$7, updated_at=NOW()
           RETURNING (xmax = 0) AS is_insert`,
          [ft, fi, tt, ti, distKm, row.road_notes || null, req.user.id]
        );
        if (r.rows[0].is_insert) inserted++; else updated++;
      }
    }

    await client.query('COMMIT');
    res.json({ inserted, updated, skipped, errors, total: inserted + updated });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Distance upload error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/distances/export
// Export all current distances as Excel
// ─────────────────────────────────────────────────────────────────────────────
router.get('/export', authenticate, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT dm.*,
        CASE dm.from_type
          WHEN 'bmcu'           THEN (SELECT bmcu_code||' — '||bmcu_name FROM bmcus WHERE id=dm.from_id)
          WHEN 'starting_point' THEN (SELECT '[Start] '||name FROM starting_points WHERE id=dm.from_id)
          WHEN 'delivery_point' THEN (SELECT '[Plant] '||name FROM delivery_points WHERE id=dm.from_id)
          WHEN 'testing_point'  THEN (SELECT '[Test] '||name  FROM testing_points  WHERE id=dm.from_id)
        END AS from_name,
        CASE dm.to_type
          WHEN 'bmcu'           THEN (SELECT bmcu_code||' — '||bmcu_name FROM bmcus WHERE id=dm.to_id)
          WHEN 'starting_point' THEN (SELECT '[Start] '||name FROM starting_points WHERE id=dm.to_id)
          WHEN 'delivery_point' THEN (SELECT '[Plant] '||name FROM delivery_points WHERE id=dm.to_id)
          WHEN 'testing_point'  THEN (SELECT '[Test] '||name  FROM testing_points  WHERE id=dm.to_id)
        END AS to_name
      FROM distance_master dm
      ORDER BY dm.from_type, dm.from_id, dm.to_type, dm.to_id
    `);

    const wb = XLSX.utils.book_new();
    const headers = ['ID','From Type','From ID','From Name','To Type','To ID','To Name','Distance KM','Google KM (ref)','Road Notes','Updated At'];
    const rows = [headers, ...r.rows.map(row => [
      row.id, row.from_type, row.from_id, row.from_name,
      row.to_type, row.to_id, row.to_name,
      parseFloat(row.distance_km),
      row.google_km != null ? parseFloat(row.google_km) : '',
      row.road_notes || '',
      row.updated_at ? new Date(row.updated_at).toLocaleDateString() : ''
    ])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [6,16,8,35,16,8,35,12,13,25,14].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'Distances');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=distance_master_export.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /:id/google-refresh — fetch the Google reference for a pair ────────
// Stores the Google Routes km in google_km WITHOUT touching distance_km, so
// manually entered distances can be compared against Google.
const { googleLegKm } = require('../services/roadDistance');
router.post('/:id(\\d+)/google-refresh', authenticate, authorize('admin'), async (req, res) => {
  try {
    const row = (await pool.query('SELECT * FROM distance_master WHERE id=$1', [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'Distance entry not found' });
    const coords = async (type, id) => {
      const table = { bmcu: 'bmcus', starting_point: 'starting_points',
                      delivery_point: 'delivery_points', testing_point: 'testing_points' }[type];
      const r = await pool.query(`SELECT latitude, longitude FROM ${table} WHERE id=$1`, [id]);
      const lat = parseFloat(r.rows[0]?.latitude), lng = parseFloat(r.rows[0]?.longitude);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    };
    const a = await coords(row.from_type, row.from_id);
    const z = await coords(row.to_type, row.to_id);
    if (!a || !z)
      return res.status(400).json({ error: 'One of the locations has no coordinates — add lat/lng in its master first (see Missing Coordinates report)' });
    const km = await googleLegKm(a.lat, a.lng, z.lat, z.lng);
    if (km == null)
      return res.status(502).json({ error: 'Google Routes API did not return a distance for this pair' });
    const g = Math.round(km * 100) / 100;
    await pool.query('UPDATE distance_master SET google_km=$1, updated_at=NOW() WHERE id=$2', [g, req.params.id]);
    res.json({ google_km: g });
  } catch (err) {
    console.error('Google refresh error:', err);
    res.status(500).json({ error: 'Failed to fetch the Google reference distance' });
  }
});

// ─── GET /missing-coords — Excel of location nodes without lat/lng ───────────
// Nodes lacking coordinates cannot use Google Routes: their legs fall back to
// estimates (or go missing). Includes 30-day usage so the team fixes the
// busiest locations first.
router.get('/missing-coords', authenticate, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 'BMCU' AS node_type, b.bmcu_code AS code, b.bmcu_name AS name,
             b.is_active,
             CASE WHEN b.latitude IS NULL AND b.longitude IS NULL THEN 'Latitude + Longitude'
                  WHEN b.latitude IS NULL THEN 'Latitude' ELSE 'Longitude' END AS missing,
             (SELECT COUNT(DISTINCT teb.execution_id) FROM trip_execution_bmcus teb
               JOIN trip_executions te ON te.id = teb.execution_id
               JOIN trip_plans tp ON tp.id = te.trip_plan_id
               WHERE teb.bmcu_id = b.id AND teb.is_deleted = FALSE
                 AND tp.plan_for_date >= CURRENT_DATE - 30)::int AS trips_last_30_days
      FROM bmcus b WHERE b.latitude IS NULL OR b.longitude IS NULL
      UNION ALL
      SELECT 'Starting Point', NULL, sp.name, sp.is_active,
             CASE WHEN sp.latitude IS NULL AND sp.longitude IS NULL THEN 'Latitude + Longitude'
                  WHEN sp.latitude IS NULL THEN 'Latitude' ELSE 'Longitude' END,
             (SELECT COUNT(*) FROM trip_plans tp
               WHERE tp.start_point_id = sp.id AND tp.plan_for_date >= CURRENT_DATE - 30
                 AND tp.status NOT IN ('cancelled','deleted'))::int
      FROM starting_points sp WHERE sp.latitude IS NULL OR sp.longitude IS NULL
      UNION ALL
      SELECT 'Delivery Point', NULL, dp.name, dp.is_active,
             CASE WHEN dp.latitude IS NULL AND dp.longitude IS NULL THEN 'Latitude + Longitude'
                  WHEN dp.latitude IS NULL THEN 'Latitude' ELSE 'Longitude' END,
             (SELECT COUNT(*) FROM trip_plans tp
               WHERE tp.delivery_point_id = dp.id AND tp.plan_for_date >= CURRENT_DATE - 30
                 AND tp.status NOT IN ('cancelled','deleted'))::int
      FROM delivery_points dp WHERE dp.latitude IS NULL OR dp.longitude IS NULL
      UNION ALL
      SELECT 'Testing Point', NULL, tpt.name, tpt.is_active,
             CASE WHEN tpt.latitude IS NULL AND tpt.longitude IS NULL THEN 'Latitude + Longitude'
                  WHEN tpt.latitude IS NULL THEN 'Latitude' ELSE 'Longitude' END,
             0
      FROM testing_points tpt WHERE tpt.latitude IS NULL OR tpt.longitude IS NULL
      ORDER BY trips_last_30_days DESC, node_type, name`);

    const wb = XLSX.utils.book_new();
    const headers = ['Type', 'BMCU Code', 'Name', 'Missing', 'Active', 'Trips (last 30 days)'];
    const rows = [headers, ...r.rows.map(row => [
      row.node_type, row.code || '', row.name, row.missing,
      row.is_active ? 'Yes' : 'No', row.trips_last_30_days,
    ])];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [16, 14, 38, 22, 8, 18].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'Missing Coordinates');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=missing_coordinates_report.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
