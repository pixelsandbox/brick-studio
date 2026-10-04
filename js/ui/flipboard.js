/**
 * @fileoverview Split-flap board. Words mode cycles through phrases with each
 * character on a printed tile that flips on a 3D seam (cascading left to
 * right, the board width easing between word lengths). Number mode rolls
 * digits up from 0 once the number scrolls into view. Styles:
 * css/components/flipboard.css.
 *
 * Markup contract
 * ---------------
 *   Words:  <span class="flip" data-flip
 *                 data-flip-words='["Product Designer","UX Designer III at Google","Mentor"]'
 *                 data-flip-interval="2800">Product Designer</span>
 *     data-flip-words     JSON array of phrases (the initial text is used if missing).
 *     data-flip-interval  ms between flips (default 2800, min 1200).
 *     data-flip-case      "upper" prints tiles in capitals (the a11y text keeps its case).
 *     data-flip-live      "off" stops live announcements; the hidden text then lists
 *                         every phrase instead (default: aria-live="polite").
 *   Number: <span data-flip-number="10" data-flip-suffix="+">10+</span>
 *     data-flip-prefix / data-flip-suffix  printed beside the tiles (not flipped).
 *   Tile colours come from --c / --on-c on the element or an ancestor.
 *   The visible tiles are aria-hidden; a visually hidden span carries the text.
 *   The word loop pauses while off-screen, while the tab is hidden and while the
 *   board is hovered or focused (WCAG 2.2.2). Reduced motion: instant swaps.
 *
 * API
 * ---
 *   initFlipboard(root = document, { sound }) -> destroy()
 *     Enhances [data-flip] and [data-flip-number] inside root. Plays 'flip'
 *     (throttled) while tiles turn.
 *   flipController(el) -> { next(), show(i), pause(), resume(), roll() } | null
 *     Imperative access for demos / QA (roll() is number mode only).
 */

import { env } from '../core/utils.js';

const controllers = new WeakMap();
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const glyph = (ch) => (ch === ' ' ? '\u00a0' : ch);

function setFace(part, ch) {
  part.firstChild.textContent = glyph(ch);
  part.classList.toggle('is-blank', ch === ' ');
}

function createTile(ch) {
  const el = document.createElement('span');
  el.className = 'flip__tile';
  const makePart = (cls) => {
    const part = document.createElement('span');
    part.className = cls;
    const chEl = document.createElement('span');
    chEl.className = 'flip__ch';
    part.append(chEl);
    return part;
  };
  const top = makePart('flip__half flip__half--top');
  const bot = makePart('flip__half flip__half--bot');
  const leafTop = makePart('flip__leaf flip__leaf--top');
  const leafBot = makePart('flip__leaf flip__leaf--bot');
  el.append(top, bot, leafTop, leafBot);
  const tile = { el, top, bot, leafTop, leafBot, ch, anims: [] };
  setFace(top, ch);
  setFace(bot, ch);
  el.classList.toggle('is-blank', ch === ' ');
  return tile;
}

function setTile(tile, ch) {
  for (const a of tile.anims) a.cancel();
  tile.anims = [];
  setFace(tile.top, ch);
  setFace(tile.bot, ch);
  tile.ch = ch;
  tile.el.classList.remove('is-flipping');
  tile.el.classList.toggle('is-blank', ch === ' ');
}

/** One flap turn from the tile's current character to `to`. */
async function flipOnce(tile, to, dur, settle) {
  const from = tile.ch;
  setFace(tile.top, to);
  setFace(tile.leafTop, from);
  setFace(tile.leafBot, to);
  tile.el.classList.add('is-flipping');
  if (to !== ' ') tile.el.classList.remove('is-blank');
  const half = dur / 2;
  const fall = tile.leafTop.animate(
    [
      { transform: 'rotateX(0deg)', filter: 'brightness(1)' },
      { transform: 'rotateX(-90deg)', filter: 'brightness(0.55)' },
    ],
    { duration: half, easing: 'cubic-bezier(0.55, 0, 0.9, 0.45)', fill: 'forwards' },
  );
  tile.anims = [fall];
  await fall.finished;
  const land = tile.leafBot.animate(
    settle
      ? [
          { transform: 'rotateX(90deg)', filter: 'brightness(1.5)' },
          { transform: 'rotateX(-14deg)', filter: 'brightness(1)', offset: 0.68 },
          { transform: 'rotateX(5deg)', offset: 0.86 },
          { transform: 'rotateX(0deg)', filter: 'brightness(1)' },
        ]
      : [
          { transform: 'rotateX(90deg)', filter: 'brightness(1.5)' },
          { transform: 'rotateX(0deg)', filter: 'brightness(1)' },
        ],
    { duration: settle ? half * 1.7 : half, easing: 'cubic-bezier(0.2, 0.65, 0.35, 1)', fill: 'forwards' },
  );
  tile.anims = [fall, land];
  await land.finished;
  setTile(tile, to);
}

