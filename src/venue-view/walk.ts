import { useEffect } from "react";
import type { AreaKind, MapData } from "../maps/types";
import { openDoors } from "./roadInteract";

type Booth = MapData["booths"][number];

export type ViewMode = "drone" | "road";
export type MoveKey = "forward" | "back" | "left" | "right" | "fast";
/** Held movement keys, written by the keyboard and the touch pad and read by the camera rigs every frame. */
export type MoveInput = Set<MoveKey>;
/** Floor point (world x/z, meters) and heading; yaw 0 faces -z (map north), positive turns left. */
export type Pose = { x: number; z: number; yaw: number };
/** Axis-aligned floor rectangle in world meters. */
export type Rect = { x0: number; z0: number; x1: number; z1: number };
/** Wall run from (ax, az) to (bx, bz) in world meters, `r` = half its thickness. `idx` = structure.walls index; an open door's wall is skipped. */
export type Wall = { ax: number; az: number; bx: number; bz: number; r: number; idx?: number };
/** Everything the walker cannot enter, plus the booth footprints (open, walkable) that `rectAt` still finds. */
export type Obstacles = { rects: Rect[]; walls: Wall[]; fixed?: FixedGrid; booths: Rect[] };
/** Interior fixtures (columns, service-band walls, lifts) bucketed into square cells so a step only tests its own cell. */
export type FixedGrid = { cells: Map<number, { rects: Rect[]; walls: Wall[] }> };

const CELL_M = 5;
const INNER_WALL_R = 0.05;
const cellKey = (cx: number, cz: number) => cx * 100003 + cz;

const buildFixedGrid = (details: NonNullable<NonNullable<MapData["structure"]>["details"]>, m: number): FixedGrid => {
  const cells: FixedGrid["cells"] = new Map();
  // Registered in every cell the shape grown by the walker's reach touches, so a lookup needs one cell.
  const put = (x0: number, z0: number, x1: number, z1: number, add: (c: { rects: Rect[]; walls: Wall[] }) => void) => {
    const g = WALKER_R + 0.1;
    for (let cx = Math.floor((x0 - g) / CELL_M); cx <= Math.floor((x1 + g) / CELL_M); cx++) {
      for (let cz = Math.floor((z0 - g) / CELL_M); cz <= Math.floor((z1 + g) / CELL_M); cz++) {
        let c = cells.get(cellKey(cx, cz));
        if (!c) cells.set(cellKey(cx, cz), (c = { rects: [], walls: [] }));
        add(c);
      }
    }
  };
  const addWall = (w: Wall) =>
    put(Math.min(w.ax, w.bx) - w.r, Math.min(w.az, w.bz) - w.r, Math.max(w.ax, w.bx) + w.r, Math.max(w.az, w.bz) + w.r, (c) => c.walls.push(w));
  const addRect = (r: Rect) => put(r.x0, r.z0, r.x1, r.z1, (c) => c.rects.push(r));
  const boxRect = (b: number[]) => rectOf({ x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] }, m);
  for (const c of details.columns) {
    const r = boxRect(c.r);
    if (c.round) {
      // A round column is a zero-length wall as thick as its radius.
      addWall({ ax: (r.x0 + r.x1) / 2, az: (r.z0 + r.z1) / 2, bx: (r.x0 + r.x1) / 2, bz: (r.z0 + r.z1) / 2, r: (r.x1 - r.x0) / 2 });
    } else addRect(r);
  }
  for (const w of details.innerWalls) {
    addWall({ ax: w.a[0] * m, az: w.a[1] * m, bx: w.b[0] * m, bz: w.b[1] * m, r: INNER_WALL_R });
  }
  for (const e of details.elevators) addRect(boxRect(e));
  return { cells };
};

const fixedAt = ({ fixed }: Obstacles, x: number, z: number) => fixed?.cells.get(cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));

export const WALKER_R = 0.35;
/** Road-view booth frame post: square section (m), standing inside each booth corner, outer faces flush with the plan rect. */
export const POST_M = 0.08;

/** Centres of a booth's four corner posts in world x/z. */
export const boothPosts = (r: Rect): [number, number][] => {
  const i = POST_M / 2;
  return [
    [r.x0 + i, r.z0 + i],
    [r.x1 - i, r.z0 + i],
    [r.x1 - i, r.z1 - i],
    [r.x0 + i, r.z1 - i],
  ];
};

