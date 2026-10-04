// Brick geometry, plastic material and renderer helpers shared by every
// WebGL scene (the fixed stage and the builder playground).
//
// Units: 1 world unit = 1 stud pitch (8 mm). A brick is 1.2 tall (9.6 mm), a
// plate 0.4. Geometry origin = centre of the footprint, y = 0 at the bottom,
// studs on top. Bodies are shrunk by GAP so neighbouring bricks show a fine
// seam, which is what makes a model read as "built".

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BRICK, THEMES } from './palette.js';

export const PITCH = 1;
export const BRICK_H = 1.2;
export const PLATE_H = 0.4;
export const STUD_R = 0.3; // 4.8 mm diameter
export const STUD_H = 0.2125; // 1.7 mm
export const GAP = 0.035;
export const WALL = 0.15; // 1.2 mm side walls
export const TOP_T = 0.125; // 1.0 mm top
const TUBE_R = 0.4069; // 6.51 mm outer tube diameter
const PIN_R = 0.16; // solid pin under 1xN bricks

const cache = new Map();

const nonIndexed = (g) => (g.index ? g.toNonIndexed() : g);

/** A single stud: a short cylinder with a softly rounded top edge. */
export function studGeometry(segments = 20) {
  const key = `stud:${segments}`;
  if (cache.has(key)) return cache.get(key);
  const e = 0.045;
  const pts = [new THREE.Vector2(0, 0), new THREE.Vector2(STUD_R, 0), new THREE.Vector2(STUD_R, STUD_H - e)];
  for (let i = 1; i <= 4; i++) {
    const a = (i / 4) * (Math.PI / 2);
    pts.push(new THREE.Vector2(STUD_R - e + Math.cos(a) * e, STUD_H - e + Math.sin(a) * e));
  }
  pts.push(new THREE.Vector2(0, STUD_H));
  const g = nonIndexed(new THREE.LatheGeometry(pts, segments));
  cache.set(key, g);
  return g;
}

/** Copies only the triangles of a non-indexed geometry for which keep(i) is true. */
function filterTriangles(g, keep) {
  const out = new THREE.BufferGeometry();
  const tris = [];
  for (let i = 0; i < g.attributes.position.count; i += 3) if (keep(i)) tris.push(i);
  for (const [name, attr] of Object.entries(g.attributes)) {
    const s = attr.itemSize;
    const arr = new Float32Array(tris.length * 3 * s);
    let o = 0;
    for (const i of tris) for (let k = 0; k < 3 * s; k++) arr[o++] = attr.array[i * s + k];
    out.setAttribute(name, new THREE.BufferAttribute(arr, s));
  }
  return out;
}

/** Drops the flat downward-facing face (all three normals point straight down). */
function openBottom(g) {
  const n = g.attributes.normal;
  return filterTriangles(g, (i) => !(n.getY(i) < -0.999 && n.getY(i + 1) < -0.999 && n.getY(i + 2) < -0.999));
}

/** Reverses winding and normals so a closed shape is seen from the inside. */
function turnInsideOut(g) {
  const swap = (arr, s) => {
    for (let t = 0; t < arr.length; t += 3 * s) {
      for (let c = 0; c < s; c++) {
        const a = t + s + c;
        const b = t + 2 * s + c;
        const tmp = arr[a];
        arr[a] = arr[b];
        arr[b] = tmp;
      }
    }
  };
  swap(g.attributes.position.array, 3);
  swap(g.attributes.normal.array, 3);
  if (g.attributes.uv) swap(g.attributes.uv.array, 2);
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return g;
}

/** Flat ring (rectangle with a rectangular hole) facing down at height y. */
function bottomRing(ow, od, iw, id, y) {
  const s = new THREE.Shape();
  s.moveTo(-ow / 2, -od / 2).lineTo(ow / 2, -od / 2).lineTo(ow / 2, od / 2).lineTo(-ow / 2, od / 2).closePath();
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, -id / 2).lineTo(-iw / 2, id / 2).lineTo(iw / 2, id / 2).lineTo(iw / 2, -id / 2).closePath();
  s.holes.push(hole);
  const g = nonIndexed(new THREE.ShapeGeometry(s));
  g.rotateX(Math.PI / 2); // shape normal +z -> -y (faces down)
  g.translate(0, y, 0);
  return g;
}

/** Underside tube (2xN) or pin (1xN), from the bottom up to the ceiling. */
function tubeGeometry(outer, inner, y0, y1, segments = 16) {
  const pts = inner > 0
    ? [new THREE.Vector2(inner, y0), new THREE.Vector2(outer, y0), new THREE.Vector2(outer, y1), new THREE.Vector2(inner, y1), new THREE.Vector2(inner, y0)]
    : [new THREE.Vector2(0, y0), new THREE.Vector2(outer, y0), new THREE.Vector2(outer, y1), new THREE.Vector2(0, y1)];
  return nonIndexed(new THREE.LatheGeometry(pts, segments));
}

/**
 * Brick/plate/tile geometry, cached per size. Real-brick proportions: studs
 * 4.8 mm wide and 1.7 mm tall on an 8 mm pitch, 1.2 mm walls, and (when
 * `hollow`) an open underside with tubes or pins so tumbling bricks look
 * right from below.
 * @param {number} w studs along x
 * @param {number} d studs along z
 * @param {{h?: number, studs?: boolean, hollow?: boolean, bevel?: number, segments?: number, studSegments?: number}} opts
 */
