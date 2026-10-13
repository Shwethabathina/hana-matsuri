import * as THREE from 'three';

// Grid navigation: obstacles are rasterised from the collision world,
// A* finds a path, then line-of-sight string pulling smooths it.
export class NavGrid {
  constructor(colliders, { minX, maxX, minZ, maxZ, cell = 0.5, agentRadius = 0.4 }) {
    this.minX = minX;
    this.minZ = minZ;
    this.cell = cell;
    this.w = Math.ceil((maxX - minX) / cell);
    this.h = Math.ceil((maxZ - minZ) / cell);
    this.blocked = new Uint8Array(this.w * this.h);
    for (let j = 0; j < this.h; j++) {
      for (let i = 0; i < this.w; i++) {
        const x = minX + (i + 0.5) * cell;
        const z = minZ + (j + 0.5) * cell;
        this.blocked[j * this.w + i] = colliders.blocked(x, z, agentRadius) ? 1 : 0;
      }
    }
    this.g = new Float32Array(this.w * this.h);
    this.parent = new Int32Array(this.w * this.h);
    this.stamp = new Uint32Array(this.w * this.h);
    this.closed = new Uint32Array(this.w * this.h);
    this.search = 0;
  }

  toCell(x, z) {
    return [Math.floor((x - this.minX) / this.cell), Math.floor((z - this.minZ) / this.cell)];
  }

  isFree(i, j) {
    return i >= 0 && j >= 0 && i < this.w && j < this.h && !this.blocked[j * this.w + i];
  }

  nearestFree(i, j) {
    if (this.isFree(i, j)) return [i, j];
    for (let r = 1; r < 20; r++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
          if (this.isFree(i + di, j + dj)) return [i + di, j + dj];
        }
      }
    }
    return null;
  }

  worldOf(i, j) {
    return new THREE.Vector3(this.minX + (i + 0.5) * this.cell, 0, this.minZ + (j + 0.5) * this.cell);
  }

  findPath(from, to) {
    const s = this.nearestFree(...this.toCell(from.x, from.z));
    const e = this.nearestFree(...this.toCell(to.x, to.z));
    if (!s || !e) return null;
    const W = this.w;
    const start = s[1] * W + s[0];
    const goal = e[1] * W + e[0];
    const id = ++this.search;
    const heap = new MinHeap();
    const h = (n) => {
      const dx = Math.abs((n % W) - e[0]);
      const dz = Math.abs(Math.floor(n / W) - e[1]);
      return dx + dz + (Math.SQRT2 - 2) * Math.min(dx, dz);
    };
    this.g[start] = 0;
    this.stamp[start] = id;
    this.parent[start] = -1;
    heap.push(start, h(start));
    let found = false;
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (this.closed[cur] === id) continue;
      this.closed[cur] = id;
      if (cur === goal) {
        found = true;
        break;
      }
      if (++expanded > 20000) break;
      const ci = cur % W;
      const cj = Math.floor(cur / W);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (!this.isFree(ni, nj)) continue;
          // No corner cutting.
          if (di && dj && (!this.isFree(ci + di, cj) || !this.isFree(ci, cj + dj))) continue;
          const n = nj * W + ni;
          if (this.closed[n] === id) continue;
          const ng = this.g[cur] + (di && dj ? Math.SQRT2 : 1);
          if (this.stamp[n] !== id || ng < this.g[n]) {
            this.stamp[n] = id;
            this.g[n] = ng;
            this.parent[n] = cur;
            heap.push(n, ng + h(n));
          }
        }
      }
    }
    if (!found) return null;
    const cells = [];
    for (let n = goal; n !== -1; n = this.parent[n]) cells.push(n);
    cells.reverse();
    const pts = cells.map((n) => this.worldOf(n % W, Math.floor(n / W)));
    pts[pts.length - 1].set(to.x, 0, to.z);
    return this.smooth(pts);
  }

  lineFree(a, b) {
    const d = a.distanceTo(b);
    const steps = Math.ceil(d / (this.cell * 0.5));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const [i, j] = this.toCell(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (!this.isFree(i, j)) return false;
    }
    return true;
  }

  smooth(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let anchor = 0;
    for (let k = 2; k < pts.length; k++) {
      if (!this.lineFree(pts[anchor], pts[k])) {
        out.push(pts[k - 1]);
        anchor = k - 1;
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  // Debug overlay texture of blocked cells.
  debugMesh() {
    const c = document.createElement('canvas');
    c.width = this.w;
    c.height = this.h;
    const g = c.getContext('2d');
    const img = g.createImageData(this.w, this.h);
    for (let n = 0; n < this.blocked.length; n++) {
      const b = this.blocked[n];
      img.data[n * 4] = b ? 255 : 40;
      img.data[n * 4 + 1] = b ? 60 : 220;
      img.data[n * 4 + 2] = b ? 60 : 120;
      img.data[n * 4 + 3] = b ? 130 : 40;
    }
    g.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    const geo = new THREE.PlaneGeometry(this.w * this.cell, this.h * this.cell);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    mesh.position.set(this.minX + (this.w * this.cell) / 2, 0.06, this.minZ + (this.h * this.cell) / 2);
    mesh.renderOrder = 5;
    return mesh;
  }
}

class MinHeap {
  constructor() {
    this.items = [];
    this.keys = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, key) {
    const a = this.items;
    const k = this.keys;
    a.push(item);
    k.push(key);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [a[p], a[i]] = [a[i], a[p]];
      [k[p], k[i]] = [k[i], k[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const k = this.keys;
    const top = a[0];
    const lastA = a.pop();
    const lastK = k.pop();
    if (a.length) {
      a[0] = lastA;
      k[0] = lastK;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && k[l] < k[m]) m = l;
        if (r < a.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        [k[m], k[i]] = [k[i], k[m]];
        i = m;
      }
    }
    return top;
  }
}
