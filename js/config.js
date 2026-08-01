// ── Speed colour scale ────────────────────────────────────────────
export const SPEED_THRESHOLDS = [0.5, 2, 4, 6, 8];   // knots
export const SPEED_COLORS     = ['#FF0000', '#FFF000', '#00FF00', '#00FFFF', '#0000FF', '#191970'];
export const SPEED_LABELS     = ['< 0.5', '0.5 – 2', '2 – 4', '4 – 6', '6 – 8', '8+'];
/** Used where a point has no wind or heading to classify by. */
export const UNKNOWN_COLOR    = '#45475a';

// ── Data sources ──────────────────────────────────────────────────
export const MANIFEST_URL = 'tracks.json';
export const DATA_DIR     = 'data';
export const CHART_URL    = 'lac_deschennes_chart_1550_cog.tif';
export const WIND_URL      = 'data/wind.json';
export const WIND_GRID_URL = 'data/wind-grid.bin';

// ── Wind ──────────────────────────────────────────────────────────
/** Wind is hourly; refuse to interpolate across a gap wider than this. */
export const MAX_WIND_GAP_MS = 2 * 3600000;
/** Below this the boat is not under way, so it has no meaningful heading. */
export const MOVING_MIN_KTS  = 0.5;

/** Pane for the particle field: above the tiles (200), below the tracks (400). */
export const WIND_PANE   = 'windPane';
export const WIND_PANE_Z = 350;

// ── Local database ────────────────────────────────────────────────
export const DB_NAME    = 'sailwitho';
/** v2 stores points as typed arrays rather than nested [lat,lon,t,spd] arrays. */
export const DB_VERSION = 2;
/** Give up opening the database after this and run without a cache. */
export const DB_OPEN_TIMEOUT_MS = 4000;

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
