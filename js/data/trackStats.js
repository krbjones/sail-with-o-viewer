/**
 * Turn raw GPX track points into the compact record shape the app and
 * build_tracks.py both use.
 *
 * Every constant and rule here mirrors build_tracks.py, so a track imported in
 * the browser reports the same distance and speeds as one built by the script.
 * Kept free of DOM and module-scope state so a Web Worker can use it.
 */

const KNOTS_PER_MS          = 1.94384;
const METRES_PER_NM         = 1852;
const SMOOTH_W              = 2;
const MOVING_MIN_KTS        = 0.5;
const MAX_PLAUSIBLE_KTS     = 25;
const MIN_GLITCH_METRES     = 50;
const MAX_CONSECUTIVE_DROPS = 20;
const GAP_SECONDS           = 60;

const round6 = v => Math.round(v * 1e6) / 1e6;
const round2 = v => Math.round(v * 100) / 100;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const f1 = lat1 * Math.PI / 180, f2 = lat2 * Math.PI / 180;
  const df = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const FNAME_RE = /^(\d{4})-(\d{2})-\d{2}_\d{6}\.gpx$/i;

/**
 * Month bundle key for an imported file. Track filenames encode local start
 * time, which is authoritative; otherwise fall back to the browser's timezone.
 */
export function monthKey(filename, startMs) {
  const m = FNAME_RE.exec(filename);
  if (m) return `${m[1]}-${m[2]}`;
  const d = new Date(startMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param raw       [{time, lat, lon}] in any order
 * @param filename  used as the record id
 * @returns compact record, or null if fewer than two usable points remain
 */
export function buildRecord(raw, filename) {
  if (!raw || raw.length < 2) return null;

  // Stable sort on time alone, matching build_tracks.py — sorting on more than
  // time would make which of a duplicate pair survives depend on coordinates.
  raw = raw.slice().sort((a, b) => a.time - b.time);

  const clean      = [raw[0]];
  const speeds     = [0];
  const continuous = [false];
  let distM = 0, dropped = 0, dupes = 0, run = 0;

  for (let i = 1; i < raw.length; i++) {
    const p    = raw[i];
    const prev = clean[clean.length - 1];
    const dt   = (p.time - prev.time) / 1000;

    // Repeated timestamp: no new time information, and would divide by zero.
    if (dt <= 0) { dupes++; continue; }

    const step = haversine(prev.lat, prev.lon, p.lat, p.lon);
    const kts  = step / dt * KNOTS_PER_MS;

    // A glitch has to be both far and fast. Speed alone flags ordinary jitter
    // hundreds of times in a clean 1 Hz track.
    if (step > MIN_GLITCH_METRES && kts > MAX_PLAUSIBLE_KTS && run < MAX_CONSECUTIVE_DROPS) {
      dropped++; run++;
      continue;
    }

    // Resyncing after drops, or bridging a gap in the log: keep the position,
    // but do not pretend to know how fast the boat got there.
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
  const s = pts[0][2];

  return {
    id: filename,
    s,
    e: pts[n - 1][2],
    month: monthKey(filename, s),
    bbox: [round6(minLat), round6(minLon), round6(maxLat), round6(maxLon)],
    dist:   round2(distNm),
    maxSpd: round2(maxSpd),
    // Averaged over time actually under way, and only with a meaningful sample.
    avgSpd: movingMs >= 60000 ? round2(distNm / (movingMs / 3600000)) : 0,
    movingMs,
    pts,
    dropped,
    dupes,
  };
}
