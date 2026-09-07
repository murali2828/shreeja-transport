// backend/src/services/tripAnalysis.js
// Trip execution analysis from the WheelsEye GPS trail (migration 038).
// For one execution: planned node chain (start → BMCUs → delivery), the GPS
// trail inside the trip's time window, detected stops, stop classification
// against the planned nodes, per-BMCU visits, and duration/distance totals.
// Pure logic + queries — no Express. Used by routes/tracking.js for the JSON
// endpoint, the per-trip Excel and the fleet Excel (which pre-loads trail
// points for a date range and passes them in via opts.trailPoints).
//
// Tuning (env, all optional):
//   TRACKING_STOP_RADIUS_M     default 150 — a stop is a run of points within this radius
//   TRACKING_STOP_MIN_MINUTES  default 5   — shorter runs are ignored
//   TRACKING_GEOFENCE_M        default 300 — a stop/point this close to a planned node "is at" it
const { query } = require('../config/db');
const { haversineKm } = require('../utils/geo');

const envNum = (k, d) => { const n = parseFloat(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };
const params = () => ({
  radius_m:         envNum('TRACKING_STOP_RADIUS_M', 150),
  geofence_m:       envNum('TRACKING_GEOFENCE_M', 300),
  min_stop_minutes: envNum('TRACKING_STOP_MIN_MINUTES', 5),
});

const num   = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const distM = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng) * 1000;
const mins  = (a, b) => Math.round(((new Date(b) - new Date(a)) / 60000) * 10) / 10;
const MAX_TRAIL_POINTS = 5000;
const GLITCH_KM = 5;            // jump > 5 km between consecutive fixes = GPS glitch
const NEAREST_BMCU_KM = 5;      // "unplanned stop 1.8 km from <bmcu>" search radius
const MOVING_SPEED = 2;         // km/h — same threshold as is_moving in routes/tracking.js

// ── Stop detection ───────────────────────────────────────────────────────────
// Walk the trail in order. A stop is a run of consecutive points where each
// point is within radius_m of the run's FIRST point and is "not moving"
// (speed <= 2 km/h or ignition off). The run closes when a point leaves the
// radius or is moving. Runs shorter than min_minutes are dropped.
// Exported for the synthetic sanity check; points need { lat, lng, speed, ignition, gps_time }.
function detectStops(trail, { radius_m = 150, min_minutes = 5 } = {}) {
  const stops = [];
  let run = null;
  const isStill = p => (p.speed != null && p.speed <= MOVING_SPEED) || p.ignition === false;
  const close = () => {
    if (run && run.points.length && mins(run.points[0].gps_time, run.points[run.points.length - 1].gps_time) >= min_minutes) {
      const pts = run.points;
      stops.push({
        from: pts[0].gps_time, to: pts[pts.length - 1].gps_time,
        minutes: mins(pts[0].gps_time, pts[pts.length - 1].gps_time),
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
        lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length,
        points: pts.length,
      });
    }
    run = null;
  };
  for (const p of trail) {
    if (run && isStill(p) && distM(run.points[0], p) <= radius_m) { run.points.push(p); continue; }
    close();
    if (isStill(p)) run = { points: [p] };
  }
  close();
  return stops;
}

// Nearest of `nodes` (each {lat,lng,...}) to point p, or null when none within maxM.
function nearest(p, nodes, maxM) {
  let best = null;
  for (const n of nodes) {
    if (n.lat == null || n.lng == null) continue;
    const d = distM(p, n);
    if (d <= maxM && (!best || d < best.distance_m)) best = { node: n, distance_m: Math.round(d) };
  }
  return best;
}

