import { state } from '../core/store.js';
import { $ } from '../core/dom.js';
import { fmtDate, fmtTime, fmtDateTime } from '../core/format.js';
import { updateMarkers } from '../map/markerRenderer.js';
import { updateTrackStyles } from '../map/trackRenderer.js';
import { STEP_MS, SLIDER_STEPS, UI_REFRESH_MS } from '../config.js';
import { registerPref, savePrefs } from '../core/prefs.js';

export function setAnimTime(t) {
  state.animTime = Math.max(state.animMin, Math.min(state.animMax, t));
}

export function updateSlider() { $('#anim-slider').value = state.animTime; }

export function updateTimeDisplay() {
  const main  = $('#anim-time-main');
  const sub   = $('#anim-time-sub');
  const count = $('#active-count');

  if (!state.visibleTracks.length) {
    main.textContent  = '──────────────';
    sub.textContent   = 'No tracks loaded';
    count.textContent = '';
    return;
  }

  main.textContent = fmtDateTime(state.animTime);
  sub.textContent  = fmtTime(state.animTime);

  let active = 0;
  for (const t of state.visibleTracks) {
    if (state.animTime >= t.startTime && state.animTime <= t.endTime) active++;
  }
  count.textContent = active ? `${active} track${active !== 1 ? 's' : ''} active` : '';
}

/** Recompute the slider bounds from the selection (or the whole filtered set). */
export function updateAnimRange() {
  const slider = $('#anim-slider');

  if (!state.visibleTracks.length) {
    slider.disabled = true;
    $('#anim-range-start').textContent = '──';
    $('#anim-range-end').textContent   = '──';
    updateTimeDisplay();
    return;
  }

  if (state.selectedTrack) {
    state.animMin = state.selectedTrack.startTime;
    state.animMax = state.selectedTrack.endTime;
    $('#anim-range-start').textContent = fmtTime(state.animMin);
    $('#anim-range-end').textContent   = fmtTime(state.animMax);
  } else {
    let min = Infinity, max = -Infinity;
    for (const t of state.visibleTracks) {
      if (t.startTime < min) min = t.startTime;
      if (t.endTime   > max) max = t.endTime;
    }
    state.animMin = min;
    state.animMax = max;
    $('#anim-range-start').textContent = fmtDate(state.animMin);
    $('#anim-range-end').textContent   = fmtDate(state.animMax);
  }

  slider.min  = state.animMin;
  slider.max  = state.animMax;
  slider.step = Math.max(1, Math.round((state.animMax - state.animMin) / SLIDER_STEPS));
  slider.disabled = false;

  if (state.animTime < state.animMin || state.animTime > state.animMax) setAnimTime(state.animMin);
  slider.value = state.animTime;
  updateTimeDisplay();
}

/** Push the current animTime into every part of the UI. */
export function refreshAnim() {
  updateSlider();
  updateTimeDisplay();
  updateTrackStyles();
  updateMarkers();
}

/** Stop playback, move the cursor, and refresh. */
export function seekTo(t) {
  stopAnim();
  setAnimTime(t);
  refreshAnim();
}

// ── Playback loop ─────────────────────────────────────────────────
let lastUiRefresh = 0;

function animStep(realNow) {
  if (!state.isPlaying) return;

  if (state.lastRealTime !== null) {
    const trackDelta = (realNow - state.lastRealTime) * state.animSpeed / 1000;
    setAnimTime(state.animTime + trackDelta);

    // Boats move every frame; the clock, slider and active-track highlighting
    // only need to keep up with the eye, and each one touches layout.
    updateTrackStyles();
    updateMarkers();
    if (realNow - lastUiRefresh >= UI_REFRESH_MS) {
      lastUiRefresh = realNow;
      updateSlider();
      updateTimeDisplay();
    }

    if (state.animTime >= state.animMax) { stopAnim(); return; }
  }

  state.lastRealTime = realNow;
  state.rafId = requestAnimationFrame(animStep);
}

export function startAnim() {
  if (!state.visibleTracks.length) return;
  state.isPlaying = true;
  state.lastRealTime = null;
  $('#btn-play').textContent = '⏸';
  if (state.animTime >= state.animMax) setAnimTime(state.animMin);
  state.rafId = requestAnimationFrame(animStep);
}

export function stopAnim() {
  const wasPlaying = state.isPlaying;
  state.isPlaying = false;
  if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
  $('#btn-play').textContent = '▶';
  state.lastRealTime = null;
  // Catch the throttled controls up to where playback actually stopped.
  if (wasPlaying) { updateSlider(); updateTimeDisplay(); }
}

export const togglePlay = () => state.isPlaying ? stopAnim() : startAnim();

// ── Wiring ────────────────────────────────────────────────────────
export function initAnimBar() {
  registerPref('animSpeed', {
    get: () => state.animSpeed,
    set: v => {
      const n = parseInt(v, 10);
      if (!Number.isFinite(n)) return;
      state.animSpeed = n;
      $('#speed-select').value = String(n);
    },
  });

  $('#btn-play').onclick      = togglePlay;
  $('#btn-to-start').onclick  = () => seekTo(state.animMin);
  $('#btn-to-end').onclick    = () => seekTo(state.animMax);
  $('#btn-step-back').onclick = () => seekTo(state.animTime - STEP_MS);
  $('#btn-step-fwd').onclick  = () => seekTo(state.animTime + STEP_MS);

  $('#anim-slider').oninput = e => {
    stopAnim();
    setAnimTime(parseInt(e.target.value, 10));
    updateTimeDisplay();
    updateTrackStyles();
    updateMarkers();
  };

  $('#speed-select').onchange = e => {
    state.animSpeed = parseInt(e.target.value, 10);
    savePrefs();
  };
}
