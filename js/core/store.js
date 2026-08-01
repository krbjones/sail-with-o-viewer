import { DEFAULT_ANIM_SPEED } from '../config.js';

/**
 * Central mutable app state. Modules import this object and read/write fields
 * directly; there is no change detection yet, callers still invoke the relevant
 * render functions themselves.
 */
export const state = {
  /** Fully hydrated track objects, sorted by startTime. */
  tracks: [],
  /** Subset of `tracks` passing the current date/time filter. */
  visibleTracks: [],
  /** Manifest entries: [{file, startMs, month, bbox}] */
  allTrackMeta: [],
  /** Track ids already hydrated into `tracks`. */
  loadedFiles: new Set(),
  /** Month keys already fetched. */
  loadedMonths: new Set(),

  /** Track whose time range the slider shows; null = full filter range. */
  selectedTrack: null,

  animTime: 0,
  animMin: 0,
  animMax: 0,
  animSpeed: DEFAULT_ANIM_SPEED,

  isPlaying: false,
  lastRealTime: null,
  rafId: null,

  /**
   * performance.now() timestamp until which moveend-driven work is suppressed.
   * Set by programmatic fits, which render the list themselves; a plain boolean
   * would be cleared by `moveend` before the debounced handler ever runs.
   */
  suppressViewUntil: 0,
};
