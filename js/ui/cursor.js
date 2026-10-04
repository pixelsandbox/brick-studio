/**
 * @fileoverview Following pointer: a custom cursor shaped like a single stud
 * seen from above. It trails the pointer on a stiff spring; a brick-tag label
 * follows on a softer spring for elements that ask for one. Styles:
 * css/components/cursor.css.
 *
 * Markup contract (no cursor markup needed; the module creates its element)
 * ---------------
 *   [data-cursor="Open"]   Stud grows and a tag with the text pops out beside it.
 *                          data-cursor="none" hides the custom cursor over the element.
 *   [data-cursor-grab]     Grab look (grips either side of the stud); squeezes while
 *                          the pointer is down. Combine with data-cursor="Drag" for a tag.
 *   a, button, summary, label, [role=button], [data-press], [tabindex]
 *                          Interactive: the stud grows a little.
 *   input, textarea, select, [contenteditable], [data-cursor-native], iframe
 *                          The custom cursor hides and the native cursor is kept.
 *
 * API
 * ---
 *   initCursor({ force }) -> destroy()
 *   Active only for fine pointers without reduced motion; `force` (or ?cursor=1)
 *   overrides that for QA. Adds html.has-brick-cursor while active (native cursor
 *   hidden everywhere except form fields). Hides when the pointer leaves the window.
 */

import { env } from '../core/utils.js';
import { raf } from '../core/raf.js';

const NATIVE =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-cursor-native], iframe';
const INTERACTIVE =
  'a[href], button, summary, label, [role="button"], [role="tab"], [data-press], [tabindex]:not([tabindex="-1"])';

function springTo(s, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (k * (target - s.x) - c * s.v) * h;
    s.x += s.v * h;
  }
}

/**
 * @param {{force?: boolean}} [options]
 * @return {function(): void} destroy
 */
export function initCursor(options = {}) {
  const force = options.force ?? env.params.get('cursor') === '1';
  if (!force && !(env.finePointer && !env.reducedMotion)) return () => {};

  const ac = new AbortController();
  const { signal } = ac;
  const el = document.createElement('div');
  el.className = 'cursor';
  el.setAttribute('aria-hidden', 'true');
  const studEl = document.createElement('div');
  studEl.className = 'cursor__stud';
  const ringEl = document.createElement('span');
  ringEl.className = 'cursor__ring';
  const faceEl = document.createElement('span');
  faceEl.className = 'cursor__face';
  studEl.append(ringEl, faceEl);

  const tagEl = document.createElement('div');
  tagEl.className = 'cursor__tag';
  const tagBodyEl = document.createElement('span');
  tagBodyEl.className = 'cursor__tag-body';
  const textEl = document.createElement('span');
  textEl.className = 'cursor__text';
  tagBodyEl.append(textEl);
  tagEl.append(tagBodyEl);

  el.append(studEl, tagEl);
  document.body.append(el);
  document.documentElement.classList.add('has-brick-cursor');

  const pointer = { x: -200, y: -200 };
  const stud = { x: { x: -200, v: 0 }, y: { x: -200, v: 0 } };
  const tag = { x: { x: -200, v: 0 }, y: { x: -200, v: 0 } };
  let seen = false;
  let inside = false;
  let dirty = true;
  let state = '';
  let unsub = null;

  const wake = () => {
    if (unsub) return;
    unsub = raf.add(tick);
    raf.start();
  };

  const setVisible = (v) => el.classList.toggle('is-visible', v);

  function resolve(target) {
    if (!target || target.closest(NATIVE)) return { off: true, link: false, grab: false, label: '' };
    const labelEl = target.closest('[data-cursor]');
    const text = labelEl ? (labelEl.getAttribute('data-cursor') || '').trim() : '';
    if (text.toLowerCase() === 'none') return { off: true, link: false, grab: false, label: '' };
    return {
      off: false,
      grab: !!target.closest('[data-cursor-grab]'),
      label: text,
      link: !!target.closest(INTERACTIVE),
    };
  }

  function applyState() {
    const r = resolve(document.elementFromPoint(pointer.x, pointer.y));
    const key = `${r.off}|${r.grab}|${r.label}|${r.link}`;
    if (key === state) return;
    state = key;
    el.classList.toggle('is-off', r.off);
    el.classList.toggle('is-grab', r.grab);
    el.classList.toggle('is-label', !!r.label);
    el.classList.toggle('is-link', r.link && !r.label && !r.grab);
    if (r.label) textEl.textContent = r.label;
  }

  function tick(t, dt) {
    if (dirty && seen) {
      dirty = false;
      applyState();
    }
    springTo(stud.x, pointer.x, 2600, 96, dt);
    springTo(stud.y, pointer.y, 2600, 96, dt);
    springTo(tag.x, pointer.x, 210, 19, dt);
    springTo(tag.y, pointer.y, 210, 19, dt);
    studEl.style.transform = `translate3d(${stud.x.x.toFixed(2)}px, ${stud.y.x.toFixed(2)}px, 0)`;
    tagEl.style.transform = `translate3d(${tag.x.x.toFixed(2)}px, ${tag.y.x.toFixed(2)}px, 0)`;

    const rest =
      Math.abs(pointer.x - stud.x.x) + Math.abs(pointer.y - stud.y.x) < 0.1 &&
      Math.abs(pointer.x - tag.x.x) + Math.abs(pointer.y - tag.y.x) < 0.1 &&
      Math.abs(stud.x.v) + Math.abs(stud.y.v) + Math.abs(tag.x.v) + Math.abs(tag.y.v) < 1;
    if (rest && !dirty) {
      unsub?.();
      unsub = null;
    }
  }

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') {
        setVisible(false);
        return;
      }
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (!seen) {
        seen = true;
        stud.x.x = tag.x.x = pointer.x;
        stud.y.x = tag.y.x = pointer.y;
      }
      if (!inside) {
        inside = true;
        setVisible(true);
      }
      dirty = true;
      wake();
    },
    { signal, passive: true },
  );

  const leave = () => {
    inside = false;
    setVisible(false);
  };
  document.addEventListener(
    'mouseout',
    (e) => {
      if (!e.relatedTarget) leave();
    },
    { signal },
  );
  document.documentElement.addEventListener('mouseleave', leave, { signal });
  window.addEventListener('blur', leave, { signal });

  let clickTimer = 0;
  window.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'touch') return;
      el.classList.add('is-down');
      el.classList.remove('is-clicked');
      void el.offsetWidth;
      el.classList.add('is-clicked');
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => el.classList.remove('is-clicked'), 500);
    },
    { signal, passive: true },
  );
  const up = () => el.classList.remove('is-down');
  window.addEventListener('pointerup', up, { signal, passive: true });
  window.addEventListener('pointercancel', up, { signal, passive: true });

  // Content moving under a still pointer (scrolling, overlays) changes the target.
  const markDirty = () => {
    dirty = true;
    if (seen) wake();
  };
  window.addEventListener('scroll', markDirty, { signal, passive: true, capture: true });
  document.addEventListener('pointerover', markDirty, { signal, passive: true });

  return () => {
    ac.abort();
    unsub?.();
    unsub = null;
    clearTimeout(clickTimer);
    el.remove();
    document.documentElement.classList.remove('has-brick-cursor');
  };
}
