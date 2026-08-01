import { state } from '../core/store.js';
import { DATA_DIR } from '../config.js';
import { trackFromJSON } from './trackModel.js';
import { showProgress, setProgress, hideProgress, setStatus } from '../ui/progress.js';

/** Months whose fetch failed — retried on the next load rather than skipped forever. */
export const failedMonths = new Set();

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

/** Fetch and hydrate every month bundle overlapping the given range. */
export async function loadTracksForRange(fromMs, toMs) {
  const monthList = [...monthsForRange(fromMs, toMs)].sort();
  if (!monthList.length) return { loaded: 0, failed: [] };

  showProgress('Loading…', 0);

  const failed = [];
  let done = 0;

  for (const month of monthList) {
    setProgress(done / monthList.length * 100, `Loading ${month}…`);

    try {
      const r = await fetch(`${DATA_DIR}/${month}.json`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const monthTracks = await r.json();

      for (const t of monthTracks) {
        if (state.loadedFiles.has(t.id)) continue;
        state.tracks.push(trackFromJSON(t));
        state.loadedFiles.add(t.id);
      }

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
