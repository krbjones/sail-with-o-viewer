import { state } from '../core/store.js';
import { $ } from '../core/dom.js';
import { localHHMM, fmtDateInput } from '../core/format.js';
import { renderTracks } from '../map/trackRenderer.js';
import { clearMarkers } from '../map/markerRenderer.js';
import { renderForView, setAllShown } from './trackList.js';
import { updateAnimRange } from './animBar.js';
import { loadTracksForRange, manifestRange } from '../data/trackLoader.js';
import { registerPref, savePrefs } from '../core/prefs.js';
import { refreshStorageInfo } from './storagePanel.js';

/** Current date filter as epoch ms, with open ends when a field is blank. */
export function currentRange() {
  const from = $('#date-from').value;
  const to   = $('#date-to').value;
  return {
    fromMs: from ? new Date(from + 'T00:00:00').getTime() : 0,
    toMs:   to   ? new Date(to   + 'T23:59:59.999').getTime() : Infinity,
  };
}

export function setRange(fromMs, toMs) {
  $('#date-from').value = fmtDateInput(fromMs);
  $('#date-to').value   = fmtDateInput(toMs);
}

/** True if a track's local start time falls inside the time-of-day window. */
function passesTimeOfDay(track, timeFrom, timeTo) {
  if (!timeFrom || !timeTo) return true;
  const hhmm = localHHMM(track.startTime);
  return timeFrom <= timeTo
    ? (hhmm >= timeFrom && hhmm <= timeTo)          // normal window
    : !(hhmm < timeFrom && hhmm > timeTo);          // window wrapping midnight
}

/** Re-filter the loaded tracks and redraw everything. */
export function applyFilter() {
  const { fromMs, toMs } = currentRange();
  const timeFrom = $('#time-from').value;
  const timeTo   = $('#time-to').value;

  state.selectedTrack = null;
  state.visibleTracks = state.tracks.filter(t =>
    t.startTime <= toMs && t.endTime >= fromMs && passesTimeOfDay(t, timeFrom, timeTo)
  );

  // renderTracks fits the map first, so the extent-filtered list below is
  // computed against the final view rather than the previous one.
  clearMarkers();
  renderTracks();
  renderForView();
  updateAnimRange();
}

export function initFilterPanel() {
  registerPref('filter', {
    get: () => ({
      from:     $('#date-from').value,
      to:       $('#date-to').value,
      timeFrom: $('#time-from').value,
      timeTo:   $('#time-to').value,
    }),
    set: v => {
      if (v.from)     $('#date-from').value = v.from;
      if (v.to)       $('#date-to').value   = v.to;
      $('#time-from').value = v.timeFrom || '';
      $('#time-to').value   = v.timeTo   || '';
    },
  });

  for (const id of ['#date-from', '#date-to', '#time-from', '#time-to']) {
    $(id).addEventListener('change', savePrefs);
  }

  $('#btn-apply').onclick = async () => {
    const { fromMs, toMs } = currentRange();
    await loadTracksForRange(fromMs, toMs);
    applyFilter();
    refreshStorageInfo();
    savePrefs();
  };

  // Show All spans the whole manifest, not just what happens to be loaded.
  $('#btn-showall').onclick = async () => {
    const range = manifestRange();
    if (!range) return;

    setRange(range.min, range.max);
    $('#time-from').value = '';
    $('#time-to').value   = '';

    await loadTracksForRange(range.min, range.max);
    applyFilter();
    refreshStorageInfo();
    savePrefs();
  };

  $('#btn-all').onclick  = () => setAllShown(true);
  $('#btn-none').onclick = () => setAllShown(false);
}
