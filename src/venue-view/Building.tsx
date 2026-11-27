import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { LOW_POWER } from "./quality";
import type { MapData } from "../maps/types";
import type { ViewMode } from "./walk";
import { CAD_ONLY } from "./HallInterior";
import { debug } from "./DebugInspector";
import { DOOR_SWING_RAD, doorLeaves, doorProgress } from "./roadInteract";
import { HALL_DOOR_IDX_BASE, HALL_DOOR_OPENINGS, SHUTTER_OPENINGS } from "./walk";

interface Props {
  data: MapData;
  mode: ViewMode;
}

/** Drone view tilts down over the halls; full-height walls would hide the booths behind them. */
const DRONE_WALL_M = 1.5;
const PARTITION_W_M = 0.3;
/** 양문형 출구 도어 colour: user said "갈색", the exact shade is a placeholder. */
// door > groove > handle, light to dark (user)
const DOOR_BROWN = "#6b4a32";
const GROOVE_BROWN = "#4e3524";
const HANDLE_WOOD = "#2e1f14";
const DOOR_SEAM_M = 0.02;
/** 도어 손잡이 (ㅕ형): vertical bar spanning HANDLE_FROM..HANDLE_TO of the door height, joined to the leaf by two stand-offs. */
/** 양문형 도어 leaf = frame (2 stiles + DOOR_PANELS+1 rails) around DOOR_PANELS flush infills ringed by a GROOVE_W_M x GROOVE_D_M groove. */
const DOOR_PANELS = 4;
const DOOR_STILE_W_M = 0.12;
const DOOR_RAIL_H_M = 0.12;
/** Only the ㅁ outline is carved: groove GROOVE_W_M wide, GROOVE_D_M deep per face; panel face stays flush with the frame. */
const GROOVE_W_M = 0.025;
const GROOVE_D_M = 0.012;
const HANDLE_FROM = 0.2;
const HANDLE_TO = 0.8;
const HANDLE_BAR_M = 0.04;
/** ㅕ: the vertical bar (ㅣ) is wood, only the two stand-offs (=) are steel. */
const HANDLE_STANDOFF_M = 0.07;
const HANDLE_STRUT_M = 0.035;
const HANDLE_SEAM_GAP_M = 0.08;
/** Top hinge (user sketch #3, steel, plan view): a body lying on the leaf top turns with it to ~90 degrees; a fixed base plate on the head under it; a short link from the body corner to a pivot on the base plate. */
const HINGE_BODY_GAP_M = 0.02;
const HINGE_BODY_LEN_M = 0.25;
const HINGE_BODY_D_M = 0.06;
const HINGE_BODY_H_M = 0.05;
/** Base plate runs from this far past the hinge axis (outward) to BASE_LEN along the closed door, and sits on the swing side. */
const HINGE_BASE_OVER_M = 0.12;
const HINGE_BASE_LEN_M = 0.35;
const HINGE_BASE_D_M = 0.12;
const HINGE_BASE_T_M = 0.01;
/** Link pivot on the base plate: u inward from the hinge axis (negative = outward), z from the door mid-plane toward the swing side. */
const HINGE_PIVOT_U_M = -0.04;
const HINGE_PIVOT_Z_M = 0.13;
const HINGE_LINK_BAR_M = 0.015;
const HINGE_KNOB_D_M = 0.025;
const HINGE_KNOB_H_M = 0.025;
/** 벽 패널 줄눈: texture baked into the faces of the walls in TEXTURED_WALLS (structure.walls indices), floor to door height; above that the wall's own colour (user photo: warm-grey panel, thin horizontal seams). */
const TEXTURED_WALLS = new Set([0, 1]);
/** User: walls[58] (the dock-side stub at the far end of the walls[59..67] chain) takes walls[0]'s bake; its tiles start on a joint at the corner it shares with walls[59]. */
// User: then extended along the same dock line to walls[57], walls[56] and the heads of openings[53], openings[52]; one U origin for the whole line.
const WALL0_TEX_WALLS = new Set([58, 57, 56]);
const WALL0_TEX_OPENINGS = new Set([53, 52]);
/** structure.openings indices whose door head gets the same bake, cut to the head's height range so rows line up with the walls beside it. */
const TEXTURED_OPENINGS = new Set([0]);
/** User: from the bottom of ochre row 0 (first asked from row 1, then row 0 filled as a copy of row 1) up, the pattern runs on past walls[1] to walls[2]: those walls are split there
 * (plain below, baked above) and these openings get a baked head from that height to the ceiling. */
const EXTENDED_WALLS = new Set([2]);
const EXTENDED_OPENINGS = new Set([1]);
/** User: walls[67], then walls[66] and walls[65] (the hall-1 end walls chained back from walls[0]'s left end) take the same full-height bake with the brown-grey band;
 * U runs back along the chain from walls[0]'s start so the tiles continue around each corner. Order = chain order from walls[0]. */
// User: walls[64..59] (the rest of the hall-1 end wall, split by openings[54..59]) join the merged wall the same way; the
// openings stay open and U keeps counting across them so the tiles line up as one wall.
const CORNER_WALLS = [67, 66, 65, 64, 63, 62, 61, 60, 59];
/** User: the two wide gaps in that chain (openings[54], openings[55]) are cargo entrances (user first called them fire shutters, then corrected) closed by a roll shutter, from the floor up to the top of ochre row 0;
 * the merged wall carries on above them. Slat pitch, depth and shade are placeholders. */
const SHUTTER_T_M = 0.12;
const SHUTTER_SLAT_M = 0.1;
const SHUTTER_GREY = "#b9bcbf";
/** User: a cement-like lintel just above each shutter, about 3 slats tall, sticking out a little on both faces. Overhang and shade are placeholders. */
const SHUTTER_LINTEL_SLATS = 3;
const SHUTTER_LINTEL_OUT_M = 0.08;
const SHUTTER_LINTEL_GREY = "#a5a29b";
/** User sketch #5 (entrance elevation + plan): two right-triangle prisms at openings[ENTRANCE_PRISM_OPENING], one per ochre row in ENTRANCE_PRISM_ROWS
 * (row 0 = lowest above the door band; 1 = the row right above the opening, 5 = the top grey row). Plan: right angle at the opening's left end
 * on the hall-side face, one leg along the wall to a tile joint past the opening's right end, the other leg into the hall.
 * Depth and the overrun are read off the sketch's proportions (placeholders, no drawing source). */
const ENTRANCE_PRISM_OPENING = 1;
// User: the upper prism moved down one row (was 5, the grey top row).
const ENTRANCE_PRISM_ROWS = [1, 4];
// User: depth reduced a little (was 2.4).
const ENTRANCE_PRISM_DEPTH_M = 1.8;
const ENTRANCE_PRISM_OVERRUN_M = 2.9;
// User: the remaining exposed faces (top/bottom) are grey-white with no tint (was warm #d8d4cc).
const ENTRANCE_PRISM_COLOR = "#ffffff"; // User: pure white (was #e6e6e6, then #f0f0f0).
/** User: front of the merged box = metal, about 20 horizontal stripes per tile row, alternating face / recessed groove (the dark look is the groove shadow); depth and shades are placeholders. */
const ENTRANCE_FRONT_STRIPES = 20;
// User: toned up three times, then a little back down (was #c4c8cd / #7d8288 metalness 0.75, #e2e5e9 / #a9aeb4 0.55, #f2f4f6 / #c3c7cc 0.4, #ffffff / #d6d9dd 0.25, #f8f9fa / #cdd0d4 0.32), then a little back up.
const ENTRANCE_FRONT_METAL = "#fcfcfd";
/** Baked shadow tones (no shadow maps): groove floor, and the down-facing step at its top edge. */
const ENTRANCE_FRONT_GROOVE_FLOOR = "#d2d5d9";
const ENTRANCE_FRONT_GROOVE_TOP = "#9fa4aa";
/** Tilt of the groove edges baked into the stripe normal map; the user wants this depth (15 degrees read too shallow). */
const ENTRANCE_FRONT_GROOVE_TILT_RAD = Math.PI / 4;
/** User: raised outline rails on the top and bottom edges of the striped metal fronts; depth = the normal-map groove depth, height is a placeholder. */
const ENTRANCE_FRONT_RIM_H_M = 0.06;
// User: the rails sit flush on the top and bottom edges (inside the face).
const ENTRANCE_FRONT_RIM_INSET_M = 0;
const ENTRANCE_FRONT_RIM_DEPTH_SCALE = 1.3;
// Hanging banner in front of the gap between the entrance prisms (user request; all placeholders).
const POSTER_H_FRAC = 0.8;
const POSTER_ASPECT = 2.2; // User: "너비가 좀 줄어들어야" (was 2.6).
const POSTER_SIDE_GAP_M = 0.6;
const POSTER_FORWARD_M = 0.6;
const POSTER_DROP_M = 0.8;
/** Exit-bay lid and the wall above its doors (user request; placeholders). */
const BAY_LID_T_M = 0.2;
const BAY_COVER_COLOR = "#e4e4e4"; // User: must match the bay's side walls (details.innerWalls, #e4e4e4); was #c9c9c9.
const POSTER_ROD_R_M = 0.03;
const POSTER_ROD_OVERHANG_M = 0.08;
const POSTER_ROD_CAP_R_M = 0.042;
const POSTER_ROD_CAP_L_M = 0.05;
const POSTER_ROD_COLOR = "#4a3423"; // dark wood, placeholder
const POSTER_T_M = 0.02;
const POSTER_LINE_W_M = 0.006;
const POSTER_LOGO_SRC = "/maps/agf-2026/logo.png";
/** User sketch #7: square flat panel on the box front; offset and colour are placeholders. */
// User: attached to the striped face (no gap) and clearly standing proud of it; the slab has no back face, so nothing is coplanar to fight.
const ENTRANCE_PANEL_OFFSET_M = 0;
const ENTRANCE_PANEL_THICK_M = 0.12; // User: a little thicker (was 0.03, then 0.08).
const ENTRANCE_PANEL_COLOR = "#3a8fe0"; // User: pure blue, then "more sky blue".
/** User: big "1" on the panel with a little padding; padding is a fraction of the side, text colour a placeholder. */
const ENTRANCE_PANEL_TEXT = "1";
const ENTRANCE_PANEL_TEXT_COLOR = "#ffffff";
const ENTRANCE_PANEL_PADDING = 0.1;
/** Paint texture on the panel: colour variation (fraction of brightness) and normal-map relief strength; both placeholders. */
const ENTRANCE_PANEL_PAINT_TONE = 0.06;
const ENTRANCE_PANEL_PAINT_BUMP = 3;
/** User: bottom of the gradient, "slightly washed-out" top colour; exact shade is a placeholder. */
const ENTRANCE_PANEL_COLOR_BOTTOM = "#4b97df"; // User: the colour 20% of the way from the top of the earlier #3a8fe0 -> #8db5dc gradient.
/** User: a box of the same depth and rows runs on from the prism's right-angle end along walls[2] up to and including walls[2]'s 6th tile counted
 * from its far (+x, hall-view left) end; the tile holding that end counts as the 1st. */
const ENTRANCE_BOX_TILES = 6;
/** Door head box: flush with the 0.4 m lobby walls (same thickness, up to the ceiling) but only between their box ends -- a wall box runs t/2 past each
 * end point, so the head is cut by that much each side; overlapping coplanar faces z-fought (openings[0] vs walls[1]), a thinner head looked recessed. */
