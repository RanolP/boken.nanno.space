import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { MapData } from "../maps/types";
import { debug, type DebugTag } from "./DebugInspector";
import { useHallEnvMapAt } from "./Environment";
import type { ViewMode } from "./walk";

interface Props {
  data: MapData;
  mode: ViewMode;
}

/** Service-band room walls and lift shafts: the drawing gives no height for them, so this is a stand-in storey. */
const BAND_WALL_M = 4.5;
const INNER_WALL_T_M = 0.1;
const GLAZING_TOP_M = 3.2;
/** Fire shutter boxes sit above the door head; the drawing gives neither height, so these are stand-ins too. */
const SHUTTER_Y_M: [number, number] = [3.6, 4.0];
const HANDRAIL_Y_M: [number, number] = [0.85, 0.9];

type Seg = { a: [number, number]; b: [number, number] };
type Box = [number, number, number, number];
/** One instance: centre x/z, size along x/z, vertical span, yaw. */
type Piece = { cx: number; cz: number; sx: number; sz: number; y0: number; y1: number; angle: number };

const fromBox = (r: Box, m: number, y0: number, y1: number): Piece => ({
  cx: ((r[0] + r[2]) / 2) * m,
  cz: ((r[1] + r[3]) / 2) * m,
  sx: Math.max((r[2] - r[0]) * m, 0.02),
  sz: Math.max((r[3] - r[1]) * m, 0.02),
  y0,
  y1,
  angle: 0,
});

const fromSeg = (s: Seg, m: number, t: number, y0: number, y1: number): Piece => {
  const dx = (s.b[0] - s.a[0]) * m;
  const dz = (s.b[1] - s.a[1]) * m;
  return { cx: ((s.a[0] + s.b[0]) / 2) * m, cz: ((s.a[1] + s.b[1]) / 2) * m, sx: Math.hypot(dx, dz), sz: t, y0, y1, angle: -Math.atan2(dz, dx) };
};

const instanced = (geometry: THREE.BufferGeometry, material: THREE.Material, pieces: Piece[], tag: DebugTag) => {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(pieces.length, 1));
  Object.assign(mesh.userData, debug(tag).userData);
  mesh.count = pieces.length;
  // Scenery: clicks pass through to the booths, and 2000+ instances stay out of every pointer raycast.
  mesh.raycast = () => {};
  const mat = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  for (const [i, p] of pieces.entries()) {
    mat.compose(new THREE.Vector3(p.cx, (p.y0 + p.y1) / 2, p.cz), q.setFromAxisAngle(up, p.angle), new THREE.Vector3(p.sx, p.y1 - p.y0, p.sz));
    mesh.setMatrixAt(i, mat);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  return mesh;
};

/**
 * Road-view interior from `data.structure.details` (KINTEX CAD): columns, the lobby-side service band
 * (room walls, stairs, lift shafts, glazing, fire shutters, handrails). The hall floor's trench
 * covers and expansion joints are baked into the floor texture rather than modelled: thin boxes on the floor plane lost
 * the depth test to the polygon-offset floor at a view-dependent distance and flickered in and out while walking.
 * Drone view shows none of it, so its top-down view stays the official plan.
 * One instanced mesh per element type, built once per map.
 */
export const BuildingDetails = ({ data, mode }: Props) => {
  const d = data.structure?.details;
  const ceiling = data.structure?.ceilingM ?? 15;
  const m = data.metersPerPx;
  // The lobby-side band runs past every hall; its instanced metal takes the probe of the hall at the building centre.
  const envMap = useHallEnvMapAt((data.source.widthPx * m) / 2);
  const group = useMemo(() => {
    const g = new THREE.Group();
    if (!d) return g;
    const box = new THREE.BoxGeometry(1, 1, 1);
    const cyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 20);
    const std = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...extra });
    const metal = (color: string, metalness: number, roughness = 0.8) => std(color, { metalness, roughness, envMap });
    // `path` is the data.structure.details list; `idx` maps an instance back to its index in it when the list was filtered.
    const add = (geometry: THREE.BufferGeometry, material: THREE.Material, pieces: Piece[], what: string, path: string, note?: string, idx?: number[]) => {
      if (pieces.length)
        g.add(instanced(geometry, material, pieces, { what, source: "CAD", ref: ({ instanceId }) => `structure.details.${path}[${instanceId === undefined ? "?" : (idx?.[instanceId] ?? instanceId)}]`, component: "BuildingDetails.tsx", note }));
    };
    const indexed = <T,>(list: T[], keep: (x: T) => boolean) => {
      const idx = list.flatMap((x, i) => (keep(x) ? [i] : []));
      return { items: idx.map((i) => list[i]), idx };
    };
    const sq = indexed(d.columns, (c) => !c.round);
    const rd = indexed(d.columns, (c) => !!c.round);
    add(box, std("#b8bdc4"), sq.items.map((c) => fromBox(c.r, m, 0, ceiling)), "기둥", "columns", undefined, sq.idx);
    add(cyl, std("#b8bdc4"), rd.items.map((c) => fromBox(c.r, m, 0, ceiling)), "기둥 (원형)", "columns", undefined, rd.idx);
    add(box, std("#e4e4e4"), d.innerWalls.map((s) => fromSeg(s, m, INNER_WALL_T_M, 0, BAND_WALL_M)), "실내 벽 (서비스 구역)", "innerWalls", "height 4.5 m, thickness 0.1 m are 임의");
    add(box, std("#8e939a"), d.stairs.map((r) => fromBox(r, m, 0, 0.02)), "계단 바닥면", "stairs", "0.02 m slab is 임의");
    add(box, std("#a7abb1"), d.stairSteps.map((t) => fromBox(t.r, m, 0, t.topM)), "계단", "stairSteps");
    add(box, metal("#7b828a", 0.6, 0.4), d.elevators.map((r) => fromBox(r, m, 0, BAND_WALL_M)), "엘리베이터", "elevators", "height 4.5 m is 임의");
    const glass = new THREE.MeshStandardMaterial({ color: "#a9cfe0", transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.1, envMap, depthWrite: false });
    add(box, glass, d.glazing.map((s) => fromSeg(s, m, 0.03, 0, GLAZING_TOP_M)), "유리벽", "glazing", "height 3.2 m, thickness 0.03 m are 임의");
    add(box, metal("#5b6168", 0.5, 0.4), d.mullions.map((r) => fromBox(r, m, 0, GLAZING_TOP_M)), "멀리언 (유리 프레임)", "mullions", "height 3.2 m is 임의");
    // User: "소화전 전부 hide" — details.hydrants stay in the data but are not drawn.
    add(box, metal("#696e75", 0.4), d.shutters.map((s) => fromSeg(s, m, 0.3, ...SHUTTER_Y_M)), "셔터", "shutters", "y 3.6-4.0 m, depth 0.3 m are 임의");
    add(box, metal("#454a50", 0.6, 0.35), d.handrails.map((s) => fromSeg(s, m, 0.05, ...HANDRAIL_Y_M)), "난간", "handrails", "y 0.85-0.9 m is 임의");
    return g;
  }, [d, m, ceiling, envMap]);
  useEffect(
    () => () => {
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      group.traverse((o) => {
        if (o instanceof THREE.InstancedMesh) {
          geometries.add(o.geometry);
          materials.add(o.material as THREE.Material);
          o.dispose();
        }
      });
      for (const x of geometries) x.dispose();
      for (const x of materials) x.dispose();
    },
    [group],
  );
  if (mode !== "road") return null;
  return <primitive object={group} />;
};