// Evenly downsample to at most `max` points (always keeps first and last).
function downsample(trail, max) {
  if (trail.length <= max) return trail;
  const step = (trail.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(trail[Math.round(i * step)]);
  return out;
}

// ── Data loading ─────────────────────────────────────────────────────────────
async function loadExecution(executionId) {
  const r = await query(`
    SELECT te.id AS execution_id, te.trip_plan_id, te.status, te.execution_date,
           te.calculated_km, te.actual_km,
           tp.trip_no, tp.plan_for_date, tp.tanker_id, tp.status AS plan_status,
           t.tanker_number, t.vendor_name,
           rm.route_name,
           sp.id AS start_id, sp.name AS start_name, sp.latitude AS start_lat, sp.longitude AS start_lng,
           dp.id AS del_id,   dp.name AS del_name,   dp.latitude AS del_lat,   dp.longitude AS del_lng,
           -- OUT / IN / unload = first print per doc type (same rule as tripDocs.js);
           -- cast to timestamptz in the DB (session TZ Asia/Kolkata) so JS gets exact instants
           (SELECT MIN(printed_at)::timestamptz FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='gate_pass') AS out_at,
           (SELECT MIN(printed_at)::timestamptz FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='coa')       AS in_at,
           (SELECT MIN(printed_at)::timestamptz FROM trip_document_prints WHERE trip_plan_id=tp.id AND doc_type='unloading') AS unload_at,
           -- plan date midnight in Asia/Kolkata (never JS local midnight)
           ((tp.plan_for_date::date)::timestamp AT TIME ZONE 'Asia/Kolkata') AS day_start
    FROM trip_executions te
    JOIN trip_plans tp ON tp.id = te.trip_plan_id
    LEFT JOIN tankers t          ON t.id  = tp.tanker_id
    LEFT JOIN route_masters rm   ON rm.id = tp.route_id
    LEFT JOIN starting_points sp ON sp.id = tp.start_point_id
    LEFT JOIN delivery_points dp ON dp.id = tp.delivery_point_id
    WHERE te.id = $1`, [executionId]);
  return r.rows[0] || null;
}

async function loadPlannedBmcus(executionId, planId) {
  const ex = await query(`
    SELECT teb.bmcu_id AS id, teb.seq_no, teb.qty_litres AS planned_qty,
           b.bmcu_code AS code, b.bmcu_name AS name, b.latitude AS lat, b.longitude AS lng
    FROM trip_execution_bmcus teb JOIN bmcus b ON b.id = teb.bmcu_id
    WHERE teb.execution_id = $1 AND teb.is_deleted = FALSE
    ORDER BY teb.seq_no, teb.id`, [executionId]);
  let rows = ex.rows, source = 'execution';
  if (!rows.length) {
    const pl = await query(`
      SELECT tpb.bmcu_id AS id, tpb.seq_no, tpb.expected_qty AS planned_qty,
             b.bmcu_code AS code, b.bmcu_name AS name, b.latitude AS lat, b.longitude AS lng
      FROM trip_plan_bmcus tpb JOIN bmcus b ON b.id = tpb.bmcu_id
      WHERE tpb.trip_plan_id = $1
      ORDER BY tpb.seq_no, tpb.id`, [planId]);
    rows = pl.rows; source = 'plan';
  }
  // Collapse repeated consecutive BMCUs (Balance Milk rows duplicate a BMCU).
  const out = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.id === r.id) { prev.planned_qty = (prev.planned_qty || 0) + (num(r.planned_qty) || 0); continue; }
    out.push({ id: r.id, code: r.code, name: r.name, lat: num(r.lat), lng: num(r.lng),
               planned_seq: out.length + 1, planned_qty: num(r.planned_qty) });
  }
  return { bmcus: out, source };
}

async function loadTrail(tankerId, from, to) {
  const r = await query(`
    SELECT latitude, longitude, speed, ignition, gps_time
    FROM tanker_gps_history
    WHERE tanker_id = $1 AND gps_time BETWEEN $2 AND $3
    ORDER BY gps_time`, [tankerId, from.toISOString(), to.toISOString()]);
  return r.rows.map(normalizePoint);
}

function normalizePoint(p) {
  return {
    lat: num(p.latitude ?? p.lat), lng: num(p.longitude ?? p.lng),
    speed: num(p.speed), ignition: p.ignition == null ? null : !!p.ignition,
    gps_time: p.gps_time instanceof Date ? p.gps_time.toISOString() : p.gps_time,
  };
}

let bmcuMasterCache = null;
async function loadBmcuMaster() {
  const r = await query(`SELECT id, bmcu_code AS code, bmcu_name AS name, latitude AS lat, longitude AS lng
                         FROM bmcus WHERE is_active = TRUE AND latitude IS NOT NULL AND longitude IS NOT NULL`);
  return r.rows.map(b => ({ id: b.id, code: b.code, name: b.name, lat: num(b.lat), lng: num(b.lng) }));
}

