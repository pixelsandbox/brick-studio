/**
 * @fileoverview Entry point for the Modular 3D Brick Hero Component.
 *
 * Boots the shared requestAnimationFrame loop, theme, sound, UI widgets
 * (press buttons, custom stud cursor, tooltips, split-flap role board),
 * the 3D WebGL LEGO stage, and the interactive "Build your name" customizer modal.
 */

import { $, $$, env } from './core/utils.js';
import { raf } from './core/raf.js';
import { Sound } from './core/sound.js';
import { initTheme, getTheme } from './ui/theme.js';
import { initPress, setButtonState } from './ui/press.js';
import { initCursor } from './ui/cursor.js';
import { initTooltip } from './ui/tooltip.js';
import { initFlipboard, flipController } from './ui/flipboard.js';
import { HERO_CONFIG } from './config.js';
import { sanitizeWord, PALETTES, MAX_WORD_LEN } from './webgl/models.js';

const root = document.documentElement;
const qa = env.qa;
const params = env.params;

const VALID_PALETTES = new Set(Object.keys(PALETTES));

function resolveInitialConfig() {
  const heroEl = $('.hero');
  const attrWord = heroEl?.dataset.brickWord;
  const attrPalette = heroEl?.dataset.brickPalette;
  const attrMinifig = heroEl?.dataset.minifig;

  const rawWord = params.get('word') || attrWord || HERO_CONFIG.brickWord || 'SUJIT';
  const rawPalette = params.get('palette') || attrPalette || HERO_CONFIG.brickPalette || 'classic';
  const rawMinifig = params.get('minifig');

  let showMinifig = HERO_CONFIG.showMinifig !== false;
  if (rawMinifig !== null) {
    showMinifig = rawMinifig !== '0' && rawMinifig !== 'false';
  } else if (attrMinifig !== undefined) {
    showMinifig = attrMinifig !== '0' && attrMinifig !== 'false';
  }

  return {
    ...HERO_CONFIG,
    brickWord: sanitizeWord(rawWord, 'SUJIT'),
    brickPalette: VALID_PALETTES.has(rawPalette) ? rawPalette : 'classic',
    showMinifig,
    name: (params.get('name') || HERO_CONFIG.name || 'Brick Hero.').slice(0, 40),
    kicker: (params.get('kicker') || HERO_CONFIG.kicker || 'Open-Source Modular Hero Component').slice(0, 60),
  };
}

const state = resolveInitialConfig();

const app = {
  sound: new Sound(),
  stage: null,
  ui: {},
  state,
  errors: [],
};
window.__app = app;

