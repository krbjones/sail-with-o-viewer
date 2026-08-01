import { map } from './mapSetup.js';
import { CHART_URL, CHART_INJECT_DELAY } from '../config.js';
import { $, el } from '../core/dom.js';
import { showProgress, setProgress, hideProgress, setStatus, getStatus } from '../ui/progress.js';
import { registerPref, savePrefs } from '../core/prefs.js';

/** Permanent layer group wrapper — always present in the layers control. */
export const chartOverlayGroup = L.layerGroup();

let chartLayer     = null;
let chartGeoRaster = null;
let chartBgMode    = 'white';   // 'white' | 'black' | 'nodata' | 'none'
let chartOpacity   = 1;

const BG_MODES = [
  ['white',  'White background'],
  ['black',  'Black background'],
  ['nodata', 'NoData value only'],
  ['none',   'None (show all)'],
];

/** Per-pixel colour function — reads chartBgMode at render time so redraws pick up changes. */
function chartPixelFn(vals) {
  const n = vals.length;

  // RGBA — honour the alpha channel, then apply the same background keying as RGB
  if (n >= 4) {
    const [r, g, b, a] = vals;
    if (a === 0) return null;
    if (chartBgMode === 'white' && r >= 248 && g >= 248 && b >= 248) return null;
    if (chartBgMode === 'black' && r <=   7 && g <=   7 && b <=   7) return null;
    if (chartBgMode === 'nodata' && chartGeoRaster != null &&
        r === chartGeoRaster.noDataValue &&
        g === chartGeoRaster.noDataValue &&
        b === chartGeoRaster.noDataValue) return null;
    return `rgba(${r},${g},${b},${a / 255})`;
  }

  // RGB
  if (n === 3) {
    const [r, g, b] = vals;
    if (r === null) return null;
    if (chartBgMode === 'white' && r >= 248 && g >= 248 && b >= 248) return null;
    if (chartBgMode === 'black' && r <=   7 && g <=   7 && b <=   7) return null;
    if (chartBgMode === 'nodata' && chartGeoRaster != null &&
        r === chartGeoRaster.noDataValue &&
        g === chartGeoRaster.noDataValue &&
        b === chartGeoRaster.noDataValue) return null;
    return `rgb(${r},${g},${b})`;
  }

  // Single-band grayscale
  const v = vals[0];
  if (v === null) return null;
  if (chartBgMode === 'nodata' && chartGeoRaster && v === chartGeoRaster.noDataValue) return null;
  if (chartBgMode === 'white' && v >= 248) return null;
  if (chartBgMode === 'black' && v <=   7) return null;
  const c = Math.max(0, Math.min(255, v));
  return `rgb(${c},${c},${c})`;
}

/** Inject opacity + transparency controls into the layers panel once the chart exists. */
export function injectChartControls() {
  setTimeout(() => {
    const panel = $('.leaflet-control-layers-list');
    if (!panel || $('#chart-ctrl-wrap')) return;
    if (!chartLayer) return;

    const pct = el('span', { id: 'chart-opacity-pct', text: Math.round(chartOpacity * 100) + '%' });

    const slider = el('input', {
      type: 'range', id: 'chart-opacity-slider',
      min: '0', max: '1', step: '0.05', value: String(chartOpacity),
      oninput: e => {
        e.stopPropagation();
        chartOpacity = parseFloat(e.target.value);
        chartLayer.setOpacity(chartOpacity);
        pct.textContent = Math.round(chartOpacity * 100) + '%';
        savePrefs();
      }
    });

    const bgSelect = el('select', {
      id: 'chart-bg-mode',
      onchange: e => {
        e.stopPropagation();
        chartBgMode = e.target.value;
        if (chartLayer) chartLayer.updateColors();
        savePrefs();
      }
    }, BG_MODES.map(([val, lbl]) => {
      const opt = el('option', { value: val, text: lbl });
      if (val === chartBgMode) opt.selected = true;
      return opt;
    }));

    panel.appendChild(el('div', { id: 'chart-ctrl-wrap' }, [
      el('div', { class: 'chart-ctrl-label' }, [el('span', { text: 'Chart opacity' }), pct]),
      slider,
      el('div', { class: 'chart-ctrl-sublabel', text: 'Transparent background' }),
      bgSelect,
    ]));
  }, CHART_INJECT_DELAY);
}

/** Fetch, parse and mount the bundled GeoTIFF chart. */
export async function loadChartFromUrl(url = CHART_URL) {
  const prevStatus = getStatus();
  setStatus('');
  showProgress('Fetching chart…', 10);

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const filename    = url.split('/').pop();
    const arrayBuffer = await response.arrayBuffer();
    const fileMB      = (arrayBuffer.byteLength / 1024 / 1024).toFixed(1);

    setProgress(60, 'Parsing GeoTIFF…');
    await new Promise(r => setTimeout(r, 0));

    const georaster = await parseGeoraster(arrayBuffer);

    setProgress(85, 'Building layer…');
    await new Promise(r => setTimeout(r, 0));

    if (chartLayer) map.removeLayer(chartLayer);

    chartGeoRaster = georaster;
    const tileRes  = arrayBuffer.byteLength > 30 * 1024 * 1024 ? 128 : 256;

    chartLayer = new GeoRasterLayer({
      georaster,
      opacity: chartOpacity,
      pane: 'chartPane',
      resolution: tileRes,
      pixelValuesToColorFn: chartPixelFn
    });
    chartLayer._filename = filename;
    chartLayer._fileMB   = fileMB;

    chartOverlayGroup.clearLayers();
    chartOverlayGroup.addLayer(chartLayer);

    setProgress(100);
    await new Promise(r => setTimeout(r, 300));
    hideProgress();
    setStatus(prevStatus);

    injectChartControls();

  } catch (err) {
    console.error('Chart load error:', err);
    hideProgress();
    setStatus(prevStatus);
  }
}

/** Lazy-load the chart the first time the user enables its overlay. */
export function wireChartLazyLoad() {
  map.on('overlayadd', e => {
    if (e.layer === chartOverlayGroup && !chartLayer) loadChartFromUrl();
    injectChartControls();
  });
  map.on('overlayremove baselayerchange', () => injectChartControls());

  registerPref('chart', {
    get: () => ({ opacity: chartOpacity, bgMode: chartBgMode }),
    set: v => {
      if (typeof v.opacity === 'number') chartOpacity = v.opacity;
      if (v.bgMode) chartBgMode = v.bgMode;
    },
  });
}
