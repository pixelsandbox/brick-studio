// The site's fixed WebGL stage: one full-viewport canvas behind the Hero section
// in which a pool of real-looking LEGO bricks assembles into any custom word
// (default "SUJIT"), responds to pointer parallax, and can be poked, knocked
// apart, dragged, thrown, and rebuilt with 3D rigid-body physics.

import * as THREE from 'three';
import { GAP, STUD_H, brickGeometry, plasticMaterial, setupRenderer, createEnvironment, createLights } from './bricks.js';
import { BRICK, THEMES } from './palette.js';
import { clamp, damp, env } from '../core/utils.js';
import { store } from '../core/store.js';
import { buildModels, heroModel, sanitizeWord, typeInfo, footprint } from './models.js';
import { Physics } from './physics.js';
import { Post, PerfMonitor, detectTier } from './post.js';

const DEG = Math.PI / 180;
const FOV = 30;
const CAM_Z = 100;
const TAN = Math.tan((FOV / 2) * DEG);
const MARGIN = 0.06;
const MIN_VIS = 0.3;
const SLOTS = ['hero'];
const LAND = 0.8; // share of a flight spent travelling; the rest is the click-in squash
const IDLE_RETURN = 2.5; // s without interaction before knocked bricks glide home
const KNOCK_R = 3.5;
const TUCK = 0.75;
const SOUND_GAP = 1000 / 12; // ms; at most ~12 of the same sound per second
const LIGHT_DIR = new THREE.Vector3(-0.42, 1, 0.58).normalize();

const UP = new THREE.Vector3(0, 1, 0);
const Q90 = new THREE.Quaternion().setFromAxisAngle(UP, Math.PI / 2);
const Q0 = new THREE.Quaternion();
const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeIn = (t) => t * t;
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const smooth = (t) => t * t * (3 - 2 * t);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Small deterministic PRNG so layouts/jitter are identical between loads. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bezier(out, p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return out.set(
    p0.x * a + p1.x * b + p2.x * c + p3.x * d,
    p0.y * a + p1.y * b + p2.y * c + p3.y * d,
    p0.z * a + p1.z * b + p2.z * c + p3.z * d,
  );
}

/** Position + rotation + uniform scale (bricks are built bottom-centred). */
class Pose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.scl = 1;
  }

  copy(p) {
    this.pos.copy(p.pos);
    this.quat.copy(p.quat);
    this.scl = p.scl;
    return this;
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _n3 = new THREE.Matrix3();
const _s = new THREE.Vector3();
const _ray = new THREE.Ray();
const _plane = new THREE.Plane();
const _A = new Pose();
const _B = new Pose();
const _L = new Pose();

/** Placement of one slot's model in world space. */
class Frame {
  constructor(key, box) {
    this.key = key;
    this.box = box;
    this.pivot = box.getCenter(new THREE.Vector3());
    this.rect = { x: 0, y: 0, w: 0, h: 0 };
    this.valid = false;
    this.vis = 0;
    this.fitted = false;
    this.sig = '';
    this.pos = new THREE.Vector3();
    this.scale = 1;
    this.baseQuat = new THREE.Quaternion();
    this.quat = new THREE.Quaternion();
    this.par = { x: 0, y: 0, w: 0 };
    this.orbit = { yaw: 0, tilt: 0, targetYaw: 0, targetTilt: 0 };
    this.matrix = new THREE.Matrix4();
    this.inverse = new THREE.Matrix4();
  }

  setBox(box) {
    this.box.copy(box);
    this.pivot.copy(box.getCenter(_v));
    this.fitted = false;
    this.sig = '';
  }

  compose() {
    _m2.makeTranslation(-this.pivot.x, -this.pivot.y, -this.pivot.z);
    this.matrix.compose(this.pos, this.quat, _s.set(this.scale, this.scale, this.scale)).multiply(_m2);
    this.inverse.copy(this.matrix).invert();
  }

  toWorld(local, out) {
    out.pos.copy(local.pos).sub(this.pivot).multiplyScalar(this.scale).applyQuaternion(this.quat).add(this.pos);
    out.quat.copy(this.quat).multiply(local.quat);
    out.scl = local.scl * this.scale;
    return out;
  }
}

/** Soft contact shadow: the model's ground footprint, blurred, as alpha. */
function contactTexture(rects, minX, maxX, minZ, maxZ, ppu = 8) {
  const W = Math.max(4, Math.ceil((maxX - minX) * ppu));
  const H = Math.max(4, Math.ceil((maxZ - minZ) * ppu));
  let a = new Float32Array(W * H);
  for (const [x0, x1, z0, z1, k] of rects) {
    for (let j = Math.floor((z0 - minZ) * ppu); j < Math.ceil((z1 - minZ) * ppu); j++) {
      for (let i = Math.floor((x0 - minX) * ppu); i < Math.ceil((x1 - minX) * ppu); i++) {
        if (i >= 0 && j >= 0 && i < W && j < H) a[j * W + i] = Math.max(a[j * W + i], k);
      }
    }
  }
  const r = Math.max(1, Math.round(ppu * 0.9));
  const tmp = new Float32Array(W * H);
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < H; j++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += a[j * W + clamp(i, 0, W - 1)];
      for (let i = 0; i < W; i++) {
        tmp[j * W + i] = acc / (2 * r + 1);
        acc += a[j * W + clamp(i + r + 1, 0, W - 1)] - a[j * W + clamp(i - r, 0, W - 1)];
      }
    }
    for (let i = 0; i < W; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += tmp[clamp(j, 0, H - 1) * W + i];
      for (let j = 0; j < H; j++) {
        a[j * W + i] = acc / (2 * r + 1);
        acc += tmp[clamp(j + r + 1, 0, H - 1) * W + i] - tmp[clamp(j - r, 0, H - 1) * W + i];
      }
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) data[((H - 1 - j) * W + i) * 4 + 3] = Math.round(Math.min(1, a[j * W + i]) * 255);
  }
  const tex = new THREE.DataTexture(data, W, H);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  a = null;
  return tex;
}

const EXPRESSIONS = ['grin', 'wink', 'surprised', 'smile'];

export class Stage {
  /**
   * @param {{canvas: HTMLCanvasElement, theme?: 'light'|'dark',
   *   word?: string, palette?: string|string[], showMinifig?: boolean,
   *   sound?: {play: (name: 'click'|'snap'|'pop'|'whoosh'|'tick') => void}|null}} opts
   */
  constructor({
    canvas,
    theme = 'light',
    word = 'SUJIT',
    palette = 'classic',
    showMinifig = true,
    sound = null,
  }) {
    this.canvas = canvas;
    this.sound = sound;
    this.word = sanitizeWord(word);
    this.palette = palette || 'classic';
    this.showMinifig = showMinifig !== false;
    this.ready = false;
    this.frames = 0;
    this.tier = 0;
    /** Object3D on the hero baseplate, right of the letters (minifigure spot). */
    this.heroAnchor = new THREE.Object3D();
    this.heroAnchor.name = 'heroAnchor';
    this.minifig = null;
    this._exprIdx = 0;
    this._theme = THEMES[theme] ? theme : 'light';
    this._reduced = env.reducedMotion;
    this._disposed = false;
    this._dirty = true;
    this._time = 0;
    this._active = null;
    this._shown = null;
    this._lastShown = null;
    this._slots = new Map();
    this._bound = new WeakSet();
    this._frames = {};
    this._grounds = {};
    this._bricks = [];
    this._byType = new Map();
    this._session = null;
    this._lastInteract = -1e9;
    this._sounds = new Map();
    this._intro = this._reduced ? 'done' : 'pending';
    this._introRequested = false;
    this._forced = undefined;
    this._rescan = 0;
    this._renderedLast = false;
    this._focusScale = 1;
    this._fig = { wrap: null, presence: 0, target: 0, waved: false, busyUntil: 0 };
    this._ptr = {
      x: -1,
      y: -1,
      slot: null,
      inside: false,
      moved: false,
      type: 'mouse',
      down: null,
      drag: null,
      grabbing: false,
      hover: null,
      speed: 0,
      vx: 0,
      vy: 0,
      lastT: 0,
    };
    this._listeners = [];
    this._rand = mulberry32(20241002);
    this._poolRand = mulberry32(77);
    this._nextBrickId = 0;
    this._raycaster = new THREE.Raycaster();
    this._viewProj = new THREE.Matrix4();
    this._vw = 1;
    this._vh = 1;
    this._aspect = 1;
    this._canvasRect = { left: 0, top: 0 };
    this.debug = {
      finish: () => this._finishAll(),
      knock: (fx = 0.5, fy = 0.55) => this._debugKnock(fx, fy),
      force: (name) => {
        this._forced = name;
      },
      state: () => this._debugState(),
    };
  }

