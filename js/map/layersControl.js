import { map } from './mapSetup.js';
import { BASEMAPS, DEFAULT_BASEMAP, overlayNautical, overlayOceanRef } from './basemaps.js';
import { chartOverlayGroup, injectChartControls, wireChartLazyLoad } from './chartLayer.js';

let layersControl = null;

export function buildLayersControl() {
  if (layersControl) layersControl.remove();

  const overlays = {
    'Nautical marks':          overlayNautical,
    'Ocean labels':            overlayOceanRef,
    '📄 Lac Deschênes Chart':  chartOverlayGroup,
  };

  layersControl = L.control.layers(BASEMAPS, overlays, { position: 'topright', collapsed: true }).addTo(map);

  // The panel list exists even while collapsed, but re-inject on interaction in
  // case the control was rebuilt after the chart had already loaded.
  layersControl.getContainer().addEventListener('click', injectChartControls);

  injectChartControls();
  return layersControl;
}

export function initLayers() {
  DEFAULT_BASEMAP.addTo(map);
  overlayNautical.addTo(map);
  wireChartLazyLoad();
  buildLayersControl();
}
