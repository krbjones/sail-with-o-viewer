import { haversine } from '../core/geo.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

// These must stay in step with build_tracks.py, so that a track imported in the
// browser reports the same distance and speeds as one built by the script.
const KNOTS_PER_MS       = 1.94384;
const METRES_PER_NM      = 1852;
const SMOOTH_W           = 2;
const MOVING_MIN_KTS     = 0.5;
const MAX_PLAUSIBLE_KTS  = 25;
const MIN_GLITCH_METRES  = 50;
const MAX_CONSECUTIVE_DROPS = 20;
const GAP_SECONDS        = 60;

const round6 = v => Math.round(v * 1e6) / 1e6;
const round2 = v => Math.round(v * 100) / 100;

/** Pull timestamped track points out of GPX text, sorted by time. */
function readTrackPoints(text) {
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

  raw.sort((a, b) => a.time - b.time);
  return raw;
}

/**
 * Parse GPX text into the same compact record the build script emits:
 *   {id, s, e, bbox, dist, maxSpd, avgSpd, movingMs, pts:[[lat,lon,timeMs,speedKts],…]}
 * Returns null when the file has fewer than two usable track points.
 */
export function parseGPX(text, filename) {
  const raw = readTrackPoints(text);
  if (!raw || raw.length < 2) return null;

  // Drop duplicate timestamps and implausible fixes; bridge gaps without
  // inventing a speed across them. See build_tracks.py for the rationale.
  const clean      = [raw[0]];
  const speeds     = [0];
  const continuous = [false];
  let distM = 0, dropped = 0, dupes = 0, run = 0;

  for (let i = 1; i < raw.length; i++) {
    const p    = raw[i];
    const prev = clean[clean.length - 1];
    const dt   = (p.time - prev.time) / 1000;

    if (dt <= 0) { dupes++; continue; }

    const step = haversine(prev.lat, prev.lon, p.lat, p.lon);
    const kts  = step / dt * KNOTS_PER_MS;

    if (step > MIN_GLITCH_METRES && kts > MAX_PLAUSIBLE_KTS && run < MAX_CONSECUTIVE_DROPS) {
      dropped++; run++;
      continue;
    }

    const bridged = run > 0 || dt > GAP_SECONDS;
    run = 0;

    clean.push(p);
    continuous.push(!bridged);
    if (bridged) {
      speeds.push(0);
    } else {
      speeds.push(kts);
      distM += step;
    }
  }

  const n = clean.length;
  if (n < 2) return null;

  const pts = new Array(n);
  let maxSpd = 0, movingMs = 0;
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;

  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - SMOOTH_W), e = Math.min(n - 1, i + SMOOTH_W);
    let sum = 0;
    for (let j = s; j <= e; j++) sum += speeds[j];
    const avg = Math.max(0, sum / (e - s + 1));

    const p = clean[i];
    pts[i] = [round6(p.lat), round6(p.lon), p.time, round2(avg)];

    if (avg > maxSpd) maxSpd = avg;
    if (i > 0 && continuous[i] && avg >= MOVING_MIN_KTS) movingMs += p.time - clean[i - 1].time;

    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }

  const distNm = distM / METRES_PER_NM;

  return {
    id: filename,
    s: pts[0][2],
    e: pts[n - 1][2],
    bbox: [round6(minLat), round6(minLon), round6(maxLat), round6(maxLon)],
    dist:     round2(distNm),
    maxSpd:   round2(maxSpd),
    avgSpd:   movingMs >= 60000 ? round2(distNm / (movingMs / 3600000)) : 0,
    movingMs,
    pts,
    dropped,
    dupes,
  };
}
