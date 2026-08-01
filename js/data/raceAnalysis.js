import { bearingDeg, haversine } from '../core/geo.js';
import { windForTrack, trueWindAngle } from './wind.js';
import { MOVING_MIN_KTS } from '../config.js';

/**
 * Race-window analysis: legs, manoeuvres and what each one cost.
 *
 * Everything here takes an explicit [fromMs, toMs] window, because the numbers
 * are only meaningful over the race itself. Across these three races, half to
 * three quarters of each recording is sailing out to the line and home again.
 */

/** Heading is measured across this many samples either side — see below. */
const HEADING_SPAN = 5;

/**
 * A manoeuvre is only real once the boat settles on the new tack beyond this
 * angle, having held the old one for MIN_HOLD_MS.
 *
 * Without the hysteresis, every wobble across head-to-wind or dead-downwind
 * counts: an earlier version of this reported 53 manoeuvres in one race, most
 * of them with no measurable speed loss because nothing had actually happened.
 */
const SETTLE_TWA   = 25;
const MIN_HOLD_MS  = 20000;
/** Speed must come back to this fraction of the entry speed to count as recovered. */
const RECOVERED_AT = 0.95;
const MAX_RECOVERY_MS = 120000;

const KNOTS_TO_MS = 0.514444;

/** Index range covering a time window. */
function windowRange(track, fromMs, toMs) {
  const { times, n } = track;
  let lo = 0, hi = n - 1;
  while (lo < n && times[lo] < fromMs) lo++;
  while (hi >= 0 && times[hi] > toMs) hi--;
  return [lo, hi];
}

/** Heading over a few seconds, not point to point: at 1 Hz a step is GPS noise. */
function headingAt(track, i, lo, hi) {
  const a = Math.max(lo, i - HEADING_SPAN);
  const b = Math.min(hi, i + HEADING_SPAN);
  if (a === b) return null;
  if (track.lats[a] === track.lats[b] && track.lons[a] === track.lons[b]) return null;
  return bearingDeg(track.lats[a], track.lons[a], track.lats[b], track.lons[b]);
}

/** Per-sample true wind angle across the window, with nulls where unknown. */
function twaSeries(track, lo, hi) {
  const twa = new Float32Array(hi - lo + 1);
  const ok  = new Uint8Array(hi - lo + 1);

  for (let i = lo; i <= hi; i++) {
    if (track.speeds[i] < MOVING_MIN_KTS) continue;
    const heading = headingAt(track, i, lo, hi);
    if (heading === null) continue;
    const wind = windForTrack(track, track.times[i], track.lats[i], track.lons[i]);
    if (!wind) continue;
    twa[i - lo] = trueWindAngle(heading, wind.windFrom);
    ok[i - lo]  = 1;
  }
  return { twa, ok };
}

/**
 * Tacks and gybes, with the speed cost of each.
 *
 * Loss is the integral of the speed deficit against the entry speed, from the
 * moment the boat leaves the old tack until it is back up to speed — not a
 * triangle approximation, since the recovery is rarely linear.
 */
export function detectManoeuvres(track, fromMs, toMs) {
  const [lo, hi] = windowRange(track, fromMs, toMs);
  if (hi - lo < 60) return [];

  const { twa, ok } = twaSeries(track, lo, hi);
  const { times, speeds } = track;

  const manoeuvres = [];
  let side = 0;            // -1 port, +1 starboard, 0 not yet established
  let sideSince = null;    // when the current side was confirmed
  let leaving = null;      // index where the boat last left a settled side

  for (let k = 0; k <= hi - lo; k++) {
    if (!ok[k]) continue;
    const i = lo + k;
    const a = twa[k];

    if (Math.abs(a) < SETTLE_TWA) {
      // In the turn, or head to wind. Remember where it began.
      if (leaving === null && side !== 0) leaving = i;
      continue;
    }

    const s = a < 0 ? -1 : 1;

    if (side === 0) { side = s; sideSince = times[i]; leaving = null; continue; }

    if (s === side) { leaving = null; continue; }

    // Changed side. Only count it if the old one was held long enough.
    if (times[i] - sideSince < MIN_HOLD_MS) { side = s; sideSince = times[i]; leaving = null; continue; }

    const startIdx = leaving !== null ? leaving : i;
    manoeuvres.push(measure(track, lo, hi, startIdx, i, twa, ok));
    side = s;
    sideSince = times[i];
    leaving = null;
  }

  return manoeuvres.filter(Boolean);
}

