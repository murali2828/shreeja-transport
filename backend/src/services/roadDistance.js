// backend/src/services/roadDistance.js
// Road-distance provider (Google Routes API). Isolated so the provider can be
// swapped (OpenRouteService / self-hosted) without touching callers.
//
// Returns road km between two points, or null on any failure / missing key —
// callers then fall back to the Haversine estimate.

const GOOGLE_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

async function googleLegKm(lat1, lng1, lat2, lng2) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return null;
  if ([lat1, lng1, lat2, lng2].some(v => v == null || isNaN(v))) return null;

  try {
    const body = {
      origins:      [{ waypoint: { location: { latLng: { latitude: Number(lat1), longitude: Number(lng1) } } } }],
      destinations: [{ waypoint: { location: { latLng: { latitude: Number(lat2), longitude: Number(lng2) } } } }],
      travelMode: 'DRIVE',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    const resp = await fetch(GOOGLE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,distanceMeters,condition',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      console.warn('[roadDistance] Google Routes API HTTP', resp.status);
      return null;
    }
    const data = await resp.json();
    // computeRouteMatrix returns an array of elements.
    const el = Array.isArray(data) ? data[0] : null;
    if (!el || el.condition !== 'ROUTE_EXISTS' || el.distanceMeters == null) return null;
    return el.distanceMeters / 1000;
  } catch (err) {
    console.warn('[roadDistance] Google Routes API error:', err.message);
    return null;
  }
}

module.exports = { googleLegKm };
