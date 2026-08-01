import { $, el } from '../core/dom.js';
import { state } from '../core/store.js';
import { fmtDuration, fmtDateTime, fmtTime } from '../core/format.js';
import { speedBucket } from '../core/geo.js';
import { SPEED_COLORS, SPEED_LABELS } from '../config.js';

/** Sparkline resolution — more columns than this is invisible at sidebar width. */
const SPARK_COLS = 180;
const SPARK_W = 260, SPARK_H = 54;
const HIST_W  = 260, HIST_H  = 68;

let onSeek  = () => {};
let onClose = () => {};
/** Let the panel drive the animation cursor when the sparkline is scrubbed. */
export function setSeekHandler(fn)  { onSeek = fn; }
/** Who to tell when the user dismisses the panel. */
export function setCloseHandler(fn) { onClose = fn; }

/**
 * Time spent in each speed bucket, and a downsampled speed envelope.
 * Cached on the track — this walks every point, and selection can be rapid.
 */
function analyse(track) {
  if (track._analysis) return track._analysis;

  const { times, speeds, n } = track;
  const bucketMs = new Array(SPEED_COLORS.length).fill(0);

  for (let i = 1; i < n; i++) {
    const dt = times[i] - times[i - 1];
    // Skip bridged gaps in the log; they are not time under way.
    if (dt <= 0 || dt > 60000) continue;
    bucketMs[speedBucket(speeds[i])] += dt;
  }

  // Per-column max and mean over the track's index range
  const cols = Math.min(SPARK_COLS, n);
  const peak = new Float32Array(cols);
  const mean = new Float32Array(cols);

  for (let c = 0; c < cols; c++) {
    const lo = Math.floor(c * n / cols);
    const hi = Math.max(lo + 1, Math.floor((c + 1) * n / cols));
    let mx = 0, sum = 0;
    for (let i = lo; i < hi; i++) { if (speeds[i] > mx) mx = speeds[i]; sum += speeds[i]; }
    peak[c] = mx;
    mean[c] = sum / (hi - lo);
  }

  track._analysis = { bucketMs, peak, mean, cols };
  return track._analysis;
}

function histogramSVG(bucketMs) {
  const total = bucketMs.reduce((a, b) => a + b, 0);
  if (!total) return '<div class="stats-empty">No time under way.</div>';

  const max     = Math.max(...bucketMs);
  const barW    = HIST_W / bucketMs.length;
  const padding = 3;

  const bars = bucketMs.map((ms, i) => {
    const h = max ? (ms / max) * (HIST_H - 16) : 0;
    const x = i * barW + padding / 2;
    const y = HIST_H - 14 - h;
    const pct = Math.round(ms / total * 100);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - padding).toFixed(1)}" height="${h.toFixed(1)}"
                  fill="${SPEED_COLORS[i]}" rx="1"><title>${SPEED_LABELS[i]} kts — ${fmtDuration(ms)} (${pct}%)</title></rect>
            <text x="${(x + (barW - padding) / 2).toFixed(1)}" y="${HIST_H - 3}" class="hist-label">${SPEED_LABELS[i]}</text>`;
  }).join('');

  return `<svg viewBox="0 0 ${HIST_W} ${HIST_H}" class="stats-chart" role="img"
               aria-label="Time spent in each speed band">${bars}</svg>`;
}

function sparklineSVG(track, analysis) {
  const { peak, mean, cols } = analysis;
  const max = Math.max(track.maxSpeed, 0.1);
  const y = v => SPARK_H - (v / max) * (SPARK_H - 2) - 1;
  const x = c => (c / (cols - 1)) * SPARK_W;

  let area = `M0,${SPARK_H} `;
  for (let c = 0; c < cols; c++) area += `L${x(c).toFixed(1)},${y(peak[c]).toFixed(1)} `;
  area += `L${SPARK_W},${SPARK_H} Z`;

  let line = '';
  for (let c = 0; c < cols; c++) line += `${c ? 'L' : 'M'}${x(c).toFixed(1)},${y(mean[c]).toFixed(1)} `;

  return `
    <svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" class="stats-chart spark" id="stats-spark" role="img"
         aria-label="Speed over the length of the track">
      <path d="${area}" class="spark-area"/>
      <path d="${line}" class="spark-line"/>
      <line id="spark-cursor" x1="0" y1="0" x2="0" y2="${SPARK_H}" class="spark-cursor"/>
    </svg>`;
}

function stat(label, value) {
  return `<div class="stat"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`;
}

/** Move the sparkline cursor to the current animation time. */
export function updateStatsCursor() {
  const track = state.selectedTrack;
  const line  = $('#spark-cursor');
  if (!track || !line) return;

  const f = (state.animTime - track.startTime) / Math.max(1, track.duration);
  const x = Math.max(0, Math.min(1, f)) * SPARK_W;
  line.setAttribute('x1', x.toFixed(1));
  line.setAttribute('x2', x.toFixed(1));
}

/** Render (or hide) the panel for the current selection. */
export function renderStats() {
  const panel = $('#stats-panel');
  const track = state.selectedTrack;

  if (!track) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  const a = analyse(track);

  $('#stats-title').textContent = `${fmtDateTime(track.startTime)} · ${fmtTime(track.startTime)}`;

  // "Under way" is time above the moving threshold, so it is always less than
  // duration — the histogram below includes the stopped band as well.
  $('#stats-grid').innerHTML =
    stat('Distance',  track.distance ? track.distance.toFixed(2) + ' <small>nm</small>' : '—') +
    stat('Duration',  fmtDuration(track.duration)) +
    stat('Under way', track.movingMs ? fmtDuration(track.movingMs) : '—') +
    stat('Avg speed', track.avgSpeed ? track.avgSpeed.toFixed(1) + ' <small>kts</small>' : '—') +
    stat('Max speed', track.maxSpeed.toFixed(1) + ' <small>kts</small>') +
    stat('Points',    track.n.toLocaleString());

  $('#stats-charts').innerHTML =
    `<div class="chart-title">Speed over time</div>${sparklineSVG(track, a)}` +
    `<div class="chart-title">Time in each speed band</div>${histogramSVG(a.bucketMs)}`;

  // Click or drag along the sparkline to scrub the animation
  const spark = $('#stats-spark');
  const seekFromEvent = e => {
    const r = spark.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    onSeek(track.startTime + f * track.duration);
  };
  spark.addEventListener('pointerdown', e => {
    spark.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  spark.addEventListener('pointermove', e => {
    if (spark.hasPointerCapture(e.pointerId)) seekFromEvent(e);
  });

  updateStatsCursor();
}

export function initStatsPanel() {
  $('#stats-close').onclick = () => onClose();
}
