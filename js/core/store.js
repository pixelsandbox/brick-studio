// Shared, mutable app state read by the render loop (DOM + WebGL).

export const store = {
  vw: window.innerWidth,
  vh: window.innerHeight,
  pointer: {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    nx: 0, // -1..1, left → right
    ny: 0, // -1..1, bottom → top
    vx: 0,
    vy: 0,
    speed: 0,
    moved: false,
    overUI: false,
  },
  scroll: { y: 0, velocity: 0, direction: 1, limit: 0, progress: 0 },
  section: 'hero',
  heroProgress: 0,
  philo: { mix: 0.5 },
  overlayOpen: false,
  menuOpen: false,
  introAt: Infinity, // timestamp (s) when the intro reveal started
};
