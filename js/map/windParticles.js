import { state } from '../core/store.js';
import { windUVAt, windGridLoaded } from '../data/wind.js';
import { WIND_PANE, WIND_PANE_Z } from '../config.js';

/**
 * Windy-style particle flow over the wind grid.
 *
 * Particles are advected through a velocity field sampled into screen space
 * once per view change, rather than per particle per frame — sampling the grid
 * thousands of times a frame would be the whole cost of the layer.
 *
 * Sits in its own pane below the track lines, so the boat is never hidden
 * behind the weather.
 */

/** Lattice spacing in pixels. Finer than the ~2.5 km grid can justify anyway. */
const FIELD_STEP = 12;

/**
 * Screen pixels per knot per frame.
 *
 * Deliberately not physical: at zoom 12 a pixel is roughly 40 m, so 10 kt of
 * real wind would crawl at an eighth of a pixel per second and read as static.
 * The flow shows direction and relative strength, not ground speed. Being
 * zoom-independent also keeps the animation looking the same as you zoom.
 */
const PX_PER_KNOT = 0.13;

const MAX_AGE        = 90;    // frames before a particle is recycled
const TRAIL_FADE     = 0.90;  // alpha retained each frame; lower = shorter tails
const PARTICLES_WIDE = 5200;  // desktop
const PARTICLES_NARROW = 1400;

/** Track-time movement that justifies resampling the field. */
const FIELD_REFRESH_MS = 90000;

/**
 * Speed bands. Particles are drawn one path per band rather than one path per
 * particle: a stroke() call each was the whole frame budget at 5,000 particles.
 */
const SPEED_BANDS = [
  { max: 6,        colour: 'rgba(160,200,255,0.55)' },
  { max: 12,       colour: 'rgba(190,235,255,0.70)' },
  { max: 18,       colour: 'rgba(215,255,235,0.80)' },
  { max: 25,       colour: 'rgba(255,240,190,0.85)' },
  { max: Infinity, colour: 'rgba(255,200,180,0.90)' },
];

function bandOf(speed) {
  for (let i = 0; i < SPEED_BANDS.length; i++) {
    if (speed < SPEED_BANDS[i].max) return i;
  }
  return SPEED_BANDS.length - 1;
}

