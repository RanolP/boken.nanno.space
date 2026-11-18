import { useSyncExternalStore } from "react";

/**
 * Road-view interaction state shared by the 3D scene and the DOM HUD: which exit doors are open (and their swing
 * animation), which door is in reach of the walker, and whether the mouse is captured (pointer lock).
 */

/** Wall index (structure.walls[i]) of every exit door that is open. Read by `collide`: an open door no longer blocks. */
export const openDoors = new Set<number>();

export const DOOR_SWING_RAD = Math.PI / 2;
const DOOR_SWING_S = 0.6;
/** E opens the nearest door whose centre is within this many metres of the walker. */
export const DOOR_REACH_M = 3;

type Anim = { from: number; to: number; t0: number };
const anims = new Map<number, Anim>();
const smooth = (x: number) => x * x * (3 - 2 * x);
const now = () => performance.now() / 1000;

/** Swing progress 0 (closed) .. 1 (open) of door `i`; a pure function of time, so both leaves read the same value. */
export const doorProgress = (i: number) => {
  const a = anims.get(i);
  if (!a) return 0;
  return a.from + (a.to - a.from) * smooth(Math.min(1, (now() - a.t0) / DOOR_SWING_S));
};

export const toggleDoor = (i: number) => {
  const to = openDoors.has(i) ? 0 : 1;
  anims.set(i, { from: doorProgress(i), to, t0: now() });
  if (to) openDoors.add(i);
  else openDoors.delete(i);
};

/** Door centres in world metres, registered by Building while it draws them (road view only). */
let spots: { i: number; x: number; z: number }[] = [];
export const registerDoors = (s: typeof spots) => {
  spots = s;
};

export const nearestDoor = (x: number, z: number) => {
  let best: number | null = null;
  let bd = DOOR_REACH_M;
  for (const s of spots) {
    const d = Math.hypot(s.x - x, s.z - z);
    if (d <= bd) {
      bd = d;
      best = s.i;
    }
  }
  return best;
};

const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
let near: number | null = null;
let locked = false;

export const setNearDoor = (i: number | null) => {
  if (i === near) return;
  near = i;
  subs.forEach((f) => f());
};
export const setPointerLocked = (v: boolean) => {
  if (v === locked) return;
  locked = v;
  subs.forEach((f) => f());
};
export const getNearDoor = () => near;
export const useNearDoor = () => useSyncExternalStore(subscribe, () => near);
export const usePointerLocked = () => useSyncExternalStore(subscribe, () => locked);
