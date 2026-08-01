import { state } from '../core/store.js';
import { DATA_DIR } from '../config.js';
import { trackFromJSON, toCacheRecord, fromCacheRecord } from './trackModel.js';
import { cachedMonths, readMonth, writeMonth, evictMonth, readLocalTracks } from './db.js';
import { showProgress, setProgress, hideProgress, setStatus } from '../ui/progress.js';

/** Months whose fetch failed — retried on the next load rather than skipped forever. */
export const failedMonths = new Set();

/** month → hash, as recorded in IndexedDB. Refreshed by syncCache(). */
let cacheIndex = {};
/** How many months were served from the cache this session. */
export const cacheStats = { hits: 0, misses: 0 };

/**
 * Reconcile the cache against the manifest: drop any month whose content hash
 * has moved on, so a rebuilt bundle is refetched rather than served stale.
 * Imported tracks are never touched.
 */
export async function syncCache(manifestMonths) {
  cacheIndex = await cachedMonths();

  for (const [month, hash] of Object.entries(cacheIndex)) {
    const current = manifestMonths?.[month];
    if (current !== undefined && current !== hash) {
      await evictMonth(month);
      delete cacheIndex[month];
    }
  }
}

/** Pull previously imported tracks into memory. */
export async function loadLocalTracks() {
  const records = await readLocalTracks();
  let added = 0;

  for (const rec of records) {
    if (state.loadedFiles.has(rec.id)) continue;
    state.tracks.push(fromCacheRecord(rec));
    state.loadedFiles.add(rec.id);
    added++;
  }

  if (added) state.tracks.sort((a, b) => a.startTime - b.startTime);
  return added;
}

/**
 * Month keys whose tracks overlap [fromMs, toMs].
 * Uses interval overlap (not just startMs containment) so a track that begins
 * before the window but runs into it is still fetched.
 */
function monthsForRange(fromMs, toMs) {
  const needed = new Set();
  for (const m of state.allTrackMeta) {
    const start = m.startMs;
    const end   = m.endMs ?? m.startMs;
    if (end < fromMs || start > toMs) continue;
    if (!state.loadedMonths.has(m.month)) needed.add(m.month);
  }
  return needed;
}

function admit(track) {
  if (state.loadedFiles.has(track.id)) return null;
  state.tracks.push(track);
  state.loadedFiles.add(track.id);
  return track;
}

/** Read a month from the cache, else fetch it and cache it. */
async function loadMonth(month) {
  const wanted = state.manifestMonths?.[month];

  // Cached and current — records come back ready to use.
  if (wanted !== undefined && cacheIndex[month] === wanted) {
    const records = await readMonth(month);
    if (records && records.length) {
      for (const rec of records) admit(fromCacheRecord(rec));
      cacheStats.hits++;
      return;
    }
  }

  const r = await fetch(`${DATA_DIR}/${month}.json`);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const records = await r.json();

  const admitted = [];
  for (const rec of records) {
    const track = admit(trackFromJSON(rec));
    if (track) admitted.push(track);
  }
  cacheStats.misses++;

  if (wanted !== undefined && admitted.length) {
    const cacheRecords = admitted.map(t => toCacheRecord(t, month));
    if (await writeMonth(month, wanted, cacheRecords)) cacheIndex[month] = wanted;
  }
}

/** Load every month bundle overlapping the given range. */
export async function loadTracksForRange(fromMs, toMs) {
  const monthList = [...monthsForRange(fromMs, toMs)].sort();
  if (!monthList.length) return { loaded: 0, failed: [] };

  showProgress('Loading…', 0);

  const failed = [];
  let done = 0;

  for (const month of monthList) {
    setProgress(done / monthList.length * 100, `Loading ${month}…`);

    try {
      await loadMonth(month);
      // Only mark loaded on success, so a transient failure can be retried.
      state.loadedMonths.add(month);
      failedMonths.delete(month);
    } catch (e) {
      console.warn(`Failed to load ${DATA_DIR}/${month}.json:`, e);
      failedMonths.add(month);
      failed.push(month);
    }

    done++;
    setProgress(done / monthList.length * 100);
    await new Promise(r => setTimeout(r, 0));
  }

  state.tracks.sort((a, b) => a.startTime - b.startTime);

  setProgress(100);
  await new Promise(r => setTimeout(r, 200));
  hideProgress();

  setStatus(failed.length
    ? `${state.loadedFiles.size} / ${state.allTrackMeta.length} loaded · ${failed.length} month(s) failed`
    : `${state.loadedFiles.size} / ${state.allTrackMeta.length} tracks loaded`);

  return { loaded: monthList.length - failed.length, failed };
}

/** Full extent of the dataset according to the manifest. */
export function manifestRange() {
  let min = Infinity, max = -Infinity;
  for (const m of state.allTrackMeta) {
    if (m.startMs < min) min = m.startMs;
    const end = m.endMs ?? m.startMs;
    if (end > max) max = end;
  }
  return min === Infinity ? null : { min, max };
}

/** Forget the in-memory cache index after the stored data is cleared. */
export function resetCacheIndex() {
  cacheIndex = {};
  cacheStats.hits = cacheStats.misses = 0;
}
