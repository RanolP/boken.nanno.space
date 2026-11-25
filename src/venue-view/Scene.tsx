import { useEffect, useMemo, useState, type RefObject } from "react";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { stageKey, stageOfArea, type AreaKind, type MapData } from "../maps/types";
import { DroneRig, RoadRig } from "./CameraRigs";
import { Building } from "./Building";
import { BuildingDetails } from "./BuildingDetails";
import { HallInterior } from "./HallInterior";
import { Booths, FONT, buildAtlas, useLabelFont, type Tile } from "./BoothFrame";
import { DebugProbe, debug } from "./DebugInspector";
import { inkOn, type Ink } from "./contrast";
import type { MoveInput, Pose, ViewMode } from "./walk";

type Booth = MapData["booths"][number];
type Area = MapData["areas"][number];
type Marker = NonNullable<MapData["markers"]>[number];
/** Loaded plan image per public path; null until every one has loaded or failed, so each texture is drawn once. */
type Images = Map<string, HTMLImageElement>;

interface Props {
  data: MapData;
  booths: Booth[];
  selected: string | null;
  flyKey: number;
  view: ViewMode;
  input: MoveInput;
  /** Camera position on the floor, shared by both rigs (and the road-view minimap) so a view switch keeps the spot. */
  pose: RefObject<Pose | null>;
  onSelect: (code: string | null) => void;
}

interface AreasProps {
  data: MapData;
  images: Images | null;
  fontReady: boolean;
  onSelect: (code: string | null) => void;
}

interface AreaMeshProps {
  area: Area;
  m: number;
  markers: Marker[];
  images: Images | null;
  fontReady: boolean;
  onSelect: (code: string | null) => void;
}

interface FloorProps {
  data: MapData;
  decals: Decal[];
  visible: boolean;
}

export const Scene = ({ data, booths, selected, flyKey, view, input, pose, onSelect }: Props) => {
  const W = data.source.widthPx * data.metersPerPx;
  const D = data.source.heightPx * data.metersPerPx;
  // Keyed on data.markers itself: a fresh [] each render would reload every image.
  const urls = useMemo(() => [...new Set((data.markers ?? []).map((mk) => mk.icon))], [data.markers]);
  const images = usePlanImages(urls);
  const fontReady = useLabelFont();
  const decals = useMemo(() => floorDecals(data, images, fontReady), [data, images, fontReady]);
  return (
    <Canvas
      className="canvas"
      camera={{ fov: 45, near: 0.5, far: 3000 }}
      aria-label="3D 지도 / 3D map"
      onPointerMissed={() => onSelect(null)}
    >
      <color attach="background" args={["#eef1f5"]} />
      <ambientLight intensity={1.1} />
      <directionalLight position={[W / 2 + 80, 200, D / 2 + 60]} intensity={1.6} />
      {/*
        Drone only: road view's floor is HallInterior's, and a coplanar second plane z-fights it. The same decals
        (frame, hall labels, floor markings) are composited into that floor's own texture instead.
      */}
      <Floor data={data} decals={decals} visible={view !== "road"} />
      <Building data={data} mode={view} />
      <BuildingDetails data={data} mode={view} />
      {view === "road" && <HallInterior data={data} decals={decals} />}
      <Areas data={data} images={images} fontReady={fontReady} onSelect={onSelect} />
      <Booths data={data} booths={booths} selected={selected} view={view} onSelect={onSelect} />
      {view === "road" && <DebugProbe />}
      {view === "drone" ? (
        <DroneRig data={data} flyKey={flyKey} selected={selected} input={input} pose={pose} />
      ) : (
        <RoadRig data={data} booths={booths} flyKey={flyKey} selected={selected} input={input} pose={pose} onSelect={onSelect} />
      )}
    </Canvas>
  );
};

/* ---------------------------------------------------------------- areas ---------------------------------------------------------------- */

/**
 * Raised areas (stage, seating, rooms): one mesh each, whose top samples one canvas where the fill, the plan images
 * on it and its label were composited in 2D. Areas with height 0 are drawn into the floor instead (see Floor).
 */
