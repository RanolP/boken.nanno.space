import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { MapData } from "../maps/types";
import { type HallRect, useHallProbes } from "./Environment";
import { debug } from "./DebugInspector";
import type { Decal } from "./Scene";
import { CEILING_TILE_M, makeCeilingTexture, makeFloorTexture } from "./textures";

interface Props {
  data: MapData;
  /** The plan's floor-level marks (frame, hall labels, floor markings), baked into the photo floor's own maps. */
  decals: Decal[];
}

/** Bottom-chord bay of the space frame; matches the ceiling texture tile so trusses land on its grid. */
const TRUSS_BAY_M = CEILING_TILE_M;
const TRUSS_DEPTH_M = 2.4;
const TRUSS_W_M = 0.5;
/** Light fixtures hang just under the trusses, on a half-bay grid between them. */
const LIGHT_PITCH_M = TRUSS_BAY_M / 2;
const LIGHT_SIZE_M: [number, number, number] = [1.6, 0.25, 0.6];
/** Seen through the openings beyond the walls: a soft overcast grey rather than the drone view's paper white. */
const ROAD_BACKGROUND = "#a9aeb5";

/** Off while the user reviews the hall surface by surface: no photo bake, no procedural canvas, flat colours only. */
const TEXTURES = false;
/** Road view shows only what the KINTEX CAD drawing has: no invented trusses, light fixtures or wall cladding. */
export const CAD_ONLY = true;
const PLAIN_FLOOR = "#c4c4c4";
const PLAIN_CEILING = "#8a8f96";
const PARTITION_TRACK_W_M = 0.3;
/** The bake draws these as one pixel at its 0.08 m floor resolution. */
const FLOOR_LINE_W_M = 0.08;
const FLOOR_DETAIL_Y_M = 0.007;
const FLOOR_DETAIL_H_M = 0.006;
/** User: trench covers are painted, black outline + pale sky-blue fill. Outline width is a placeholder. */
const TRENCH_OUTLINE_M = 0.05;
const TRENCH_FILL_LIFT_M = 0.002;

/**
 * Road-view hall interior: polished-concrete floor over the plan's white floor, and the 15 m space-frame
 * ceiling with rows of lights. Drone view never mounts it, so the top view stays the plan's exact white.
 */
