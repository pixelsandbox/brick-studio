/**
 * @fileoverview Light/dark theme.
 *
 * The inline script in <head> sets html[data-theme] before first paint
 * (?theme= override, then localStorage 'sp.theme', then the OS preference).
 * This module wires every [data-theme-toggle] button, persists the choice,
 * keeps <meta name="theme-color"> in sync and dispatches a window
 * 'themechange' CustomEvent ({detail: {theme}}) that the WebGL stage, the
 * builder and the UI components listen to.
 *
 * Where the View Transitions API exists, the new theme is revealed as a
 * circle growing from the button (CSS in main.css: html.is-theme-vt).
 */
import { env } from '../core/utils.js';

const KEY = 'sp.theme';
const META_COLOR = { light: '#f4f1ea', dark: '#111418' };

/** @return {'light'|'dark'} */
export const getTheme = () =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Applies a theme immediately and notifies listeners.
 * @param {'light'|'dark'} theme
 * @param {{persist: (boolean|undefined)}=} opts
 */
export function applyTheme(theme, { persist = true } = {}) {
  const root = document.documentElement;
  const next = theme === 'dark' ? 'dark' : 'light';
  if (persist) {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
  }
  if (root.dataset.theme === next) return;
  root.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', META_COLOR[next]);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
}

/**
 * Wires the theme toggle buttons.
 * @param {{sound: (?Object|undefined)}=} opts
 * @return {function()} destroy
 */
export function initTheme({ sound = null } = {}) {
  const root = document.documentElement;
  const buttons = Array.from(document.querySelectorAll('[data-theme-toggle]'));

  const sync = () => {
    const dark = getTheme() === 'dark';
    for (const btn of buttons) {
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      const label = btn.querySelector('[data-theme-label]');
      if (label) label.textContent = dark ? 'Dark' : 'Light';
    }
  };

  const onClick = (event) => {
    const btn = event.currentTarget;
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    sound?.play('click');
    if (!document.startViewTransition || env.reducedMotion) {
      applyTheme(next);
      return;
    }
    // Circle reveal from the centre of the button that was pressed.
    const r = btn.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    root.style.setProperty('--vt-x', `${x}px`);
    root.style.setProperty('--vt-y', `${y}px`);
    root.style.setProperty('--vt-r', `${radius}px`);
    root.classList.add('is-theme-vt');
    try {
      const vt = document.startViewTransition(() => applyTheme(next));
      vt.finished.finally(() => root.classList.remove('is-theme-vt'));
    } catch {
      root.classList.remove('is-theme-vt');
      applyTheme(next);
    }
  };

  for (const btn of buttons) btn.addEventListener('click', onClick);
  window.addEventListener('themechange', sync);
  sync();

  // Follow the OS setting until the visitor picks a theme explicitly.
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onSystem = (e) => {
    if (!stored() && !env.params.has('theme')) {
      applyTheme(e.matches ? 'dark' : 'light', { persist: false });
    }
  };
  mq.addEventListener?.('change', onSystem);

  return () => {
    for (const btn of buttons) btn.removeEventListener('click', onClick);
    window.removeEventListener('themechange', sync);
    mq.removeEventListener?.('change', onSystem);
  };
}
