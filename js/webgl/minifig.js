// Procedural, authentic-proportion 3D minifigure of Sujit Pradhan.
//
// Proportions follow real minifigure geometry (1 stud pitch = 1.0 world unit =
// 20 LDU):
//   - Feet on y = 0, centred at (0, 0, 0), facing +z
//   - Leg hip pivot at y = 1.40, x = +-0.45
//   - Hips waist band y = 1.40 .. 1.72 (width 1.80, depth 0.94)
//   - Trapezoid torso y = 1.72 .. 3.32 (bottom width 1.88, top width 1.24,
//     side slope ~9.8 deg, depth 0.94)
//   - Shoulder pivots at (x = +-0.77, y = 3.00, z = 0)
//   - Rounded cylindrical head y = 3.38 .. 4.50 (radius 0.62) + top stud
//   - Sculpted ABS swept-back hair piece crowning to y ~ 5.05
//
// Default look is tuned to Sujit's portrait: Medium Nougat warm brown skin,
// voluminous dark swept-back hair, thin rimless rectangular glasses, short
// full beard + moustache, big toothy smile, black hoodie torso with subtle
// drawstrings + kangaroo pocket + 4-colour brick badge, and dark blue jeans.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { plasticMaterial } from './bricks.js';
import { BRICK, THEMES } from './palette.js';
import { clamp, damp, env } from '../core/utils.js';

const DEG = Math.PI / 180;
const SHOULDER_SLOPE = 9.8 * DEG;

function resolveHex(c, fallback) {
  if (!c) return fallback;
  if (BRICK[c]) return BRICK[c];
  return String(c);
}

/** Converts an indexed geometry to non-indexed with clean normals for merging. */
function toNonIndexed(g) {
  const out = g.index ? g.toNonIndexed() : g.clone();
  if (!out.attributes.normal) out.computeVertexNormals();
  return out;
}

/**
 * Builds the trapezoid minifigure torso (wider at the waist, narrower at the
 * shoulders, with soft bevelled edges). Origin at the bottom centre of the
 * torso (y = 0 .. 1.60).
 */
function buildTorsoGeometry() {
  const h = 1.60;
  const wBot = 1.88;
  const wTop = 1.26;
  const dBot = 0.94;
  const dTop = 0.88;
  const g = new RoundedBoxGeometry(1, 1, 1, 4, 0.08);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) + 0.5; // 0..1 bottom to top
    const z = pos.getZ(i);
    const t = clamp(y, 0, 1);
    const w = wBot + (wTop - wBot) * t;
    const d = dBot + (dTop - dBot) * t;
    pos.setXYZ(i, x * w, y * h, z * d);
  }
  g.computeVertexNormals();
  // Add the short cylindrical neck post on top.
  const neck = new THREE.CylinderGeometry(0.34, 0.36, 0.18, 24);
  neck.translate(0, h + 0.07, 0);
  return mergeGeometries([toNonIndexed(g), toNonIndexed(neck)], false);
}

/**
 * Builds the minifigure head cylinder with rounded top/bottom rims and a
 * recessed hollow stud on top. Origin at bottom of head (y = 0 .. 1.30).
 */
function buildHeadGeometry() {
  const pts = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.42, 0.0),
    new THREE.Vector2(0.55, 0.04),
    new THREE.Vector2(0.61, 0.12),
    new THREE.Vector2(0.625, 0.20),
    new THREE.Vector2(0.625, 0.92),
    new THREE.Vector2(0.61, 1.00),
    new THREE.Vector2(0.54, 1.08),
    new THREE.Vector2(0.42, 1.12),
    new THREE.Vector2(0.31, 1.12),
    new THREE.Vector2(0.31, 1.30),
    new THREE.Vector2(0.28, 1.32),
    new THREE.Vector2(0.21, 1.32),
    new THREE.Vector2(0.21, 1.20),
    new THREE.Vector2(0.0, 1.20),
  ];
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateY(Math.PI); // put seam at the back (-z) so +z is clean
  g.computeVertexNormals();
  return g;
}

/**
 * Thin front decal shell around the cylindrical face area so the facial print
 * sits crisp over the glossy head plastic without z-fighting.
 */
