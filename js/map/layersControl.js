import { map } from './mapSetup.js';
import { BASEMAPS, DEFAULT_BASEMAP, overlayNautical, overlayOceanRef } from './basemaps.js';
import { chartOverlayGroup, injectChartControls, wireChartLazyLoad } from './chartLayer.js';
import { registerPref, savePrefs } from '../core/prefs.js';

let layersControl = null;

const OVERLAYS = {
  'Nautical marks':         overlayNautical,
  'Ocean labels':           overlayOceanRef,
  '📄 Lac Deschênes Chart': chartOverlayGroup,
};

/**
 * Add the wind field to the overlays once the grid is known to exist, and
 * rebuild the control so it appears. Registered late because the grid loads
 * after the map is up; leaving it out entirely is the honest outcome when
 * there is no grid, rather than a control that does nothing.
 */
export function addWindOverlay(layer) {
  OVERLAYS['🌬 Wind field'] = layer;
  buildLayersControl();
}

export function buildLayersControl() {
  if (layersControl) layersControl.remove();

  layersControl = L.control.layers(BASEMAPS, OVERLAYS, { position: 'topright', collapsed: true }).addTo(map);

  // The panel list exists even while collapsed, but re-inject on interaction in
  // case the control was rebuilt after the chart had already loaded.
  layersControl.getContainer().addEventListener('click', injectChartControls);

  injectChartControls();
  return layersControl;
}

/** Name of whichever basemap is currently on the map. */
function activeBasemapName() {
  for (const [name, layer] of Object.entries(BASEMAPS)) {
    if (map.hasLayer(layer)) return name;
  }
  return null;
}

export function initLayers() {
  DEFAULT_BASEMAP.addTo(map);
  overlayNautical.addTo(map);
  wireChartLazyLoad();
  buildLayersControl();

  registerPref('layers', {
    get: () => ({
      basemap:  activeBasemapName(),
      overlays: Object.entries(OVERLAYS).filter(([, l]) => map.hasLayer(l)).map(([n]) => n),
    }),
    set: v => {
      if (v.basemap && BASEMAPS[v.basemap]) {
        for (const layer of Object.values(BASEMAPS)) map.removeLayer(layer);
        BASEMAPS[v.basemap].addTo(map);
      }
      if (Array.isArray(v.overlays)) {
        for (const [name, layer] of Object.entries(OVERLAYS)) {
          const want = v.overlays.includes(name);
          if (want && !map.hasLayer(layer))       layer.addTo(map);
          else if (!want && map.hasLayer(layer))  map.removeLayer(layer);
        }
      }
    },
  });

  map.on('baselayerchange overlayadd overlayremove', savePrefs);
}