/** Keyboard WASD/arrows/Shift into `input`; keys typed into a text field stay text. */
export const useMoveKeys = (input: MoveInput) => {
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      const key = KEY_MAP[e.code];
      if (!key || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      input.add(key);
      if (key !== "fast") e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      const key = KEY_MAP[e.code];
      if (key) input.delete(key);
    };
    // A key released while the window is unfocused never sends keyup; drop everything instead of walking forever.
    const clear = () => input.clear();
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [input]);
};

export const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select") !== null);

/** Forward/strafe axes in -1..1 from the held keys. */
export const moveAxes = (input: MoveInput) => ({
  f: (input.has("forward") ? 1 : 0) - (input.has("back") ? 1 : 0),
  s: (input.has("right") ? 1 : 0) - (input.has("left") ? 1 : 0),
});

/**
 * Booth corner posts, raised areas you cannot walk onto (seating and photo zones stay walkable) and the hall walls.
 * A booth is an open frame: only its posts block (each a zero-length wall as thick as its half-diagonal), so the walker
 * enters between them. Wall runs already stop at entrances, docks and doors, so those stay open; movable partitions
 * are floor seams, not walls.
 */
export const obstaclesOf = (data: MapData, booths: Booth[]): Obstacles => {
  const m = data.metersPerPx;
  const boothRects = booths.map((b) => rectOf(b, m));
  const postR = POST_M * Math.SQRT1_2;
  return {
    rects: data.areas.filter((a) => SOLID_AREAS.has(a.kind)).map((o) => rectOf(o, m)),
    walls: [
      ...(data.structure?.walls ?? []).map((w, idx) => ({
        idx,
        ax: w.a[0] * m,
        az: w.a[1] * m,
        bx: w.b[0] * m,
        bz: w.b[1] * m,
        r: w.thicknessM / 2,
      })),
      ...boothRects.flatMap((r) => boothPosts(r).map(([x, z]) => ({ ax: x, az: z, bx: x, bz: z, r: postR }))),
    ],
    fixed: data.structure?.details ? buildFixedGrid(data.structure.details, m) : undefined,
    booths: boothRects,
  };
};

/** Source-px box to world rect. */
export const rectOf = (o: { x: number; y: number; w: number; h: number }, m: number): Rect => ({
  x0: o.x * m,
  z0: o.y * m,
  x1: (o.x + o.w) * m,
  z1: (o.y + o.h) * m,
});

/**
 * Pushes the walker circle out of every rect and back onto the floor, in place.
 * Run after each step: pushing out along the contact normal makes walls slide instead of stick.
 */
export const collide = (p: { x: number; z: number }, obs: Obstacles, W: number, D: number) => {
  for (let pass = 0; pass < 3; pass++) {
    pushOut(p, obs.rects, obs.walls);
    const near = fixedAt(obs, p.x, p.z);
    if (near) pushOut(p, near.rects, near.walls);
  }
  p.x = clamp(p.x, WALKER_R, W - WALKER_R);
  p.z = clamp(p.z, WALKER_R, D - WALKER_R);
};

const pushOut = (p: { x: number; z: number }, rects: Rect[], walls: Wall[]) => {
  {
    for (const w of walls) {
      if (w.idx !== undefined && openDoors.has(w.idx)) continue;
      const vx = w.bx - w.ax;
      const vz = w.bz - w.az;
      const t = clamp(((p.x - w.ax) * vx + (p.z - w.az) * vz) / (vx * vx + vz * vz || 1), 0, 1);
      const dx = p.x - (w.ax + vx * t);
      const dz = p.z - (w.az + vz * t);
      const reach = WALKER_R + w.r;
      const d = Math.hypot(dx, dz);
      if (d >= reach) continue;
      if (d > 1e-6) {
        p.x += (dx / d) * (reach - d);
        p.z += (dz / d) * (reach - d);
      } else {
        // Exactly on the wall line: step off along its normal.
        const len = Math.hypot(vx, vz) || 1;
        p.x += (-vz / len) * reach;
        p.z += (vx / len) * reach;
      }
    }
    for (const r of rects) {
      const dx = p.x - clamp(p.x, r.x0, r.x1);
      const dz = p.z - clamp(p.z, r.z0, r.z1);
      const d2 = dx * dx + dz * dz;
      if (d2 >= WALKER_R * WALKER_R) continue;
      if (d2 > 1e-12) {
        const k = (WALKER_R - Math.sqrt(d2)) / Math.sqrt(d2);
        p.x += dx * k;
        p.z += dz * k;
      } else {
        // Centre inside the rect: leave through the nearest side.
        const exits = [
          { d: p.x - r.x0 + WALKER_R, x: -1, z: 0 },
          { d: r.x1 - p.x + WALKER_R, x: 1, z: 0 },
          { d: p.z - r.z0 + WALKER_R, x: 0, z: -1 },
          { d: r.z1 - p.z + WALKER_R, x: 0, z: 1 },
        ].sort((a, b) => a.d - b.d)[0];
        p.x += exits.x * exits.d;
        p.z += exits.z * exits.d;
      }
    }
  }
};