export const HallInterior = ({ data, decals }: Props) => {
  const m = data.metersPerPx;
  const W = data.source.widthPx * m;
  const D = data.source.heightPx * m;
  const s = data.structure;
  const gl = useThree((st) => st.gl);
  const scene = useThree((st) => st.scene);
  const aniso = gl.capabilities.getMaxAnisotropy();

  // Building footprint in metres: the CAD inner-face outline (KINTEX 1 is notched at the lobby-side ends of halls 1
  // and 5), else the axis-aligned extent of the perimeter runs. `rect` is its bounding box.
  const rect = useMemo(() => {
    if (!s) return null;
    const pts = s.outline ?? [...s.walls, ...s.openings].flatMap((w) => [w.a, w.b]);
    const xs = pts.map((p) => p[0] * m);
    const zs = pts.map((p) => p[1] * m);
    const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
    const poly: Poly = s.outline
      ? s.outline.map(([x, z]) => [x * m, z * m])
      : [
          [x0, z0],
          [x1, z0],
          [x1, z1],
          [x0, z1],
        ];
    return { x0, x1, z0, z1, h: s.ceilingM, poly };
  }, [s, m]);
  const ceilingGeo = useMemo(
    () => rect && polyGeo(rect.poly, rect.h, [rect.x0, rect.z0, rect.x1, rect.z1], -1, (z, fz0, fz1) => (z - fz0) / (fz1 - fz0)),
    [rect],
  );
  useEffect(() => () => ceilingGeo?.dispose(), [ceilingGeo]);

  const floor = useMemo(() => {
    if (!TEXTURES) return { tex: null, mat: new THREE.MeshStandardMaterial({ color: PLAIN_FLOOR, roughness: 1, metalness: 0 }) };
    const tex = makeFloorTexture(W, D, aniso);
    // Same canvas as roughness: joints and dark flecks read a touch glossier, pale mottling a touch duller.
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughnessMap: tex, roughness: 1.15, metalness: 0 });
    return { tex, mat };
  }, [W, D, aniso]);

  const ceiling = useMemo(() => {
    if (!rect) return null;
    if (!TEXTURES) return { tex: null, mat: new THREE.MeshStandardMaterial({ color: PLAIN_CEILING, roughness: 0.9, metalness: 0.2 }) };
    const tex = makeCeilingTexture(rect.x1 - rect.x0, rect.z1 - rect.z0, aniso);
    // FrontSide only: the plane faces down, so it is invisible from above.
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.2 });
    return { tex, mat };
  }, [rect, aniso]);

  const parts = useMemo(
    () => ({
      box: new THREE.BoxGeometry(1, 1, 1),
      trussMat: new THREE.MeshStandardMaterial({ color: "#5d626a", roughness: 0.7, metalness: 0.4 }),
      // Unlit and untone-mapped so the fixtures read as light sources without adding real lights.
      lightMat: new THREE.MeshBasicMaterial({ color: "#fffaf0", toneMapped: false }),
    }),
    [],
  );

  useEffect(
    () => () => {
      floor.tex?.dispose();
      floor.mat.dispose();
    },
    [floor],
  );
  useEffect(
    () => () => {
      ceiling?.tex?.dispose();
      ceiling?.mat.dispose();
    },
    [ceiling],
  );
  useEffect(
    () => () => {
      parts.box.dispose();
      parts.trussMat.dispose();
      parts.lightMat.dispose();
    },
    [parts],
  );

  const manifest = usePhotoManifest(data.id);
  const photo = TEXTURES ? manifest : null;

  useEffect(() => {
    const prev = scene.background;
    scene.background = new THREE.Color(ROAD_BACKGROUND);
    return () => {
      scene.background = prev;
    };
  }, [scene]);

  return (
    <group>
      {/* With baked photos the floor is the manifest's single plane (trenches, joints and seams baked in). */}
      {!photo && (
        <>
          <mesh rotation-x={-Math.PI / 2} position={[W / 2, 0, D / 2]} material={floor.mat} raycast={() => null} {...debug({ what: "바닥", source: "임의", ref: "plain colour; extent = plan size (data.source)", component: "HallInterior.tsx" })}>
            <planeGeometry args={[W, D]} />
          </mesh>
          <CadFloorFeatures data={data} />
        </>
      )}
      {rect && ceiling && ceilingGeo && (
        <>
          <mesh geometry={ceilingGeo} material={ceiling.mat} raycast={() => null} {...debug({ what: "천장", source: "CAD", ref: "structure.outline + ceilingM", component: "HallInterior.tsx", note: "colour is 임의" })} />
          {/* The baked photos already show the real space frame and lights; instanced ones would double them. */}
          {!photo && !CAD_ONLY && <Trusses rect={rect} box={parts.box} mat={parts.trussMat} />}
          {!photo && !CAD_ONLY && <Fixtures rect={rect} box={parts.box} mat={parts.lightMat} />}
        </>
      )}
      {photo && (
        <PhotoSurfaces
          base={`/maps/${data.id}/textures/`}
          manifest={photo}
          aniso={aniso}
          footprint={rect?.poly ?? null}
          decals={decals}
          metersPerPx={m}
        />
      )}
    </group>
  );
};

type Rect = { x0: number; x1: number; z0: number; z1: number; h: number; poly: Poly };
/** A floor-plan ring in metres, `[x, z]` per vertex. */
type Poly = [number, number][];

/** Even-odd point-in-polygon on the floor plan. */
const inPoly =(x: number, z: number, poly: Poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[j];
    if (az > z !== bz > z && x < ax + ((z - az) * (bx - ax)) / (bz - az)) inside = !inside;
  }
  return inside;
};

/** The [min, max] of where the line `axis = value` crosses the ring (x for axis 0, z for axis 1), or null. */
const spanAt = (poly: Poly, axis: 0 | 1, value: number): [number, number] | null => {
  const o = 1 - axis;
  const hits: number[] = [];
  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length];
    if (a[axis] > value !== b[axis] > value) hits.push(a[o] + ((value - a[axis]) * (b[o] - a[o])) / (b[axis] - a[axis]));
  });
  return hits.length ? [Math.min(...hits), Math.max(...hits)] : null;
};