function measure(track, lo, hi, startIdx, endIdx, twa, ok) {
  const { times, speeds } = track;

  // Entry speed: the 20 s before the boat left the old tack.
  let sum = 0, count = 0;
  for (let i = startIdx; i >= lo && times[startIdx] - times[i] <= 20000; i--) {
    sum += speeds[i]; count++;
  }
  if (!count) return null;
  const entry = sum / count;
  if (entry < 1) return null;      // drifting; a "manoeuvre" here means nothing

  // Through the turn: minimum speed, and whether it passed close to head to wind.
  let minSpeed = Infinity, minAbsTwa = 180;
  for (let i = startIdx; i <= Math.min(hi, endIdx + 10); i++) {
    if (speeds[i] < minSpeed) minSpeed = speeds[i];
    const k = i - lo;
    if (ok[k]) minAbsTwa = Math.min(minAbsTwa, Math.abs(twa[k]));
  }

  // Recovery, and the deficit integrated over it.
  const target = entry * RECOVERED_AT;
  let recoveredAt = null, lostMetres = 0;
  for (let i = startIdx + 1; i <= hi; i++) {
    const dt = (times[i] - times[i - 1]) / 1000;
    if (dt > 0 && dt < 30) lostMetres += Math.max(0, entry - speeds[i]) * KNOTS_TO_MS * dt;
    if (speeds[i] >= target && times[i] > times[endIdx]) { recoveredAt = times[i]; break; }
    if (times[i] - times[startIdx] > MAX_RECOVERY_MS) break;
  }

  return {
    kind: minAbsTwa < 90 ? 'tack' : 'gybe',
    at: times[startIdx],
    entry,
    minSpeed,
    recoverySec: recoveredAt ? (recoveredAt - times[startIdx]) / 1000 : null,
    lostMetres,
  };
}

/** Point-of-sail band, coarser than the legend's six for leg splitting. */
function bandOf(twa) {
  const a = Math.abs(twa);
  return a < 60 ? 'Upwind' : a < 120 ? 'Reach' : 'Downwind';
}

/** Sustained stretches on one point of sail. */
export function detectLegs(track, fromMs, toMs, minMs = 120000) {
  const [lo, hi] = windowRange(track, fromMs, toMs);
  if (hi - lo < 60) return [];

  const { twa, ok } = twaSeries(track, lo, hi);
  const { times, speeds, lats, lons } = track;

  const legs = [];
  let cur = null;

  for (let k = 0; k <= hi - lo; k++) {
    if (!ok[k]) continue;
    const i = lo + k;
    const band = bandOf(twa[k]);

    if (cur && cur.band === band) {
      cur.endMs = times[i];
      cur.endIdx = i;
    } else {
      if (cur && cur.endMs - cur.startMs >= minMs) legs.push(cur);
      cur = { band, startMs: times[i], endMs: times[i], startIdx: i, endIdx: i };
    }
  }
  if (cur && cur.endMs - cur.startMs >= minMs) legs.push(cur);

  // Fill in what each leg actually achieved.
  for (const leg of legs) {
    let dist = 0, sum = 0, count = 0, max = 0;
    for (let i = leg.startIdx + 1; i <= leg.endIdx; i++) {
      dist += haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]);
      sum += speeds[i]; count++;
      if (speeds[i] > max) max = speeds[i];
    }
    leg.distanceNm = dist / 1852;
    leg.avgSpeed = count ? sum / count : 0;
    leg.maxSpeed = max;
    leg.durationMs = leg.endMs - leg.startMs;
  }

  return legs;
}

/** Distance, speed and time over an explicit window. */
export function windowStats(track, fromMs, toMs) {
  const [lo, hi] = windowRange(track, fromMs, toMs);
  if (hi <= lo) return null;

  const { times, speeds, lats, lons } = track;
  let dist = 0, moving = 0, sum = 0, count = 0, max = 0;

  for (let i = lo + 1; i <= hi; i++) {
    const dt = times[i] - times[i - 1];
    if (dt <= 0 || dt > 60000) continue;
    dist += haversine(lats[i - 1], lons[i - 1], lats[i], lons[i]);
    if (speeds[i] >= MOVING_MIN_KTS) moving += dt;
    sum += speeds[i]; count++;
    if (speeds[i] > max) max = speeds[i];
  }

  const distanceNm = dist / 1852;
  return {
    distanceNm,
    durationMs: times[hi] - times[lo],
    movingMs: moving,
    avgSpeed: count ? sum / count : 0,
    maxSpeed: max,
    // Speed made good around the course, which is what the result is scored on.
    vmgCourse: distanceNm / ((times[hi] - times[lo]) / 3600000),
    points: hi - lo + 1,
  };
}
