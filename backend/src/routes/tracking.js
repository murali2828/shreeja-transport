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

module.exports = router;
