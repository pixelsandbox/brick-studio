// One requestAnimationFrame loop for the whole site. Subscribers run in
// insertion order and receive (elapsedSeconds, deltaSeconds).

const subscribers = new Set();
let last = 0;
let elapsed = 0;
let running = false;
// Longest step a single frame may take; keeps animations from jumping after
// a background tab or a long task. QA screenshots raise it (see main.js).
let maxDt = 1 / 20;

function frame(now) {
  const dt = Math.max(0, Math.min((now - last) / 1000, maxDt));
  last = now;
  elapsed += dt;
  for (const fn of subscribers) {
    try {
      fn(elapsed, dt);
    } catch (err) {
      // Keep the loop alive if one module throws; surface it once.
      if (!fn.__reported) {
        fn.__reported = true;
        console.error(err);
        window.dispatchEvent(new CustomEvent('app-error', { detail: err }));
      }
    }
  }
  requestAnimationFrame(frame);
}

export const raf = {
  add(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },
  start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(frame);
  },
  get time() {
    return elapsed;
  },
  set maxDt(v) {
    maxDt = v;
  },
};
