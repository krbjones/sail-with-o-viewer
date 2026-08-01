import { map, trackLayer, markerLayer } from './mapSetup.js';
import { state } from '../core/store.js';
import { speedBucket, unionBounds } from '../core/geo.js';
import { SPEED_COLORS, TRACK_OPACITY, TRACK_WEIGHT, VIEW_DEBOUNCE_MS } from '../config.js';

/**
 * Group consecutive points into runs of the same speed bucket.
 * Adjacent segments share an endpoint so there are no visible gaps.
 */
export function buildSegments(points) {
  const segs = [];
  let curBucket = speedBucket(points[0].speed);
  let curPts    = [[points[0].lat, points[0].lon]];

  for (let i = 1; i < points.length; i++) {
    const b = speedBucket(points[i].speed);
    curPts.push([points[i].lat, points[i].lon]);

    if (b !== curBucket) {
      segs.push({ bucket: curBucket, latlngs: curPts });
      curBucket = b;
      curPts = [[points[i].lat, points[i].lon]];   // overlap
    }
  }
  segs.push({ bucket: curBucket, latlngs: curPts });
  return segs;
}

/** Rebuild all polylines for the current visibleTracks and fit the map to them. */
export function renderTracks({ fit = true } = {}) {
  trackLayer.clearLayers();
  markerLayer.clearLayers();

  for (const track of state.visibleTracks) {
    track.polylines    = [];
    track._activeState = undefined;

    // Hidden tracks keep their polylines but are drawn invisible, so that
    // toggling them back on does not require a full rebuild.
    const opacity = track.shown ? TRACK_OPACITY : 0;
    const weight  = track.shown ? TRACK_WEIGHT  : 0;

    for (const seg of buildSegments(track.points)) {
      if (seg.latlngs.length < 2) continue;
      const pl = L.polyline(seg.latlngs, {
        color: SPEED_COLORS[seg.bucket],
        weight,
        opacity,
      }).addTo(trackLayer);
      pl.on('click', () => zoomToTrack(track));
      track.polylines.push(pl);
    }
  }

  if (fit) fitToTracks(state.visibleTracks);
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
  if (bounds) {
    fitQuietly(bounds, [30, 30]);
    return;
  }
  // Fallback for tracks without a bbox (e.g. legacy data)
  if (!track.polylines.length) return;
  fitQuietly(L.featureGroup(track.polylines).getBounds().pad(0.1), [30, 30]);
}

/**
 * Show or hide a single track's polylines.
 * Does not refresh the markers — callers batch that so a bulk All/None toggle
 * only redraws once.
 */
export function setTrackShown(track, shown) {
  track.shown = shown;
  track._activeState = undefined;   // force a restyle on the next frame
  for (const pl of track.polylines) {
    pl.setStyle({
      opacity: shown ? TRACK_OPACITY : 0,
      weight:  shown ? TRACK_WEIGHT  : 0,
    });
  }
}
