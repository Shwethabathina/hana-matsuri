import * as THREE from 'three';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
// Frame-rate independent exponential smoothing.
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export function angleDamp(a, b, lambda, dt) {
  let d = b - a;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * (1 - Math.exp(-lambda * dt));
}

// Piecewise-linear keyframes: [[t, value], ...]
export function keyLerp(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1];
      const [t1, v1] = keys[i];
      return lerp(v0, v1, (t - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

const _ca = new THREE.Color();
const _cb = new THREE.Color();
export function keyColor(keys, t, out) {
  if (t <= keys[0][0]) return out.set(keys[0][1]);
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      _ca.set(keys[i - 1][1]);
      _cb.set(keys[i][1]);
      return out.copy(_ca).lerp(_cb, (t - keys[i - 1][0]) / (keys[i][0] - keys[i - 1][0]));
    }
  }
  return out.set(keys[keys.length - 1][1]);
}

export function canvasTexture(w, h, draw, { repeat = null, srgb = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  tex.anisotropy = 4;
  return tex;
}

// Vertical Japanese-style sign / banner texture.
export function signTexture(text, { bg = '#b3202a', fg = '#fff6e0', w = 256, h = 128, font = 64, border = '#2a1208' } = {}) {
  return canvasTexture(w, h, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = border;
    g.lineWidth = 8;
    g.strokeRect(4, 4, w - 8, h - 8);
    g.fillStyle = fg;
    g.font = `bold ${font}px "Yu Gothic", "Meiryo", "Hiragino Sans", "Noto Sans JP", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4);
  });
}

// Billboard text label; call sprite.userData.setText() to change it.
export function textSprite(text, { font = 34, color = '#fff', bg = 'rgba(20,12,30,0.72)', height = 0.32 } = {}) {
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.renderOrder = 10;
  let current = null;
  sprite.userData.setText = (t) => {
    if (t === current) return;
    current = t;
    g.font = `bold ${font}px "Yu Gothic", "Segoe UI", sans-serif`;
    const w = Math.ceil(g.measureText(t).width) + 28;
    const h = font + 20;
    canvas.width = w;
    canvas.height = h;
    g.font = `bold ${font}px "Yu Gothic", "Segoe UI", sans-serif`;
    g.fillStyle = bg;
    const r = 14;
    g.beginPath();
    g.roundRect(0, 0, w, h, r);
    g.fill();
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(t, w / 2, h / 2 + 2);
    tex.needsUpdate = true;
    sprite.scale.set((w / h) * height, height, 1);
  };
  sprite.userData.setText(text);
  return sprite;
}

// Soft radial glow texture shared by sprites and particles.
let _glow = null;
export function glowTexture() {
  if (_glow) return _glow;
  _glow = canvasTexture(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  });
  return _glow;
}

// Group [x, z, ...] spots into square cells so each cell becomes its own InstancedMesh
// and the renderer can frustum-cull the ones that are off screen.
export function chunkSpots(spots, cell = 40) {
  const map = new Map();
  for (const s of spots) {
    const key = `${Math.floor(s[0] / cell)},${Math.floor(s[1] / cell)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.values()];
}

// Enable per-chunk culling once the instance matrices are set. The margin covers wind sway.
export function cullable(im, margin = 3) {
  im.computeBoundingSphere();
  im.boundingSphere.radius += margin;
  im.frustumCulled = true;
}