export const WindParticleLayer = L.Layer.extend({

  onAdd(map) {
    this._map = map;

    this._canvas = L.DomUtil.create('canvas', 'wind-particles');
    this._ctx    = this._canvas.getContext('2d');
    map.getPane(WIND_PANE).appendChild(this._canvas);

    this._onViewChange = () => this._reset();
    this._onMoveStart  = () => this._pause();
    this._onMoveEnd    = () => { this._reset(); this._resume(); };

    map.on('zoomstart movestart', this._onMoveStart, this);
    map.on('moveend zoomend resize', this._onMoveEnd, this);

    // A hidden tab should not burn frames; the browser throttles rAF but does
    // not always stop it, and there is nothing to see either way.
    this._onVisibility = () => (document.hidden ? this._pause() : this._resume());
    document.addEventListener('visibilitychange', this._onVisibility);

    this._reset();
    this._resume();
    return this;
  },

  onRemove(map) {
    this._pause();
    map.off('zoomstart movestart', this._onMoveStart, this);
    map.off('moveend zoomend resize', this._onMoveEnd, this);
    document.removeEventListener('visibilitychange', this._onVisibility);
    if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
    this._canvas = this._ctx = this._field = this._particles = null;
    return this;
  },

  // ── Field ───────────────────────────────────────────────────────

  /** Resize the canvas, pin it to the pane, and resample the velocity field. */
  _reset() {
    if (!this._map || !this._canvas) return;

    const size = this._map.getSize();
    if (size.x === 0 || size.y === 0) return;

    this._canvas.width  = size.x;
    this._canvas.height = size.y;
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));

    this._sampleField();
    this._seedParticles();
  },

  /**
   * Sample the wind onto a coarse screen lattice. Everything downstream reads
   * from this, so a frame never touches the grid or the projection.
   */
  _sampleField() {
    const map  = this._map;
    const size = map.getSize();

    const cols = Math.ceil(size.x / FIELD_STEP) + 1;
    const rows = Math.ceil(size.y / FIELD_STEP) + 1;
    const u = new Float32Array(cols * rows);
    const v = new Float32Array(cols * rows);
    const ok = new Uint8Array(cols * rows);

    const t = state.animTime;
    let covered = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ll = map.containerPointToLatLng([c * FIELD_STEP, r * FIELD_STEP]);
        const uv = windUVAt(ll.lat, ll.lng, t);
        const i  = r * cols + c;
        if (uv) { u[i] = uv[0]; v[i] = uv[1]; ok[i] = 1; covered++; }
      }
    }

    this._field = { cols, rows, u, v, ok, covered };
    this._fieldTime = t;
  },

  /** Nearest lattice node. The lattice is finer than the data, so nearest is honest. */
  _lookup(x, y) {
    const f = this._field;
    if (!f) return null;
    const c = Math.round(x / FIELD_STEP);
    const r = Math.round(y / FIELD_STEP);
    if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return null;
    const i = r * f.cols + c;
    return f.ok[i] ? [f.u[i], f.v[i]] : null;
  },

  // ── Particles ───────────────────────────────────────────────────

  _count() {
    return window.innerWidth <= 820 ? PARTICLES_NARROW : PARTICLES_WIDE;
  },

  _seedParticles() {
    const n = this._count();
    this._particles = new Array(n);
    for (let i = 0; i < n; i++) this._particles[i] = this._spawn({});
    // Reused every frame so the draw loop allocates nothing.
    this._bands = SPEED_BANDS.map(() => []);
  },

  _spawn(p) {
    const size = this._map.getSize();
    p.x   = Math.random() * size.x;
    p.y   = Math.random() * size.y;
    p.age = Math.floor(Math.random() * MAX_AGE);
    return p;
  },

  // ── Animation ───────────────────────────────────────────────────

  _resume() {
    if (this._raf || !this._map || document.hidden) return;
    this._raf = requestAnimationFrame(() => this._frame());
  },

  _pause() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  },

  _frame() {
    this._raf = null;
    if (!this._ctx || !this._field) return;

    // Follow the playback clock: when the cursor has moved far enough for the
    // wind to have changed, resample. This is what makes shifts visible.
    if (Math.abs(state.animTime - this._fieldTime) > FIELD_REFRESH_MS) this._sampleField();

    const ctx = this._ctx;
    const { width, height } = this._canvas;

    // Fade what is already drawn instead of clearing, which is what leaves
    // tails. destination-in scales existing alpha and keeps the canvas
    // transparent, so the map still shows through.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${TRAIL_FADE})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    if (this._field.covered) {
      ctx.lineWidth = 1.2;
      ctx.lineCap = 'round';

      // Collect this frame's segments per speed band, then stroke each band
      // once. Stroking per particle costs about 29 ms a frame at this count;
      // batched it is a small fraction of that.
      const bands = this._bands;
      for (const b of bands) b.length = 0;

      for (const p of this._particles) {
        const uv = this._lookup(p.x, p.y);

        if (!uv || p.age++ > MAX_AGE) { this._spawn(p); continue; }

        // Web Mercator away from the poles: north is up, east is right, so the
        // components map straight onto screen axes with y inverted.
        const nx = p.x + uv[0] * PX_PER_KNOT;
        const ny = p.y - uv[1] * PX_PER_KNOT;

        if (nx < 0 || ny < 0 || nx > width || ny > height) { this._spawn(p); continue; }

        const seg = bands[bandOf(Math.hypot(uv[0], uv[1]))];
        seg.push(p.x, p.y, nx, ny);

        p.x = nx;
        p.y = ny;
      }

      for (let i = 0; i < bands.length; i++) {
        const seg = bands[i];
        if (!seg.length) continue;
        ctx.strokeStyle = SPEED_BANDS[i].colour;
        ctx.beginPath();
        for (let k = 0; k < seg.length; k += 4) {
          ctx.moveTo(seg[k], seg[k + 1]);
          ctx.lineTo(seg[k + 2], seg[k + 3]);
        }
        ctx.stroke();
      }
    }

    this._raf = requestAnimationFrame(() => this._frame());
  },
});

/**
 * The layer, or null when there is no grid to animate. Returning null lets the
 * caller leave it out of the layers control entirely rather than offering a
 * control that does nothing.
 */
export function createWindParticleLayer(map) {
  if (!windGridLoaded()) return null;

  // Reduced motion is a request not to animate; a static field would be a
  // misleading still, so the layer simply is not offered.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;

  if (!map.getPane(WIND_PANE)) {
    map.createPane(WIND_PANE);
    map.getPane(WIND_PANE).style.zIndex = WIND_PANE_Z;
    map.getPane(WIND_PANE).style.pointerEvents = 'none';
  }

  return new WindParticleLayer();
}
