import { clamp } from './util.js';

// 2D (xz-plane) collision world: axis-aligned boxes + circles + occupancy grids.
// Used for the player, NPC agents and to rasterise the navigation grid.
export class Colliders {
  constructor() {
    this.boxes = [];
    this.circles = [];
    // Occupancy grids rasterised from imported models (e.g. the town): { minX, minZ, cell, w, h, blocked }
    this.grids = [];
    this.bounds = { minX: -1e9, maxX: 1e9, minZ: -1e9, maxZ: 1e9 };
  }

  addBox(minX, minZ, maxX, maxZ, tag = '') {
    this.boxes.push({ minX, minZ, maxX, maxZ, tag });
  }

  addBox3(box3, pad = 0, tag = '') {
    this.addBox(box3.min.x - pad, box3.min.z - pad, box3.max.x + pad, box3.max.z + pad, tag);
  }

  // Box centred at (x,z) with half extents, optionally rotated by 90° multiples only.
  addRect(x, z, hx, hz, tag = '') {
    this.addBox(x - hx, z - hz, x + hx, z + hz, tag);
  }

  addCircle(x, z, r, tag = '') {
    this.circles.push({ x, z, r, tag });
  }

  // Push a circle of radius r at pos (Vector3, xz used) out of every collider.
  // bounds: optional per-caller override (the player uses the town's bounds while in the town).
  resolve(pos, r, bounds = this.bounds) {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const b of this.boxes) {
        if (pos.x < b.minX - r || pos.x > b.maxX + r || pos.z < b.minZ - r || pos.z > b.maxZ + r) continue;
        const cx = clamp(pos.x, b.minX, b.maxX);
        const cz = clamp(pos.z, b.minZ, b.maxZ);
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        if (d2 > 1e-8) {
          const d = Math.sqrt(d2);
          pos.x = cx + (dx / d) * r;
          pos.z = cz + (dz / d) * r;
        } else {
          // Centre inside the box: exit via the nearest face.
          const l = pos.x - b.minX;
          const rr = b.maxX - pos.x;
          const t = pos.z - b.minZ;
          const bt = b.maxZ - pos.z;
          const m = Math.min(l, rr, t, bt);
          if (m === l) pos.x = b.minX - r;
          else if (m === rr) pos.x = b.maxX + r;
          else if (m === t) pos.z = b.minZ - r;
          else pos.z = b.maxZ + r;
        }
        moved = true;
      }
      for (const c of this.circles) {
        const dx = pos.x - c.x;
        const dz = pos.z - c.z;
        const rr = r + c.r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-4;
        pos.x = c.x + (dx / d) * rr;
        pos.z = c.z + (dz / d) * rr;
        moved = true;
      }
      for (const g of this.grids) {
        if (gridPush(g, pos, r)) moved = true;
      }
      if (!moved) break;
    }
    const B = bounds;
    pos.x = clamp(pos.x, B.minX + r, B.maxX - r);
    pos.z = clamp(pos.z, B.minZ + r, B.maxZ - r);
  }

  blocked(x, z, r) {
    const B = this.bounds;
    if (x < B.minX + r || x > B.maxX - r || z < B.minZ + r || z > B.maxZ - r) return true;
    for (const b of this.boxes) {
      const cx = clamp(x, b.minX, b.maxX);
      const cz = clamp(z, b.minZ, b.maxZ);
      if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
    }
    for (const c of this.circles) {
      if ((x - c.x) ** 2 + (z - c.z) ** 2 < (r + c.r) ** 2) return true;
    }
    for (const g of this.grids) {
      if (gridBlocked(g, x, z, r)) return true;
    }
    return false;
  }
}

// Push a circle out of the blocked cells of an occupancy grid (each blocked cell acts as a box).
function gridPush(g, pos, r) {
  const i0 = Math.floor((pos.x - r - g.minX) / g.cell);
  const i1 = Math.floor((pos.x + r - g.minX) / g.cell);
  const j0 = Math.floor((pos.z - r - g.minZ) / g.cell);
  const j1 = Math.floor((pos.z + r - g.minZ) / g.cell);
  if (i1 < 0 || j1 < 0 || i0 >= g.w || j0 >= g.h) return false;
  let moved = false;
  for (let j = Math.max(0, j0); j <= Math.min(g.h - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(g.w - 1, i1); i++) {
      if (!g.blocked[j * g.w + i]) continue;
      const minX = g.minX + i * g.cell;
      const minZ = g.minZ + j * g.cell;
      const cx = clamp(pos.x, minX, minX + g.cell);
      const cz = clamp(pos.z, minZ, minZ + g.cell);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * r;
        pos.z = cz + (dz / d) * r;
      } else {
        // Centre inside a blocked cell: step back out along the shortest axis.
        const l = pos.x - minX;
        const rr = minX + g.cell - pos.x;
        const t = pos.z - minZ;
        const bt = minZ + g.cell - pos.z;
        const m = Math.min(l, rr, t, bt);
        if (m === l) pos.x = minX - r;
        else if (m === rr) pos.x = minX + g.cell + r;
        else if (m === t) pos.z = minZ - r;
        else pos.z = minZ + g.cell + r;
      }
      moved = true;
    }
  }
  return moved;
}

function gridBlocked(g, x, z, r) {
  const i0 = Math.floor((x - r - g.minX) / g.cell);
  const i1 = Math.floor((x + r - g.minX) / g.cell);
  const j0 = Math.floor((z - r - g.minZ) / g.cell);
  const j1 = Math.floor((z + r - g.minZ) / g.cell);
  for (let j = Math.max(0, j0); j <= Math.min(g.h - 1, j1); j++) {
    for (let i = Math.max(0, i0); i <= Math.min(g.w - 1, i1); i++) {
      if (g.blocked[j * g.w + i]) return true;
    }
  }
  return false;
}

// ---------- 3D helpers used by the minigames ----------

// Sphere vs axis-aligned box. Returns contact normal + depth or null.
export function sphereAABB(p, r, min, max) {
  const cx = clamp(p.x, min.x, max.x);
  const cy = clamp(p.y, min.y, max.y);
  const cz = clamp(p.z, min.z, max.z);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const dz = p.z - cz;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > r * r) return null;
  const d = Math.sqrt(d2);
  if (d < 1e-6) return { nx: 0, ny: 0, nz: -1, depth: r, px: cx, py: cy, pz: cz };
  return { nx: dx / d, ny: dy / d, nz: dz / d, depth: r - d, px: cx, py: cy, pz: cz };
}