/** Nearest point to (x, z) where the walker fits, searching outward in rings. */
export const freeSpotNear = (x: number, z: number, obs: Obstacles, W: number, D: number) => {
  if (isFree(x, z, obs, W, D)) return { x, z };
  for (let ring = 0.5; ring <= 60; ring += 0.5) {
    const n = Math.max(8, Math.ceil((2 * Math.PI * ring) / 0.5));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const px = x + Math.cos(a) * ring;
      const pz = z + Math.sin(a) * ring;
      if (isFree(px, pz, obs, W, D)) return { x: px, z: pz };
    }
  }
  return { x: clamp(x, WALKER_R, W - WALKER_R), z: clamp(z, WALKER_R, D - WALKER_R) };
};

/**
 * A free spot facing `target` from its side nearest `from`, far enough back to take in that side.
 * Falls back to the nearest free spot around the target.
 */
export const spotFacing = (target: Rect, from: { x: number; z: number }, obs: Obstacles, W: number, D: number): Pose => {
  const cx = (target.x0 + target.x1) / 2;
  const cz = (target.z0 + target.z1) / 2;
  const sides = [
    { x: cx, z: target.z1, len: target.x1 - target.x0, nx: 0, nz: 1 },
    { x: cx, z: target.z0, len: target.x1 - target.x0, nx: 0, nz: -1 },
    { x: target.x0, z: cz, len: target.z1 - target.z0, nx: -1, nz: 0 },
    { x: target.x1, z: cz, len: target.z1 - target.z0, nx: 1, nz: 0 },
  ].sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
  const face = (x: number, z: number): Pose => ({ x, z, yaw: Math.atan2(-(cx - x), -(cz - z)) });
  // Comfortable spots first (whole face in view, a clear walk to it), then any spot on any side, then anywhere near.
  for (const minGap of [VIEW_GAP, 1.5]) {
    for (const s of sides) {
      const far = clamp(s.len * 0.5, minGap, 15);
      for (const gap of [far, (far + minGap) / 2, minGap]) {
        const x = s.x + s.nx * gap;
        const z = s.z + s.nz * gap;
        if (isFree(x, z, obs, W, D) && clearWalk(x, z, s.nx, s.nz, gap, obs, W, D)) return face(x, z);
      }
    }
  }
  const p = freeSpotNear(cx, target.z1 + VIEW_GAP, obs, W, D);
  return face(p.x, p.z);
};

/**
 * Distance from a booth face at which its whole wall (floor to the 3 m top, eye at 1.6 m) fits in a
 * 60deg vertical view: 1.6 / tan(30deg) ~ 2.8 m.
 */
const VIEW_GAP = 2.8;

/** The walker could walk straight from (x, z) back along -(nx, nz) to the face: nothing stands in between. */
const clearWalk = (x: number, z: number, nx: number, nz: number, gap: number, obs: Obstacles, W: number, D: number) => {
  for (let d = 0.5; d < gap - WALKER_R; d += 0.5) {
    if (!isFree(x - nx * d, z - nz * d, obs, W, D)) return false;
  }
  return true;
};

