import { WIND_URL, MAX_WIND_GAP_MS } from '../config.js';

/**
 * Historical wind, as built by build_wind.py.
 *
 * Everything here follows the meteorological convention: a direction is where
 * the wind blows FROM. Boat bearings are where the boat is going TO. Mixing the
 * two up by 180 degrees is the classic bug in this arithmetic, so the two are
 * named apart throughout — `windFrom` versus `heading`.
 */

let areas = [];
/** areaId -> rows sorted by time: [timeMs, areaId, speedKts, fromDeg, gustKts] */
let byArea = new Map();
let loaded = false;
let meta = null;

export function windLoaded() { return loaded && byArea.size > 0; }
export function windMeta()   { return meta; }

/** One line naming the models behind the data, for the UI caveat. */
export function windProvenance() {
  if (!meta || !meta.models || !meta.models.length) return 'Model wind';
  const names = meta.models.map(([name]) => name);
  return names.length === 1 ? names[0] : `${names[0]} (plus ${names.slice(1).join(', ')})`;
}

/** Fetch wind.json once. Absent or unreadable simply means no wind features. */
export async function loadWind() {
  if (loaded) return windLoaded();
  loaded = true;

  try {
    const r = await fetch(WIND_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const doc = await r.json();

    areas = doc.areas || [];

    // Which models supplied the data, commonest first. Stated in the UI rather
    // than hardcoded, so the caveat cannot drift out of step with the file.
    const names = doc.models || [];
    const tally = new Map();
    for (const row of doc.hours || []) {
      const idx = row[5];
      const name = idx != null && names[idx] ? names[idx] : 'unknown model';
      tally.set(name, (tally.get(name) || 0) + 1);
    }

    meta = {
      stamp: doc.stamp,
      built: doc.built,
      source: doc.source,
      hours: (doc.hours || []).length,
      models: [...tally.entries()].sort((a, b) => b[1] - a[1]),
    };

    byArea = new Map();
    for (const row of doc.hours || []) {
      const list = byArea.get(row[1]);
      if (list) list.push(row);
      else byArea.set(row[1], [row]);
    }
    for (const list of byArea.values()) list.sort((a, b) => a[0] - b[0]);

    return windLoaded();
  } catch (e) {
    console.warn('No wind data available:', e.message);
    return false;
  }
}

/** Nearest sailing area to a position, by squared degrees — areas are far apart. */
function nearestArea(lat, lon) {
  let best = null, bestD = Infinity;
  for (const a of areas) {
    const d = (a.lat - lat) ** 2 + (a.lon - lon) ** 2;
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

/** Cache the area lookup on the track — it never moves. */
function areaFor(track) {
  if (track._windArea === undefined) {
    const lat = track.bbox ? (track.bbox.minLat + track.bbox.maxLat) / 2 : track.lats[0];
    const lon = track.bbox ? (track.bbox.minLon + track.bbox.maxLon) / 2 : track.lons[0];
    const a = nearestArea(lat, lon);
    track._windArea = a ? a.id : null;
  }
  return track._windArea;
}

/**
 * Wind at a moment, interpolated between the bracketing hourly samples.
 * Returns null outside the covered range, or across a gap longer than an hour
 * or so — better no answer than a straight line drawn through missing data.
 */
export function windAt(areaId, t) {
  const rows = byArea.get(areaId);
  if (!rows || !rows.length) return null;

  let lo = 0, hi = rows.length - 1;
  if (t < rows[0][0] - MAX_WIND_GAP_MS || t > rows[hi][0] + MAX_WIND_GAP_MS) return null;

  if (t <= rows[0][0])  return sample(rows[0]);
  if (t >= rows[hi][0]) return sample(rows[hi]);

  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (rows[m][0] <= t) lo = m; else hi = m;
  }

  const a = rows[lo], b = rows[hi];
  if (b[0] - a[0] > MAX_WIND_GAP_MS) return null;

  const f = (t - a[0]) / (b[0] - a[0]);

  // Interpolate direction as a vector. Averaging 350 and 10 numerically gives
  // 180 — exactly backwards — instead of 0.
  const ar = a[3] * Math.PI / 180, br = b[3] * Math.PI / 180;
  const x = Math.cos(ar) + f * (Math.cos(br) - Math.cos(ar));
  const y = Math.sin(ar) + f * (Math.sin(br) - Math.sin(ar));

  return {
    speed:    a[2] + f * (b[2] - a[2]),
    windFrom: (Math.atan2(y, x) * 180 / Math.PI + 360) % 360,
    gust:     a[4] != null && b[4] != null ? a[4] + f * (b[4] - a[4]) : null,
  };
}

/** Wind at a track's position and time. */
export function windForTrack(track, t) {
  const areaId = areaFor(track);
  return areaId == null ? null : windAt(areaId, t);
}

/**
 * True wind angle: the angle between the bow and the wind, -180..180.
 * Zero is head to wind, +/-180 is dead downwind. Sign gives the tack —
 * negative is wind over the port bow, positive over the starboard bow.
 */
export function trueWindAngle(heading, windFrom) {
  // Range is [-180, 180): dead downwind lands on -180, never +180.
  return (windFrom - heading + 540) % 360 - 180;
}

/**
 * Tack, or null where the concept does not apply — head to wind and dead
 * downwind have no windward side, and claiming one there would be invented.
 */
export function tackOf(twa, deadZone = 3) {
  const a = Math.abs(twa);
  if (a < deadZone || a > 180 - deadZone) return null;
  return twa < 0 ? 'port' : 'stbd';
}

/** Points of sail, keyed off |TWA|. Boundaries are the conventional ones. */
export const POINTS_OF_SAIL = [
  { max: 30,  name: 'In irons',    short: 'Irons',  color: '#6c7086' },
  { max: 60,  name: 'Close hauled', short: 'Beat',  color: '#f38ba8' },
  { max: 90,  name: 'Close reach',  short: 'Close', color: '#fab387' },
  { max: 120, name: 'Beam reach',   short: 'Beam',  color: '#a6e3a1' },
  { max: 150, name: 'Broad reach',  short: 'Broad', color: '#89b4fa' },
  { max: 181, name: 'Running',      short: 'Run',   color: '#cba6f7' },
];

export function pointOfSail(twa) {
  const a = Math.abs(twa);
  for (const p of POINTS_OF_SAIL) if (a < p.max) return p;
  return POINTS_OF_SAIL[POINTS_OF_SAIL.length - 1];
}

export function pointOfSailIndex(twa) {
  const a = Math.abs(twa);
  for (let i = 0; i < POINTS_OF_SAIL.length; i++) if (a < POINTS_OF_SAIL[i].max) return i;
  return POINTS_OF_SAIL.length - 1;
}

/** Velocity made good straight upwind (positive) or downwind (negative). */
export function vmg(boatSpeed, twa) {
  return boatSpeed * Math.cos(twa * Math.PI / 180);
}
