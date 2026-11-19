import { useSyncExternalStore } from "react";
import type { Object3D } from "three";
import type { StageId } from "../maps/types";

/**
 * Road-view interaction state shared by the 3D scene and the DOM HUD: which exit doors are open (and their swing
 * animation), which door the crosshair looks at, and whether the mouse is captured (pointer lock).
 */

/** Wall index (structure.walls[i]) of every exit door that is open. Read by `collide`: an open door no longer blocks. */
export const openDoors = new Set<number>();

export const DOOR_SWING_RAD = Math.PI / 2;
const DOOR_SWING_S = 0.6;
/** User: "문 바라볼 땐 LMB 문 열기/문 닫기": a door leaf the crosshair ray hits within this many metres of the eye can be toggled. */
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
  subs.forEach((f) => f());
};

/** Swing groups of every drawn door leaf (road view only), tagged with their door id; RoadRig raycasts them for the door aim. */
export const doorLeaves = new Set<{ object: Object3D; i: number }>();

const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
/** Door id under the road-view crosshair (pointer locked only); a left click toggles it instead of teleporting. */
let aimDoor: number | null = null;
let locked = false;
/** Booth code under the road-view crosshair (pointer locked only); drives the booth probe HUD and the aim outline. */
let aimBooth: string | null = null;

export const setAimDoor = (i: number | null) => {
  if (i === aimDoor) return;
  aimDoor = i;
  subs.forEach((f) => f());
};
export const setPointerLocked = (v: boolean) => {
  if (v === locked) return;
  locked = v;
  subs.forEach((f) => f());
};
export const setAimBooth = (code: string | null) => {
  if (code === aimBooth) return;
  aimBooth = code;
  subs.forEach((f) => f());
};
/** The floor ring is shown, so a left click teleports (RoadRig's `teleportSpot` result); drives the HUD crosshair shape. */
let teleportable = false;
export const setTeleportable = (v: boolean) => {
  if (v === teleportable) return;
  teleportable = v;
  subs.forEach((f) => f());
};
export const useTeleportable = () => useSyncExternalStore(subscribe, () => teleportable);
/** RED/BLUE STAGE under the road-view crosshair (pointer locked only); drives the crosshair hint like a booth. */
let aimStage: StageId | null = null;
export const setAimStage = (s: StageId | null) => {
  if (s === aimStage) return;
  aimStage = s;
  subs.forEach((f) => f());
};
export const useAimStage = () => useSyncExternalStore(subscribe, () => aimStage);
export const getAimBooth = () => aimBooth;
export const useAimBooth = () => useSyncExternalStore(subscribe, () => aimBooth);
export const getAimDoor = () => aimDoor;
/** null = no door aimed, else whether the aimed door is open (the HUD says 문 닫기 / 문 열기). */
export const useAimDoorOpen = () => useSyncExternalStore(subscribe, () => (aimDoor === null ? null : openDoors.has(aimDoor)));
export const usePointerLocked = () => useSyncExternalStore(subscribe, () => locked);
