import { buildRecord } from './trackStats.js';

const GPX_NS = 'http://www.topografix.com/GPX/1/1';

/**
 * DOMParser-based reader — the fallback for files the fast scanner in
 * js/data/gpxScan.js cannot make sense of. Main thread only: DOMParser does
 * not exist in a Web Worker.
 */
function readTrackPoints(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return null;

  let trkpts = Array.from(doc.getElementsByTagNameNS(GPX_NS, 'trkpt'));
  if (!trkpts.length) trkpts = Array.from(doc.getElementsByTagName('trkpt'));
  if (!trkpts.length) return null;

  const raw = [];
  for (const pt of trkpts) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    const tel = pt.getElementsByTagNameNS(GPX_NS, 'time')[0] || pt.getElementsByTagName('time')[0];
    if (!tel) continue;

    const t = new Date(tel.textContent.trim().replace(' ', 'T').replace(/Z?$/, 'Z')).getTime();
    if (!isNaN(lat) && !isNaN(lon) && !isNaN(t)) raw.push({ time: t, lat, lon });
  }

  return raw;
}

/**
 * Parse GPX text into the same compact record build_tracks.py emits.
 * Returns null when the file has fewer than two usable track points.
 */
export function parseGPX(text, filename) {
  const raw = readTrackPoints(text);
  return raw ? buildRecord(raw, filename) : null;
}