const Areas = ({ data, images, fontReady, onSelect }: AreasProps) => {
  const m = data.metersPerPx;
  // Per area, the markers on it; memoised so each area's texture is drawn once, not on every Scene render.
  const onArea = useMemo(() => {
    const owner = markerOwners(data);
    return data.areas.map((_, i) => (data.markers ?? []).filter((_, j) => owner[j] === i));
  }, [data]);
  return (
    <>
      {data.areas.map((a, i) =>
        AREA_STYLE[a.kind].h > 0 ? (
          <AreaMesh
            key={a.id}
            area={a}
            m={m}
            markers={onArea[i]}
            images={images}
            fontReady={fontReady}
            onSelect={onSelect}
          />
        ) : null,
      )}
    </>
  );
};

const AreaMesh = ({ area: a, m, markers, images, fontReady, onSelect }: AreaMeshProps) => {
  const s = AREA_STYLE[a.kind];
  const fill = a.color ?? s.color;
  const geom = useMemo(() => {
    if (!a.polygon) return new THREE.BoxGeometry(a.w * m, s.h, a.h * m);
    // Shape drawn in XY with y = -py so the -90deg X rotation lands each point at world z = +py (no mirroring)
    // and the extrusion depth points up.
    const shape = new THREE.Shape(a.polygon.map(([x, y]) => new THREE.Vector2(x * m, -y * m)));
    return new THREE.ExtrudeGeometry(shape, { depth: s.h, bevelEnabled: false });
  }, [a, m, s.h]);
  useEffect(() => () => geom.dispose(), [geom]);

  const gl = useThree((st) => st.gl);
  const tex = useMemo(() => {
    const canvas = areaCanvas(a, m, fill, markers, images, fontReady);
    if (!canvas) return null;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = gl.capabilities.getMaxAnisotropy();
    if (a.polygon) {
      // Extrude caps carry their shape coordinates as uv: u = x*m, v = -y*m. Map them onto the bbox canvas
      // (flipY: v = 1 is the canvas top, plan y = a.y).
      const w = a.w * m;
      const d = a.h * m;
      t.repeat.set(1 / w, 1 / d);
      t.offset.set((-a.x * m) / w, 1 + (a.y * m) / d);
    }
    return t;
  }, [a, fill, markers, images, fontReady, m, gl]);
  useEffect(() => () => tex?.dispose(), [tex]);

  const mats = useMemo(() => {
    // Top: unlit and untone-mapped so the plan view shows the plan's exact colours, as the booth tops do.
    const top = tex ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) : new THREE.MeshBasicMaterial({ color: fill, toneMapped: false });
    const side = new THREE.MeshStandardMaterial({ color: fill });
    // BoxGeometry groups: +x, -x, +y (top), -y, +z, -z. ExtrudeGeometry groups: caps, sides.
    return { top, side, list: a.polygon ? [top, side] : [side, side, top, side, side, side] };
  }, [tex, fill, a.polygon]);
  useEffect(
    () => () => {
      mats.top.dispose();
      mats.side.dispose();
    },
    [mats],
  );

  const tag = debug({ what: `${AREA_KO[a.kind]} "${a.label}"`, source: "배치도", ref: `areas[id=${a.id}]`, component: "Scene.tsx (AreaMesh)", note: `height ${s.h} m from AREA_STYLE (임의)` });
  // User: a click on the RED/BLUE STAGE opens its official timetable, the way a booth click opens the booth card.
  const stage = stageOfArea(a);
  const click = stage
    ? {
        onClick: (e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          // A drag (orbit or look-around) that ends on the stage is not a pick.
          if (e.delta > 4) return;
          onSelect(stageKey(stage));
        },
      }
    : {};
  return a.polygon ? (
    <mesh geometry={geom} rotation-x={-Math.PI / 2} material={mats.list} {...tag} {...click} />
  ) : (
    <mesh geometry={geom} position={[(a.x + a.w / 2) * m, s.h / 2, (a.y + a.h / 2) * m]} material={mats.list} {...tag} {...click} />
  );
};

const AREA_KO: Record<AreaKind, string> = {
  stage: "무대",
  seating: "좌석",
  facility: "편의시설",
  "photo-zone": "포토존",
  "hall-label": "홀 라벨",
  "floor-marking": "바닥 표시",
};

/** Longest canvas side for an area top, in texels. */
const AREA_TEX_MAX = 2048;

