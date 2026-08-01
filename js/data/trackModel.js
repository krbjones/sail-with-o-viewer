import { bearingDeg } from '../core/geo.js';

/**
 * Convert a compact JSON track record from data/YYYY-MM.json into the app's
 * track format.
 *
 * Compact form: {id, s, e, bbox, dist, maxSpd, avgSpd, movingMs,
 *                pts:[[lat,lon,timeMs,speedKts],…]}
 *
 * Points are kept as parallel typed arrays rather than an array of objects.
 * The full archive is ~1.9M points; as objects that is hundreds of megabytes of
 * heap and a garbage-collection pause every time a filter changes.
 *
 * lat/lon and time stay Float64: latitude needs eight significant digits (a
 * Float32 would round it to roughly a metre) and epoch milliseconds do not fit
 * a Float32 at all. Only speed is narrow enough for Float32.
 */
export function trackFromJSON(rec) {
  const { id, s, e, bbox, pts } = rec;
  const n = pts.length;

  const times  = new Float64Array(n);
  const lats   = new Float64Array(n);
  const lons   = new Float64Array(n);
  const speeds = new Float32Array(n);

  let maxFromPoints = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    lats[i]   = p[0];
    lons[i]   = p[1];
    times[i]  = p[2];
    speeds[i] = p[3];
    if (p[3] > maxFromPoints) maxFromPoints = p[3];
  }

  return {
    id,
    filename: id,
    startTime: s,
    endTime:   e,
    duration:  e - s,
    bbox: bbox ? { minLat: bbox[0], minLon: bbox[1], maxLat: bbox[2], maxLon: bbox[3] } : null,

    n, times, lats, lons, speeds,

    // Stats come precomputed from build_tracks.py; older bundles without them
    // fall back to what can be derived from the points.
    maxSpeed: rec.maxSpd ?? maxFromPoints,
    avgSpeed: rec.avgSpd ?? 0,
    distance: rec.dist   ?? 0,
    movingMs: rec.movingMs ?? 0,

    /** One L.Polyline per speed bucket (sparse — empty buckets stay undefined). */
    bucketLines: [],
    shown: true,
    _activeState: undefined,
  };
}

/** Bearing between two indices, 0 when the points coincide. */
function bearingAt(track, i, j) {
  if (track.lats[i] === track.lats[j] && track.lons[i] === track.lons[j]) return 0;
  return bearingDeg(track.lats[i], track.lons[i], track.lats[j], track.lons[j]);
}

/**
 * Position, speed and bearing of a track at time `t`, clamped to its range.
 * Always returns the full shape including `bearing` — the endpoints borrow the
 * heading of their adjacent segment.
 */
export function interpolate(track, t) {
  const { times, lats, lons, speeds, n } = track;
  const last = n - 1;

  if (t <= times[0]) {
    return { lat: lats[0], lon: lons[0], speed: speeds[0], bearing: bearingAt(track, 0, Math.min(1, last)) };
  }
  if (t >= times[last]) {
    return {
      lat: lats[last], lon: lons[last], speed: speeds[last],
      bearing: bearingAt(track, Math.max(0, last - 1), last),
    };
  }

  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (times[m] <= t) lo = m; else hi = m;
  }

  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return {
    lat:     lats[lo]   + f * (lats[hi]   - lats[lo]),
    lon:     lons[lo]   + f * (lons[hi]   - lons[lo]),
    speed:   speeds[lo] + f * (speeds[hi] - speeds[lo]),
    bearing: bearingAt(track, lo, hi),
  };
}
