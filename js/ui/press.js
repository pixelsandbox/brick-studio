/**
 * @fileoverview Brick buttons: physical press feedback, magnetic hover and a
 * stateful (loading / success / error) variant. Styles live in
 * css/components/buttons.css.
 *
 * Markup contract
 * ---------------
 *   <button class="btn-brick" type="button">Unlock</button>
 *   <a class="btn-brick btn-brick--sm" href="#connect" style="--c: var(--blue)">Let’s talk</a>
 *   <button class="btn-brick btn-brick--ghost" type="button">Tidy up</button>
 *
 *   .btn-brick              Glossy brick with studs on the top edge and a solid side
 *                           band that collapses when pressed (:active, or Space/Enter).
 *                           Colour: --c (face, default --red), --c-deep (side; derived
 *                           when omitted), --on-c (label colour, default --on-accent;
 *                           use var(--ink) on yellow / white bricks).
 *   .btn-brick--ghost       Outlined smooth tile (no studs). --c sets the outline.
 *   .btn-brick--sm | --lg   Sizes. .btn-brick--icon: square icon-only (needs aria-label).
 *   .btn-brick__label       Optional label wrapper; setButtonState() creates it if missing
 *                           (it moves the button's existing child nodes into it).
 *   [data-press]            Opt any other element into the press sound + keyboard press.
 *   [data-sound="snap"]     Press sound override (default 'click'; data-sound="" mutes).
 *   [data-magnetic="0.3"]   Magnetic hover, strength 0..1 (default 0.3). Fine pointers
 *                           only. A child [data-magnetic-label] (or .btn-brick__label)
 *                           drifts a little further for depth.
 *   data-loading-text / data-success-text / data-error-text
 *                           Optional status messages announced by setButtonState().
 *
 * API
 * ---
 *   initPress(root = document, { sound, magnetic = 'auto' }) -> destroy()
 *     Event delegation on `root`, so buttons added later are covered too.
 *   setButtonState(button, state, { sound, message, revert }) -> Promise<void>
 *     state: 'idle' | 'loading' | 'success' | 'error'. Loading shows studs hopping in
 *     sequence (aria-busy + aria-disabled, focus is kept); success draws a check and
 *     plays 'snap'; error shakes, plays 'error' and returns to idle after `revert` ms
 *     (default 1600; pass revert: false to stay). Success stays unless `revert` is a
 *     number. The promise resolves when the state's animation has finished.
 *
 * QA: ?cursor=1 forces fine-pointer behaviour (magnetic hover) in headless Chrome.
 */

import { clamp, env } from '../core/utils.js';
import { raf } from '../core/raf.js';

const PRESSABLE = '.btn-brick, [data-press]';
const isFine = () => env.finePointer || env.params.get('cursor') === '1';

/** Semi-implicit spring step with sub-steps (stable for large dt). */
function springTo(s, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (k * (target - s.x) - c * s.v) * h;
    s.x += s.v * h;
  }
}

const isDisabled = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true';

/**
 * Wires press feedback, sounds and magnetic hover for brick buttons in `root`.
 * @param {Document|Element} [root=document]
 * @param {{sound?: {play(name: string): void}, magnetic?: 'auto'|boolean}} [options]
 * @return {function(): void} destroy
 */
