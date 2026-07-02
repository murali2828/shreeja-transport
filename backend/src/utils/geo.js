// backend/src/utils/geo.js
// Dependency-free geographic helpers.

// Straight-line multiplier applied to great-circle distance when no real road
// distance is available (typical road:crow-flies ratio ~1.3).
const ROAD_FACTOR = parseFloat(process.env.ROAD_DISTANCE_FACTOR || '1.3');

// Great-circle distance in kilometres between two lat/long points.
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

module.exports = { haversineKm, ROAD_FACTOR };
