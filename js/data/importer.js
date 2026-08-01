import { state } from '../core/store.js';
import { trackFromJSON, toCacheRecord } from './trackModel.js';
import { writeLocalTrack, deleteTrack } from './db.js';
import { parseGPX } from './gpxParser.js';

let worker = null;
/** Once the worker has failed we stop retrying it and parse inline instead. */
let workerUnavailable = false;
let nextJobId = 1;
const pending = new Map();

function failPendingJobs() {
  for (const job of pending.values()) job.resolve({ ok: false, retryWithDom: true });
  pending.clear();
}

/** Spin up the parsing worker on first use; null if workers are unavailable. */
function getWorker() {
  if (worker) return worker;
  if (workerUnavailable) return null;

  try {
    worker = new Worker(new URL('./gpxWorker.js', import.meta.url), { type: 'module' });

    worker.onmessage = ({ data }) => {
      const job = pending.get(data.id);
      if (!job) return;
      pending.delete(data.id);
      job.resolve(data);
    };

    worker.onerror = e => {
      console.warn('GPX worker failed; parsing on the main thread instead:', e.message);
      workerUnavailable = true;
      worker = null;
      failPendingJobs();
    };
  } catch (e) {
    console.warn('Web Workers unavailable; parsing on the main thread:', e);
    workerUnavailable = true;
    worker = null;
  }

  return worker;
}

function parseInWorker(name, text) {
  const w = getWorker();
  if (!w) return Promise.resolve({ ok: false, retryWithDom: true });

  const id = nextJobId++;
  return new Promise(resolve => {
    pending.set(id, { resolve });
    w.postMessage({ id, name, text });
  });
}

/**
 * Parse one GPX file into a compact record.
 * Tries the worker first, then falls back to DOMParser on the main thread.
 */
export async function parseFile(file) {
  const text = await file.text();

  const fromWorker = await parseInWorker(file.name, text);
  if (fromWorker.ok) return fromWorker.record;

  if (fromWorker.retryWithDom) {
    const record = parseGPX(text, file.name);
    if (record) return record;
  }

  throw new Error(fromWorker.error || 'Could not read any track points from this file.');
}

/** True if a track with this id is already loaded (imported or from a bundle). */
export function isDuplicate(id) {
  return state.loadedFiles.has(id);
}

/**
 * Store a parsed record as a local track and add it to the in-memory set.
 * Replaces any existing track with the same id.
 */
export async function importRecord(record) {
  const track = trackFromJSON(record);
  track.source = 'local';

  await writeLocalTrack({ ...toCacheRecord(track, record.month, 'local') });

  const existing = state.tracks.findIndex(t => t.id === track.id);
  if (existing >= 0) state.tracks[existing] = track;
  else state.tracks.push(track);

  state.loadedFiles.add(track.id);
  state.allTrackMeta = state.allTrackMeta.filter(m => m.file !== track.id);
  state.allTrackMeta.push({
    file: track.id, startMs: track.startTime, endMs: track.endTime,
    month: record.month, bbox: record.bbox,
    dist: record.dist, maxSpd: record.maxSpd, avgSpd: record.avgSpd,
    movingMs: record.movingMs, n: record.pts.length, source: 'local',
  });

  state.tracks.sort((a, b) => a.startTime - b.startTime);
  state.allTrackMeta.sort((a, b) => a.startMs - b.startMs);

  return track;
}

/** Remove an imported track from storage and memory. */
export async function removeLocalTrack(id) {
  await deleteTrack(id);
  state.tracks       = state.tracks.filter(t => t.id !== id);
  state.visibleTracks = state.visibleTracks.filter(t => t.id !== id);
  state.allTrackMeta = state.allTrackMeta.filter(m => m.file !== id);
  state.loadedFiles.delete(id);
}
