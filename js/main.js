import { state } from './core/store.js';
import { debounce } from './core/dom.js';
import { loadPrefs, flushPrefs } from './core/prefs.js';
import { VIEW_DEBOUNCE_MS } from './config.js';

import { map } from './map/mapSetup.js';
import { initLayers, addWindOverlay } from './map/layersControl.js';
import { createWindParticleLayer } from './map/windParticles.js';
import { initLegend, enableColorModes, disableColorModes, setColorModeHandler } from './map/legend.js';
import { renderTracks } from './map/trackRenderer.js';

import { fetchManifest } from './data/manifest.js';
import { loadWind } from './data/wind.js';
import { initWindLayer } from './map/windLayer.js';
import { loadTracksForRange, syncCache, loadLocalTracks } from './data/trackLoader.js';

import { initAnimBar, seekTo, refreshAnim } from './ui/animBar.js';
import { initTrackList, renderForView, clearSelection, restoreSelection } from './ui/trackList.js';
import { initFilterPanel, applyFilter, setRange, currentRange } from './ui/filterPanel.js';
import { initStoragePanel, refreshStorageInfo } from './ui/storagePanel.js';
import { initImportPanel } from './ui/importPanel.js';
import { initStatsPanel, setSeekHandler, setCloseHandler } from './ui/statsPanel.js';
import { initKeyboard } from './ui/keyboard.js';
import { initDrawer } from './ui/drawer.js';
import {
  readUrlState, applyUrlFilters, applyUrlView, startUrlSync, saveUrlState,
} from './data/urlState.js';
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

  // Saved preferences first, then the URL on top — a shared link should win
  // over whatever this browser was last looking at.
  await loadPrefs();
  const url = readUrlState();
  applyUrlFilters(url);

  // Open on the most recent week of sailing every time. The date range is
  // deliberately not restored from preferences: the useful thing to see on
  // arrival is what happened lately, not wherever the filter was left months
  // ago. An explicit shared link still wins.
  if (!url.from) {
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

  // Wind is optional: 33 KB, and every feature that uses it degrades quietly
  // if data/wind.json is absent. The colour-mode toggle only appears once
  // there is wind to colour by.
  if (await loadWind()) {
    initWindLayer();
    enableColorModes();

    // Offered only when there is a grid to animate, and only if the browser has
    // not asked for reduced motion.
    const particles = createWindParticleLayer(map);
    if (particles) addWindOverlay(particles);
  } else {
    disableColorModes();
  }

  hideSplash();
  applyFilter();

  // A shared link's framing and selection beat applyFilter's auto-fit.
  restoreSelection(url.sel);
  if (applyUrlView(url)) renderForView();
  if (url.t) seekTo(Number(url.t));

  startUrlSync();
  saveUrlState();     // publish the restored view so the link is copyable straight away
  refreshStorageInfo();
}

function init() {
  initLayers();
  // Early, so its preferences are registered before boot's loadPrefs runs.
  initLegend();
  setColorModeHandler(() => { renderTracks({ fit: false }); refreshAnim(); });
  initAnimBar();
  initTrackList();
  initFilterPanel();
  initStoragePanel();
  initImportPanel();
  initStatsPanel();
  initDrawer();
  initKeyboard();

  // Scrubbing the stats sparkline drives the animation cursor.
  setSeekHandler(seekTo);
  setCloseHandler(clearSelection);

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