/**
 * Flat polygon at height y, triangulated, with UVs = world position over `full` `[x0, z0, x1, z1]` (u along x,
 * `vOf(z)` along z), wound to face up (+1) or down (-1).
 */
const polyGeo = (poly: Poly, y: number, full: HallRect, facing: 1 | -1, vOf: (z: number, fz0: number, fz1: number) => number) => {
  const [fx0, fz0, fx1, fz1] = full;
  const ring = poly.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(ring, []);
  const index: number[] = [];
  for (const [a, b, c] of tris) {
    // y of (b - a) x (c - a) in (x, y, z): positive faces up.
    const up = (ring[b].y - ring[a].y) * (ring[c].x - ring[a].x) - (ring[b].x - ring[a].x) * (ring[c].y - ring[a].y);
    index.push(...(Math.sign(up) === facing ? [a, b, c] : [a, c, b]));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(poly.flatMap(([x, z]) => [x, y, z]), 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(poly.flatMap(([x, z]) => [(x - fx0) / (fx1 - fx0), vOf(z, fz0, fz1)]), 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
};

/**
 * Notches of a footprint: for each ring vertex strictly inside its bounding box (a reflex corner), the rect from it
 * to the nearest box corner, `[x0, z0, x1, z1]`. Holds for axis-aligned rings with one-corner notches, as KINTEX 1.
 */
const notchesOf = (poly: Poly): HallRect[] => {
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const eps = 1e-3;
  return poly
    .filter(([x, z]) => x > x0 + eps && x < x1 - eps && z > z0 + eps && z < z1 - eps)
    .map(([x, z]) => {
      const cx = x - x0 < x1 - x ? x0 : x1;
      const cz = z - z0 < z1 - z ? z0 : z1;
      return [Math.min(x, cx), Math.min(z, cz), Math.max(x, cx), Math.max(z, cz)];
    });
};

/**
 * The rect `[x0, z0, x1, z1]` minus each notch that reaches its x0 or x1 edge, as one ring: a floor strip that stops
 * at a notch room's walls. A notch not touching either side edge is left in (not a shape this venue has).
 */
const rectMinusNotches = ([x0, z0, x1, z1]: HallRect, notches: HallRect[]): Poly => {
  // Walk west edge north-to-south, then the east edge south-to-north, detouring round any notch on that edge.
  const west: Poly = [[x0, z1]];
  const east: Poly = [[x1, z0]];
  for (const [nx0, nz0, nx1, nz1] of notches) {
    if (nx0 <= x0 + 1e-3 && nx1 < x1) west.push([x0, nz1], [nx1, nz1], [nx1, nz0], [x0, nz0]);
    else if (nx1 >= x1 - 1e-3 && nx0 > x0) east.push([x1, nz0], [nx0, nz0], [nx0, nz1], [x1, nz1]);
  }
  return [...west, [x0, z0], ...east, [x1, z1]];
};

interface InstancedProps {
  rect: Rect;
  box: THREE.BoxGeometry;
  mat: THREE.Material;
}

/** Fills an InstancedMesh once from a list of [position, scale]; nothing runs per frame. */
type InstanceTransform = [THREE.Vector3, THREE.Vector3, THREE.Quaternion?];

const useInstances = (ref: React.RefObject<THREE.InstancedMesh | null>, items: InstanceTransform[]) => {
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const mtx = new THREE.Matrix4();
    const identity = new THREE.Quaternion();
    items.forEach(([p, sc, q], i) => mesh.setMatrixAt(i, mtx.compose(p, q ?? identity, sc)));
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [ref, items]);
};

type FloorInstance = { transform: InstanceTransform; index: number; x: number };
type FloorFeatureProps = {
  box: THREE.BoxGeometry;
  items: FloorInstance[];
  what: string;
  path: string;
  color: string;
  roughness: number;
  metalness: number;
  envMap?: THREE.Texture | null;
};

const FloorFeatureInstances = ({ box, items, what, path, color, roughness, metalness, envMap = null }: FloorFeatureProps) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const transforms = useMemo(() => items.map((item) => item.transform), [items]);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ color, roughness, metalness, envMap }), [color, roughness, metalness, envMap]);
  useInstances(ref, transforms);
  useEffect(() => () => material.dispose(), [material]);
  return (
    <instancedMesh
      ref={ref}
      args={[box, material, items.length]}
      raycast={() => null}
      {...debug({
        what,
        source: "CAD",
        ref: ({ instanceId }) => `${path}[${instanceId === undefined ? "?" : (items[instanceId]?.index ?? "?")}]`,
        component: "HallInterior.tsx",
      })}
    />
  );
};

