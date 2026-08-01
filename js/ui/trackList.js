import { state } from '../core/store.js';
import { $, el, debounce } from '../core/dom.js';
import { registerPref, savePrefs } from '../core/prefs.js';
import { fmtTime, fmtDateTime, fmtDuration } from '../core/format.js';
import { map } from '../map/mapSetup.js';
import { bboxIntersects } from '../core/geo.js';
import { zoomToTrack, setTrackShown, setActiveChangeHandler, updateTrackStyles } from '../map/trackRenderer.js';
import { updateMarkers } from '../map/markerRenderer.js';
import { stopAnim, updateAnimRange, setAnimTime, refreshAnim } from './animBar.js';
import { deleteImported } from './importPanel.js';
import { renderStats } from './statsPanel.js';
import { closeDrawerAfterSelection } from './drawer.js';
import { saveUrlState } from '../data/urlState.js';

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

/** All / None buttons — one refresh for the whole batch. */
export function setAllShown(shown) {
  for (const track of state.visibleTracks) setShown(track, shown);
  updateTrackStyles();
  updateMarkers();
}

/** Drop the current selection and widen the animation range back out. */
export function clearSelection() {
  if (state.selectedTrack) selectTrack(state.selectedTrack);
}

/** Select a track by id, for restoring a shared link. No-op if not loaded. */
export function restoreSelection(id) {
  if (!id || state.selectedTrack) return;
  const track = state.visibleTracks.find(t => t.id === id);
  if (track) selectTrack(track);
}

/** Select (or deselect) a track and retarget the animation range at it. */
function selectTrack(track) {
  stopAnim();

  state.selectedTrack = state.selectedTrack === track ? null : track;
  if (state.selectedTrack) zoomToTrack(track);

  // zoomToTrack suppresses the debounced extent rebuild, so drive it here —
  // the list still follows the map extent, just without the 150ms lag.
  renderForView();
  renderStats();

  updateAnimRange();
  setAnimTime(state.animMin);
  refreshAnim();

  saveUrlState();
  // On a phone the drawer covers the map, so step aside to show the track.
  if (state.selectedTrack) closeDrawerAfterSelection();
}

function buildRow(track) {
  const checkbox = el('input', {
    type: 'checkbox', class: 'track-cb', title: 'Show/hide track',
    onchange: e => {
      e.stopPropagation();
      setShown(track, e.target.checked);
      updateTrackStyles();
      updateMarkers();
    },
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
      el('div', { class: 'track-date' }, [
        fmtDateTime(track.startTime),
        track.source === 'local' ? el('span', { class: 'track-local-badge', text: 'LOCAL', title: 'Imported into this browser' }) : null,
      ]),
      el('div', {
        class: 'track-meta',
        text: `${fmtTime(track.startTime)} · ${fmtDuration(track.duration)} · max ${track.maxSpeed.toFixed(1)} kts`,
      }),
    ]),
    track.source === 'local'
      ? el('button', {
          class: 'track-delete', title: 'Remove this imported track',
          text: '🗑',
          onclick: e => { e.stopPropagation(); deleteImported(track); },
        })
      : null,
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
const SORTS = {
  'date-desc': (a, b) => b.startTime - a.startTime,
  'date-asc':  (a, b) => a.startTime - b.startTime,
  'duration':  (a, b) => b.duration - a.duration,
  'distance':  (a, b) => (b.distance || 0) - (a.distance || 0),
  'maxSpd':    (a, b) => b.maxSpeed - a.maxSpeed,
};

/** Free-text haystack for a track: its formatted date, time and filename. */
function searchText(track) {
  if (!track._search) {
    track._search = `${fmtDateTime(track.startTime)} ${fmtTime(track.startTime)} ${track.id}`.toLowerCase();
  }
  return track._search;
}

/**
 * Every whitespace-separated term must appear somewhere in the track's text.
 * A single substring match would fail the most natural query there is —
 * "jul 2024" does not occur literally in "Mon, Jul 15, 2024".
 */
function matchesSearch(track, terms) {
  const hay = searchText(track);
  return terms.every(term => hay.includes(term));
}

export function renderForView() {
  // A map with no laid-out size reports a single degenerate point as its
  // bounds, which would filter every track out of the list. That happens in a
  // background tab, behind a drawer, or before first layout — show everything
  // rather than an empty sidebar, and let the resize handler re-filter.
  const size   = map.getSize();
  const bounds = map.getBounds();
  const usable = size.x > 0 && size.y > 0 && !bounds.getSouthWest().equals(bounds.getNorthEast());

  let list = usable
    ? state.visibleTracks.filter(t => bboxIntersects(t, bounds))
    : state.visibleTracks.slice();

  const query = ($('#track-search')?.value || '').trim().toLowerCase();
  const terms = query ? query.split(/\s+/) : [];
  if (terms.length) list = list.filter(t => matchesSearch(t, terms));

  const sort = SORTS[$('#track-sort')?.value] || SORTS['date-desc'];
  list = list.slice().sort(sort);

  renderRows(list,
    query                       ? 'Nothing matches that search.' :
    state.visibleTracks.length  ? 'No tracks in current view.'
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

  registerPref('trackList', {
    get: () => ({ search: $('#track-search').value, sort: $('#track-sort').value }),
    set: v => {
      if (typeof v.search === 'string') $('#track-search').value = v.search;
      if (v.sort && SORTS[v.sort])      $('#track-sort').value   = v.sort;
    },
  });

  const rerender = debounce(() => { renderForView(); savePrefs(); saveUrlState(); }, 120);
  $('#track-search').addEventListener('input', rerender);
  $('#track-sort').addEventListener('change', () => { renderForView(); savePrefs(); saveUrlState(); });
}
