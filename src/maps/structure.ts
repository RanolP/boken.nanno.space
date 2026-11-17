/** Fixed hall shell extracted from venue CAD drawings; points in the map's source px, heights in meters. */
export type Structure = {
  source: { drawing: string; url: string };
  /** How the CAD drawing was fitted onto the plan image, and how well. */
  fit: { method: string; metersPerPx: number; residualsM: number[]; rmsM: number };
  ceilingM: number;
  /** Solid wall runs along the hall perimeter. */
  walls: { a: [number, number]; b: [number, number]; side: string; heightM: number; thicknessM: number }[];
  /** Passable gaps in the perimeter; `heightM` is the door head when the drawing set gives one, else open to the ceiling. */
  openings: { a: [number, number]; b: [number, number]; side: string; kind: "entrance" | "dock" | "door"; widthM: number; heightM?: number }[];
  /** Hall dividers; "movable" ones are retracted when halls are combined. */
  partitions: { a: [number, number]; b: [number, number]; kind: "movable" }[];
  /** Inner wall-face outline of the whole hall floor as one closed ring (not a rectangle: KINTEX 1 has notches at the lobby-side ends of Hall 1 and Hall 5). */
  outline?: [number, number][];
  /** Each hall's floor polygon: `outline` cut at the cross partitions. */
  halls?: { id: string; polygon: [number, number][] }[];
  /** Interior elements from the same drawing, clipped to the plan image; absent for venues without them. */
  details?: StructureDetails;
  /**
   * Hall exits on the lobby face, one recessed bay per hall. `a`-`b` is the bay's mouth on the hall face; its
   * back wall stands `back.depthM` behind it and holds the (closed) double doors `doors`, drawn on the back
   * wall's hall-side face. `pillars` are the stone-clad columns flanking the bay, `canopy` the footprint of
   * the steel box projecting over it into the hall. The doors and pillars are also in `walls` (sides
   * "exit-door" / "exit-pillar") so the walker collides with them.
   */
  exits?: HallExit[];
};

export type HallExit = {
  hall: number;
  a: [number, number];
  b: [number, number];
  back: { depthM: number; thicknessM: number };
  doors: Seg[];
  pillars: Box[];
  canopy?: [number, number][];
};

type Seg = { a: [number, number]; b: [number, number] };
/** Axis-aligned footprint [x0, y0, x1, y1] in source px. */
type Box = [number, number, number, number];

export type StructureDetails = {
  /** Wall-line and service-band columns; solid from floor to ceiling. */
  columns: { r: Box; round: boolean }[];
  /** One drawn face of a service-band room wall (each wall is drawn as two faces). */
  innerWalls: Seg[];
  /** Stair flight footprints, and the step boxes of the flights that rise from this floor (`topM` = tread height). */
  stairs: Box[];
  stairSteps: { r: Box; topM: number }[];
  /** Lift shaft footprints. */
  elevators: Box[];
  /** Floor utility trench covers, and trench edges drawn as single lines. */
  trenches: Box[];
  trenchLines: Seg[];
  /** Floor expansion joints. */
  joints: Seg[];
  /** Glass panes and window lines; `mullions` are the curtain-wall posts. */
  glazing: Seg[];
  mullions: Box[];
  /** Fire hydrant cabinets. */
  hydrants: Box[];
  /** Fire shutter lines across openings. */
  shutters: Seg[];
  handrails: Seg[];
  /** Room names drawn on the plan (1-TEXT). */
  rooms: { at: [number, number]; text: string }[];
};

const isBox = (b: unknown) => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];

const OPENING_KINDS = ["entrance", "dock", "door"];

const isPoint = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

/** Checks what JSON import widens: point tuples (to `number[]`), opening kind (to `string`) and positive heights. */
export const parseStructure = (mapId: string, json: unknown): Structure => {
  const s = json as Structure;
  const fail = (what: string) => {
    throw new Error(`map "${mapId}": structure ${what}`);
  };
  if (!(s.ceilingM > 0)) fail("ceilingM must be positive");
  for (const [i, w] of s.walls.entries()) {
    if (!isPoint(w.a) || !isPoint(w.b)) fail(`wall ${i} needs [x, y] points a and b`);
    if (!(w.heightM > 0) || !(w.thicknessM > 0)) fail(`wall ${i} needs positive heightM and thicknessM`);
  }
  for (const [i, o] of s.openings.entries()) {
    if (!isPoint(o.a) || !isPoint(o.b)) fail(`opening ${i} needs [x, y] points a and b`);
    if (!OPENING_KINDS.includes(o.kind)) fail(`opening ${i} has unknown kind "${o.kind}"`);
    if (o.heightM !== undefined && !(o.heightM > 0)) fail(`opening ${i} heightM must be positive`);
  }
  for (const [i, p] of s.partitions.entries()) {
    if (!isPoint(p.a) || !isPoint(p.b)) fail(`partition ${i} needs [x, y] points a and b`);
  }
  if (s.outline && !(s.outline.length >= 3 && s.outline.every(isPoint))) fail("outline needs 3+ [x, y] points");
  for (const [i, h] of (s.halls ?? []).entries()) {
    if (!h.id || !(h.polygon.length >= 3 && h.polygon.every(isPoint))) fail(`hall ${i} needs an id and 3+ [x, y] polygon points`);
  }
  for (const [i, e] of (s.exits ?? []).entries()) {
    if (!isPoint(e.a) || !isPoint(e.b) || !(e.back?.depthM > 0) || !(e.back.thicknessM > 0)) fail(`exit ${i} needs points a, b and a positive back depth and thickness`);
    if (!e.doors.every((g) => isPoint(g.a) && isPoint(g.b)) || !e.pillars.every(isBox)) fail(`exit ${i} has a malformed door or pillar`);
    if (e.canopy && !(e.canopy.length >= 3 && e.canopy.every(isPoint))) fail(`exit ${i} canopy needs 3+ [x, y] points`);
  }
  const d = s.details;
  if (d) {
    const boxes = { columns: d.columns.map((c) => c.r), stairs: d.stairs, stairSteps: d.stairSteps.map((t) => t.r), elevators: d.elevators, trenches: d.trenches, mullions: d.mullions, hydrants: d.hydrants };
    for (const [k, list] of Object.entries(boxes)) {
      for (const [i, b] of list.entries()) if (!isBox(b)) fail(`details.${k} ${i} needs [x0, y0, x1, y1]`);
    }
    const segs = { innerWalls: d.innerWalls, trenchLines: d.trenchLines, joints: d.joints, glazing: d.glazing, shutters: d.shutters, handrails: d.handrails };
    for (const [k, list] of Object.entries(segs)) {
      for (const [i, g] of list.entries()) if (!isPoint(g.a) || !isPoint(g.b)) fail(`details.${k} ${i} needs [x, y] points a and b`);
    }
  }
  return s;
};