  /** Builds the scene and compiles shaders; resolves once a frame has rendered. */
  async init() {
    const r = setupRenderer(this.canvas, { alpha: false, antialias: true, shadows: true });
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 10, 420);
    this.camera.position.set(0, 0, CAM_Z);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this._env = createEnvironment(r);
    this.scene.environment = this._env;
    this.lights = createLights(this.scene, { shadowSize: 20, mapSize: 2048 });
    this.lights.key.shadow.radius = 3;
    this.tier = detectTier(r);
    this._tierForced = env.params.has('tier');
    this.material = this._makeMaterial();
    this.models = buildModels({
      word: this.word,
      palette: this.palette,
      showMinifig: this.showMinifig,
    });
    this._buildPool();
    for (const key of SLOTS) {
      const box = this._boxOf(this.models[key].bounds);
      this._frames[key] = new Frame(key, box);
    }
    this._buildGrounds();
    this._heroGroup = new THREE.Group();
    this._heroGroup.matrixAutoUpdate = false;
    const a = this.models.hero.anchor;
    this.heroAnchor.position.set(a.x, a.y, a.z);
    this._heroGroup.add(this.heroAnchor);
    this.scene.add(this._heroGroup);
    this.physics = new Physics({ gravity: 70, onImpact: (s) => this._play(s > 10 ? 'click' : 'tick') });
    this.post = new Post({
      renderer: r,
      scene: this.scene,
      camera: this.camera,
      bg: THEMES[this._theme].bg,
      onChange: () => {
        this._dirty = true;
      },
    });
    this.perf = new PerfMonitor({ budgetMs: 22, windowSec: 2 });
    this.resize();
    await this.post.setTier(this.tier);
    this._applyTierSettings();
    this._applyTheme();
    this._scanSlots();
    this._bindGlobal();
    this._loadMinifig();
    try {
      if (r.compileAsync) await Promise.race([r.compileAsync(this.scene, this.camera), wait(6000)]);
    } catch {
      // Compilation will simply happen on the first render.
    }
    if (this._disposed) return;
    this.ready = true;
    this._readyAt = this._time;
    this._readSlots();
    this._updateFrames(0);
    this._tickBricks(0);
    this._writeInstances();
    this._render(0);
  }

  // ---------------------------------------------------------------- setup

  _makeMaterial() {
    const m = plasticMaterial();
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vJit;')
        .replace(
          '#include <begin_vertex>',
          [
            '#include <begin_vertex>',
            '#if defined(USE_INSTANCING) && __VERSION__ >= 300',
            '  vJit = fract(sin(float(gl_InstanceID) * 12.9898 + 4.1414) * 43758.5453);',
            '#else',
            '  vJit = 0.5;',
            '#endif',
          ].join('\n'),
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vJit;')
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + (vJit - 0.5) * 0.16, 0.08, 1.0);',
        );
    };
    m.customProgramCacheKey = () => 'stage-plastic-jitter';
    return m;
  }

  _boxOf(b) {
    return new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
  }

  /**
   * Builds a generous pool of the brick types used in heroModel so that
   * words of up to 10 characters can be rebuilt on the fly without reallocating.
   */
  _buildPool() {
    const basePool = new Map([
      ['b1x2', 120],
      ['b2x2', 120],
      ['b2x4', 80],
      ['p2x4', 56],
      ['p2x2', 12],
      ['b1x1', 8],
      ['p1x1', 8],
    ]);
    for (const e of this.models.hero.bricks) {
      const count = this.models.hero.bricks.filter((x) => x.t === e.t).length;
      basePool.set(e.t, Math.max(basePool.get(e.t) || 0, count + 8));
    }
    for (const [t, n] of basePool) {
      this._createTypeMesh(t, n);
    }
    this.poolSize = this._bricks.length;
  }

  _createTypeMesh(t, n) {
    const info = typeInfo(t);
    const geo = brickGeometry(info.w, info.d, {
      h: info.h,
      studs: info.studs,
      hollow: !info.big,
      studSegments: info.big ? 12 : 18,
    });
    const mesh = new THREE.InstancedMesh(geo, this.material, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `pool:${t}`;
    const list = [];
    const rand = this._poolRand;
    for (let i = 0; i < n; i++) {
      const b = {
        id: this._nextBrickId++,
        t,
        info,
        mesh,
        index: i,
        half: [(info.w - GAP) / 2, (info.h - GAP) / 2, (info.d - GAP) / 2],
        mode: 'park',
        model: null,
        entry: -1,
        rain: false,
        wp: new Pose(),
        lp: new Pose(),
        matrix: new THREE.Matrix4(),
        hidden: false,
        color: new THREE.Color(BRICK.white),
        target: new THREE.Color(BRICK.white),
        ck: 'white',
        colorDirty: true,
        jit: [(rand() - 0.5) * 0.03, (rand() - 0.5) * 0.036],
        rnd: rand(),
        hv: 0,
        hvv: 0,
        ht: 0,
        sq: 0,
        nudgeAt: 0,
        f: null,
        ret: null,
      };
      this._parkPose(b, 1, b.wp);
      mesh.setMatrixAt(i, ZERO_M);
      mesh.setColorAt(i, b.color);
      b.hidden = true;
      list.push(b);
      this._bricks.push(b);
    }
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this._byType.set(t, list);
    this.scene.add(mesh);
  }

  _groundRects(bricks) {
    const out = [];
    for (const e of bricks) {
      if (e.y > 0.05 || e.tuck) continue;
      const [sx, sz] = footprint(e);
      out.push([e.x - sx / 2, e.x + sx / 2, e.z - sz / 2, e.z + sz / 2, 1]);
    }
    return out;
  }

  _buildGrounds() {
    for (const key of SLOTS) {
      this._grounds[key] = this._createGroundFor(key);
    }
  }

  _createGroundFor(key) {
    const box = this._frames[key].box;
    const group = new THREE.Group();
    group.matrixAutoUpdate = false;
    group.visible = false;
    const sx = box.max.x - box.min.x;
    const sz = box.max.z - box.min.z;
    const cx = (box.max.x + box.min.x) / 2;
    const cz = (box.max.z + box.min.z) / 2;
    const span = Math.max(sx, sz) * 5.5 + 110;
    const catcher = new THREE.Mesh(
      new THREE.PlaneGeometry(span, span),
      new THREE.ShadowMaterial({ opacity: 0, depthWrite: false }),
    );
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.set(cx, 0, cz);
    catcher.receiveShadow = true;
    catcher.renderOrder = -2;
    group.add(catcher);

    const pad = 3;
    const rects = this._groundRects(this.models[key].bricks);
    const tex = contactTexture(rects, box.min.x - pad, box.max.x + pad, box.min.z - pad, box.max.z + pad);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(sx + pad * 2, sz + pad * 2), mat);
    blob.rotation.x = -Math.PI / 2;
    blob.position.set(cx, 0.004, cz);
    blob.renderOrder = -1;
    group.add(blob);

    this.scene.add(group);
    return { group, catcher, blobs: [blob], presence: 0 };
  }

  _rebuildHeroGround() {
    const old = this._grounds.hero;
    const prevPresence = old ? old.presence : 1;
    if (old) {
      this.scene.remove(old.group);
      old.catcher.geometry.dispose();
      old.catcher.material.dispose();
      for (const b of old.blobs) {
        b.geometry.dispose();
        b.material.map.dispose();
        b.material.dispose();
      }
    }
    const next = this._createGroundFor('hero');
    next.presence = prevPresence;
    this._grounds.hero = next;
  }

  async _loadMinifig() {
    let mod;
    try {
      mod = await import('./minifig.js');
    } catch {
      return;
    }
    if (this._disposed || typeof mod.createMinifig !== 'function') return;
    try {
      const fig = mod.createMinifig({ theme: this._theme });
      const obj = fig.group || fig.object || fig;
      if (!obj || !obj.isObject3D) return;
      const wrap = new THREE.Group();
      wrap.add(obj);
      const box = new THREE.Box3().setFromObject(obj);
      const h = box.max.y - box.min.y;
      if (h > 0 && (h < 3.6 || h > 6.8)) obj.scale.multiplyScalar(4.9 / h);
      box.setFromObject(obj);
      obj.position.x -= (box.min.x + box.max.x) / 2;
      obj.position.z -= (box.min.z + box.max.z) / 2;
      obj.position.y -= box.min.y;
      wrap.rotation.y = -0.45;
      obj.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });
      wrap.visible = false;
      this.heroAnchor.add(wrap);
      this.minifig = fig;
      this._fig.wrap = wrap;
      this._dirty = true;
    } catch (err) {
      console.warn('[stage] minifig unavailable', err);
    }
  }

  _applyTierSettings() {
    const size = this.tier === 0 ? 1024 : 2048;
    const sh = this.lights.key.shadow;
    if (sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      if (sh.map) {
        sh.map.dispose();
        sh.map = null;
      }
    }
    this._dirty = true;
  }

  _applyTheme() {
    const t = THEMES[this._theme];
    this.lights.applyTheme(this._theme, this.renderer);
    this.material.envMapIntensity = t.envIntensity;
    this.post.setBackground(t.bg);
    for (const b of this._bricks) {
      if (b.ck !== 'baseplate') continue;
      this._resolveColor(b.ck, b, b.target);
      if (b.mode !== 'fly') {
        b.color.copy(b.target);
        b.colorDirty = true;
      }
    }
    if (this._fig.wrap) this.minifig.setTheme?.(this._theme);
    this._dirty = true;
  }

  _resolveColor(key, b, out) {
    const name = key === 'baseplate' ? THEMES[this._theme].baseplate : key;
    out.set(BRICK[name] || name);
    if (b) out.offsetHSL(0, b.jit[0], b.jit[1]);
    return out;
  }

  // ---------------------------------------------------------------- public API

  /**
   * Dynamically rebuilds the 3D LEGO hero word with optional palette and minifigure toggle.
   * @param {string} word
   * @param {{palette?: string|string[], showMinifig?: boolean, drop?: boolean}} [opts]
   */
  setWord(word, opts = {}) {
    const nextWord = sanitizeWord(word, this.word || 'SUJIT');
    const nextPalette = opts.palette !== undefined ? opts.palette : this.palette;
    const nextMinifig = opts.showMinifig !== undefined ? Boolean(opts.showMinifig) : this.showMinifig;

    this.word = nextWord;
    this.palette = nextPalette;
    this.showMinifig = nextMinifig;

    if (!this.ready) return this.word;

    this._endSession();
    this.models.hero = heroModel(this.word, {
      palette: this.palette,
      showMinifig: this.showMinifig,
    });

    const box = this._boxOf(this.models.hero.bounds);
    this._frames.hero.setBox(box);
    const a = this.models.hero.anchor;
    this.heroAnchor.position.set(a.x, a.y, a.z);
    this._rebuildHeroGround();
    this._readSlots();
    this._updateFrames(0);

    if (opts.drop) {
      this._playIntro();
    } else {
      this._transition('hero');
      if (this.showMinifig && this.minifig) {
        this._fig.waved = false;
      }
    }
    this._dirty = true;
    return this.word;
  }

  /** Re-plays the sky drop-in brick assembly animation. */
  rebuild() {
    if (!this.ready) return;
    if (this._frames.hero) {
      this._frames.hero.orbit.targetYaw = 0;
      this._frames.hero.orbit.targetTilt = 0;
    }
    this._play('whoosh');
    this._playIntro();
  }

  /** Knocks the LEGO letters loose in a playful physics burst. */
  smash() {
    if (!this.ready || this._shown !== 'hero') return;
    const b = this.models.hero.bounds;
    const minX = b.min[0];
    const maxX = b.max[0];
    const midY = (b.min[1] + b.max[1]) * 0.48;
    const midZ = (b.min[2] + b.max[2]) * 0.5;
    const hits = [0.22, 0.5, 0.78];
    for (const f of hits) {
      const hx = minX + (maxX - minX) * f;
      const pt = new THREE.Vector3(hx, midY, midZ);
      this._knock(null, pt);
    }
  }

  /** Makes the minifigure wave, jump, and cycle facial expressions. */
  triggerMinifigWave() {
    if (!this.ready || !this.minifig || !this.showMinifig) return;
    this._exprIdx = (this._exprIdx + 1) % EXPRESSIONS.length;
    this.minifig.setExpression?.(EXPRESSIONS[this._exprIdx]);
    this.minifig.wave?.();
    this.minifig.jump?.();
    this._fig.busyUntil = this._time + 2.5;
    this._play('pop');
    this._dirty = true;
  }

  /** Called from the site's rAF loop every frame. */
  update(t, dt) {
    if (!this.ready || this._disposed || document.hidden) return;
    dt = Math.min(dt, 0.25);
    this._time += dt;
    if (--this._rescan <= 0) {
      this._scanSlots();
      this._rescan = 90;
    }
    this._readSlots();
    if (this._intro === 'pending' && this._active === 'hero' && (this._introRequested || this._time - this._readyAt > 1.2)) {
      this._playIntro();
    }
    if (this._updateFrames(dt)) this._dirty = true;
    this._tickPointer(dt);
    let busy = this._tickPhysics(dt);
    busy = this._tickBricks(dt) || busy;
    if (this._tickGrounds(dt)) busy = true;
    if (this._tickMinifig(t, dt)) busy = true;
    if (busy) this._dirty = true;
    if (!this._dirty) {
      this._renderedLast = false;
      return;
    }
    this._writeInstances();
    this._render(dt);
    this._dirty = false;
    if (this._renderedLast && !this._tierForced && this.tier > 0 && this.perf.sample(dt * 1000)) {
      this.tier--;
      this.post.setTier(this.tier).then(() => this._applyTierSettings());
    }
    this._renderedLast = true;
  }

  /** Canvas-size based (clientWidth/Height), not innerWidth. */
  resize() {
    if (!this.renderer) return;
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this._vw = w;
    this._vh = h;
    this._aspect = w / h;
    this.camera.aspect = this._aspect;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    this._viewProj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.post.setSize(w, h);
    const r = this.canvas.getBoundingClientRect();
    this._canvasRect = { left: r.left, top: r.top };
    for (const fr of Object.values(this._frames)) fr.sig = '';
    this._dirty = true;
  }

  setTheme(name) {
    if (!THEMES[name] || name === this._theme) return;
    this._theme = name;
    if (this.renderer) this._applyTheme();
  }

  /** Plays the hero build-in once (bricks drop in bottom-up, ~1.8 s). */
  intro() {
    this._introRequested = true;
    if (this._intro !== 'pending') return;
    if (!this.ready) return;
    if (this._active === 'hero') this._playIntro();
  }

  get activeSlot() {
    return this._active;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const off of this._listeners) off();
    this._listeners = [];
    delete document.documentElement.dataset.stageActive;
    for (const el of this._slots.values()) el.style.cursor = '';
    if (!this.renderer) return;
    this.physics.dispose();
    try {
      this.minifig?.dispose?.();
    } catch {
      // ignore
    }
    for (const list of this._byType.values()) list[0].mesh.dispose();
    for (const g of Object.values(this._grounds)) {
      g.catcher.geometry.dispose();
      g.catcher.material.dispose();
      for (const b of g.blobs) {
        b.geometry.dispose();
        b.material.map.dispose();
        b.material.dispose();
      }
    }
    this.material.dispose();
    this._env.dispose();
    this.post.dispose();
    this.lights.key.shadow.map?.dispose();
    this.renderer.dispose();
    this.scene.clear();
  }

  // ---------------------------------------------------------------- slots

  _scanSlots() {
    for (const [name, el] of this._slots) if (!el.isConnected) this._slots.delete(name);
    for (const el of document.querySelectorAll('.stage-slot[data-stage]')) {
      const name = el.dataset.stage;
      if (!SLOTS.includes(name)) continue;
      if (this._slots.get(name) !== el) this._slots.set(name, el);
      if (!this._bound.has(el)) {
        this._bound.add(el);
        this._bindSlot(el, name);
      }
    }
  }

  _readSlots() {
    const vw = this._vw;
    const vh = this._vh;
    let best = null;
    let bestVis = 0;
    let bestDist = Infinity;
    for (const key of SLOTS) {
      const fr = this._frames[key];
      const el = this._slots.get(key);
      if (!el || !el.isConnected) {
        fr.valid = false;
        fr.vis = 0;
        continue;
      }
      const r = el.getBoundingClientRect();
      fr.rect.x = r.left - this._canvasRect.left;
      fr.rect.y = r.top - this._canvasRect.top;
      fr.rect.w = r.width;
      fr.rect.h = r.height;
      fr.valid = r.width > 8 && r.height > 8;
      if (!fr.valid) {
        fr.vis = 0;
        continue;
      }
      const visW = Math.max(0, Math.min(fr.rect.x + r.width, vw) - Math.max(fr.rect.x, 0));
      const visH = Math.max(0, Math.min(fr.rect.y + r.height, vh) - Math.max(fr.rect.y, 0));
      fr.vis = (visW * visH) / (Math.min(r.width, vw) * Math.min(r.height, vh));
      const dist = Math.abs(fr.rect.y + r.height / 2 - vh / 2);
      if (fr.vis >= MIN_VIS && (fr.vis > bestVis + 0.02 || (Math.abs(fr.vis - bestVis) <= 0.02 && dist < bestDist))) {
        best = key;
        bestVis = fr.vis;
        bestDist = dist;
      }
    }
    const cur = this._active && this._frames[this._active];
    if (cur && cur.valid && cur.vis >= MIN_VIS && best !== this._active && bestVis < cur.vis + 0.2) best = this._active;
    if (this._forced !== undefined) best = this._forced;
    if (best !== this._active) this._setActive(best);
  }

  _setActive(name) {
    this._active = name;
    const root = document.documentElement;
    if (name) root.dataset.stageActive = name;
    else delete root.dataset.stageActive;
    if (this._intro === 'pending') {
      if (name === 'hero') return;
      if (name) this._intro = 'done';
    }
    this._transition(name);
  }

  _viewOf(key, aspect) {
    return this.models[key].view(aspect);
  }

  /** Refits every slot frame; returns true if a visible frame moved. */
  _updateFrames(dt) {
    let moved = false;
    const p = this._ptr;
    for (const key of SLOTS) {
      const fr = this._frames[key];
      if (!fr.valid) continue;
      const r = fr.rect;
      let tx = 0;
      let ty = 0;
      let tw = 0;
      if (!this._reduced) {
        if (p.inside && p.slot === key && !p.drag && !p.orbit) {
          tx = clamp((p.x - this._canvasRect.left - (r.x + r.w / 2)) / (r.w / 2), -1, 1) * 5 * DEG;
          ty = clamp((p.y - this._canvasRect.top - (r.y + r.h / 2)) / (r.h / 2), -1, 1) * 3.5 * DEG;
        }
        tw = clamp(-(store.scroll.velocity || 0) * 0.000035, -0.05, 0.05);
      }
      const par = fr.par;
      const ox = par.x;
      const oy = par.y;
      const ow = par.w;
      par.x = damp(par.x, tx, 4, dt);
      par.y = damp(par.y, ty, 4, dt);
      par.w = damp(par.w, tw, 6, dt);
      const parMoved = Math.abs(par.x - ox) + Math.abs(par.y - oy) + Math.abs(par.w - ow) > 1e-5;

      const orb = fr.orbit;
      const oyaw = orb.yaw;
      const otilt = orb.tilt;
      orb.yaw = this._reduced ? orb.targetYaw : damp(orb.yaw, orb.targetYaw, 14, dt);
      orb.tilt = this._reduced ? orb.targetTilt : damp(orb.tilt, orb.targetTilt, 14, dt);
      if (Math.abs(orb.yaw - orb.targetYaw) < 1e-4) orb.yaw = orb.targetYaw;
      if (Math.abs(orb.tilt - orb.targetTilt) < 1e-4) orb.tilt = orb.targetTilt;
      const orbitMoved =
        Math.abs(orb.yaw - oyaw) + Math.abs(orb.tilt - otilt) > 1e-5 ||
        Math.abs(orb.targetYaw - orb.yaw) + Math.abs(orb.targetTilt - orb.tilt) > 1e-5;

      const sig = `${r.x.toFixed(2)}|${r.y.toFixed(2)}|${r.w.toFixed(1)}|${r.h.toFixed(1)}`;
      if (sig !== fr.sig) {
        this._fit(fr);
        fr.sig = sig;
      } else if (!parMoved && !orbitMoved) {
        continue;
      }
      const view = this._viewOf(key, r.w / Math.max(1, r.h));
      const totalTilt = clamp(view.tilt + orb.tilt + par.y + par.w, -78 * DEG, 78 * DEG);
      const totalYaw = view.yaw + orb.yaw + par.x;
      _e.set(totalTilt, totalYaw, 0, 'XYZ');
      fr.quat.setFromEuler(_e);
      fr.compose();
      const g = this._grounds[key];
      if (key === this._shown || g.presence > 0.002) moved = true;
    }
    return moved;
  }

  /** Scales/places a frame so its model's box fits the slot rect (6% margin). */
  _fit(fr) {
    const r = fr.rect;
    const vw = this._vw;
    const vh = this._vh;
    const tw = Math.max(8, r.w * (1 - 2 * MARGIN));
    const th = Math.max(8, r.h * (1 - 2 * MARGIN));
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const view = this._viewOf(fr.key, r.w / Math.max(1, r.h));
    fr.baseQuat.setFromEuler(_e.set(view.tilt, view.yaw, 0, 'XYZ'));
    const halfH = CAM_Z * TAN;
    const ppu = vh / (2 * halfH);
    if (!fr.fitted) {
      fr.pos.set((cx - vw / 2) / ppu, -(cy - vh / 2) / ppu, 0);
      const size = fr.box.getSize(_v);
      fr.scale = Math.min(tw / (size.x * ppu), th / (Math.max(size.y, size.z) * ppu));
      fr.fitted = true;
    }
    for (let it = 0; it < 3; it++) {
      const b = this._projectBox(fr);
      const k = Math.min(tw / Math.max(1e-3, b.maxX - b.minX), th / Math.max(1e-3, b.maxY - b.minY));
      const p0x = vw / 2 + fr.pos.x * ppu;
      const p0y = vh / 2 - fr.pos.y * ppu;
      const mx = p0x + ((b.minX + b.maxX) / 2 - p0x) * k;
      const my = p0y + ((b.minY + b.maxY) / 2 - p0y) * k;
      fr.scale *= k;
      fr.pos.x += (cx - mx) / ppu;
      fr.pos.y -= (cy - my) / ppu;
      if (Math.abs(k - 1) < 1e-4 && Math.abs(cx - mx) < 0.05 && Math.abs(cy - my) < 0.05) break;
    }
  }

  _projectBox(fr) {
    const out = this._pb || (this._pb = { minX: 0, maxX: 0, minY: 0, maxY: 0 });
    out.minX = out.minY = Infinity;
    out.maxX = out.maxY = -Infinity;
    const { min, max } = fr.box;
    for (let i = 0; i < 8; i++) {
      _v.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z);
      _v.sub(fr.pivot).multiplyScalar(fr.scale).applyQuaternion(fr.baseQuat).add(fr.pos);
      _v.applyMatrix4(this._viewProj);
      const x = (_v.x + 1) * 0.5 * this._vw;
      const y = (1 - _v.y) * 0.5 * this._vh;
      out.minX = Math.min(out.minX, x);
      out.maxX = Math.max(out.maxX, x);
      out.minY = Math.min(out.minY, y);
      out.maxY = Math.max(out.maxY, y);
    }
    return out;
  }

  // ---------------------------------------------------------------- transitions

  _transition(name) {
    this._endSession();
    const prev = this._shown;
    this._shown = name;
    if (name) this._lastShown = name;
    const model = name && this.models[name];
    const used = new Set();
    if (model) {
      const plan = this._assign(model);
      for (const { b, e } of plan) {
        used.add(b);
        const o = model.bricks[e].o;
        this._flyTo(b, name, e, { delay: this._reduced ? 0 : o * 0.45 + b.rnd * 0.06, dur: 0.68 + b.rnd * 0.14 });
      }
    }
    const dir = this._exitDir();
    for (const b of this._bricks) if (!used.has(b)) this._toPark(b, dir);
    if (model || prev) this._play('whoosh');
    this._dirty = true;
  }

  _exitDir() {
    return (store.scroll.direction || 1) > 0 ? 1 : -1;
  }

  /** Pairs pool bricks with layout entries type by type, spatially coherent. */
  _assign(model) {
    const entries = model.bricks;
    const byType = new Map();
    entries.forEach((e, i) => {
      if (!byType.has(e.t)) byType.set(e.t, []);
      byType.get(e.t).push(i);
    });
    const plan = [];
    for (const [t, idxs] of byType) {
      const pool = (this._byType.get(t) || []).slice().sort((a, b) => a.wp.pos.x - b.wp.pos.x);
      idxs.sort((i, j) => entries[i].x - entries[j].x);
      const n = Math.min(idxs.length, pool.length);
      for (let k = 0; k < n; k++) {
        const pi = pool.length === n ? k : Math.round(((k + 0.5) * pool.length) / n - 0.5);
        plan.push({ b: pool[pi], e: idxs[k] });
      }
    }
    return plan;
  }

  _flightState(b) {
    if (!b.f) {
      b.f = {
        from: new Pose(),
        to: new Pose(),
        fromKey: null,
        toKey: null,
        entry: -1,
        toPark: false,
        t: 0,
        delay: 0,
        dur: 1,
        side: new THREE.Vector3(),
        axis: new THREE.Vector3(),
        turns: 0,
        landed: false,
        intro: false,
        rain: false,
        c0: new THREE.Color(),
      };
    }
    return b.f;
  }

  /** Starts a flight from wherever the brick is now to a model entry. */
  _flyTo(b, key, entry, { delay = 0, dur = 0.8, rain = false, intro = false, from = null } = {}) {
    const f = this._flightState(b);
    if (b.mode === 'park') this._parkPose(b, this._entryDir(key), b.wp);
    this._captureFrom(b, f);
    if (from) {
      f.fromKey = key;
      f.from.copy(from);
    }
    f.toKey = key;
    f.entry = entry;
    f.toPark = false;
    f.rain = rain;
    f.intro = intro;
    f.t = -delay;
    f.dur = this._reduced ? 0.28 : dur;
    f.landed = false;
    const rnd = this._rand;
    f.side.set(rnd() - 0.5, 0, rnd() - 0.5).normalize();
    f.axis.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    f.turns = this._reduced || intro ? 0 : rnd() < 0.7 ? 1 : 0;
    f.c0.copy(b.color);
    b.mode = 'fly';
    b.model = key;
    b.entry = entry;
    b.rain = rain;
    b.hv = b.hvv = b.ht = 0;
    const model = this.models[key];
    const ck = model.bricks[entry].c;
    b.ck = ck;
    this._resolveColor(ck, b, b.target);
  }

  _captureFrom(b, f) {
    const inFrame = (b.mode === 'rest' || b.mode === 'loose' || b.mode === 'return' || b.mode === 'hold') && b.model && this._frames[b.model];
    if (inFrame) {
      f.fromKey = b.model;
      f.from.copy(b.lp);
    } else {
      f.fromKey = null;
      f.from.copy(b.wp);
    }
  }

  _toPark(b, dir) {
    if (b.mode === 'park') return;
    if (this._physicsHas(b)) this.physics.remove(b.id);
    const f = this._flightState(b);
    this._captureFrom(b, f);
    this._parkPose(b, dir, f.to);
    f.toKey = null;
    f.entry = -1;
    f.toPark = true;
    f.rain = false;
    f.intro = false;
    f.t = -(b.rnd * 0.22);
    f.dur = this._reduced ? 0.25 : 0.62 + b.rnd * 0.2;
    f.landed = true;
    f.turns = this._reduced ? 0 : 1;
    f.axis.set(b.rnd - 0.5, 0.6, 0.5 - b.rnd).normalize();
    f.side.set(b.rnd - 0.5, 0, 0.3).normalize();
    f.c0.copy(b.color);
    b.target.copy(b.color);
    b.mode = 'fly';
    b.model = null;
    b.entry = -1;
    b.hv = b.hvv = b.ht = 0;
  }

  _entryDir(key) {
    const fr = this._frames[key];
    if (!fr || !fr.valid) return 1;
    return fr.rect.y + fr.rect.h / 2 < this._vh / 2 ? 1 : -1;
  }

  /** World pose just outside the viewport (above for dir = 1, below for -1). */
  _parkPose(b, dir, out) {
    const rnd = this._rand;
    const z = -14 + rnd() * 12;
    const halfH = (CAM_Z - z) * TAN;
    const halfW = halfH * this._aspect;
    out.pos.set((rnd() * 2 - 1) * halfW * 1.05, dir * (halfH + 6 + rnd() * 16), z);
    _e.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
    out.quat.setFromEuler(_e);
    out.scl = this._frames.hero ? Math.max(0.3, this._frames[this._lastShown || 'hero'].scale || 1) : 1;
    return out;
  }

  _playIntro() {
    this._intro = 'done';
    const model = this.models.hero;
    this._endSession();
    this._shown = 'hero';
    this._lastShown = 'hero';
    this._fig.waved = false;
    const plan = this._assign(model);
    const used = new Set();
    const rnd = this._rand;
    for (const { b, e } of plan) {
      used.add(b);
      const entry = model.bricks[e];
      _L.pos.set(entry.x + (rnd() - 0.5) * 0.8, entry.y + 13 + rnd() * 8, entry.z + (rnd() - 0.5) * 0.8);
      _e.set((rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.5);
      _L.quat.setFromEuler(_e).multiply(entry.r ? Q90 : Q0);
      _L.scl = 1;
      this._flyTo(b, 'hero', e, { delay: entry.o * 1.2 + rnd() * 0.05, dur: 0.48 + rnd() * 0.08, intro: true, from: _L });
      b.color.copy(b.target);
      b.f.c0.copy(b.target);
      b.colorDirty = true;
    }
    for (const b of this._bricks) if (!used.has(b) && b.mode !== 'park') this._toPark(b, 1);
    this._dirty = true;
  }

  // ---------------------------------------------------------------- per-frame brick logic

  _tickBricks(dt) {
    let busy = false;
    for (const b of this._bricks) {
      switch (b.mode) {
        case 'park':
          break;
        case 'fly':
          this._tickFlight(b, dt);
          busy = true;
          break;
        case 'return':
          this._tickReturn(b, dt);
          this._frames[b.model].toWorld(b.lp, b.wp);
          busy = true;
          break;
        case 'loose':
          this._loosePose(b);
          this._frames[b.model].toWorld(b.lp, b.wp);
          break;
        case 'hold':
          this._frames[b.model].toWorld(b.lp, b.wp);
          break;
        case 'rest': {
          if (this._tickSpring(b, dt)) busy = true;
          this._restLocal(b, b.lp);
          this._frames[b.model].toWorld(b.lp, b.wp);
          if (b.sq !== 0) {
            b.sq = 0;
            busy = true;
          }
          break;
        }
        default:
          break;
      }
    }
    return busy;
  }

  _fromWorld(f, out) {
    if (f.fromKey) return this._frames[f.fromKey].toWorld(f.from, out);
    return out.copy(f.from);
  }

  _toWorld(b, f, out) {
    if (f.toPark) return out.copy(f.to);
    const fr = this._frames[f.toKey];
    this._entryPose(this.models[f.toKey], f.entry, _L);
    return fr.toWorld(_L, out);
  }

  _tickFlight(b, dt) {
    const f = b.f;
    f.t += dt;
    this._fromWorld(f, _A);
    if (f.t <= 0) {
      b.wp.copy(_A);
      b.sq = 0;
      return;
    }
    this._toWorld(b, f, _B);
    const u = Math.min(1, f.t / f.dur);
    const travel = f.toPark ? 1 : LAND;
    const t0 = Math.min(1, u / travel);
    if (f.intro) {
      const e = easeIn(t0);
      b.wp.pos.lerpVectors(_A.pos, _B.pos, e);
      b.wp.quat.slerpQuaternions(_A.quat, _B.quat, easeOut(t0));
      b.wp.scl = _B.scl;
    } else if (this._reduced) {
      const e = smooth(t0);
      b.wp.pos.lerpVectors(_A.pos, _B.pos, e);
      b.wp.quat.slerpQuaternions(_A.quat, _B.quat, e);
      b.wp.scl = _A.scl + (_B.scl - _A.scl) * e;
    } else {
      const e = f.toPark ? easeIn(t0) * 0.6 + easeInOut(t0) * 0.4 : easeInOut(t0);
      const dist = _A.pos.distanceTo(_B.pos);
      const s = Math.max(0.05, _B.scl);
      const lift = clamp(dist * 0.32, 3 * s, 42);
      _p1.copy(_A.pos).addScaledVector(UP, lift * 0.85).addScaledVector(f.side, lift * 0.45);
      if (f.toPark) _v.copy(UP);
      else _v.copy(UP).applyQuaternion(this._frames[f.toKey].quat);
      _p2.copy(_B.pos).addScaledVector(_v, f.toPark ? lift * 0.2 : lift * 0.45 + 2.6 * s);
      bezier(b.wp.pos, _A.pos, _p1, _p2, _B.pos, e);
      b.wp.quat.slerpQuaternions(_A.quat, _B.quat, e);
      if (f.turns) b.wp.quat.premultiply(_q.setFromAxisAngle(f.axis, e * Math.PI * 2 * f.turns));
      b.wp.scl = _A.scl + (_B.scl - _A.scl) * e;
      if (!b.target.equals(f.c0)) {
        b.color.copy(f.c0).lerp(b.target, smooth(clamp((e - 0.2) / 0.55)));
        b.colorDirty = true;
      }
    }
    if (u > travel) {
      const k = (u - travel) / (1 - travel);
      b.sq = Math.sin(k * Math.PI * 2) * Math.exp(-3.5 * k);
      if (!f.landed) {
        f.landed = true;
        if (!this._isTuck(b)) this._play('snap');
        if (!b.color.equals(b.target)) {
          b.color.copy(b.target);
          b.colorDirty = true;
        }
      }
    } else {
      b.sq = 0;
    }
    if (u >= 1) this._endFlight(b);
  }

  _endFlight(b) {
    const f = b.f;
    b.sq = 0;
    if (!b.color.equals(b.target)) {
      b.color.copy(b.target);
      b.colorDirty = true;
    }
    if (f.toPark) {
      b.wp.copy(f.to);
      b.mode = 'park';
      return;
    }
    b.mode = 'rest';
    this._restLocal(b, b.lp);
  }

  _restLocal(b, out) {
    this._entryPose(this.models[b.model], b.entry, out);
    if (b.hv !== 0) {
      const e = this._entryOf(b);
      if (e && e.covered) out.pos.add(_v.set(0, 0.05 * b.hv, 0.17 * b.hv));
      else out.pos.y += 0.17 * b.hv;
    }
    return out;
  }

  _entryOf(b) {
    const model = this.models[b.model];
    if (!model || b.entry < 0) return null;
    return model.bricks[b.entry];
  }

  _isTuck(b) {
    const e = this._entryOf(b);
    return !!(e && e.tuck);
  }

  /** Local rest pose of a layout entry. */
  _entryPose(model, i, out) {
    const e = model.bricks[i];
    out.pos.set(e.x, e.y, e.z);
    out.quat.copy(e.r ? Q90 : Q0);
    out.scl = e.tuck ? TUCK : 1;
    return out;
  }

  _tickSpring(b, dt) {
    if (b.hv === b.ht && b.hvv === 0) return false;
    const steps = dt > 1 / 50 ? 3 : 1;
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = 300 * (b.ht - b.hv) - 19 * b.hvv;
      b.hvv += a * h;
      b.hv += b.hvv * h;
    }
    if (Math.abs(b.hv - b.ht) < 1e-3 && Math.abs(b.hvv) < 1e-3) {
      b.hv = b.ht;
      b.hvv = 0;
    }
    return true;
  }

  _writeInstances() {
    const touched = new Set();
    const colored = new Set();
    for (const b of this._bricks) {
      if (b.mode === 'park') {
        if (!b.hidden) {
          b.mesh.setMatrixAt(b.index, ZERO_M);
          b.hidden = true;
          touched.add(b.mesh);
        }
        continue;
      }
      b.hidden = false;
      const s = b.wp.scl;
      const sq = b.sq;
      _s.set(s * (1 + 0.06 * sq), s * (1 - 0.13 * sq), s * (1 + 0.06 * sq));
      b.matrix.compose(b.wp.pos, b.wp.quat, _s);
      b.mesh.setMatrixAt(b.index, b.matrix);
      touched.add(b.mesh);
      if (b.colorDirty) {
        b.mesh.setColorAt(b.index, b.color);
        b.colorDirty = false;
        colored.add(b.mesh);
      }
    }
    for (const m of touched) m.instanceMatrix.needsUpdate = true;
    for (const m of colored) m.instanceColor.needsUpdate = true;
  }

  _tickGrounds(dt) {
    let busy = false;
    const t = THEMES[this._theme];
    for (const key of SLOTS) {
      const g = this._grounds[key];
      const fr = this._frames[key];
      const target = key === this._shown && fr.valid ? 1 : 0;
      const before = g.presence;
      g.presence = this._reduced ? target : damp(g.presence, target, key === this._shown ? 2.6 : 6, dt);
      if (Math.abs(g.presence - target) < 0.002) g.presence = target;
      if (g.presence !== before) busy = true;
      g.group.visible = g.presence > 0.002 && fr.valid;
      if (!g.group.visible) continue;
      g.group.matrix.copy(fr.matrix);
      g.group.matrixWorldNeedsUpdate = true;
      g.catcher.material.opacity = t.shadowOpacity * g.presence;
      const blobBase = Math.min(0.62, t.shadowOpacity * 1.9) * g.presence;
      g.blobs[0].material.opacity = blobBase;
    }
    return busy;
  }

  _tickMinifig(t, dt) {
    const fig = this._fig;
    if (!fig.wrap) return false;
    const hf = this._frames.hero;
    this._heroGroup.matrix.copy(hf.matrix);
    this._heroGroup.matrixWorldNeedsUpdate = true;
    let assembled = this.showMinifig && this._shown === 'hero';
    if (assembled) {
      let n = 0;
      let rest = 0;
      for (const b of this._bricks) {
        if (b.model !== 'hero') continue;
        n++;
        if (b.mode !== 'fly') rest++;
      }
      assembled = n > 0 && rest / n > 0.85;
    }
    fig.target = assembled ? 1 : 0;
    const before = fig.presence;
    fig.presence = this._reduced ? fig.target : damp(fig.presence, fig.target, fig.target ? 5 : 9, dt);
    if (Math.abs(fig.presence - fig.target) < 0.003) fig.presence = fig.target;
    fig.wrap.visible = fig.presence > 0.01;
    let busy = fig.presence !== before;
    if (fig.wrap.visible) {
      const k = fig.presence;
      const s = k < 1 ? 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2) : 1;
      fig.wrap.scale.setScalar(Math.max(0.001, s));
      if (fig.target === 1 && k > 0.9 && !fig.waved) {
        fig.waved = true;
        this.minifig.wave?.();
        fig.busyUntil = this._time + 2.5;
      }
      const res = this.minifig.update?.(t, dt);
      if (res === true || this._time < fig.busyUntil) busy = true;
    } else if (fig.target === 0) {
      fig.waved = false;
    }
    return busy;
  }

  // ---------------------------------------------------------------- physics

  _physicsHas(b) {
    return this.physics && this.physics.has(b.id);
  }

  _ensureSession(key) {
    if (this._session && this._session.key === key) return this._session;
    this._endSession();
    // Use an infinite ground plane; lateral & vertical boundaries are enforced
    // against the exact 3D camera frustum of the screen canvas so bricks can be
    // thrown across the entire viewport and bounce off the screen edges.
    this.physics.setEnvironment({
      groundY: 0,
      bounds: null,
    });
    this._session = { key, kind: 'knock' };
    return this._session;
  }

  _endSession() {
    if (!this._session) return;
    for (const b of this._bricks) if (b.mode === 'loose' || b.mode === 'return') b.mode = 'hold';
    if (this._ptr.drag) this._endDrag(false);
    this.physics.clearBricks();
    this._session = null;
  }

  _addBody(b, vel, angVel) {
    _v.set(0, b.info.h / 2, 0).applyQuaternion(b.lp.quat).add(b.lp.pos);
    this.physics.removeStatic(b.id);
    this.physics.addDynamic(b.id, { half: b.half, pos: _v, quat: b.lp.quat, vel, angVel });
    b.mode = 'loose';
    b.hv = b.hvv = b.ht = 0;
    b.lp.scl = 1;
  }

  _loosePose(b) {
    if (!this.physics.pose(b.id, _v2, b.lp.quat)) return;
    b.lp.pos.copy(_v.set(0, -b.info.h / 2, 0).applyQuaternion(b.lp.quat).add(_v2));
    b.lp.scl = 1;
  }

  /**
   * Clamps a model-local center position `localPos` so its world projection stays
   * strictly inside the visible screen canvas frustum.
   */
  _clampLocalToScreen(localPos, b, fr) {
    const scale = Math.max(0.05, fr.scale);
    const invQuat = _q.copy(fr.quat).invert();
    const brickRad = Math.hypot(b.half[0], b.half[1], b.half[2]) * scale * 1.05;

    _p1.copy(localPos).sub(fr.pivot).multiplyScalar(scale).applyQuaternion(fr.quat).add(fr.pos);
    const minZ = fr.pos.z - 42;
    const maxZ = Math.min(CAM_Z - 26, fr.pos.z + 36);
    _p1.z = clamp(_p1.z, minZ, maxZ);

    const depth = CAM_Z - _p1.z;
    const halfH = depth * TAN;
    const halfW = halfH * this._aspect;
    const limX = Math.max(0.5, halfW - (brickRad + halfW * 0.022));
    const limY = Math.max(0.5, halfH - (brickRad + halfH * 0.028));

    _p1.x = clamp(_p1.x, -limX, limX);
    _p1.y = clamp(_p1.y, -limY, limY);

    localPos.copy(_p1).sub(fr.pos).applyQuaternion(invQuat).divideScalar(scale).add(fr.pivot);
    localPos.y = Math.max(b.half[1], localPos.y);
    return localPos;
  }

  /**
   * Keeps every loose brick strictly inside the screen canvas frustum and
   * bounces bricks off the left/right/top/bottom canvas edges with velocity
   * proportional to the user's throw force.
   */
  _constrainToScreenCanvas(key) {
    const fr = this._frames[key];
    if (!fr || !fr.valid) return;
    const scale = Math.max(0.05, fr.scale);
    const invQuat = _q.copy(fr.quat).invert();
    const minZ = fr.pos.z - 42;
    const maxZ = Math.min(CAM_Z - 26, fr.pos.z + 36);
    const wallBounce = 0.65;
    const wallFriction = 0.88;
    let loudestImpact = 0;

    for (const b of this._bricks) {
      if (b.mode !== 'loose' || b.model !== key) continue;
      const body = this.physics.bodies.get(b.id);
      if (!body) continue;

      const brickRad = Math.hypot(b.half[0], b.half[1], b.half[2]) * scale * 1.05;

      // Transform body center & velocity from model space -> world space
      _p1
        .set(body.position.x, body.position.y, body.position.z)
        .sub(fr.pivot)
        .multiplyScalar(scale)
        .applyQuaternion(fr.quat)
        .add(fr.pos);
      _p2
        .set(body.velocity.x, body.velocity.y, body.velocity.z)
        .multiplyScalar(scale)
        .applyQuaternion(fr.quat);

      let clamped = false;
      let bounced = false;
      let impact = 0;

      if (_p1.z < minZ) {
        _p1.z = minZ;
        clamped = true;
        if (_p2.z < 0) {
          impact = Math.max(impact, -_p2.z / scale);
          _p2.z = -_p2.z * 0.58;
          bounced = true;
        }
      } else if (_p1.z > maxZ) {
        _p1.z = maxZ;
        clamped = true;
        if (_p2.z > 0) {
          impact = Math.max(impact, _p2.z / scale);
          _p2.z = -_p2.z * 0.58;
          bounced = true;
        }
      }

      const depth = CAM_Z - _p1.z;
      const halfH = depth * TAN;
      const halfW = halfH * this._aspect;
      const limX = Math.max(0.5, halfW - (brickRad + halfW * 0.022));
      const limY = Math.max(0.5, halfH - (brickRad + halfH * 0.028));

      // Left / Right screen canvas edges
      if (_p1.x < -limX) {
        _p1.x = -limX;
        clamped = true;
        if (_p2.x < 0) {
          impact = Math.max(impact, -_p2.x / scale);
          _p2.x = -_p2.x * wallBounce;
          _p2.y *= wallFriction;
          _p2.z *= wallFriction;
          bounced = true;
        }
      } else if (_p1.x > limX) {
        _p1.x = limX;
        clamped = true;
        if (_p2.x > 0) {
          impact = Math.max(impact, _p2.x / scale);
          _p2.x = -_p2.x * wallBounce;
          _p2.y *= wallFriction;
          _p2.z *= wallFriction;
          bounced = true;
        }
      }

      // Bottom / Top screen canvas edges
      let hitBottom = false;
      if (_p1.y < -limY) {
        _p1.y = -limY;
        clamped = true;
        hitBottom = true;
        if (_p2.y < 0) {
          impact = Math.max(impact, -_p2.y / scale);
          _p2.y = -_p2.y * wallBounce;
          _p2.x *= wallFriction;
          _p2.z *= wallFriction;
          bounced = true;
        }
      } else if (_p1.y > limY) {
        _p1.y = limY;
        clamped = true;
        if (_p2.y > 0) {
          impact = Math.max(impact, _p2.y / scale);
          _p2.y = -_p2.y * wallBounce;
          _p2.x *= wallFriction;
          _p2.z *= wallFriction;
          bounced = true;
        }
      }

      if (!clamped && !bounced) continue;

      // Convert clamped world position & velocity back to model-local space
      _v.copy(_p1).sub(fr.pos).applyQuaternion(invQuat).divideScalar(scale).add(fr.pivot);
      _v2.copy(_p2).applyQuaternion(invQuat).divideScalar(scale);

      // Keep above the tabletop ground plane (y = 0)
      if (_v.y < b.half[1]) {
        _v.y = b.half[1];
        if (_v2.y < 0) {
          impact = Math.max(impact, -_v2.y);
          _v2.y = -_v2.y * 0.54;
          bounced = true;
        }
      }

      // If the brick is on the tabletop at the bottom screen edge, slide & bounce
      // it inward along the tabletop so it never wedges or slips below the screen.
      if (hitBottom && _v.y <= b.half[1] + 0.35) {
        _s.set(0, 1, 0).applyQuaternion(invQuat);
        const hx = _s.x;
        const hz = _s.z;
        const hLen = Math.hypot(hx, hz);
        if (hLen > 0.05) {
          const nx = hx / hLen;
          const nz = hz / hLen;
          // Re-verify world Y at _v.y = b.half[1]
          _p1.copy(_v).sub(fr.pivot).multiplyScalar(scale).applyQuaternion(fr.quat).add(fr.pos);
          if (_p1.y < -limY) {
            const push = (-limY - _p1.y) / (scale * hLen);
            _v.x += nx * push;
            _v.z += nz * push;
          }
          const vn = _v2.x * nx + _v2.z * nz;
          if (vn < 0) {
            impact = Math.max(impact, -vn);
            _v2.x -= (1 + wallBounce) * vn * nx;
            _v2.z -= (1 + wallBounce) * vn * nz;
            bounced = true;
          }
        }
      }

      body.position.set(_v.x, _v.y, _v.z);
      body.previousPosition.set(_v.x, _v.y, _v.z);
      body.interpolatedPosition.set(_v.x, _v.y, _v.z);

      if (bounced) {
        body.velocity.set(_v2.x, _v2.y, _v2.z);
        if (impact > 2.5) {
          body.wakeUp();
          const spin = Math.min(14, impact * 0.18);
          body.angularVelocity.x += (this._rand() - 0.5) * spin;
          body.angularVelocity.y += (this._rand() - 0.5) * spin;
          body.angularVelocity.z += (this._rand() - 0.5) * spin;
        }
        if (impact > loudestImpact) loudestImpact = impact;
      }
    }

    if (loudestImpact > 3.5) {
      this._play(loudestImpact > 10 ? 'click' : 'tick');
    }
  }

  _tickPhysics(dt) {
    const s = this._session;
    if (!s) return false;
    let awake = 0;
    if (this.physics.count > 0) {
      awake = this.physics.step(dt);
      this._constrainToScreenCanvas(s.key);
    }
    if (s.kind === 'knock') {
      let anyLoose = false;
      let anyReturn = false;
      let maxSpeedSq = 0;
      for (const b of this._bricks) {
        if (b.mode === 'loose') {
          anyLoose = true;
          const body = this.physics.bodies.get(b.id);
          if (body) {
            const v = body.velocity;
            const spSq = v.x * v.x + v.y * v.y + v.z * v.z;
            if (spSq > maxSpeedSq) maxSpeedSq = spSq;
          }
        } else if (b.mode === 'return') {
          anyReturn = true;
        }
      }
      // Let fast-thrown bricks finish bouncing before starting auto-return
      if (maxSpeedSq > 16) {
        this._lastInteract = Math.max(this._lastInteract, this._time - (IDLE_RETURN - 1.1));
      }
      if (anyLoose && !this._ptr.drag && this._time - this._lastInteract > IDLE_RETURN) this._startReturns();
      else if (!anyLoose && !anyReturn && !this._ptr.drag) this._endSession();
    }
    return awake > 0 || !!this._ptr.drag;
  }

  _startReturns() {
    const list = this._bricks.filter((b) => b.mode === 'loose' && b.model === this._session.key);
    list.sort(
      (a, b) =>
        this._entryPose(this.models[a.model], a.entry, _A).pos.y -
        this._entryPose(this.models[b.model], b.entry, _B).pos.y,
    );
    list.forEach((b, i) => {
      this.physics.remove(b.id);
      if (!b.ret) b.ret = { from: new Pose(), t: 0, dur: 0.6, landed: false };
      b.ret.from.copy(b.lp);
      const home = this._entryPose(this.models[b.model], b.entry, _A).pos;
      const dist = b.lp.pos.distanceTo(home);
      b.ret.t = -i * 0.032;
      b.ret.dur = this._reduced ? 0.3 : 0.55 + Math.min(0.32, dist * 0.006) + b.rnd * 0.14;
      b.ret.landed = false;
      b.mode = 'return';
    });
    this.physics.clearBricks();
  }

  _tickReturn(b, dt) {
    const r = b.ret;
    r.t += dt;
    if (r.t <= 0) {
      b.lp.copy(r.from);
      return;
    }
    const u = Math.min(1, r.t / r.dur);
    const travel = 0.78;
    const e = easeInOut(Math.min(1, u / travel));
    this._entryPose(this.models[b.model], b.entry, _L);
    const arcLift = Math.max(3, Math.min(11, r.from.pos.distanceTo(_L.pos) * 0.22));
    _p1.copy(r.from.pos).add(_v.set(0, arcLift, 0));
    _p2.copy(_L.pos).add(_v.set(0, Math.max(2.4, arcLift * 0.75), 0));
    bezier(b.lp.pos, r.from.pos, _p1, _p2, _L.pos, e);
    b.lp.quat.slerpQuaternions(r.from.quat, _L.quat, e);
    b.lp.scl = _L.scl;
    if (u > travel) {
      const k = (u - travel) / (1 - travel);
      b.sq = Math.sin(k * Math.PI * 2) * Math.exp(-3.5 * k);
      if (!r.landed) {
        r.landed = true;
        this._play('snap');
      }
    }
    if (u >= 1) {
      b.sq = 0;
      b.mode = 'rest';
    }
  }

  /**
   * Physics support law: determines which remaining bricks in `members` still
   * have a valid structural load path down to the baseplate (`g === 'base'`).
   * Any brick whose bottom supports are broken (or whose center of mass tips
   * off its remaining broken foundation) is added to `loose` so it falls under gravity.
   */
  _cascadeUnsupported(model, members, loose) {
    if (!model || model.kind !== 'static') return;
    const owner = new Map();
    for (const b of members) {
      if (!loose.has(b)) owner.set(b.entry, b);
    }

    const supRange = new Map();
    const supported = new Set();

    // 1. Baseplate plates (`g === 'base'`) form the fixed foundation.
    for (const [entryIdx] of owner) {
      const e = model.bricks[entryIdx];
      if (e.g === 'base') {
        const [sx] = footprint(e);
        supRange.set(entryIdx, [e.x - sx / 2, e.x + sx / 2]);
        supported.add(entryIdx);
      }
    }

    // 2. Propagate upward (course by course) and laterally for same-course cantilevers.
    const sortedEntries = [...owner.keys()].sort((a, b) => model.bricks[a].y - model.bricks[b].y);
    let changed = true;
    while (changed) {
      changed = false;
      for (const idx of sortedEntries) {
        if (supported.has(idx)) continue;
        const e = model.bricks[idx];
        const [sx] = footprint(e);
        const bx0 = e.x - sx / 2;
        const bx1 = e.x + sx / 2;

        // Real vertical supports underneath `e` (excluding hanging bricks that had no `sup` of their own)
        const realBelow = e.sup.filter((s) => {
          const se = model.bricks[s];
          return se && (se.g === 'base' || se.sup.length > 0 || se.side.length > 0);
        });

        if (realBelow.length > 0) {
          const activeBelow = realBelow.filter((s) => supRange.has(s));
          if (activeBelow.length === 0) continue;

          let ux0 = Infinity;
          let ux1 = -Infinity;
          for (const s of activeBelow) {
            const [sx0, sx1] = supRange.get(s);
            ux0 = Math.min(ux0, sx0);
            ux1 = Math.max(ux1, sx1);
          }
          const cx0 = Math.max(bx0, ux0);
          const cx1 = Math.min(bx1, ux1);

          if (activeBelow.length === realBelow.length) {
            if (cx1 - cx0 > 0.05) {
              const fullBeneath = activeBelow.every((s) => {
                const se = model.bricks[s];
                const [ssx] = footprint(se);
                const [rx0, rx1] = supRange.get(s);
                return rx1 - rx0 >= ssx - 0.05;
              });
              if (fullBeneath) {
                supRange.set(idx, [bx0, bx1]);
                supported.add(idx);
                changed = true;
              } else if (e.x >= cx0 + 0.15 && e.x <= cx1 - 0.15) {
                supRange.set(idx, [cx0, cx1]);
                supported.add(idx);
                changed = true;
              }
            }
          } else if (cx1 - cx0 >= 0.9 && e.x >= cx0 + 0.25 && e.x <= cx1 - 0.25) {
            // Partial foundation lost: only stays up if center of mass is well inside remaining support
            supRange.set(idx, [cx0, cx1]);
            supported.add(idx);
            changed = true;
          }
        } else if (e.sup.length === 0 && e.side.length > 0) {
          const activeSide = e.side.filter((s) => supRange.has(s));
          if (activeSide.length === e.side.length && activeSide.length > 0) {
            supRange.set(idx, [bx0, bx1]);
            supported.add(idx);
            changed = true;
          }
        }
      }
    }

    // 3. Downward-hanging pieces (e.g. middle tip of M with `e.sup.length === 0`)
    // stay attached only if every brick directly above them is still supported.
    for (const idx of sortedEntries) {
      if (supported.has(idx)) continue;
      const e = model.bricks[idx];
      if (e.sup.length === 0 && e.above.length > 0 && e.above.every((a) => supported.has(a))) {
        supported.add(idx);
      }
    }

    // 4. Any non-base brick not in `supported` has no connection to the base and must fall!
    for (const [idx, b] of owner) {
      const e = model.bricks[idx];
      if (e.g !== 'base' && !supported.has(idx)) {
        loose.add(b);
      }
    }
  }

  /** Knock: bricks around the hit point burst loose (plus anything they held up). */
  _knock(hitBrick, hitLocal) {
    const key = this._shown;
    const model = this.models[key];
    if (!model) return;
    if (hitBrick && model.bricks[hitBrick.entry]?.g === 'base') return;
    this._ensureSession(key);
    const strength = this._reduced ? 0.5 : 1;
    const centre = (b, out) => this._entryPose(model, b.entry, out).pos.add(_v.set(0, b.info.h / 2, 0));
    const members = this._bricks.filter(
      (b) => b.model === key && (b.mode === 'rest' || b.mode === 'hold' || b.mode === 'return') && !this._isTuck(b),
    );
    const loose = new Set();
    const hitGroup = hitBrick ? model.bricks[hitBrick.entry]?.g : null;
    const blastRadius = hitBrick ? 1.75 : KNOCK_R;
    for (const b of members) {
      const e = model.bricks[b.entry];
      if (!e || e.g === 'base') continue;
      if (hitGroup !== null && e.g !== hitGroup) continue;
      if (centre(b, _A).distanceTo(hitLocal) < blastRadius) loose.add(b);
    }
    if (hitBrick && members.includes(hitBrick) && model.bricks[hitBrick.entry]?.g !== 'base') {
      loose.add(hitBrick);
    }
    const direct = new Set(loose);
    this._cascadeUnsupported(model, members, loose);

    for (const b of members) {
      if (loose.has(b)) continue;
      if (centre(b, _A).distanceTo(hitLocal) < 14) {
        const pose = this._entryPose(model, b.entry, _B);
        _v.set(0, b.info.h / 2, 0).add(pose.pos);
        this.physics.addStatic(b.id, { half: b.half, pos: _v.clone(), quat: pose.quat.clone() });
      }
    }
    const rnd = this._rand;
    const towardCam = _v2.set(0, 0, 1).applyQuaternion(_q.copy(this._frames[key].quat).invert());
    const tc = towardCam.clone();
    for (const b of loose) {
      if (b.mode === 'return') {
        b.ret.t = 0;
      } else {
        this._restLocal(b, b.lp);
      }
      const c = centre(b, _A);
      const d = c.distanceTo(hitLocal);
      const dir = _p1.copy(c).sub(hitLocal);
      dir.y = 0;
      if (dir.lengthSq() < 1e-4) dir.set(rnd() - 0.5, 0, rnd() - 0.5);
      dir.normalize();
      let vel;
      if (direct.has(b)) {
        const fall = 1 - Math.min(1, d / KNOCK_R) * 0.45;
        vel = {
          x: (dir.x * (3.5 + rnd() * 4) + tc.x * 2.2) * fall * strength,
          y: (4.2 + rnd() * 4.2) * fall * strength + tc.y * 1.8,
          z: (dir.z * (3.5 + rnd() * 4) + tc.z * 2.2) * fall * strength,
        };
      } else {
        // Unsupported top sections fall downward under gravity
        vel = {
          x: (rnd() - 0.5) * 0.9,
          y: -0.6 - rnd() * 0.6,
          z: (rnd() - 0.5) * 0.9,
        };
      }
      const w = (direct.has(b) ? 9 : 3.2) * strength;
      this._addBody(b, vel, { x: (rnd() - 0.5) * w, y: (rnd() - 0.5) * w, z: (rnd() - 0.5) * w });
    }
    this._lastInteract = this._time;
    this._play('pop');
    if (key === 'hero' && this.minifig && this.showMinifig) {
      this.minifig.jump?.();
      this._fig.busyUntil = this._time + 1.5;
    }
    this._dirty = true;
  }

  // ---------------------------------------------------------------- input

  _bindGlobal() {
    const onTheme = (e) => this.setTheme(e.detail && e.detail.theme);
    window.addEventListener('themechange', onTheme);
    this._listeners.push(() => window.removeEventListener('themechange', onTheme));
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas);
      this._listeners.push(() => ro.disconnect());
    }

    // Allow grabbing/throwing loose bricks that landed anywhere on the screen canvas
    // outside `.stage-slot`, and ensure drag tracking continues across the whole window.
    const isInteractiveTarget = (t) =>
      t instanceof Element &&
      Boolean(t.closest('button, a, input, select, textarea, label, dialog, [role="button"]'));

    const onWinDown = (e) => {
      if (e.button !== undefined && e.button > 0) return;
      const key = this._shown;
      if (!key) return;
      const slotEl = this._slots.get(key);
      if (slotEl && e.target instanceof Node && slotEl.contains(e.target)) return;
      if (isInteractiveTarget(e.target)) return;
      this._ptr.x = e.clientX;
      this._ptr.y = e.clientY;
      const hit = this._pick();
      if (hit && hit.b) {
        this._onDown(e, key, slotEl || document.body);
      }
    };
    const onWinMove = (e) => {
      const key = this._shown;
      if (!key) return;
      const slotEl = this._slots.get(key);
      if (slotEl && e.target instanceof Node && slotEl.contains(e.target)) return;
      if (this._ptr.drag || this._ptr.orbit || this._ptr.down) {
        this._onMove(e, key);
      }
    };
    const onWinUp = (e) => {
      const key = this._shown;
      if (!key) return;
      const slotEl = this._slots.get(key);
      if (slotEl && e.target instanceof Node && slotEl.contains(e.target)) return;
      if (this._ptr.drag || this._ptr.orbit || this._ptr.down) {
        this._onUp(e, key, slotEl || document.body);
      }
    };
    window.addEventListener('pointerdown', onWinDown);
    window.addEventListener('pointermove', onWinMove);
    window.addEventListener('pointerup', onWinUp);
    this._listeners.push(() => {
      window.removeEventListener('pointerdown', onWinDown);
      window.removeEventListener('pointermove', onWinMove);
      window.removeEventListener('pointerup', onWinUp);
    });
  }

  _bindSlot(el, name) {
    const on = (type, fn, opts) => {
      el.addEventListener(type, fn, opts);
      this._listeners.push(() => el.removeEventListener(type, fn, opts));
    };
    on('pointermove', (e) => this._onMove(e, name));
    on('pointerdown', (e) => this._onDown(e, name, el));
    on('pointerup', (e) => this._onUp(e, name, el));
    on('pointercancel', () => this._onCancel());
    on('pointerleave', (e) => this._onLeave(e, name, el));
    const block = (e) => {
      if (this._ptr.grabbing || this._ptr.orbit) e.preventDefault();
    };
    on('touchstart', block, { passive: false });
    on('touchmove', block, { passive: false });
  }

  _onMove(e, name) {
    const p = this._ptr;
    const now = performance.now();
    const dtm = Math.max(1, now - p.lastT);
    if (p.lastT && p.x >= 0) {
      p.vx = ((e.clientX - p.x) / dtm) * 1000;
      p.vy = ((e.clientY - p.y) / dtm) * 1000;
      p.speed = Math.hypot(p.vx, p.vy);
    }
    p.lastT = now;
    p.x = e.clientX;
    p.y = e.clientY;
    p.type = e.pointerType;
    p.slot = name;
    p.inside = true;
    p.moved = true;

    if (p.orbit) {
      const fr = this._frames[p.orbit.key];
      if (fr) {
        const dx = e.clientX - p.orbit.lastX;
        const dy = e.clientY - p.orbit.lastY;
        p.orbit.lastX = e.clientX;
        p.orbit.lastY = e.clientY;
        fr.orbit.targetYaw += dx * 0.011;
        fr.orbit.targetTilt = clamp(fr.orbit.targetTilt + dy * 0.008, -65 * DEG, 65 * DEG);
        this._dirty = true;
      }
      return;
    }

    const d = p.down;
    if (d && !p.drag && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) {
      const horizontal = Math.abs(e.clientX - d.x) > Math.abs(e.clientY - d.y);
      if (e.pointerType !== 'touch' || horizontal) {
        const model = this.models[this._shown];
        const isBase = d.brick && model && model.bricks[d.brick.entry]?.g === 'base';
        if (d.brick && !isBase) {
          this._startDrag(d.brick, d.local, d.el, e.pointerId);
        } else {
          this._startOrbit(d.el, e.pointerId, e.clientX, e.clientY);
        }
      }
    }
    if (p.drag || name === this._shown) this._dirty = true;
  }

  _onDown(e, name, el) {
    if (e.button !== undefined && e.button > 0) return;
    const p = this._ptr;
    p.x = e.clientX;
    p.y = e.clientY;
    p.slot = name;
    p.inside = true;
    p.type = e.pointerType;
    p.down = null;
    p.grabbing = false;
    if (name !== this._shown) return;
    const hit = this._pick();
    const isFig = !hit && name === 'hero' && this._fig.wrap && this._fig.wrap.visible && this._figHit();
    p.down = {
      x: e.clientX,
      y: e.clientY,
      t: this._time,
      brick: hit ? hit.b : null,
      local: hit ? hit.local : null,
      fig: Boolean(isFig),
      el,
    };
  }

  _onUp(e, name, el) {
    const p = this._ptr;
    const d = p.down;
    p.down = null;
    if (p.orbit) {
      this._endOrbit();
      return;
    }
    if (p.drag) {
      this._endDrag(true);
      return;
    }
    if (!d || name !== this._shown) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    if (d.fig) {
      this.triggerMinifigWave();
    } else if (d.brick) {
      this._knock(d.brick, d.local);
    }
    void el;
  }

  _onCancel() {
    const p = this._ptr;
    p.down = null;
    if (p.orbit) this._endOrbit();
    if (p.drag) this._endDrag(true);
    p.grabbing = false;
  }

  _onLeave(e, name, el) {
    const p = this._ptr;
    if (p.drag || p.orbit) return;
    if (p.slot === name) {
      p.inside = false;
      p.moved = true;
    }
    el.style.cursor = '';
    this._setHover(null);
    this._dirty = true;
  }

  _startOrbit(el, pointerId, x, y) {
    const key = this._shown;
    if (!key || !this._frames[key]) return;
    const p = this._ptr;
    p.orbit = { key, el, lastX: x, lastY: y };
    p.down = null;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // Synthetic events have no capturable pointer.
    }
    el.style.cursor = 'grabbing';
    el.style.touchAction = 'none';
    this._setHover(null);
    this._dirty = true;
  }

  _endOrbit() {
    const p = this._ptr;
    const o = p.orbit;
    if (!o) return;
    o.el.style.cursor = '';
    o.el.style.touchAction = '';
    p.orbit = null;
    this._dirty = true;
  }

  _rayFromPointer(out) {
    const ndcX = ((this._ptr.x - this._canvasRect.left) / this._vw) * 2 - 1;
    const ndcY = -(((this._ptr.y - this._canvasRect.top) / this._vh) * 2 - 1);
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    return out.copy(this._raycaster.ray);
  }

  /** Nearest interactive brick of the shown model under the pointer. */
  _pick() {
    const key = this._shown;
    if (!key || !this.models[key]) return null;
    this._rayFromPointer(_ray);
    let best = null;
    let bestT = Infinity;
    const o = _p1;
    const d = _p2;
    for (const b of this._bricks) {
      if (b.model !== key || b.hidden) continue;
      if (b.mode !== 'rest' && b.mode !== 'loose' && b.mode !== 'hold' && b.mode !== 'return') continue;
      if (b.mode === 'rest' && this._isTuck(b)) continue;
      _m.copy(b.matrix).invert();
      o.copy(_ray.origin).applyMatrix4(_m);
      d.copy(_ray.direction).applyMatrix3(_n3.setFromMatrix4(_m));
      const hx = b.half[0];
      const hz = b.half[2];
      const top = b.info.h + (b.info.studs ? STUD_H : 0);
      let t0 = -Infinity;
      let t1 = Infinity;
      const slab = (oo, dd, lo, hi) => {
        if (Math.abs(dd) < 1e-9) return oo >= lo && oo <= hi;
        let a = (lo - oo) / dd;
        let c = (hi - oo) / dd;
        if (a > c) [a, c] = [c, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, c);
        return t0 <= t1;
      };
      if (!slab(o.x, d.x, -hx, hx) || !slab(o.y, d.y, 0, top) || !slab(o.z, d.z, -hz, hz)) continue;
      if (t1 < 0) continue;
      const t = Math.max(0, t0);
      if (t < bestT) {
        bestT = t;
        best = b;
      }
    }
    if (!best) return null;
    const point = _ray.at(bestT, new THREE.Vector3());
    const local = point.clone().applyMatrix4(this._frames[key].inverse);
    return { b: best, point, local };
  }

  _figHit() {
    if (!this._fig.wrap) return false;
    const ndcX = ((this._ptr.x - this._canvasRect.left) / this._vw) * 2 - 1;
    const ndcY = -(((this._ptr.y - this._canvasRect.top) / this._vh) * 2 - 1);
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    return this._raycaster.intersectObject(this._fig.wrap, true).length > 0;
  }

  _setHover(b) {
    const p = this._ptr;
    if (p.hover === b) return;
    if (p.hover) p.hover.ht = 0;
    p.hover = b;
    if (b) b.ht = 1;
    this._dirty = true;
  }

  _startDrag(b, local, el, pointerId) {
    const key = this._shown;
    const model = this.models[key];
    if (!model || !b) return;
    if (model.bricks[b.entry]?.g === 'base') return;
    this._ensureSession(key);
    if (b.mode === 'rest' || b.mode === 'hold' || b.mode === 'return') {
      const members = this._bricks.filter(
        (m) => m.model === key && (m.mode === 'rest' || m.mode === 'hold' || m.mode === 'return') && !this._isTuck(m),
      );
      const loose = new Set([b]);
      this._cascadeUnsupported(model, members, loose);
      const centre = (m, out) => this._entryPose(model, m.entry, out).pos.add(_v.set(0, m.info.h / 2, 0));
      for (const m of members) {
        if (loose.has(m)) continue;
        if (centre(m, _A).distanceTo(local) < 14) {
          const pose = this._entryPose(model, m.entry, _B);
          _v.set(0, m.info.h / 2, 0).add(pose.pos);
          this.physics.addStatic(m.id, { half: m.half, pos: _v.clone(), quat: pose.quat.clone() });
        }
      }
      if (b.mode === 'rest') this._restLocal(b, b.lp);
      this._addBody(b, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      const rnd = this._rand;
      for (const m of loose) {
        if (m === b) continue;
        if (m.mode === 'return') m.ret.t = 0;
        else this._restLocal(m, m.lp);
        this._addBody(
          m,
          { x: (rnd() - 0.5) * 0.8, y: -0.5 - rnd() * 0.5, z: (rnd() - 0.5) * 0.8 },
          { x: (rnd() - 0.5) * 2.5, y: (rnd() - 0.5) * 2.5, z: (rnd() - 0.5) * 2.5 },
        );
      }
    }
    if (b.mode !== 'loose') return;
    const fr = this._frames[key];
    const p = this._ptr;
    // Always drag on a plane parallel to the screen canvas so the user can
    // fling bricks across the entire viewport from any rotation angle.
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(_q.copy(fr.quat).invert()).normalize();
    const point = local.clone();
    this.physics.startGrab(b.id, local);
    p.drag = { b, normal, point, el };
    p.grabbing = true;
    p.down = null;
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // Synthetic events have no capturable pointer.
    }
    el.style.cursor = 'grabbing';
    el.style.touchAction = 'none';
    this._lastInteract = this._time;
    this._setHover(null);
    this._play('click');
  }

  _endDrag(throwIt) {
    const p = this._ptr;
    const d = p.drag;
    if (!d) return;
    const speed = this.physics.release(throwIt ? 115 : 0);
    if (throwIt && speed > 18) this._play('whoosh');
    d.el.style.cursor = '';
    d.el.style.touchAction = '';
    p.drag = null;
    p.grabbing = false;
    this._lastInteract = this._time;
  }

  _tickPointer() {
    const p = this._ptr;
    const key = this._shown;
    if (p.drag) {
      const fr = this._frames[key];
      if (!fr || !fr.valid) {
        this._endDrag(false);
        return;
      }
      this._rayFromPointer(_ray);
      _ray.applyMatrix4(_m.copy(fr.inverse));
      _plane.setFromNormalAndCoplanarPoint(p.drag.normal, p.drag.point);
      if (_ray.intersectPlane(_plane, _v)) {
        _v.y = Math.max(_v.y, p.drag.b.half[1]);
        this._clampLocalToScreen(_v, p.drag.b, fr);
        this.physics.moveGrab(_v);
      }
      this._lastInteract = this._time;
      return;
    }
    if (!p.moved) return;
    p.moved = false;
    const el = key && this._slots.get(key);
    if (!p.inside || p.slot !== key || !el) {
      this._setHover(null);
      return;
    }
    if (this._fig.wrap && key === 'hero') {
      const ndcX = ((p.x - this._canvasRect.left) / this._vw) * 2 - 1;
      const ndcY = -(((p.y - this._canvasRect.top) / this._vh) * 2 - 1);
      this.minifig.lookAt?.(ndcX, ndcY);
      this._fig.busyUntil = Math.max(this._fig.busyUntil, this._time + 0.6);
    }
    const hit = this._pick();
    const model = key && this.models[key];
    const isBase = hit && model && model.bricks[hit.b.entry]?.g === 'base';
    const b = hit && !isBase && hit.b.mode === 'rest' && !this._isTuck(hit.b) ? hit.b : null;
    this._setHover(b);
    el.style.cursor = hit && !isBase ? 'pointer' : 'grab';
  }

  // ---------------------------------------------------------------- render

  _updateLight() {
    const key = this._shown || this._lastShown;
    const fr = key && this._frames[key];
    if (!fr || !fr.fitted) return;
    const radius = fr.box.getSize(_v).length() * 0.5 * fr.scale;
    const key3 = this.lights.key;
    const target = fr.pos;
    key3.position.copy(target).addScaledVector(LIGHT_DIR, radius * 3 + 30);
    key3.target.position.copy(target);
    key3.target.updateMatrixWorld();
    const cam = key3.shadow.camera;
    let ext = radius * 1.15;
    if (this._session && this._session.key === key) {
      for (const b of this._bricks) {
        if ((b.mode === 'loose' || b.mode === 'return') && b.model === key) {
          const d = b.wp.pos.distanceTo(target) + 2.5;
          if (d > ext) ext = d;
        }
      }
      ext = Math.min(ext, radius * 3.8);
    }
    if (Math.abs(cam.right - ext) > 1e-2) {
      cam.left = -ext;
      cam.right = ext;
      cam.top = ext;
      cam.bottom = -ext;
      cam.near = 1;
      cam.far = Math.max(radius * 6 + 70, ext * 4 + 80);
      cam.updateProjectionMatrix();
    }
    key3.shadow.normalBias = 0.02 * fr.scale;
    key3.shadow.bias = -0.0003;
    if (Math.abs(this._focusScale - fr.scale) > 1e-3) {
      this._focusScale = fr.scale;
      this.post.setAOScale(fr.scale);
    }
  }

  _render(dt) {
    this._updateLight();
    this.post.render(dt);
    this.frames++;
  }

  // ---------------------------------------------------------------- sound

  _play(name) {
    if (!this.sound || typeof this.sound.play !== 'function') return;
    const now = performance.now();
    if (now - (this._sounds.get(name) || 0) < SOUND_GAP) return;
    this._sounds.set(name, now);
    try {
      this.sound.play(name);
    } catch {
      // Audio is optional.
    }
  }

  // ---------------------------------------------------------------- QA helpers

  _finishAll() {
    for (const b of this._bricks) {
      if (b.mode === 'fly') {
        b.f.t = b.f.dur;
        this._tickFlight(b, 0);
        if (b.mode === 'fly') this._endFlight(b);
      } else if (b.mode === 'return') {
        b.ret.t = b.ret.dur;
        this._tickReturn(b, 0);
      }
    }
    for (const g of Object.values(this._grounds)) g.presence = g.presence > 0 ? 1 : 0;
    this._dirty = true;
  }

  _debugKnock(fx, fy) {
    const key = this._shown;
    const fr = key && this._frames[key];
    if (!fr || !fr.valid) return { ok: false, reason: 'no active model' };
    this._ptr.x = this._canvasRect.left + fr.rect.x + fr.rect.w * fx;
    this._ptr.y = this._canvasRect.top + fr.rect.y + fr.rect.h * fy;
    const hit = this._pick();
    if (!hit) return { ok: false, reason: 'miss' };
    this._knock(hit.b, hit.local);
    return { ok: true, loose: this.physics.count };
  }

  _debugState() {
    const modes = {};
    for (const b of this._bricks) modes[b.mode] = (modes[b.mode] || 0) + 1;
    return {
      active: this._active,
      shown: this._shown,
      word: this.word,
      palette: this.palette,
      showMinifig: this.showMinifig,
      tier: this.tier,
      pool: this.poolSize,
      modes,
      frames: this.frames,
      session: this._session && this._session.kind,
      bodies: this.physics.count,
      info: this.renderer.info.render,
    };
  }
}
