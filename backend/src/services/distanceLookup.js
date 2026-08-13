// backend/src/services/distanceLookup.js
// Shared Distance Master read/write, reusing the same pair-normalisation as
// backend/src/routes/distances.js so rows stay de-duplicated (from <= to).

// Normalise a node pair so the "from" key is lexicographically <= the "to" key.
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

// Return the stored road km for a pair, or null if none. `db` is a pg client or pool.
// Preload the whole Distance Master into a Map for batch jobs (billing run
// execute processes ~1000 trips × ~5 legs — per-leg SELECTs are an N+1).
// Key matches normalisePair ordering. Callers pass the Map as masterCache.
async function loadMasterDistanceCache(db) {
  const r = await db.query('SELECT from_type, from_id, to_type, to_id, distance_km, road_notes FROM distance_master');
  const cache = new Map();
  for (const row of r.rows) {
    cache.set(`${row.from_type}:${row.from_id}|${row.to_type}:${row.to_id}`, {
      km: parseFloat(row.distance_km),
      fromGoogle: /google/i.test(row.road_notes || ''),
    });
  }
  return cache;
}

async function getMasterDistanceKm(db, fromType, fromId, toType, toId, masterCache) {
  const p = normalisePair(fromType, parseInt(fromId), toType, parseInt(toId));
  if (masterCache) return masterCache.get(`${p.fromType}:${p.fromId}|${p.toType}:${p.toId}`) || null;
  const r = await db.query(
    `SELECT distance_km, road_notes FROM distance_master
     WHERE from_type=$1 AND from_id=$2 AND to_type=$3 AND to_id=$4`,
    [p.fromType, p.fromId, p.toType, p.toId]
  );
  if (!r.rows.length) return null;
  return {
    km: parseFloat(r.rows[0].distance_km),
    // Rows cached from the Routes API keep their Google attribution even
    // though they now live in the Distance Master.
    fromGoogle: /google/i.test(r.rows[0].road_notes || ''),
  };
}

// Cache a road km into Distance Master (insert or update). Used to persist
// externally-fetched (Google) leg distances so each unique leg is fetched once.
async function upsertMasterDistanceKm(db, fromType, fromId, toType, toId, km, note, userId) {
  if (fromType === toType && parseInt(fromId) === parseInt(toId)) return; // self-pair: nothing to store
  const p = normalisePair(fromType, parseInt(fromId), toType, parseInt(toId));
  await db.query(
    `INSERT INTO distance_master (from_type, from_id, to_type, to_id, distance_km, road_notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (from_type, from_id, to_type, to_id)
     DO UPDATE SET distance_km=$5, road_notes=$6, updated_by=$7, updated_at=NOW()`,
    [p.fromType, p.fromId, p.toType, p.toId, parseFloat(km), note || null, userId || null]
  );
}

module.exports = { normalisePair, getMasterDistanceKm, upsertMasterDistanceKm, loadMasterDistanceCache };
