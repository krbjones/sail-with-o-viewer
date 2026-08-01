import { $, el } from '../core/dom.js';
import { state } from '../core/store.js';
import { fmtDateTime, fmtDuration } from '../core/format.js';
import { raceForTrack, ourBoat } from '../data/races.js';
import { detectManoeuvres, detectLegs, windowStats } from '../data/raceAnalysis.js';
import { analysePolar } from '../data/polar.js';

/**
 * One page per race, for going through with the crew.
 *
 * Everything here is computed over the official gun-to-finish window rather
 * than the whole recording, which is mostly the sail out and back.
 */

/** m:ss, or h:mm:ss once a race runs past the hour — these often do. */
function mmss(s) {
  if (s == null) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function stat(label, value, note) {
  return el('div', { class: 'db-stat' }, [
    el('div', { class: 'db-stat-value', html: value }),
    el('div', { class: 'db-stat-label', text: label }),
    note ? el('div', { class: 'db-stat-note', text: note }) : null,
  ]);
}

/** How we did, and by how much. */
function resultBlock(race) {
  const us   = race.us;
  const gap  = us.bce;
  const pct  = gap && us.elapsed ? (gap / us.elapsed * 100) : null;

  return el('section', { class: 'db-section' }, [
    el('div', { class: 'db-grid' }, [
      stat('Finished', `${us.rank} <small>of ${race.scored}</small>`,
           race.scored < race.entries ? `${race.entries} entered, ${race.entries - race.scored} did not finish` : null),
      stat('Elapsed',   mmss(us.elapsed)),
      stat('Corrected', mmss(us.corrected), `PHRF ${us.phrf}`),
      stat('Needed',    gap ? mmss(gap) + ' <small>faster</small>' : '—',
           pct ? `${pct.toFixed(1)}% quicker to win` : null),
    ]),
  ]);
}

/** Every finisher on corrected time, with our row marked. */
function fleetBlock(race) {
  const rows = race.finishers.map(b => {
    const isUs = b.name === ourBoat();
    const delta = b.corrected - race.us.corrected;
    return el('tr', { class: isUs ? 'db-us' : '' }, [
      el('td', { text: b.rank }),
      el('td', { text: b.name }),
      el('td', { class: 'db-dim', text: b.type || '' }),
      el('td', { class: 'db-num', text: b.phrf }),
      el('td', { class: 'db-num', text: mmss(b.elapsed) }),
      el('td', { class: 'db-num', text: mmss(b.corrected) }),
      el('td', { class: 'db-num ' + (delta < 0 ? 'db-ahead' : delta > 0 ? 'db-behind' : ''),
                 text: isUs ? '—' : (delta < 0 ? '-' : '+') + mmss(Math.abs(delta)) }),
    ]);
  });

  return el('section', { class: 'db-section' }, [
    el('h3', { text: 'Fleet on corrected time' }),
    el('table', { class: 'db-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '#' }), el('th', { text: 'Boat' }), el('th', { text: 'Type' }),
        el('th', { class: 'db-num', text: 'PHRF' }), el('th', { class: 'db-num', text: 'Elapsed' }),
        el('th', { class: 'db-num', text: 'Corrected' }), el('th', { class: 'db-num', text: 'vs us' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]);
}

/** What the boat actually did between the gun and the finish. */
function sailingBlock(track, race) {
  const s = windowStats(track, race.startMs, race.finishMs);
  if (!s) return null;

  const whole = track.duration;
  const racePart = (race.finishMs - race.startMs) / whole * 100;

  return el('section', { class: 'db-section' }, [
    el('h3', { text: 'Between the gun and the finish' }),
    el('div', { class: 'db-grid' }, [
      stat('Distance sailed', s.distanceNm.toFixed(2) + ' <small>nm</small>'),
      stat('Average speed',   s.avgSpeed.toFixed(1) + ' <small>kt</small>'),
      stat('Best speed',      s.maxSpeed.toFixed(1) + ' <small>kt</small>'),
      stat('Under way',       fmtDuration(s.movingMs),
           s.movingMs < s.durationMs ? `${fmtDuration(s.durationMs - s.movingMs)} below ½ kt` : null),
    ]),
    el('p', { class: 'db-note', text:
      `The recording is ${fmtDuration(whole)} in total; the race is ${racePart.toFixed(0)}% of it. ` +
      `Everything on this page uses the race window only.` }),
  ]);
}

function legsBlock(track, race) {
  const legs = detectLegs(track, race.startMs, race.finishMs);
  if (!legs.length) return null;

  return el('section', { class: 'db-section' }, [
    el('h3', { text: `Legs (${legs.length})` }),
    el('table', { class: 'db-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Point of sail' }), el('th', { class: 'db-num', text: 'Time' }),
        el('th', { class: 'db-num', text: 'Distance' }), el('th', { class: 'db-num', text: 'Avg' }),
        el('th', { class: 'db-num', text: 'Best' }),
      ])]),
      el('tbody', {}, legs.map(l => el('tr', {}, [
        el('td', { text: l.band }),
        el('td', { class: 'db-num', text: fmtDuration(l.durationMs) }),
        el('td', { class: 'db-num', text: l.distanceNm.toFixed(2) + ' nm' }),
        el('td', { class: 'db-num', text: l.avgSpeed.toFixed(1) }),
        el('td', { class: 'db-num', text: l.maxSpeed.toFixed(1) }),
      ]))),
    ]),
  ]);
}

