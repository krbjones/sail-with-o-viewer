export const fmtDate = ms =>
  new Date(ms).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });

export const fmtTime = ms =>
  new Date(ms).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

export const fmtDateTime = ms =>
  new Date(ms).toLocaleDateString('en-CA', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });

export const fmtDuration = ms => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** "YYYY-MM-DD" for <input type="date">, in the browser's local timezone. */
export function fmtDateInput(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' +
         String(d.getMonth() + 1).padStart(2, '0') + '-' +
         String(d.getDate()).padStart(2, '0');
}

/** "HH:MM" in local browser time. */
export function localHHMM(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