const floorBox = (r: [number, number, number, number], index: number, m: number): FloorInstance => {
  const x = ((r[0] + r[2]) / 2) * m;
  return {
    index,
    x,
    transform: [
      new THREE.Vector3(x, FLOOR_DETAIL_Y_M, ((r[1] + r[3]) / 2) * m),
      new THREE.Vector3(Math.max((r[2] - r[0]) * m, FLOOR_LINE_W_M), FLOOR_DETAIL_H_M, Math.max((r[3] - r[1]) * m, FLOOR_LINE_W_M)),
    ],
  };
};

const floorSegment = (segment: { a: [number, number]; b: [number, number] }, index: number, m: number, width: number): FloorInstance => {
  const dx = (segment.b[0] - segment.a[0]) * m;
  const dz = (segment.b[1] - segment.a[1]) * m;
  const x = ((segment.a[0] + segment.b[0]) / 2) * m;
  return {
    index,
    x,
    transform: [
      new THREE.Vector3(x, FLOOR_DETAIL_Y_M, ((segment.a[1] + segment.b[1]) / 2) * m),
      new THREE.Vector3(Math.hypot(dx, dz), FLOOR_DETAIL_H_M, width),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(dz, dx)),
    ],
  };
};

const CadFloorFeatures = ({ data }: Pick<Props, "data">) => {
  const structure = data.structure;
  const details = structure?.details;
  const m = data.metersPerPx;
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const halls = useMemo(
    () =>
      (structure?.halls ?? []).map((hall) => {
        const polygon = hall.polygon.map(([x, z]): [number, number] => [x * m, z * m]);
        const xs = polygon.map(([x]) => x);
        const zs = polygon.map(([, z]) => z);
        return { id: hall.id, polygon, rect: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] as HallRect };
      }),
    [structure, m],
  );
  const { probes, capture } = useHallProbes(halls);
  const features = useMemo(() => {
    const trenches = (details?.trenches ?? []).map((r, i) => floorBox(r, i, m));
    // User: trench covers are black-paint outline + pale sky-blue paint fill. Fill = cover inset by the outline width, raised to clear the outline's top.
    const trenchFills = (details?.trenches ?? []).map((r, i) => {
      const o = TRENCH_OUTLINE_M / m;
      const f = floorBox([r[0] + o, r[1] + o, r[2] - o, r[3] - o], i, m);
      f.transform[0].y += TRENCH_FILL_LIFT_M;
      return f;
    });
    const partitions = (structure?.partitions ?? []).map((segment, i) => floorSegment(segment, i, m, PARTITION_TRACK_W_M));
    const trenchLines = (details?.trenchLines ?? []).map((segment, i) => floorSegment(segment, i, m, FLOOR_LINE_W_M));
    const joints = (details?.joints ?? []).map((segment, i) => floorSegment(segment, i, m, FLOOR_LINE_W_M));
    return { trenches, trenchFills, partitions, trenchLines, joints };
  }, [structure, details, m]);
  const metalGroups = useMemo(() => {
    const groups = probes.map((probe) => ({ id: probe.id, envMap: probe.envMap, trenches: [] as FloorInstance[], partitions: [] as FloorInstance[] }));
    if (!groups.length) return [{ id: "all", envMap: null, trenches: features.trenches, partitions: features.partitions }];
    const add = (key: "trenches" | "partitions", item: FloorInstance) => {
      const group = groups.reduce((nearest, candidate) => {
        const distance = (g: (typeof groups)[number]) => {
          const probe = probes.find((p) => p.id === g.id);
          return probe ? Math.max(probe.rect[0] - item.x, item.x - probe.rect[2], 0) : Infinity;
        };
        return distance(candidate) < distance(nearest) ? candidate : nearest;
      });
      group[key].push(item);
    };
    features.trenches.forEach((item) => add("trenches", item));
    features.partitions.forEach((item) => add("partitions", item));
    return groups;
  }, [features, probes]);
  useEffect(() => () => box.dispose(), [box]);
  useEffect(() => {
    if (details) capture();
  }, [details, capture]);
  if (!structure || !details) return null;
  return (
    <group>
      {metalGroups.map((group) => (
        <group key={group.id}>
          {group.trenches.length > 0 && <FloorFeatureInstances box={box} items={group.trenches} what="트렌치 덮개 외곽선 (검은 페인트)" path="structure.details.trenches" color="#141414" roughness={0.8} metalness={0} />}
          {group.partitions.length > 0 && <FloorFeatureInstances box={box} items={group.partitions} what="칸막이 레일" path="structure.partitions" color="rgb(95, 100, 107)" roughness={0.5} metalness={0.5} envMap={group.envMap} />}
        </group>
      ))}
      {features.trenchFills.length > 0 && <FloorFeatureInstances box={box} items={features.trenchFills} what="트렌치 덮개 (옅은 하늘 페인트)" path="structure.details.trenches" color="#cfe2f0" roughness={0.8} metalness={0} />}
      {features.trenchLines.length > 0 && <FloorFeatureInstances box={box} items={features.trenchLines} what="트렌치 선" path="structure.details.trenchLines" color="rgb(74, 72, 70)" roughness={0.6} metalness={0} />}
      {features.joints.length > 0 && <FloorFeatureInstances box={box} items={features.joints} what="줄눈" path="structure.details.joints" color="rgb(74, 72, 70)" roughness={0.6} metalness={0} />}
    </group>
  );
};

