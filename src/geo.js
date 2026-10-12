// Distance and ETA helpers.
const R = 6371; // km

export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Straight-line distance is shorter than real roads; 1.3 is a common city detour factor.
export const ROAD_FACTOR = 1.3;

export function etaMinutes(from, to, speedKmh, fallbackKmh) {
  const d = distanceKm(from, to);
  if (d == null) return null;
  const v = speedKmh && speedKmh > 10 ? speedKmh : fallbackKmh;
  return Math.max(1, Math.round(((d * ROAD_FACTOR) / v) * 60));
}

export function getPath(obj, p) {
  if (!p) return obj;
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