/** The area top: fill, then the plan images on it, then its label; null when there is nothing but the fill. */
const areaCanvas = (a: Area, m: number, fill: string, markers: Marker[], images: Images | null, fontReady: boolean) => {
  const withImages = images ? markers.filter((mk) => images.has(mk.icon)) : [];
  const withLabel = a.label !== "" && fontReady;
  if (withImages.length === 0 && !withLabel) return null;
  // Texels per source px; at most 1, since the plan images are no sharper than the plan.
  const k = Math.min(1, AREA_TEX_MAX / Math.max(a.w, a.h));
  const canvas = Object.assign(document.createElement("canvas"), { width: Math.ceil(a.w * k), height: Math.ceil(a.h * k) });
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const mk of withImages) ctx.drawImage(images!.get(mk.icon)!, (mk.x - a.x) * k, (mk.y - a.y) * k, mk.w * k, mk.h * k);
  if (withLabel) drawAreaLabel(ctx, a, a.kind === "hall-label" ? inkOn(FLOOR, ["flat"]) : inkOn(fill), (a.w / 2) * k, (a.h / 2) * k, k, m);
  return canvas;
};

/**
 * Label centred at (cx, cy) on a canvas at k texels per source px (m meters each). Tall narrow areas (locker, makeup room) read along
 * their long side, turned 90deg counter-clockwise seen from above.
 */
const drawAreaLabel = (ctx: CanvasRenderingContext2D, a: Area, ink: Ink, cx: number, cy: number, k: number, m: number) => {
  const vertical = a.h > a.w * 1.4;
  const lw = vertical ? a.h : a.w;
  const ls = vertical ? a.w : a.h;
  // The size rule the 3D text used, in source px: at least 0.8 m, at most 6 m.
  const size = Math.max(0.8 / m, Math.min(ls * 0.6, (lw / Math.max(a.label.length, 1)) * 1.4, 6 / m)) * k;
  ctx.save();
  ctx.translate(cx, cy);
  if (vertical) ctx.rotate(-Math.PI / 2);
  ctx.font = `${size}px "${FONT}"`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  if (ink.outline) {
    // The halo rim is 0.06 em outside each glyph edge; a centred stroke needs twice that width.
    ctx.strokeStyle = ink.outline;
    ctx.lineWidth = size * 0.12;
    ctx.strokeText(a.label, 0, 0, lw * k);
  }
  ctx.fillStyle = ink.color;
  ctx.fillText(a.label, 0, 0, lw * k);
  ctx.restore();
};

/**
 * Index of the area each marker lies on: the highest raised area whose box contains the marker centre, or -1 when it
 * lies on the floor (no area, or only height-0 areas such as hall labels and floor markings).
 */
const markerOwners = (data: MapData) =>
  (data.markers ?? []).map((mk) => {
    const cx = mk.x + mk.w / 2;
    const cy = mk.y + mk.h / 2;
    let best = -1;
    let top = 0;
    data.areas.forEach((a, i) => {
      const h = AREA_STYLE[a.kind].h;
      if (h > top && cx >= a.x && cx <= a.x + a.w && cy >= a.y && cy <= a.y + a.h) {
        best = i;
        top = h;
      }
    });
    return best;
  });

/* ---------------------------------------------------------------- floor ---------------------------------------------------------------- */

/** One rectangle drawn into the floor, in source px: a plan image, or a height-0 area's fill and label. */
export type Decal = { x: number; y: number; w: number; h: number; draw: (ctx: CanvasRenderingContext2D, x: number, y: number, k: number) => void };

/** Atlas texels of each cell's surroundings drawn around it, so mip levels sample the true neighbour, not another tile. */
const DECAL_GUTTER = 4;
/** Longest cell side in source px, so long frame strips still shelf-pack into the atlas width. */
const CELL_MAX = 2048;

/**
 * The drone-view floor as one mesh. The plan rectangle is cut on every decal edge into a grid of cells; plain cells are
 * paper white, and cells under a decal sample an atlas tile where white and every decal over it were composited in 2D.
 * Cells never overlap, so nothing is stacked on the floor.
 */
const Floor = ({ data, decals, visible }: FloorProps) => {
  const gl = useThree((st) => st.gl);
  const built = useMemo(() => floorMesh(data.source.widthPx, data.source.heightPx, data.metersPerPx, decals, gl), [data, decals, gl]);
  useEffect(
    () => () => {
      built.geom.dispose();
      built.mats.forEach((mt) => mt.dispose());
      built.tex?.dispose();
    },
    [built],
  );
  return <mesh geometry={built.geom} material={built.mats} visible={visible} {...debug({ what: "바닥 (드론용)", source: "배치도", ref: "plan decals", component: "Scene.tsx (Floor)" })} />;
};