export function initPress(root = document, options = {}) {
  const { sound = null, magnetic = 'auto' } = options;
  const ac = new AbortController();
  const { signal } = ac;
  const play = (name) => {
    if (!name) return;
    try {
      sound?.play?.(name);
    } catch (_) {
      /* sound is optional */
    }
  };

  let lastSoundAt = 0;
  const pressSound = (el) => {
    const name = el.hasAttribute('data-sound') ? el.getAttribute('data-sound') : 'click';
    const now = performance.now();
    el.__brickSoundAt = now;
    if (now - lastSoundAt < 50) return;
    lastSoundAt = now;
    play(name);
  };

  const find = (e) => {
    const el = e.target instanceof Element ? e.target.closest(PRESSABLE) : null;
    return el && (root === document || root.contains(el)) ? el : null;
  };

  // Mouse / pen: sound on press for a physical feel. Touch waits for the click
  // so a scroll gesture that starts on a button stays silent.
  root.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || e.pointerType === 'touch') return;
      const el = find(e);
      if (el && !isDisabled(el)) pressSound(el);
    },
    { signal },
  );

  root.addEventListener(
    'click',
    (e) => {
      const el = find(e);
      if (!el) return;
      if (isDisabled(el)) {
        // aria-disabled keeps focusability, so block activation ourselves.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (performance.now() - (el.__brickSoundAt || 0) > 700) pressSound(el);
    },
    { signal, capture: true },
  );

  // Keyboard: show the pressed look while Space is held / briefly for Enter.
  const keyPressed = new Set();
  const release = () => {
    for (const el of keyPressed) el.classList.remove('is-pressed');
    keyPressed.clear();
  };
  root.addEventListener(
    'keydown',
    (e) => {
      if (e.repeat || (e.key !== 'Enter' && e.key !== ' ')) return;
      const el = find(e);
      if (!el || isDisabled(el) || e.target !== el) return;
      if (e.key === ' ' && el.tagName === 'A') return; // Space scrolls on links
      el.classList.add('is-pressed');
      keyPressed.add(el);
      pressSound(el);
      if (e.key === 'Enter') setTimeout(release, 150);
    },
    { signal },
  );
  root.addEventListener('keyup', release, { signal });
  root.addEventListener('focusout', release, { signal });

  let destroyMagnets = () => {};
  if (magnetic === true || (magnetic === 'auto' && isFine() && !env.reducedMotion)) {
    destroyMagnets = initMagnets(root, signal);
  }

  return () => {
    ac.abort();
    release();
    destroyMagnets();
  };
}

/** Magnetic hover for [data-magnetic] (element + optional label parallax). */
function initMagnets(root, signal) {
  const states = new Map();
  let px = 0;
  let py = 0;
  let unsub = null;

  const stateFor = (el) => {
    let s = states.get(el);
    if (!s) {
      s = {
        el,
        label: el.querySelector('[data-magnetic-label]') || el.querySelector(':scope > .btn-brick__label'),
        x: { x: 0, v: 0 },
        y: { x: 0, v: 0 },
        lx: { x: 0, v: 0 },
        ly: { x: 0, v: 0 },
        active: false,
        strength: 0.3,
      };
      states.set(el, s);
    }
    const v = parseFloat(el.getAttribute('data-magnetic'));
    s.strength = clamp(Number.isFinite(v) ? v : 0.3, 0, 1);
    return s;
  };

  const start = () => {
    if (unsub) return;
    unsub = raf.add(tick);
    raf.start();
  };

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      px = e.clientX;
      py = e.clientY;
    },
    { signal, passive: true },
  );

  root.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType === 'touch') return;
      const el = e.target instanceof Element ? e.target.closest('[data-magnetic]') : null;
      if (!el || isDisabled(el)) return;
      const s = stateFor(el);
      if (s.active) return;
      s.active = true;
      if (e.clientX || e.clientY) {
        px = e.clientX;
        py = e.clientY;
      }
      start();
    },
    { signal },
  );

  root.addEventListener(
    'pointerout',
    (e) => {
      const el = e.target instanceof Element ? e.target.closest('[data-magnetic]') : null;
      if (!el) return;
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      const s = states.get(el);
      if (s) s.active = false;
    },
    { signal },
  );

  function tick(t, dt) {
    for (const s of states.values()) {
      let tx = 0;
      let ty = 0;
      if (s.active && s.el.isConnected) {
        const r = s.el.getBoundingClientRect();
        // Rest centre = current centre minus our own offset.
        const cx = r.left + r.width / 2 - s.x.x;
        const cy = r.top + r.height / 2 - s.y.x;
        const reach = Math.max(r.width, r.height) * 0.5 + 24;
        tx = clamp((px - cx) * s.strength, -reach * s.strength, reach * s.strength);
        ty = clamp((py - cy) * s.strength, -reach * s.strength, reach * s.strength);
      }
      springTo(s.x, tx, 190, 15, dt);
      springTo(s.y, ty, 190, 15, dt);
      springTo(s.lx, tx * 0.45, 150, 12, dt);
      springTo(s.ly, ty * 0.45, 150, 12, dt);

      const resting =
        !s.active &&
        Math.abs(s.x.x) + Math.abs(s.y.x) + Math.abs(s.lx.x) + Math.abs(s.ly.x) < 0.05 &&
        Math.abs(s.x.v) + Math.abs(s.y.v) + Math.abs(s.lx.v) + Math.abs(s.ly.v) < 0.5;
      if (resting) {
        s.el.style.translate = '';
        if (s.label) s.label.style.translate = '';
        states.delete(s.el);
        continue;
      }
      s.el.style.translate = `${s.x.x.toFixed(2)}px ${s.y.x.toFixed(2)}px`;
      if (s.label) s.label.style.translate = `${s.lx.x.toFixed(2)}px ${s.ly.x.toFixed(2)}px`;
    }
    if (!states.size && unsub) {
      unsub();
      unsub = null;
    }
  }

  return () => {
    unsub?.();
    unsub = null;
    for (const s of states.values()) {
      s.el.style.translate = '';
      if (s.label) s.label.style.translate = '';
    }
    states.clear();
  };
}

