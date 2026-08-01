import { windForTrack, trueWindAngle, pointOfSailIndex, vmg, windLoaded } from './wind.js';
import { bearingDeg } from '../core/geo.js';
import { MOVING_MIN_KTS } from '../config.js';

/**
 * Per-point true wind angle for a track, plus the aggregates that only become
 * possible once wind is known: time on each point of sail, best VMG up and
 * down, and a speed-against-wind-angle polar.
 *
 * Computed lazily and cached on the track — this walks every point, and a
 * season's worth would be millions.
 */

/** Polar resolution: 5-degree buckets over 0..180 of |TWA|. */
const TWA_BUCKET = 5;
const TWA_BUCKETS = 180 / TWA_BUCKET;

/**
 * Heading at index i, smoothed over a window. A single 1 Hz step is a metre or
 * two, so consecutive-point bearings are dominated by GPS jitter — sampling
 * across a few seconds gives a heading that means something.
 */
function headingAt(track, i, span = 5) {
  const { lats, lons, n } = track;
  const a = Math.max(0, i - span), b = Math.min(n - 1, i + span);
  if (a === b) return null;
  if (lats[a] === lats[b] && lons[a] === lons[b]) return null;
  return bearingDeg(lats[a], lons[a], lats[b], lons[b]);
}

export function analysePolar(track) {
  if (track._polar !== undefined) return track._polar;
  if (!windLoaded()) { track._polar = null; return null; }

  const { times, speeds, n } = track;

  const twa       = new Float32Array(n);
  const twaValid  = new Uint8Array(n);
  const sailMs    = new Array(6).fill(0);
  const bucketMax = new Float32Array(TWA_BUCKETS);
  const bucketSum = new Float64Array(TWA_BUCKETS);
  const bucketCnt = new Uint32Array(TWA_BUCKETS);

  let sampled = 0;

  for (let i = 0; i < n; i++) {
    // Only points actually under way carry a meaningful heading.
    if (speeds[i] < MOVING_MIN_KTS) continue;

    const heading = headingAt(track, i);
    if (heading === null) continue;

    // Sample at the boat's own position — over a 20 km area the grid genuinely
    // differs end to end, and the coordinates are already to hand.
    const wind = windForTrack(track, times[i], track.lats[i], track.lons[i]);
    if (!wind) continue;

    const angle = trueWindAngle(heading, wind.windFrom);
    twa[i] = angle;
    twaValid[i] = 1;
    sampled++;

    const dt = i > 0 ? times[i] - times[i - 1] : 0;
    if (dt > 0 && dt <= 60000) sailMs[pointOfSailIndex(angle)] += dt;

    const b = Math.min(TWA_BUCKETS - 1, Math.floor(Math.abs(angle) / TWA_BUCKET));
    if (speeds[i] > bucketMax[b]) bucketMax[b] = speeds[i];
    bucketSum[b] += speeds[i];
    bucketCnt[b]++;
  }

  if (!sampled) { track._polar = null; return null; }

  const bucketAvg = new Float32Array(TWA_BUCKETS);
  for (let b = 0; b < TWA_BUCKETS; b++) {
    bucketAvg[b] = bucketCnt[b] ? bucketSum[b] / bucketCnt[b] : 0;
  }

  track._polar = {
    twa, twaValid, sampled,
    sailMs,
    bucketMax, bucketAvg, bucketCnt,
    bucketSize: TWA_BUCKET,
    ...bestVmg(bucketAvg, bucketCnt),
  };
  return track._polar;
}

/** A bucket needs this many samples before it is worth drawing conclusions from. */
const MIN_BUCKET_SAMPLES = 30;

/**
 * Best velocity made good up and down, taken from the bucket averages rather
 * than the single fastest instant.
 *
 * A max over ten thousand 1 Hz samples is an outlier estimator — it reports the
 * luckiest surf down one wave, and for upwind it happily picks a moment of
 * drifting head to wind. Averaging within an angle bucket, and requiring the
 * bucket to be populated, gives a figure the boat actually sustained. It also
 * matches the curve drawn in the polar, so the number and the picture agree.
 */
function bestVmg(bucketAvg, bucketCnt) {
  let up = null, down = null;

  for (let b = 0; b < bucketAvg.length; b++) {
    if (bucketCnt[b] < MIN_BUCKET_SAMPLES) continue;

    const twa = (b + 0.5) * TWA_BUCKET;
    const v   = vmg(bucketAvg[b], twa);

    if (v > 0 && (up   === null || v >  up.vmg))   up   = { vmg:  v, speed: bucketAvg[b], twa };
    if (v < 0 && (down === null || v < -down.vmg)) down = { vmg: -v, speed: bucketAvg[b], twa };
  }

  return { bestUpwind: up, bestDownwind: down };
}

/** Merge several tracks' polars into one, for an archive-wide view. */
export function combinePolars(tracks) {
  const max = new Float32Array(TWA_BUCKETS);
  const sum = new Float64Array(TWA_BUCKETS);
  const cnt = new Uint32Array(TWA_BUCKETS);
  let sampled = 0;

  for (const t of tracks) {
    const p = analysePolar(t);
    if (!p) continue;
    sampled += p.sampled;
    for (let b = 0; b < TWA_BUCKETS; b++) {
      if (p.bucketMax[b] > max[b]) max[b] = p.bucketMax[b];
      sum[b] += p.bucketAvg[b] * p.bucketCnt[b];
      cnt[b] += p.bucketCnt[b];
    }
  }

  const avg = new Float32Array(TWA_BUCKETS);
  for (let b = 0; b < TWA_BUCKETS; b++) avg[b] = cnt[b] ? sum[b] / cnt[b] : 0;

  return { bucketMax: max, bucketAvg: avg, bucketCnt: cnt, bucketSize: TWA_BUCKET, sampled };
}

export { TWA_BUCKET, TWA_BUCKETS };