function buildFaceDecalGeometry() {
  const arc = Math.PI * 0.78;
  const g = new THREE.CylinderGeometry(0.629, 0.629, 0.80, 36, 1, true, -arc / 2, arc);
  g.translate(0, 0.56, 0);
  return g;
}

/**
 * Builds a sculpted, glossy ABS hair piece: swept-back voluminous pompadour /
 * quiff with parted waves, side temples and back crown. Origin matches head
 * bottom (y = 0).
 */
function buildHairGeometry(style = 'swept') {
  if (style === 'none') return new THREE.BufferGeometry();
  const parts = [];
  const addLobe = (w, h, d, x, y, z, rx = 0, ry = 0, rz = 0, r = 0.18) => {
    const b = toNonIndexed(new RoundedBoxGeometry(w, h, d, 4, r));
    if (rx) b.rotateX(rx);
    if (ry) b.rotateY(ry);
    if (rz) b.rotateZ(rz);
    b.translate(x, y, z);
    parts.push(b);
  };

  // Main crown cap wrapping the top & back of the head.
  addLobe(1.36, 0.44, 1.34, 0, 1.12, -0.04, -0.06, 0, 0, 0.20);
  // Back hair shaping down to the nape.
  addLobe(1.30, 0.64, 0.54, 0, 0.80, -0.44, 0.12, 0, 0, 0.18);
  // Left & right temple sides (above the glasses temples).
  addLobe(0.24, 0.48, 0.92, -0.58, 0.88, -0.06, 0, 0, 0.08, 0.10);
  addLobe(0.24, 0.48, 0.92, 0.58, 0.88, -0.06, 0, 0, -0.08, 0.10);

  if (style === 'swept' || style === 'curly') {
    // Voluminous swept-up front quiff (signature silhouette from Sujit's photo).
    addLobe(1.26, 0.40, 0.76, 0.03, 1.32, 0.22, -0.28, 0.05, -0.06, 0.16);
    addLobe(1.06, 0.32, 0.68, 0.08, 1.44, 0.10, -0.18, 0.08, -0.08, 0.14);
    // Subtle moulded wave ridges on top.
    addLobe(0.36, 0.22, 0.82, -0.28, 1.42, 0.06, -0.15, -0.06, 0.12, 0.09);
    addLobe(0.38, 0.24, 0.84, 0.22, 1.46, 0.08, -0.15, 0.06, -0.05, 0.09);
  } else {
    addLobe(1.24, 0.28, 0.72, 0, 1.26, 0.18, -0.12, 0, 0, 0.12);
  }

  return mergeGeometries(parts, false);
}

/**
 * Builds the hips waist block + centre pelvis post between the legs.
 * Origin at hip pin axis (y = 0).
 */
function buildHipsGeometry() {
  const waist = toNonIndexed(new RoundedBoxGeometry(1.80, 0.30, 0.94, 3, 0.04));
  waist.translate(0, 0.17, 0);
  const post = toNonIndexed(new RoundedBoxGeometry(0.20, 0.52, 0.64, 2, 0.03));
  post.translate(0, -0.12, 0);
  return mergeGeometries([waist, post], false);
}

/**
 * Builds a single leg (pivoting at y = 0, extending down to y = -1.40).
 */
function buildLegGeometry() {
  // Upper hip barrel.
  const barrel = new THREE.CylinderGeometry(0.42, 0.42, 0.76, 24);
  barrel.rotateZ(Math.PI / 2);
  // Main leg column.
  const shin = new RoundedBoxGeometry(0.76, 1.06, 0.88, 3, 0.04);
  shin.translate(0, -0.68, -0.02);
  // Foot block jutting slightly forward (+z).
  const foot = new RoundedBoxGeometry(0.78, 0.36, 0.96, 3, 0.04);
  foot.translate(0, -1.22, 0.02);
  return mergeGeometries([toNonIndexed(barrel), toNonIndexed(shin), toNonIndexed(foot)], false);
}

/**
 * Builds an arm (left: dir = -1, right: dir = +1) with shoulder ball, curved
 * elbow and angled forearm. Origin at shoulder pivot (0, 0, 0).
 */
