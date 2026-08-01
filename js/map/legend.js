import { SPEED_COLORS, SPEED_LABELS, UNKNOWN_COLOR } from '../config.js';
import { $, el } from '../core/dom.js';
import { state } from '../core/store.js';
import { POINTS_OF_SAIL } from '../data/wind.js';
import { registerPref, savePrefs } from '../core/prefs.js';

/**
 * Build the speed legend and make it draggable.
 * Uses Pointer Events so it works with both mouse and touch, and keeps the
 * whole drag in viewport coordinates relative to its offset parent (#main).
 */
let legendEl = null;
let onModeChange = () => {};
/** Told when the user switches what the colours mean. */
export function setColorModeHandler(fn) { onModeChange = fn; }

/** Rebuild the legend rows for the current colour mode. */
export function renderLegend() {
  if (!legendEl) return;
  const body = legendEl.querySelector('.legend-body');
  const sail = state.colorMode === 'sail';

  const rows = sail
    ? [
        ...POINTS_OF_SAIL.map(p => [p.color, p.name]),
        [UNKNOWN_COLOR, 'No wind data'],
      ]
    : SPEED_LABELS.map((lbl, i) => [SPEED_COLORS[i], `${lbl} kts`]);

  body.replaceChildren(...rows.map(([color, label]) => el('div', { class: 'legend-row' }, [
    el('div', { class: 'legend-swatch', style: `background:${color}` }),
    el('span', { text: label }),
  ])));

  legendEl.querySelector('.legend-title').textContent = sail ? 'Point of sail' : 'Speed (knots)';
  for (const b of legendEl.querySelectorAll('.legend-mode button')) {
    b.classList.toggle('active', (b.dataset.mode === 'sail') === sail);
  }
}

/**
 * Add the colour-mode toggle. Separate from initLegend because wind arrives
 * later in boot, and initLegend has to run early enough for its preferences to
 * be registered before loadPrefs applies them.
 */
export function enableColorModes() {
  if (!legendEl || legendEl.querySelector('.legend-mode')) return;

  const toggle = el('div', { class: 'legend-mode' }, [
    el('button', { 'data-mode': 'speed', text: 'Speed', title: 'Colour tracks by boat speed' }),
    el('button', { 'data-mode': 'sail',  text: 'Sail',  title: 'Colour tracks by point of sail' }),
  ]);

  toggle.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.mode === state.colorMode) return;
    e.stopPropagation();
    state.colorMode = btn.dataset.mode;
    renderLegend();
    savePrefs();
    onModeChange();
  });
  // A pointerdown on the buttons would otherwise start dragging the legend.
  toggle.addEventListener('pointerdown', e => e.stopPropagation());

  legendEl.appendChild(toggle);
  renderLegend();
}

/** Without wind there is nothing to colour by, so fall back to speed. */
export function disableColorModes() {
  state.colorMode = 'speed';
  renderLegend();
}

export function initLegend() {
  const legend = el('div', { id: 'speed-legend' }, [
    el('div', { class: 'legend-title', text: 'Speed (knots)' }),
    el('div', { class: 'legend-body' }),
  ]);

  legendEl = legend;

  const main = $('#main');
  main.appendChild(legend);

  let dragOffsetX = 0, dragOffsetY = 0, pointerId = null;

  legend.addEventListener('pointerdown', e => {
    pointerId = e.pointerId;
    legend.setPointerCapture(pointerId);

    // Measure both boxes in viewport space so the two coordinate systems agree.
    const legendBox = legend.getBoundingClientRect();
    dragOffsetX = e.clientX - legendBox.left;
    dragOffsetY = e.clientY - legendBox.top;

    legend.classList.add('dragging');
    legend.style.right  = 'auto';
    legend.style.bottom = 'auto';
    e.preventDefault();
  });

  legend.addEventListener('pointermove', e => {
    if (pointerId === null || e.pointerId !== pointerId) return;
    const parentBox = main.getBoundingClientRect();
    legend.style.left = (e.clientX - dragOffsetX - parentBox.left) + 'px';
    legend.style.top  = (e.clientY - dragOffsetY - parentBox.top)  + 'px';
  });

  const endDrag = e => {
    if (pointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== pointerId) return;
    if (legend.hasPointerCapture(pointerId)) legend.releasePointerCapture(pointerId);
    pointerId = null;
    legend.classList.remove('dragging');
    savePrefs();
  };

  legend.addEventListener('pointerup', endDrag);
  legend.addEventListener('pointercancel', endDrag);

  registerPref('colorMode', {
    get: () => state.colorMode,
    set: v => { if (v === 'sail' || v === 'speed') state.colorMode = v; },
  });

  renderLegend();

  registerPref('legendPos', {
    get: () => (legend.style.left ? { left: legend.style.left, top: legend.style.top } : null),
    set: v => {
      if (!v || !v.left) return;
      legend.style.right  = 'auto';
      legend.style.bottom = 'auto';
      legend.style.left   = v.left;
      legend.style.top    = v.top;
    },
  });

  return legend;
}