// ── Main ─────────────────────────────────────────────────────────────────────
// opts: { from, to (Date|string overrides), windowHours (default 24),
//         trailPoints (pre-loaded rows for this tanker, any time range — filtered here),
//         bmcuMaster (pre-loaded active BMCU list) }
async function analyzeTrip(executionId, opts = {}) {
  const P = params();
  const head = await loadExecution(executionId);
  if (!head) return null;
  const { bmcus, source: bmcu_source } = await loadPlannedBmcus(executionId, head.trip_plan_id);

  const start = head.start_id ? { type: 'start', id: head.start_id, name: head.start_name, lat: num(head.start_lat), lng: num(head.start_lng) } : null;
  const delivery = head.del_id ? { type: 'delivery', id: head.del_id, name: head.del_name, lat: num(head.del_lat), lng: num(head.del_lng) } : null;
  const events = { out_at: head.out_at, in_at: head.in_at, unload_at: head.unload_at };

  // Window: OUT → (unload | IN), else plan-date midnight IST → min(now, from + windowHours)
  const windowHours = num(opts.windowHours) || 24;
  let from = opts.from ? new Date(opts.from) : (events.out_at ? new Date(events.out_at) : new Date(head.day_start));
  let to;
  if (opts.to) to = new Date(opts.to);
  else if (events.unload_at || events.in_at) to = new Date(events.unload_at || events.in_at);
  else to = new Date(Math.min(Date.now(), from.getTime() + windowHours * 3600 * 1000));
  if (to < from) to = new Date(from.getTime() + windowHours * 3600 * 1000);
  const window = { from: from.toISOString(), to: to.toISOString(),
                   source: opts.from || opts.to ? 'override' : events.out_at ? 'gate_pass' : 'plan_date' };

  // Trail
  let trail;
  if (Array.isArray(opts.trailPoints)) {
    const f = from.getTime(), t = to.getTime();
    trail = opts.trailPoints.map(normalizePoint)
      .filter(p => { const g = new Date(p.gps_time).getTime(); return g >= f && g <= t; })
      .sort((a, b) => new Date(a.gps_time) - new Date(b.gps_time));
  } else if (head.tanker_id) {
    trail = await loadTrail(head.tanker_id, from, to);
  } else trail = [];
  trail = trail.filter(p => p.lat != null && p.lng != null);
  const has_trail = trail.length > 0;

  // Planned nodes for classification
  const nodes = [];
  if (start) nodes.push(start);
  for (const b of bmcus) nodes.push({ type: 'bmcu', ...b });
  if (delivery) nodes.push(delivery);

  // Stops + classification
  const bmcuMaster = opts.bmcuMaster || (bmcuMasterCache ||= await loadBmcuMaster());
  const stops = detectStops(trail, { radius_m: P.radius_m, min_minutes: P.min_stop_minutes }).map(s => {
    const m = nearest(s, nodes, P.geofence_m);
    if (m) return { ...s, type: m.node.type, distance_m: m.distance_m,
                    node: { type: m.node.type, id: m.node.id, code: m.node.code, name: m.node.name } };
    const nb = nearest(s, bmcuMaster, NEAREST_BMCU_KM * 1000);
    return { ...s, type: 'unplanned', node: null, distance_m: null,
             nearest_bmcu: nb ? { id: nb.node.id, code: nb.node.code, name: nb.node.name, distance_m: nb.distance_m } : null };
  });

  // Per-BMCU visits: first/last trail point inside the geofence + matched stops
  const bmcu_visits = bmcus.map(b => {
    const v = { planned_seq: b.planned_seq, id: b.id, code: b.code, name: b.name, planned_qty: b.planned_qty,
                lat: b.lat, lng: b.lng, visited: null, missed: null, arrived_at: null, departed_at: null, wait_minutes: 0 };
    if (!has_trail || b.lat == null || b.lng == null) return v;
    for (const p of trail) {
      if (distM(p, b) <= P.geofence_m) { v.arrived_at ??= p.gps_time; v.departed_at = p.gps_time; }
    }
    for (const s of stops) if (s.type === 'bmcu' && s.node.id === b.id) {
      v.wait_minutes += s.minutes;
      if (!v.arrived_at || new Date(s.from) < new Date(v.arrived_at)) v.arrived_at = s.from;
      if (!v.departed_at || new Date(s.to) > new Date(v.departed_at)) v.departed_at = s.to;
    }
    v.wait_minutes = Math.round(v.wait_minutes * 10) / 10;
    v.visited = !!v.arrived_at;
    v.missed = !v.visited;
    return v;
  });
  const reached = bmcu_visits.filter(v => v.visited).sort((a, b) => new Date(a.arrived_at) - new Date(b.arrived_at));
  const actual_sequence = reached.map(v => v.planned_seq);
  const sequence_deviation = has_trail && actual_sequence.some((s, i) => i > 0 && s < actual_sequence[i - 1]);

  // Totals
  let trail_km = 0, glitches = 0, max_speed = 0;
  for (let i = 1; i < trail.length; i++) {
    const km = haversineKm(trail[i - 1].lat, trail[i - 1].lng, trail[i].lat, trail[i].lng);
    if (km > GLITCH_KM) { glitches++; continue; }
    trail_km += km;
  }
  for (const p of trail) if (p.speed != null && p.speed > max_speed) max_speed = p.speed;

  let trip_duration_minutes = null, duration_source = null;
  if (events.out_at && events.in_at) {
    trip_duration_minutes = mins(events.out_at, events.in_at); duration_source = 'gate_pass/coa';
  } else if (has_trail) {
    const firstMove = trail.find(p => p.speed != null && p.speed > MOVING_SPEED);
    const arrive = delivery && delivery.lat != null
      ? trail.find(p => firstMove && new Date(p.gps_time) > new Date(firstMove.gps_time) && distM(p, delivery) <= P.geofence_m)
      : null;
    if (firstMove && arrive) { trip_duration_minutes = mins(firstMove.gps_time, arrive.gps_time); duration_source = 'gps'; }
  }
  const sum = (arr, f) => Math.round(arr.reduce((s, x) => s + f(x), 0) * 10) / 10;
  const bmcu_wait_minutes      = sum(stops.filter(s => s.type === 'bmcu'), s => s.minutes);
  const unplannedStops         = stops.filter(s => s.type === 'unplanned');
  const unplanned_stop_minutes = sum(unplannedStops, s => s.minutes);
  const stopped_total          = sum(stops, s => s.minutes);
  const span = has_trail ? mins(trail[0].gps_time, trail[trail.length - 1].gps_time) : null;
  const moving_minutes = span == null ? null : Math.max(0, Math.round((span - stopped_total) * 10) / 10);

  const totals = {
    has_trail, points: trail.length, first_fix: has_trail ? trail[0].gps_time : null, last_fix: has_trail ? trail[trail.length - 1].gps_time : null,
    trip_duration_minutes, duration_source, moving_minutes,
    bmcu_wait_minutes, unplanned_stop_minutes, unplanned_stop_count: unplannedStops.length,
    missed_bmcu_count: has_trail ? bmcu_visits.filter(v => v.missed).length : null,
    trail_km: Math.round(trail_km * 10) / 10, glitches, max_speed: Math.round(max_speed),
    calculated_km: num(head.calculated_km), actual_km: num(head.actual_km),
  };

  return {
    execution: {
      execution_id: head.execution_id, trip_plan_id: head.trip_plan_id, status: head.status,
      trip_no: head.trip_no, plan_for_date: head.plan_for_date, execution_date: head.execution_date,
      tanker_id: head.tanker_id, tanker_number: head.tanker_number, vendor_name: head.vendor_name,
      route_name: head.route_name, delivery_point: head.del_name, bmcu_source,
    },
    plan: { start, delivery, bmcus },
    events, window,
    trail: downsample(trail, MAX_TRAIL_POINTS),
    stops, bmcu_visits: bmcu_visits.map(v => ({ ...v })), actual_sequence, sequence_deviation,
    totals, params: P,
  };
}

// Fresh BMCU master (for batch callers; the module cache is otherwise per-process).
async function getBmcuMaster() { bmcuMasterCache = await loadBmcuMaster(); return bmcuMasterCache; }

module.exports = { analyzeTrip, detectStops, getBmcuMaster, params };
