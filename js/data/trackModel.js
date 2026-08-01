import { bearingDeg } from '../core/geo.js';

/**
 * Convert a compact JSON track record from data/YYYY-MM.json into the app's
 * track format.
 *
 * Compact form: {id, s, e, bbox:[minLat,minLon,maxLat,maxLon], pts:[[lat,lon,timeMs,speedKts],…]}
 */
export function trackFromJSON({ id, s, e, bbox, pts }) {
  const points = new Array(pts.length);
  let maxSpeed = 0;

  for (let i = 0; i < pts.length; i++) {
    const [lat, lon, time, speed] = pts[i];
    points[i] = { lat, lon, time, speed };
    if (speed > maxSpeed) maxSpeed = speed;   // loop, not Math.max(...) — arrays run to 100k+
  }

  return {
    id,
    filename: id,
    startTime: s,
    endTime:   e,
    duration:  e - s,
    bbox: bbox ? { minLat: bbox[0], minLon: bbox[1], maxLat: bbox[2], maxLon: bbox[3] } : null,
    points,
    maxSpeed,
    polylines: [],
    visible: true,
    shown: true,
  };
}

/** Bearing across a pair of points, 0 when they coincide. */
function segmentBearing(p1, p2) {
  return (p1.lat !== p2.lat || p1.lon !== p2.lon)
    ? bearingDeg(p1.lat, p1.lon, p2.lat, p2.lon)
    : 0;
}

/**
 * Position, speed and bearing of a track at time `t`, clamped to its range.
 * Always returns the full shape including `bearing` — the endpoints borrow the
 * heading of their adjacent segment rather than returning a bare track point.
 */
export function interpolate(track, t) {
  const pts  = track.points;
  const last = pts.length - 1;

  if (t <= pts[0].time) {
    const p = pts[0];
    return { lat: p.lat, lon: p.lon, speed: p.speed, bearing: segmentBearing(p, pts[Math.min(1, last)]) };
  }
  if (t >= pts[last].time) {
    const p = pts[last];
    return { lat: p.lat, lon: p.lon, speed: p.speed, bearing: segmentBearing(pts[Math.max(0, last - 1)], p) };
  }

  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].time <= t) lo = m; else hi = m;
  }

  const p1 = pts[lo], p2 = pts[hi];
  const f  = (t - p1.time) / (p2.time - p1.time);

  return {
    lat:     p1.lat   + f * (p2.lat   - p1.lat),
    lon:     p1.lon   + f * (p2.lon   - p1.lon),
    speed:   p1.speed + f * (p2.speed - p1.speed),
    bearing: segmentBearing(p1, p2),
  };
}
