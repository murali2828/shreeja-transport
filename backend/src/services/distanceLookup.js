// backend/src/services/distanceLookup.js
// Shared Distance Master read/write, reusing the same pair-normalisation as
// backend/src/routes/distances.js so rows stay de-duplicated (from <= to).

// Normalise a node pair so the "from" key is lexicographically <= the "to" key.
function normalisePair(fromType, fromId, toType, toId) {
  const fromKey = `${fromType}:${fromId}`;
  const toKey   = `${toType}:${toId}`;
  if (fromKey <= toKey) return { fromType, fromId, toType, toId };
  return { fromType: toType, fromId: toId, toType: fromType, toId: fromId };
}

// Return the stored road km for a pair, or null if none. `db` is a pg client or pool.
async function getMasterDistanceKm(db, fromType, fromId, toType, toId) {
  const p = normalisePair(fromType, parseInt(fromId), toType, parseInt(toId));
  const r = await db.query(
    `SELECT distance_km FROM distance_master
     WHERE from_type=$1 AND from_id=$2 AND to_type=$3 AND to_id=$4`,
    [p.fromType, p.fromId, p.toType, p.toId]
  );
  return r.rows.length ? parseFloat(r.rows[0].distance_km) : null;
}

// Cache a road km into Distance Master (insert or update). Used to persist
// externally-fetched (Google) leg distances so each unique leg is fetched once.
async function upsertMasterDistanceKm(db, fromType, fromId, toType, toId, km, note, userId) {
  const p = normalisePair(fromType, parseInt(fromId), toType, parseInt(toId));
  await db.query(
    `INSERT INTO distance_master (from_type, from_id, to_type, to_id, distance_km, road_notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
     ON CONFLICT (from_type, from_id, to_type, to_id)
     DO UPDATE SET distance_km=$5, road_notes=$6, updated_by=$7, updated_at=NOW()`,
    [p.fromType, p.fromId, p.toType, p.toId, parseFloat(km), note || null, userId || null]
  );
}

module.exports = { normalisePair, getMasterDistanceKm, upsertMasterDistanceKm };
