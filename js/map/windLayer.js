import { el } from '../core/dom.js';
import { map } from './mapSetup.js';
import { state } from '../core/store.js';
import { windLoaded, windForTrack, trueWindAngle, pointOfSail, tackOf, windProvenance } from '../data/wind.js';
import { interpolate } from '../data/trackModel.js';

let panel = null;
let refs  = null;

/**
 * Wind readout for the moment under the animation cursor.
 *
 * The arrow points the way the wind is blowing — downwind — because that is
 * what reads correctly next to a boat on a map. The label says "from" and
 * gives the meteorological bearing, so there is no ambiguity either way.
 */
export function initWindLayer() {
  if (!windLoaded()) return null;

  const arrow = el('div', { class: 'wind-arrow', html: `
    <svg viewBox="-12 -12 24 24" width="34" height="34">
      <path d="M0,-9 L4.5,3 L0,0.6 L-4.5,3 Z" fill="var(--accent)" stroke="none"/>
    </svg>` });

  const speed  = el('span', { class: 'wind-speed', text: '—' });
  const gust   = el('span', { class: 'wind-gust', text: '' });
  const from   = el('div',  { class: 'wind-from', text: '' });
  const sail   = el('div',  { class: 'wind-sail', text: '' });

  panel = el('div', { id: 'wind-panel', title: `${windProvenance()} — a forecast model, not a local observation` }, [
    el('div', { class: 'wind-title', text: 'Wind' }),
    el('div', { class: 'wind-body' }, [
      arrow,
      el('div', { class: 'wind-figures' }, [
        el('div', {}, [speed, gust]),
        from,
      ]),
    ]),
    sail,
  ]);

  // A Leaflet control, not a child of #main. #main holds the sidebar as well as
  // the map, so absolute positioning there put this on top of the filters.
  // Leaflet also keeps clicks and drags on the panel from panning the map.
  const WindControl = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      L.DomEvent.disableClickPropagation(panel);
      L.DomEvent.disableScrollPropagation(panel);
      return panel;
    },
  });
  new WindControl().addTo(map);

  refs = { arrow: arrow.querySelector('svg'), speed, gust, from, sail };
  updateWindPanel();
  return panel;
}

/** Which track's wind to show: the selection, else whichever is under the cursor. */
function referenceTrack() {
  if (state.selectedTrack) return state.selectedTrack;
  for (const t of state.visibleTracks) {
    if (t.shown && state.animTime >= t.startTime && state.animTime <= t.endTime) return t;
  }
  return null;
}

export function updateWindPanel() {
  if (!panel || !refs) return;

  const track = referenceTrack();
  // Sample where the boat actually is, when it is under way.
  const at    = track && state.animTime >= track.startTime && state.animTime <= track.endTime
    ? interpolate(track, state.animTime) : null;
  const wind  = track ? windForTrack(track, state.animTime, at?.lat, at?.lon) : null;

  if (!wind) {
    panel.classList.add('wind-idle');
    refs.speed.textContent = '—';
    refs.gust.textContent  = '';
    refs.from.textContent  = track ? 'no data for this time' : 'no track at this time';
    refs.sail.textContent  = '';
    return;
  }

  panel.classList.remove('wind-idle');
  refs.speed.textContent = wind.speed.toFixed(1);
  refs.gust.textContent  = wind.gust != null ? ` kts · gust ${wind.gust.toFixed(0)}` : ' kts';
  refs.from.textContent  = `from ${Math.round(wind.windFrom)}°`;

  // Arrow points downwind, i.e. 180 from the direction the wind comes from.
  refs.arrow.style.transform = `rotate(${(wind.windFrom + 180) % 360}deg)`;

  // Point of sail needs the boat's heading, so only while a boat is moving.
  if (at) {
    const twa  = trueWindAngle(at.bearing, wind.windFrom);
    const sail = pointOfSail(twa);
    const tack = tackOf(twa);
    refs.sail.textContent = `${sail.name} · ${Math.abs(Math.round(twa))}°${tack ? ' ' + tack : ''}`;
    refs.sail.style.color = sail.color;
  } else {
    refs.sail.textContent = '';
  }
}
