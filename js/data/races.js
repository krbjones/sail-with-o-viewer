import { RACES_URL } from '../config.js';

/**
 * Official race results, as scraped by build_races.py.
 *
 * The valuable part is the start and finish times. A recorded track runs two to
 * three hours of which only forty to sixty minutes is the race, so without the
 * official window every statistic is averaged with an hour of sailing out to
 * the line and home again.
 */

let doc = null;
let loaded = false;
/** Local date "YYYY-MM-DD" -> race entry featuring our boat. */
let byDate = new Map();

export function racesLoaded() { return loaded && byDate.size > 0; }
export function ourBoat()     { return doc ? doc.boat : null; }
export function raceCount()   { return byDate.size; }

export async function loadRaces() {
  if (loaded) return racesLoaded();
  loaded = true;

  try {
    const r = await fetch(RACES_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    doc = await r.json();

    for (const race of doc.races || []) {
      if (!race.boats.some(b => b.name === doc.boat)) continue;
      // One race per date for our boat; later fleets would only overwrite
      // themselves, and our boat sails one fleet.
      byDate.set(race.date, race);
    }
    return racesLoaded();
  } catch (e) {
    console.warn('No race results available:', e.message);
    return false;
  }
}

/** Local midnight for "YYYY-MM-DD", so clock times resolve in the sailor's day. */
function midnight(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/**
 * The race a track belongs to, with the window resolved to epoch ms.
 * Returns null when the track is not a race, or the results have no finish for
 * us — a DNF has no window to analyse.
 */
export function raceForTrack(track) {
  if (!racesLoaded()) return null;

  const d = new Date(track.startTime);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const race = byDate.get(key);
  if (!race || race.start == null) return null;

  const us = race.boats.find(b => b.name === doc.boat);
  if (!us || us.elapsed == null) return null;

  const base     = midnight(race.date);
  const startMs  = base + race.start * 1000;
  const finishMs = startMs + us.elapsed * 1000;

  // Only claim the race if the recording actually covers it.
  if (track.startTime > startMs || track.endTime < finishMs) return null;

  const finishers = race.boats.filter(b => b.elapsed != null)
                              .sort((a, b) => a.corrected - b.corrected);

  return {
    ...race,
    us,
    startMs,
    finishMs,
    finishers,
    rank: us.rank,
    scored: finishers.length,
    entries: race.boats.length,
  };
}

/** Every race we have both a result and a covering track for. */
export function racesWithTracks(tracks) {
  return tracks
    .map(t => ({ track: t, race: raceForTrack(t) }))
    .filter(x => x.race);
}
