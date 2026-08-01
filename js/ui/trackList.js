import { state } from '../core/store.js';
import { $, el } from '../core/dom.js';
import { fmtTime, fmtDateTime, fmtDuration } from '../core/format.js';
import { map } from '../map/mapSetup.js';
import { bboxIntersects } from '../core/geo.js';
import { zoomToTrack, setTrackShown } from '../map/trackRenderer.js';
import { setActiveChangeHandler, updateMarkers } from '../map/markerRenderer.js';
import { stopAnim, updateAnimRange, setAnimTime, refreshAnim } from './animBar.js';

/** trackId → row element, so the animation loop never needs querySelector. */
const rows = new Map();

/** Toggle one track's visibility and keep its row in sync. */
function setShown(track, shown) {
  setTrackShown(track, shown);
  const row = rows.get(track.id);
  if (row) {
    row.classList.toggle('track-hidden', !shown);
    const cb = row.querySelector('.track-cb');
    if (cb) cb.checked = shown;
  }
}

/** All / None buttons — one marker refresh for the whole batch. */
export function setAllShown(shown) {
  for (const track of state.visibleTracks) setShown(track, shown);
  updateMarkers();
}

/** Select (or deselect) a track and retarget the animation range at it. */
function selectTrack(track) {
  stopAnim();

  state.selectedTrack = state.selectedTrack === track ? null : track;
  if (state.selectedTrack) zoomToTrack(track);

  // zoomToTrack suppresses the debounced extent rebuild, so drive it here —
  // the list still follows the map extent, just without the 150ms lag.
  renderForView();

  updateAnimRange();
  setAnimTime(state.animMin);
  refreshAnim();
}

function buildRow(track) {
  const checkbox = el('input', {
    type: 'checkbox', class: 'track-cb', title: 'Show/hide track',
    onchange: e => { e.stopPropagation(); setShown(track, e.target.checked); updateMarkers(); },
  });
  checkbox.checked = track.shown;

  const dot = el('div', { class: 'track-dot' });

  const row = el('div', {
    class: 'track-item',
    'data-id': track.id,
    onclick: () => selectTrack(track),
  }, [
    checkbox,
    dot,
    el('div', { class: 'track-info' }, [
      el('div', { class: 'track-date', text: fmtDateTime(track.startTime) }),
      el('div', {
        class: 'track-meta',
        text: `${fmtTime(track.startTime)} · ${fmtDuration(track.duration)} · max ${track.maxSpeed.toFixed(1)} kts`,
      }),
    ]),
    el('button', {
      class: 'track-zoom', title: 'Zoom to track',
      text: '⊕',
      onclick: e => { e.stopPropagation(); zoomToTrack(track); },
    }),
  ]);

  if (!track.shown) row.classList.add('track-hidden');
  if (state.selectedTrack === track) row.classList.add('track-selected');
  if (track._activeState) {
    row.classList.add('active-now');
    dot.style.background = 'var(--active)';
  }

  return row;
}

/**
 * Render an explicit list of tracks into the sidebar.
 * Both the date-filter view and the map-extent view go through here.
 */
export function renderRows(tracks, emptyMessage) {
  const list    = $('#tracklist');
  const countEl = $('#tracklist-count');
  const summary = $('#track-summary');

  countEl.textContent = `${tracks.length} of ${state.tracks.length}`;
  rows.clear();

  if (!tracks.length) {
    list.replaceChildren(el('div', { id: 'no-tracks', text: emptyMessage }));
    summary.textContent = '';
    return;
  }

  const totalDur = tracks.reduce((s, t) => s + t.duration, 0);
  summary.textContent =
    `Total: ${fmtDuration(totalDur)} · ${tracks.length} track${tracks.length !== 1 ? 's' : ''}`;

  const frag = document.createDocumentFragment();
  for (const track of tracks) {
    const row = buildRow(track);
    rows.set(track.id, row);
    frag.appendChild(row);
  }
  list.replaceChildren(frag);
}

/**
 * The filtered tracks whose bbox intersects the current map view.
 * The list always follows the map extent — there is no separate "all filtered"
 * mode, so this is the single entry point for rendering the sidebar.
 */
export function renderForView() {
  const bounds = map.getBounds();
  const inView = state.visibleTracks.filter(t => bboxIntersects(t, bounds));
  renderRows(inView, state.visibleTracks.length
    ? 'No tracks in current view.'
    : 'No tracks in this date range.');
}

/** Highlight a row as the animation cursor crosses its track. */
function applyActiveState(trackId, isActive) {
  const row = rows.get(trackId);
  if (!row) return;
  row.classList.toggle('active-now', isActive);
  const dot = row.querySelector('.track-dot');
  if (dot) dot.style.background = isActive ? 'var(--active)' : 'var(--accent)';
}

export function initTrackList() {
  setActiveChangeHandler(applyActiveState);
}