if (qa) {
  raf.maxDt = 0.5;
  const log = (msg) => app.errors.push(String(msg));
  window.addEventListener('error', (e) => log(e.message));
  window.addEventListener('unhandledrejection', (e) => log(e.reason?.message || e.reason));
  window.addEventListener('app-error', (e) => log(e.detail?.message || e.detail));
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

const COMPONENTS = [
  ['press', initPress],
  ['cursor', initCursor],
  ['tooltip', initTooltip],
  ['flipboard', initFlipboard],
];

boot().catch((err) => {
  console.error(err);
  root.classList.add('is-ready');
});

async function boot() {
  initTheme({ sound: app.sound });
  $$('[data-sound-toggle]').forEach((btn) => app.sound.bindToggle(btn));

  applyHeroCopy(state);
  raf.start();

  const components = initComponents();
  const stage = params.has('nogl') ? Promise.resolve(noWebGL()) : initStage();

  await Promise.race([Promise.allSettled([stage, components]), wait(qa ? 10000 : 3000)]);

  root.classList.add('is-ready');
  app.stage?.intro?.();

  initHeroInteractions();
  initCustomizerModal();
  exposePublicApi();

  await Promise.allSettled([stage, components]);

  if (qa) {
    await nextFrame();
    await nextFrame();
    root.dataset.qaReady = '1';
  }
}

async function initComponents() {
  for (const [key, init] of COMPONENTS) {
    try {
      app.ui[key] = init(document, { sound: app.sound });
    } catch (err) {
      app.errors.push(`[ui:${key}] ${err?.stack || err?.message || err}`);
      console.warn(`[ui:${key}]`, err);
    }
  }
}

// ---------------------------------------------------------------- 3D stage

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

function noWebGL() {
  root.classList.add('no-webgl');
  return null;
}

async function initStage() {
  if (!webglAvailable()) return noWebGL();
  try {
    const { Stage } = await import('./webgl/stage.js');
    const stage = new Stage({
      canvas: $('#stage'),
      theme: getTheme(),
      word: state.brickWord,
      palette: state.brickPalette,
      showMinifig: state.showMinifig,
      sound: app.sound,
    });
    await stage.init();
    app.stage = stage;
    raf.add((t, dt) => stage.update(t, dt));
    if (root.classList.contains('is-ready')) stage.intro?.();
    window.addEventListener('resize', () => stage.resize());
    window.addEventListener('themechange', (e) => stage.setTheme(e.detail.theme));
    return stage;
  } catch (err) {
    console.error('[stage]', err);
    return noWebGL();
  }
}

// ------------------------------------------------------------ DOM & Config

function applyHeroCopy(cfg) {
  if (cfg.brandName !== undefined) {
    const brandEl = $('#brand-name');
    if (brandEl) brandEl.textContent = String(cfg.brandName);
  }
  if (cfg.badgeNumber !== undefined) {
    const badgeNum = $('#hero-badge-num');
    if (badgeNum) badgeNum.textContent = String(cfg.badgeNumber);
  }
  if (cfg.badgeUnit !== undefined) {
    const badgeUnit = $('#hero-badge-unit');
    if (badgeUnit) badgeUnit.textContent = String(cfg.badgeUnit);
  }
  if (cfg.kicker !== undefined) {
    const kickerEl = $('#hero-kicker');
    if (kickerEl) kickerEl.textContent = String(cfg.kicker);
  }
  if (cfg.greeting !== undefined) {
    const greetEl = $('#hero-greeting');
    if (greetEl) greetEl.textContent = String(cfg.greeting);
  }
  if (cfg.name !== undefined) {
    const nameEl = $('#hero-name');
    if (nameEl) nameEl.textContent = String(cfg.name);
  }
  if (cfg.roleLabel !== undefined) {
    const roleLabelEl = $('#hero-role-label');
    if (roleLabelEl) roleLabelEl.textContent = String(cfg.roleLabel);
  }
  if (Array.isArray(cfg.roles) && cfg.roles.length) {
    const flipEl = $('#hero-flip');
    if (flipEl) {
      const ctrl = flipController(flipEl);
      if (ctrl && typeof ctrl.setWords === 'function') {
        ctrl.setWords(cfg.roles);
      } else {
        flipEl.setAttribute('data-flip-words', JSON.stringify(cfg.roles));
        flipEl.textContent = cfg.roles[0];
      }
    }
  }
  if (cfg.taglinePrefix !== undefined) {
    const prefixEl = $('#hero-tagline-prefix');
    if (prefixEl) prefixEl.textContent = String(cfg.taglinePrefix);
  }
  if (cfg.taglineAccent !== undefined) {
    const accentEl = $('#hero-tagline-accent');
    if (accentEl) accentEl.textContent = String(cfg.taglineAccent);
  }
  if (cfg.taglineSuffix !== undefined) {
    const suffixEl = $('#hero-tagline-suffix');
    if (suffixEl) suffixEl.textContent = String(cfg.taglineSuffix);
  }
  if (cfg.ctaLabel) {
    const ctaBtn = $('#hero-cta');
    if (ctaBtn) {
      const labelSpan = ctaBtn.querySelector('.btn-brick__label') || ctaBtn;
      labelSpan.textContent = String(cfg.ctaLabel);
    }
  }
  if (cfg.authorName) {
    const authorEl = $('#footer-author');
    if (authorEl) {
      authorEl.textContent = String(cfg.authorName);
      if (typeof cfg.authorUrl === 'string' && /^https?:\/\//i.test(cfg.authorUrl)) {
        authorEl.setAttribute('href', cfg.authorUrl);
      }
    }
  }
  syncWordBadges(cfg.brickWord || state.brickWord);
}

function syncWordBadges(word) {
  const clean = sanitizeWord(word, state.brickWord);
  const topbarWord = $('#topbar-word-value');
  if (topbarWord) topbarWord.textContent = clean;
  const heroEl = $('.hero');
  if (heroEl) heroEl.dataset.brickWord = clean;
  $$('[data-word-preset]').forEach((chip) => {
    chip.classList.toggle('is-active', chip.dataset.wordPreset === clean);
  });
}

function syncPaletteUI(palette) {
  const heroEl = $('.hero');
  if (heroEl) heroEl.dataset.brickPalette = palette;
  $$('[data-palette-option]').forEach((btn) => {
    const active = btn.dataset.paletteOption === palette;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
}

// -------------------------------------------------- Stage & Hero Interactions

function initHeroInteractions() {
  $$('[data-stage-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.stageAction;
      if (action === 'rebuild') app.stage?.rebuild();
      else if (action === 'smash') app.stage?.smash();
      else if (action === 'wave') app.stage?.triggerMinifigWave();
    });
  });

  // Keyboard shortcuts when not typing in an input or modal
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const modal = $('#customizer-modal');
    if (modal?.open) return;

    const key = e.key.toLowerCase();
    if (key === 'r') {
      e.preventDefault();
      app.stage?.rebuild();
    } else if (key === ' ') {
      e.preventDefault();
      app.stage?.smash();
    } else if (key === 'w') {
      e.preventDefault();
      app.stage?.triggerMinifigWave();
    } else if (key === 'c') {
      e.preventDefault();
      openCustomizer();
    }
  });
}

// -------------------------------------------------- Customizer Modal

