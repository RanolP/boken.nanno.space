import * as THREE from "three";

/**
 * Procedural road-view surfaces, drawn once into a canvas (no image hosts: the CSP blocks them).
 * Each texture covers a whole number of real metres so the caller tiles it with `repeat = size / TILE_M`.
 */

/** Floor tile: 2 x 2 slab panels between saw-cut expansion joints, as poured in exhibition halls. */
export const FLOOR_TILE_M = 15;
const FLOOR_PANEL_M = FLOOR_TILE_M / 2;
const FLOOR_PX = 1024;

/** Ceiling tile: one bay of the space frame's bottom chords. */
export const CEILING_TILE_M = 12;
const CEILING_PX = 512;

/** Deterministic PRNG so every load draws the same floor. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Smooth value noise on a `cells` lattice that wraps at `size` px, so the tile repeats without a seam. */
const valueNoise = (size: number, cells: number, rand: () => number) => {
  const lattice = Float32Array.from({ length: cells * cells }, rand);
  const out = new Float32Array(size * size);
  const step = size / cells;
  for (let y = 0; y < size; y++) {
    const gy = y / step;
    const y0 = Math.floor(gy) % cells;
    const y1 = (y0 + 1) % cells;
    const fy = gy - Math.floor(gy);
    const sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < size; x++) {
      const gx = x / step;
      const x0 = Math.floor(gx) % cells;
      const x1 = (x0 + 1) % cells;
      const fx = gx - Math.floor(gx);
      const sx = fx * fx * (3 - 2 * fx);
      const a = lattice[y0 * cells + x0] + (lattice[y0 * cells + x1] - lattice[y0 * cells + x0]) * sx;
      const b = lattice[y1 * cells + x0] + (lattice[y1 * cells + x1] - lattice[y1 * cells + x0]) * sx;
      out[y * size + x] = a + (b - a) * sy - 0.5;
    }
  }
  return out;
};

const finish = (canvas: HTMLCanvasElement, repeatX: number, repeatY: number, anisotropy: number) => {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
};

/**
 * Grey polished concrete: low-frequency mottling, fine aggregate speckle, a slight tone step between
 * pours, and dark saw-cut joints every FLOOR_PANEL_M. Grey value is the albedo; the caller lights it.
 */
export const makeFloorTexture = (widthM: number, depthM: number, anisotropy: number) => {
  const N = FLOOR_PX;
  const rand = mulberry32(20261118);
  const octaves = [
    { cells: 4, amp: 10 },
    { cells: 12, amp: 6 },
    { cells: 48, amp: 4 },
    { cells: 256, amp: 3 },
  ].map((o) => ({ ...o, n: valueNoise(N, o.cells, rand) }));
  const panelPx = N / 2;
  const panelTone = [0, 4, -3, 2];
  const jointPx = Math.max(2, Math.round((0.012 / FLOOR_TILE_M) * N * 2));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(N, N);
  const BASE = 196;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      let v = BASE + panelTone[(y >= panelPx ? 2 : 0) + (x >= panelPx ? 1 : 0)];
      for (const o of octaves) v += o.n[i] * o.amp * 2;
      // Sparse aggregate flecks, lighter and darker.
      const r = rand();
      if (r < 0.004) v -= 18;
      else if (r > 0.997) v += 12;
      // Saw-cut joint centred on each panel edge (x/y = 0 and panelPx), with a faint dirty halo either side.
      const dx = Math.min(x % panelPx, panelPx - (x % panelPx));
      const dy = Math.min(y % panelPx, panelPx - (y % panelPx));
      const d = Math.min(dx, dy);
      if (d < jointPx) v -= 70;
      else if (d < jointPx + 3) v -= 14;
      const c = Math.max(0, Math.min(255, Math.round(v)));
      img.data[i * 4] = c;
      img.data[i * 4 + 1] = c + 1;
      img.data[i * 4 + 2] = Math.min(255, c + 3);
      img.data[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(canvas, widthM / FLOOR_TILE_M, depthM / FLOOR_TILE_M, anisotropy);
};

/** Underside of the roof deck seen through the space frame: dark deck, lighter diagonal web members and chords. */
export const makeCeilingTexture = (widthM: number, depthM: number, anisotropy: number) => {
  const N = CEILING_PX;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = N;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#2b2e33";
  ctx.fillRect(0, 0, N, N);
  // Corrugated deck ribs every 0.3 m.
  ctx.strokeStyle = "#33363c";
  ctx.lineWidth = 3;
  const rib = (0.3 / CEILING_TILE_M) * N;
  for (let x = 0; x < N; x += rib) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, N);
    ctx.stroke();
  }
  // Space-frame web: a 3 m square grid with both diagonals, the classic double-layer grid seen from below.
  const cell = N / 4;
  ctx.strokeStyle = "#6c717a";
  ctx.lineWidth = 3;
  for (let i = 0; i <= 4; i++) {
    ctx.beginPath();
    ctx.moveTo(i * cell, 0);
    ctx.lineTo(i * cell, N);
    ctx.moveTo(0, i * cell);
    ctx.lineTo(N, i * cell);
    ctx.stroke();
  }
  ctx.strokeStyle = "#555a62";
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      ctx.beginPath();
      ctx.moveTo(i * cell, j * cell);
      ctx.lineTo((i + 1) * cell, (j + 1) * cell);
      ctx.moveTo((i + 1) * cell, j * cell);
      ctx.lineTo(i * cell, (j + 1) * cell);
      ctx.stroke();
    }
  }
  // Nodes where members meet.
  ctx.fillStyle = "#8a8f97";
  for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) ctx.fillRect(i * cell - 4, j * cell - 4, 8, 8);
  return finish(canvas, widthM / CEILING_TILE_M, depthM / CEILING_TILE_M, anisotropy);
};