function buildArmGeometry(dir = 1) {
  const parts = [];
  const shoulder = new THREE.SphereGeometry(0.24, 18, 14);
  shoulder.scale(0.95, 1.05, 1.0);
  shoulder.translate(dir * 0.06, -0.04, 0);
  parts.push(toNonIndexed(shoulder));

  const upper = new THREE.CylinderGeometry(0.21, 0.23, 0.68, 20);
  upper.rotateZ(-dir * 0.13);
  upper.translate(dir * 0.11, -0.34, 0.02);
  parts.push(toNonIndexed(upper));

  const elbow = new THREE.SphereGeometry(0.22, 16, 12);
  elbow.translate(dir * 0.15, -0.66, 0.04);
  parts.push(toNonIndexed(elbow));

  const fore = new THREE.CylinderGeometry(0.22, 0.20, 0.58, 20);
  fore.rotateX(0.38);
  fore.rotateZ(-dir * 0.05);
  fore.translate(dir * 0.17, -0.90, 0.15);
  parts.push(toNonIndexed(fore));

  return mergeGeometries(parts, false);
}

/**
 * Builds the iconic C-shaped minifigure hand with wrist stem.
 * Origin at wrist socket (0, 0, 0), pointing down/forward along the forearm.
 */
function buildHandGeometry() {
  const parts = [];
  const wrist = new THREE.CylinderGeometry(0.13, 0.14, 0.24, 16);
  wrist.translate(0, -0.06, 0);
  parts.push(toNonIndexed(wrist));

  // C-grip: torus arc with a 75-degree opening at the bottom-front.
  const arc = Math.PI * 1.52;
  const grip = new THREE.TorusGeometry(0.21, 0.085, 14, 26, arc);
  grip.rotateY(Math.PI / 2);
  grip.rotateX(Math.PI * 0.62);
  grip.translate(0, -0.32, 0.04);
  parts.push(toNonIndexed(grip));

  return mergeGeometries(parts, false);
}

/** Optional designer stylus accessory held in the hand grip. */
function buildStylusGeometry() {
  const body = new THREE.CylinderGeometry(0.055, 0.055, 1.15, 16);
  const tip = new THREE.ConeGeometry(0.055, 0.18, 16);
  tip.rotateX(Math.PI);
  tip.translate(0, -0.665, 0);
  const band = new THREE.CylinderGeometry(0.06, 0.06, 0.08, 16);
  band.translate(0, -0.42, 0);
  const g = mergeGeometries([toNonIndexed(body), toNonIndexed(tip), toNonIndexed(band)], false);
  g.rotateX(Math.PI * 0.35);
  g.translate(0, -0.32, 0.12);
  return g;
}

/**
 * Draws the minifigure facial print onto a 2D canvas and returns a
 * CanvasTexture. Supports expressions ('smile' | 'grin' | 'wink' | 'surprised')
 * and `blink` (closed eyelids).
 */
