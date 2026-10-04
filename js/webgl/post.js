// Post-processing and quality tiers for the stage.
//
//   tier 0  direct render (no composer), DPR <= 1.5, 1024 shadow map
//   tier 1  RenderPass -> BgOutputPass (ACES + sRGB + page background) -> SMAA
//   tier 2  tier 1 + GTAO (soft contact darkening between studs and seams)
//
// The scene is rendered into a half-float target cleared to transparent
// black. BgOutputPass tone-maps the scene, converts to sRGB and only then
// composites over the theme background, so the canvas matches the page
// colour exactly (tone mapping the clear colour would shift it). Shadow
// catchers write black + alpha, which therefore darken the page colour.
// Addons are imported lazily so tier 0 devices never download them.

import * as THREE from 'three';
import { clamp } from '../core/utils.js';

const BG_OUTPUT = {
  vertexShader: /* glsl */ `
    precision highp float;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    attribute vec3 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec3 uBg;
    #include <tonemapping_pars_fragment>
    #include <colorspace_pars_fragment>
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float a = clamp(c.a, 0.0, 1.0);
      vec3 col = ACESFilmicToneMapping(c.rgb);
      col = sRGBTransferOETF(vec4(col, 1.0)).rgb;
      gl_FragColor = vec4(mix(uBg, col, a), 1.0);
    }`,
};

/** Picks a starting tier; `?tier=N` in the URL always wins. */
export function detectTier(renderer) {
  const forced = new URLSearchParams(window.location.search).get('tier');
  if (forced !== null && forced !== '') return clamp(Math.round(Number(forced)) || 0, 0, 2);
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
  } catch {
    // Some browsers hide the renderer string; fall back to device hints.
  }
  if (/swiftshader|llvmpipe|softpipe|software/i.test(gpu)) return 0;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.screen.width, window.screen.height) < 700;
  if (coarse && small) return 0;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8;
  if (coarse || cores <= 4 || mem <= 4 || /mali|adreno [1-5]|powervr|intel.*hd/i.test(gpu)) return 1;
  return 2;
}

/** Average frame time over a window; tells the stage to drop a tier. */
export class PerfMonitor {
  constructor({ budgetMs = 22, windowSec = 2 } = {}) {
    this.budget = budgetMs;
    this.window = windowSec * 1000;
    this.reset();
  }

  reset() {
    this.sum = 0;
    this.n = 0;
  }

  /** @returns {boolean} true when the last full window averaged over budget */
  sample(ms) {
    this.sum += ms;
    this.n++;
    if (this.sum < this.window) return false;
    const avg = this.sum / this.n;
    this.reset();
    return avg > this.budget;
  }
}

export class Post {
  /**
   * @param {{renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
   *   bg?: string, onChange?: () => void}} opts onChange fires when an async
   *   resource (SMAA lookup textures, a new tier) needs a re-render.
   */
  constructor({ renderer, scene, camera, bg = '#000000', onChange = null }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.onChange = onChange;
    this.tier = -1;
    this.composer = null;
    this.passes = {};
    this.bg = new THREE.Color(bg);
    this.size = { w: 1, h: 1 };
    this.aoScale = 1;
    this._token = 0;
  }