/** Primary trusses spanning north-south every bay, plus lighter east-west ties at the bay lines. */
const Trusses = ({ rect, box, mat }: InstancedProps) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const items = useMemo(() => {
    const out: [THREE.Vector3, THREE.Vector3][] = [];
    const depth = rect.z1 - rect.z0;
    const width = rect.x1 - rect.x0;
    // Each truss spans only the footprint at its line, so none crosses a notch room.
    for (let x = rect.x0 + TRUSS_BAY_M; x < rect.x1; x += TRUSS_BAY_M) {
      const [za, zb] = spanAt(rect.poly, 0, x) ?? [rect.z0, rect.z0 + depth];
      out.push([new THREE.Vector3(x, rect.h - TRUSS_DEPTH_M / 2, (za + zb) / 2), new THREE.Vector3(TRUSS_W_M, TRUSS_DEPTH_M, zb - za)]);
    }
    for (let z = rect.z0 + TRUSS_BAY_M; z < rect.z1; z += TRUSS_BAY_M) {
      const [xa, xb] = spanAt(rect.poly, 1, z) ?? [rect.x0, rect.x0 + width];
      out.push([new THREE.Vector3((xa + xb) / 2, rect.h - 0.4, z), new THREE.Vector3(xb - xa, 0.8, 0.3)]);
    }
    return out;
  }, [rect]);
  useInstances(ref, items);
  return <instancedMesh ref={ref} args={[box, mat, items.length]} raycast={() => null} {...debug({ what: "트러스", source: "임의", ref: ({ instanceId }) => `truss #${instanceId}`, component: "HallInterior.tsx (Trusses)" })} />;
};

type PhotoSurface = {
  id: string;
  kind: "floor" | "ceiling" | "wall";
  file: string;
  /** Floor only: packed occlusion/roughness/metalness (R/G/B, three.js convention) from the CAD layers. */
  ormFile?: string;
  rect?: HallRect;
  /** Ceilings: the hall's floor polygon in metres (`rect` is its bounds and the UV frame); the mesh is cut to it. */
  polygon?: Poly;
  y?: number;
  p0?: [number, number];
  p1?: [number, number];
  height?: number;
};
type PhotoManifest = { surfaces: PhotoSurface[] };

