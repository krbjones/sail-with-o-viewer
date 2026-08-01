import { scanTrackPoints } from './gpxScan.js';
import { buildRecord } from './trackStats.js';

/**
 * Parses GPX off the main thread. The largest file in this archive is 6.4 MB;
 * parsing that inline visibly freezes the UI mid-drop.
 *
 * in:  {id, name, text}
 * out: {id, ok: true, record} | {id, ok: false, error}
 */
self.onmessage = ({ data: { id, name, text } }) => {
  try {
    const raw = scanTrackPoints(text);

    if (raw.length < 2) {
      self.postMessage({ id, ok: false, error: 'No timestamped track points found.', retryWithDom: true });
      return;
    }

    const record = buildRecord(raw, name);
    if (!record) {
      self.postMessage({ id, ok: false, error: 'Not enough usable track points.' });
      return;
    }

    self.postMessage({ id, ok: true, record });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e.message, retryWithDom: true });
  }
};