const HEAD_T_M = 0.4;
const HEAD_EXT_M = -HEAD_T_M;
const PANEL_BASE = "#c9c5bb";
/** User: on CORNER_WALLS only, the bottom band is orange instead of ivory; exact shade is a placeholder. */
const CORNER_PANEL_BASE = "#b5825a";
const CORNER_PANEL_LINE = "#8a6446";
/** User: the area above the panel band is WALL_TILE_ROWS equal rows of ochre (황토) tile, joints in the darker shade; tile width = one exit-door leaf (derived from the door data, so the texture period is that width). */
const WALL_TILE_OCHRE = "#c9b393";
const WALL_TILE_JOINT = "#9c8a6e";
const WALL_TILE_ROWS = 6;
const WALL_TILE_FEWER = 1;
const WALL_TILE_WIDEN = 1.25;
const WALL_TILE_SHIFT = 0.5;
/** User: the topmost of the WALL_TILE_ROWS rows is painted dark grey (no tile joints in it). */
const WALL_TOP_ROW_GREY = "#808080";
const PANEL_LINE = "#8f8b83";
/** User layout: the band (floor to door height) is WALL_PANEL_ROWS equal rows; the top row is split into WALL_PANEL_TOP_SUBROWS equal rows. V spans the band, so rows scale with h. */
const WALL_PANEL_ROWS = 5;
const WALL_PANEL_TOP_SUBROWS = 10;
// Phones: half the texels (a quarter of the memory and of the per-pixel weathering pass at load).
const PANEL_PX_PER_M = LOW_POWER ? 128 : 256;
const PANEL_LINE_PX = 2;
const PANEL_NOISE_DOTS = 500;
/** User: the ivory band below gets a vertical seam every 2.5 ochre tiles. The canvas spans BAKE_PERIOD_TILES tiles (the first whole multiple of 2.5) so both patterns repeat. */
const PANEL_VSEAM_TILES = 2.5;
const BAKE_PERIOD_TILES = 5;

/** Swing side corrected by user report: +1 = leaves open toward world +z (away from the lobby), -1 = toward the lobby. The CAD arcs were never read; the earlier lobby-side guess was wrong. */
const DOOR_SWING_SIDE = 1;
const HANDLE_STRUT_AT = [1 / 3, 2 / 3] as const;

/** Leaf pivot: origin on the hinge axis; rotates about Y by the door's shared swing progress (both leaves mirrored via `sign`). */
const SwingPivot = ({ i, sign, position, children }: { i: number; sign: number; position: [number, number, number]; children: ReactNode }) => {
  const ref = useRef<THREE.Group>(null);
  useEffect(() => {
    const leaf = { object: ref.current!, i };
    doorLeaves.add(leaf);
    return () => void doorLeaves.delete(leaf);
  }, [i]);
  useFrame(() => {
    if (ref.current) ref.current.rotation.y = sign * DOOR_SWING_RAD * doorProgress(i);
  });
  return (
    <group ref={ref} position={position}>
      {children}
    </group>
  );
};

/** Short link from the body's hinge-end knob (moves with the leaf) to the fixed pivot knob on the base plate, stretched between the two points every frame. */
const HingeLink = ({ i, side, lz, axisX, t, h, tag, mat, box, cyl }: { i: number; side: number; lz: number; axisX: number; t: number; h: number; tag: object; mat: THREE.Material; box: THREE.BufferGeometry; cyl: THREE.BufferGeometry }) => {
  const link = useRef<THREE.Mesh>(null);
  const yk = h / 2 + HINGE_BASE_T_M + HINGE_KNOB_H_M / 2;
  const bx = axisX - side * HINGE_PIVOT_U_M;
  const bz = lz * HINGE_PIVOT_Z_M;
  useFrame(() => {
    const m = link.current;
    if (!m) return;
    const th = side * lz * DOOR_SWING_RAD * doorProgress(i);
    const c0x = -side * HINGE_BODY_GAP_M;
    const c0z = lz * (t / 2 - HINGE_BODY_D_M / 2);
    const cx = axisX + c0x * Math.cos(th) + c0z * Math.sin(th);
    const cz = -c0x * Math.sin(th) + c0z * Math.cos(th);
    const len = Math.hypot(bx - cx, bz - cz);
    m.position.set((cx + bx) / 2, yk, (cz + bz) / 2);
    m.rotation.set(0, Math.atan2(-(bz - cz), bx - cx), 0);
    m.scale.set(len, HINGE_LINK_BAR_M, HINGE_LINK_BAR_M);
  });
  return (
    <>
      <mesh ref={link} geometry={box} material={mat} {...tag} />
      <mesh geometry={cyl} material={mat} position={[bx, yk, bz]} scale={[HINGE_KNOB_D_M, HINGE_KNOB_H_M, HINGE_KNOB_D_M]} {...tag} />
    </>
  );
};


/** User: natural weathering. Ochre tiles: blotchy noise darkening. Bottom panel band: grime that spreads from each joint line with a noisy reach,
 * plus dust rising from the floor and clinging to the wall. All noise wraps along U (period = canvas width) so the repeating texture stays seamless. */
// User: "아직 이정도로 낡진 않았어 강도 낮춰" (was ochre 0.16, line 0.38, dust 0.45); then "바닥 먼지는 약간 더 세게 하고 위쪽 벽은 약간 더 약하게" (ochre 0.07 -> 0.045, dust 0.18 -> 0.26).
// User: "위쪽도 경계선 노이즈 추가하고 pane 자체는 더 약하게" (pane 0.045 -> 0.025; tile joints get the same noisy grime as the band, a bit lighter).
const WEATHER_OCHRE_DARKEN = 0.025;
const WEATHER_TILE_LINE_DARKEN = 0.12;
const WEATHER_LINE_DARKEN = 0.15;
const WEATHER_LINE_SPREAD_M = 0.025;
const WEATHER_DUST_M = 0.7;
const WEATHER_DUST = [118, 106, 88] as const;
const WEATHER_DUST_MAX = 0.26;

/** Value noise on a lattice of `cell` px, periodic in x over width w (w is rounded to whole cells per period); y wraps too so offset lookups stay on the lattice. */
const periodicNoise = (w: number, hgt: number, cell: number, seed: number) => {
  const nx = Math.max(1, Math.round(w / cell));
  const ny = Math.ceil(hgt / cell) + 2;
  const lat = new Float32Array(nx * ny);
  let s = seed >>> 0;
  for (let i = 0; i < lat.length; i++) lat[i] = (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const cx = w / nx;
  return (x: number, y: number) => {
    const fx = x / cx;
    const fy = y / cell;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const xa = ((x0 % nx) + nx) % nx;
    const xb = (xa + 1) % nx;
    const ya = ((y0 % ny) + ny) % ny;
    const r0 = ya * nx;
    const r1 = ((ya + 1) % ny) * nx;
    const a = lat[r0 + xa] + (lat[r0 + xb] - lat[r0 + xa]) * sx;
    const b = lat[r1 + xa] + (lat[r1 + xb] - lat[r1 + xa]) * sx;
    return a + (b - a) * sy;
  };
};

const weatherWall = (g: CanvasRenderingContext2D, w: number, ph: number, top: number, greyRowPx: number, hLines: number[], vLines: number[], tileHLines: number[], tileVLines: number[]) => {
  const img = g.getImageData(0, 0, w, ph);
  const d = img.data;
  const P = PANEL_PX_PER_M;
  const big = periodicNoise(w, ph, Math.round(0.9 * P), 11);
  const mid = periodicNoise(w, ph, Math.round(0.25 * P), 23);
  const fine = periodicNoise(w, ph, Math.round(0.05 * P), 37);
  const grain = periodicNoise(w, ph, 3, 53);
  const fbm = (x: number, y: number) => big(x, y) * 0.5 + mid(x, y) * 0.3 + fine(x, y) * 0.2;
  // Nearest joint distance per row / column inside the band (vertical seams wrap at the canvas edge).
  const dy = new Float32Array(ph).fill(1e9);
  for (let y = top; y < ph; y++) for (const ly of hLines) dy[y] = Math.min(dy[y], Math.abs(y - ly));
  const dx = new Float32Array(w).fill(1e9);
  for (let x = 0; x < w; x++) for (const lx of vLines) { const t = Math.abs(x - lx); dx[x] = Math.min(dx[x], t, w - t); }
  const tdy = new Float32Array(ph).fill(1e9);
  for (let y = 0; y < top; y++) for (const ly of tileHLines) tdy[y] = Math.min(tdy[y], Math.abs(y - ly));
  const tdx = new Float32Array(w).fill(1e9);
  for (let x = 0; x < w; x++) for (const lx of tileVLines) { const t = Math.abs(x - lx); tdx[x] = Math.min(tdx[x], t, w - t); }
  const spread = WEATHER_LINE_SPREAD_M * P;
  const dustH = WEATHER_DUST_M * P;
  for (let y = greyRowPx; y < ph; y++) {
    const inBand = y >= top;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let k = 1;
      if (!inBand) {
        const n = fbm(x, y);
        const reach = spread * (0.4 + 1.6 * n);
        const grime = Math.exp(-Math.min(tdy[y], tdx[x]) / reach) * (0.35 + 0.65 * fine(x, y)) * (0.6 + 0.4 * grain(x, y));
        k = 1 - WEATHER_OCHRE_DARKEN * Math.max(0, n * 1.6 - 0.35) - 0.01 * grain(x, y) - WEATHER_TILE_LINE_DARKEN * grime;
      } else {
        const n = fbm(x, y);
        const reach = spread * (0.4 + 1.6 * n);
        const dist = Math.min(dy[y], dx[x]);
        const grime = Math.exp(-dist / reach) * (0.35 + 0.65 * fine(x, y)) * (0.6 + 0.4 * grain(x, y));
        k = 1 - WEATHER_LINE_DARKEN * grime;
      }
      let r = d[i] * k;
      let gg = d[i + 1] * k;
      let b = d[i + 2] * k;
      const up = ph - y;
      if (up < dustH * 1.6) {
        // Dust edge height wanders with the noise; denser right at the floor, speckled by the grain.
        const edge = dustH * (0.55 + 0.9 * mid(x, y + 997));
        const t = Math.max(0, 1 - up / edge);
        const a = WEATHER_DUST_MAX * t * t * (0.55 + 0.45 * fine(x + 311, y)) * (0.75 + 0.25 * grain(x + 7, y));
        r += (WEATHER_DUST[0] - r) * a;
        gg += (WEATHER_DUST[1] - gg) * a;
        b += (WEATHER_DUST[2] - b) * a;
      }
      d[i] = r;
      d[i + 1] = gg;
      d[i + 2] = b;
    }
  }
  g.putImageData(img, 0, 0);
};

