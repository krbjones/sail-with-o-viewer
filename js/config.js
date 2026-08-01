// ── Speed colour scale ────────────────────────────────────────────
export const SPEED_THRESHOLDS = [0.5, 2, 4, 6, 8];   // knots
export const SPEED_COLORS     = ['#FF0000', '#FFF000', '#00FF00', '#00FFFF', '#0000FF', '#191970'];
export const SPEED_LABELS     = ['< 0.5', '0.5 – 2', '2 – 4', '4 – 6', '6 – 8', '8+'];

// ── Data sources ──────────────────────────────────────────────────
export const MANIFEST_URL = 'tracks.json';
export const DATA_DIR     = 'data';
export const CHART_URL    = 'lac_deschennes_chart_1550_cog.tif';

// ── Map defaults ──────────────────────────────────────────────────
export const DEFAULT_CENTER = [45.4, -75.7];
export const DEFAULT_ZOOM   = 10;

// ── Track styling ─────────────────────────────────────────────────
export const TRACK_WEIGHT          = 2.5;
export const TRACK_OPACITY         = 0.75;
export const TRACK_ACTIVE_WEIGHT   = 3;
export const TRACK_ACTIVE_OPACITY  = 0.9;
export const TRACK_DIM_WEIGHT      = 2;
export const TRACK_DIM_OPACITY     = 0.25;

// ── Animation ─────────────────────────────────────────────────────
export const DEFAULT_ANIM_SPEED = 300000;  // ms of track-time per second of real-time
export const STEP_MS            = 60000;   // step forward/back increment
export const SLIDER_STEPS       = 10000;

// ── Timing ────────────────────────────────────────────────────────
export const VIEW_DEBOUNCE_MS   = 150;
export const CHART_INJECT_DELAY = 80;
/** How often the clock and slider are repainted during playback (markers run every frame). */
export const UI_REFRESH_MS      = 100;
