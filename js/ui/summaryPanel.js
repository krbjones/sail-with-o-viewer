import { $, el } from '../core/dom.js';
import { fmtDate, fmtDuration } from '../core/format.js';
import { metaInRange, totals, windOver, compass, allTime } from '../data/summary.js';
import { registerPref, savePrefs } from '../core/prefs.js';

/**
 * Sidebar summary: totals for the filtered period, and an all-time breakdown.
 *
 * Both read the manifest only (see js/data/summary.js), so this panel is
 * accurate for every track in the archive whether or not its month bundle has
 * been downloaded. That is the whole point — "total miles sailed" should not
 * depend on where you happen to have panned.
 */

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Which year rows are expanded; persisted so the panel reopens as you left it. */
let openYears = new Set();
let allTimeOpen = false;

const nm   = d => d.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const stat = (label, value, unit) => el('div', { class: 'stat' }, [
  el('div', { class: 'stat-value', html: unit ? `${value} <small>${unit}</small>` : String(value) }),
  el('div', { class: 'stat-label', text: label }),
]);

/** "Sep 19 – Sep 26", or an honest label when an end of the range is open. */
function rangeLabel(fromMs, toMs, t) {
  if (!t.count) return '';
  const open = fromMs <= 0 || !Number.isFinite(toMs);
  // With a blank date box the filter spans everything, so the useful thing to
  // name is the sailing the period actually contains, not "1970 – forever".
  const a = open ? t.firstMs : fromMs;
  const b = open ? t.lastMs  : toMs;
  return fmtDate(a) === fmtDate(b) ? fmtDate(a) : `${fmtDate(a)} – ${fmtDate(b)}`;
}

function renderPeriod(fromMs, toMs, timeFrom, timeTo) {
  const host = $('#period-summary');
  if (!host) return;

  const metas = metaInRange(fromMs, toMs, timeFrom, timeTo);
  const t     = totals(metas);

  if (!t.count) {
    host.replaceChildren(el('div', { class: 'summary-empty', text: 'No tracks in this period.' }));
    return;
  }

  const kids = [
    el('div', { class: 'summary-range', text: rangeLabel(fromMs, toMs, t) }),
    el('div', { class: 'summary-grid' }, [
      stat('Distance',  nm(t.dist), 'nm'),
      stat('Under way', fmtDuration(t.movingMs)),
      stat('Tracks',    t.count),
      stat('Avg speed', t.avgSpd ? t.avgSpd.toFixed(1) : '—', t.avgSpd ? 'kts' : ''),
      stat('Max speed', t.maxSpd ? t.maxSpd.toFixed(1) : '—', t.maxSpd ? 'kts' : ''),
      stat('Elapsed',   fmtDuration(t.elapsedMs)),
    ]),
  ];

  const w = windOver(metas);
  if (w) {
    const gust = w.gust ? `, gusts ${w.gust.toFixed(0)}` : '';
    kids.push(el('div', { class: 'summary-wind' }, [
      el('span', { class: 'summary-wind-main',
                   text: `Wind ${w.speed.toFixed(0)} kts ${compass(w.windFrom)}${gust}` }),
      // Wind starts in 2025 and only covers areas a North American model
      // serves, so a period can be partly described. Say which part.
      w.tracks < w.of
        ? el('span', { class: 'summary-wind-note', text: ` · ${w.tracks} of ${w.of} tracks` })
        : null,
    ]));
  }

  host.replaceChildren(...kids);
}

function monthRow(mo) {
  return el('div', { class: 'summary-row summary-row-month' }, [
    el('span', { class: 'summary-row-label', text: MONTH_NAMES[Number(mo.key.slice(5, 7)) - 1] || mo.key }),
    el('span', { class: 'summary-row-count', text: `${mo.count}` }),
    el('span', { class: 'summary-row-dist',  text: `${nm(mo.dist)} nm` }),
  ]);
}

function yearBlock(y, maxDist) {
  const open = openYears.has(y.year);

  const head = el('button', {
    class: 'summary-row summary-row-year' + (open ? ' open' : ''),
    type: 'button',
    'aria-expanded': String(open),
    onclick: () => {
      if (openYears.has(y.year)) openYears.delete(y.year); else openYears.add(y.year);
      renderAllTime();
      savePrefs();
    },
  }, [
    el('span', { class: 'summary-caret', text: '▸' }),
    el('span', { class: 'summary-row-label', text: y.year }),
    // A proportional bar makes a good season legible without reading numbers.
    el('span', { class: 'summary-bar' }, [
      el('span', { class: 'summary-bar-fill', style: `width:${maxDist ? (y.dist / maxDist) * 100 : 0}%` }),
    ]),
    el('span', { class: 'summary-row-dist', text: `${nm(y.dist)} nm` }),
  ]);

  return el('div', { class: 'summary-year' },
    [head, open ? el('div', { class: 'summary-months' }, y.months.map(monthRow)) : null]);
}

function renderAllTime() {
  const host = $('#alltime-body');
  if (!host) return;

  const a = allTime();
  const maxDist = a.years.reduce((m, y) => Math.max(m, y.dist), 0);

  $('#alltime-total').textContent = `${nm(a.dist)} nm`;
  $('#alltime-sub').textContent   =
    `${a.count} tracks · ${fmtDuration(a.movingMs)} under way`;

  host.replaceChildren(...a.years.map(y => yearBlock(y, maxDist)));
}

/** Redraw both halves. Call after anything that changes the date filter. */
export function renderSummary({ fromMs, toMs, timeFrom, timeTo }) {
  renderPeriod(fromMs, toMs, timeFrom, timeTo);
  renderAllTime();
}

export function initSummaryPanel() {
  const details = $('#alltime');

  // Registered here, during init(), so the values are in place before boot's
  // loadPrefs() runs — a provider added later is silently never restored.
  registerPref('summary', {
    get: () => ({ openYears: [...openYears], allTimeOpen: details ? details.open : allTimeOpen }),
    set: v => {
      openYears   = new Set(Array.isArray(v.openYears) ? v.openYears : []);
      allTimeOpen = !!v.allTimeOpen;
      if (details) details.open = allTimeOpen;
      renderAllTime();
    },
  });

  if (details) details.addEventListener('toggle', () => { allTimeOpen = details.open; savePrefs(); });
}