/** The obstacle or booth rect containing (x, z), if any. */
export const rectAt = (x: number, z: number, { rects, booths }: Obstacles) =>
  [...rects, ...booths].find((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);

const isFree = (x: number, z: number, obs: Obstacles, W: number, D: number) => {
  const { rects, walls } = obs;
  const near = fixedAt(obs, x, z);
  return (
  x >= WALKER_R &&
  z >= WALKER_R &&
  x <= W - WALKER_R &&
  z <= D - WALKER_R &&
  rects.every((r) => Math.hypot(x - clamp(x, r.x0, r.x1), z - clamp(z, r.z0, r.z1)) >= WALKER_R) &&
  walls.every((w) => (w.idx !== undefined && openDoors.has(w.idx)) || segDist(x, z, w) >= WALKER_R + w.r) &&
  (near?.rects.every((r) => Math.hypot(x - clamp(x, r.x0, r.x1), z - clamp(z, r.z0, r.z1)) >= WALKER_R) ?? true) &&
  (near?.walls.every((w) => segDist(x, z, w) >= WALKER_R + w.r) ?? true)
  );
};

/** Farthest a click-teleport reaches when the view never meets the floor (looking level or up). */
const TELEPORT_MAX_M = 60;
const TELEPORT_STEP_M = 0.1;

/**
 * Click-to-teleport target: the floor point the view ray meets (eye at `eyeH`), reached by marching from the walker
 * along the view heading and stopping at the last spot the walker fits, so a wall, column or closed door in between
 * lands you just in front of it instead of past it. Null when the very first step is blocked.
 */
export const lookFloorSpot = (p: { x: number; z: number }, yaw: number, pitch: number, eyeH: number, obs: Obstacles, W: number, D: number) => {
  const reach = pitch < 0 ? Math.min(TELEPORT_MAX_M, eyeH / Math.tan(-pitch)) : TELEPORT_MAX_M;
  const d = freeRun(p, yaw, reach, obs, W, D);
  return d > 0 ? { x: p.x - Math.sin(yaw) * d, z: p.z - Math.cos(yaw) * d } : null;
};

/** How far (m, in TELEPORT_STEP_M steps) the walker fits along heading `yaw` before something blocks it, up to `reach`. */
export const freeRun = (p: { x: number; z: number }, yaw: number, reach: number, obs: Obstacles, W: number, D: number) => {
  const dx = -Math.sin(yaw);
  const dz = -Math.cos(yaw);
  let last = 0;
  for (let d = TELEPORT_STEP_M; d <= reach; d += TELEPORT_STEP_M) {
    if (!isFree(p.x + dx * d, p.z + dz * d, obs, W, D)) break;
    last = d;
  }
  return last;
};

/**
 * Index into `obs.booths` of the booth the view ray (eye at `eyeH`) meets first, as a `boothH`-tall box, before the
 * floor; null when none, or when a wall stops the walker well short of it (the booth is behind that wall).
 */
export const lookBooth = (p: { x: number; z: number }, yaw: number, pitch: number, eyeH: number, boothH: number, obs: Obstacles, W: number, D: number) => {
  const c = Math.cos(pitch);
  const dir = [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
  const o = [p.x, eyeH, p.z];
  let tMax = pitch < 0 ? eyeH / -dir[1] : Infinity;
  let best: number | null = null;
  obs.booths.forEach((r, i) => {
    const lo = [r.x0, 0, r.z0];
    const hi = [r.x1, boothH, r.z1];
    let t0 = 0;
    let t1 = tMax;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dir[k]) < 1e-9) {
        if (o[k] < lo[k] || o[k] > hi[k]) return;
        continue;
      }
      const a = (lo[k] - o[k]) / dir[k];
      const b = (hi[k] - o[k]) / dir[k];
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
      if (t0 > t1) return;
    }
    tMax = t0;
    best = i;
  });
  if (best === null) return null;
  // Occlusion: the walker must get to within LOOK_BOOTH_SLACK_M of the booth's face (its own corner posts block a bit early).
  const flat = tMax * c;
  return freeRun(p, yaw, flat, obs, W, D) >= flat - LOOK_BOOTH_SLACK_M ? best : null;
};
const LOOK_BOOTH_SLACK_M = 1;

const segDist = (x: number, z: number, w: Wall) => {
  const vx = w.bx - w.ax;
  const vz = w.bz - w.az;
  const t = clamp(((x - w.ax) * vx + (z - w.az) * vz) / (vx * vx + vz * vz || 1), 0, 1);
  return Math.hypot(x - (w.ax + vx * t), z - (w.az + vz * t));
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const SOLID_AREAS = new Set<AreaKind>(["stage", "facility"]);

const KEY_MAP: Record<string, MoveKey> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "fast",
  ShiftRight: "fast",
};