/** Wall-face bake: the whole wall height H in one canvas; grey panel rows in the bottom band h, ochre tiles above. The canvas is one tile wide (tileW metres) and repeats along U. */
const makeWallBakeTexture = (H: number, h: number, tileW: number, bandColor = PANEL_BASE, bandLine = PANEL_LINE) => {
  const tw = Math.round(tileW * PANEL_PX_PER_M);
  const w = tw * BAKE_PERIOD_TILES;
  const ph = Math.ceil(H * PANEL_PX_PER_M);
  const band = Math.round(h * PANEL_PX_PER_M);
  const top = ph - band;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = ph;
  const g = c.getContext("2d")!;
  g.fillStyle = WALL_TILE_OCHRE;
  g.fillRect(0, 0, w, ph);
  g.fillStyle = bandColor;
  g.fillRect(0, top, w, band);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < PANEL_NOISE_DOTS; k++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
    g.fillRect(Math.floor(rnd() * w), top + Math.floor(rnd() * band), 1 + Math.floor(rnd() * 2), 1);
  }
  for (let k = 0; k < PANEL_NOISE_DOTS; k++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.04})`;
    g.fillRect(Math.floor(rnd() * w), Math.floor(rnd() * top), 1 + Math.floor(rnd() * 2), 1);
  }
  g.fillStyle = WALL_TILE_JOINT;
  const tileRow = (H - h) / WALL_TILE_ROWS;
  g.fillRect(0, 0, PANEL_LINE_PX / 2, top);
  for (let k = 1; k < BAKE_PERIOD_TILES; k++) g.fillRect(k * tw - PANEL_LINE_PX / 2, 0, PANEL_LINE_PX, top);
  g.fillRect(w - PANEL_LINE_PX / 2, 0, PANEL_LINE_PX / 2, top);
  for (let k = 0; k < WALL_TILE_ROWS; k++) g.fillRect(0, Math.round(ph - (h + k * tileRow) * PANEL_PX_PER_M) - PANEL_LINE_PX / 2, w, PANEL_LINE_PX);
  g.fillStyle = WALL_TOP_ROW_GREY;
  g.fillRect(0, 0, w, Math.round(tileRow * PANEL_PX_PER_M) - PANEL_LINE_PX / 2);
  g.fillStyle = bandLine;
  const hLines: number[] = [];
  const vLines: number[] = [];
  const line = (zFromFloor: number) => {
    const y = Math.round(ph - zFromFloor * PANEL_PX_PER_M);
    hLines.push(y);
    g.fillRect(0, y - PANEL_LINE_PX / 2, w, PANEL_LINE_PX);
  };
  const row = h / WALL_PANEL_ROWS;
  line(h);
  for (let k = 1; k < WALL_PANEL_ROWS; k++) line(k * row);
  for (let j = 1; j < WALL_PANEL_TOP_SUBROWS; j++) line(h - row + (j * row) / WALL_PANEL_TOP_SUBROWS);
  for (let k = 0; k * PANEL_VSEAM_TILES < BAKE_PERIOD_TILES; k++) {
    const x = Math.round(k * PANEL_VSEAM_TILES * tw);
    vLines.push(x);
    if (x === 0) {
      g.fillRect(0, top, PANEL_LINE_PX / 2, band);
      g.fillRect(w - PANEL_LINE_PX / 2, top, PANEL_LINE_PX / 2, band);
    } else g.fillRect(x - PANEL_LINE_PX / 2, top, PANEL_LINE_PX, band);
  }
  const tileHLines = Array.from({ length: WALL_TILE_ROWS }, (_, k) => Math.round(ph - (h + k * tileRow) * PANEL_PX_PER_M));
  const tileVLines = Array.from({ length: BAKE_PERIOD_TILES }, (_, k) => k * tw);
  weatherWall(g, w, ph, top, Math.round(tileRow * PANEL_PX_PER_M), hLines, vLines, tileHLines, tileVLines);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
};

type Run = { cx: number; cz: number; len: number; angle: number };

const run = (a: [number, number], b: [number, number], m: number): Run => {
  const dx = (b[0] - a[0]) * m;
  const dz = (b[1] - a[1]) * m;
  return { cx: ((a[0] + b[0]) / 2) * m, cz: ((a[1] + b[1]) / 2) * m, len: Math.hypot(dx, dz), angle: -Math.atan2(dz, dx) };
};

/** KINTEX hall shell from `data.structure`: perimeter walls with their openings, door heads, and the floor seams of retracted partitions. */
export const Building = ({ data, mode }: Props) => {
  const s = data.structure;
  const m = data.metersPerPx;
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#c9ced6" }), []);
  /** User: the exit-gap filler (side "exit-door" with no door drawn) stays, semi-transparent. */
  const gapMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#c9ced6", transparent: true, opacity: 0.35, depthWrite: false }), []);
  const seamMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#d4d8df" }), []);
  const roadWallMat = useMemo(makeRoadWallMaterial, []);
  const doorMat = useMemo(() => new THREE.MeshStandardMaterial({ color: DOOR_BROWN, roughness: 0.6 }), []);
  const doorSeamMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#1a1410" }), []);
  const cyl = useMemo(() => new THREE.CylinderGeometry(0.5, 0.5, 1, 12), []);
  const handleWoodMat = useMemo(() => new THREE.MeshStandardMaterial({ color: HANDLE_WOOD, metalness: 0, roughness: 0.65 }), []);
  const grooveMat = useMemo(() => new THREE.MeshStandardMaterial({ color: GROOVE_BROWN, roughness: 0.65 }), []);
  const handleMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#d8d8d8", metalness: 0.6, roughness: 0.3 }), []);
  useEffect(() => () => roadWallMat.dispose(), [roadWallMat]);
  const bake = useMemo(() => {
    if (!s || mode === "drone") return null;
    const doorH = s.walls.find((w) => w.side === "exit-door")?.heightM;
    const leaf = s.exits?.[0]?.doors[0];
    if (!doorH || !leaf) return null;
    const leafW = (Math.hypot(leaf.b[0] - leaf.a[0], leaf.b[1] - leaf.a[1]) * m) / 2;
    // User: tile joints fall exactly on the outer ends of the textured wall run (walls[0]'s left end, walls[1]'s right end):
    // the run holds a whole number of tiles, each stretched slightly from the door-leaf width, and U is measured from the run's start.
    const near = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5;
    const along = (a: [number, number], b: [number, number], p: [number, number]) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return ((p[0] * (b[0] - a[0]) + p[1] * (b[1] - a[1])) / len) * m;
    };
    const ends = s.walls
      .filter((w, i) => TEXTURED_WALLS.has(i) && w.side !== "exit-door")
      .flatMap((w) => [along(w.a, w.b, w.a) - w.thicknessM / 2, along(w.a, w.b, w.b) + w.thicknessM / 2]);
    const originU = ends.length ? Math.min(...ends) : 0;
    const runSpan = ends.length ? Math.max(...ends) - originU : 0;
    // User: one tile fewer than fits at the leaf width, then 1.25x wider (rounded to a whole tile count so both ends stay joints).
    const tileW = runSpan > 0 ? runSpan / Math.max(1, Math.round((Math.floor(runSpan / leafW) - WALL_TILE_FEWER) / WALL_TILE_WIDEN)) : leafW;
    const base = CAD_ONLY ? wallMat : roadWallMat;
    const out = new Map<string, { mats: THREE.Material[]; tex: THREE.Texture; back: THREE.Texture; y0: number; seg?: [[number, number], [number, number]]; geo?: THREE.BufferGeometry; runs?: Run[] }>();
    // One pattern over the whole wall line: V spans floor..H for every piece (a head shows only its y0..y1 slice),
    // U is metres along the line from a shared origin, so rows and tile joints run on across pieces.
    const H = s.ceilingM;
    // One canvas for every piece: clones share its image, so it uploads once.
    const bakeTex = makeWallBakeTexture(H, Math.min(doorH, H), tileW);
    const cornerTex = makeWallBakeTexture(H, Math.min(doorH, H), tileW, CORNER_PANEL_BASE, CORNER_PANEL_LINE);
    const period = tileW * BAKE_PERIOD_TILES;
    const add = (key: string, a: [number, number], b: [number, number], ext: number, y0: number, y1: number, org = originU, src = bakeTex) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      // User: whole pattern shifted right (+x, lobby view) by half a tile.
      const u0 = along(a, b, a) - ext / 2 - org - tileW * WALL_TILE_SHIFT;
      const tex = src.clone();
      tex.needsUpdate = true;
      const w = (len * m + ext) / period;
      tex.repeat.set(w, (y1 - y0) / H);
      tex.offset.set(u0 / period, y0 / H);
      // The box's -z face runs U from the far end back, so it needs the mirrored mapping to stay continuous with its neighbours.
      const back = tex.clone();
      back.repeat.set(-w, (y1 - y0) / H);
      back.offset.set(u0 / period + w, y0 / H);
      back.needsUpdate = true;
      const face = new THREE.MeshStandardMaterial({ map: tex });
      const faceBack = new THREE.MeshStandardMaterial({ map: back });
      out.set(key, { mats: [base, base, base, base, face, faceBack], tex, back, y0 });
    };
    // Dock line origin: a tile joint at walls[58]'s corner end (shared with walls[59]); every piece on that line measures U from it.
    const w58 = s.walls[58];
    const dockOrg = w58 ? along(w58.a, w58.b, w58.b) + w58.thicknessM / 2 - tileW * WALL_TILE_SHIFT : originU;
    s.walls.forEach((w, i) => {
      if (TEXTURED_WALLS.has(i) && w.side !== "exit-door") add(`w${i}`, w.a, w.b, w.thicknessM, 0, w.heightM);
      if (WALL0_TEX_WALLS.has(i)) add(`w${i}`, w.a, w.b, w.thicknessM, 0, w.heightM, dockOrg);
    });
    s.openings.forEach((o, i) => {
      if (WALL0_TEX_OPENINGS.has(i) && o.heightM !== undefined) add(`o${i}`, o.a, o.b, HEAD_EXT_M, o.heightM, H, dockOrg);
    });
    // User: walls[65..67] are one merged wall (a mitered extrusion along the chain), not overlapping boxes:
    // box ends overlapped at the corners and either flickered or showed a white end cap.
    // Chain order from walls[0] backwards; the end touching walls[0] runs on t/2 to cover the corner square, and walls[0]'s box starts after it.
    const chain = CORNER_WALLS.map((i) => s.walls[i]).filter(Boolean);
    const w0 = s.walls[0];
    if (chain.length && w0) {
      const t = chain[0].thicknessM;
      // Points from walls[0]'s joint back along the chain, in metres (x, z).
      // solid[k]: segment pts[k]..pts[k+1] is wall; false = an opening between two chain walls (no faces, U still advances).
            const pts: [number, number][] = [];
      const solid: boolean[] = [];
      // headY[k]: that opening is a cargo entrance or a hall door, so the wall runs on above it from this height.
      const headY: (number | undefined)[] = [];
      const shutterRuns: Run[] = [];
      const cut = Math.min(doorH, H);
      const shutterTop = cut + (H - cut) / WALL_TILE_ROWS;
      let joint: [number, number] = w0.a;
      for (const w of chain) {
        if (!pts.length) pts.push([joint[0] * m, joint[1] * m]);
        else if (!near(w.a, joint) && !near(w.b, joint)) {
          const d = (p: [number, number]) => Math.hypot(p[0] - joint[0], p[1] - joint[1]);
          const from = joint;
          joint = d(w.a) < d(w.b) ? w.a : w.b;
          pts.push([joint[0] * m, joint[1] * m]);
          solid.push(false);
          const oi = s.openings.findIndex((o) => (near(o.a, from) && near(o.b, joint)) || (near(o.a, joint) && near(o.b, from)));
          // User: openings[56..59] (the four short ones) are hall doors, headed at the door height like the exit doors.
          headY[solid.length - 1] = SHUTTER_OPENINGS.has(oi) ? shutterTop : HALL_DOOR_OPENINGS.has(oi) ? cut : undefined;
          if (SHUTTER_OPENINGS.has(oi)) shutterRuns.push(run(from, joint, m));
        }
        const far = near(w.a, joint) ? w.b : w.a;
        pts.push([far[0] * m, far[1] * m]);
        solid.push(true);
        joint = far;
      }
      // Run the first point on by t/2 past the joint (toward walls[0]'s far side) so the corner square is filled.
      const d0 = [pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]];
      const l0 = Math.hypot(d0[0], d0[1]);
      pts[0] = [pts[0][0] + (d0[0] / l0) * (t / 2), pts[0][1] + (d0[1] / l0) * (t / 2)];
      const dir = (k: number) => {
        const dx = pts[k + 1][0] - pts[k][0];
        const dz = pts[k + 1][1] - pts[k][1];
        const l = Math.hypot(dx, dz);
        return [dx / l, dz / l];
      };
      // Offset polyline on side sgn (+1 / -1) with mitered joints.
      const side = (sgn: number) =>
        pts.map((p, k) => {
          const dA = dir(Math.min(k, pts.length - 2));
          const nA = [-dA[1] * sgn, dA[0] * sgn];
          if (k === 0 || k === pts.length - 1) return [p[0] + (nA[0] * t) / 2, p[1] + (nA[1] * t) / 2];
          const dP = dir(k - 1);
          const nP = [-dP[1] * sgn, dP[0] * sgn];
          const bis = [nP[0] + nA[0], nP[1] + nA[1]];
          const cos = (bis[0] * nA[0] + bis[1] * nA[1]) / Math.hypot(bis[0], bis[1]);
          const bl = Math.hypot(bis[0], bis[1]);
          return [p[0] + ((bis[0] / bl) * t) / 2 / cos, p[1] + ((bis[1] / bl) * t) / 2 / cos];
        });
      const L = side(1);
      const R = side(-1);
      const top = chain[0].heightM;
      const pos: number[] = [];
      const uv: number[] = [];
      const idx: number[] = [];
      const groups: [number, number, number][] = [];
      const shift = tileW * WALL_TILE_SHIFT;
      const U = (um: number) => (um - shift) / period;
      const quad = (p: number[][], u: number[], v: number[]) => {
        const b = pos.length / 3;
        p.forEach((q, j) => (pos.push(q[0], q[1], q[2]), uv.push(u[j], v[j])));
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
      };
      // u on each side face = minus that side's own arc length back from the joint end, so u = 0 at the corner (walls[0]'s run start, originU).
      // The corner point on the outer side is where walls[0]'s face begins: originU is measured to walls[0].a - t/2, i.e. that outer edge.
      const startU = (S: number[][]) => {
        const out: number[] = [0];
        for (let k = 1; k < S.length; k++) out.push(out[k - 1] - Math.hypot(S[k][0] - S[k - 1][0], S[k][1] - S[k - 1][1]));
        return out;
      };
      const g0 = idx.length;
      for (const S of [L, R]) {
        const us = startU(S);
        for (let k = 0; k < S.length - 1; k++) {
          const a = S[k];
          const b = S[k + 1];
          const hy = headY[k];
          if (hy !== undefined) quad([[a[0], hy, a[1]], [b[0], hy, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]], [U(us[k]), U(us[k + 1]), U(us[k + 1]), U(us[k])], [hy / H, hy / H, top / H, top / H]);
          if (!solid[k]) continue;
          quad([[a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]], [U(us[k]), U(us[k + 1]), U(us[k + 1]), U(us[k])], [0, 0, top / H, top / H]);
        }
      }
      // End cap at the walls[0] joint continues walls[0]'s face: u from 0 (outer edge) to t.
      const outer = Math.hypot(L[0][0] - w0.a[0] * m, L[0][1] - w0.a[1] * m) > Math.hypot(R[0][0] - w0.a[0] * m, R[0][1] - w0.a[1] * m) ? [L[0], R[0]] : [R[0], L[0]];
      quad([[outer[0][0], 0, outer[0][1]], [outer[1][0], 0, outer[1][1]], [outer[1][0], top, outer[1][1]], [outer[0][0], top, outer[0][1]]], [U(0), U(t), U(t), U(0)], [0, 0, top / H, top / H]);
      groups.push([g0, idx.length - g0, 1]);
      const g1 = idx.length;
      for (let k = 0; k < L.length - 1; k++) if (solid[k] || headY[k] !== undefined) quad([[L[k][0], top, L[k][1]], [L[k + 1][0], top, L[k + 1][1]], [R[k + 1][0], top, R[k + 1][1]], [R[k][0], top, R[k][1]]], [0, 0, 0, 0], [0, 0, 0, 0]);
      const n = L.length - 1;
      quad([[L[n][0], 0, L[n][1]], [R[n][0], 0, R[n][1]], [R[n][0], top, R[n][1]], [L[n][0], top, L[n][1]]], [0, 0, 0, 0], [0, 0, 0, 0]);
      // Wall ends facing each opening (the jambs).
      for (let k = 0; k < n; k++) {
        if (solid[k]) continue;
        const y1 = headY[k] ?? top;
        for (const j of [k, k + 1]) quad([[L[j][0], 0, L[j][1]], [R[j][0], 0, R[j][1]], [R[j][0], y1, R[j][1]], [L[j][0], y1, L[j][1]]], [0, 0, 0, 0], [0, 0, 0, 0]);
        // Underside of the wall above a shutter.
        if (y1 < top) quad([[L[k][0], y1, L[k][1]], [R[k][0], y1, R[k][1]], [R[k + 1][0], y1, R[k + 1][1]], [L[k + 1][0], y1, L[k + 1][1]]], [0, 0, 0, 0], [0, 0, 0, 0]);
      }
      if (shutterRuns.length) {
        // Roll-shutter slats: a light face, a dark groove at each joint, a thin highlight under it; repeats every SHUTTER_SLAT_M.
        const c = document.createElement("canvas");
        c.width = 4;
        c.height = 32;
        const g = c.getContext("2d")!;
        g.fillStyle = SHUTTER_GREY;
        g.fillRect(0, 0, 4, 32);
        g.fillStyle = "#6f7377";
        g.fillRect(0, 0, 4, 3);
        g.fillStyle = "#e3e5e7";
        g.fillRect(0, 3, 4, 2);
        const st = new THREE.CanvasTexture(c);
        st.wrapS = st.wrapT = THREE.RepeatWrapping;
        st.repeat.set(1, shutterTop / SHUTTER_SLAT_M);
        st.colorSpace = THREE.SRGBColorSpace;
        const sm = new THREE.MeshStandardMaterial({ map: st, metalness: 0.5, roughness: 0.45 });
        out.set("shutter", { mats: [sm, sm, sm, sm, sm, sm], tex: st, back: st, y0: shutterTop, runs: shutterRuns });
      }
      groups.push([g1, idx.length - g1, 0]);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      groups.forEach(([st, c, mi]) => geo.addGroup(st, c, mi));
      geo.computeVertexNormals();
      const tex = cornerTex.clone();
      tex.needsUpdate = true;
      const face = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide });
      out.set("chain", { mats: [new THREE.MeshStandardMaterial({ color: (base as THREE.MeshStandardMaterial).color, side: THREE.DoubleSide }), face, face, face, face, face], tex, back: tex, y0: 0, geo });
      // walls[0] now starts after the merged corner: trim its box by t at the joint (u still measured from the untrimmed end).
      const lenPx = Math.hypot(w0.b[0] - w0.a[0], w0.b[1] - w0.a[1]);
      const k = w0.thicknessM / m / lenPx;
      const a0: [number, number] = [w0.a[0] + (w0.b[0] - w0.a[0]) * k, w0.a[1] + (w0.b[1] - w0.a[1]) * k];
      add("w0", a0, w0.b, w0.thicknessM, 0, w0.heightM);
      const e = out.get("w0");
      if (e) e.seg = [a0, w0.b];
    }
    // Entrance prisms (sketch #5). User: they stand on the hall side (inside, -z of the lobby wall line), not the lobby.
    const op = s.openings[ENTRANCE_PRISM_OPENING];
    if (op) {
      const t = 0.4;
      // User: mirrored left-right (sketch is seen from the hall): right angle at the opening's +x end, the wall leg runs to -x past its other end.
      const x0 = Math.max(op.a[0], op.b[0]) * m;
      const target = Math.min(op.a[0], op.b[0]) * m - ENTRANCE_PRISM_OVERRUN_M;
      // Snap the far end to a tile joint: joints sit at u = shift + k * tileW, u measured from originU along +x.
      const shift = tileW * WALL_TILE_SHIFT;
      // User: end point moved one tile left as seen from the hall (+x).
      const x1 = originU + shift + Math.round((target - originU - shift) / tileW) * tileW + tileW;
      const zf = op.a[1] * m - t / 2;
      const cut = Math.min(doorH, H);
      const row = (H - cut) / WALL_TILE_ROWS;
      const pos: number[] = [];
      const tri = (p: number[][]) => p.forEach((q) => pos.push(q[0], q[1], q[2]));
      // Hall-facing metal faces: [quad, tile rows it spans] (the stripe texture repeats once per row).
      const fronts: [number[][], number][] = [];
      // Open ends of the striped metal (end-face plane x, face line z, rows span ya..yb with n tile rows, sx = end-face normal sign) for the profile caps.
      const frontEnds: { x: number; z: number; ya: number; yb: number; n: number; sx: number }[] = [];
      // User: the two boxes are one -- the rows between them are filled, so a single box spans the lowest to the highest prism row; the prisms stay two.
      {
        const ya = cut + Math.min(...ENTRANCE_PRISM_ROWS) * row;
        const yb = cut + (Math.max(...ENTRANCE_PRISM_ROWS) + 1) * row;
        const w2x = Math.max(s.walls[2].a[0], s.walls[2].b[0]) * m;
        const xe = originU + shift + (Math.floor((w2x - originU - shift) / tileW) - ENTRANCE_BOX_TILES + 2) * tileW;
        // User: "너비 절반만 오른쪽으로" = the box keeps its start and is cut to half that length (its far end moves right in hall view, -x).
        const xeHalf = x0 + (xe - x0) / 2 - Math.sign(xe - x0) * 4 * tileW; // User: "4칸만 더 줄여봐" = 4 more tiles shorter.
        const zb = zf - ENTRANCE_PRISM_DEPTH_M;
        const Q = [[x0, zf], [x0, zb], [xeHalf, zb], [xeHalf, zf]];
        tri([[Q[0][0], yb, Q[0][1]], [Q[1][0], yb, Q[1][1]], [Q[2][0], yb, Q[2][1]]]);
        tri([[Q[0][0], yb, Q[0][1]], [Q[2][0], yb, Q[2][1]], [Q[3][0], yb, Q[3][1]]]);
        tri([[Q[0][0], ya, Q[0][1]], [Q[2][0], ya, Q[2][1]], [Q[1][0], ya, Q[1][1]]]);
        tri([[Q[0][0], ya, Q[0][1]], [Q[3][0], ya, Q[3][1]], [Q[2][0], ya, Q[2][1]]]);
        // Sides: between the prism rows the x = x0 face is exposed; behind each prism it is hidden inside it (the prism skips that leg).
        // The hall-facing front (Q[1] -> Q[2], z = zb) is its own striped metal mesh below.
        fronts.push([[[Q[1][0], ya, Q[1][1]], [Q[2][0], ya, Q[2][1]], [Q[2][0], yb, Q[2][1]], [Q[1][0], yb, Q[1][1]]], Math.max(...ENTRANCE_PRISM_ROWS) - Math.min(...ENTRANCE_PRISM_ROWS) + 1]);
        frontEnds.push({ x: Q[2][0], z: Q[2][1], ya, yb, n: Math.max(...ENTRANCE_PRISM_ROWS) - Math.min(...ENTRANCE_PRISM_ROWS) + 1, sx: Math.sign(xe - x0) });
        // User: the start end (x = x0, by the "1" panel) also shows between the two prisms, so it gets the same profile cap there.
        frontEnds.push({ x: Q[1][0], z: Q[1][1], ya: ya + row, yb: yb - row, n: Math.max(...ENTRANCE_PRISM_ROWS) - Math.min(...ENTRANCE_PRISM_ROWS) + 1 - 2, sx: -Math.sign(xe - x0) });
        for (const [A, B] of [[Q[0], Q[1]], [Q[2], Q[3]], [Q[3], Q[0]]]) {
          tri([[A[0], ya, A[1]], [B[0], ya, B[1]], [B[0], yb, B[1]]]);
          tri([[A[0], ya, A[1]], [B[0], yb, B[1]], [A[0], yb, A[1]]]);
        }
      }
      for (const r of ENTRANCE_PRISM_ROWS) {
        const ya = cut + r * row;
        const yb = ya + row;
        const P = [[x0, zf], [x1, zf], [x0, zf - ENTRANCE_PRISM_DEPTH_M]];
        tri([[P[0][0], yb, P[0][1]], [P[2][0], yb, P[2][1]], [P[1][0], yb, P[1][1]]]);
        tri([[P[0][0], ya, P[0][1]], [P[1][0], ya, P[1][1]], [P[2][0], ya, P[2][1]]]);
        // User: the prism's hall-facing slope (P[1] -> P[2]) is the same striped metal as the box front.
        fronts.push([[[P[1][0], ya, P[1][1]], [P[2][0], ya, P[2][1]], [P[2][0], yb, P[2][1]], [P[1][0], yb, P[1][1]]], 1]);
        // Skip the prism's x = x0 leg (P[2] -> P[0]): the box continues past it; the slope is in `fronts`.
        for (let k = 0; k < 1; k++) {
          const A = P[k];
          const B = P[(k + 1) % 3];
          tri([[A[0], ya, A[1]], [B[0], ya, B[1]], [B[0], yb, B[1]]]);
          tri([[A[0], ya, A[1]], [B[0], yb, B[1]], [A[0], yb, A[1]]]);
        }
      }
      // User sketch #7: a flat x-by-x square on the box front, against its open end at x0, spanning the gap rows between the two prisms
      // (x = one tile row). It floats ENTRANCE_PANEL_OFFSET_M proud of the striped face; colour is a placeholder.
      {
        const lo = Math.min(...ENTRANCE_PRISM_ROWS) + 1;
        const hi = Math.max(...ENTRANCE_PRISM_ROWS);
        // User: x = one ochre tile row high; top edge stays under the upper prism (as sketched).
        const side = row;
        if (hi > lo) {
          const zb = zf - ENTRANCE_PRISM_DEPTH_M - ENTRANCE_PANEL_OFFSET_M;
          const yb = cut + hi * row;
          const ya = yb - side;
          // User: it is a panel, so it has a little depth: a slab ENTRANCE_PANEL_THICK_M thick standing on the striped face.
          // Group 0 = hall-facing face (textured), group 1 = the four edges (plain paint colour); the back touches the box and is never seen.
          const zf2 = zb - ENTRANCE_PANEL_THICK_M;
          const x2 = x0 + side;
          const pgeo = new THREE.BufferGeometry();
          pgeo.setAttribute("position", new THREE.Float32BufferAttribute([
            x0, ya, zf2, x2, ya, zf2, x2, yb, zf2, x0, yb, zf2,
            x0, ya, zb, x0, ya, zf2, x0, yb, zf2, x0, yb, zb,
            x2, ya, zf2, x2, ya, zb, x2, yb, zb, x2, yb, zf2,
            x0, ya, zb, x2, ya, zb, x2, ya, zf2, x0, ya, zf2,
            x0, yb, zf2, x2, yb, zf2, x2, yb, zb, x0, yb, zb,
          ], 3));
          pgeo.setIndex([0, 1, 2, 3, 4].flatMap((q) => [0, 1, 2, 0, 2, 3].map((v) => v + 4 * q)));
          pgeo.addGroup(0, 6, 0);
          pgeo.addGroup(6, 24, 1);
          pgeo.computeVertexNormals();
          // User: vertical linear gradient (top = ENTRANCE_PANEL_COLOR, bottom = a washed-out version) and a big "1" with a little padding,
          // baked into one face texture (surface and text are one texture, never separate layers).
          // Seen from the hall, +x is on the viewer's left, so U runs from x0 + side (u = 0) to x0 (u = 1) to keep the text unmirrored.
          pgeo.setAttribute("uv", new THREE.Float32BufferAttribute([1, 0, 0, 0, 0, 1, 1, 1, ...new Array(32).fill(0)], 2));
          const PX = 512;
          const pc = document.createElement("canvas");
          pc.width = PX;
          pc.height = PX;
          const pg = pc.getContext("2d")!;
          const grad = pg.createLinearGradient(0, 0, 0, PX);
          grad.addColorStop(0, ENTRANCE_PANEL_COLOR);
          grad.addColorStop(1, ENTRANCE_PANEL_COLOR_BOTTOM);
          pg.fillStyle = grad;
          pg.fillRect(0, 0, PX, PX);
          const pad = PX * ENTRANCE_PANEL_PADDING;
          pg.fillStyle = ENTRANCE_PANEL_TEXT_COLOR;
          pg.textAlign = "center";
          pg.textBaseline = "alphabetic";
          let fs = PX - 2 * pad;
          pg.font = `bold ${fs}px system-ui, sans-serif`;
          // Fit the glyph's ink box (not the font's line box) inside the padding, then centre it.
          let mt = pg.measureText(ENTRANCE_PANEL_TEXT);
          const inkH = mt.actualBoundingBoxAscent + mt.actualBoundingBoxDescent;
          fs *= (PX - 2 * pad) / inkH;
          pg.font = `bold ${fs}px system-ui, sans-serif`;
          mt = pg.measureText(ENTRANCE_PANEL_TEXT);
          pg.fillText(ENTRANCE_PANEL_TEXT, PX / 2, pad + mt.actualBoundingBoxAscent);
          // User: paint texture over the whole face (ground and "1" alike). One height field = fine grain + vertical roller streaks, blurred so it
          // reads as paint rather than pixel noise; it shades the colour map lightly and drives a normal map so lights pick up the relief.
          let ps = 11;
          const prnd = () => ((ps = (ps * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
          const raw = new Float32Array(PX * PX).map(prnd);
          const streak = new Float32Array(PX).map(prnd);
          const hgt = new Float32Array(PX * PX);
          const at = (a: Float32Array, x: number, y: number) => a[((y + PX) % PX) * PX + ((x + PX) % PX)];
          for (let y = 0; y < PX; y++)
            for (let x = 0; x < PX; x++) {
              let g = 0;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) g += at(raw, x + dx, y + dy);
              const sx = (streak[(x + PX - 1) % PX] + streak[x] + streak[(x + 1) % PX]) / 3;
              hgt[y * PX + x] = (g / 9) * 0.7 + sx * 0.3;
            }
          const img = pg.getImageData(0, 0, PX, PX);
          const nc = document.createElement("canvas");
          nc.width = PX;
          nc.height = PX;
          const ng = nc.getContext("2d")!;
          const nimg = ng.createImageData(PX, PX);
          for (let y = 0; y < PX; y++)
            for (let x = 0; x < PX; x++) {
              const i = y * PX + x;
              const k = 1 + ENTRANCE_PANEL_PAINT_TONE * hgt[i] * 2;
              for (let c = 0; c < 3; c++) img.data[i * 4 + c] = Math.min(255, img.data[i * 4 + c] * k);
              // Canvas y runs down, texture v runs up: the y slope flips sign.
              const nx = -(at(hgt, x + 1, y) - at(hgt, x - 1, y)) * ENTRANCE_PANEL_PAINT_BUMP;
              const ny = (at(hgt, x, y + 1) - at(hgt, x, y - 1)) * ENTRANCE_PANEL_PAINT_BUMP;
              const nl = Math.hypot(nx, ny, 1);
              nimg.data[i * 4] = ((nx / nl) * 0.5 + 0.5) * 255;
              nimg.data[i * 4 + 1] = ((ny / nl) * 0.5 + 0.5) * 255;
              nimg.data[i * 4 + 2] = ((1 / nl) * 0.5 + 0.5) * 255;
              nimg.data[i * 4 + 3] = 255;
            }
          pg.putImageData(img, 0, 0);
          ng.putImageData(nimg, 0, 0);
          const pnrm = new THREE.CanvasTexture(nc);
          pnrm.anisotropy = 16;
          const ptex = new THREE.CanvasTexture(pc);
          ptex.colorSpace = THREE.SRGBColorSpace;
          ptex.anisotropy = 16;
          const pmat = new THREE.MeshStandardMaterial({ map: ptex, normalMap: pnrm, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
          const pedge = new THREE.MeshStandardMaterial({ color: ENTRANCE_PANEL_COLOR, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
          out.set("entrancePanel", { mats: [pmat, pedge, pmat, pmat, pmat, pmat], tex: ptex, back: pnrm, y0: 0, geo: pgeo });
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: ENTRANCE_PRISM_COLOR, side: THREE.DoubleSide });
      const tex = new THREE.Texture();
      out.set("prism", { mats: [mat, mat, mat, mat, mat, mat], tex, back: tex, y0: 0, geo });
      // User: ~20 horizontal stripes per tile row; every other stripe is a recessed groove (음각) whose dark look is its shadow.
      // Flat face + normal map: each groove has bevelled top/bottom edges in the normal map, so lights shade the edges like a real step.
      // No shadow maps in the scene, so the colour map keeps a baked shadow tone on the groove floor and its down-facing top edge.
      if (fronts.length) {
        const SP = 32; // px per stripe
        const BV = 6; // bevel px at each groove edge
        const hpx = ENTRANCE_FRONT_STRIPES * SP;
        const FW = 64;
        const mk = () => {
          const c = document.createElement("canvas");
          c.width = FW;
          c.height = hpx;
          return [c, c.getContext("2d")!] as const;
        };
        const [cc, gc] = mk();
        const [nc, gn] = mk();
        const s45 = Math.sin(ENTRANCE_FRONT_GROOVE_TILT_RAD);
        const c45 = Math.cos(ENTRANCE_FRONT_GROOVE_TILT_RAD);
        const nrm = (ny: number, nz: number) => `rgb(128,${Math.round((ny * 0.5 + 0.5) * 255)},${Math.round((nz * 0.5 + 0.5) * 255)})`;
        // Canvas y runs down; stripe k counts up from the row's bottom (texture flipY puts canvas bottom at v = 0).
        for (let k = 0; k < ENTRANCE_FRONT_STRIPES; k++) {
          const top = hpx - (k + 1) * SP;
          if (k % 2 === 0) {
            gc.fillStyle = ENTRANCE_FRONT_METAL;
            gc.fillRect(0, top, FW, SP);
            gn.fillStyle = nrm(0, 1);
            gn.fillRect(0, top, FW, SP);
            continue;
          }
          gc.fillStyle = ENTRANCE_FRONT_GROOVE_FLOOR;
          gc.fillRect(0, top, FW, SP);
          gn.fillStyle = nrm(0, 1);
          gn.fillRect(0, top, FW, SP);
          // Top edge: the step comes back out going up, so it faces down (shadowed); bottom edge faces up (lit).
          gc.fillStyle = ENTRANCE_FRONT_GROOVE_TOP;
          gc.fillRect(0, top, FW, BV);
          gn.fillStyle = nrm(-s45, c45);
          gn.fillRect(0, top, FW, BV);
          gc.fillStyle = ENTRANCE_FRONT_METAL;
          gc.fillRect(0, top + SP - BV, FW, BV);
          gn.fillStyle = nrm(s45, c45);
          gn.fillRect(0, top + SP - BV, FW, BV);
        }
        const tex = (c: HTMLCanvasElement, srgb: boolean) => {
          const t = new THREE.CanvasTexture(c);
          if (srgb) t.colorSpace = THREE.SRGBColorSpace;
          t.wrapS = THREE.RepeatWrapping;
          t.wrapT = THREE.RepeatWrapping;
          t.magFilter = THREE.LinearFilter;
          // User saw moire (dashed stripes) at a distance. Cause: the strip was 4 px wide stretched over metres, so texels were ~100x wider than tall;
          // the GPU caps anisotropy at 16:1 and then picks the mip from the stretched axis, i.e. too sharp a level, and the thin stripes aliased.
          // Fix: U is tiled in metres (below) so texels are square in the world and the mip chain blurs the stripes evenly.
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.anisotropy = 16;
          return t;
        };
        const ftex = tex(cc, true);
        const fnrm = tex(nc, false);
        const fgeo = new THREE.BufferGeometry();
        fgeo.setAttribute("position", new THREE.Float32BufferAttribute(fronts.flatMap(([q]) => q.flat()), 3));
        // U in texture repeats such that one texel is as wide as it is tall: rowH metres = hpx texels vertically.
        const uOf = (q: number[][], n: number) => (Math.hypot(q[1][0] - q[0][0], q[1][2] - q[0][2]) / ((q[3][1] - q[0][1]) / n)) * (hpx / FW);
        fgeo.setAttribute("uv", new THREE.Float32BufferAttribute(fronts.flatMap(([q, n]) => { const u = uOf(q, n); return [0, 0, u, 0, u, n, 0, n]; }), 2));
        fgeo.setIndex(fronts.flatMap((_, j) => [0, 1, 2, 0, 2, 3].map((v) => v + 4 * j)));
        fgeo.computeVertexNormals();
        const fmat = new THREE.MeshStandardMaterial({ map: ftex, normalMap: fnrm, metalness: 0.28, roughness: 0.55, side: THREE.DoubleSide });
        out.set("prismFront", { mats: [fmat, fmat, fmat, fmat, fmat, fmat], tex: ftex, back: fnrm, y0: 0, geo: fgeo });
        // User: like the blue panel's thickness, the striped metal fronts get a raised outline along their top and bottom edges, standing
        // proud of the face toward the hall by the stripes' baked groove depth. Rails sit on the top and bottom edges (inset ENTRANCE_FRONT_RIM_INSET_M), and where a prism slope meets the box
        // front the rail turns the corner without a seam: edges at the same height are chained into one polyline and extruded with mitered joints.
        const rim: number[] = [];
        // User: the rail's side faces read as bright white next to the stripes. They now use the stripes' painted metal and the same normals the
        // stripe normal map bakes: top face = 45 degrees up-and-out, bottom = 45 degrees down-and-out, front and end caps = the face normal.
        const rimN: number[] = [];
        // User: the rail edge looked flat from below. Same convention as the stripe bake: down-facing faces carry the baked shadow tone.
        const rimC: number[] = [];
        // User: the rail front read as a white line (a gap) above the stripes: same albedo, but it rendered at 180 vs the stripes' 147 (8-bit, road-view
        // screenshot); why the two shade differently is not found. Scale calibrated in the browser so the rail renders at the stripes' tone.
        const lit = new THREE.Color(ENTRANCE_FRONT_METAL).multiplyScalar(0.62);
        const shade = new THREE.Color(ENTRANCE_FRONT_GROOVE_TOP);
        const levels = new Map<number, { y: number; segs: [number[], number[]][] }>();
        for (const [q] of fronts)
          for (const y of [q[0][1], q[3][1]]) {
            const k = Math.round(y * 1000);
            if (!levels.has(k)) levels.set(k, { y, segs: [] });
            levels.get(k)!.segs.push([[q[0][0], q[0][2]], [q[1][0], q[1][2]]]);
          }
        const same = (p: number[], r: number[]) => Math.hypot(p[0] - r[0], p[1] - r[1]) < 1e-3;
        const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], col = lit) => {
          rim.push(...a, ...b, ...c, ...a, ...c, ...d);
          for (let j = 0; j < 6; j++) rimN.push(...n), rimC.push(col.r, col.g, col.b);
        };
        for (const { y, segs } of levels.values()) {
          const left = [...segs];
          while (left.length) {
            const si = Math.max(0, left.findIndex((s) => !left.some((o) => o !== s && same(o[1], s[0]))));
            const [s0] = left.splice(si, 1);
            const pts = [s0[0], s0[1]];
            for (let j; (j = left.findIndex((s) => same(s[0], pts[pts.length - 1]))) >= 0; ) pts.push(left.splice(j, 1)[0][1]);
            // Hall-side unit normal of segment k (the hall is on the -z side of the wall line).
            const nrmOf = (k: number) => {
              const ex = pts[k + 1][0] - pts[k][0];
              const ez = pts[k + 1][1] - pts[k][1];
              const l = Math.hypot(ex, ez);
              return ex > 0 || (ex === 0 && ez < 0) ? [ez / l, -ex / l] : [-ez / l, ex / l];
            };
            // User: the rail stands proud only as far as the groove depth baked into the stripes' normal map (45-degree bevel BV px of an SP px stripe).
            // User: then "a very little deeper" than the groove depth.
            const d = (row / ENTRANCE_FRONT_STRIPES) * (BV / SP) * Math.tan(ENTRANCE_FRONT_GROOVE_TILT_RAD) * ENTRANCE_FRONT_RIM_DEPTH_SCALE;
            const outer = pts.map((p, k) => {
              const nA = nrmOf(Math.min(k, pts.length - 2));
              if (k === 0 || k === pts.length - 1) return [p[0] + nA[0] * d, p[1] + nA[1] * d];
              const nP = nrmOf(k - 1);
              const bx = nP[0] + nA[0];
              const bz = nP[1] + nA[1];
              const bl = Math.hypot(bx, bz);
              const cos = (bx * nA[0] + bz * nA[1]) / bl;
              return [p[0] + (bx / bl) * (d / cos), p[1] + (bz / bl) * (d / cos)];
            });
            // User: rails pushed inward onto the face (first sat on the edge inside, then centred on it): inset ENTRANCE_FRONT_RIM_INSET_M from the edge.
            const dir = y === Math.min(...fronts.flatMap(([q]) => (Math.abs(q[0][1] - y) < 1e-3 ? [q[0][1]] : []))) ? 1 : -1;
            const yc = y + dir * (ENTRANCE_FRONT_RIM_INSET_M + ENTRANCE_FRONT_RIM_H_M / 2);
            const y0 = yc - ENTRANCE_FRONT_RIM_H_M / 2;
            const y1 = yc + ENTRANCE_FRONT_RIM_H_M / 2;
            const v = (p: number[], yy: number) => [p[0], yy, p[1]];
            for (let k = 0; k < pts.length - 1; k++) {
              const [I0, I1, O0, O1] = [pts[k], pts[k + 1], outer[k], outer[k + 1]];
              const nk = nrmOf(k);
              const s45 = Math.SQRT1_2;
              // User: the rail still read flat (a horizontal 1.9 cm underside vanishes when seen from below). Its underside is now a 45-degree chamfer
              // from the face out to the rail front, the same bevel and shadow tone the stripe normal map bakes, so it shows as a dark band like the grooves.
              quad(v(O0, y0 + d), v(O1, y0 + d), v(O1, y1), v(O0, y1), [nk[0], 0, nk[1]]);
              quad(v(I1, y0), v(I0, y0), v(I0, y1), v(I1, y1), [-nk[0], 0, -nk[1]]);
              quad(v(I0, y1), v(O0, y1), v(O1, y1), v(I1, y1), [nk[0] * s45, s45, nk[1] * s45]);
              quad(v(I1, y0), v(O1, y0 + d), v(O0, y0 + d), v(I0, y0), [nk[0] * s45, -s45, nk[1] * s45], shade);
            }
            const n = pts.length - 1;
            // User: where a face's bottom edge meets the white underside, the underside ends in a strip of the metal face's colour so the two join
            // naturally. The strip runs from the rail front inward by the groove depth d under the solid, just below the white face (no z-fight),
            // and shades with the metal face's own normal so it reads as the same colour seen on the face.
            if (dir === 1) {
              // User: the strip was far deeper than the stripes' groove; it is exactly the groove depth d wide (k = 1), in darker grey.
              const flangeCol = new THREE.Color(ENTRANCE_FRONT_GROOVE_TOP);
              const k = 1;
              const inner = pts.map((p, j) => [p[0] - (outer[j][0] - p[0]) * k, p[1] - (outer[j][1] - p[1]) * k]);
              const yf = y0 - 0.002;
              for (let j = 0; j < pts.length - 1; j++) {
                const nj = nrmOf(j);
                quad(v(inner[j], yf), v(inner[j + 1], yf), v(outer[j + 1], yf), v(outer[j], yf), [nj[0], 0, nj[1]], flangeCol);
              }
            }
            const n0 = nrmOf(0);
            const nn = nrmOf(n - 1);
            quad(v(pts[0], y0), v(outer[0], y0 + d), v(outer[0], y1), v(pts[0], y1), [n0[0], 0, n0[1]]);
            quad(v(outer[n], y0 + d), v(pts[n], y0), v(pts[n], y1), v(outer[n], y1), [nn[0], 0, nn[1]]);
          }
        }
        // User (sketch): at the box's open end the striped sheet shows its cross-section: a metal strip in the end-face plane whose outer edge
        // follows the stripe profile baked in the normal map (crests stand proud by the groove depth, grooves step back in on 45-degree bevels).
        for (const e of frontEnds) {
          const g = (row / ENTRANCE_FRONT_STRIPES) * (BV / SP) * Math.tan(ENTRANCE_FRONT_GROOVE_TILT_RAD);
          const st = (e.yb - e.ya) / (e.n * ENTRANCE_FRONT_STRIPES);
          const bv = st * (BV / SP);
          // Profile as (y, outward offset) breakpoints from the bottom up; the hall is on the -z side of the face.
          const prof: [number, number][] = [];
          for (let k = 0; k < e.n * ENTRANCE_FRONT_STRIPES; k++) {
            const y = e.ya + k * st;
            if (k % 2 === 0) prof.push([y, g], [y + st, g]);
            else prof.push([y, g], [y + bv, 0], [y + st - bv, 0], [y + st, g]);
          }
          const nE = [e.sx, 0, 0];
          for (let j = 0; j < prof.length - 1; j++) {
            const [ya0, o0] = prof[j];
            const [ya1, o1] = prof[j + 1];
            if (ya1 - ya0 < 1e-6) continue;
            quad([e.x, ya0, e.z], [e.x, ya0, e.z - o0], [e.x, ya1, e.z - o1], [e.x, ya1, e.z], nE);
          }
        }
        const rgeo = new THREE.BufferGeometry();
        rgeo.setAttribute("position", new THREE.Float32BufferAttribute(rim, 3));
        rgeo.setAttribute("normal", new THREE.Float32BufferAttribute(rimN, 3));
        rgeo.setAttribute("color", new THREE.Float32BufferAttribute(rimC, 3));
        const rtex = new THREE.Texture();
        const rmat = new THREE.MeshStandardMaterial({ color: "#ffffff", vertexColors: true, metalness: 0.28, roughness: 0.55, side: THREE.DoubleSide });
        out.set("prismRim", { mats: [rmat, rmat, rmat, rmat, rmat, rmat], tex: rtex, back: rtex, y0: 0, geo: rgeo });
        // User: a banner hung from the ceiling on fishing line, a little in front (hall side) of the non-metal gap between the two prisms,
        // like the reference photo. Content is a placeholder AGF 2026 banner built from the app's own logo and dates; text and logo are one texture.
        {
          const zb = zf - ENTRANCE_PRISM_DEPTH_M;
          const yLo = cut + (Math.min(...ENTRANCE_PRISM_ROWS) + 1) * row;
          const yHi = cut + Math.max(...ENTRANCE_PRISM_ROWS) * row;
          const ph = (yHi - yLo) * POSTER_H_FRAC;
          const pw = Math.min(Math.abs(x0 - x1) - 2 * POSTER_SIDE_GAP_M, ph * POSTER_ASPECT);
          // User: "위치 더 1쪽으로", then "1을 가리진 말고 정확히 금속 꺾인점에서 멈춰야지": the near edge sits exactly at x0, where the prism
          // slope bends into the box front (the "1" panel starts there).
          const cx = x0 - Math.sign(x0 - x1) * (pw / 2);
          const cy = (yLo + yHi) / 2 - POSTER_DROP_M; // User: "조금 더 아래로 내려걸어야함".
          const pz = zb - POSTER_FORWARD_M;
          const PXW = 2048;
          const PXH = Math.round((PXW * ph) / pw);
          const c = Object.assign(document.createElement("canvas"), { width: PXW, height: PXH });
          const g = c.getContext("2d")!;
          const ptex = new THREE.CanvasTexture(c);
          ptex.colorSpace = THREE.SRGBColorSpace;
          ptex.anisotropy = 16;
          const draw = (logo?: HTMLImageElement) => {
            const bg = g.createLinearGradient(0, 0, PXW, PXH);
            bg.addColorStop(0, "#1b2a6b");
            bg.addColorStop(1, "#3a1f6e");
            g.fillStyle = bg;
            g.fillRect(0, 0, PXW, PXH);
            const pad = PXH * 0.12;
            let tx = pad;
            if (logo) {
              const lh = PXH - 2 * pad;
              const lw = (logo.width / logo.height) * lh;
              g.fillStyle = "#ffffff";
              g.fillRect(pad * 0.6, pad * 0.6, lw + pad * 0.8, lh + pad * 0.8);
              g.drawImage(logo, pad, pad, lw, lh);
              tx = pad * 2 + lw + pad * 0.6;
            }
            // Shrink the text block to fit beside the logo when the banner is narrow.
            const lines: [string, number, number][] = [["AGF 2026", 700, 0.26], ["2026.12.04 ~ 12.06", 600, 0.12], ["KINTEX 제1전시장 1-5홀", 500, 0.09]];
            const fit = Math.min(1, ...lines.map(([t, w, s]) => ((g.font = `${w} ${PXH * s}px sans-serif`), (PXW - tx - pad) / g.measureText(t).width)));
            g.fillStyle = "#ffffff";
            g.textBaseline = "alphabetic";
            g.font = `700 ${PXH * 0.26 * fit}px sans-serif`;
            g.fillText("AGF 2026", tx, PXH * 0.42);
            g.fillStyle = "#ffd84a";
            g.font = `600 ${PXH * 0.12 * fit}px sans-serif`;
            g.fillText("2026.12.04 ~ 12.06", tx, PXH * 0.64);
            g.fillStyle = "#dfe6ff";
            g.font = `500 ${PXH * 0.09 * fit}px sans-serif`;
            g.fillText("KINTEX 제1전시장 1-5홀", tx, PXH * 0.82);
            ptex.needsUpdate = true;
          };
          draw();
          const img = new Image();
          img.onload = () => draw(img);
          img.src = POSTER_LOGO_SRC;
          const pgeo = new THREE.BoxGeometry(pw, ph, POSTER_T_M);
          pgeo.translate(cx, cy, pz);
          const face = new THREE.MeshStandardMaterial({ map: ptex, roughness: 0.8, metalness: 0, side: THREE.FrontSide });
          const edge = new THREE.MeshStandardMaterial({ color: "#e8e8e8", roughness: 0.8, metalness: 0 });
          out.set("poster", { mats: [edge, edge, edge, edge, edge, face], tex: ptex, back: ptex, y0: 0, geo: pgeo });
          // Fishing line: two crossed thin quads per line so it shows from any side.
          const wp: number[] = [];
          const r = POSTER_LINE_W_M / 2;
          // User: lines at 27% and 73% (100-27%) of the banner width (was 8% / 92%, then 33% / 66%, then 30% / 70%).
          for (const wx of [0.27, 1 - 0.27].map((f) => cx - pw / 2 + pw * f)) {
            const yt = cy + ph / 2;
            for (const [dx, dz] of [[r, 0], [0, r]])
              wp.push(wx - dx, yt, pz - dz, wx + dx, yt, pz + dz, wx + dx, H, pz + dz, wx - dx, yt, pz - dz, wx + dx, H, pz + dz, wx - dx, H, pz - dz);
          }
          const wgeo = new THREE.BufferGeometry();
          wgeo.setAttribute("position", new THREE.Float32BufferAttribute(wp, 3));
          const wmat = new THREE.MeshBasicMaterial({ color: "#d8dde3", transparent: true, opacity: 0.55, side: THREE.DoubleSide });
          const wtex = new THREE.Texture();
          out.set("posterLine", { mats: [wmat, wmat, wmat, wmat, wmat, wmat], tex: wtex, back: wtex, y0: 0, geo: wgeo });
          // User: "돌돌 말리는 족자봉 느낌으로 위/아래 봉 끼워진 느낌": a rod through the top and bottom hems, each a little longer than the
          // banner and ending in a slightly fatter cap, like a hanging scroll.
          const parts: THREE.BufferGeometry[] = [];
          for (const ry of [cy + ph / 2, cy - ph / 2]) {
            const rod = new THREE.CylinderGeometry(POSTER_ROD_R_M, POSTER_ROD_R_M, pw + 2 * POSTER_ROD_OVERHANG_M, 24);
            rod.rotateZ(Math.PI / 2);
            rod.translate(cx, ry, pz);
            parts.push(rod);
            for (const sx of [-1, 1]) {
              const cap = new THREE.CylinderGeometry(POSTER_ROD_CAP_R_M, POSTER_ROD_CAP_R_M, POSTER_ROD_CAP_L_M, 24);
              cap.rotateZ(Math.PI / 2);
              cap.translate(cx + sx * (pw / 2 + POSTER_ROD_OVERHANG_M - POSTER_ROD_CAP_L_M / 2), ry, pz);
              parts.push(cap);
            }
          }
          const rp: number[] = [];
          const rn: number[] = [];
          for (const p of parts) {
            const q = p.toNonIndexed();
            rp.push(...(q.attributes.position.array as Float32Array));
            rn.push(...(q.attributes.normal.array as Float32Array));
            p.dispose();
            q.dispose();
          }
          const rgeo2 = new THREE.BufferGeometry();
          rgeo2.setAttribute("position", new THREE.Float32BufferAttribute(rp, 3));
          rgeo2.setAttribute("normal", new THREE.Float32BufferAttribute(rn, 3));
          const rodMat = new THREE.MeshStandardMaterial({ color: POSTER_ROD_COLOR, roughness: 0.45, metalness: 0 });
          const rodTex = new THREE.Texture();
          out.set("posterRod", { mats: [rodMat, rodMat, rodMat, rodMat, rodMat, rodMat], tex: rodTex, back: rodTex, y0: 0, geo: rgeo2 });
        }
      }


    }
    s.openings.forEach((o, i) => {
      if (TEXTURED_OPENINGS.has(i) && o.heightM !== undefined) add(`o${i}`, o.a, o.b, HEAD_EXT_M, o.heightM, H);
    });
    // User: on extended walls row 0 is filled with a copy of row 1 (rows are identical), so they start at the door height;
    // an extended opening keeps its hole and is headed only from row 1's bottom.
    const cut = Math.min(doorH, H);
    const headCut = cut + (H - cut) / WALL_TILE_ROWS;
    s.walls.forEach((w, i) => {
      if (EXTENDED_WALLS.has(i)) add(`w${i}u`, w.a, w.b, w.thicknessM, cut, w.heightM);
      // User: "walls[2]도 최하단에 패널 안들어간거 채우자": the band below the door height gets the same bake as walls[1]'s, on the same U.
      if (EXTENDED_WALLS.has(i)) add(`w${i}`, w.a, w.b, w.thicknessM, 0, cut);
    });
    s.openings.forEach((o, i) => {
      if (EXTENDED_OPENINGS.has(i)) add(`o${i}`, o.a, o.b, HEAD_EXT_M, Math.max(headCut, o.heightM ?? 0), H);
    });
    // User: "출입구쪽 뚜껑이랑 문 위에 벽 덮자": the exit bay behind openings[EXTENDED_OPENINGS] was open to the sky above the 3 m doors.
    // Lid: a slab over the bay (exit a..b, from the opening line to the back wall) with its underside at the opening head's bottom;
    // back wall: from the door top up to that slab, on the doors' line. Colour and slab thickness are placeholders.
    for (const e of s.exits ?? []) {
      const oi = s.openings.findIndex((o, i) => EXTENDED_OPENINGS.has(i) && near(o.a, e.b) && near(o.b, e.a)) ;
      const o = oi >= 0 ? s.openings[oi] : s.openings.find((q, i) => EXTENDED_OPENINGS.has(i) && ((near(q.a, e.a) && near(q.b, e.b)) || (near(q.a, e.b) && near(q.b, e.a))));
      if (!o || !e.doors.length) continue;
      const lidY = Math.max(headCut, o.heightM ?? 0);
      const xA = Math.min(e.a[0], e.b[0]) * m;
      const xB = Math.max(e.a[0], e.b[0]) * m;
      const zO = e.a[1] * m;
      const zD = e.doors[0].a[1] * m;
      const doorTop = Math.max(...s.walls.filter((w) => e.doors.some((d) => near(d.a, w.a) && near(d.b, w.b))).map((w) => w.heightM), 0);
      const sgn = Math.sign(zD - zO);
      const zBack = zD + sgn * e.back.thicknessM / 2;
      const boxes: THREE.BufferGeometry[] = [];
      // openings[1]'s head box spans zO ± HEAD_T_M/2 from lidY up, so a lid starting at zO shared its underside and fought it.
      // Start the lid 1 cm inside the head (front face hidden in it) and lift its underside 1 cm above the head's (3 mm still read as 0.00 m apart in the debug probe).
      const zL = zO + sgn * (HEAD_T_M / 2 - 0.01);
      const lid = new THREE.BoxGeometry(xB - xA, BAY_LID_T_M, Math.abs(zBack - zL));
      lid.translate((xA + xB) / 2, lidY + 0.01 + BAY_LID_T_M / 2, (zL + zBack) / 2);
      boxes.push(lid);
      if (doorTop > 0 && lidY > doorTop) {
        const wall = new THREE.BoxGeometry(xB - xA, lidY - doorTop, e.back.thicknessM);
        wall.translate((xA + xB) / 2, (lidY + doorTop) / 2, zD);
        boxes.push(wall);
      }
      const bp: number[] = [];
      const bn: number[] = [];
      for (const b of boxes) {
        const q = b.toNonIndexed();
        bp.push(...(q.attributes.position.array as Float32Array));
        bn.push(...(q.attributes.normal.array as Float32Array));
        b.dispose();
        q.dispose();
      }
      const bgeo = new THREE.BufferGeometry();
      bgeo.setAttribute("position", new THREE.Float32BufferAttribute(bp, 3));
      bgeo.setAttribute("normal", new THREE.Float32BufferAttribute(bn, 3));
      const bmat = new THREE.MeshStandardMaterial({ color: BAY_COVER_COLOR, roughness: 0.9 });
      const btex = new THREE.Texture();
      out.set("bayCover", { mats: [bmat, bmat, bmat, bmat, bmat, bmat], tex: btex, back: btex, y0: lidY, geo: bgeo });
    }
    return out;
  }, [s, m, mode, wallMat, roadWallMat]);
  useEffect(() => () => bake?.forEach((b) => (b.tex.dispose(), b.back.dispose(), b.mats[4].dispose(), b.mats[5].dispose())), [bake]);
  if (!s) return null;
  const drone = mode === "drone";
  const pieces: { key: string; r: Run; y0: number; y1: number; t: number; ref: string; ext?: number }[] = [];
  const doors: { i: number; r: Run; h: number; t: number; ref?: string }[] = [];
  const hallDoorH = s.walls.find((w) => w.side === "exit-door")?.heightM;
  if (!drone && hallDoorH)
    for (const [oi, o] of s.openings.entries())
      if (HALL_DOOR_OPENINGS.has(oi)) doors.push({ i: HALL_DOOR_IDX_BASE + oi, r: run(o.a, o.b, m), h: Math.min(hallDoorH, s.ceilingM), t: 0.4, ref: `structure.openings[${oi}]` });
  const near = (p: [number, number], q: [number, number]) => Math.abs(p[0] - q[0]) < 0.5 && Math.abs(p[1] - q[1]) < 0.5;
  const isExitDoor = (w: { a: [number, number]; b: [number, number] }) =>
    (s.exits ?? []).some((e) => e.doors.some((d) => (near(d.a, w.a) && near(d.b, w.b)) || (near(d.a, w.b) && near(d.b, w.a))));
  for (const [i, w] of s.walls.entries()) {
    if (bake?.has("chain") && CORNER_WALLS.includes(i)) continue;
    if (!drone && w.side === "exit-door" && isExitDoor(w)) {
      doors.push({ i, r: run(w.a, w.b, m), h: w.heightM, t: w.thicknessM });
      continue;
    }
    const up = drone ? undefined : bake?.get(`w${i}u`);
    if (up) {
      pieces.push({ key: `w${i}`, ref: `structure.walls[${i}]`, r: run(w.a, w.b, m), y0: 0, y1: up.y0, t: w.thicknessM });
      pieces.push({ key: `w${i}u`, ref: `structure.walls[${i}]`, r: run(w.a, w.b, m), y0: up.y0, y1: w.heightM, t: w.thicknessM });
      continue;
    }
    const seg = drone ? undefined : bake?.get(`w${i}`)?.seg;
    pieces.push({ key: w.side === "exit-door" ? `g${i}` : `w${i}`, ref: `structure.walls[${i}]`, r: seg ? run(seg[0], seg[1], m) : run(w.a, w.b, m), y0: 0, y1: drone ? Math.min(DRONE_WALL_M, w.heightM) : w.heightM, t: w.thicknessM });
  }
  // A door head only shows once walls rise above it (road view).
  if (!drone) {
    for (const [i, o] of s.openings.entries()) {
      const y0 = bake?.get(`o${i}`)?.y0 ?? o.heightM;
      if (y0 !== undefined) pieces.push({ key: `o${i}`, ref: `structure.openings[${i}]`, r: run(o.a, o.b, m), y0, y1: s.ceilingM, t: HEAD_T_M, ext: HEAD_EXT_M });
    }
  }
  return (
    <group>
      {bake?.get("prism")?.geo && (
        <mesh geometry={bake.get("prism")!.geo} material={bake.get("prism")!.mats[0]} {...debug({ what: "입구 직각삼각형 기둥 2개 + 직육면체 (합침)", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user sketch #5; depth, overrun and colour are placeholders" })} />
      )}
      {bake?.get("entrancePanel")?.geo && (
        <mesh geometry={bake.get("entrancePanel")!.geo} material={bake.get("entrancePanel")!.mats} {...debug({ what: "입구 직육면체 전면 정사각 평면 (x×x)", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user sketch #7; x = one ochre tile row; top under the upper prism" })} />
      )}
      {bake?.get("poster")?.geo && (
        <mesh geometry={bake.get("poster")!.geo} material={bake.get("poster")!.mats} {...debug({ what: "입구 천장에 매단 현수막 (AGF 2026)", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user request; content, size and position are placeholders" })} />
      )}
      {bake?.get("bayCover")?.geo && (
        <mesh geometry={bake.get("bayCover")!.geo} material={bake.get("bayCover")!.mats[0]} {...debug({ what: "출입구 안쪽 뚜껑 + 문 위 벽", source: "임의", ref: "structure.exits[0]", component: "Building.tsx", note: "user request; lid at the opening head's bottom, colour placeholder" })} />
      )}
      {bake?.get("posterRod")?.geo && (
        <mesh geometry={bake.get("posterRod")!.geo} material={bake.get("posterRod")!.mats[0]} {...debug({ what: "현수막 위·아래 족자봉", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user request; radius, overhang and colour are placeholders" })} />
      )}
      {bake?.get("posterLine")?.geo && (
        <mesh geometry={bake.get("posterLine")!.geo} material={bake.get("posterLine")!.mats[0]} {...debug({ what: "현수막 낚싯줄", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user request" })} />
      )}
      {bake?.get("prismRim")?.geo && (
        <mesh geometry={bake.get("prismRim")!.geo} material={bake.get("prismRim")!.mats[0]} {...debug({ what: "입구 메탈 줄무늬 면 상·하단 테두리 (돌출)", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user request; depth = stripe normal-map groove depth, rail height placeholder" })} />
      )}
      {bake?.get("prismFront")?.geo && (
        <mesh geometry={bake.get("prismFront")!.geo} material={bake.get("prismFront")!.mats[0]} {...debug({ what: "입구 직육면체·삼각기둥 전면 (메탈, row당 20줄 중 한 줄 걸러 음각 — 노멀맵)", source: "임의", ref: `structure.openings[${ENTRANCE_PRISM_OPENING}]`, component: "Building.tsx", note: "user request; stripe count ~20, colours and metalness are placeholders" })} />
      )}
      {bake?.get("shutter")?.runs?.map((r, k) => (
        <mesh key={`lintel${k}`} position={[r.cx, bake.get("shutter")!.y0 - (SHUTTER_LINTEL_SLATS * SHUTTER_SLAT_M) / 2, r.cz]} rotation={[0, r.angle, 0]} {...debug({ what: "화물출입구 셔터 상단 시멘트 인방", source: "임의", ref: `structure.openings[${[...SHUTTER_OPENINGS][k]}]`, component: "Building.tsx", note: "user: 셔터 줄무늬 3개 높이, 약간 돌출; overhang/colour placeholders" })}>
          <boxGeometry args={[r.len, SHUTTER_LINTEL_SLATS * SHUTTER_SLAT_M, 0.4 + 2 * SHUTTER_LINTEL_OUT_M]} />
          <meshStandardMaterial color={SHUTTER_LINTEL_GREY} roughness={0.95} />
        </mesh>
      ))}
      {bake?.get("shutter")?.runs?.map((r, k) => (
        <mesh key={`shutter${k}`} position={[r.cx, bake.get("shutter")!.y0 / 2, r.cz]} rotation={[0, r.angle, 0]} material={bake.get("shutter")!.mats[0]} {...debug({ what: "화물출입구 셔터", source: "임의", ref: `structure.openings[${[...SHUTTER_OPENINGS][k]}]`, component: "Building.tsx", note: "user: 황토 타일 아래에서 1칸까지; slat pitch/depth/colour placeholders" })}>
          <boxGeometry args={[r.len, bake.get("shutter")!.y0, SHUTTER_T_M]} />
        </mesh>
      ))}
      {bake?.get("chain")?.geo && (
        <mesh geometry={bake.get("chain")!.geo} material={bake.get("chain")!.mats} {...debug({ what: "홀1 끝 벽 (walls[59..67] 병합)", source: "CAD", ref: "structure.walls[59..67]", component: "Building.tsx", note: "one mitered mesh so the corners neither overlap nor flicker; texture baked" })} />
      )}
      {pieces.map(({ key, r, y0, y1, t, ref, ext }) => (
        <mesh
          key={key}
          geometry={box}
          material={bake?.get(key)?.mats ?? (key.startsWith("g") ? gapMat : drone || CAD_ONLY ? wallMat : roadWallMat)}
          position={[r.cx, (y0 + y1) / 2, r.cz]}
          rotation={[0, r.angle, 0]}
          scale={[r.len + (ext ?? t), y1 - y0, t]}
          {...(bake?.has(key)
            ? debug({ what: "로비 벽 (패널 줄눈 베이크)", source: "임의", ref, component: "Building.tsx", note: "pattern from user photo + 5 rows / top 10 sub-rows; texture baked into wall face; above the band 5 rows of ochre tile" })
            : key.startsWith("o")
            ? debug({ what: "출입구 상단 벽", source: "CAD", ref, component: "Building.tsx", note: "thickness 0.4 m and top = ceilingM are 임의" })
            : key.startsWith("g")
              ? debug({ what: "출구 틈 채움 (반투명, 문 아님)", source: "임의", ref, component: "Building.tsx", note: "CAD: 5-방화삿터 at this gap; kept semi-transparent by user; wall above from openings heightM 3" })
              : debug({ what: "외벽", source: "CAD", ref, component: "Building.tsx" }))}
        />
      ))}
      {doors.map(({ i, r, h, t, ref: dref = `structure.walls[${i}]` }) => {
        const leafLen = r.len / 2 - DOOR_SEAM_M / 2;
        const lz = DOOR_SWING_SIDE * (Math.cos(r.angle) > 0 ? 1 : -1);
        return (
          <group key={`d${i}`} position={[r.cx, h / 2, r.cz]} rotation={[0, r.angle, 0]}>
            {([-1, 1] as const).map((side) => {
              const lr = side < 0 ? "좌" : "우";
              const innerW = leafLen - 2 * DOOR_STILE_W_M;
              const panelH = (h - (DOOR_PANELS + 1) * DOOR_RAIL_H_M) / DOOR_PANELS;
              const pitch = DOOR_RAIL_H_M + panelH;
              const note = "only outline groove recessed per user report; sizes 임의";
              const hinge = debug({ what: "도어 상부 힌지 (본체+짧은 링크)", source: "임의", ref: dref, component: "Building.tsx", note: "from user sketch #3; sizes 임의" });
              const yk = h / 2 + HINGE_BASE_T_M + HINGE_KNOB_H_M / 2;
              const frame = debug({ what: `양문형 도어 (${lr}) 프레임`, source: "임의", ref: dref, component: "Building.tsx", note });
              return (
                <group key={side}>
                <SwingPivot i={i} sign={side * lz} position={[(side * r.len) / 2, 0, 0]}>
                  <group position={[(-side * r.len) / 4, 0, 0]}>
                  {([-1, 1] as const).map((e) => (
                    <mesh
                      key={`s${e}`}
                      geometry={box}
                      material={doorMat}
                      position={[e * (leafLen - DOOR_STILE_W_M) / 2, 0, 0]}
                      scale={[DOOR_STILE_W_M, h, t]}
                      {...frame}
                    />
                  ))}
                  {Array.from({ length: DOOR_PANELS + 1 }, (_, k) => (
                    <mesh
                      key={`r${k}`}
                      geometry={box}
                      material={doorMat}
                      position={[0, h / 2 - DOOR_RAIL_H_M / 2 - k * pitch, 0]}
                      scale={[innerW, DOOR_RAIL_H_M, t]}
                      {...frame}
                    />
                  ))}
                  {Array.from({ length: DOOR_PANELS }, (_, k) => {
                    const cy = h / 2 - DOOR_RAIL_H_M - panelH / 2 - k * pitch;
                    return (
                      <group key={`p${k}`} position={[0, cy, 0]}>
                        <mesh
                          geometry={box}
                          material={grooveMat}
                          scale={[innerW, panelH, t - 2 * GROOVE_D_M]}
                          {...debug({ what: "양문형 도어 ㅁ 홈", source: "임의", ref: dref, component: "Building.tsx", note })}
                        />
                        <mesh
                          geometry={box}
                          material={doorMat}
                          scale={[innerW - 2 * GROOVE_W_M, panelH - 2 * GROOVE_W_M, t]}
                          {...debug({ what: `양문형 도어 (${lr}) 패널 ${k + 1}/${DOOR_PANELS}`, source: "임의", ref: dref, component: "Building.tsx", note })}
                        />
                      </group>
                    );
                  })}
                    <mesh geometry={box} material={doorSeamMat} position={[(-side * leafLen) / 2, 0, 0]} scale={[DOOR_SEAM_M / 2, h, t * 1.05]} />
                  </group>
                  {/* Hinge body on the leaf top (turns with it) and the link's moving knob. */}
                  <mesh
                    geometry={box}
                    material={handleMat}
                    position={[-side * (HINGE_BODY_GAP_M + HINGE_BODY_LEN_M / 2), h / 2 + HINGE_BASE_T_M + 0.004 + HINGE_BODY_H_M / 2, lz * (t / 2 - HINGE_BODY_D_M / 2)]}
                    scale={[HINGE_BODY_LEN_M, HINGE_BODY_H_M, HINGE_BODY_D_M]}
                    {...hinge}
                  />
                  <mesh
                    geometry={cyl}
                    material={handleMat}
                    position={[-side * HINGE_BODY_GAP_M, yk, lz * (t / 2 - HINGE_BODY_D_M / 2)]}
                    scale={[HINGE_KNOB_D_M, HINGE_KNOB_H_M, HINGE_KNOB_D_M]}
                    {...hinge}
                  />
                </SwingPivot>
                <mesh
                  geometry={box}
                  material={handleMat}
                  position={[(side * r.len) / 2 - side * (HINGE_BASE_LEN_M / 2 - HINGE_BASE_OVER_M), h / 2 + HINGE_BASE_T_M / 2, lz * (t / 2 - HINGE_BODY_D_M + HINGE_BASE_D_M / 2)]}
                  scale={[HINGE_BASE_LEN_M, HINGE_BASE_T_M, HINGE_BASE_D_M]}
                  {...hinge}
                />
                <HingeLink i={i} side={side} lz={lz} axisX={(side * r.len) / 2} t={t} h={h} tag={hinge} mat={handleMat} box={box} cyl={cyl} />
                </group>
              );
            })}
          </group>
        );
      })}
      {/* Road view bakes the partition tracks into the floor texture: a 2 cm box on the floor plane lost the depth
          test to the polygon-offset floor beyond a view-dependent distance, so the line came and went while walking. */}
      {drone && s.partitions.map((p, i) => {
        const r = run(p.a, p.b, m);
        return (
          <mesh
            key={`p${i}`}
            geometry={box}
            material={seamMat}
            position={[r.cx, 0.01, r.cz]}
            rotation={[0, r.angle, 0]}
            scale={[r.len, 0.02, PARTITION_W_M]}
            {...debug({ what: "칸막이 이음선 (드론용)", source: "CAD", ref: `structure.partitions[${i}]`, component: "Building.tsx" })}
          />
        );
      })}
    </group>
  );
};

const WALL_PANEL_M = 1.2;
const WALL_COURSE_M = 3;
const SKIRT_M = 1;

/**
 * Road-view wall finish: light-grey cladding panels with thin joints and a dark 1 m skirting band, drawn
 * in world metres by the shader so every wall run (one stretched unit box each) gets the same panel size.
 * Panels run along each mesh's own x axis (the run direction), so angled runs get joints too.
 */
const makeRoadWallMaterial = () => {
  const mat = new THREE.MeshStandardMaterial({ color: "#c3c7cd", roughness: 0.85 });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWallPos;\nvarying float vWallAlong;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vWallPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWallAlong = dot(vWallPos.xz, normalize(modelMatrix[0].xz));`,
      );
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vWallPos;\nvarying float vWallAlong;").replace(
      "#include <color_fragment>",
      `#include <color_fragment>
      {
        float along = vWallAlong;
        float fw = max(fwidth(along), 1e-4);
        float u = abs(fract(along / ${WALL_PANEL_M.toFixed(2)} + 0.5) - 0.5) * ${WALL_PANEL_M.toFixed(2)};
        float v = abs(fract(vWallPos.y / ${WALL_COURSE_M.toFixed(2)} + 0.5) - 0.5) * ${WALL_COURSE_M.toFixed(2)};
        float joint = max(1.0 - smoothstep(0.01, 0.01 + fw, u), 1.0 - smoothstep(0.01, 0.01 + fwidth(vWallPos.y), v));
        diffuseColor.rgb *= 1.0 - 0.28 * joint;
        if (vWallPos.y < ${SKIRT_M.toFixed(2)}) diffuseColor.rgb = vec3(0.13, 0.14, 0.15);
      }`,
    );
  };
  return mat;
};