function drawFaceTexture(opts, expression = 'grin', blink = false) {
  const W = 1024;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const beardType = opts.face?.beard ?? 'short';
  const beardColor = opts.face?.beardColor || '#1b1614';
  const glasses = opts.face?.glasses ?? 'rimless';

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // --- 1. Short full beard & moustache (warm authentic minifigure line-art) ---
  if (beardType && beardType !== 'none') {
    ctx.fillStyle = beardColor;
    ctx.globalAlpha = beardType === 'stubble' ? 0.55 : 0.94;

    // Jawline + chin beard strap wrapping the lower face.
    ctx.beginPath();
    ctx.moveTo(cx - 270, 175);
    ctx.bezierCurveTo(cx - 262, 325, cx - 190, 430, cx, 442);
    ctx.bezierCurveTo(cx + 190, 430, cx + 262, 325, cx + 270, 175);
    ctx.lineTo(cx + 236, 175);
    ctx.bezierCurveTo(cx + 225, 285, cx + 168, 344, cx + 112, 344);
    ctx.bezierCurveTo(cx + 75, 344, cx + 52, 392, cx, 394);
    ctx.bezierCurveTo(cx - 52, 392, cx - 75, 344, cx - 112, 344);
    ctx.bezierCurveTo(cx - 168, 344, cx - 225, 285, cx - 236, 175);
    ctx.closePath();
    ctx.fill();

    // Moustache arch above the smile, connecting cleanly to the beard sides.
    ctx.beginPath();
    ctx.moveTo(cx - 136, 336);
    ctx.quadraticCurveTo(cx - 88, 282, cx, 294);
    ctx.quadraticCurveTo(cx + 88, 282, cx + 136, 336);
    ctx.quadraticCurveTo(cx + 110, 355, cx + 82, 328);
    ctx.quadraticCurveTo(cx, 314, cx - 82, 328);
    ctx.quadraticCurveTo(cx - 110, 355, cx - 136, 336);
    ctx.closePath();
    ctx.fill();

    // Soul patch under lower lip.
    ctx.beginPath();
    ctx.roundRect(cx - 20, 382, 40, 34, 12);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // --- 2. Eyebrows ---
  ctx.strokeStyle = '#141110';
  ctx.lineWidth = 16;
  const browLift = expression === 'surprised' || opts.face?.brows === 'raised' ? -14 : 0;
  // Left eyebrow
  ctx.beginPath();
  ctx.moveTo(cx - 150, 148 + browLift);
  ctx.quadraticCurveTo(cx - 98, 126 + browLift, cx - 48, 144 + browLift);
  ctx.stroke();
  // Right eyebrow
  ctx.beginPath();
  ctx.moveTo(cx + 48, 144 + browLift);
  ctx.quadraticCurveTo(cx + 98, 126 + browLift, cx + 150, 148 + browLift);
  ctx.stroke();

  // --- 3. Eyes (with classic white specular catchlights) ---
  const drawEye = (ex, ey, isClosed) => {
    if (isClosed) {
      ctx.strokeStyle = '#141110';
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(ex - 26, ey + 2);
      ctx.quadraticCurveTo(ex, ey + 18, ex + 26, ey + 2);
      ctx.stroke();
      return;
    }
    ctx.fillStyle = '#141110';
    ctx.beginPath();
    ctx.arc(ex, ey, 23, 0, Math.PI * 2);
    ctx.fill();
    // Primary white catchlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(ex - 7, ey - 7, 7.5, 0, Math.PI * 2);
    ctx.fill();
    // Secondary tiny catchlight
    ctx.beginPath();
    ctx.arc(ex + 8, ey + 7, 3.2, 0, Math.PI * 2);
    ctx.fill();
  };
  drawEye(cx - 96, 206, blink);
  drawEye(cx + 96, 206, blink || expression === 'wink');

  // Subtle lower-eye smile creases (warm expression from photo).
  if (!blink) {
    ctx.strokeStyle = 'rgba(28, 18, 12, 0.38)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx - 96, 214, 30, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + 96, 214, 30, 0.25 * Math.PI, 0.75 * Math.PI);
    ctx.stroke();
  }

  // --- 4. Thin rimless / wire rectangular glasses ---
  if (glasses) {
    const lensW = 132;
    const lensH = 76;
    const ly = 168;
    const lxL = cx - 96 - lensW / 2;
    const lxR = cx + 96 - lensW / 2;

    // Subtle glass lens sheen
    ctx.fillStyle = 'rgba(235, 246, 255, 0.14)';
    ctx.beginPath();
    ctx.roundRect(lxL, ly, lensW, lensH, 14);
    ctx.roundRect(lxR, ly, lensW, lensH, 14);
    ctx.fill();

    // Diagonal specular glint on each lens
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(lxL + 22, ly + 14);
    ctx.lineTo(lxL + 44, ly + 42);
    ctx.moveTo(lxR + 22, ly + 14);
    ctx.lineTo(lxR + 44, ly + 42);
    ctx.stroke();

    // Thin metallic rim & bridge
    ctx.strokeStyle = glasses === 'square' ? '#1e242b' : 'rgba(225, 232, 240, 0.85)';
    ctx.lineWidth = glasses === 'square' ? 9 : 5.5;
    ctx.beginPath();
    ctx.roundRect(lxL, ly, lensW, lensH, 14);
    ctx.roundRect(lxR, ly, lensW, lensH, 14);
    ctx.stroke();

    // Nose bridge + side hinge pins + temple arms
    ctx.strokeStyle = '#c8d0d8';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(lxL + lensW, ly + 28);
    ctx.quadraticCurveTo(cx, ly + 20, lxR, ly + 28);
    ctx.moveTo(lxL - 55, ly + 24);
    ctx.lineTo(lxL + 8, ly + 28);
    ctx.moveTo(lxR + lensW - 8, ly + 28);
    ctx.lineTo(lxR + lensW + 55, ly + 24);
    ctx.stroke();
  }

  // --- 5. Mouth / big warm smile with white teeth ---
  if (expression === 'surprised') {
    ctx.fillStyle = '#2a0e0e';
    ctx.strokeStyle = '#141110';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.ellipse(cx, 352, 34, 26, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (expression === 'smile') {
    ctx.strokeStyle = '#141110';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(cx - 74, 336);
    ctx.quadraticCurveTo(cx, 384, cx + 74, 336);
    ctx.stroke();
  } else {
    // 'grin' (default): wide friendly toothy smile matching Sujit's photo.
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#141110';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(cx - 88, 326);
    ctx.quadraticCurveTo(cx, 340, cx + 88, 326);
    ctx.bezierCurveTo(cx + 80, 384, cx - 80, 384, cx - 88, 326);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Draws the front torso print (black hoodie with hood V-seam, drawstrings,
 * kangaroo pocket, and a tiny 4-colour brick design badge).
 */
function drawTorsoTexture(opts) {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const style = opts.torso?.print ?? 'hoodie';
  if (style === 'plain') {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Subtle collar / hood neckline seam at top centre
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(W / 2, 34, 88, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // Hoodie drawstrings with metal aglets
  ctx.strokeStyle = 'rgba(240, 242, 245, 0.78)';
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 44, 84);
  ctx.quadraticCurveTo(W / 2 - 50, 155, W / 2 - 42, 212);
  ctx.moveTo(W / 2 + 44, 84);
  ctx.quadraticCurveTo(W / 2 + 50, 155, W / 2 + 42, 202);
  ctx.stroke();

  ctx.fillStyle = '#f5cd2f';
  ctx.beginPath();
  ctx.roundRect(W / 2 - 48, 206, 12, 20, 4);
  ctx.roundRect(W / 2 + 36, 196, 12, 20, 4);
  ctx.fill();

  // Tiny 2x2 colour-block designer badge on left chest
  const bx = W / 2 + 78;
  const by = 132;
  const colors = ['#c91a09', '#f5cd2f', '#0a5ec7', '#237841'];
  for (let i = 0; i < 4; i++) {
    const x = bx + (i % 2) * 22;
    const y = by + Math.floor(i / 2) * 22;
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.roundRect(x, y, 18, 18, 4);
    ctx.fill();
  }

  // Kangaroo pocket seam on lower torso
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(106, 456);
  ctx.lineTo(142, 326);
  ctx.lineTo(W - 142, 326);
  ctx.lineTo(W - 106, 456);
  ctx.moveTo(92, 456);
  ctx.lineTo(W - 92, 456);
  ctx.stroke();

  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Front torso decal plane tilted by the torso's front slope so the hoodie
 * print sits flush on the chest.
 */
function buildTorsoDecalGeometry() {
  const h = 1.46;
  const wBot = 1.66;
  const wTop = 1.14;
  const zBot = 0.474;
  const zTop = 0.444;
  const g = new THREE.PlaneGeometry(1, 1, 1, 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) + 0.5; // 0..1
    const w = wBot + (wTop - wBot) * y;
    const z = zBot + (zTop - zBot) * y;
    pos.setXYZ(i, x * w, 0.07 + y * h, z);
  }
  g.computeVertexNormals();
  return g;
}

export class Minifig {
  /**
   * @param {Object} [opts]
   */
  constructor(opts = {}) {
    this.opts = {
      skin: opts.skin || BRICK.mediumNougat || '#aa7d55',
      hair: {
        style: opts.hair?.style || 'swept',
        color: opts.hair?.color || '#1b1615',
      },
      face: {
        brows: opts.face?.brows || 'neutral',
        mouth: opts.face?.mouth || 'grin',
        glasses: opts.face?.glasses !== undefined ? opts.face.glasses : 'rimless',
        beard: opts.face?.beard || 'short',
        beardColor: opts.face?.beardColor || '#1a1514',
      },
      torso: {
        color: opts.torso?.color || BRICK.black,
        print: opts.torso?.print || 'hoodie',
        accent: opts.torso?.accent || BRICK.yellow,
      },
      arms: opts.arms || opts.torso?.color || BRICK.black,
      hands: opts.hands || opts.skin || BRICK.mediumNougat || '#aa7d55',
      hips: opts.hips || BRICK.black,
      legs: opts.legs || BRICK.blue,
      accessory: opts.accessory || 'none',
      theme: opts.theme || 'light',
    };

    this.group = new THREE.Group();
    this.group.name = 'minifig';
    this._root = new THREE.Group();
    this.group.add(this._root);

    this._geos = [];
    this._mats = [];
    this._texs = new Map();
    this._expression = this.opts.face.mouth || 'grin';
    this._pose = 'idle';
    this._look = { tx: 0, ty: 0, x: 0, y: 0 };
    this._wave = { active: false, t: 0, dur: 1.75 };
    this._jump = { active: false, t: 0, dur: 0.72 };
    this._blink = { nextAt: 2.4, until: 0, closed: false };

    this._build();
    this.setTheme(this.opts.theme);
  }

  _mat(colorHex, extra = {}) {
    const m = plasticMaterial({
      color: resolveHex(colorHex, '#ffffff'),
      roughness: extra.roughness ?? 0.16,
      clearcoat: extra.clearcoat ?? 0.65,
      ...extra,
    });
    this._mats.push(m);
    return m;
  }

  _trackGeo(g) {
    this._geos.push(g);
    return g;
  }

  _getFaceTex(expr, blink) {
    const key = `${expr}:${blink ? 1 : 0}`;
    if (!this._texs.has(key)) {
      this._texs.set(key, drawFaceTexture(this.opts, expr, blink));
    }
    return this._texs.get(key);
  }

  _build() {
    const skinMat = this._mat(this.opts.skin, { roughness: 0.18 });
    const hairMat = this._mat(this.opts.hair.color, { roughness: 0.22 });
    const torsoMat = this._mat(this.opts.torso.color, { roughness: 0.16 });
    const armMat = this._mat(this.opts.arms, { roughness: 0.16 });
    const handMat = this._mat(this.opts.hands, { roughness: 0.18 });
    const hipMat = this._mat(this.opts.hips, { roughness: 0.20 });
    const legMat = this._mat(this.opts.legs, { roughness: 0.18 });

    // --- Hips & Legs ---
    this.hips = new THREE.Group();
    this.hips.position.set(0, 1.40, 0);
    this._root.add(this.hips);

    const hipsMesh = new THREE.Mesh(this._trackGeo(buildHipsGeometry()), hipMat);
    this.hips.add(hipsMesh);

    const legGeo = this._trackGeo(buildLegGeometry());
    this.leftLeg = new THREE.Mesh(legGeo, legMat);
    this.leftLeg.position.set(0.45, 0, 0);
    this.rightLeg = new THREE.Mesh(legGeo, legMat);
    this.rightLeg.position.set(-0.45, 0, 0);
    this.hips.add(this.leftLeg, this.rightLeg);

    // --- Upper body (torso + arms + head) ---
    this.upper = new THREE.Group();
    this.upper.position.set(0, 1.72, 0);
    this._root.add(this.upper);

    const torsoMesh = new THREE.Mesh(this._trackGeo(buildTorsoGeometry()), torsoMat);
    this.upper.add(torsoMesh);

    const torsoTex = drawTorsoTexture(this.opts);
    this._texs.set('torso', torsoTex);
    const torsoDecalMat = new THREE.MeshStandardMaterial({
      map: torsoTex,
      transparent: true,
      roughness: 0.22,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    this._mats.push(torsoDecalMat);
    const torsoDecal = new THREE.Mesh(this._trackGeo(buildTorsoDecalGeometry()), torsoDecalMat);
    this.upper.add(torsoDecal);

    // --- Arms & Hands ---
    // In local space (+z forward), +x is the character's left side and -x is right.
    this.leftShoulder = new THREE.Group();
    this.leftShoulder.position.set(0.76, 1.28, 0);
    this.leftShoulder.rotation.z = -SHOULDER_SLOPE;
    this.upper.add(this.leftShoulder);

    const leftArmMesh = new THREE.Mesh(this._trackGeo(buildArmGeometry(1)), armMat);
    this.leftShoulder.add(leftArmMesh);

    const handGeo = this._trackGeo(buildHandGeometry());
    this.leftHand = new THREE.Group();
    this.leftHand.position.set(0.19, -1.16, 0.25);
    this.leftHand.rotation.x = 0.36;
    this.leftHand.add(new THREE.Mesh(handGeo, handMat));
    this.leftShoulder.add(this.leftHand);

    this.rightShoulder = new THREE.Group();
    this.rightShoulder.position.set(-0.76, 1.28, 0);
    this.rightShoulder.rotation.z = SHOULDER_SLOPE;
    this.upper.add(this.rightShoulder);

    const rightArmMesh = new THREE.Mesh(this._trackGeo(buildArmGeometry(-1)), armMat);
    this.rightShoulder.add(rightArmMesh);

    this.rightHand = new THREE.Group();
    this.rightHand.position.set(-0.19, -1.16, 0.25);
    this.rightHand.rotation.x = 0.36;
    this.rightHand.add(new THREE.Mesh(handGeo, handMat));
    this.rightShoulder.add(this.rightHand);

    if (this.opts.accessory === 'stylus') {
      const stylusMat = this._mat(BRICK.white, { roughness: 0.14 });
      const stylus = new THREE.Mesh(this._trackGeo(buildStylusGeometry()), stylusMat);
      this.leftHand.add(stylus);
    }

    // --- Head & Hair ---
    this.head = new THREE.Group();
    this.head.position.set(0, 1.66, 0);
    this.upper.add(this.head);

    const headMesh = new THREE.Mesh(this._trackGeo(buildHeadGeometry()), skinMat);
    this.head.add(headMesh);

    const faceTex = this._getFaceTex(this._expression, false);
    this._faceMat = new THREE.MeshStandardMaterial({
      map: faceTex,
      transparent: true,
      roughness: 0.20,
      metalness: 0.0,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    });
    this._mats.push(this._faceMat);
    const faceDecal = new THREE.Mesh(this._trackGeo(buildFaceDecalGeometry()), this._faceMat);
    this.head.add(faceDecal);

    if (this.opts.hair.style !== 'none') {
      const hairMesh = new THREE.Mesh(this._trackGeo(buildHairGeometry(this.opts.hair.style)), hairMat);
      this.head.add(hairMesh);
    }

    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /**
   * Smoothly turns the head and upper torso towards normalized device
   * coordinates (-1..1).
   * @param {number} ndcX
   * @param {number} ndcY
   */
  lookAt(ndcX, ndcY) {
    this._look.tx = clamp(Number(ndcX) || 0, -1, 1);
    this._look.ty = clamp(Number(ndcY) || 0, -1, 1);
  }

  /** Raises the right arm and waves three times. */
  wave() {
    this._wave.active = true;
    this._wave.t = 0;
  }

  /** Squash, hop with a cheerful bounce, and land. */
  jump() {
    this._jump.active = true;
    this._jump.t = 0;
  }

  /**
   * @param {'idle'|'wave'|'point'|'cheer'|'think'} name
   */
  setPose(name) {
    this._pose = name || 'idle';
    if (name === 'wave') this.wave();
  }

  /**
   * @param {'smile'|'grin'|'wink'|'surprised'} name
   */
  setExpression(name) {
    this._expression = name || 'grin';
    if (this._faceMat) {
      this._faceMat.map = this._getFaceTex(this._expression, this._blink.closed);
      this._faceMat.needsUpdate = true;
    }
  }

  /**
   * Updates environment map intensity when theme switches.
   * @param {'light'|'dark'} name
   */
  setTheme(name) {
    const t = THEMES[name] || THEMES.light;
    for (const m of this._mats) {
      if ('envMapIntensity' in m) m.envMapIntensity = t.envIntensity;
    }
  }

  /**
   * Per-frame update. Returns true when an active gesture (wave, jump, or look
   * damping) requires another render frame.
   * @param {number} t
   * @param {number} dt
   * @return {boolean}
   */
  update(t, dt) {
    dt = clamp(dt || 1 / 60, 0.001, 0.1);
    const reduced = env.reducedMotion;
    let active = false;

    // 1. Pointer look damping
    const ox = this._look.x;
    const oy = this._look.y;
    this._look.x = damp(this._look.x, this._look.tx, 6, dt);
    this._look.y = damp(this._look.y, this._look.ty, 6, dt);
    if (Math.abs(this._look.x - ox) + Math.abs(this._look.y - oy) > 1e-4) active = true;

    // 2. Periodic blink
    if (!reduced && t >= this._blink.nextAt) {
      if (!this._blink.closed) {
        this._blink.closed = true;
        this._blink.until = t + 0.13;
        this._faceMat.map = this._getFaceTex(this._expression, true);
        active = true;
      } else if (t >= this._blink.until) {
        this._blink.closed = false;
        this._blink.nextAt = t + 3.2 + (Math.sin(t * 7.3) * 0.5 + 0.5) * 2.2;
        this._faceMat.map = this._getFaceTex(this._expression, false);
        active = true;
      }
    }

    // 3. Idle breathing & head orientation
    const breath = reduced ? 0 : Math.sin(t * 2.1) * 0.025;
    this.head.rotation.y = this._look.x * 0.52;
    this.head.rotation.x = -this._look.y * 0.24 + breath * 0.5;
    this.upper.rotation.y = this._look.x * 0.18;
    this.upper.rotation.x = breath;

    // 4. Arm poses + wave animation
    let rArmX = -0.08;
    let rArmZ = SHOULDER_SLOPE;
    let rHandZ = 0;
    let lArmX = 0.08;
    let lArmZ = -SHOULDER_SLOPE;

    if (this._pose === 'cheer') {
      rArmX = -2.55;
      lArmX = -2.55;
    } else if (this._pose === 'point') {
      rArmX = -1.35;
    } else if (this._pose === 'think') {
      rArmX = -1.75;
      rArmZ = -0.18;
    }

    if (this._wave.active) {
      this._wave.t += dt;
      const u = this._wave.t / this._wave.dur;
      if (u >= 1) {
        this._wave.active = false;
      } else {
        active = true;
        const lift = u < 0.18 ? u / 0.18 : u > 0.82 ? (1 - u) / 0.18 : 1;
        const ease = lift * lift * (3 - 2 * lift);
        const waggle = Math.sin(u * Math.PI * 6) * ease;
        rArmX = -2.45 * ease;
        rArmZ = SHOULDER_SLOPE + (0.28 + waggle * 0.26) * ease;
        rHandZ = waggle * 0.35;
      }
    }

    this.rightShoulder.rotation.x = damp(this.rightShoulder.rotation.x, rArmX, 14, dt);
    this.rightShoulder.rotation.z = damp(this.rightShoulder.rotation.z, rArmZ, 14, dt);
    this.rightHand.rotation.z = damp(this.rightHand.rotation.z, rHandZ, 16, dt);
    this.leftShoulder.rotation.x = damp(this.leftShoulder.rotation.x, lArmX, 12, dt);
    this.leftShoulder.rotation.z = damp(this.leftShoulder.rotation.z, lArmZ, 12, dt);

    // 5. Jump hop animation
    if (this._jump.active) {
      this._jump.t += dt;
      const u = this._jump.t / this._jump.dur;
      if (u >= 1) {
        this._jump.active = false;
        this._root.position.y = 0;
        this._root.scale.set(1, 1, 1);
        this.leftLeg.rotation.x = 0;
        this.rightLeg.rotation.x = 0;
      } else {
        active = true;
        const arc = Math.sin(u * Math.PI);
        this._root.position.y = arc * 0.95;
        const sq = u < 0.15 ? 1 - u * 0.8 : u > 0.85 ? 1 - (1 - u) * 0.6 : 1 + arc * 0.05;
        this._root.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
        this.leftLeg.rotation.x = arc * 0.42;
        this.rightLeg.rotation.x = -arc * 0.36;
      }
    }

    return active;
  }

  dispose() {
    for (const g of this._geos) g.dispose();
    for (const m of this._mats) m.dispose();
    for (const tex of this._texs.values()) tex.dispose();
    this._geos.length = 0;
    this._mats.length = 0;
    this._texs.clear();
  }
}

/**
 * Factory creating a configured 3D minifigure instance.
 * @param {Object} [opts]
 * @return {Minifig}
 */
export function createMinifig(opts = {}) {
  return new Minifig(opts);
}
