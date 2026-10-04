/**
 * @fileoverview Synthesised UI sounds (WebAudio, no audio files): plastic
 * brick clicks, snaps, pops, a whoosh, split-flap flips, an error buzz and an
 * unlock jingle.
 *
 * Sound is OFF by default. The visitor opts in with a [data-sound-toggle]
 * button; the choice is stored in localStorage ('sp.sound'). Every component
 * receives the shared instance and calls sound.play(name). While sound is off
 * (or before the first user gesture, when browsers refuse to start audio)
 * play() is a cheap no-op.
 *
 * Usage
 *   import { Sound } from './core/sound.js';
 *   const sound = new Sound();
 *   sound.bindToggle(document.querySelector('[data-sound-toggle]'));
 *   sound.play('snap');
 */

const KEY = 'sp.sound';

/** Minimum seconds between two plays of the same sound (rapid-fire guard). */
const MIN_GAP = {
  click: 0.03,
  snap: 0.05,
  pop: 0.05,
  whoosh: 0.25,
  tick: 0.025,
  error: 0.2,
  unlock: 0.5,
  flip: 0.028,
};

/** At most this many voices may start within VOICE_WINDOW seconds. */
const MAX_VOICES = 10;
const VOICE_WINDOW = 0.12;

function readPref() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function writePref(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    /* Private mode: keep the in-memory value only. */
  }
}

/** Small random detune so repeated clicks don't sound machine-gunned. */
const vary = (amount = 0.08) => 1 - amount + Math.random() * amount * 2;

export class Sound {
  constructor() {
    this.enabled = readPref();
    this.ctx = null;
    this.out = null;
    this.noise = null;
    this.last = new Map();
    this.recent = [];
    this.listeners = new Set();
    this.toggles = new Set();
    this._onGesture = () => {
      if (this.enabled) this._ensure();
    };
    // Browsers only start an AudioContext inside a user gesture. If the
    // visitor enabled sound on a previous visit, start it on the first one.
    window.addEventListener('pointerdown', this._onGesture, { passive: true });
    window.addEventListener('keydown', this._onGesture);
  }

  /** @return {boolean} whether sound is currently on */
  get on() {
    return this.enabled;
  }

  /**
   * Turns sound on/off and persists the choice. Call from a user gesture so
   * the AudioContext may start.
   * @param {boolean} on
   */
  setEnabled(on) {
    this.enabled = !!on;
    writePref(this.enabled);
    if (this.enabled) {
      this._ensure();
      // Confirmation blip so the visitor hears that it worked.
      setTimeout(() => this.play('pop'), 30);
    } else if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
    for (const fn of this.listeners) fn(this.enabled);
    this._syncToggles();
  }

  /** Flips the current state. */
  toggle() {
    this.setEnabled(!this.enabled);
  }

  /**
   * Subscribes to on/off changes.
   * @param {function(boolean)} fn
   * @return {function()} unsubscribe
   */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Wires a toggle button: aria-pressed, an optional [data-sound-label]
   * child ("Sound on" / "Sound off") and the click handler.
   * @param {?HTMLElement} button
   * @return {function()} destroy
   */
  bindToggle(button) {
    if (!button) return () => {};
    const onClick = () => this.toggle();
    button.addEventListener('click', onClick);
    this.toggles.add(button);
    this._syncToggles();
    return () => {
      button.removeEventListener('click', onClick);
      this.toggles.delete(button);
    };
  }

  _syncToggles() {
    for (const btn of this.toggles) {
      btn.setAttribute('aria-pressed', String(this.enabled));
      btn.dataset.state = this.enabled ? 'on' : 'off';
      const label = btn.querySelector('[data-sound-label]');
      if (label) label.textContent = this.enabled ? 'Sound on' : 'Sound off';
    }
  }

