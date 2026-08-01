import { haversine } from '../core/geo.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

/** Half-width of the moving-average speed smoother — must match build_tracks.py. */
const SMOOTH_W = 2;

/**
 * Parse GPX text into the same compact record shape the build script emits:
 *   {id, s, e, bbox:[minLat,minLon,maxLat,maxLon], pts:[[lat,lon,timeMs,speedKts],…]}
 * Returns null when the file has fewer than two timestamped track points.
 */
export function parseGPX(text, filename) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  let trkpts = Array.from(doc.getElementsByTagNameNS(GPX_NS, 'trkpt'));
  if (!trkpts.length) trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  if (!trkpts.length) return null;

  const raw = [];
  for (const pt of trkpts) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const tel = pt.getElementsByTagNameNS(GPX_NS, 'time')[0] || pt.getElementsByTagName('time')[0];
    if (!tel) continue;

    const t = new Date(tel.textContent.trim().replace(' ', 'T').replace(/Z?$/, 'Z')).getTime();
    if (!isNaN(lat) && !isNaN(lon) && !isNaN(t)) raw.push({ time: t, lat, lon });
  }

  if (raw.length < 2) return null;
  raw.sort((a, b) => a.time - b.time);

  // Raw speed (m/s → knots) between consecutive points
  const speeds = new Float64Array(raw.length);
  for (let i = 1; i < raw.length; i++) {
    const dt   = (raw[i].time - raw[i - 1].time) / 1000;
    const dist = haversine(raw[i - 1].lat, raw[i - 1].lon, raw[i].lat, raw[i].lon);
    speeds[i]  = dt > 0 ? (dist / dt) * 1.94384 : 0;
  }

  // Moving-average smooth over a (2*SMOOTH_W + 1) window
  const n = raw.length;
  const pts = new Array(n);
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;

  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - SMOOTH_W), e = Math.min(n - 1, i + SMOOTH_W);
    let sum = 0;
    for (let j = s; j <= e; j++) sum += speeds[j];

    const p = raw[i];
    pts[i] = [
      Math.round(p.lat * 1e6) / 1e6,
      Math.round(p.lon * 1e6) / 1e6,
      p.time,
      Math.round(Math.max(0, sum / (e - s + 1)) * 100) / 100,
    ];

    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  return {
    id: filename,
    s: pts[0][2],
    e: pts[n - 1][2],
    bbox: [minLat, minLon, maxLat, maxLon].map(v => Math.round(v * 1e6) / 1e6),
    pts,
  };
}
