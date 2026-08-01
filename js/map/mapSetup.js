import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../config.js';

export const map = L.map('map', { zoomControl: true }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

// Custom pane so the chart always renders above track polylines (overlayPane z=400)
map.createPane('chartPane');
map.getPane('chartPane').style.zIndex = 450;

export const trackLayer  = L.layerGroup().addTo(map);
export const markerLayer = L.layerGroup().addTo(map);

// Leaflet caches the container size at construction time. If the map is laid
// out later (hidden tab, deferred module, responsive drawer opening) that cache
// is a stale 0x0 and every fitBounds resolves to a degenerate point at max zoom.
const container = map.getContainer();
new ResizeObserver(() => map.invalidateSize({ animate: false })).observe(container);
map.invalidateSize({ animate: false });
