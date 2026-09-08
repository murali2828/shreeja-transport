// backend/src/routes/tracking.js
// Live tanker tracking (WheelsEye GPS). Reads the tables the poller
// (jobs/wheelseyePoll.js) keeps up to date; nothing here calls WheelsEye
// except the admin-only poll-now endpoint. The access token is never
// returned by any route.
const express = require('express');
const router  = express.Router();
const { query } = require('../config/db');
const { authenticate, authorize, authorizeOrModule } = require('../middleware/auth');
const { normalizeVehicle } = require('../services/wheelseye');
const { runOnce, getStatus } = require('../jobs/wheelseyePoll');
const { analyzeTrip, getBmcuMaster } = require('../services/tripAnalysis');
const ExcelJS = require('exceljs');
const { fmtDateDisplay } = require('../utils/date');

const canView = authorizeOrModule('execution', 'admin','planner','executor','biller','viewer');

const staleMinutes = () => Math.max(1, parseInt(process.env.WHEELSEYE_STALE_MINUTES || '30', 10) || 30);

// GET /api/tracking/positions — every matched tanker's latest position with
// its current trip context, plus WheelsEye vehicles that match no tanker.
router.get('/positions', authenticate, canView, async (req, res) => {
  try {
    const stale = staleMinutes();
    const pos = await query(`
      SELECT g.vehicle_number, g.vehicle_number_raw, g.tanker_id, g.device_number,
             g.latitude, g.longitude, g.speed, g.ignition, g.angle, g.accurate, g.location,
             g.gps_time, g.received_at,
             t.tanker_number, t.is_active, t.capacity_litres, t.vendor_name,
             tr.trip_no, tr.route_name, tr.delivery_point, tr.gp_at,
             (g.gps_time IS NULL OR g.gps_time < NOW() - ($1 || ' minutes')::interval) AS is_stale,
             (COALESCE(g.ignition, FALSE) AND COALESCE(g.speed, 0) > 2) AS is_moving
      FROM tanker_gps_latest g
      JOIN tankers t ON t.id = g.tanker_id
      LEFT JOIN (
        -- Latest trip-cycle prints per tanker (same rule as buildTankerPosition in tripDocs.js)
        SELECT DISTINCT ON (tp.tanker_id)
          tp.tanker_id, tp.id AS plan_id, tp.trip_no, rm.route_name, dp.name AS delivery_point,
          (SELECT MIN(printed_at) FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='gate_pass') AS gp_at
        FROM trip_plans tp
        LEFT JOIN route_masters rm ON rm.id=tp.route_id
        LEFT JOIN delivery_points dp ON dp.id=tp.delivery_point_id
        WHERE tp.tanker_id IS NOT NULL AND tp.status NOT IN ('cancelled','deleted')
          AND EXISTS (SELECT 1 FROM trip_document_prints p WHERE p.trip_plan_id=tp.id)
        ORDER BY tp.tanker_id,
          (SELECT MAX(printed_at) FROM trip_document_prints p WHERE p.trip_plan_id=tp.id) DESC
      ) tr ON tr.tanker_id = g.tanker_id
      WHERE g.tanker_id IS NOT NULL
      ORDER BY t.tanker_number`, [String(stale)]);

    const unmatched = await query(`
      SELECT vehicle_number_raw, vehicle_number, gps_time, received_at
      FROM tanker_gps_latest WHERE tanker_id IS NULL ORDER BY vehicle_number`);

    const st = getStatus();
    res.json({
      polled_at: st.lastSuccessAt,
      poll_status: { enabled: st.enabled, last_run_at: st.lastRunAt, last_error: st.lastError,
                     interval_seconds: st.intervalSeconds, stale_minutes: stale },
      positions: pos.rows.map(r => ({
        ...r,
        latitude:  r.latitude  == null ? null : Number(r.latitude),
        longitude: r.longitude == null ? null : Number(r.longitude),
        speed:     r.speed     == null ? null : Number(r.speed),
      })),
      unmatched: unmatched.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tracking/positions/:tankerNumber/history?from=&to=
// Trail points for one tanker (default last 24 h, capped at 7 days).
router.get('/positions/:tankerNumber/history', authenticate, canView, async (req, res) => {
  try {
    const norm = normalizeVehicle(req.params.tankerNumber);
    if (!norm) return res.status(400).json({ error: 'tankerNumber required' });
    const MAX_MS = 7 * 24 * 60 * 60 * 1000;
    let to   = req.query.to   ? new Date(req.query.to)   : new Date();
    let from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 24 * 60 * 60 * 1000);
    if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'Invalid from/to' });
    if (to.getTime() - from.getTime() > MAX_MS) from = new Date(to.getTime() - MAX_MS);

    const r = await query(`
      SELECT latitude, longitude, speed, ignition, gps_time
      FROM tanker_gps_history
      WHERE vehicle_number = $1 AND gps_time >= $2 AND gps_time <= $3
      ORDER BY gps_time`, [norm, from.toISOString(), to.toISOString()]);
    res.json(r.rows.map(p => ({
      latitude: Number(p.latitude), longitude: Number(p.longitude),
      speed: p.speed == null ? null : Number(p.speed), ignition: p.ignition, gps_time: p.gps_time,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tracking/status — poller health + row counts (never the token).
router.get('/status', authenticate, canView, async (req, res) => {
  try {
    const c = await query(`
      SELECT COUNT(*)::int AS latest_rows,
             COUNT(*) FILTER (WHERE tanker_id IS NOT NULL)::int AS matched,
             COUNT(*) FILTER (WHERE tanker_id IS NULL)::int AS unmatched,
             MAX(gps_time) AS newest_gps_time
      FROM tanker_gps_latest`);
    const h = await query('SELECT COUNT(*)::bigint AS history_rows FROM tanker_gps_history');
    res.json({
      ...getStatus(),
      stale_minutes: staleMinutes(),
      fetch_address: process.env.WHEELSEYE_FETCH_ADDRESS === 'true',
      history_days: parseInt(process.env.WHEELSEYE_HISTORY_DAYS || '90', 10) || 90,
      ...c.rows[0],
      history_rows: Number(h.rows[0].history_rows),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tracking/poll-now — admin only; runs one poll cycle immediately.
router.post('/poll-now', authenticate, authorize('admin'), async (req, res) => {
  try {
    if (!process.env.WHEELSEYE_ACCESS_TOKEN)
      return res.status(503).json({ error: 'WheelsEye tracking is not configured on this server' });
    const r = await runOnce();
    if (!r.ok) return res.status(r.skipped ? 409 : 502).json({ error: r.error });
    res.json({ received: r.received, upserted: r.upserted, historyAdded: r.historyAdded,
               matched: r.matched, unmatched: r.unmatched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Trip playback / analysis (phase 2) — services/tripAnalysis.js
// ─────────────────────────────────────────────────────────────────────────────
const numOrNull = v => (v == null ? null : Number(v));
const fmtIn = ts => ts ? new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const isoDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const sendXlsx = async (res, wb, filename) => {
  res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
};

// GET /api/tracking/bmcus — every active BMCU / plant with coordinates (map layer).
router.get('/bmcus', authenticate, canView, async (req, res) => {
  try {
    const [b, s, d] = await Promise.all([
      query(`SELECT id, bmcu_code AS code, bmcu_name AS name, latitude AS lat, longitude AS lng
             FROM bmcus WHERE is_active = TRUE AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY bmcu_code`),
      query(`SELECT id, name, latitude AS lat, longitude AS lng
             FROM starting_points WHERE is_active = TRUE AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY name`),
      query(`SELECT id, name, latitude AS lat, longitude AS lng
             FROM delivery_points WHERE is_active = TRUE AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY name`),
    ]);
    const conv = r => ({ ...r, lat: Number(r.lat), lng: Number(r.lng) });
    res.json({ bmcus: b.rows.map(conv), starting_points: s.rows.map(conv), delivery_points: d.rows.map(conv) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Executions for a plan date (optionally one tanker) with OUT/IN and whether
// any GPS history exists for the tanker on that day.
const TRIPS_SQL = `
  SELECT te.id AS execution_id, te.trip_plan_id, te.status, tp.trip_no, tp.plan_for_date,
         tp.tanker_id, t.tanker_number, t.vendor_name, rm.route_name, dp.name AS delivery_point,
         te.calculated_km, te.actual_km,
         (SELECT MIN(printed_at)::timestamptz FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='gate_pass') AS out_at,
         (SELECT MIN(printed_at)::timestamptz FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='coa')       AS in_at,
         EXISTS (SELECT 1 FROM tanker_gps_history h
                 WHERE h.tanker_id = tp.tanker_id
                   AND h.gps_time >= (tp.plan_for_date::timestamp AT TIME ZONE 'Asia/Kolkata')
                   AND h.gps_time <  ((tp.plan_for_date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')) AS has_trail
  FROM trip_executions te
  JOIN trip_plans tp ON tp.id = te.trip_plan_id
  LEFT JOIN tankers t          ON t.id  = tp.tanker_id
  LEFT JOIN route_masters rm   ON rm.id = tp.route_id
  LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
  WHERE tp.status NOT IN ('cancelled','deleted') AND te.status <> 'cancelled'`;

// GET /api/tracking/trips?date=YYYY-MM-DD&tanker=<tanker_number>
router.get('/trips', authenticate, canView, async (req, res) => {
  try {
    const { date, tanker } = req.query;
    if (!isoDate(date)) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
    const args = [date];
    let sql = TRIPS_SQL + ' AND tp.plan_for_date = $1';
    if (tanker) {
      args.push(normalizeVehicle(tanker));
      sql += ` AND upper(regexp_replace(t.tanker_number, '[^A-Za-z0-9]', '', 'g')) = $2`;
    }
    sql += ' ORDER BY t.tanker_number, tp.trip_no, te.id';
    const r = await query(sql, args);
    res.json(r.rows.map(x => ({
      execution_id: x.execution_id, trip_plan_id: x.trip_plan_id, trip_no: x.trip_no, plan_for_date: x.plan_for_date,
      tanker_number: x.tanker_number, vendor_name: x.vendor_name, route_name: x.route_name, delivery_point: x.delivery_point,
      status: x.status, out_at: x.out_at, in_at: x.in_at, has_trail: x.has_trail,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tracking/trip/:executionId?from&to — full analysis JSON.
router.get('/trip/:executionId', authenticate, canView, async (req, res) => {
  try {
    const id = parseInt(req.params.executionId, 10);
    if (!id) return res.status(400).json({ error: 'executionId required' });
    const opts = {};
    for (const k of ['from', 'to']) if (req.query[k]) {
      const d = new Date(req.query[k]);
      if (isNaN(d)) return res.status(400).json({ error: `Invalid ${k}` });
      opts[k] = d;
    }
    const a = await analyzeTrip(id, opts);
    if (!a) return res.status(404).json({ error: 'Execution not found' });
    res.json(a);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const STOP_TYPE = { start: 'Start point', bmcu: 'BMCU', delivery: 'Delivery point', unplanned: 'Unplanned' };
const stopWhere = s => s.node ? `${s.node.code ? s.node.code + ' ' : ''}${s.node.name || ''} (${s.distance_m} m)`
  : s.nearest_bmcu ? `${(s.nearest_bmcu.distance_m / 1000).toFixed(1)} km from ${s.nearest_bmcu.code} ${s.nearest_bmcu.name}` : 'No BMCU within 5 km';

// GET /api/tracking/trip/:executionId/report — Excel: Summary / BMCU Visits / Stops / Trail.
router.get('/trip/:executionId/report', authenticate, canView, async (req, res) => {
  try {
    const id = parseInt(req.params.executionId, 10);
    if (!id) return res.status(400).json({ error: 'executionId required' });
    const a = await analyzeTrip(id);
    if (!a) return res.status(404).json({ error: 'Execution not found' });
    const { execution: e, events, totals: t } = a;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Summary');
    ws.addRow([`Trip #${e.trip_no} — ${e.tanker_number || ''} — ${fmtDateDisplay(e.plan_for_date)}`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    const kv = [
      ['Trip', `#${e.trip_no}`], ['Tanker', e.tanker_number || ''], ['Vendor', e.vendor_name || ''],
      ['Date', fmtDateDisplay(e.plan_for_date)], ['Route', e.route_name || ''], ['Delivery point', e.delivery_point || ''],
      ['Execution status', e.status || ''],
      ['Tanker OUT (Gate Pass)', fmtIn(events.out_at)], ['Tanker IN (COA)', fmtIn(events.in_at)], ['Unloading completed', fmtIn(events.unload_at)],
      ['Analysis window', `${fmtIn(a.window.from)} → ${fmtIn(a.window.to)} (${a.window.source})`],
      ['GPS data', t.has_trail ? `${t.points} points, ${fmtIn(t.first_fix)} → ${fmtIn(t.last_fix)}` : "No GPS data recorded for this trip's window"],
      ['Trip duration (min)', t.trip_duration_minutes ?? ''], ['Duration source', t.duration_source || ''],
      ['Moving time (min)', t.moving_minutes ?? ''],
      ['BMCU waiting total (min)', t.bmcu_wait_minutes], ['Unplanned stops', `${t.unplanned_stop_count} stop(s), ${t.unplanned_stop_minutes} min`],
      ['Missed BMCUs', t.missed_bmcu_count ?? ''], ['Sequence deviation', t.has_trail ? (a.sequence_deviation ? 'Yes' : 'No') : ''],
      ['Actual BMCU order', a.actual_sequence.join(' → ')],
      ['Distance — GPS trail (km)', t.trail_km], ['Distance — calculated (km)', t.calculated_km ?? ''], ['Distance — actual entered (km)', t.actual_km ?? ''],
      ['Max speed (km/h)', t.max_speed], ['GPS glitches skipped', t.glitches],
      ['Parameters', `stop radius ${a.params.radius_m} m · min stop ${a.params.min_stop_minutes} min · geofence ${a.params.geofence_m} m`],
    ];
    kv.forEach(([k, v]) => { const r = ws.addRow([k, v]); r.getCell(1).font = { bold: true }; });
    ws.getColumn(1).width = 30; ws.getColumn(2).width = 60;

    const wv = wb.addWorksheet('BMCU Visits');
    wv.addRow(['Planned Seq', 'Code', 'Name', 'Planned Qty (L)', 'Visited', 'Arrived', 'Departed', 'Wait (min)', 'Missed']).font = { bold: true };
    a.bmcu_visits.forEach(v => wv.addRow([v.planned_seq, v.code, v.name, v.planned_qty ?? '',
      v.visited == null ? '' : v.visited ? 'Yes' : 'No', fmtIn(v.arrived_at), fmtIn(v.departed_at), v.wait_minutes,
      v.missed == null ? '' : v.missed ? 'Yes' : 'No']));
    wv.columns.forEach(c => { c.width = 16; }); wv.getColumn(3).width = 30;

    const wst = wb.addWorksheet('Stops');
    wst.addRow(['#', 'Type', 'Matched node / nearest BMCU', 'From', 'To', 'Minutes', 'Latitude', 'Longitude']).font = { bold: true };
    a.stops.forEach((s, i) => wst.addRow([i + 1, STOP_TYPE[s.type] || s.type, stopWhere(s), fmtIn(s.from), fmtIn(s.to), s.minutes,
      Number(s.lat.toFixed(6)), Number(s.lng.toFixed(6))]));
    wst.columns.forEach(c => { c.width = 18; }); wst.getColumn(3).width = 40;

    const wt = wb.addWorksheet('Trail');
    wt.addRow(['GPS Time', 'Latitude', 'Longitude', 'Speed (km/h)', 'Ignition']).font = { bold: true };
    a.trail.forEach(p => wt.addRow([fmtIn(p.gps_time), p.lat, p.lng, p.speed ?? '', p.ignition == null ? '' : p.ignition ? 'ON' : 'OFF']));
    wt.columns.forEach(c => { c.width = 18; });

    await sendXlsx(res, wb, `trip_${e.trip_no}_${e.tanker_number || ''}_${e.plan_for_date}.xlsx`);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tracking/report?from=YYYY-MM-DD&to=YYYY-MM-DD — fleet Excel, one row per
// execution (max 31 days). Trail points for the whole range are loaded in ONE
// query, grouped by tanker, and handed to analyzeTrip via opts.trailPoints.
router.get('/report', authenticate, canView, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!isoDate(from) || !isoDate(to)) return res.status(400).json({ error: 'from and to (YYYY-MM-DD) required' });
    const days = (new Date(to) - new Date(from)) / 86400000 + 1;
    if (days < 1 || days > 31) return res.status(400).json({ error: 'Range must be 1–31 days' });

    const execs = (await query(TRIPS_SQL + ' AND tp.plan_for_date BETWEEN $1 AND $2 ORDER BY tp.plan_for_date, t.tanker_number, tp.trip_no', [from, to])).rows;

    // One trail query for the whole range (+1 day so a trip's 24 h window fits), grouped by tanker.
    const trail = await query(`
      SELECT tanker_id, latitude, longitude, speed, ignition, gps_time
      FROM tanker_gps_history
      WHERE tanker_id IS NOT NULL
        AND gps_time >= ($1::date::timestamp AT TIME ZONE 'Asia/Kolkata')
        AND gps_time <  (($2::date + 2)::timestamp AT TIME ZONE 'Asia/Kolkata')
      ORDER BY tanker_id, gps_time`, [from, to]);
    const byTanker = new Map();
    for (const p of trail.rows) {
      if (!byTanker.has(p.tanker_id)) byTanker.set(p.tanker_id, []);
      byTanker.get(p.tanker_id).push(p);
    }
    const bmcuMaster = await getBmcuMaster();

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Trip Analysis');
    ws.addRow([`Trip execution analysis — ${fmtDateDisplay(from)} to ${fmtDateDisplay(to)} — ${execs.length} trip(s)`]).font = { bold: true, size: 13 };
    ws.addRow([]);
    ws.addRow(['Date', 'Trip', 'Tanker', 'Vendor', 'Route', 'Delivery Point', 'OUT', 'IN', 'Duration (min)', 'Duration Source',
               'Moving (min)', 'BMCU Wait (min)', 'Unplanned Stops', 'Unplanned Stop (min)', 'Missed BMCUs', 'Sequence Deviation',
               'Trail KM', 'Calculated KM', 'Actual KM', 'Has GPS']).font = { bold: true };
    for (const x of execs) {
      const a = await analyzeTrip(x.execution_id, { trailPoints: byTanker.get(x.tanker_id) || [], bmcuMaster });
      if (!a) continue;
      const t = a.totals;
      ws.addRow([fmtDateDisplay(x.plan_for_date), x.trip_no, x.tanker_number || '', x.vendor_name || '', x.route_name || '', x.delivery_point || '',
        fmtIn(a.events.out_at), fmtIn(a.events.in_at), t.trip_duration_minutes ?? '', t.duration_source || '',
        t.moving_minutes ?? '', t.bmcu_wait_minutes, t.unplanned_stop_count, t.unplanned_stop_minutes,
        t.missed_bmcu_count ?? '', t.has_trail ? (a.sequence_deviation ? 'Yes' : 'No') : '',
        t.trail_km, t.calculated_km ?? '', t.actual_km ?? '', t.has_trail ? 'Yes' : 'No']);
    }
    ws.columns.forEach(c => { c.width = 16; }); ws.getColumn(5).width = 28; ws.getColumn(6).width = 22;

    await sendXlsx(res, wb, `trip_analysis_${from}_${to}.xlsx`);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