export const floorDecals = (data: MapData, images: Images | null, fontReady: boolean): Decal[] => {
  const m = data.metersPerPx;
  const owner = markerOwners(data);
  const out: Decal[] = [];
  for (const a of data.areas) {
    if (AREA_STYLE[a.kind].h > 0) continue;
    const fill = a.color;
    const label = a.label !== "" && fontReady;
    if (!fill && !label) continue;
    out.push({
      x: a.x,
      y: a.y,
      w: a.w,
      h: a.h,
      draw: (ctx, x, y, k) => {
        if (fill) {
          ctx.fillStyle = fill;
          ctx.fillRect(x, y, a.w * k, a.h * k);
        }
        if (label) drawAreaLabel(ctx, a, a.kind === "hall-label" ? inkOn(FLOOR, ["flat"]) : inkOn(fill ?? FLOOR), x + (a.w / 2) * k, y + (a.h / 2) * k, k, m);
      },
    });
  }
  (data.markers ?? []).forEach((mk, j) => {
    const img = images?.get(mk.icon);
    if (owner[j] !== -1 || !img) return;
    out.push({ x: mk.x, y: mk.y, w: mk.w, h: mk.h, draw: (ctx, x, y, k) => ctx.drawImage(img, x, y, mk.w * k, mk.h * k) });
  });
  return out;
};

/** Sorted cut positions along one axis: 0, size, every decal edge, and extra cuts so no cell is longer than CELL_MAX. */
const cuts = (size: number, edges: number[]) => {
  const base = [...new Set([0, size, ...edges.map((e) => Math.min(size, Math.max(0, e)))])].sort((p, q) => p - q);
  const out: number[] = [];
  base.forEach((p, i) => {
    out.push(p);
    const next = base[i + 1];
    if (next === undefined) return;
    const n = Math.ceil((next - p) / CELL_MAX);
    for (let s = 1; s < n; s++) out.push(p + ((next - p) * s) / n);
  });
  return out;
};

const floorMesh = (Wpx: number, Hpx: number, m: number, decals: Decal[], gl: THREE.WebGLRenderer) => {
  const xs = cuts(Wpx, decals.flatMap((d) => [d.x, d.x + d.w]));
  const ys = cuts(Hpx, decals.flatMap((d) => [d.y, d.y + d.h]));
  type Cell = { x0: number; y0: number; x1: number; y1: number };
  const plain: Cell[] = [];
  const marked: Cell[] = [];
  for (let j = 0; j + 1 < ys.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const c = { x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] };
      const under = decals.some((d) => c.x0 >= d.x && c.x1 <= d.x + d.w && c.y0 >= d.y && c.y1 <= d.y + d.h);
      (under ? marked : plain).push(c);
    }
  }

  // One atlas tile per marked cell, starting at 1 texel per source px. Each tile carries its own DECAL_GUTTER margin
  // showing the plan around the cell (white, then every decal over it), and the cell's uv is inset past that margin.
  const g = DECAL_GUTTER;
  const atlas =
    marked.length > 0
      ? buildAtlas(gl, 1 / m, (dens) =>
          marked.map((c): Tile => {
            const k = dens * m;
            return {
              w: (c.x1 - c.x0) * k + 2 * g,
              h: (c.y1 - c.y0) * k + 2 * g,
              bg: FLOOR,
              draw: (ctx, x, y, w, h) => {
                // buildAtlas rounds tiles up to whole texels; stretch so the cell's plan extent fills exactly the inset.
                const sx = (w - 2 * g) / (c.x1 - c.x0);
                const sy = (h - 2 * g) / (c.y1 - c.y0);
                ctx.translate(x + g, y + g);
                ctx.scale(sx / k, sy / k);
                const gx = g / sx;
                const gy = g / sy;
                for (const d of decals) {
                  if (d.x > c.x1 + gx || d.x + d.w < c.x0 - gx || d.y > c.y1 + gy || d.y + d.h < c.y0 - gy) continue;
                  d.draw(ctx, (d.x - c.x0) * k, (d.y - c.y0) * k, k);
                }
              },
            };
          }),
        )
      : null;
  const tex = atlas?.tex ?? null;

  // World quads at y = 0 facing up; plain cells first (group 0), then marked cells (group 1) with their atlas uv.
  const pos: number[] = [];
  const uvs: number[] = [];
  const quad = (c: Cell, uv: [number, number, number, number]) => {
    const [u0, v0, u1, v1] = uv;
    const [x0, z0, x1, z1] = [c.x0 * m, c.y0 * m, c.x1 * m, c.y1 * m];
    // Counter-clockwise seen from above (+y): (x0,z1) -> (x1,z1) -> (x1,z0), then (x0,z1) -> (x1,z0) -> (x0,z0).
    pos.push(x0, 0, z1, x1, 0, z1, x1, 0, z0, x0, 0, z1, x1, 0, z0, x0, 0, z0);
    uvs.push(u0, v1, u1, v1, u1, v0, u0, v1, u1, v0, u0, v0);
  };
  plain.forEach((c) => quad(c, [0, 0, 0, 0]));
  marked.forEach((c, i) => {
    const uv = atlas!.uv(i);
    // The tile size buildAtlas used (it rounds up), so the inset lands exactly on the cell's texels.
    const k = atlas!.dens * m;
    const tw = Math.max(1, Math.ceil((c.x1 - c.x0) * k + 2 * g));
    const th = Math.max(1, Math.ceil((c.y1 - c.y0) * k + 2 * g));
    // v0 is the cell's north edge (plan y0), the tile's top row past the margin.
    const [u0, v0] = uv(g / tw, g / th);
    const [u1, v1] = uv(1 - g / tw, 1 - g / th);
    quad(c, [u0, v0, u1, v1]);
  });
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute("normal", new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.addGroup(0, plain.length * 6, 0);
  geom.addGroup(plain.length * 6, marked.length * 6, 1);
  geom.computeBoundingSphere();
  // Unlit: a flat floor gets uniform light anyway, and lit+tone-mapped white came out #cecece instead of the plan's paper white.
  const mats = [
    new THREE.MeshBasicMaterial({ color: FLOOR, toneMapped: false }),
    tex ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) : new THREE.MeshBasicMaterial({ color: FLOOR, toneMapped: false }),
  ];
  return { geom, mats, tex };
};

