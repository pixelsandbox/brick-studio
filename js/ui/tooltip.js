/**
 * @fileoverview Animated tooltip: a brick tag that springs up from its trigger,
 * tilts with the horizontal pointer velocity and drifts slightly with the
 * pointer. Works on hover, keyboard focus and touch long-press; Escape
 * dismisses; it is clamped so it never overflows the viewport. Styles:
 * css/components/tooltip.css.
 *
 * Markup contract
 * ---------------
 *   <button type="button" data-tip="Copy email" data-tip-sub="hello@…">…</button>
 *   <a href="…" data-tip="LinkedIn" data-tip-sub="Let’s connect" data-tip-color="var(--blue)">…</a>
 *
 *   data-tip            Tooltip text (required). Changes while open are picked up.
 *   data-tip-sub        Optional second line (mono).
 *   data-tip-color      Optional stripe colour (CSS colour / var()); defaults to the
 *                       trigger's --c if set, else --yellow.
 *   data-tip-placement  "top" (default) or "bottom"; flips when there is no room.
 *   The trigger should be focusable. While shown it gets aria-describedby pointing
 *   at the shared role="tooltip" element (existing describedby ids are kept).
 *
 * API
 * ---
 *   initTooltip(root = document, { sound }) -> destroy()
 *   Plays 'pop' (throttled) when a tooltip opens, if a sound object is given.
 */

import { clamp, damp, env } from '../core/utils.js';
import { raf } from '../core/raf.js';

const MARGIN = 10;
const GAP = 12;
let uid = 0;

function springTo(s, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 240));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (k * (target - s.x) - c * s.v) * h;
    s.x += s.v * h;
  }
}

/**
 * @param {Document|Element} [root=document]
 * @param {{sound?: {play(name: string): void}}} [options]
 * @return {function(): void} destroy
 */
