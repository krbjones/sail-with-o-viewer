import { $ } from '../core/dom.js';
import { state } from '../core/store.js';
import { cachedMonths, clearRemoteCache, storageEstimate } from '../data/db.js';
import { resetCacheIndex, cacheStats } from '../data/trackLoader.js';

const fmtMB = bytes => bytes >= 1024 ** 3
  ? (bytes / 1024 ** 3).toFixed(1) + ' GB'
  : Math.round(bytes / 1024 ** 2) + ' MB';

/** Refresh the "cached offline" line under the filter controls. */
export async function refreshStorageInfo() {
  const line = $('#storage-info');
  const btn  = $('#btn-clear-cache');
  if (!line) return;

  const months = await cachedMonths();
  const n      = Object.keys(months).length;
  const total  = state.manifestMonths ? Object.keys(state.manifestMonths).length : 0;

  if (!n) {
    line.textContent = 'Nothing cached yet.';
    btn.classList.add('hidden');
    return;
  }

  const est  = await storageEstimate();
  const size = est && est.usage ? ` · ${fmtMB(est.usage)}` : '';
  const hits = cacheStats.hits ? ` · ${cacheStats.hits} served from cache` : '';

  line.textContent = `${n}${total ? ' of ' + total : ''} month${n !== 1 ? 's' : ''} cached${size}${hits}`;
  btn.classList.remove('hidden');
}

export function initStoragePanel() {
  $('#btn-clear-cache').onclick = async () => {
    await clearRemoteCache();
    resetCacheIndex();
    await refreshStorageInfo();
    // Tracks already in memory stay; the cache just repopulates on the next load.
  };

  refreshStorageInfo();
}
