// Thin cannon-es wrapper for the stage. The world lives in the active
// model's own space (stud units, y up), so scrolling never disturbs it.
// Only loose bricks are dynamic bodies; the ground, soft side walls and a few
// static neighbours (bricks still clicked into the model) are static.

import {
  World,
  Body,
  Box,
  Vec3,
  Plane,
  Material,
  ContactMaterial,
  PointToPointConstraint,
  SAPBroadphase,
} from '../../vendor/cannon/cannon-es.js';

const STEP = 1 / 60;
const MAX_SUBSTEPS = 5;
const _v = new Vec3();

export class Physics {
  /**
   * @param {{gravity?: number, onImpact?: (speed: number) => void}} [opts]
   *   gravity in studs/s^2 (toy scale, much lower than real 1226 studs/s^2
   *   so tumbles read on screen); onImpact fires on hard contacts.
   */
  constructor({ gravity = 70, onImpact = null } = {}) {
    this.onImpact = onImpact;
    this.world = new World({ gravity: new Vec3(0, -gravity, 0) });
    this.world.allowSleep = true;
    this.world.broadphase = new SAPBroadphase(this.world);
    this.world.solver.iterations = 12;
    this.world.solver.tolerance = 0.001;
    this.brickMat = new Material('brick');
    this.groundMat = new Material('ground');
    // Lively ABS plastic bounce: bounces scale naturally with throw/impact force.
    this.world.addContactMaterial(new ContactMaterial(this.brickMat, this.brickMat, {
      friction: 0.28,
      restitution: 0.46,
      contactEquationStiffness: 5e6,
      contactEquationRelaxation: 3,
    }));
    this.world.addContactMaterial(new ContactMaterial(this.brickMat, this.groundMat, {
      friction: 0.36,
      restitution: 0.54,
      contactEquationStiffness: 5e6,
      contactEquationRelaxation: 3,
    }));
    /** @type {Map<number|string, Body>} */
    this.bodies = new Map();
    /** @type {Map<number|string, Body>} */
    this.statics = new Map();
    this.env = [];
    this.grabBody = new Body({ mass: 0, type: Body.KINEMATIC });
    this.grabBody.collisionResponse = false;
    this.world.addBody(this.grabBody);
    this.grab = null;
    this._lastImpact = 0;
  }

  /**
   * Replaces the environment: an infinite ground at `groundY` plus optional
   * invisible walls around `bounds`.
   * @param {{groundY?: number, bounds?: {minX: number, maxX: number, minZ: number, maxZ: number}|null, wallH?: number}} opts
   */
  setEnvironment({ groundY = 0, bounds = null, wallH = 40 }) {
    for (const b of this.env) this.world.removeBody(b);
    this.env = [];
    const ground = new Body({ mass: 0, material: this.groundMat, shape: new Plane() });
    ground.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    ground.position.set(0, groundY, 0);
    this.env.push(ground);
    if (bounds) {
      const { minX, maxX, minZ, maxZ } = bounds;
      const t = 2;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const hx = (maxX - minX) / 2 + t;
      const hz = (maxZ - minZ) / 2 + t;
      const walls = [
        [minX - t, cz, t, hz],
        [maxX + t, cz, t, hz],
        [cx, minZ - t, hx, t],
        [cx, maxZ + t, hx, t],
      ];
      for (const [x, z, sx, sz] of walls) {
        const w = new Body({ mass: 0, material: this.groundMat, shape: new Box(new Vec3(sx, wallH / 2, sz)) });
        w.position.set(x, groundY + wallH / 2, z);
        this.env.push(w);
      }
    }
    for (const b of this.env) this.world.addBody(b);
  }

  /**
   * Static box (a brick that is still clicked into the model, a tray wall).
   * @param {number|string} id
   * @param {{half: number[], pos: {x: number, y: number, z: number}, quat: {x: number, y: number, z: number, w: number}}} box
   */
  addStatic(id, { half, pos, quat }) {
    if (this.statics.has(id)) return;
    const b = new Body({ mass: 0, material: this.brickMat, shape: new Box(new Vec3(half[0], half[1], half[2])) });
    b.position.set(pos.x, pos.y, pos.z);
    b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    this.statics.set(id, b);
    this.world.addBody(b);
  }

  removeStatic(id) {
    const b = this.statics.get(id);
    if (!b) return;
    this.world.removeBody(b);
    this.statics.delete(id);
  }

