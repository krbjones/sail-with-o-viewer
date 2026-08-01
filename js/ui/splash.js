import { $ } from '../core/dom.js';

export function setSplashStatus(text) {
  $('#splash-status').textContent = text;
}

export function hideSplash() {
  $('#splash').classList.add('hidden');
}

/**
 * Show a dismissible error on the splash with a working Retry button, so a
 * failed manifest fetch no longer leaves the app permanently dimmed.
 */
export function showSplashError(message, onRetry) {
  setSplashStatus(message);

  const btn = $('#splash-btn');
  btn.classList.remove('hidden');
  btn.textContent = onRetry ? 'Retry' : 'Dismiss';
  btn.onclick = onRetry
    ? () => { btn.classList.add('hidden'); onRetry(); }
    : hideSplash;
}

export function clearSplashError() {
  $('#splash-btn').classList.add('hidden');
}