/** Baked photo textures from `npm run textures:kintex`; null when the map has none (the procedural surfaces stay). */
const usePhotoManifest = (mapId: string) => {
  const [manifest, setManifest] = useState<PhotoManifest | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/maps/${mapId}/textures/manifest.json`)
      .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? r.json() : null))
      .then((j: PhotoManifest | null) => live && setManifest(j))
      .catch(() => live && setManifest(null));
    return () => {
      live = false;
    };
  }, [mapId]);
  return manifest;
};

/** Distance the wall faces sit inside the CAD wall line: half the 0.4 m wall box plus a hair, so they win the depth test. */
const WALL_INSET_M = 0.21;

type PhotoItem = { id: string; kind: PhotoSurface["kind"]; geo: THREE.BufferGeometry; mat: THREE.Material };

/** Quad over `[x0, z0, x1, z1]` at height y, with UVs = its world position over `full` (v = 1 at full's z0). */
const rectQuad = ([x0, z0, x1, z1]: HallRect, y: number, full: HallRect) => {
  const [fx0, fz0, fx1, fz1] = full;
  const u = (x: number) => (x - fx0) / (fx1 - fx0);
  // The bake writes row 0 at z0 and three.js flips rows on upload.
  const v = (z: number) => 1 - (z - fz0) / (fz1 - fz0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([u(x0), v(z1), u(x1), v(z1), u(x1), v(z0), u(x0), v(z0)], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  return geo;
};

/**
 * One textured quad per baked surface, mapped by world position over the surface's rect (no tiling): each texel is
 * the photo sample for exactly that spot, so the view from a calibrated photo's pose reproduces the photo.
 *
 * The floor is one texture over the whole building but is cut into one mesh per hall (UVs still over the full rect,
 * so the strips meet without a seam), each reflecting its own hall's probe. The probes are captured once the photo
 * textures have loaded and their meshes are in the scene, and again only when the manifest's textures change.
 */
const PhotoSurfaces = ({
  base,
  manifest,
  aniso,
  footprint,
  decals,
  metersPerPx,
}: {
  base: string;
  manifest: PhotoManifest;
  aniso: number;
  footprint: Poly | null;
  decals: Decal[];
  metersPerPx: number;
}) => {
  const halls = useMemo(
    () =>
      manifest.surfaces
        .filter((s) => s.kind === "ceiling" && s.rect)
        .map((s) => ({ id: s.id.replace(/-ceiling$/, ""), rect: s.rect!, polygon: s.polygon }))
        .sort((a, b) => a.rect[0] - b.rect[0]),
    [manifest],
  );
  const { probes, capture } = useHallProbes(halls);

  // Every photo texture, keyed by file; null until all have settled.
  const [textures, setTextures] = useState<Map<string, THREE.Texture> | null>(null);
  useEffect(() => {
    let live = true;
    const loader = new THREE.TextureLoader();
    const files = [...new Set(manifest.surfaces.flatMap((s) => (s.ormFile ? [s.file, s.ormFile] : [s.file])))];
    const loaded: THREE.Texture[] = [];
    Promise.allSettled(files.map((f) => loader.loadAsync(base + f))).then((results) => {
      const map = new Map<string, THREE.Texture>();
      results.forEach((r, i) => {
        if (r.status === "rejected") return console.warn(`hall photo texture failed to load: ${base + files[i]}`, r.reason);
        const tex = r.value;
        const isOrm = manifest.surfaces.some((s) => s.ormFile === files[i]);
        tex.colorSpace = isOrm ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        tex.anisotropy = aniso;
        tex.generateMipmaps = true;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        loaded.push(tex);
        map.set(files[i], tex);
      });
      if (live) setTextures(map);
      else for (const t of loaded) t.dispose();
    });
    return () => {
      live = false;
      for (const t of loaded) t.dispose();
      setTextures(null);
    };
  }, [base, manifest, aniso]);

  // The floor's albedo and ORM with the plan's floor marks painted in, composited once per load (see bakeFloorDecals).
  const floorMaps = useMemo(() => {
    const s = manifest.surfaces.find((f) => f.ormFile && f.rect);
    const map = s && textures?.get(s.file);
    const orm = s?.ormFile ? textures?.get(s.ormFile) : undefined;
    if (!s || !map || !orm || decals.length === 0) return null;
    return bakeFloorDecals(map, orm, s.rect!, decals, metersPerPx, aniso);
  }, [manifest, textures, decals, metersPerPx, aniso]);
  useEffect(
    () => () => {
      floorMaps?.map.dispose();
      floorMaps?.orm.dispose();
    },
    [floorMaps],
  );

  const items = useMemo<PhotoItem[]>(() => {
    if (!textures) return [];
    const floors = manifest.surfaces.filter((s) => s.rect);
    const cx = floors.reduce((a, s) => a + (s.rect![0] + s.rect![2]) / 2, 0) / floors.length;
    const cz = floors.reduce((a, s) => a + (s.rect![1] + s.rect![3]) / 2, 0) / floors.length;
    // Notch rooms of the footprint; one touching the building's west or east side runs out past the floor's edge, so
    // a floor strip stops at the notch walls instead of running under the room.
    const fxs = footprint?.map((p) => p[0]) ?? [];
    const notches = (footprint ? notchesOf(footprint) : []).map(([x0, z0, x1, z1]): HallRect => [
      x0 <= Math.min(...fxs) + 1e-3 ? -Infinity : x0,
      z0,
      x1 >= Math.max(...fxs) - 1e-3 ? Infinity : x1,
      z1,
    ]);
    const vOf = (z: number, fz0: number, fz1: number) => 1 - (z - fz0) / (fz1 - fz0);
    return manifest.surfaces.flatMap((s): PhotoItem[] => {
      const loaded = textures.get(s.file);
      if (!loaded) return [];
      const baked = s.ormFile && s.rect ? floorMaps : null;
      const tex = baked?.map ?? loaded;
      const orm = baked?.orm ?? (s.ormFile ? textures.get(s.ormFile) : undefined);
      if (s.ormFile && s.rect) {
        // Floor: plain PBR. The bake de-lights the photo into albedo; roughness (G) and metalness (B) come from the
        // CAD steel covers and seams. One strip per hall (the outermost halls take the floor rect's margins).
        const full = s.rect;
        const strips = probes.length ? probes : [{ id: "all", rect: full, envMap: null }];
        return strips.map((p, i) => {
          const sx0 = i === 0 ? full[0] : p.rect[0];
          const sx1 = i === strips.length - 1 ? full[2] : strips[i + 1].rect[0];
          const mat = new THREE.MeshStandardMaterial({
            map: tex,
            roughnessMap: orm ?? null,
            metalnessMap: orm ?? null,
            roughness: 1,
            metalness: orm ? 1 : 0,
            envMap: p.envMap,
          });
          const strip: HallRect = [sx0, full[1], sx1, full[3]];
          const geo = notches.length ? polyGeo(rectMinusNotches(strip, notches), s.y ?? 0, full, 1, vOf) : rectQuad(strip, s.y ?? 0, full);
          return { id: `${s.id}-${p.id}`, kind: s.kind, geo, mat };
        });
      }
      // Unlit: walls and ceilings are only looked at, so the photo's own lighting stays baked in.
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
      // The ceiling sits on the CAD ceiling height, where the building's roof may also be.
      mat.polygonOffset = true;
      mat.polygonOffsetFactor = -4;
      mat.polygonOffsetUnits = -4;
      if (s.rect) {
        const geo = s.polygon ? polyGeo(s.polygon, s.y ?? 0, s.rect, -1, vOf) : rectQuad(s.rect, s.y ?? 0, s.rect);
        return [{ id: s.id, kind: s.kind, geo, mat }];
      }
      const [ax, az] = s.p0!;
      const [bx, bz] = s.p1!;
      const len = Math.hypot(bx - ax, bz - az);
      let nx = -(bz - az) / len;
      let nz = (bx - ax) / len;
      // Inset toward the inside: the wall's own hall polygon when the manifest has one (a notch face points away
      // from the building centre), else the centre of the surfaces.
      const own = halls.find((h) => s.id.startsWith(`${h.id}-`))?.polygon;
      const [mx, mz] = [(ax + bx) / 2, (az + bz) / 2];
      const inward = own ? inPoly(mx + nx * 0.5, mz + nz * 0.5, own) : (cx - mx) * nx + (cz - mz) * nz >= 0;
      if (!inward) [nx, nz] = [-nx, -nz];
      const [ox, oz] = [nx * WALL_INSET_M, nz * WALL_INSET_M];
      const h = s.height ?? 15;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute([ax + ox, 0, az + oz, bx + ox, 0, bz + oz, bx + ox, h, bz + oz, ax + ox, h, az + oz], 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      return [{ id: s.id, kind: s.kind, geo, mat }];
    });
  }, [manifest, textures, floorMaps, probes, halls, footprint]);
  useEffect(
    () => () => {
      for (const it of items) {
        it.geo.dispose();
        it.mat.dispose();
      }
    },
    [items],
  );

  // Runs after the commit that put the loaded surfaces in the scene: the probes see the finished halls.
  useEffect(() => {
    if (items.length) capture();
  }, [items, capture]);

  return (
    <group>
      {items.map((it) => (
        <mesh key={it.id} geometry={it.geo} material={it.mat} raycast={() => null} {...debug({ what: `${PHOTO_KO[it.kind]} (사진 베이크)`, source: "CAD", ref: `manifest.surfaces ${it.id}`, component: "HallInterior.tsx (PhotoSurfaces)" })} />
      ))}
    </group>
  );
};

const PHOTO_KO: Record<PhotoSurface["kind"], string> = { floor: "바닥", ceiling: "천장", wall: "벽" };

/** Matte floor paint: roughness 0.8 (ORM green 204 under the material's roughness 1), occlusion 1, metalness 0. */
const PAINT_ORM = "rgb(255, 204, 0)";

/**
 * The photo floor's albedo and ORM with the plan's floor marks painted in, one canvas each at the bake's own
 * resolution (manifest metersPerTexel), so every hall strip shows them through its existing UVs and nothing is
 * layered on the floor. The ORM gets matte, non-metallic paint wherever a mark covers the floor (by its alpha), so a
 * mark over a steel trench cover does not stay mirror-like.
 */
const bakeFloorDecals = (map: THREE.Texture, orm: THREE.Texture, [fx0, fz0, fx1, fz1]: HallRect, decals: Decal[], m: number, aniso: number) => {
  const src = map.image as HTMLImageElement;
  const ormSrc = orm.image as HTMLImageElement;
  const W = src.width;
  const H = src.height;
  // Plan px -> texel: x_t = (x * m - fx0) * W / (fx1 - fx0); row 0 is z = fz0 (the bake's layout, flipped on upload).
  const kx = W / (fx1 - fx0);
  const kz = H / (fz1 - fz0);
  const canvas = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
    draw(c.getContext("2d")!);
    return c;
  };
  const paint = (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.setTransform(m * kx, 0, 0, m * kz, -fx0 * kx, -fz0 * kz);
    for (const d of decals) d.draw(ctx, d.x, d.y, 1);
    ctx.restore();
  };
  const albedo = canvas((ctx) => {
    ctx.drawImage(src, 0, 0, W, H);
    paint(ctx);
  });
  // Coverage of every mark, recoloured to the paint's ORM, then laid over the baked ORM.
  const mask = canvas((ctx) => {
    paint(ctx);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = PAINT_ORM;
    ctx.fillRect(0, 0, W, H);
  });
  const ormCanvas = canvas((ctx) => {
    ctx.drawImage(ormSrc, 0, 0, W, H);
    ctx.drawImage(mask, 0, 0);
  });
  const wrap = (c: HTMLCanvasElement, colorSpace: THREE.ColorSpace) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = colorSpace;
    t.anisotropy = aniso;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  };
  return { map: wrap(albedo, THREE.SRGBColorSpace), orm: wrap(ormCanvas, THREE.NoColorSpace) };
};

/** Rows of high-bay fixtures between the trusses. */
const Fixtures = ({ rect, box, mat }: InstancedProps) => {
  const ref = useRef<THREE.InstancedMesh>(null);
  const items = useMemo(() => {
    const out: [THREE.Vector3, THREE.Vector3][] = [];
    const y = rect.h - TRUSS_DEPTH_M - 0.3;
    const size = new THREE.Vector3(...LIGHT_SIZE_M);
    for (let x = rect.x0 + LIGHT_PITCH_M; x < rect.x1; x += TRUSS_BAY_M) {
      for (let z = rect.z0 + LIGHT_PITCH_M / 2; z < rect.z1; z += LIGHT_PITCH_M) {
        if (inPoly(x, z, rect.poly)) out.push([new THREE.Vector3(x, y, z), size]);
      }
    }
    return out;
  }, [rect]);
  useInstances(ref, items);
  return <instancedMesh ref={ref} args={[box, mat, items.length]} raycast={() => null} {...debug({ what: "조명", source: "임의", ref: ({ instanceId }) => `fixture #${instanceId}`, component: "HallInterior.tsx (Fixtures)" })} />;
};