function manoeuvreBlock(track, race) {
  const ms = detectManoeuvres(track, race.startMs, race.finishMs);
  if (!ms.length) {
    return el('section', { class: 'db-section' }, [
      el('h3', { text: 'Manoeuvres' }),
      el('p', { class: 'db-note', text: 'None detected — this needs wind data, which exists from 2025 on.' }),
    ]);
  }

  const total = ms.reduce((a, m) => a + m.lostMetres, 0);
  const tacks = ms.filter(m => m.kind === 'tack').length;

  return el('section', { class: 'db-section' }, [
    el('h3', { text: `Manoeuvres (${tacks} tacks, ${ms.length - tacks} gybes)` }),
    el('div', { class: 'db-grid' }, [
      stat('Total lost', Math.round(total) + ' <small>m</small>', 'against holding entry speed'),
      stat('Average',    Math.round(total / ms.length) + ' <small>m</small>', 'per manoeuvre'),
      stat('Worst',      Math.round(Math.max(...ms.map(m => m.lostMetres))) + ' <small>m</small>'),
    ]),
    el('table', { class: 'db-table' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Time' }), el('th', { text: '' }),
        el('th', { class: 'db-num', text: 'Entry' }), el('th', { class: 'db-num', text: 'Low' }),
        el('th', { class: 'db-num', text: 'Recovery' }), el('th', { class: 'db-num', text: 'Lost' }),
      ])]),
      el('tbody', {}, ms.map(m => el('tr', {}, [
        el('td', { text: new Date(m.at).toLocaleTimeString('en-CA', { hour12: false }) }),
        el('td', { text: m.kind }),
        el('td', { class: 'db-num', text: m.entry.toFixed(1) }),
        el('td', { class: 'db-num', text: m.minSpeed.toFixed(1) }),
        el('td', { class: 'db-num', text: m.recoverySec ? Math.round(m.recoverySec) + ' s' : '> 2 min' }),
        el('td', { class: 'db-num', text: Math.round(m.lostMetres) + ' m' }),
      ]))),
    ]),
  ]);
}

function conditionsBlock(race) {
  return el('section', { class: 'db-section' }, [
    el('h3', { text: 'Conditions' }),
    el('div', { class: 'db-grid' }, [
      stat('Wind (committee)', `${race.windDir || '—'}`, race.windSpeed || null),
      stat('Course', race.course || '—'),
      stat('Fleet', `${race.fleet} <small>fleet</small>`, `race ${race.race}`),
    ]),
    el('p', { class: 'db-note', text:
      'Wind above is the race committee\'s own observation. The model wind used for ' +
      'angles agrees on direction but reads low on speed, so treat wind-strength ' +
      'comparisons between races with care.' }),
  ]);
}

// ── Panel ─────────────────────────────────────────────────────────

let panel = null;

export function closeDebrief() {
  if (panel) panel.classList.add('hidden');
}

export function openDebrief(track) {
  const race = raceForTrack(track);
  if (!race) return;

  const body = $('#debrief-body');
  $('#debrief-title').textContent = `${race.fleet} Fleet · Race ${race.race}`;
  $('#debrief-sub').textContent   = `${fmtDateTime(track.startTime)} · ${track.id}`;

  body.replaceChildren(
    resultBlock(race),
    fleetBlock(race),
    conditionsBlock(race),
    sailingBlock(track, race),
    manoeuvreBlock(track, race),
    legsBlock(track, race),
  );

  panel.classList.remove('hidden');
  body.scrollTop = 0;
}

export function initDebrief() {
  panel = $('#debrief');
  $('#debrief-close').onclick = closeDebrief;
  panel.addEventListener('click', e => { if (e.target === panel) closeDebrief(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) closeDebrief();
  });
}

/** True when this track has a race behind it, so callers can offer the button. */
export function hasDebrief(track) {
  return raceForTrack(track) != null;
}
