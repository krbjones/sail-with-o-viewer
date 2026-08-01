import { $ } from '../core/dom.js';
import { map } from '../map/mapSetup.js';

const MOBILE_QUERY = '(max-width: 820px)';

let mql = null;

export function isMobile() { return mql ? mql.matches : false; }

function setOpen(open) {
  document.body.classList.toggle('drawer-open', open);
  $('#btn-drawer').setAttribute('aria-expanded', String(open));
  // The map's width changes with the drawer on wider phones/tablets.
  setTimeout(() => map.invalidateSize({ animate: false }), 260);
}

export function closeDrawer() {
  if (document.body.classList.contains('drawer-open')) setOpen(false);
}

/**
 * Below 820px the sidebar slides over the map instead of sitting beside it.
 * At that width a fixed 290px column leaves no usable map.
 */
export function initDrawer() {
  const btn      = $('#btn-drawer');
  const backdrop = $('#drawer-backdrop');

  btn.addEventListener('click', () => setOpen(!document.body.classList.contains('drawer-open')));
  backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeDrawer();
  });

  mql = window.matchMedia(MOBILE_QUERY);

  // Leaving mobile with the drawer open would strand the backdrop over the map.
  // Listen for resize as well as the media query: the change event does not
  // fire reliably when the viewport is resized programmatically.
  const onViewportChange = () => {
    if (!mql.matches) closeDrawer();
    map.invalidateSize({ animate: false });
  };
  mql.addEventListener('change', onViewportChange);
  window.addEventListener('resize', onViewportChange);
}

/** Get out of the way after the user picks a track on a phone. */
export function closeDrawerAfterSelection() {
  if (isMobile()) closeDrawer();
}