function openCustomizer() {
  const modal = /** @type {HTMLDialogElement|null} */ ($('#customizer-modal'));
  if (!modal) return;
  const wordInput = /** @type {HTMLInputElement|null} */ ($('#input-brick-word'));

  if (wordInput) {
    wordInput.value = state.brickWord;
    updateWordCounter(wordInput.value);
  }
  syncWordBadges(state.brickWord);
  syncPaletteUI(state.brickPalette);

  app.sound.play('pop');
  if (typeof modal.showModal === 'function' && !modal.open) {
    modal.showModal();
  } else {
    modal.setAttribute('open', '');
  }
  wordInput?.focus();
  wordInput?.select();
}

function closeCustomizer() {
  const modal = /** @type {HTMLDialogElement|null} */ ($('#customizer-modal'));
  if (!modal) return;
  app.sound.play('click');
  if (typeof modal.close === 'function' && modal.open) {
    modal.close();
  } else {
    modal.removeAttribute('open');
  }
}

function updateWordCounter(val) {
  const counter = $('#word-char-count');
  if (!counter) return;
  const clean = sanitizeWord(val, '');
  counter.textContent = `${clean.length} / ${MAX_WORD_LEN}`;
}

function applyBrickSettings({ word, palette, showMinifig, drop = false }) {
  if (word !== undefined) state.brickWord = sanitizeWord(word, state.brickWord);
  if (palette !== undefined && VALID_PALETTES.has(palette)) state.brickPalette = palette;
  if (showMinifig !== undefined) state.showMinifig = Boolean(showMinifig);

  syncWordBadges(state.brickWord);
  syncPaletteUI(state.brickPalette);

  app.stage?.setWord(state.brickWord, {
    palette: state.brickPalette,
    showMinifig: state.showMinifig,
    drop,
  });
}

function initCustomizerModal() {
  const modal = /** @type {HTMLDialogElement|null} */ ($('#customizer-modal'));
  if (!modal) return;

  const form = $('#customizer-form');
  const wordInput = /** @type {HTMLInputElement|null} */ ($('#input-brick-word'));

  $$('[data-open-customizer]').forEach((btn) => {
    btn.addEventListener('click', () => openCustomizer());
  });

  $$('[data-close-customizer]').forEach((btn) => {
    btn.addEventListener('click', () => closeCustomizer());
  });

  // Close when clicking the backdrop outside .customizer__panel
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeCustomizer();
  });

  // Word input live counter
  wordInput?.addEventListener('input', () => {
    updateWordCounter(wordInput.value);
  });

  // Preset word chips
  $$('[data-word-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const preset = chip.dataset.wordPreset || 'SUJIT';
      if (wordInput) {
        wordInput.value = preset;
        updateWordCounter(preset);
      }
      applyBrickSettings({ word: preset });
    });
  });

  // Palette buttons
  $$('[data-palette-option]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const palette = btn.dataset.paletteOption || 'classic';
      app.sound.play('click');
      applyBrickSettings({ palette });
    });
  });

  // Form submit ("Snap Bricks")
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nextWord = sanitizeWord(wordInput?.value || state.brickWord, 'SUJIT');
    if (wordInput) {
      wordInput.value = nextWord;
      updateWordCounter(nextWord);
    }
    applyBrickSettings({
      word: nextWord,
      drop: true,
    });
    closeCustomizer();
  });
}

// -------------------------------------------------- Public Modular API

function exposePublicApi() {
  window.LegoHero = {
    /**
     * Dynamically changes the 3D LEGO word on the baseplate.
     * @param {string} word 1-10 characters (e.g. 'SUJIT', 'ALEX')
     * @param {{palette?: string, showMinifig?: boolean, drop?: boolean}} [opts]
     */
    setWord(word, opts = {}) {
      applyBrickSettings({
        word,
        palette: opts.palette,
        showMinifig: opts.showMinifig,
        drop: opts.drop,
      });
      return state.brickWord;
    },

    /**
     * Updates any hero configuration properties (word, palette, copy, roles).
     * @param {Partial<typeof HERO_CONFIG>} nextConfig
     */
    configure(nextConfig = {}) {
      Object.assign(state, nextConfig);
      applyHeroCopy(state);
      if (
        nextConfig.brickWord !== undefined ||
        nextConfig.brickPalette !== undefined ||
        nextConfig.showMinifig !== undefined
      ) {
        applyBrickSettings({
          word: state.brickWord,
          palette: state.brickPalette,
          showMinifig: state.showMinifig,
        });
      }
    },

    /** Drops all bricks from the sky in a fresh assembly animation. */
    rebuild: () => app.stage?.rebuild(),

    /** Knocks the LEGO word apart with 3D rigid-body physics. */
    smash: () => app.stage?.smash(),

    /** Makes the minifigure wave, jump & cycle facial expressions. */
    wave: () => app.stage?.triggerMinifigWave(),

    /** Opens the interactive "Build your name" customizer modal. */
    openCustomizer,

    /** Closes the customizer modal. */
    closeCustomizer,

    /** Returns a snapshot of the current hero configuration. */
    getConfig: () => ({ ...state }),
  };
}