  /** Lazily builds the audio graph: voices -> gain -> compressor -> out. */
  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        return null;
      }
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      comp.connect(this.ctx.destination);
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.55;
      this.out.connect(comp);
      // One second of white noise, reused by every noisy voice.
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  /**
   * Plays a named sound. Unknown names, rapid repeats and calls while sound
   * is off are ignored.
   * @param {string} name click|snap|pop|whoosh|tick|error|unlock|flip
   * @param {{volume: (number|undefined)}=} opts
   */
  play(name, { volume = 1 } = {}) {
    if (!this.enabled || document.hidden) return;
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const gap = MIN_GAP[name];
    if (gap === undefined) return;
    if (now - (this.last.get(name) ?? -1) < gap) return;
    this.recent = this.recent.filter((t) => now - t < VOICE_WINDOW);
    if (this.recent.length >= MAX_VOICES) return;
    this.last.set(name, now);
    this.recent.push(now);
    const t = now + 0.004;
    const v = Math.max(0, Math.min(volume, 1.5));
    switch (name) {
      case 'click': this._click(t, v); break;
      case 'snap': this._snap(t, v); break;
      case 'pop': this._pop(t, v); break;
      case 'whoosh': this._whoosh(t, v); break;
      case 'tick': this._tick(t, v); break;
      case 'error': this._error(t, v); break;
      case 'unlock': this._unlock(t, v); break;
      case 'flip': this._flip(t, v); break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- voices

  /** Filtered noise burst with a fast exponential decay. */
  _burst(t, { type = 'bandpass', freq = 2500, q = 1, dur = 0.02, gain = 0.4 }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(gain, t + 0.0015);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(amp).connect(this.out);
    src.start(t, Math.random() * 0.8);
    src.stop(t + dur + 0.03);
  }

  /** Oscillator with an exponential pitch glide and a percussive envelope. */
  _tone(t, { type = 'sine', f0 = 440, f1 = f0, dur = 0.1, gain = 0.2, attack = 0.003 }) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(gain, t + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(this.out);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  _click(t, v) {
    const r = vary();
    this._burst(t, { freq: 3200 * r, q: 1.4, dur: 0.024, gain: 0.5 * v });
    this._tone(t, { f0: 2100 * r, f1: 1500 * r, dur: 0.02, gain: 0.1 * v });
  }

  /** Two plastic transients and a low body thunk: the "tk-tchk" of a brick. */
  _snap(t, v) {
    const r = vary();
    this._burst(t, { freq: 2500 * r, q: 1, dur: 0.018, gain: 0.55 * v });
    this._tone(t, { type: 'triangle', f0: 230 * r, f1: 120 * r, dur: 0.06, gain: 0.32 * v });
    this._burst(t + 0.022, { freq: 4200 * r, q: 2, dur: 0.02, gain: 0.32 * v });
  }

  _pop(t, v) {
    const r = vary(0.05);
    this._tone(t, { f0: 320 * r, f1: 980 * r, dur: 0.075, gain: 0.36 * v, attack: 0.002 });
    this._burst(t, { freq: 1800, q: 0.8, dur: 0.03, gain: 0.14 * v });
  }

  /** Band-passed noise sweeping up then down. */
  _whoosh(t, v) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.9;
    filter.frequency.setValueAtTime(350, t);
    filter.frequency.exponentialRampToValueAtTime(1800, t + 0.2);
    filter.frequency.exponentialRampToValueAtTime(500, t + 0.5);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(0.26 * v, t + 0.17);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
    src.connect(filter).connect(amp).connect(this.out);
    src.start(t);
    src.stop(t + 0.56);
  }

  _tick(t, v) {
    this._burst(t, { type: 'highpass', freq: 5000, q: 0.7, dur: 0.009, gain: 0.22 * v });
    this._tone(t, { type: 'square', f0: 3200, f1: 3000, dur: 0.01, gain: 0.025 * v });
  }

  _error(t, v) {
    this._tone(t, { type: 'triangle', f0: 330, f1: 320, dur: 0.09, gain: 0.24 * v });
    this._tone(t + 0.11, { type: 'triangle', f0: 247, f1: 238, dur: 0.15, gain: 0.24 * v });
  }

  /** A snap, then a bright rising arpeggio (C6 E6 G6 + C7 sparkle). */
  _unlock(t, v) {
    this._snap(t, v);
    [1046.5, 1318.5, 1568].forEach((f, i) => {
      this._tone(t + 0.06 + i * 0.07, { type: 'triangle', f0: f, dur: 0.24, gain: 0.16 * v });
    });
    this._tone(t + 0.28, { f0: 2093, dur: 0.3, gain: 0.07 * v });
  }

  /** Split-flap: a papery flutter plus a tiny click. */
  _flip(t, v) {
    const r = vary();
    this._burst(t, { freq: 1400 * r, q: 1.2, dur: 0.03, gain: 0.28 * v });
    this._burst(t + 0.012, { freq: 3000 * r, q: 2, dur: 0.012, gain: 0.18 * v });
  }

  /** Releases the audio graph and listeners. */
  dispose() {
    window.removeEventListener('pointerdown', this._onGesture);
    window.removeEventListener('keydown', this._onGesture);
    this.listeners.clear();
    this.toggles.clear();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