/* ---------------------------------------------------------------- loading -------------------------------------------------------------- */

/** Every plan image, resolved once all have loaded or failed (a failed one is left out and logged). */
const usePlanImages = (urls: string[]) => {
  const [images, setImages] = useState<Images | null>(null);
  useEffect(() => {
    let live = true;
    setImages(null);
    Promise.allSettled(
      urls.map(async (url) => {
        const img = new Image();
        img.src = url;
        try {
          await img.decode();
        } catch (err) {
          console.warn(`map marker failed to load: ${url}`, err);
          throw err;
        }
        return [url, img] as const;
      }),
    ).then((rs) => {
      if (live) setImages(new Map(rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))));
    });
    return () => {
      live = false;
    };
  }, [urls]);
  return images;
};


/* ---------------------------------------------------------------- style ---------------------------------------------------------------- */

export const AREA_STYLE: Record<AreaKind, { h: number; color: string }> = {
  stage: { h: 0.8, color: "#c9a0ff" },
  seating: { h: 0.3, color: "#9fb4c7" },
  facility: { h: 0.3, color: "#b8b8b8" },
  "photo-zone": { h: 0.3, color: "#f3a6c8" },
  "hall-label": { h: 0, color: "#8a8f98" },
  // Printed on the floor: drawn into the floor mesh, no box, and walk.ts lets you walk over it.
  "floor-marking": { h: 0, color: "#ffffff" },
};

/** Floor colour, the surface under hall labels and floor markings. */
const FLOOR = "#ffffff";
/** Opening pose: 3 m inside Hall 1's lobby entrance, facing into the hall (-z). Null without CAD structure. */
export const startPose = (data: MapData): Pose | null => {
  const s = data.structure;
  const hall1 = s?.halls?.find((h) => h.id === "hall1");
  if (!s || !hall1) return null;
  const xs = hall1.polygon.map((p) => p[0]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const door = s.openings.find((o) => o.kind === "entrance" && o.side === "lobby" && (o.a[0] + o.b[0]) / 2 > x0 && (o.a[0] + o.b[0]) / 2 < x1);
  if (!door) return null;
  const m = data.metersPerPx;
  return { x: ((door.a[0] + door.b[0]) / 2) * m, z: ((door.a[1] + door.b[1]) / 2) * m - 3, yaw: 0 };
};
