import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { COLLISION_PATCHES } from './site.js';

// Slim enough for the narrow spots (0.47 m past the open en-suite leaf into the walk-in closet),
// short enough for the 1.76 m garage fire-door head seen from the lobby. The eye sits above the capsule.
export const RADIUS = 0.2;
export const EYE_HEIGHT = 1.6;
const CAPSULE_TOP = 1.45; // top sphere centre; capsule reaches 1.65
export const STEP_HEIGHT = 0.26; // the west deck stair foot is 0.24 above the (estimated) ground
const GRAVITY = 9.8;
const FLOOR_NORMAL_Y = 0.5; // contacts steeper than ~60° count as walls
const STEP_PROBE = 0.08; // m
const ACCEL = 12; // how fast horizontal speed follows the input (1/s)

// One octree from several glTF scenes (house collision + optional furniture boxes).
// Triangles lying wholly inside a walk-through box (door leaves, floor plants) are left out,
// so you can walk through them. Octree.build() empties the triangle list, so everything goes
// in through a single group.
export function buildOctree(scenes, walkthrough = []) {
  const boxes = walkthrough.map(([x0, y0, z0, x1, y1, z1]) => new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)));
  const group = new THREE.Group();
  for (const s of scenes) group.add(s.clone());
  group.updateMatrixWorld(true);
  const kept = new THREE.Group();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone()).applyMatrix4(o.matrixWorld);
    const pos = g.attributes.position;
    const out = [];
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      if (boxes.some((box) => box.containsPoint(a) && box.containsPoint(b) && box.containsPoint(c))) continue;
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    kept.add(new THREE.Mesh(geo));
  });
  kept.updateMatrixWorld(true);
  return new Octree().fromGraphNode(kept);
}

// Invisible boxes that fill gaps in the exported collision mesh (see site.js).
export function collisionPatches() {
  const group = new THREE.Group();
  for (const [x, y, z, w, h, d] of COLLISION_PATCHES) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d));
    box.position.set(x, y, z);
    group.add(box);
  }
  return group;
}

const _up = new THREE.Vector3(0, 1, 0);
const _move = new THREE.Vector3();
const _flat = new THREE.Vector3();
const _ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));

// Lift the capsule straight up by the least amount (at most STEP_HEIGHT) that clears everything.
// Vertical only, so it can rest on a riser's nosing without being pushed back off it. A binary search,
// because a riser edge gives a mostly sideways normal that says little about the height needed.
function settle(capsule, octree) {
  if (!octree.capsuleIntersect(capsule)) return true;
  const probe = capsule.clone();
  const top = STEP_HEIGHT + 0.01;
  if (octree.capsuleIntersect(probe.translate(_up.clone().multiplyScalar(top)))) return false;
  let lo = 0;
  let hi = top;
  for (let i = 0; i < 6; i++) {
    const mid = (lo + hi) / 2;
    probe.copy(capsule).translate(_up.clone().multiplyScalar(mid));
    if (octree.capsuleIntersect(probe)) lo = mid;
    else hi = mid;
  }
  capsule.translate(_up.clone().multiplyScalar(hi + 0.001));
  return true;
}

// Capsule walker in the style of three.js's games_fps example, plus step-up and
// step-down snapping so stairs and the 0.17 m level changes walk smoothly.
export class Body {
  constructor() {
    this.capsule = new Capsule(new THREE.Vector3(), new THREE.Vector3(0, CAPSULE_TOP - RADIUS, 0), RADIUS);
    this.velocity = new THREE.Vector3();
    this.onFloor = false;
    this._eye = new THREE.Vector3();
  }

  get eye() {
    return this._eye.copy(this.capsule.start).setY(this.capsule.start.y - RADIUS + EYE_HEIGHT);
  }

  get feetY() {
    return this.capsule.start.y - RADIUS;
  }

  placeAt(x, floorY, z) {
    this.capsule.start.set(x, floorY + RADIUS, z);
    this.capsule.end.set(x, floorY + CAPSULE_TOP, z);
    this.velocity.set(0, 0, 0);
    this.onFloor = false;
  }

  // Push the capsule out of the octree. Returns 'floor', 'wall' or null.
  resolve(capsule, octree) {
    const hit = octree.capsuleIntersect(capsule);
    if (!hit) return null;
    capsule.translate(hit.normal.clone().multiplyScalar(hit.depth));
    if (hit.normal.y > FLOOR_NORMAL_Y) {
      if (this.velocity.y < 0) this.velocity.y = 0;
      return 'floor';
    }
    this.velocity.addScaledVector(hit.normal, -hit.normal.dot(this.velocity));
    return 'wall';
  }

  // Floor just under the feet? Catches standing against a riser, where the combined
  // collision normal is mostly horizontal and resolve() reports 'wall'.
  supported(octree) {
    _ray.origin.copy(this.capsule.start);
    const hit = octree.rayIntersect(_ray);
    return !!hit && hit.distance < RADIUS + 0.06;
  }

  step(dt, wish, octree) {
    const k = 1 - Math.exp(-ACCEL * dt);
    this.velocity.x += (wish.x - this.velocity.x) * k;
    this.velocity.z += (wish.z - this.velocity.z) * k;
    this.velocity.y -= GRAVITY * dt;

    const wasOnFloor = this.onFloor || this.supported(octree);
    const before = this.capsule.clone();
    _move.copy(this.velocity).multiplyScalar(dt);
    this.capsule.translate(_move);
    const contact = this.resolve(this.capsule, octree);
    this.onFloor = contact === 'floor';
    // Floor and riser contacts can merge into one mostly-upward normal, so also check whether
    // the walk actually got anywhere.
    const tried = Math.hypot(_move.x, _move.z);
    const got = Math.hypot(this.capsule.start.x - before.start.x, this.capsule.start.z - before.start.z);
    const blocked = tried > 1e-5 && got < tried * 0.5;

    // Step up: blocked while grounded and walking, so try the same move from STEP_HEIGHT higher.
    if ((contact === 'wall' || blocked) && wasOnFloor) {
      // Probe along the input direction, at least STEP_PROBE ahead: hugging a riser leaves
      // almost no forward velocity, and a tiny probe would drop straight back onto the edge.
      _flat.set(wish.x, 0, wish.z);
      const want = _flat.length() * dt;
      _flat.setLength(Math.max(want, STEP_PROBE));
      const lifted = before.clone().translate(_up.clone().multiplyScalar(STEP_HEIGHT));
      if (want > 1e-6 && !octree.capsuleIntersect(lifted) && !octree.capsuleIntersect(lifted.translate(_flat))) {
        lifted.translate(_up.clone().multiplyScalar(-STEP_HEIGHT));
        if (settle(lifted, octree) && lifted.start.y > before.start.y + 0.01) {
          this.capsule.copy(lifted);
          this.velocity.y = 0;
          this.onFloor = true;
        }
      }
    }

    // Step down: stay glued to stairs instead of hopping off each tread. Drop straight down onto
    // the floor under the feet; if that would clip the edge we just left, let gravity do it.
    if (!this.onFloor && wasOnFloor && this.velocity.y <= 0) {
      _ray.origin.copy(this.capsule.start);
      const hit = octree.rayIntersect(_ray);
      if (hit && hit.distance > RADIUS && hit.distance <= RADIUS + STEP_HEIGHT) {
        const probe = this.capsule.clone().translate(_up.clone().multiplyScalar(RADIUS - hit.distance + 0.001));
        if (!octree.capsuleIntersect(probe)) {
          this.capsule.copy(probe);
          this.velocity.y = 0;
          this.onFloor = true;
        }
      }
    }
  }
}
