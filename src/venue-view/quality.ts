/**
 * Render budget. Phones and tablets (a touch-first pointer, or a browser reporting 4 GB of memory or less) get smaller
 * baked atlases, capped anisotropy and a lower render resolution: mobile browsers lose the WebGL context or fail canvas
 * allocations well before desktop ones, and their GPUs are fill-rate bound at a 3x device pixel ratio.
 */
export const LOW_POWER =
  matchMedia("(pointer: coarse)").matches || ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 4;

/** Render resolution range (device pixels per CSS pixel); the scene drops toward MIN_DPR while the frame rate is low. */
export const MAX_DPR = Math.min(window.devicePixelRatio || 1, LOW_POWER ? 1.5 : 2);
export const MIN_DPR = Math.min(MAX_DPR, LOW_POWER ? 0.75 : 1);

/** Upper bound for every texture's anisotropic filtering; 16x on a mobile GPU costs bandwidth on the floor at grazing angles. */
export const MAX_ANISOTROPY = LOW_POWER ? 4 : 16;

/** Widest (and tallest) baked atlas canvas in texels: 4096^2 RGBA with mips is ~90 MB each, and road view bakes three. */
export const ATLAS_MAX = LOW_POWER ? 2048 : 4096;
