/**
 * DOM-free GPX track-point scanner.
 *
 * DOMParser does not exist in a Web Worker, and parsing a multi-megabyte GPX on
 * the main thread freezes the UI for a noticeable beat. This walks the text
 * directly with indexOf, which is fast and has no backtracking risk.
 *
 * It understands the regular, machine-generated GPX these loggers produce.
 * Callers should fall back to the DOMParser path in js/data/gpxParser.js if
 * this returns too few points.
 */

/** Value of an attribute within a tag's text span, or null. */
function attr(text, from, to, name) {
  const at = text.indexOf(name + '=', from);
  if (at === -1 || at > to) return null;

  const q = text[at + name.length + 1];
  if (q !== '"' && q !== "'") return null;

  const start = at + name.length + 2;
  const end   = text.indexOf(q, start);
  if (end === -1 || end > to) return null;

  return text.slice(start, end);
}

/** Parse a GPX timestamp to epoch ms, or NaN. */
function parseTime(raw) {
  let s = raw.trim().replace(' ', 'T');
  // A bare timestamp with no zone is UTC by the GPX spec.
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  return new Date(s).getTime();
}

/**
 * @returns [{time, lat, lon}] in document order, timestamped points only.
 */
export function scanTrackPoints(text) {
  const points = [];
  let i = 0;

  for (;;) {
    const open = text.indexOf('<trkpt', i);
    if (open === -1) break;

    // Guard against matching a longer tag name that merely starts with trkpt.
    const after = text[open + 6];
    if (after && !' \t\r\n/>'.includes(after)) { i = open + 6; continue; }

    const tagEnd = text.indexOf('>', open);
    if (tagEnd === -1) break;

    const lat = parseFloat(attr(text, open, tagEnd, 'lat'));
    const lon = parseFloat(attr(text, open, tagEnd, 'lon'));

    // Self-closing <trkpt .../> carries no time; skip it.
    const close = text.indexOf('</trkpt>', tagEnd);
    if (close === -1) break;

    const timeOpen = text.indexOf('<time>', tagEnd);
    if (timeOpen !== -1 && timeOpen < close) {
      const timeClose = text.indexOf('</time>', timeOpen);
      if (timeClose !== -1 && timeClose < close) {
        const time = parseTime(text.slice(timeOpen + 6, timeClose));
        if (!isNaN(lat) && !isNaN(lon) && !isNaN(time)) points.push({ time, lat, lon });
      }
    }

    i = close + 8;
  }

  return points;
}
