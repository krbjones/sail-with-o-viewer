import { markerLayer } from './mapSetup.js';
import { state } from '../core/store.js';
import { speedBucket } from '../core/geo.js';
import { interpolate } from '../data/trackModel.js';
import { isTrackActive } from './trackRenderer.js';
import { SPEED_COLORS } from '../config.js';

/** trackId → {marker, el, speedEl, svg, hull, speedText, bucket} */
const boats = new Map();

const ICON_HTML = `
  <div class="speed-callout-wrap">
    <div class="speed-callout">
      <span class="speed-value">0.0</span>
      <span class="kts-label"> kts</span>
    </div>
    <div class="speed-callout-stem"></div>
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="-11 -18 22 36" width="22" height="36"
         style="transform-origin:50% 50%;display:block;margin:0 auto;overflow:visible;
                filter:drop-shadow(0 1px 3px rgba(0,0,0,0.85))">
      <!-- Hull: bow at top (-y), stern at bottom (+y) -->
      <path class="boat-hull" d="M0,-17 C7,-10 8,0 7,10 Q0,16 -7,10 C-8,0 -7,-10 0,-17Z"
            fill="#FF0000" stroke="white" stroke-width="1.3" stroke-linejoin="round"/>
      <!-- Mast -->
      <circle cx="0" cy="-4" r="1.8" fill="white" opacity="0.95"/>
      <!-- Mainsail (starboard) -->
      <path d="M0,-4 L8,9 L0,9Z" fill="white" fill-opacity="0.55"/>
      <!-- Jib (port) -->
      <path d="M0,-4 L-6,4 L0,1Z" fill="white" fill-opacity="0.38"/>
    </svg>
  </div>`;

/**
 * One marker per track, created on first use and then reused.
 *
 * The previous version cleared the layer and built a fresh divIcon for every
 * active track on every animation frame — 60 rounds of DOM construction and
 * teardown per second. Markers now stay in the layer and are hidden with CSS,
 * so a frame only writes the coordinates and any values that actually changed.
 */
function boatFor(track) {
  let boat = boats.get(track.id);
  if (boat) return boat;

  const marker = L.marker([0, 0], {
    icon: L.divIcon({ className: '', iconSize: [70, 78], iconAnchor: [35, 60], html: ICON_HTML }),
    zIndexOffset: 1000,
    interactive: false,
  }).addTo(markerLayer);

  const el = marker.getElement();
  boat = {
    marker,
    el,
    speedEl:   el.querySelector('.speed-value'),
    svg:       el.querySelector('svg'),
    hull:      el.querySelector('.boat-hull'),
    speedText: null,
    bucket:    -1,
    visible:   true,
  };
  boats.set(track.id, boat);
  return boat;
}

function setBoatVisible(boat, visible) {
  if (boat.visible === visible) return;
  boat.el.style.display = visible ? '' : 'none';
  boat.visible = visible;
}

/** Drop every marker — used when the filtered set changes. */
export function clearMarkers() {
  markerLayer.clearLayers();
  boats.clear();
}

/** Reposition the animated boat marker for every track under the cursor. */
export function updateMarkers() {
  const t = state.animTime;

  for (const track of state.visibleTracks) {
    if (!isTrackActive(track, t)) {
      const existing = boats.get(track.id);
      if (existing) setBoatVisible(existing, false);
      continue;
    }

    const pos  = interpolate(track, t);
    const boat = boatFor(track);

    boat.marker.setLatLng([pos.lat, pos.lon]);
    setBoatVisible(boat, true);

    const text = pos.speed.toFixed(1);
    if (text !== boat.speedText) {
      boat.speedEl.textContent = text;
      boat.speedText = text;
    }

    const bucket = speedBucket(pos.speed);
    if (bucket !== boat.bucket) {
      boat.hull.setAttribute('fill', SPEED_COLORS[bucket]);
      boat.bucket = bucket;
    }

    boat.svg.style.transform = `rotate(${pos.bearing.toFixed(1)}deg)`;
  }
}
