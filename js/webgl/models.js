// Brick-built Hero model layout for the 3D stage (js/webgl/stage.js).
//
// Everything is in stud units on the brick grid of bricks.js: x to the right,
// y up, z towards the viewer. A layout is a flat list of bricks:
//   { t, x, y, z, r, c, g }
//   t     type key: kind + WxD with W <= D, e.g. 'b2x4' (brick), 'p2x4' (plate).
//   x, z  centre of the footprint; y = bottom of the brick
//   r     quarter turns about +y (0 | 1); r = 1 swaps the footprint axes
//   c     palette key from palette.js, or 'baseplate' (theme dependent)
//   g     group tag (letter index, 'base', 'prop')
//
// Models are centred on x = z = 0 with the ground at y = 0 so stage.js can
// frame them by their bounds.

import { BRICK_H, PLATE_H, STUD_H } from './bricks.js';

/** Bold 7-row pixel font with 2-stud stems (reads as chunky brick letters). */
export const FONT = {
  A: ['.###.', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
  B: ['####.', '##.##', '##.##', '####.', '##.##', '##.##', '####.'],
  C: ['.####', '##...', '##...', '##...', '##...', '##...', '.####'],
  D: ['####.', '##.##', '##.##', '##.##', '##.##', '##.##', '####.'],
  E: ['#####', '##...', '##...', '####.', '##...', '##...', '#####'],
  F: ['#####', '##...', '##...', '####.', '##...', '##...', '##...'],
  G: ['.####', '##...', '##...', '##.##', '##.##', '##.##', '.####'],
  H: ['##.##', '##.##', '##.##', '#####', '##.##', '##.##', '##.##'],
  I: ['####', '.##.', '.##.', '.##.', '.##.', '.##.', '####'],
  J: ['..###', '...##', '...##', '...##', '...##', '##.##', '.###.'],
  K: ['##.##', '##.##', '####.', '###..', '####.', '##.##', '##.##'],
  L: ['##...', '##...', '##...', '##...', '##...', '##...', '#####'],
  M: ['##...##', '###.###', '#######', '##.#.##', '##...##', '##...##', '##...##'],
  N: ['##..##', '###.##', '######', '##.###', '##..##', '##..##', '##..##'],
  O: ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  P: ['####.', '##.##', '##.##', '####.', '##...', '##...', '##...'],
  Q: ['.###.', '##.##', '##.##', '##.##', '##.##', '##.#.', '.##.#'],
  R: ['####.', '##.##', '##.##', '####.', '####.', '##.##', '##.##'],
  S: ['.####', '##...', '##...', '.###.', '...##', '...##', '####.'],
  T: ['######', '..##..', '..##..', '..##..', '..##..', '..##..', '..##..'],
  U: ['##.##', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  V: ['##.##', '##.##', '##.##', '##.##', '##.##', '.###.', '..#..'],
  W: ['##...##', '##...##', '##...##', '##.#.##', '#######', '###.###', '##...##'],
  X: ['##.##', '##.##', '.###.', '..#..', '.###.', '##.##', '##.##'],
  Y: ['##..##', '##..##', '.####.', '..##..', '..##..', '..##..', '..##..'],
  Z: ['#####', '...##', '..##.', '.###.', '.##..', '##...', '#####'],
  0: ['.###.', '##.##', '##.##', '##.##', '##.##', '##.##', '.###.'],
  1: ['.##.', '###.', '.##.', '.##.', '.##.', '.##.', '####'],
  2: ['.###.', '##.##', '...##', '.###.', '##...', '##...', '#####'],
  3: ['####.', '...##', '...##', '.###.', '...##', '...##', '####.'],
  4: ['##.##', '##.##', '##.##', '#####', '...##', '...##', '...##'],
  5: ['#####', '##...', '##...', '####.', '...##', '...##', '####.'],
  6: ['.###.', '##...', '##...', '####.', '##.##', '##.##', '.###.'],
  7: ['#####', '...##', '..##.', '..##.', '.##..', '.##..', '.##..'],
  8: ['.###.', '##.##', '##.##', '.###.', '##.##', '##.##', '.###.'],
  9: ['.###.', '##.##', '##.##', '.####', '...##', '...##', '.###.'],
  '!': ['##', '##', '##', '##', '##', '..', '##'],
  '?': ['.###.', '##.##', '...##', '..##.', '..##.', '.....', '..##.'],
  '-': ['....', '....', '....', '####', '....', '....', '....'],
  '.': ['..', '..', '..', '..', '..', '##', '##'],
  '&': ['.###..', '##.##.', '.###..', '####.#', '##.###', '##..##', '.###.#'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  ' ': ['..', '..', '..', '..', '..', '..', '..'],
};

/** Named brick color palettes for the 3D word. */
export const PALETTES = {
  classic: ['red', 'yellow', 'blue', 'green', 'orange', 'azure', 'lime'],
  bauhaus: ['red', 'yellow', 'blue', 'white', 'orange'],
  cyber: ['azure', 'pink', 'lime', 'magenta', 'orange', 'darkAzure'],
  warm: ['red', 'orange', 'lightOrange', 'yellow', 'pink', 'tan'],
  ocean: ['blue', 'darkAzure', 'azure', 'brightGreen', 'sandGreen', 'white'],
  mono: ['white', 'lightGrey', 'darkGrey', 'tan'],
};

export const MAX_WORD_LEN = 10;

/**
 * Sanitizes a user-supplied string into a buildable brick word (1..MAX_WORD_LEN chars).
 * @param {string} raw
 * @param {string} [fallback='SUJIT']
 * @return {string}
 */
export function sanitizeWord(raw, fallback = 'SUJIT') {
  const cleaned = String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
    .split('')
    .filter((ch) => ch in FONT)
    .join('')
    .slice(0, MAX_WORD_LEN)
    .trim();
  return cleaned || fallback;
}

const typeCache = new Map();

/**
 * Parses a type key ('b2x4', 'p2x4', 't1x2').
 * @param {string} key
 * @returns {{key: string, kind: 'b'|'p'|'t', w: number, d: number, h: number, studs: boolean, big: boolean}}
 */
export function typeInfo(key) {
  let info = typeCache.get(key);
  if (info) return info;
  const m = /^([bpt])(\d+)x(\d+)$/.exec(key);
  if (!m) throw new Error(`models: unknown brick type '${key}'`);
  const kind = /** @type {'b'|'p'|'t'} */ (m[1]);
  const w = Number(m[2]);
  const d = Number(m[3]);
  info = { key, kind, w, d, h: kind === 'b' ? BRICK_H : PLATE_H, studs: kind !== 't', big: w * d > 16 };
  typeCache.set(key, info);
  return info;
}

/** Footprint along x / z of a brick entry, honouring its rotation. */
export function footprint(e) {
  const { w, d } = typeInfo(e.t);
  return e.r ? [d, w] : [w, d];
}

/** Type + rotation for a piece covering sx studs along x and sz along z. */
function piece(sx, sz, kind) {
  return { t: `${kind}${Math.min(sx, sz)}x${Math.max(sx, sz)}`, r: sx > sz ? 1 : 0 };
}

function greedy(len, lens) {
  const out = [];
  let rest = len;
  for (const l of lens) {
    while (rest >= l) {
      out.push(l);
      rest -= l;
    }
  }
  return out;
}

/**
 * Splits a run of `len` studs into brick lengths. Odd courses use a shifted
 * split so vertical seams don't line up with the course below (running bond).
 */
function split(len, odd, lens) {
  const even = greedy(len, lens);
  if (!odd) return even;
  const rev = even.slice().reverse();
  if (rev.some((v, i) => v !== even[i])) return rev;
  const half = lens.find((l) => l < lens[0] && l < len);
  if (!half || len < 4) return even;
  return [half, ...greedy(len - 2 * half, lens), half];
}

/**
 * Upright pixel facade (rows top to bottom), `depth` studs deep starting at
 * z0. Characters other than '.' are colour codes looked up in `colors`
 * (a string colours every pixel). Each course is one brick tall.
 */
function facade(rows, { x0 = 0, y0 = 0, z0 = 0, depth = 2, kind = 'b', colors, group }) {
  const lens = depth >= 4 ? [2, 1] : [4, 2, 1];
  const h = kind === 'b' ? BRICK_H : PLATE_H;
  const out = [];
  rows.forEach((row, ri) => {
    const course = rows.length - 1 - ri;
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      if (ch === '.' || ch === ' ') {
        x++;
        continue;
      }
      let len = 0;
      while (x + len < row.length && row[x + len] === ch) len++;
      const c = typeof colors === 'string' ? colors : colors[ch];
      let px = x;
      for (const l of split(len, course % 2 === 1, lens)) {
        const p = piece(l, depth, kind);
        out.push({ t: p.t, r: p.r, x: x0 + px + l / 2, y: y0 + course * h, z: z0 + depth / 2, c, g: group });
        px += l;
      }
      x += len;
    }
  });
  return out;
}

/** Axis-aligned bounds of a layout: { min: [x, y, z], max: [x, y, z] }. */
export function layoutBounds(bricks) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const e of bricks) {
    const info = typeInfo(e.t);
    const [sx, sz] = footprint(e);
    const top = e.y + info.h + (info.studs ? STUD_H : 0);
    min[0] = Math.min(min[0], e.x - sx / 2);
    max[0] = Math.max(max[0], e.x + sx / 2);
    min[1] = Math.min(min[1], e.y);
    max[1] = Math.max(max[1], top);
    min[2] = Math.min(min[2], e.z - sz / 2);
    max[2] = Math.max(max[2], e.z + sz / 2);
  }
  return { min, max };
}

