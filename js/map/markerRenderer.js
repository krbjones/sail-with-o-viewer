import { markerLayer } from './mapSetup.js';
import { state } from '../core/store.js';
import { speedBucket } from '../core/geo.js';
import { interpolate } from '../data/trackModel.js';
import {
  SPEED_COLORS,
  TRACK_ACTIVE_OPACITY, TRACK_ACTIVE_WEIGHT,
  TRACK_DIM_OPACITY,    TRACK_DIM_WEIGHT,
} from '../config.js';

/** Called with (trackId, isActive) whenever a track crosses the animation cursor. */
let onActiveChange = () => {};
export function setActiveChangeHandler(fn) { onActiveChange = fn; }

function markerIconHtml(speedText, color, bearing) {
  return `
    <div class="speed-callout-wrap">
      <div class="speed-callout">
        <span>${speedText}</span>
        <span class="kts-label"> kts</span>
      </div>
      <div class="speed-callout-stem"></div>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="-11 -18 22 36" width="22" height="36"
           style="transform:rotate(${bearing.toFixed(1)}deg);transform-origin:50% 50%;
                  display:block;margin:0 auto;overflow:visible;
                  filter:drop-shadow(0 1px 3px rgba(0,0,0,0.85))">
        <!-- Hull: bow at top (-y), stern at bottom (+y) -->
        <path d="M0,-17 C7,-10 8,0 7,10 Q0,16 -7,10 C-8,0 -7,-10 0,-17Z"
              fill="${color}" stroke="white" stroke-width="1.3" stroke-linejoin="round"/>
        <!-- Mast -->
        <circle cx="0" cy="-4" r="1.8" fill="white" opacity="0.95"/>
        <!-- Mainsail (starboard) -->
        <path d="M0,-4 L8,9 L0,9Z" fill="white" fill-opacity="0.55"/>
        <!-- Jib (port) -->
        <path d="M0,-4 L-6,4 L0,1Z" fill="white" fill-opacity="0.38"/>
      </svg>
    </div>`;
}

/**
 * Reposition the animated boat markers and restyle tracks that have just
 * entered or left the animation window.
 */
export function updateMarkers() {
  markerLayer.clearLayers();

  for (const track of state.visibleTracks) {
    if (!track.shown) continue;

    const isActive = state.animTime >= track.startTime && state.animTime <= track.endTime;

    if (track._activeState !== isActive) {
      track._activeState = isActive;
      for (const pl of track.polylines) {
        pl.setStyle({
          opacity: isActive ? TRACK_ACTIVE_OPACITY : TRACK_DIM_OPACITY,
          weight:  isActive ? TRACK_ACTIVE_WEIGHT  : TRACK_DIM_WEIGHT,
        });
      }
      onActiveChange(track.id, isActive);
    }

    if (!isActive) continue;

    const pos   = interpolate(track, state.animTime);
    const color = SPEED_COLORS[speedBucket(pos.speed)];

    const icon = L.divIcon({
      className: '',
      iconSize:  [70, 78],
      iconAnchor: [35, 60],
      html: markerIconHtml(pos.speed.toFixed(1), color, pos.bearing),
    });

    L.marker([pos.lat, pos.lon], { icon, zIndexOffset: 1000 }).addTo(markerLayer);
  }
}

/** Forget cached active-state so the next updateMarkers() restyles everything. */
export function resetActiveState() {
  for (const track of state.tracks) track._activeState = undefined;
}
