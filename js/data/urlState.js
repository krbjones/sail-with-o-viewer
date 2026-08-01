import { state } from '../core/store.js';
import { $, debounce } from '../core/dom.js';
import { map } from '../map/mapSetup.js';
import { BASEMAPS } from '../map/basemaps.js';

/**
 * The current view encoded in the URL hash, so a filtered, framed, selected
 * view can be bookmarked or sent to someone.
 *
 * Written with replaceState — every map pan would otherwise add a history
 * entry and make the back button useless.
 */

let suppressWrites = true;   // stays on until the first read completes

function activeBasemapName() {
  for (const [name, layer] of Object.entries(BASEMAPS)) {
    if (map.hasLayer(layer)) return name;
  }
  return null;
}

function encode() {
  const p = new URLSearchParams();
  const add = (k, v) => { if (v) p.set(k, v); };

  add('from', $('#date-from').value);
  add('to',   $('#date-to').value);
  add('tf',   $('#time-from').value);
  add('tt',   $('#time-to').value);
  add('q',    $('#track-search').value.trim());
  add('sort', $('#track-sort').value !== 'date-desc' ? $('#track-sort').value : '');
  add('sel',  state.selectedTrack ? state.selectedTrack.id : '');
  add('base', activeBasemapName());

  const size = map.getSize();
  if (size.x > 0 && size.y > 0) {
    const c = map.getCenter();
    add('z', String(map.getZoom()));
    add('c', `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`);
  }

  if (state.animTime) add('t', String(Math.round(state.animTime)));

  return p.toString();
}

/** Parse the hash into a plain object; empty when there is nothing to restore. */
export function readUrlState() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return {};

  const p   = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of p) out[k] = v;
  return out;
}

/**
 * Apply the parts of the URL that belong to the filter controls.
 * Map position and selection are applied later, once tracks exist.
 */
export function applyUrlFilters(url) {
  if (url.from) $('#date-from').value = url.from;
  if (url.to)   $('#date-to').value   = url.to;
  if (url.tf)   $('#time-from').value = url.tf;
  if (url.tt)   $('#time-to').value   = url.tt;
  if (url.q)    $('#track-search').value = url.q;
  if (url.sort) $('#track-sort').value   = url.sort;

  if (url.base && BASEMAPS[url.base]) {
    for (const layer of Object.values(BASEMAPS)) map.removeLayer(layer);
    BASEMAPS[url.base].addTo(map);
  }
}

/** Restore map framing from the URL. Returns true if it moved the map. */
export function applyUrlView(url) {
  if (!url.c || !url.z) return false;

  const [lat, lng] = url.c.split(',').map(Number);
  const zoom = Number(url.z);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(zoom)) return false;

  map.setView([lat, lng], zoom, { animate: false });
  return true;
}

export const saveUrlState = debounce(() => {
  if (suppressWrites) return;
  const q = encode();
  history.replaceState(null, '', q ? '#' + q : location.pathname + location.search);
}, 300);

/** Start reflecting state into the URL. Called once boot has restored the view. */
export function startUrlSync() {
  suppressWrites = false;
  map.on('moveend zoomend baselayerchange', saveUrlState);
}