  /**
   * Adds a loose brick. `pos` is the box centre.
   * @param {number|string} id
   * @param {{half: number[], pos: object, quat: object, vel?: object, angVel?: object}} o
   */
  addDynamic(id, { half, pos, quat, vel, angVel }) {
    this.remove(id);
    const mass = Math.max(0.15, half[0] * half[1] * half[2] * 2);
    const b = new Body({
      mass,
      material: this.brickMat,
      shape: new Box(new Vec3(half[0], half[1], half[2])),
      linearDamping: 0.025,
      angularDamping: 0.1,
      allowSleep: true,
      sleepSpeedLimit: 0.35,
      sleepTimeLimit: 0.5,
    });
    b.position.set(pos.x, pos.y, pos.z);
    b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);
    b.interpolatedQuaternion.copy(b.quaternion);
    if (vel) b.velocity.set(vel.x, vel.y, vel.z);
    if (angVel) b.angularVelocity.set(angVel.x, angVel.y, angVel.z);
    b.addEventListener('collide', (e) => {
      const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
      // Reinforce vertical bounce on hard ground impacts so force translates into visible multi-bounces
      if (speed > 8 && (e.body === this.env[0] || e.contact.bi === this.env[0] || e.contact.bj === this.env[0])) {
        const minBounceY = speed * 0.48;
        if (b.velocity.y < minBounceY) {
          b.velocity.y = minBounceY;
        }
      }
      if (!this.onImpact) return;
      const now = performance.now();
      if (speed > 3.5 && now - this._lastImpact > 40) {
        this._lastImpact = now;
        this.onImpact(speed);
      }
    });
    this.bodies.set(id, b);
    this.world.addBody(b);
    return b;
  }

  remove(id) {
    const b = this.bodies.get(id);
    if (!b) return;
    if (this.grab && this.grab.id === id) this.release(0);
    this.world.removeBody(b);
    this.bodies.delete(id);
  }

  has(id) {
    return this.bodies.has(id);
  }

  /** Box-centre pose of a loose brick (interpolated between fixed steps). */
  pose(id, outPos, outQuat) {
    const b = this.bodies.get(id);
    if (!b) return false;
    const p = b.interpolatedPosition;
    const q = b.interpolatedQuaternion;
    outPos.set(p.x, p.y, p.z);
    outQuat.set(q.x, q.y, q.z, q.w);
    return true;
  }

  /** Advances the simulation; returns the number of awake bodies. */
  step(dt) {
    if (this.grab) {
      const g = this.grab;
      // Move the kinematic handle with a velocity so the constraint drags
      // smoothly and the brick keeps that momentum when released.
      const p = this.grabBody.position;
      const safeDt = Math.max(dt, 1 / 120);
      const k = Math.min(1, dt * 45);
      _v.set((g.target.x - p.x) * k, (g.target.y - p.y) * k, (g.target.z - p.z) * k);
      this.grabBody.velocity.set(_v.x / safeDt, _v.y / safeDt, _v.z / safeDt);
      p.vadd(_v, p);
    } else {
      this.grabBody.velocity.set(0, 0, 0);
    }
    this.world.step(STEP, Math.min(dt, STEP * MAX_SUBSTEPS), MAX_SUBSTEPS);
    let awake = 0;
    for (const b of this.bodies.values()) if (b.sleepState !== Body.SLEEPING) awake++;
    return awake;
  }

  impulse(id, imp, point = null) {
    const b = this.bodies.get(id);
    if (!b) return;
    b.wakeUp();
    const at = point ? new Vec3(point.x, point.y, point.z) : b.position;
    b.applyImpulse(new Vec3(imp.x, imp.y, imp.z), at);
  }

  /**
   * Starts dragging a loose brick by a world-space point on it.
   * @param {number|string} id
   * @param {{x: number, y: number, z: number}} point grab point (model space)
   */
  startGrab(id, point) {
    const b = this.bodies.get(id);
    if (!b) return false;
    this.release(0);
    const pivot = new Vec3(point.x, point.y, point.z);
    const local = new Vec3();
    b.pointToLocalFrame(pivot, local);
    this.grabBody.position.copy(pivot);
    this.grabBody.velocity.set(0, 0, 0);
    const c = new PointToPointConstraint(b, local, this.grabBody, new Vec3(0, 0, 0), b.mass * 900);
    this.world.addConstraint(c);
    b.wakeUp();
    b.angularDamping = 0.78;
    b.linearDamping = 0.22;
    const now = performance.now();
    this.grab = {
      id,
      body: b,
      constraint: c,
      target: pivot.clone(),
      samples: [{ x: pivot.x, y: pivot.y, z: pivot.z, t: now }],
    };
    return true;
  }

  moveGrab(point) {
    if (!this.grab) return;
    this.grab.target.set(point.x, point.y, point.z);
    const now = performance.now();
    const samples = this.grab.samples;
    samples.push({ x: point.x, y: point.y, z: point.z, t: now });
    while (samples.length > 2 && now - samples[0].t > 130) {
      samples.shift();
    }
  }

  /**
   * Lets go; the brick launches with velocity proportional to the user's
   * drag/flick force so gentle tosses stay close and hard throws fly far.
   */
  release(maxSpeed = 115) {
    const g = this.grab;
    if (!g) return 0;
    this.world.removeConstraint(g.constraint);
    this.grabBody.velocity.set(0, 0, 0);
    const body = g.body;
    body.angularDamping = 0.1;
    body.linearDamping = 0.025;
    body.wakeUp();

    const v = body.velocity;
    if (maxSpeed <= 0) {
      v.set(0, 0, 0);
      this.grab = null;
      return 0;
    }

    const now = performance.now();
    const samples = g.samples;
    let vx = 0;
    let vy = 0;
    let vz = 0;
    let hasGesture = false;

    if (samples.length >= 2) {
      const last = samples[samples.length - 1];
      // Only treat as an active throw if the pointer moved recently (< 85ms before release)
      if (now - last.t < 85) {
        // Find a reference sample 25-95ms before the last sample for stable flick velocity
        let ref = samples[0];
        for (let i = samples.length - 2; i >= 0; i--) {
          const dtMs = last.t - samples[i].t;
          ref = samples[i];
          if (dtMs >= 35) break;
        }
        const dtSec = (last.t - ref.t) / 1000;
        if (dtSec > 0.003) {
          vx = (last.x - ref.x) / dtSec;
          vy = (last.y - ref.y) / dtSec;
          vz = (last.z - ref.z) / dtSec;
          hasGesture = true;
        }
      } else {
        // Pointer was held still before releasing: drop gently from rest
        v.scale(0.15, v);
      }
    }

    if (hasGesture) {
      const gain = 1.32;
      vx *= gain;
      vy *= gain;
      vz *= gain;
      const gSpeed = Math.hypot(vx, vy, vz);
      const bSpeed = v.length();
      if (gSpeed > bSpeed * 0.75) {
        v.set(vx, vy, vz);
      } else {
        v.set(v.x * 0.4 + vx * 0.6, v.y * 0.4 + vy * 0.6, v.z * 0.4 + vz * 0.6);
      }
      const speed = v.length();
      if (speed > 6) {
        const horiz = Math.hypot(v.x, v.z);
        if (v.y > -8) {
          v.y += Math.min(14, horiz * 0.15);
        }
        // Impart tumble proportional to throw force
        const spin = Math.min(22, speed * 0.24);
        body.angularVelocity.set(
          body.angularVelocity.x * 0.35 + (v.z / Math.max(1, speed)) * spin,
          body.angularVelocity.y * 0.35 + ((v.x - v.z) / Math.max(1, speed)) * spin * 0.6,
          body.angularVelocity.z * 0.35 - (v.x / Math.max(1, speed)) * spin,
        );
      }
    }

    const finalSpeed = v.length();
    if (finalSpeed > maxSpeed) {
      v.scale(maxSpeed / finalSpeed, v);
    }
    this.grab = null;
    return Math.min(finalSpeed, maxSpeed);
  }

  get count() {
    return this.bodies.size;
  }

  /** Removes every loose and static brick (keeps the environment). */
  clearBricks() {
    this.release();
    for (const b of this.bodies.values()) this.world.removeBody(b);
    for (const b of this.statics.values()) this.world.removeBody(b);
    this.bodies.clear();
    this.statics.clear();
  }

  dispose() {
    this.clearBricks();
    for (const b of this.env) this.world.removeBody(b);
    this.env = [];
    this.world.removeBody(this.grabBody);
  }
}
