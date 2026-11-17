import { AREA_KINDS, type MapData, type MapMeta } from "./types";
import agf2026 from "./agf-2026/map.json";
import { meta as agf2026Meta } from "./agf-2026/meta";
import agf2026Structure from "./agf-2026/structure.json";
import { parseStructure } from "./structure";

export type MapEntry = { id: string; data: MapData; meta: MapMeta };

/** Checks the fields JSON import widens: area kind (to `string`) and polygon points (to `number[]`), plus marker rects. */
const parseMap = (json: unknown): MapData => {
  const data = json as MapData;
  for (const a of data.areas) {
    if (!(AREA_KINDS as readonly string[]).includes(a.kind)) {
      throw new Error(`map "${data.id}": area "${a.id}" has unknown kind "${a.kind}"`);
    }
    if (a.color !== undefined && !/^#[0-9a-f]{6}$/i.test(a.color)) {
      throw new Error(`map "${data.id}": area "${a.id}" color "${a.color}" must be #rrggbb`);
    }
    if (a.polygon && (a.polygon.length < 3 || a.polygon.some((p) => p.length !== 2))) {
      throw new Error(`map "${data.id}": area "${a.id}" polygon needs 3+ [x, y] points`);
    }
  }
  for (const [i, mk] of (data.markers ?? []).entries()) {
    if (typeof mk.icon !== "string" || !mk.icon.startsWith("/")) {
      throw new Error(`map "${data.id}": marker ${i} icon must be a public path starting with "/"`);
    }
    if (![mk.x, mk.y, mk.w, mk.h].every(Number.isFinite) || mk.w <= 0 || mk.h <= 0) {
      throw new Error(`map "${data.id}": marker ${i} (${mk.icon}) needs finite x, y and positive w, h`);
    }
  }
  if (data.structure) parseStructure(data.id, data.structure);
  return data;
};

// To add a map: create src/maps/<id>/{map.json,meta.ts} (optionally structure.json) and list it here.
export const maps: MapEntry[] = [
  { id: "agf-2026", data: parseMap({ ...agf2026, structure: agf2026Structure }), meta: agf2026Meta },
];

export const findMap = (id: string): MapEntry | undefined => maps.find((m) => m.id === id);
