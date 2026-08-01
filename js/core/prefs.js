import { readPrefs, writePrefs } from '../data/db.js';
import { debounce } from './dom.js';

/**
 * Preference registry.
 *
 * Each module registers what it owns rather than a central module reaching into
 * everything, so adding a setting means touching one file. Providers are
 * applied in registration order at boot and saved together, debounced.
 */
const providers = new Map();

export function registerPref(key, { get, set }) {
  providers.set(key, { get, set });
}

/** Apply stored preferences to the UI. Missing keys leave defaults alone. */
export async function loadPrefs() {
  const stored = await readPrefs();

  for (const [key, provider] of providers) {
    if (!(key in stored)) continue;
    try {
      provider.set(stored[key]);
    } catch (e) {
      console.warn(`Ignoring saved preference "${key}":`, e);
    }
  }

  return stored;
}

/** Persist current UI state immediately. */
export async function flushPrefs() {
  const values = {};
  for (const [key, provider] of providers) {
    try { values[key] = provider.get(); }
    catch (e) { console.warn(`Could not read preference "${key}":`, e); }
  }
  await writePrefs(values);
}

/** Persist current UI state. Debounced — safe to call on every input event. */
export const savePrefs = debounce(flushPrefs, 400);