function shift(bricks, dx, dz) {
  for (const e of bricks) {
    e.x += dx;
    e.z += dz;
  }
}

const overlaps = (a, b) => {
  const [ax, az] = footprint(a);
  const [bx, bz] = footprint(b);
  return Math.abs(a.x - b.x) < (ax + bx) / 2 - 0.01 && Math.abs(a.z - b.z) < (az + bz) / 2 - 0.01;
};

const touchesSide = (a, b) => {
  const [ax, az] = footprint(a);
  const [bx, bz] = footprint(b);
  const xTouch = Math.abs(Math.abs(a.x - b.x) - (ax + bx) / 2) < 0.05;
  const zOverlap = Math.abs(a.z - b.z) < (az + bz) / 2 - 0.01;
  return xTouch && zOverlap;
};

/**
 * Support graph for knock cascades and hover:
 * - `sup`   = indices of bricks directly underneath
 * - `above` = indices of bricks directly on top
 * - `side`  = indices of bricks touching laterally on the same course & group
 * - `covered` = something sits on top
 */
function linkSupports(bricks) {
  for (const e of bricks) {
    e.sup = [];
    e.above = [];
    e.side = [];
    e.covered = false;
  }
  bricks.forEach((a, i) => {
    const top = a.y + typeInfo(a.t).h;
    bricks.forEach((b, j) => {
      if (i === j) return;
      if (Math.abs(b.y - top) <= 0.01 && overlaps(a, b)) {
        b.sup.push(i);
        a.above.push(j);
        a.covered = true;
      } else if (a.g === b.g && a.g !== 'base' && Math.abs(a.y - b.y) <= 0.01 && touchesSide(a, b)) {
        a.side.push(j);
      }
    });
  });
}

