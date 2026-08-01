import { map, trackLayer, lineRenderer } from './mapSetup.js';
import { state } from '../core/store.js';
import { speedBucket, unionBounds } from '../core/geo.js';
import {
  SPEED_COLORS, UNKNOWN_COLOR, TRACK_OPACITY, TRACK_WEIGHT, VIEW_DEBOUNCE_MS,
  TRACK_ACTIVE_OPACITY, TRACK_ACTIVE_WEIGHT,
  TRACK_DIM_OPACITY,    TRACK_DIM_WEIGHT,
} from '../config.js';
import { POINTS_OF_SAIL, pointOfSailIndex } from '../data/wind.js';
import { analysePolar } from '../data/polar.js';

/** Called with (trackId, isActive) whenever a track crosses the animation cursor. */
let onActiveChange = () => {};
export function setActiveChangeHandler(fn) { onActiveChange = fn; }

/** True when the animation cursor is inside a track's time range. */
export function isTrackActive(track, t) {
  return track.shown && t >= track.startTime && t <= track.endTime;
}

/**
 * Split a track into runs of constant speed bucket, grouped by bucket.
 * Returns an array indexed by bucket, each holding the runs for that colour.
 *
 * Consecutive runs share an endpoint so the coloured segments meet without
 * visible gaps — the same overlap the previous per-segment renderer used.
 */
/** Colours for the current mode; the last entry is "no data" in sail mode. */
export function paletteFor(mode) {
  return mode === 'sail'
    ? [...POINTS_OF_SAIL.map(p => p.color), UNKNOWN_COLOR]
    : SPEED_COLORS;
}

/**
 * Which colour band point i falls in.
 * In sail mode a point with no usable wind or heading gets the trailing
 * "unknown" band rather than being silently coloured as if it were known.
 */
function bandOf(track, i, mode, polar) {
  if (mode !== 'sail') return speedBucket(track.speeds[i]);
  if (!polar || !polar.twaValid[i]) return POINTS_OF_SAIL.length;
  return pointOfSailIndex(polar.twa[i]);
}

function bucketRuns(track, mode) {
  const { lats, lons, n } = track;
  const polar = mode === 'sail' ? analysePolar(track) : null;
  const runs = paletteFor(mode).map(() => []);

  // Build L.LatLng instances rather than [lat, lon] pairs, saving L.Polyline a
  // conversion pass over every point. Worth a few percent end to end; the bulk
  // of the render cost is Leaflet projecting and simplifying, not this loop.
  // Rendering the whole archive (~2M points) takes about 6 s, a month 0.7 s.
  let bucket = bandOf(track, 0, mode, polar);
  let run    = [L.latLng(lats[0], lons[0])];

  for (let i = 1; i < n; i++) {
    const b  = bandOf(track, i, mode, polar);
    const ll = L.latLng(lats[i], lons[i]);
    run.push(ll);

    if (b !== bucket) {
      runs[bucket].push(run);
      bucket = b;
      run = [ll];   // overlap, sharing the boundary point
    }
  }
  runs[bucket].push(run);

  return runs;
}

/**
 * Rebuild the polylines for the current visibleTracks.
 *
 * Each track becomes at most six layers — one multi-polyline per speed bucket —
 * instead of one layer per bucket change. A typical track changes bucket
 * hundreds of times, so this is the difference between ~660 layers per track
 * and 6.
 */
export function renderTracks({ fit = true } = {}) {
  trackLayer.clearLayers();

  for (const track of state.visibleTracks) {
    track.bucketLines  = [];
    track._activeState = undefined;

    // Hidden tracks still get their lines built, drawn invisible, so toggling
    // them back on is a style change rather than a rebuild.
    const opacity = track.shown ? TRACK_OPACITY : 0;
    const weight  = track.shown ? TRACK_WEIGHT  : 0;

    const palette = paletteFor(state.colorMode);
    const runs = bucketRuns(track, state.colorMode);
    for (let b = 0; b < runs.length; b++) {
      if (!runs[b].length) continue;

      const pl = L.polyline(runs[b], {
        renderer: lineRenderer,
        color:    palette[b],
        weight,
        opacity,
      }).addTo(trackLayer);

      pl.on('click', () => zoomToTrack(track));
      track.bucketLines.push(pl);
    }
  }

  if (fit) fitToTracks(state.visibleTracks);
}

/** Apply a style to every one of a track's bucket polylines. */
function styleTrack(track, opacity, weight) {
  for (const pl of track.bucketLines) pl.setStyle({ opacity, weight });
}

/**
 * Highlight the tracks the animation cursor is currently inside and dim the
 * rest. Restyles only on a transition — setStyle on a canvas layer forces a
 * full canvas redraw, so doing it every frame would be ruinous.
 */
export function updateTrackStyles() {
  for (const track of state.visibleTracks) {
    const active = isTrackActive(track, state.animTime);
    if (track._activeState === active) continue;

    track._activeState = active;
    if (track.shown) {
      styleTrack(track,
        active ? TRACK_ACTIVE_OPACITY : TRACK_DIM_OPACITY,
        active ? TRACK_ACTIVE_WEIGHT  : TRACK_DIM_WEIGHT);
    }
    onActiveChange(track.id, active);
  }
}

/**
 * Move the map without triggering the debounced extent-driven list rebuild —
 * callers of these helpers render the list themselves.
 */
function fitQuietly(bounds, padding) {
  map.invalidateSize({ animate: false });
  map.fitBounds(bounds, { padding, animate: false });
  state.suppressViewUntil = performance.now() + VIEW_DEBOUNCE_MS + 250;
}

/** Fit the map to a set of tracks using their precomputed bboxes. */
export function fitToTracks(tracks) {
  const bounds = unionBounds(tracks);
  if (bounds) fitQuietly(bounds, [20, 20]);
}

export function zoomToTrack(track) {
  const bounds = unionBounds([track]);
  if (bounds) fitQuietly(bounds, [30, 30]);
}

/**
 * Show or hide a single track's lines.
 * Does not refresh the markers — callers batch that so a bulk All/None toggle
 * only redraws once.
 */
export function setTrackShown(track, shown) {
  track.shown = shown;
  track._activeState = undefined;   // force a restyle on the next frame
  styleTrack(track, shown ? TRACK_OPACITY : 0, shown ? TRACK_WEIGHT : 0);
}