/* ------------------------------------------------------------------------ */
/* Stateful buttons                                                          */
/* ------------------------------------------------------------------------ */

const STATE_MS = { success: 640, error: 520 };
const DEFAULT_TEXT = { loading: 'Working…', success: 'Done', error: 'Something went wrong' };
let liveNode = null;

function announce(message) {
  if (!message) return;
  if (!liveNode || !liveNode.isConnected) {
    liveNode = document.createElement('span');
    liveNode.className = 'btn-brick-live';
    liveNode.setAttribute('role', 'status');
    document.body.append(liveNode);
  }
  liveNode.textContent = '';
  // A fresh text node after a tick makes repeated identical messages re-announce.
  setTimeout(() => {
    if (liveNode) liveNode.textContent = message;
  }, 40);
}

function ensureParts(button) {
  if (button.__brickParts) return button.__brickParts;
  let label = button.querySelector(':scope > .btn-brick__label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'btn-brick__label';
    label.append(...button.childNodes);
    button.append(label);
  }
  const layer = document.createElement('span');
  layer.className = 'btn-brick__state';
  layer.setAttribute('aria-hidden', 'true');
  const dots = document.createElement('span');
  dots.className = 'btn-brick__dots';
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('i');
    dot.style.setProperty('--i', String(i));
    dots.append(dot);
  }
  const svgNS = 'http://www.w3.org/2000/svg';
  const makeGlyph = (cls, d) => {
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', `btn-brick__glyph ${cls}`);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('pathLength', '1');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };
  layer.append(
    dots,
    makeGlyph('btn-brick__glyph--ok', 'M5 12.8l4.6 4.4L19 7.6'),
    makeGlyph('btn-brick__glyph--err', 'M7.5 7.5l9 9m0-9l-9 9'),
  );
  button.append(layer);
  button.__brickParts = { label, layer };
  button.__brickAriaDisabled = button.getAttribute('aria-disabled');
  return button.__brickParts;
}

/**
 * Switches a brick button between idle / loading / success / error.
 * @param {HTMLElement} button
 * @param {'idle'|'loading'|'success'|'error'} [state='idle']
 * @param {{sound?: {play(name: string): void}, message?: string, revert?: number|false}} [options]
 * @return {Promise<void>} resolves when the state's animation has finished
 */
export function setButtonState(button, state = 'idle', options = {}) {
  if (!button) return Promise.resolve();
  const { sound = null, message } = options;
  ensureParts(button);
  clearTimeout(button.__brickRevert);
  const play = (name) => {
    try {
      sound?.play?.(name);
    } catch (_) {
      /* optional */
    }
  };

  if (state === 'idle') {
    delete button.dataset.state;
    button.removeAttribute('aria-busy');
    if (button.__brickAriaDisabled == null) button.removeAttribute('aria-disabled');
    else button.setAttribute('aria-disabled', button.__brickAriaDisabled);
    if (message) announce(message);
    return Promise.resolve();
  }

  if (!['loading', 'success', 'error'].includes(state)) {
    return Promise.reject(new Error(`setButtonState: unknown state "${state}"`));
  }

  // Restart the CSS animation when the same state is applied twice (e.g. two
  // wrong passwords in a row should shake twice).
  if (button.dataset.state === state && state !== 'loading') {
    delete button.dataset.state;
    void button.offsetWidth;
  }
  button.dataset.state = state;
  const text = message ?? button.getAttribute(`data-${state}-text`) ?? DEFAULT_TEXT[state];

  if (state === 'loading') {
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    announce(text);
    return Promise.resolve();
  }

  button.removeAttribute('aria-busy');
  if (button.__brickAriaDisabled == null) button.removeAttribute('aria-disabled');
  play(state === 'success' ? 'snap' : 'error');
  announce(text);

  const revert = options.revert ?? (state === 'error' ? 1600 : false);
  if (typeof revert === 'number') {
    button.__brickRevert = setTimeout(() => setButtonState(button, 'idle'), revert);
  }
  const ms = env.reducedMotion ? 0 : STATE_MS[state];
  return new Promise((resolve) => setTimeout(resolve, ms));
}