/**
 * Build rank in 0..1 (bottom-up, then back to front, then left to right):
 * the order bricks click in, like steps in a building-instructions booklet.
 */
function rankBuild(bricks, key = (e) => e.y * 1000 + e.z * 0.5 + e.x * 0.02) {
  const order = bricks.map((e, i) => i).sort((a, b) => key(bricks[a]) - key(bricks[b]));
  const n = Math.max(1, bricks.length - 1);
  order.forEach((idx, rank) => {
    bricks[idx].o = rank / n;
  });
}

function finish(model) {
  const b = layoutBounds(model.bricks);
  const dx = -(b.min[0] + b.max[0]) / 2;
  const dz = -(b.min[2] + b.max[2]) / 2;
  shift(model.bricks, dx, dz);
  if (model.anchor) {
    model.anchor.x += dx;
    model.anchor.z += dz;
  }
  model.bounds = layoutBounds(model.bricks);
  linkSupports(model.bricks);
  rankBuild(model.bricks, model.rankKey);
  return model;
}

const DEG = Math.PI / 180;
const mix = (a, b, t) => a + (b - a) * Math.min(1, Math.max(0, t));

/**
 * Hero: a custom word (default 'SUJIT') in chunky 2-stud-deep letters on a
 * baseplate strip, with room on the right for the minifigure (anchor).
 * @param {string} [word='SUJIT']
 * @param {{palette?: string|string[], showMinifig?: boolean}} [opts]
 */
