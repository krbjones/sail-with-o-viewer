import { state } from './core/store.js';
import { debounce } from './core/dom.js';
import { loadPrefs, flushPrefs } from './core/prefs.js';
import { VIEW_DEBOUNCE_MS } from './config.js';

import { map } from './map/mapSetup.js';
import { initLayers } from './map/layersControl.js';
import { initLegend } from './map/legend.js';

import { fetchManifest } from './data/manifest.js';
import { loadTracksForRange, syncCache, loadLocalTracks } from './data/trackLoader.js';

import { initAnimBar } from './ui/animBar.js';
import { initTrackList, renderForView } from './ui/trackList.js';
import { initFilterPanel, applyFilter, setRange, currentRange } from './ui/filterPanel.js';
import { initStoragePanel, refreshStorageInfo } from './ui/storagePanel.js';
import { initImportPanel } from './ui/importPanel.js';
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

  state.allTrackMeta   = manifest.tracks;
  state.buildStamp     = manifest.buildStamp;
  state.manifestMonths = manifest.months;

  if (!state.allTrackMeta.length) {
    showSplashError('The track index is empty. Run build_tracks.py and reload.', boot);
    return;
  }

  // Drop any cached month whose bundle has been rebuilt since.
  setSplashStatus('Checking local cache…');
  await syncCache(manifest.months);
  await loadLocalTracks();

  // Restore the saved filter, falling back to the most recent week of data.
  const saved = await loadPrefs();
  if (!saved.filter || !saved.filter.from) {
    let latestMs = -Infinity;
    for (const m of state.allTrackMeta) if (m.startMs > latestMs) latestMs = m.startMs;
    setRange(latestMs - WEEK_MS, latestMs);
  }

  setSplashStatus('Loading tracks…');
  const { fromMs, toMs } = currentRange();
  const { failed } = await loadTracksForRange(fromMs, toMs);

  if (failed.length && !state.tracks.length) {
    showSplashError(`Could not load track data (${failed.join(', ')}).`, boot);
    return;
  }

  hideSplash();
  applyFilter();
  refreshStorageInfo();
}

function init() {
  initLayers();
  initLegend();
  initAnimBar();
  initTrackList();
  initFilterPanel();
  initStoragePanel();
  initImportPanel();
  initKeyboard();

  // 'resize' matters too: the map may be laid out only after boot (background
  // tab, or a drawer opening), and the list needs re-filtering once it is.
  map.on('moveend zoomend resize', onViewChange);
  // pagehide, not unload: the debounced save would never fire on the way out.
  window.addEventListener('pagehide', flushPrefs);

  boot();
}

init();

// Handy for debugging from the console.
window.__sail = { state, map };
