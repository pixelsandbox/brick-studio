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
const MAX_SUBSTEPS = 3;
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
    // ABS on ABS: low bounce, moderate friction, settles quickly.
    this.world.addContactMaterial(new ContactMaterial(this.brickMat, this.brickMat, {
      friction: 0.32,
      restitution: 0.16,
      contactEquationStiffness: 5e6,
      contactEquationRelaxation: 3,
    }));
    this.world.addContactMaterial(new ContactMaterial(this.brickMat, this.groundMat, {
      friction: 0.48,
      restitution: 0.12,
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
   * Replaces the environment: an infinite ground at `groundY` plus soft
   * invisible walls around `bounds` so loose bricks stay in view.
   * @param {{groundY?: number, bounds: {minX: number, maxX: number, minZ: number, maxZ: number}, wallH?: number}} opts
   */
  setEnvironment({ groundY = 0, bounds, wallH = 40 }) {
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
      linearDamping: 0.04,
      angularDamping: 0.12,
      allowSleep: true,
      sleepSpeedLimit: 0.35,
      sleepTimeLimit: 0.45,
    });
    b.position.set(pos.x, pos.y, pos.z);
    b.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    b.previousPosition.copy(b.position);
    b.interpolatedPosition.copy(b.position);
    b.interpolatedQuaternion.copy(b.quaternion);
    if (vel) b.velocity.set(vel.x, vel.y, vel.z);
    if (angVel) b.angularVelocity.set(angVel.x, angVel.y, angVel.z);
    b.addEventListener('collide', (e) => {
      if (!this.onImpact) return;
      const speed = Math.abs(e.contact.getImpactVelocityAlongNormal());
      const now = performance.now();
      if (speed > 4 && now - this._lastImpact > 45) {
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
    if (this.grab && this.grab.id === id) this.release();
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
      const k = Math.min(1, dt * 30);
      _v.set((g.target.x - p.x) * k, (g.target.y - p.y) * k, (g.target.z - p.z) * k);
      p.vadd(_v, p);
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
    this.release();
    const pivot = new Vec3(point.x, point.y, point.z);
    const local = new Vec3();
    b.pointToLocalFrame(pivot, local);
    this.grabBody.position.copy(pivot);
    this.grabBody.velocity.set(0, 0, 0);
    const c = new PointToPointConstraint(b, local, this.grabBody, new Vec3(0, 0, 0), b.mass * 400);
    this.world.addConstraint(c);
    b.wakeUp();
    b.angularDamping = 0.85;
    b.linearDamping = 0.35;
    this.grab = { id, body: b, constraint: c, target: pivot.clone() };
    return true;
  }

  moveGrab(point) {
    if (this.grab) this.grab.target.set(point.x, point.y, point.z);
  }

  /** Lets go; the brick keeps its momentum (capped) so it can be thrown. */
  release(maxSpeed = 38) {
    const g = this.grab;
    if (!g) return;
    this.world.removeConstraint(g.constraint);
    g.body.angularDamping = 0.12;
    g.body.linearDamping = 0.04;
    const v = g.body.velocity;
    const s = v.length();
    if (s > maxSpeed) v.scale(maxSpeed / s, v);
    this.grab = null;
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
