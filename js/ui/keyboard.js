import { state } from '../core/store.js';
import { STEP_MS } from '../config.js';
import { togglePlay, seekTo } from './animBar.js';

const FOCUSABLE = 'button,input,select,textarea,[contenteditable]';

export function initKeyboard() {
  document.addEventListener('keydown', e => {
    // Never hijack keys aimed at a control. Space in particular would otherwise
    // both activate the focused button and toggle playback.
    if (e.target.closest && e.target.closest(FOCUSABLE)) return;

    switch (e.code) {
      case 'Space':      e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft':  seekTo(state.animTime - STEP_MS); break;
      case 'ArrowRight': seekTo(state.animTime + STEP_MS); break;
      case 'Home':       seekTo(state.animMin); break;
      case 'End':        seekTo(state.animMax); break;
    }
  });
}
