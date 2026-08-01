import { state } from './core/store.js';
import { debounce } from './core/dom.js';
import { fmtDateInput } from './core/format.js';
import { VIEW_DEBOUNCE_MS } from './config.js';

import { map } from './map/mapSetup.js';
import { initLayers } from './map/layersControl.js';
import { initLegend } from './map/legend.js';

import { fetchManifest } from './data/manifest.js';
import { loadTracksForRange } from './data/trackLoader.js';

import { initAnimBar } from './ui/animBar.js';
import { initTrackList, renderForView } from './ui/trackList.js';
import { initFilterPanel, applyFilter, setRange } from './ui/filterPanel.js';
import { initKeyboard } from './ui/keyboard.js';
import { hideSplash, setSplashStatus, showSplashError, clearSplashError } from './ui/splash.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Keep the sidebar list in step with the map view, without touching polylines. */
const onViewChange = debounce(() => {
  if (performance.now() < state.suppressViewUntil) return;
  renderForView();
}, VIEW_DEBOUNCE_MS);

async function boot() {
  clearSplashError();
  setSplashStatus('Loading tracks…');

  let manifest;
  try {
    manifest = await fetchManifest();
  } catch (e) {
    showSplashError('Could not load the track index: ' + e.message, boot);
    return;
  }

  state.allTrackMeta = manifest.tracks;
  state.buildStamp   = manifest.buildStamp;

  if (!state.allTrackMeta.length) {
    showSplashError('The track index is empty. Run build_tracks.py and reload.', boot);
    return;
  }

  // Default view: the most recent week in the dataset.
  let latestMs = -Infinity;
  for (const m of state.allTrackMeta) if (m.startMs > latestMs) latestMs = m.startMs;
  setRange(latestMs - WEEK_MS, latestMs);

  setSplashStatus('Loading recent tracks…');
  const { failed } = await loadTracksForRange(latestMs - WEEK_MS, latestMs);

  if (failed.length && !state.tracks.length) {
    showSplashError(`Could not load track data (${failed.join(', ')}).`, boot);
    return;
  }

  hideSplash();
  applyFilter();
}

function init() {
  initLayers();
  initLegend();
  initAnimBar();
  initTrackList();
  initFilterPanel();
  initKeyboard();

  map.on('moveend zoomend', onViewChange);

  boot();
}

init();

// Handy for debugging from the console.
window.__sail = { state, map, fmtDateInput };
