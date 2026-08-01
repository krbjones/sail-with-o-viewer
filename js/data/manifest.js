import { MANIFEST_URL } from '../config.js';

/**
 * Fetch the track index.
 *
 * Accepts either a bare array (the shape before build_tracks.py grew a
 * manifest envelope) or {buildStamp, months, tracks}. Without a `months` map
 * there are no content hashes to validate a cached bundle against, so caching
 * simply stays off rather than risking stale data.
 */
export async function fetchManifest() {
  const r = await fetch(MANIFEST_URL);
  if (!r.ok) throw new Error('HTTP ' + r.status);

  const json = await r.json();
  if (Array.isArray(json)) return { buildStamp: 'legacy', months: null, tracks: json };

  return {
    buildStamp: json.buildStamp ?? 'legacy',
    months:     json.months ?? null,
    tracks:     json.tracks ?? [],
  };
}
