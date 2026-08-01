import { SPEED_THRESHOLDS } from '../config.js';

/** Index into SPEED_COLORS / SPEED_LABELS for a speed in knots. */
export function speedBucket(kts) {
  for (let i = 0; i < SPEED_THRESHOLDS.length; i++) {
    if (kts < SPEED_THRESHOLDS[i]) return i;
  }
  return SPEED_THRESHOLDS.length;
}

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Initial bearing in degrees (0–360). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** True if a track's bbox intersects a Leaflet LatLngBounds. */
export function bboxIntersects(track, bounds) {
  if (!track.bbox) return true;
  return track.bbox.maxLat >= bounds.getSouth() &&
         track.bbox.minLat <= bounds.getNorth() &&
         track.bbox.maxLon >= bounds.getWest()  &&
         track.bbox.minLon <= bounds.getEast();
}

/**
 * Union of several tracks' bboxes as [[minLat,minLon],[maxLat,maxLon]],
 * or null when none of them carry a bbox.
 */
export function unionBounds(tracks) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const t of tracks) {
    if (!t.bbox) continue;
    if (t.bbox.minLat < minLat) minLat = t.bbox.minLat;
    if (t.bbox.minLon < minLon) minLon = t.bbox.minLon;
    if (t.bbox.maxLat > maxLat) maxLat = t.bbox.maxLat;
    if (t.bbox.maxLon > maxLon) maxLon = t.bbox.maxLon;
  }
  if (minLat === Infinity) return null;
  return [[minLat, minLon], [maxLat, maxLon]];
}
