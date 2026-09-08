// backend/src/services/wheelseye.js
// WheelsEye GPS integration. All Shreeja tankers carry WheelsEye devices;
// the vendor exposes a single pull endpoint (currentLoc) that returns every
// vehicle's latest position, paginated. This module fetches that list and
// syncs it into tanker_gps_latest / tanker_gps_history (migration 038).
//
// SECURITY: the access token is a live credential. It is read ONLY from
// process.env.WHEELSEYE_ACCESS_TOKEN and must never be logged, returned in an
// API response, or embedded in an error message.

const { query } = require('../config/db');

const WHEELSEYE_URL = 'https://api.wheelseye.com/currentLoc';
const PAGE_SIZE = 100;
const MAX_PAGES = 50;          // safety stop — 5 000 vehicles is far beyond the fleet
const FETCH_TIMEOUT_MS = 20_000;

// Registration numbers differ in spacing/hyphens between WheelsEye and the
// tanker master ("KA 01 AB 1234" vs "KA01-AB-1234"). Compare on this form.
// SQL equivalent: upper(regexp_replace(tanker_number, '[^A-Za-z0-9]', '', 'g'))
function normalizeVehicle(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function fetchPage(token, pageNo, withAddress) {
  const url = `${WHEELSEYE_URL}?accessToken=${encodeURIComponent(token)}` +
              `&isLocationReq=${withAddress ? 'true' : 'false'}&pageNo=${pageNo}&size=${PAGE_SIZE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const resp = await fetch(url, { method: 'GET', signal: controller.signal })
    .finally(() => clearTimeout(timer));
  if (!resp.ok) throw new Error(`WheelsEye HTTP ${resp.status}`);
  return resp.json();
}

// Pull every page of the current-location list.
// Returns { ok, list, totalCount, error } — never throws, never includes the token.
async function fetchAllCurrentLoc({ withAddress = false } = {}) {
  const token = process.env.WHEELSEYE_ACCESS_TOKEN;
  if (!token) return { ok: false, list: [], totalCount: 0, error: 'WHEELSEYE_ACCESS_TOKEN not set' };

  const list = [];
  let totalCount = 0;
  try {
    for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
      const body = await fetchPage(token, pageNo, withAddress);
      if (!body || body.success === false) {
        return { ok: false, list: [], totalCount: 0, error: body?.message || 'WheelsEye request failed' };
      }
      const data = body.data || {};
      list.push(...(Array.isArray(data.list) ? data.list : []));
      totalCount = Number(data.totalCount) || list.length;
      const totalPages = Number(data.totalPages) || 1;
      if (pageNo >= totalPages - 1) break;
    }
    return { ok: true, list, totalCount, error: null };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'WheelsEye request timed out' : (err.message || 'WheelsEye fetch error');
    return { ok: false, list: [], totalCount: 0, error: msg };
  }
}

const num = v => (v == null || v === '' || isNaN(Number(v))) ? null : Number(v);
const bool = v => (v == null ? null : v === true || v === 'true');

// Upsert the fetched list into tanker_gps_latest and append to
// tanker_gps_history. `client` is a pg client or the pool (anything with
// .query). Returns { received, upserted, historyAdded, matched, unmatched }.
async function syncPositions(client, list) {
  // One lookup per sync: normalised tanker_number → id (active tankers only).
  const tk = await client.query(
    `SELECT id, upper(regexp_replace(tanker_number, '[^A-Za-z0-9]', '', 'g')) AS norm
     FROM tankers WHERE is_active = TRUE`);
  const idByNorm = new Map(tk.rows.map(r => [r.norm, r.id]));

  const out = { received: list.length, upserted: 0, historyAdded: 0, matched: 0, unmatched: [] };
  for (const row of list) {
    const raw  = row.vehicleNumber;
    const norm = normalizeVehicle(raw);
    if (!norm) continue;
    const lat = num(row.latitude), lng = num(row.longitude);
    const gpsSecs = num(row.createdDate);
    const gpsTime = gpsSecs ? new Date(gpsSecs * 1000) : null;
    const tankerId = idByNorm.get(norm) ?? null;
    if (tankerId) out.matched++; else out.unmatched.push(raw);

    const up = await client.query(`
      INSERT INTO tanker_gps_latest
        (vehicle_number, vehicle_number_raw, tanker_id, device_number, latitude, longitude,
         speed, ignition, angle, accurate, location, gps_time, received_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      ON CONFLICT (vehicle_number) DO UPDATE SET
        vehicle_number_raw = EXCLUDED.vehicle_number_raw,
        tanker_id     = EXCLUDED.tanker_id,
        device_number = EXCLUDED.device_number,
        latitude      = EXCLUDED.latitude,
        longitude     = EXCLUDED.longitude,
        speed         = EXCLUDED.speed,
        ignition      = EXCLUDED.ignition,
        angle         = EXCLUDED.angle,
        accurate      = EXCLUDED.accurate,
        location      = COALESCE(EXCLUDED.location, tanker_gps_latest.location),
        gps_time      = EXCLUDED.gps_time,
        received_at   = NOW()
      WHERE tanker_gps_latest.gps_time IS NULL
         OR EXCLUDED.gps_time IS NULL
         OR EXCLUDED.gps_time >= tanker_gps_latest.gps_time`,
      [norm, raw, tankerId, row.deviceNumber || null, lat, lng, num(row.speed),
       bool(row.ignition), num(row.angle) == null ? null : Math.round(num(row.angle)),
       bool(row.accurate), row.location || null, gpsTime]);
    out.upserted += up.rowCount;

    // History append: skip fixes already older than the retention window —
    // devices whose last fix is months old are re-sent on every poll and
    // would otherwise be inserted and pruned again every hour. The latest
    // upsert above still runs so the UI can show "Stale · N d ago".
    if (gpsTime && lat != null && lng != null && gpsTime.getTime() > Date.now() - retentionDays() * 86400000) {
      const h = await client.query(`
        INSERT INTO tanker_gps_history
          (vehicle_number, tanker_id, latitude, longitude, speed, ignition, angle, gps_time)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (vehicle_number, gps_time) DO NOTHING`,
        [norm, tankerId, lat, lng, num(row.speed), bool(row.ignition),
         num(row.angle) == null ? null : Math.round(num(row.angle)), gpsTime]);
      out.historyAdded += h.rowCount;
    }
  }
  return out;
}

// Trail retention in days (WHEELSEYE_HISTORY_DAYS, default 90, min 1) — the
// single parser used by both the history append and the hourly prune.
function retentionDays(days = process.env.WHEELSEYE_HISTORY_DAYS) {
  return Math.max(1, parseInt(days, 10) || 90);
}

// Drop trail points older than the retention window. Returns rows deleted.
async function pruneHistory(days) {
  const d = retentionDays(days);
  const r = await query(
    `DELETE FROM tanker_gps_history WHERE gps_time < NOW() - ($1 || ' days')::interval`, [String(d)]);
  return r.rowCount;
}

module.exports = { normalizeVehicle, fetchAllCurrentLoc, syncPositions, pruneHistory, retentionDays };
