import { state } from '../core/store.js';
import { localHHMM } from '../core/format.js';
import { areaFor, windAt } from './wind.js';

/**
 * Rollups over the manifest.
 *
 * Everything here reads state.allTrackMeta — the raw manifest entries, which
 * carry dist, movingMs, avgSpd, maxSpd and n per track. That is deliberate and
 * it is what makes totals cheap: the manifest is 75 KB and is already in memory
 * before first paint, whereas the month bundles it summarises are 79.5 MB
 * across 30 files. Nothing in this module may reach for point data.
 *
 * Manifest entries use the short field names (startMs, dist, maxSpd); hydrated
 * tracks in state.tracks use long ones (startTime, distance, maxSpeed). These
 * functions take the short shape throughout. Locally imported tracks are pushed
 * into allTrackMeta in the same shape, so they count too.
 */

const HOUR_MS = 3600000;

/**
 * True if a track's local start time falls inside the time-of-day window.
 *
 * Lives here rather than in the filter panel because both the filter and the
 * summary have to agree on it, and the midnight-wrapping case is too easy to
 * get subtly wrong twice. Takes either field shape.
 */
export function passesTimeOfDay(track, timeFrom, timeTo) {
  if (!timeFrom || !timeTo) return true;
  const hhmm = localHHMM(track.startTime ?? track.startMs);
  return timeFrom <= timeTo
    ? (hhmm >= timeFrom && hhmm <= timeTo)          // normal window
    : !(hhmm < timeFrom && hhmm > timeTo);          // window wrapping midnight
}

/** Manifest entries overlapping a range, under the same rules as the filter. */
export function metaInRange(fromMs, toMs, timeFrom, timeTo) {
  return state.allTrackMeta.filter(m =>
    m.startMs <= toMs && (m.endMs ?? m.startMs) >= fromMs &&
    passesTimeOfDay(m, timeFrom, timeTo)
  );
}

/** Distance, time and speed over a set of manifest entries. */
export function totals(metas) {
  let dist = 0, movingMs = 0, elapsedMs = 0, maxSpd = 0;
  let firstMs = Infinity, lastMs = -Infinity;

  for (const m of metas) {
    dist      += m.dist || 0;
    movingMs  += m.movingMs || 0;
    elapsedMs += (m.endMs ?? m.startMs) - m.startMs;
    if (m.maxSpd > maxSpd) maxSpd = m.maxSpd;
    if (m.startMs < firstMs) firstMs = m.startMs;
    if ((m.endMs ?? m.startMs) > lastMs) lastMs = m.endMs ?? m.startMs;
  }

  // Distance over time under way, matching how build_tracks.py derives a single
  // track's avgSpd. Averaging the per-track averages instead would weight a
  // ten-minute potter the same as a four-hour race, and several tracks store a
  // literal 0 for avgSpd when they never moved for a full minute.
  const avgSpd = movingMs >= 60000 ? dist / (movingMs / 3600000) : 0;

  return {
    count: metas.length, dist, movingMs, elapsedMs, avgSpd, maxSpd,
    firstMs: metas.length ? firstMs : null,
    lastMs:  metas.length ? lastMs  : null,
  };
}

/**
 * Mean wind across a set of tracks, sampled hourly from the area point series.
 *
 * Returns null when nothing is covered, which is the normal case for a period
 * before 2025 — wind is only fetched from 2025 on, and the grid only for areas
 * a North American model serves. `tracks` reports how many of them contributed
 * so the caller can say so rather than implying the whole period is described.
 */
export function windOver(metas) {
  let sumSpeed = 0, sumU = 0, sumV = 0, n = 0, gustMax = 0, covered = 0;

  for (const m of metas) {
    const areaId = areaFor(m);
    if (areaId == null) continue;

    let got = 0;
    for (let t = m.startMs; t <= (m.endMs ?? m.startMs); t += HOUR_MS) {
      const w = windAt(areaId, t);
      if (!w) continue;

      // Average direction as unit vectors. A numeric mean of 350 and 10 gives
      // 180 — exactly backwards.
      const r = w.windFrom * Math.PI / 180;
      sumU += Math.cos(r);
      sumV += Math.sin(r);
      sumSpeed += w.speed;
      n++; got++;
      if (w.gust != null && w.gust > gustMax) gustMax = w.gust;
    }
    if (got) covered++;
  }

  if (!n) return null;
  return {
    speed:    sumSpeed / n,
    windFrom: (Math.atan2(sumV, sumU) * 180 / Math.PI + 360) % 360,
    gust:     gustMax || null,
    tracks:   covered,
    of:       metas.length,
  };
}

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

/** Compass point for a bearing in degrees. */
export function compass(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/**
 * Every track grouped by year and then month, newest first.
 *
 * Grouping uses the manifest's own `month` key rather than re-deriving one from
 * startMs, so the breakdown agrees with the bundle a track actually lives in.
 */
export function allTime() {
  const years = new Map();

  for (const m of state.allTrackMeta) {
    const key  = m.month || '????-??';
    const year = key.slice(0, 4);

    let y = years.get(year);
    if (!y) years.set(year, y = { year, months: new Map() });

    let mo = y.months.get(key);
    if (!mo) y.months.set(key, mo = { key, metas: [] });
    mo.metas.push(m);
  }

  const out = [...years.values()].map(y => ({
    year:   y.year,
    ...totals([...y.months.values()].flatMap(mo => mo.metas)),
    months: [...y.months.values()]
      .map(mo => ({ key: mo.key, ...totals(mo.metas) }))
      .sort((a, b) => b.key.localeCompare(a.key)),
  })).sort((a, b) => b.year.localeCompare(a.year));

  return { years: out, ...totals(state.allTrackMeta) };
}