export function brickGeometry(w = 1, d = 1, opts = {}) {
  const { h = BRICK_H, studs = true, hollow = true, bevel = 0.045, segments = 3, studSegments = 20 } = opts;
  const key = `brick:${w}x${d}x${h}:${studs}:${hollow}:${bevel}:${segments}:${studSegments}`;
  if (cache.has(key)) return cache.get(key);
  const bw = w * PITCH - GAP;
  const bd = d * PITCH - GAP;
  const y0 = GAP / 2;
  const y1 = h - GAP / 2;
  let body = nonIndexed(new RoundedBoxGeometry(bw, h - GAP, bd, segments, bevel));
  body.translate(0, h / 2, 0);
  const parts = [];
  if (hollow) {
    const open = openBottom(body);
    body.dispose();
    body = open;
    const iw = bw - 2 * WALL;
    const id = bd - 2 * WALL;
    const ih = y1 - TOP_T - y0;
    const rIn = 0.012;
    const cavity = turnInsideOut(openBottom(nonIndexed(new RoundedBoxGeometry(iw, ih, id, 1, rIn))));
    cavity.translate(0, y0 + ih / 2, 0);
    // The ring overlaps both openings a hair and sits 1.5 thou inside so
    // there is never a crack or z-fighting where it meets the bevels.
    const lift = 0.0015;
    parts.push(cavity, bottomRing(bw - 2 * bevel + 0.01, bd - 2 * bevel + 0.01, iw - 2 * rIn - 0.01, id - 2 * rIn - 0.01, y0 + lift));
    const ceil = y1 - TOP_T + 0.002;
    if (w >= 2 && d >= 2) {
      for (let i = 0; i < w - 1; i++) {
        for (let j = 0; j < d - 1; j++) {
          parts.push(tubeGeometry(TUBE_R, STUD_R, y0 + lift, ceil).translate((i - (w - 2) / 2) * PITCH, 0, (j - (d - 2) / 2) * PITCH));
        }
      }
    } else if (w * d >= 2) {
      const n = Math.max(w, d);
      for (let i = 0; i < n - 1; i++) {
        const off = (i - (n - 2) / 2) * PITCH;
        parts.push(tubeGeometry(PIN_R, 0, y0 + lift, ceil, 12).translate(w > 1 ? off : 0, 0, d > 1 ? off : 0));
      }
    }
  }
  parts.unshift(body);
  if (studs) {
    const stud = studGeometry(studSegments);
    const top = y1 - 0.004;
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < d; j++) {
        parts.push(stud.clone().translate((i - (w - 1) / 2) * PITCH, top, (j - (d - 1) / 2) * PITCH));
      }
    }
  }
  const g = parts.length > 1 ? mergeGeometries(parts, false) : body;
  if (!g) throw new Error(`brickGeometry: could not merge parts for ${w}x${d}`);
  for (const p of parts) if (p !== g) p.dispose();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  cache.set(key, g);
  return g;
}

/** Glossy ABS-like plastic. Works with InstancedMesh.instanceColor. */
export function plasticMaterial(opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.3,
    metalness: 0,
    clearcoat: 0.55,
    clearcoatRoughness: 0.22,
    specularIntensity: 0.55,
    ...opts,
  });
}

/** Linear-space THREE.Color for a palette name or a hex string. */
export function brickColor(nameOrHex, target = new THREE.Color()) {
  return target.set(BRICK[nameOrHex] || nameOrHex);
}

export function setupRenderer(canvas, { alpha = true, antialias = true, shadows = true } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha, antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x000000, 0);
  return renderer;
}

/** Soft studio reflections (no network, generated on the GPU). */
export function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
  pmrem.dispose();
  return env;
}

/**
 * Key (shadow-casting) + fill + hemisphere lights. Call `applyTheme(name)`
 * (or `applySceneTheme`) whenever the page theme changes; it returns the
 * theme settings so callers can update materials and backgrounds.
 */
export function createLights(scene, { shadowSize = 14, mapSize = 2048 } = {}) {
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(6, 12, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(mapSize, mapSize);
  const c = key.shadow.camera;
  c.left = -shadowSize;
  c.right = shadowSize;
  c.top = shadowSize;
  c.bottom = -shadowSize;
  c.near = 0.5;
  c.far = 60;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(-8, 4, -6);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f99, 0.25);
  scene.add(key, key.target, fill, hemi);

  function applyTheme(name, renderer) {
    const t = THEMES[name] || THEMES.light;
    key.color.set(t.key.color);
    key.intensity = t.key.intensity;
    fill.color.set(t.fill.color);
    fill.intensity = t.fill.intensity;
    hemi.intensity = t.ambient;
    if (renderer) renderer.toneMappingExposure = t.exposure;
    return t;
  }
  return { key, fill, hemi, applyTheme };
}

/** Invisible ground that only shows shadows. */
export function shadowCatcher(size = 60, opacity = 0.2) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity }));
  m.rotation.x = -Math.PI / 2;
  m.receiveShadow = true;
  return m;
}

/**
 * Applies a theme to a scene built with the helpers above. three r161 has no
 * scene-wide environment intensity, so pass the materials to update.
 * `catcher` is optional (a shadowCatcher mesh).
 */
export function applySceneTheme({ name, renderer, lights, materials = [], catcher = null }) {
  const t = lights.applyTheme(name, renderer);
  for (const m of materials) m.envMapIntensity = t.envIntensity;
  if (catcher) catcher.material.opacity = t.shadowOpacity;
  return t;
}