/** Turns a tile through `sequence` (intermediate characters) and lands on `to`. */
async function flipThrough(tile, sequence, to, { fast = 85, final = 260, onFlip } = {}) {
  for (let i = 0; i < sequence.length; i++) {
    onFlip?.();
    const d = typeof fast === 'function' ? fast(i, sequence.length) : fast;
    await flipOnce(tile, sequence[i], d, false);
  }
  onFlip?.();
  await flipOnce(tile, to, final, true);
}

function randomFor(ch) {
  const set = DIGITS.includes(ch) ? DIGITS : ch === ch.toLowerCase() && ch !== ch.toUpperCase() ? LOWER : UPPER;
  return set[Math.floor(Math.random() * set.length)];
}

/** Creates a throttled 'flip' voice with a per-transition budget. */
function makeVoice(sound, gap = 110) {
  let last = 0;
  let budget = 0;
  return {
    reset(n) {
      budget = n;
    },
    play() {
      const now = performance.now();
      if (!sound || budget <= 0 || now - last < gap) return;
      last = now;
      budget--;
      try {
        sound.play('flip');
      } catch (_) {
        /* optional */
      }
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Words                                                                     */
/* ------------------------------------------------------------------------ */

function createWords(el, { sound } = {}) {
  const reduced = env.reducedMotion;
  const initial = el.textContent.trim().replace(/\s+/g, ' ');
  let words = [];
  try {
    words = JSON.parse(el.getAttribute('data-flip-words') || '[]').map((w) => String(w));
  } catch (_) {
    words = [];
  }
  if (initial && !words.includes(initial)) words.unshift(initial);
  if (!words.length) words = [initial || ' '];
  const interval = Math.max(1200, parseInt(el.getAttribute('data-flip-interval'), 10) || 2800);
  const upper = el.getAttribute('data-flip-case') === 'upper';
  const live = el.getAttribute('data-flip-live') !== 'off';
  const chars = (w) => Array.from(upper ? w.toUpperCase() : w);
  const voice = makeVoice(sound);

  let index = Math.max(0, words.indexOf(initial));
  const original = el.textContent;
  el.textContent = '';
  el.classList.add('flip', 'is-ready');
  const sr = document.createElement('span');
  sr.className = 'flip__sr';
  if (live) {
    sr.setAttribute('aria-live', 'polite');
    sr.textContent = words[index];
  } else {
    sr.textContent = words.join(', ');
  }
  const board = document.createElement('span');
  board.className = 'flip__board';
  board.setAttribute('aria-hidden', 'true');
  el.append(sr, board);

  let tiles = chars(words[index]).map((ch) => createTile(ch));
  tiles.forEach((t) => board.append(t.el));
  let length = tiles.length;
  board.style.setProperty('--n', String(length));

  let alive = true;
  let busy = false;
  let timer = 0;
  const paused = new Set();

  const container = () => {
    let p = el.parentElement;
    while (p && /^(inline|contents)$/.test(getComputedStyle(p).display)) p = p.parentElement;
    return p;
  };

  const fit = () => {
    const parent = container();
    if (!parent) return;
    const cs = getComputedStyle(parent);
    const avail = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const own = getComputedStyle(el);
    const fs = parseFloat(own.fontSize);
    const step = (parseFloat(own.getPropertyValue('--flip-w')) || 0.8) + (parseFloat(own.getPropertyValue('--flip-gap')) || 0.07);
    const longest = Math.max(...words.map((w) => chars(w).length));
    const need = longest * step * fs + 0.2 * fs;
    const s = avail > 0 && need > avail ? Math.max(0.3, avail / need) : 1;
    el.style.setProperty('--flip-fit', s.toFixed(4));
  };

  async function transitionTo(word) {
    const next = chars(word);
    const n = Math.max(tiles.length, next.length);
    while (tiles.length < n) {
      const t = createTile(' ');
      tiles.push(t);
      board.append(t.el);
    }
    if (live) sr.textContent = word;
    if (next.length > length) board.style.setProperty('--n', String(next.length));

    if (reduced) {
      tiles.forEach((t, i) => setTile(t, next[i] ?? ' '));
    } else {
      voice.reset(6);
      const stagger = Math.min(38, 560 / n);
      await Promise.all(
        tiles.map((t, i) => {
          const to = next[i] ?? ' ';
          if (t.ch === to) return null;
          const hops = to === ' ' || t.ch === ' ' ? 1 : 1 + Math.floor(Math.random() * 2);
          const seq = Array.from({ length: hops }, () => (to === ' ' ? randomFor(t.ch === ' ' ? 'A' : t.ch) : randomFor(to)));
          return wait(i * stagger).then(() => flipThrough(t, seq, to, { onFlip: () => voice.play() }));
        }),
      );
    }

    if (next.length < tiles.length) {
      board.style.setProperty('--n', String(next.length));
      if (!reduced) await wait(500);
      if (!alive) return;
      tiles.splice(next.length).forEach((t) => t.el.remove());
    }
    length = next.length;
  }

  const schedule = () => {
    clearTimeout(timer);
    if (!alive || busy || paused.size || words.length < 2) return;
    timer = setTimeout(() => go(index + 1), interval);
  };

  async function go(i) {
    if (!alive || busy) return;
    busy = true;
    clearTimeout(timer);
    index = ((i % words.length) + words.length) % words.length;
    try {
      await transitionTo(words[index]);
    } catch (_) {
      /* cancelled by destroy() */
    }
    busy = false;
    schedule();
  }

  const setPaused = (reason, on) => {
    if (on) paused.add(reason);
    else paused.delete(reason);
    if (on) clearTimeout(timer);
    else schedule();
  };

  const ac = new AbortController();
  const { signal } = ac;
  el.addEventListener('pointerenter', (e) => e.pointerType !== 'touch' && setPaused('hover', true), { signal });
  el.addEventListener('pointerleave', () => setPaused('hover', false), { signal });
  el.addEventListener('focusin', () => setPaused('focus', true), { signal });
  el.addEventListener('focusout', () => setPaused('focus', false), { signal });
  el.addEventListener('click', () => go(index + 1), { signal });
  document.addEventListener('visibilitychange', () => setPaused('hidden', document.hidden), { signal });
  if (document.hidden) paused.add('hidden');

  let io = null;
  if ('IntersectionObserver' in window) {
    paused.add('offscreen');
    io = new IntersectionObserver((entries) => setPaused('offscreen', !entries[entries.length - 1].isIntersecting));
    io.observe(el);
  }

  let ro = null;
  const box = container();
  if ('ResizeObserver' in window && box) {
    ro = new ResizeObserver(fit);
    ro.observe(box);
  }
  fit();
  document.fonts?.ready.then(() => alive && fit());

  const controller = {
    next: () => go(index + 1),
    show: (i) => go(i),
    setWords(newWords) {
      const cleaned = (Array.isArray(newWords) ? newWords : [String(newWords)])
        .map((w) => String(w).trim())
        .filter(Boolean);
      if (!cleaned.length) return;
      words = cleaned;
      el.setAttribute('data-flip-words', JSON.stringify(words));
      fit();
      go(0);
    },
    pause: () => setPaused('api', true),
    resume: () => setPaused('api', false),
    roll: () => {},
    destroy() {
      alive = false;
      clearTimeout(timer);
      ac.abort();
      io?.disconnect();
      ro?.disconnect();
      for (const t of tiles) for (const a of t.anims) a.cancel();
      el.textContent = original;
      el.classList.remove('is-ready');
      el.style.removeProperty('--flip-fit');
      controllers.delete(el);
    },
  };
  controllers.set(el, controller);
  schedule();
  return controller;
}

/* ------------------------------------------------------------------------ */
/* Numbers                                                                   */
/* ------------------------------------------------------------------------ */

function createNumber(el, { sound } = {}) {
  const reduced = env.reducedMotion;
  const target = Math.max(0, Math.round(Number(el.getAttribute('data-flip-number')) || 0));
  const prefix = el.getAttribute('data-flip-prefix') || '';
  const suffix = el.getAttribute('data-flip-suffix') || '';
  const digits = Array.from(String(target));
  const voice = makeVoice(sound, 120);
  const original = el.textContent;

  el.textContent = '';
  el.classList.add('flip', 'flip--number', 'is-ready');
  const sr = document.createElement('span');
  sr.className = 'flip__sr';
  sr.textContent = `${prefix}${target}${suffix}`;
  const board = document.createElement('span');
  board.className = 'flip__board';
  board.setAttribute('aria-hidden', 'true');
  const affix = (text) => {
    const s = document.createElement('span');
    s.className = 'flip__affix';
    s.textContent = text;
    return s;
  };
  if (prefix) board.append(affix(prefix));
  const tiles = digits.map((d) => createTile(reduced ? d : '0'));
  tiles.forEach((t) => board.append(t.el));
  if (suffix) board.append(affix(suffix));
  board.style.setProperty('--n', String(tiles.length));
  el.append(sr, board);

  let rolled = reduced;
  let alive = true;
  const roll = async () => {
    if (!alive) return;
    if (reduced) {
      tiles.forEach((t, i) => setTile(t, digits[i]));
      return;
    }
    rolled = true;
    tiles.forEach((t) => setTile(t, '0'));
    voice.reset(8);
    try {
      await Promise.all(
        tiles.map((tile, i) => {
          const d = Number(digits[i]);
          // Small digits take a full turn of the drum so every tile moves.
          const steps = d + (d < 3 ? 10 : 0);
          if (steps === 0) return null;
          const seq = [];
          for (let k = 1; k < steps; k++) seq.push(String(k % 10));
          const fast = (j, n) => 46 + 150 * Math.pow(j / Math.max(1, n), 3);
          return wait(i * 110).then(() => flipThrough(tile, seq, digits[i], { fast, final: 300, onFlip: () => voice.play() }));
        }),
      );
    } catch (_) {
      /* cancelled */
    }
  };

  let io = null;
  if (!rolled && 'IntersectionObserver' in window) {
    io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          io = null;
          roll();
        }
      },
      { threshold: 0.6 },
    );
    io.observe(el);
  } else if (!rolled) {
    tiles.forEach((t, i) => setTile(t, digits[i]));
  }

  const controller = {
    next() {},
    show() {},
    pause() {},
    resume() {},
    roll,
    destroy() {
      alive = false;
      io?.disconnect();
      for (const t of tiles) for (const a of t.anims) a.cancel();
      el.textContent = original;
      el.classList.remove('is-ready');
      controllers.delete(el);
    },
  };
  controllers.set(el, controller);
  return controller;
}

/* ------------------------------------------------------------------------ */

/**
 * Enhances every [data-flip] and [data-flip-number] inside `root`.
 * @param {Document|Element} [root=document]
 * @param {{sound?: {play(name: string): void}}} [options]
 * @return {function(): void} destroy
 */
export function initFlipboard(root = document, options = {}) {
  const found = [];
  const pick = (sel) => {
    if (root instanceof Element && root.matches(sel)) found.push(root);
    found.push(...root.querySelectorAll(sel));
  };
  pick('[data-flip]');
  const words = found.splice(0).filter((el) => !controllers.has(el)).map((el) => createWords(el, options));
  pick('[data-flip-number]');
  const numbers = found.filter((el) => !controllers.has(el)).map((el) => createNumber(el, options));
  const all = [...words, ...numbers];
  return () => all.forEach((c) => c.destroy());
}

/**
 * @param {Element} el an enhanced [data-flip] / [data-flip-number] element
 * @return {?{next: function(), show: function(number), pause: function(), resume: function(), roll: function()}}
 */
export function flipController(el) {
  return controllers.get(el) || null;
}
