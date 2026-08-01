import { SPEED_COLORS, SPEED_LABELS } from '../config.js';
import { $, el } from '../core/dom.js';

/**
 * Build the speed legend and make it draggable.
 * Uses Pointer Events so it works with both mouse and touch, and keeps the
 * whole drag in viewport coordinates relative to its offset parent (#main).
 */
export function initLegend() {
  const legend = el('div', { id: 'speed-legend' }, [
    el('div', { class: 'legend-title', text: 'Speed (knots)' }),
    ...SPEED_LABELS.map((lbl, i) => el('div', { class: 'legend-row' }, [
      el('div', { class: 'legend-swatch', style: `background:${SPEED_COLORS[i]}` }),
      el('span', { text: `${lbl} kts` }),
    ])),
  ]);

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
  };

  legend.addEventListener('pointerup', endDrag);
  legend.addEventListener('pointercancel', endDrag);

  return legend;
}
