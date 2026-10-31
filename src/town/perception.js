import * as THREE from 'three';

// NPC perception prototype: an NPC detects a target only if it is
//   1. within detection distance,
//   2. inside the NPC's field of view (angle between facing and target direction), and
//   3. not hidden behind solid geometry (raycast line-of-sight test against the town's buildings).
// A radius-only check is evaluated alongside for comparison and debugging.
export class Perception {
  constructor({ range = 9, fovDeg = 110, eyeHeight = 1.55, occluders = [] } = {}) {
    this.range = range;
    this.cosHalfFov = Math.cos(THREE.MathUtils.degToRad(fovDeg / 2));
    this.fovDeg = fovDeg;
    this.eyeHeight = eyeHeight;
    this.occluders = occluders;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._dir = new THREE.Vector3();
  }

  // npcPos / targetPos: feet positions (y = ground). heading: yaw, NPC faces +z rotated by heading.
  sense(npcPos, heading, targetPos, targetEye = 1.6) {
    const dx = targetPos.x - npcPos.x;
    const dz = targetPos.z - npcPos.z;
    const dist = Math.hypot(dx, dz);
    const inRange = dist <= this.range;
    // Facing f = (sin h, cos h); cos(angle) = f · d / |d|
    const cosA = dist > 1e-4 ? (Math.sin(heading) * dx + Math.cos(heading) * dz) / dist : 1;
    const inFov = cosA >= this.cosHalfFov;
    let los = false;
    let hitPoint = null;
    if (inRange && inFov) {
      this._from.set(npcPos.x, npcPos.y + this.eyeHeight, npcPos.z);
      this._to.set(targetPos.x, targetPos.y + targetEye, targetPos.z);
      this._dir.subVectors(this._to, this._from);
      const len = this._dir.length();
      this._dir.divideScalar(len);
      this.ray.set(this._from, this._dir);
      this.ray.far = len - 0.25;
      const hit = this.ray.intersectObjects(this.occluders, false)[0];
      los = !hit;
      hitPoint = hit ? hit.point.clone() : null;
    }
    const sees = inRange && inFov && los;
    let reason = 'visible';
    if (!inRange) reason = 'too far';
    else if (!inFov) reason = 'outside field of view';
    else if (!los) reason = 'blocked by a building';
    return {
      dist,
      angleDeg: THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, cosA)))),
      inRange,
      inFov,
      los,
      sees,
      radiusOnly: inRange, // what a plain radius check would report
      reason,
      hitPoint,
    };
  }
}
