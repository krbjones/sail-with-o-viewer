import { $ } from '../core/dom.js';

const wrap  = () => $('#progress-wrap');
const bar   = () => $('#progress-bar');
const label = () => $('#progress-label');
const status = () => $('#load-status');

export function showProgress(text = 'Loading…', pct = 0) {
  wrap().classList.add('visible');
  bar().style.width = pct + '%';
  label().textContent = text;
}

export function setProgress(pct, text) {
  bar().style.width = Math.round(pct) + '%';
  if (text !== undefined) label().textContent = text;
}

export function hideProgress() {
  wrap().classList.remove('visible');
}

export function setStatus(text) { status().textContent = text; }
export function getStatus()     { return status().textContent; }