  get pixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    return Math.min(dpr, this.tier <= 0 ? 1.5 : 2);
  }

  /** Switches pipeline; resolves once the passes are ready. */
  async setTier(tier) {
    tier = clamp(tier, 0, 2);
    if (tier === this.tier) return;
    const token = ++this._token;
    let mods = null;
    if (tier > 0) {
      try {
        mods = await Promise.all([
          import('three/addons/postprocessing/EffectComposer.js'),
          import('three/addons/postprocessing/RenderPass.js'),
          import('three/addons/postprocessing/Pass.js'),
          import('three/addons/postprocessing/SMAAPass.js'),
          tier > 1 ? import('three/addons/postprocessing/GTAOPass.js') : null,
        ]);
      } catch (err) {
        console.warn('[stage] post-processing unavailable, using direct rendering', err);
        tier = 0;
      }
    }
    if (token !== this._token) return;
    this._disposeComposer();
    this.tier = tier;
    const r = this.renderer;
    r.setPixelRatio(this.pixelRatio);
    r.setSize(this.size.w, this.size.h, false);
    if (tier === 0) {
      r.setClearColor(this.bg, 1);
      this.onChange?.();
      return;
    }
    const [{ EffectComposer }, { RenderPass }, { Pass, FullScreenQuad }, { SMAAPass }, gtaoMod] = mods;
    r.setClearColor(0x000000, 0);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 0 });
    const composer = new EffectComposer(r, target);
    composer.setPixelRatio(this.pixelRatio);
    composer.setSize(this.size.w, this.size.h);
    const render = new RenderPass(this.scene, this.camera);
    composer.addPass(render);
    this.passes = { render };
    if (gtaoMod) {
      const { GTAOPass } = gtaoMod;
      const w = this.size.w * this.pixelRatio;
      const h = this.size.h * this.pixelRatio;
      // Half-resolution AO on dense screens: the denoiser hides the rest.
      const aoRes = this.pixelRatio > 1.25 ? 0.5 : 1;
      class StageGTAO extends GTAOPass {
        setSize(width, height) {
          super.setSize(Math.max(1, Math.round(width * aoRes)), Math.max(1, Math.round(height * aoRes)));
        }
      }
      const gtao = new StageGTAO(this.scene, this.camera, w, h);
      gtao.setSize(w, h);
      gtao.blendIntensity = 0.9;
      gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 12 });
      composer.addPass(gtao);
      this.passes.gtao = gtao;
      this.setAOScale(this.aoScale);
    }
    class BgOutputPass extends Pass {
      constructor() {
        super();
        this.uniforms = {
          tDiffuse: { value: null },
          toneMappingExposure: { value: 1 },
          uBg: { value: new THREE.Color() },
        };
        this.material = new THREE.RawShaderMaterial({
          name: 'StageBgOutput',
          uniforms: this.uniforms,
          vertexShader: BG_OUTPUT.vertexShader,
          fragmentShader: BG_OUTPUT.fragmentShader,
          depthTest: false,
          depthWrite: false,
        });
        this.fsQuad = new FullScreenQuad(this.material);
      }

      render(renderer, writeBuffer, readBuffer) {
        this.uniforms.tDiffuse.value = readBuffer.texture;
        this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.fsQuad.render(renderer);
      }

      dispose() {
        this.material.dispose();
        this.fsQuad.dispose();
      }
    }
    const output = new BgOutputPass();
    composer.addPass(output);
    this.passes.output = output;
    const smaa = new SMAAPass(this.size.w * this.pixelRatio, this.size.h * this.pixelRatio);
    // The lookup textures decode asynchronously; re-render when they land
    // or a render-on-demand canvas could keep an un-antialiased frame.
    for (const tex of [smaa.areaTexture, smaa.searchTexture]) {
      const img = tex.image;
      const prev = img.onload;
      img.onload = (e) => {
        prev?.call(img, e);
        this.onChange?.();
      };
    }
    composer.addPass(smaa);
    this.passes.smaa = smaa;
    this.composer = composer;
    this.setBackground(this.bg);
    this.onChange?.();
  }

  /** Theme background (any THREE.Color input; sRGB hex strings expected). */
  setBackground(color) {
    this.bg.set(color);
    if (this.tier <= 0 || !this.composer) {
      this.renderer.setClearColor(this.bg, 1);
      return;
    }
    // The composite happens after the sRGB transfer, so pass sRGB values.
    this.bg.getRGB(this.passes.output.uniforms.uBg.value, THREE.SRGBColorSpace);
    this.renderer.setClearColor(0x000000, 0);
  }

  /** AO radius follows the on-screen size of a stud (world units per stud). */
  setAOScale(unitsPerStud) {
    this.aoScale = unitsPerStud;
    const gtao = this.passes.gtao;
    if (!gtao) return;
    gtao.updateGtaoMaterial({
      radius: 0.55 * unitsPerStud,
      distanceExponent: 1.6,
      thickness: 0.9 * unitsPerStud,
      scale: 1,
      samples: 12,
      distanceFallOff: 1,
      screenSpaceRadius: false,
    });
  }

  setSize(w, h) {
    this.size.w = Math.max(1, w);
    this.size.h = Math.max(1, h);
    const r = this.renderer;
    r.setPixelRatio(this.pixelRatio);
    r.setSize(this.size.w, this.size.h, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.pixelRatio);
      this.composer.setSize(this.size.w, this.size.h);
    }
  }

  render(dt = 0) {
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  _disposeComposer() {
    if (!this.composer) return;
    for (const p of Object.values(this.passes)) p.dispose?.();
    this.composer.renderTarget1.dispose();
    this.composer.renderTarget2.dispose();
    this.composer = null;
    this.passes = {};
  }

  dispose() {
    this._token++;
    this._disposeComposer();
  }
}