export function initTooltip(root = document, options = {}) {
  const { sound = null } = options;
  const ac = new AbortController();
  const { signal } = ac;
  const reduced = env.reducedMotion;

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.id = `brick-tip-${++uid}`;
  tip.setAttribute('role', 'tooltip');
  const card = document.createElement('span');
  card.className = 'tip__card';
  const titleEl = document.createElement('span');
  titleEl.className = 'tip__title';
  const subEl = document.createElement('span');
  subEl.className = 'tip__sub';
  const notchEl = document.createElement('span');
  notchEl.className = 'tip__notch';
  notchEl.setAttribute('aria-hidden', 'true');
  card.append(titleEl, subEl, notchEl);
  tip.append(card);
  document.body.append(tip);

  let current = null;
  let open = false;
  let dismissed = null;
  let pointerOver = false;
  let showTimer = 0;
  let hideTimer = 0;
  let touchTimer = 0;
  let lastPop = 0;
  let size = { w: 0, h: 0 };
  let unsub = null;
  const appear = { x: 0, v: 0 };
  const tilt = { x: 0, v: 0 };
  const drift = { x: 0, v: 0 };
  const pointer = { x: 0, y: 0, vx: 0, t: 0 };

  const contains = (el) => el && (root === document ? document.contains(el) : root.contains(el));
  const triggerOf = (node) => (node instanceof Element ? node.closest('[data-tip]') : null);

  const mo = new MutationObserver(() => current && fill(current));

  function fill(trigger) {
    titleEl.textContent = trigger.getAttribute('data-tip') || '';
    subEl.textContent = trigger.getAttribute('data-tip-sub') || '';
    const color = trigger.getAttribute('data-tip-color') || getComputedStyle(trigger).getPropertyValue('--c').trim();
    if (color) card.style.setProperty('--_c', color);
    else card.style.removeProperty('--_c');
    size = { w: card.offsetWidth, h: card.offsetHeight };
  }

  function describe(trigger, on) {
    const ids = (trigger.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tip.id);
    if (on) ids.push(tip.id);
    if (ids.length) trigger.setAttribute('aria-describedby', ids.join(' '));
    else trigger.removeAttribute('aria-describedby');
  }

  function place() {
    if (!current) return;
    const r = current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const { w, h } = size;
    const cx = r.left + r.width / 2;
    let placement = current.getAttribute('data-tip-placement') === 'bottom' ? 'bottom' : 'top';
    const above = r.top - GAP - h;
    const below = r.bottom + GAP;
    if (placement === 'top' && above < MARGIN && below + h <= vh - MARGIN) placement = 'bottom';
    else if (placement === 'bottom' && below + h > vh - MARGIN && above >= MARGIN) placement = 'top';
    const left = clamp(cx - w / 2, MARGIN, Math.max(MARGIN, vw - w - MARGIN));
    const top = placement === 'top' ? Math.max(MARGIN, above) : Math.min(below, vh - h - MARGIN);
    tip.dataset.placement = placement;
    tip.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
    card.style.setProperty('--_ax', `${clamp(cx - left, 12, w - 12).toFixed(1)}px`);
  }

  function show(trigger) {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    if (!trigger.getAttribute('data-tip')) return;
    if (trigger === dismissed) return;
    if (current && current !== trigger) {
      describe(current, false);
      mo.disconnect();
    }
    const fresh = !open || current !== trigger;
    current = trigger;
    open = true;
    fill(trigger);
    describe(trigger, true);
    mo.observe(trigger, { attributes: true, attributeFilter: ['data-tip', 'data-tip-sub'] });
    tip.classList.add('is-open');
    place();
    if (fresh && appear.x < 0.5) {
      appear.x = 0;
      appear.v = 0;
      const now = performance.now();
      if (now - lastPop > 250) {
        lastPop = now;
        try {
          sound?.play?.('pop');
        } catch (_) {
          /* optional */
        }
      }
    }
    if (reduced) appear.x = 1;
    wake();
  }

  function hide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (!current) return;
    describe(current, false);
    mo.disconnect();
    open = false;
    pointerOver = false;
    if (reduced) appear.x = 0;
    wake();
  }

  const scheduleHide = (ms = 110) => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, ms);
  };

  const wake = () => {
    if (unsub) return;
    unsub = raf.add(tick);
    raf.start();
  };

  function tick(t, dt) {
    // Velocity decays when the pointer stops.
    if (performance.now() - pointer.t > 40) pointer.vx = damp(pointer.vx, 0, 14, dt);

    if (open) springTo(appear, 1, 480, 22, dt);
    else springTo(appear, 0, 900, 60, dt);

    let tiltTarget = 0;
    let driftTarget = 0;
    if (open && pointerOver && !reduced && current) {
      const r = current.getBoundingClientRect();
      tiltTarget = clamp(pointer.vx * 0.016, -10, 10);
      driftTarget = clamp((pointer.x - (r.left + r.width / 2)) * 0.18, -14, 14);
    }
    springTo(tilt, tiltTarget, 220, 13, dt);
    springTo(drift, driftTarget, 260, 22, dt);

    if (current) place();
    const s = clamp(appear.x, 0, 1.4);
    const dir = tip.dataset.placement === 'bottom' ? -1 : 1;
    card.style.opacity = String(clamp(appear.x * 2, 0, 1));
    card.style.transform = reduced
      ? 'none'
      : `translate3d(${drift.x.toFixed(2)}px, ${((1 - s) * 12 * dir).toFixed(2)}px, 0) ` +
        `rotate(${tilt.x.toFixed(2)}deg) scale(${(0.55 + 0.45 * s).toFixed(4)})`;

    if (!open && appear.x < 0.02) {
      appear.x = 0;
      appear.v = 0;
      tip.classList.remove('is-open');
      card.style.opacity = '0';
      current = null;
      unsub?.();
      unsub = null;
      return;
    }
    const settled =
      open &&
      !pointerOver &&
      Math.abs(1 - appear.x) < 0.001 &&
      Math.abs(appear.v) + Math.abs(tilt.x) + Math.abs(tilt.v) + Math.abs(drift.x) + Math.abs(drift.v) < 0.02;
    if (settled) {
      unsub?.();
      unsub = null;
    }
  }

  /* ---- Pointer (mouse / pen) ------------------------------------------------ */
  root.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType === 'touch') return;
      const trigger = triggerOf(e.target);
      if (!trigger || !contains(trigger)) return;
      if (e.relatedTarget instanceof Node && trigger.contains(e.relatedTarget)) return;
      pointerOver = true;
      if (e.clientX || e.clientY) {
        pointer.x = e.clientX;
        pointer.y = e.clientY;
      }
      if (open && current === trigger) {
        clearTimeout(hideTimer);
        wake();
        return;
      }
      clearTimeout(showTimer);
      showTimer = setTimeout(() => show(trigger), open ? 0 : 40);
    },
    { signal },
  );
  root.addEventListener(
    'pointerout',
    (e) => {
      if (e.pointerType === 'touch') return;
      const trigger = triggerOf(e.target);
      if (!trigger) return;
      const to = e.relatedTarget;
      if (to instanceof Node && (trigger.contains(to) || tip.contains(to))) return;
      if (trigger === dismissed) dismissed = null;
      clearTimeout(showTimer);
      if (trigger === current) {
        pointerOver = false;
        if (!trigger.contains(document.activeElement) || !trigger.matches(':focus-visible')) scheduleHide();
      }
    },
    { signal },
  );
  // Hoverable (WCAG 1.4.13): moving onto the tooltip keeps it open.
  tip.addEventListener('pointerenter', () => clearTimeout(hideTimer), { signal });
  tip.addEventListener('pointerleave', () => scheduleHide(), { signal });

  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      const now = performance.now();
      const dtMs = Math.max(4, now - (pointer.t || now - 16));
      const v = ((e.clientX - pointer.x) / dtMs) * 1000;
      pointer.vx = pointer.vx + (clamp(v, -4000, 4000) - pointer.vx) * 0.35;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.t = now;
      if (open && pointerOver) wake();
    },
    { signal, passive: true },
  );

  /* ---- Keyboard ------------------------------------------------------------- */
  root.addEventListener(
    'focusin',
    (e) => {
      const trigger = triggerOf(e.target);
      if (!trigger || !contains(trigger)) return;
      dismissed = null;
      show(trigger);
    },
    { signal },
  );
  root.addEventListener(
    'focusout',
    (e) => {
      const trigger = triggerOf(e.target);
      if (!trigger || trigger !== current) return;
      if (e.relatedTarget instanceof Node && trigger.contains(e.relatedTarget)) return;
      if (!pointerOver) hide();
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !open || !current) return;
      dismissed = current;
      hide();
    },
    { signal },
  );

  /* ---- Touch: long-press shows, release hides after a beat ------------------ */
  let touchStart = null;
  root.addEventListener(
    'pointerdown',
    (e) => {
      const trigger = triggerOf(e.target);
      if (e.pointerType !== 'touch') {
        if (open && trigger !== current) hide();
        return;
      }
      clearTimeout(touchTimer);
      if (!trigger || !contains(trigger)) {
        if (open) hide();
        return;
      }
      touchStart = { x: e.clientX, y: e.clientY };
      touchTimer = setTimeout(() => {
        dismissed = null;
        show(trigger);
      }, 420);
    },
    { signal, passive: true },
  );
  const endTouch = (e) => {
    if (e.pointerType !== 'touch') return;
    clearTimeout(touchTimer);
    touchStart = null;
    if (open) scheduleHide(1600);
  };
  root.addEventListener('pointerup', endTouch, { signal, passive: true });
  root.addEventListener('pointercancel', endTouch, { signal, passive: true });
  root.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'touch' || !touchStart) return;
      if (Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 10) clearTimeout(touchTimer);
    },
    { signal, passive: true },
  );

  window.addEventListener('resize', () => open && place(), { signal, passive: true });
  window.addEventListener('scroll', () => open && wake(), { signal, passive: true, capture: true });

  return () => {
    ac.abort();
    mo.disconnect();
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    clearTimeout(touchTimer);
    if (current) describe(current, false);
    unsub?.();
    unsub = null;
    tip.remove();
  };
}
