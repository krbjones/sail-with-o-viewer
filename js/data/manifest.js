import { MANIFEST_URL } from '../config.js';

/**
 * Fetch the track index.
 * Accepts either the current bare array or the future {buildStamp, tracks}
 * envelope, so the app keeps working across a rebuild.
 */
export async function fetchManifest() {
  const r = await fetch(MANIFEST_URL);
  if (!r.ok) throw new Error('HTTP ' + r.status);

  const json = await r.json();
  if (Array.isArray(json)) return { buildStamp: 'legacy', tracks: json };
  return { buildStamp: json.buildStamp ?? 'legacy', tracks: json.tracks ?? [] };
}