export function heroModel(word = 'SUJIT', { palette = 'classic', showMinifig = true } = {}) {
  const cleanWord = sanitizeWord(word);
  const colors = Array.isArray(palette) && palette.length
    ? palette
    : PALETTES[palette] || PALETTES.classic;
  const bricks = [];
  const zc = 2; // letters span z 1..3 of the 4-deep strip
  let x = 1;
  let colorIdx = 0;
  [...cleanWord].forEach((ch, i) => {
    const g = FONT[ch] || FONT[' '];
    if (ch !== ' ') {
      const col = colors[colorIdx % colors.length];
      colorIdx++;
      bricks.push(...facade(g, { x0: x, y0: PLATE_H, z0: zc - 1, depth: 2, colors: col, group: i }));
    }
    x += g[0].length + 1;
  });
  const lettersEnd = Math.max(4, x - 1);
  const extraRight = showMinifig ? 6 : 2;
  const W = Math.max(8, Math.ceil((lettersEnd + extraRight) / 4) * 4);
  // Baseplate strip: two rows of 2x4 plates in running bond.
  for (let i = 0; i < W / 4; i++) {
    bricks.push({ t: 'p2x4', r: 1, x: i * 4 + 2, y: 0, z: 1, c: 'baseplate', g: 'base' });
  }
  bricks.push({ t: 'p2x2', r: 0, x: 1, y: 0, z: 3, c: 'baseplate', g: 'base' });
  for (let i = 0; i < W / 4 - 1; i++) {
    bricks.push({ t: 'p2x4', r: 1, x: i * 4 + 4, y: 0, z: 3, c: 'baseplate', g: 'base' });
  }
  bricks.push({ t: 'p2x2', r: 0, x: W - 1, y: 0, z: 3, c: 'baseplate', g: 'base' });

  if (showMinifig) {
    // White / black accents: a little bollard next to the minifigure.
    bricks.push({ t: 'b1x2', r: 0, x: W - 1.5, y: PLATE_H, z: 1, c: 'white', g: 'prop' });
    bricks.push({ t: 'b1x1', r: 0, x: W - 1.5, y: PLATE_H + BRICK_H, z: 0.5, c: 'black', g: 'prop' });
    bricks.push({ t: 'p1x1', r: 0, x: W - 1.5, y: PLATE_H + BRICK_H, z: 1.5, c: 'white', g: 'prop' });
  }

  return finish({
    key: 'hero',
    kind: 'static',
    word: cleanWord,
    bricks,
    anchor: { x: lettersEnd + (W - 2 - lettersEnd) / 2 + 0.5, y: PLATE_H, z: 2.5 },
    // Wide slots get a gentle three-quarter view; tall ones turn the word
    // further so it recedes in depth instead of shrinking.
    view: (aspect) => ({
      yaw: mix(34, 16, (aspect - 0.9) / 1.6) * DEG,
      tilt: mix(25, 19, (aspect - 0.9) / 1.6) * DEG,
    }),
    rankKey: (e) => (e.g === 'base' ? -1000 + e.x : e.y * 100 + e.x * 0.6 + e.z * 0.1),
  });
}

/**
 * Builds the stage models dictionary.
 * @param {{word?: string, palette?: string|string[], showMinifig?: boolean}} [opts]
 */
export function buildModels({ word = 'SUJIT', palette = 'classic', showMinifig = true } = {}) {
  return {
    hero: heroModel(word, { palette, showMinifig }),
  };
}
