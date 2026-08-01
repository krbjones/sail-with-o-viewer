import { $, el } from '../core/dom.js';
import { parseFile, importRecord, isDuplicate, removeLocalTrack } from '../data/importer.js';
import { applyFilter, setRange, currentRange } from './filterPanel.js';
import { fmtDateInput } from '../core/format.js';
import { state } from '../core/store.js';

let busy = false;

function setLog(html) { $('#import-log').innerHTML = html; }

function summarise(results) {
  const added   = results.filter(r => r.status === 'added');
  const skipped = results.filter(r => r.status === 'skipped');
  const failed  = results.filter(r => r.status === 'failed');

  const parts = [];
  if (added.length)   parts.push(`<span class="import-ok">${added.length} added</span>`);
  if (skipped.length) parts.push(`<span class="import-skip">${skipped.length} skipped</span>`);
  if (failed.length)  parts.push(`<span class="import-err">${failed.length} failed</span>`);

  const detail = failed.map(f => `<div class="import-detail">${f.name}: ${f.error}</div>`).join('');
  const glitch = added.reduce((n, r) => n + (r.dropped || 0), 0);
  const note   = glitch ? `<div class="import-detail">${glitch} bad GPS fix(es) rejected</div>` : '';

  setLog(parts.join(' · ') + detail + note);
}

/** Widen the date filter so freshly imported tracks are actually on screen. */
function revealImported(tracks) {
  if (!tracks.length) return;

  const { fromMs, toMs } = currentRange();
  let min = Infinity, max = -Infinity;
  for (const t of tracks) {
    if (t.startTime < min) min = t.startTime;
    if (t.endTime   > max) max = t.endTime;
  }

  if (min < fromMs || max > toMs) {
    setRange(Math.min(min, fromMs === 0 ? min : fromMs),
             Math.max(max, toMs === Infinity ? max : toMs));
  }
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f => /\.gpx$/i.test(f.name));
  if (!files.length) { setLog('<span class="import-err">No .gpx files in that drop.</span>'); return; }
  if (busy) return;

  busy = true;
  const results = [];
  const added   = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setLog(`Reading ${i + 1} of ${files.length}: ${file.name}…`);

    try {
      if (isDuplicate(file.name)) {
        // Re-importing the same name replaces it; that is the useful behaviour
        // when a track has been re-exported, and the id is the filename.
        const confirmed = confirm(`"${file.name}" is already loaded. Replace it?`);
        if (!confirmed) { results.push({ name: file.name, status: 'skipped' }); continue; }
      }

      const record = await parseFile(file);
      const track  = await importRecord(record);
      added.push(track);
      results.push({ name: file.name, status: 'added', dropped: (record.dropped || 0) + (record.dupes || 0) });
    } catch (e) {
      results.push({ name: file.name, status: 'failed', error: e.message });
    }
  }

  busy = false;

  if (added.length) {
    revealImported(added);
    applyFilter();
  }
  summarise(results);
}

export function initImportPanel() {
  const zone  = $('#import-zone');
  const input = $('#import-input');

  input.addEventListener('change', e => {
    handleFiles(e.target.files);
    e.target.value = '';           // let the same file be picked again
  });

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });

  // Without preventDefault on dragover the browser navigates to the file.
  for (const type of ['dragenter', 'dragover']) {
    zone.addEventListener(type, e => { e.preventDefault(); zone.classList.add('drag-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    zone.addEventListener(type, e => { e.preventDefault(); zone.classList.remove('drag-over'); });
  }
  zone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));

  // Dropping anywhere else would otherwise replace the page with the file.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());
}

/** Delete an imported track, used by its row's remove button. */
export async function deleteImported(track) {
  if (!confirm(`Remove "${track.id}" from this browser?\n\nThe original GPX file is not touched.`)) return;
  await removeLocalTrack(track.id);
  if (state.selectedTrack && state.selectedTrack.id === track.id) state.selectedTrack = null;
  applyFilter();
}
