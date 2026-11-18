import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Edges } from "@react-three/drei";
import * as THREE from "three";
import type { MapData } from "../maps/types";
import { debug } from "./DebugInspector";
import { faceWalker } from "./labelFit";
import { INK_DARK, INK_LIGHT, WALLS, inkOn, logoPlate, logoSamples, type Ink } from "./contrast";
import { POST_M, boothPosts, rectOf, type ViewMode } from "./walk";

/**
 * Booths, drawn the standard way for text on a surface: every surface that carries text or a logo is ONE opaque mesh
 * whose material samples a canvas atlas where the surface colour, the text and the logo were composited in 2D.
 * Nothing is layered over a surface (no decals, no polygon offset, no transparent text quads), so there is no draw
 * order to get wrong.
 *
 * - Drone view: solid boxes; the top samples the drone atlas (plan fill + name or logo), unlit and untone-mapped so it
 *   shows the map.json colour exactly.
 * - Road view: open shell-scheme stands. Four corner posts (instanced) and a fascia band along the top of each side;
 *   each fascia's outer face samples the fascia atlas ("<code> <name>", logo left of it where it fits). Above the
 *   booth floats a billboard (rounded plate + logo or name) that turns about Y to face the walker.
 */

type Booth = MapData["booths"][number];

interface BoothsProps {
  data: MapData;
  booths: Booth[];
  selected: string | null;
  view: ViewMode;
  onSelect: (code: string | null) => void;
}

/** Loaded logo image per booth code; null until every logo has loaded or failed, so each atlas is drawn once with them. */
type Logos = Map<string, { img: HTMLImageElement; aspect: number }>;

/** Noto Sans KR Bold subset (woff: troika cannot read woff2). Regenerate with `npm run font`. Also drawn into canvases. */
export const fontUrl = "/fonts/boken-labels.woff";
export const FONT = "boken-labels";

export const BOOTH_H = 3;
/** Road-view fascia band: height, thickness, and its centre height (hanging just below the post tops). Meters. */
const FASCIA_H = 0.4;
const FASCIA_T = 0.03;
const FASCIA_Y = BOOTH_H - 0.05 - FASCIA_H / 2;
/** Fascia copy: side padding, logo height, logo-to-text gap, and the text size range (font size, meters). */
const FASCIA_PAD = 0.08;
const FASCIA_LOGO_H = FASCIA_H * 0.7;
const FASCIA_GAP = 0.08;
const FASCIA_TEXT_MAX = FASCIA_H * 0.55;
const FASCIA_TEXT_MIN = 0.12;
/** Road-view floating sign: gap above the booth top and the box it fits in (meters). */
const SIGN_LIFT = 1.2;
const SIGN_H = 2.4;
const SIGN_W = 6;
/** Atlas texels per meter to start from; lowered until the atlas fits ATLAS_W square. */
const FASCIA_DENSITY = 256;
const TOP_DENSITY = 64;
const SIGN_DENSITY = 96;
const ATLAS_W = 4096;
/** Texels of the tile's own background drawn around it, so mip levels do not bleed a neighbour in. */
const GUTTER = 6;

const NAME_LINE_H = 1.15;
/** Shell-scheme aluminium post: light, slightly glossy, and dielectric (a metal needs an environment map to read as anything). */
const POST_MATERIAL = new THREE.MeshStandardMaterial({ color: "#d7dbe0", roughness: 0.45 });
const NO_RAYCAST = () => null;

export const Booths = ({ data, booths, selected, view, onSelect }: BoothsProps) => {
  const m = data.metersPerPx;
  const font = useLabelFont();
  const logos = useLogoImages(data.booths);
  const sel = booths.find((b) => b.code === selected);
  /** Pick handler mapping a hit triangle or instance to its booth. */
  const pick = (boothOf: (e: ThreeEvent<MouseEvent>) => number | null) => (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    // A drag (orbit or look-around) that ends on a booth is not a pick.
    if (e.delta > 4) return;
    const i = boothOf(e);
    if (i != null) onSelect(booths[i]?.code ?? null);
  };
  return (
    <>
      {view === "road" ? (
        <RoadBooths data={data} booths={booths} font={font} logos={logos} pick={pick} />
      ) : (
        <DroneBooths data={data} booths={booths} font={font} logos={logos} pick={pick} />
      )}
      {sel && (
        <mesh
          position={[(sel.x + sel.w / 2) * m, BOOTH_H / 2 + 0.15, (sel.y + sel.h / 2) * m]}
          scale={[sel.w * m + 0.4, BOOTH_H + 0.3, sel.h * m + 0.4]}
          renderOrder={1}
          raycast={NO_RAYCAST}
          {...debug({ what: "선택 하이라이트", source: "임의", ref: `booth ${sel.code}`, component: "BoothFrame.tsx (Booths)" })}
        >
          <boxGeometry args={[1, 1, 1]} />
          {/* Road view stands close enough that the tinted box fills the screen like a veil: outline only there. */}
          <meshBasicMaterial color="#ffe14d" transparent opacity={0.3} depthWrite={false} visible={view === "drone"} />
          <Edges color="#d49b00" />
        </mesh>
      )}
    </>
  );
};

type Pick = (boothOf: (e: ThreeEvent<MouseEvent>) => number | null) => (e: ThreeEvent<MouseEvent>) => void;
interface PartProps {
  data: MapData;
  booths: Booth[];
  font: boolean;
  logos: Logos | null;
  pick: Pick;
}

/* ---------------------------------------------------------------- drone ---------------------------------------------------------------- */

/** Triangles per booth in the drone mesh: 4 side quads (all booths' sides first), then 1 top quad. */
const DRONE_SIDE_TRIS = 8;

const DroneBooths = ({ data, booths, font, logos, pick }: PartProps) => {
  const m = data.metersPerPx;
  const gl = useThree((s) => s.gl);
  const atlas = useMemo(() => (font ? topAtlas(data, booths, logos, gl) : null), [data, booths, logos, font, gl]);
  useEffect(() => () => atlas?.tex.dispose(), [atlas]);
  const geom = useMemo(() => {
    const g = new QuadBuilder();
    const color = new THREE.Color();
    const white = new THREE.Color(1, 1, 1);
    for (const b of booths) {
      color.set(boothFill(data, b));
      const r = rectOf(b, m);
      const at = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      g.quad([at(r.x1, 0, r.z1), at(r.x0, 0, r.z1), at(r.x0, BOOTH_H, r.z1), at(r.x1, BOOTH_H, r.z1)], [0, 0, 1], null, color);
      g.quad([at(r.x0, 0, r.z0), at(r.x1, 0, r.z0), at(r.x1, BOOTH_H, r.z0), at(r.x0, BOOTH_H, r.z0)], [0, 0, -1], null, color);
      g.quad([at(r.x1, 0, r.z0), at(r.x1, 0, r.z1), at(r.x1, BOOTH_H, r.z1), at(r.x1, BOOTH_H, r.z0)], [1, 0, 0], null, color);
      g.quad([at(r.x0, 0, r.z1), at(r.x0, 0, r.z0), at(r.x0, BOOTH_H, r.z0), at(r.x0, BOOTH_H, r.z1)], [-1, 0, 0], null, color);
    }
    const sideVerts = g.count;
    booths.forEach((b, i) => {
      color.set(boothFill(data, b));
      const r = rectOf(b, m);
      // Plan orientation: atlas tile x runs east (+x), tile y runs south (+z).
      const uv = atlas ? atlas.uv(i) : null;
      g.quad(
        [new THREE.Vector3(r.x0, BOOTH_H, r.z1), new THREE.Vector3(r.x1, BOOTH_H, r.z1), new THREE.Vector3(r.x1, BOOTH_H, r.z0), new THREE.Vector3(r.x0, BOOTH_H, r.z0)],
        [0, 1, 0],
        uv ? [uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0)] : null,
        atlas ? white : color,
      );
    });
    const geo = g.build();
    geo.addGroup(0, sideVerts, 0);
    geo.addGroup(sideVerts, g.count - sideVerts, 1);
    return geo;
  }, [booths, data, m, atlas]);
  useEffect(() => () => geom.dispose(), [geom]);
  // Top: unlit and untone-mapped so the plan view shows the exact map.json colour (from the atlas, or the vertex colour until it is drawn).
  const materials = useMemo(
    () => [
      new THREE.MeshStandardMaterial({ vertexColors: true }),
      atlas ? new THREE.MeshBasicMaterial({ map: atlas.tex, toneMapped: false }) : new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }),
    ],
    [atlas],
  );
  useEffect(() => () => materials.forEach((x) => x.dispose()), [materials]);
  const n = booths.length;
  return (
    <mesh
      geometry={geom}
      material={materials}
      {...debug({
        what: "부스 (드론용)",
        source: "배치도",
        ref: ({ faceIndex }) => `booth ${faceIndex === undefined ? "?" : booths[faceIndex < n * DRONE_SIDE_TRIS ? Math.floor(faceIndex / DRONE_SIDE_TRIS) : Math.floor((faceIndex - n * DRONE_SIDE_TRIS) / 2)]?.code}`,
        component: "BoothFrame.tsx (DroneBooths)",
      })}
      onClick={pick((e) => (e.faceIndex == null ? null : e.faceIndex < n * DRONE_SIDE_TRIS ? Math.floor(e.faceIndex / DRONE_SIDE_TRIS) : Math.floor((e.faceIndex - n * DRONE_SIDE_TRIS) / 2)))}
    />
  );
};

/** Drone atlas: one tile per booth top, the plan fill with the exhibitor logo, or its name laid out as the plan does. */
const topAtlas = (data: MapData, booths: Booth[], logos: Logos | null, gl: THREE.WebGLRenderer) => {
  const m = data.metersPerPx;
  return buildAtlas(gl, TOP_DENSITY, (dens) =>
    booths.map((b): Tile => {
      const bw = b.w * m;
      const bd = b.h * m;
      const fill = boothFill(data, b);
      const logo = logos?.get(b.code);
      return {
        w: bw * dens,
        h: bd * dens,
        bg: fill,
        draw: (ctx, x, y, w, h) => {
          if (logo) {
            // Fitted inside the top with padding, always upright (top = north).
            const pad = Math.min(bw, bd) * 0.1;
            const lw = Math.min(bw - 2 * pad, (bd - 2 * pad) * logo.aspect);
            const ld = lw / logo.aspect;
            ctx.drawImage(logo.img, x + (w - lw * dens) / 2, y + (h - ld * dens) / 2, lw * dens, ld * dens);
            return;
          }
          const fit = fitBoothText(b, m);
          ctx.translate(x + w / 2, y + h / 2);
          // Turned a quarter counterclockwise seen from above: reads south to north.
          if (fit.vertical) ctx.rotate(-Math.PI / 2);
          drawLines(ctx, fit.text.split("\n"), 0, 0, fit.size * dens, inkOn(fill, ["flat"]), "center");
        },
      };
    }),
  );
};

/* ---------------------------------------------------------------- road ----------------------------------------------------------------- */

/** Quads per fascia (front margin, front copy, front margin, back, top, bottom, two ends) and so triangles per booth. */
const FASCIA_TRIS_PER_BOOTH = 4 * 8 * 2;
/** Counter box: chest height, inset of one person's width per footprint axis, minimum side, and the copy band's gap below the box top. Meters. */
const BOX_H_M = 1.3;
const PERSON_M = 0.6;
const BOX_MIN_M = 0.4;
const BOX_BAND_GAP = 0.1;
/** Quads per box side (below band, above band, margin, copy, margin) x 4, plus the top; so triangles per booth. */
const BOX_TRIS_PER_BOOTH = (4 * 5 + 1) * 2;

const RoadBooths = ({ data, booths, font, logos, pick }: PartProps) => {
  const m = data.metersPerPx;
  const gl = useThree((s) => s.gl);
  const posts = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const pm = posts.current;
    if (!pm) return;
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    booths.forEach((b, i) => {
      boothPosts(rectOf(b, m)).forEach(([x, z], k) => {
        pm.setMatrixAt(i * 4 + k, mat.compose(new THREE.Vector3(x, BOOTH_H / 2, z), q, new THREE.Vector3(POST_M, BOOTH_H, POST_M)));
      });
    });
    pm.count = booths.length * 4;
    pm.instanceMatrix.needsUpdate = true;
    pm.computeBoundingSphere();
  }, [booths, m]);

  const fascia = useMemo(() => (font ? fasciaAtlas(data, booths, logos, gl) : null), [data, booths, logos, font, gl]);
  useEffect(() => () => fascia?.atlas.tex.dispose(), [fascia]);
  const geom = useMemo(() => fasciaGeometry(data, booths, fascia), [data, booths, fascia]);
  useEffect(() => () => geom.dispose(), [geom]);
  // Lit like the old booth walls, so contrast.ts's WALLS shading bounds the fascia ink. Vertex colour = fill where the
  // face samples the atlas's white tile, white where it samples a copy tile (which carries the fill itself).
  const fasciaMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, map: fascia?.atlas.tex ?? null }), [fascia]);
  useEffect(() => () => fasciaMat.dispose(), [fasciaMat]);

  // Counter boxes: the same copy layout on a shrunk booth, in an atlas of its own (the fascia's is left as it is).
  const boxes = useMemo(() => booths.map((b) => boxOf(b, m)), [booths, m]);
  const boxCopy = useMemo(() => (font ? fasciaAtlas(data, boxes, logos, gl) : null), [data, boxes, logos, font, gl]);
  useEffect(() => () => boxCopy?.atlas.tex.dispose(), [boxCopy]);
  const boxGeom = useMemo(() => boxGeometry(data, boxes, boxCopy), [data, boxes, boxCopy]);
  useEffect(() => () => boxGeom.dispose(), [boxGeom]);
  const boxMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, map: boxCopy?.atlas.tex ?? null }), [boxCopy]);
  useEffect(() => () => boxMat.dispose(), [boxMat]);

  const signs = useMemo(() => (font ? signAtlas(data, booths, logos, gl) : null), [data, booths, logos, font, gl]);
  useEffect(() => () => signs?.atlas.tex.dispose(), [signs]);
  // Cut-out (alpha test), not blended: the rounded plate's corners are the only transparent texels.
  const signMat = useMemo(() => (signs ? new THREE.MeshBasicMaterial({ map: signs.atlas.tex, alphaTest: 0.5, toneMapped: false }) : null), [signs]);
  useEffect(() => () => signMat?.dispose(), [signMat]);

  return (
    <>
      <instancedMesh
        ref={posts}
        args={[undefined, POST_MATERIAL, data.booths.length * 4]}
        frustumCulled={false}
        {...debug({ what: "부스 기둥", source: "배치도", ref: ({ instanceId }) => `booth ${instanceId === undefined ? "?" : booths[Math.floor(instanceId / 4)]?.code} post ${(instanceId ?? 0) % 4}`, component: "BoothFrame.tsx (RoadBooths)", note: "height 3 m (BOOTH_H) is 임의" })}
        onClick={pick((e) => (e.instanceId == null ? null : Math.floor(e.instanceId / 4)))}
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <mesh
        geometry={geom}
        material={fasciaMat}
        {...debug({
          what: "부스 벽 (파시아)",
          source: "배치도",
          ref: ({ faceIndex }) => `booth ${faceIndex === undefined ? "?" : booths[Math.floor(faceIndex / FASCIA_TRIS_PER_BOOTH)]?.code}`,
          component: "BoothFrame.tsx (RoadBooths)",
          note: "0.4 m band at the booth top; text/logo from booth data",
        })}
        onClick={pick((e) => (e.faceIndex == null ? null : Math.floor(e.faceIndex / FASCIA_TRIS_PER_BOOTH)))}
      />
      <mesh
        geometry={boxGeom}
        material={boxMat}
        {...debug({
          what: "부스 카운터 박스 (로고 면)",
          source: "임의",
          ref: ({ faceIndex }) => `booth ${faceIndex === undefined ? "?" : booths[Math.floor(faceIndex / BOX_TRIS_PER_BOOTH)]?.code}`,
          component: "BoothFrame.tsx (RoadBooths)",
          note: "chest-high box, footprint = booth − 0.6 m per axis, per user request",
        })}
        onClick={pick((e) => (e.faceIndex == null ? null : Math.floor(e.faceIndex / BOX_TRIS_PER_BOOTH)))}
      />
      {signs &&
        signMat &&
        booths.map((b, i) => <Billboard key={b.code} booth={b} m={m} size={signs.sizes[i]} uv={signs.atlas.uv(i)} material={signMat} />)}
    </>
  );
};

/** A booth's four plan edges in world space: edge midpoint, outward normal, and length. */
const boothSides = (b: Booth, m: number) => {
  const cx = (b.x + b.w / 2) * m;
  const cz = (b.y + b.h / 2) * m;
  const bw = b.w * m;
  const bd = b.h * m;
  return [
    { x: cx, z: cz + bd / 2, nx: 0, nz: 1, len: bw },
    { x: cx, z: cz - bd / 2, nx: 0, nz: -1, len: bw },
    { x: cx + bw / 2, z: cz, nx: 1, nz: 0, len: bd },
    { x: cx - bw / 2, z: cz, nx: -1, nz: 0, len: bd },
  ];
};

/** Length of a side's fascia: post to post. */
const fasciaLen = (len: number) => len - 2 * POST_M;

/**
 * Fascia copy tiles, one per distinct (booth, fascia length): opposite sides share one. Index 0 is a white tile that
 * plain faces sample, tinted by their vertex colour.
 */
const fasciaAtlas = (data: MapData, booths: Booth[], logos: Logos | null, gl: THREE.WebGLRenderer) => {
  const keys = new Map<string, number>();
  const jobs: { b: Booth; len: number }[] = [];
  const m = data.metersPerPx;
  const tileOf = booths.map((b) =>
    boothSides(b, m).map((s) => {
      const len = fasciaLen(s.len);
      const k = `${b.code}|${len.toFixed(3)}`;
      if (!keys.has(k)) {
        keys.set(k, jobs.length + 1);
        jobs.push({ b, len });
      }
      return keys.get(k)!;
    }),
  );
  const layouts = jobs.map(({ b, len }) => fasciaLayout(fasciaText(b), len, logos?.get(b.code)?.aspect ?? null));
  const atlas = buildAtlas(gl, FASCIA_DENSITY, (dens) => [
    { w: 32, h: 32, bg: "#ffffff", draw: () => {} },
    ...jobs.map(({ b, len }, j): Tile => {
      const lay = layouts[j];
      const fill = boothFill(data, b);
      const logo = logos?.get(b.code);
      return {
        w: Math.min(len, lay.rowW + 2 * FASCIA_PAD) * dens,
        h: FASCIA_H * dens,
        bg: fill,
        draw: (ctx, x, y, w, h) => {
          const left = x + (w - lay.rowW * dens) / 2;
          if (logo && lay.logoW > 0)
            ctx.drawImage(logo.img, left, y + (h - FASCIA_LOGO_H * dens) / 2, lay.logoW * dens, FASCIA_LOGO_H * dens);
          const tx = left + (lay.logoW > 0 ? (lay.logoW + FASCIA_GAP) * dens : 0);
          drawLines(ctx, lay.lines, tx, y + h / 2, lay.size * dens, inkOn(fill, WALLS), "left");
        },
      };
    }),
  ]);
  return { atlas, tileOf, widths: jobs.map(({ len }, j) => Math.min(len, layouts[j].rowW + 2 * FASCIA_PAD)), layouts };
};

/**
 * All fascias as one mesh. Each is a box spanning post to post, outer face flush with the plan edge; the outer face is
 * split into margin | copy | margin so only the copy needs atlas texels.
 */
const fasciaGeometry = (data: MapData, booths: Booth[], fascia: ReturnType<typeof fasciaAtlas> | null) => {
  const m = data.metersPerPx;
  const g = new QuadBuilder();
  const fill = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  const plain = fascia ? fascia.atlas.uv(0)(0.5, 0.5) : null;
  const plainUv = plain ? ([plain, plain, plain, plain] as UV4) : null;
  const yb = FASCIA_Y - FASCIA_H / 2;
  const yt = FASCIA_Y + FASCIA_H / 2;
  booths.forEach((b, i) => {
    fill.set(boothFill(data, b));
    boothSides(b, m).forEach((s, k) => {
      const L = fasciaLen(s.len);
      const n = new THREE.Vector3(s.nx, 0, s.nz);
      // Right as seen by a viewer outside, facing the side.
      const R = new THREE.Vector3(s.nz, 0, -s.nx);
      const P = (along: number, y: number, depth: number) =>
        new THREE.Vector3(s.x + R.x * along - n.x * depth, y, s.z + R.z * along - n.z * depth);
      const t = fascia ? fascia.tileOf[i][k] : 0;
      const cw = fascia ? fascia.widths[t - 1] : 0;
      const uv = fascia ? fascia.atlas.uv(t) : null;
      const front = (a: number, c: number, copy: boolean) =>
        g.quad(
          [P(a, yb, 0), P(c, yb, 0), P(c, yt, 0), P(a, yt, 0)],
          [n.x, 0, n.z],
          copy && uv ? [uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0)] : plainUv,
          copy && uv ? white : fill,
        );
      front(-L / 2, -cw / 2, false);
      front(-cw / 2, cw / 2, true);
      front(cw / 2, L / 2, false);
      const T = FASCIA_T;
      g.quad([P(L / 2, yb, T), P(-L / 2, yb, T), P(-L / 2, yt, T), P(L / 2, yt, T)], [-n.x, 0, -n.z], plainUv, fill);
      g.quad([P(-L / 2, yt, 0), P(L / 2, yt, 0), P(L / 2, yt, T), P(-L / 2, yt, T)], [0, 1, 0], plainUv, fill);
      g.quad([P(-L / 2, yb, T), P(L / 2, yb, T), P(L / 2, yb, 0), P(-L / 2, yb, 0)], [0, -1, 0], plainUv, fill);
      g.quad([P(L / 2, yb, 0), P(L / 2, yb, T), P(L / 2, yt, T), P(L / 2, yt, 0)], [R.x, 0, R.z], plainUv, fill);
      g.quad([P(-L / 2, yb, T), P(-L / 2, yb, 0), P(-L / 2, yt, 0), P(-L / 2, yt, T)], [-R.x, 0, -R.z], plainUv, fill);
    });
  });
  return g.build();
};

/** The booth shrunk to its counter box: PERSON_M less per footprint axis (at least BOX_MIN_M), same centre. Source px. */
const boxOf = (b: Booth, m: number): Booth => {
  const w = Math.max(BOX_MIN_M, b.w * m - PERSON_M) / m;
  const h = Math.max(BOX_MIN_M, b.h * m - PERSON_M) / m;
  return { ...b, x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h };
};

/**
 * Counter boxes as one mesh, BOX_TRIS_PER_BOOTH triangles per booth. `boxes` are the booths run through boxOf, and
 * `copy` is the fascia atlas built from them. Each side face is plain fill above and below the copy band, and
 * margin | copy | margin inside it (the copy tile carries the fill itself); the top is the plain fill.
 */
const boxGeometry = (data: MapData, boxes: Booth[], copy: ReturnType<typeof fasciaAtlas> | null) => {
  const m = data.metersPerPx;
  const g = new QuadBuilder();
  const fill = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  const plain = copy ? copy.atlas.uv(0)(0.5, 0.5) : null;
  const plainUv = plain ? ([plain, plain, plain, plain] as UV4) : null;
  const bt = BOX_H_M - BOX_BAND_GAP;
  const bb = bt - FASCIA_H;
  boxes.forEach((b, i) => {
    fill.set(boothFill(data, b));
    boothSides(b, m).forEach((s, k) => {
      const L = s.len;
      const n = new THREE.Vector3(s.nx, 0, s.nz);
      // Right as seen by a viewer outside, facing the side.
      const R = new THREE.Vector3(s.nz, 0, -s.nx);
      const P = (along: number, y: number) => new THREE.Vector3(s.x + R.x * along, y, s.z + R.z * along);
      const t = copy ? copy.tileOf[i][k] : 0;
      const cw = copy ? copy.widths[t - 1] : 0;
      const uv = copy ? copy.atlas.uv(t) : null;
      const face = (a: number, c: number, y0: number, y1: number, isCopy: boolean) =>
        g.quad(
          [P(a, y0), P(c, y0), P(c, y1), P(a, y1)],
          [n.x, 0, n.z],
          isCopy && uv ? [uv(0, 1), uv(1, 1), uv(1, 0), uv(0, 0)] : plainUv,
          isCopy && uv ? white : fill,
        );
      face(-L / 2, L / 2, 0, bb, false);
      face(-L / 2, L / 2, bt, BOX_H_M, false);
      face(-L / 2, -cw / 2, bb, bt, false);
      face(-cw / 2, cw / 2, bb, bt, true);
      face(cw / 2, L / 2, bb, bt, false);
    });
    const cx = (b.x + b.w / 2) * m;
    const cz = (b.y + b.h / 2) * m;
    const hw = (b.w * m) / 2;
    const hd = (b.h * m) / 2;
    g.quad(
      [new THREE.Vector3(cx - hw, BOX_H_M, cz + hd), new THREE.Vector3(cx + hw, BOX_H_M, cz + hd), new THREE.Vector3(cx + hw, BOX_H_M, cz - hd), new THREE.Vector3(cx - hw, BOX_H_M, cz - hd)],
      [0, 1, 0],
      plainUv,
      fill,
    );
  });
  return g.build();
};

/** Fascia copy: "<code> <name>", or the code alone for a booth without an exhibitor name. */
const fasciaText = (b: Booth) => {
  const name = boothName(b);
  return name === b.code ? b.code : `${b.code} ${name}`;
};

/**
 * Fascia copy layout for a band `length` long. Text: one line as large as fits (capped at FASCIA_TEXT_MAX); below
 * FASCIA_TEXT_MIN, two balanced lines; still below, one line at the minimum size cut with "...". The logo (height
 * FASCIA_LOGO_H) goes left of the text only when the text keeps the same layout beside it: text wins.
 */
const fasciaLayout = (text: string, length: number, aspect: number | null) => {
  const inner = length - 2 * FASCIA_PAD;
  const fitText = (width: number) => {
    const one = Math.min(FASCIA_TEXT_MAX, width / emOf(text));
    if (one >= FASCIA_TEXT_MIN) return { mode: "one", size: one, lines: [text], w: one * emOf(text) };
    const lines = wrapName(text, 2, true);
    const widest = Math.max(...lines.map(emOf));
    const two = Math.min((FASCIA_H * 0.9) / (2 * NAME_LINE_H), width / widest);
    if (lines.length === 2 && two >= FASCIA_TEXT_MIN) return { mode: "two", size: two, lines, w: two * widest };
    let cut = [...text];
    while (cut.length > 1 && emOf(cut.join("").trimEnd() + "...") * FASCIA_TEXT_MIN > width) cut = cut.slice(0, -1);
    const short = cut.join("").trimEnd() + "...";
    return { mode: "cut", size: FASCIA_TEXT_MIN, lines: [short], w: FASCIA_TEXT_MIN * emOf(short) };
  };
  const bare = fitText(inner);
  if (aspect) {
    const logoW = FASCIA_LOGO_H * aspect;
    const beside = fitText(inner - logoW - FASCIA_GAP);
    if (bare.mode !== "cut" && beside.mode === bare.mode) return { ...beside, logoW, rowW: logoW + FASCIA_GAP + beside.w };
  }
  return { ...bare, logoW: 0, rowW: bare.w };
};

/**
 * Billboard tiles: a rounded plate (logoPlate colour behind a logo, white behind the name in dark ink) sized to its
 * content inside the sign box; corners left transparent for the material's alpha test.
 */
const signAtlas = (data: MapData, booths: Booth[], logos: Logos | null, gl: THREE.WebGLRenderer) => {
  const m = data.metersPerPx;
  const plans = booths.map((b) => {
    const width = Math.min(Math.max(b.w * m, b.h * m) * 0.9, SIGN_W);
    const pad = Math.min(width, SIGN_H) * 0.1;
    const logo = logos?.get(b.code);
    if (logo) {
      const lw = Math.min(width - 2 * pad, (SIGN_H - 2 * pad) * logo.aspect);
      const ld = lw / logo.aspect;
      const plate = Math.min(pad * 0.6, 0.4);
      return { w: lw + plate, h: ld + plate, plate: logoPlate(logoSamples(logo.img)), logo: { img: logo.img, w: lw, h: ld }, text: null };
    }
    const fit = fitName(boothName(b), width, SIGN_H, false);
    const lines = fit.text.split("\n");
    const margin = fit.size * 0.5;
    return {
      w: Math.max(...lines.map(emOf)) * fit.size + 2 * margin,
      h: lines.length * fit.size * NAME_LINE_H + margin,
      plate: INK_LIGHT,
      logo: null,
      text: { lines, size: fit.size },
    };
  });
  const atlas = buildAtlas(gl, SIGN_DENSITY, (dens) =>
    plans.map(
      (p): Tile => ({
        w: p.w * dens,
        h: p.h * dens,
        bg: null,
        draw: (ctx, x, y, w, h) => {
          roundRect(ctx, x, y, w, h, Math.min(w, h) * 0.15);
          ctx.fillStyle = p.plate;
          ctx.fill();
          if (p.logo) ctx.drawImage(p.logo.img, x + (w - p.logo.w * dens) / 2, y + (h - p.logo.h * dens) / 2, p.logo.w * dens, p.logo.h * dens);
          if (p.text) drawLines(ctx, p.text.lines, x + w / 2, y + h / 2, p.text.size * dens, SIGN_INK, "center");
        },
      }),
    ),
  );
  return { atlas, sizes: plans.map((p) => [p.w, p.h] as const) };
};

/** Name on a white plate: dark ink, exact (both unlit). */
const SIGN_INK: Ink = { color: INK_DARK, outline: null, ratio: 0 };

/** Floating sign above the booth that turns about Y to face the walker, like a Minecraft item display. */
const Billboard = ({ booth: b, m, size, uv, material }: { booth: Booth; m: number; size: readonly [number, number]; uv: UvOf; material: THREE.Material }) => {
  const ref = useRef<THREE.Group>(null);
  const at = useMemo(() => new THREE.Vector3((b.x + b.w / 2) * m, BOOTH_H + SIGN_LIFT + SIGN_H / 2, (b.y + b.h / 2) * m), [b, m]);
  const geom = useMemo(() => {
    const g = new THREE.PlaneGeometry(size[0], size[1]);
    // PlaneGeometry vertex order: top-left, top-right, bottom-left, bottom-right.
    g.setAttribute("uv", new THREE.Float32BufferAttribute([...uv(0, 0), ...uv(1, 0), ...uv(0, 1), ...uv(1, 1)], 2));
    return g;
  }, [size, uv]);
  useEffect(() => () => geom.dispose(), [geom]);
  useFrame(({ camera }) => {
    if (ref.current) faceWalker(ref.current, at, camera.position);
  });
  return (
    <group ref={ref} matrixAutoUpdate={false}>
      <mesh geometry={geom} material={material} raycast={NO_RAYCAST} {...debug({ what: "간판 (로고/이름)", source: "배치도", ref: `booth ${b.code}`, component: "BoothFrame.tsx (Billboard)", note: "floating position/size 임의" })} />
    </group>
  );
};

/* ---------------------------------------------------------------- atlas ---------------------------------------------------------------- */

/** One atlas tile: size in texels, background drawn under it and into its gutter (null: transparent), and its content. */
export type Tile = {
  w: number;
  h: number;
  bg: string | null;
  draw: (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;
};
/** Atlas uv of the point (fx, fy) in tile i, fx/fy 0..1 from the tile's top-left. */
type UvOf = (fx: number, fy: number) => [number, number];
type UV4 = [[number, number], [number, number], [number, number], [number, number]];

/**
 * Shelf-packs tiles into a canvas ATLAS_W wide and uploads it as an sRGB, mipmapped, anisotropic texture. Tiles are
 * made at `density` texels per meter, lowered until the atlas is at most ATLAS_W tall.
 */
export const buildAtlas = (gl: THREE.WebGLRenderer, density: number, make: (dens: number) => Tile[]) => {
  for (let dens = density; ; dens *= 0.85) {
    const tiles = make(dens).map((t) => ({ ...t, w: Math.max(1, Math.ceil(t.w)), h: Math.max(1, Math.ceil(t.h)) }));
    const order = tiles.map((_, i) => i).sort((a, b) => tiles[b].h - tiles[a].h);
    const at: { x: number; y: number }[] = [];
    let x = 0;
    let y = 0;
    let row = 0;
    for (const i of order) {
      const w = tiles[i].w + 2 * GUTTER;
      const h = tiles[i].h + 2 * GUTTER;
      if (x + w > ATLAS_W) {
        y += row;
        x = 0;
        row = 0;
      }
      at[i] = { x: x + GUTTER, y: y + GUTTER };
      x += w;
      row = Math.max(row, h);
    }
    const H = y + row;
    if (H > ATLAS_W && dens > 4) continue;
    const canvas = Object.assign(document.createElement("canvas"), { width: ATLAS_W, height: Math.ceil(H / 4) * 4 });
    const ctx = canvas.getContext("2d")!;
    tiles.forEach((t, i) => {
      const p = at[i];
      if (t.bg) {
        ctx.fillStyle = t.bg;
        ctx.fillRect(p.x - GUTTER, p.y - GUTTER, t.w + 2 * GUTTER, t.h + 2 * GUTTER);
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, t.w, t.h);
      ctx.clip();
      t.draw(ctx, p.x, p.y, t.w, t.h);
      ctx.restore();
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = gl.capabilities.getMaxAnisotropy();
    const uv =
      (i: number): UvOf =>
      (fx, fy) => [(at[i].x + fx * tiles[i].w) / canvas.width, 1 - (at[i].y + fy * tiles[i].h) / canvas.height];
    return { tex, uv, dens };
  }
};

/** Text lines centred on cy, each `px` tall, in the ink's colour over its halo (stroked first) when it has one. */
const drawLines = (ctx: CanvasRenderingContext2D, lines: string[], x: number, cy: number, px: number, ink: Ink, align: CanvasTextAlign) => {
  ctx.font = `${px}px "${FONT}"`;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  ctx.lineJoin = "round";
  lines.forEach((l, i) => {
    const y = cy + (i - (lines.length - 1) / 2) * px * NAME_LINE_H;
    if (ink.outline) {
      // The halo rim is 0.06 em outside each glyph edge; a centred stroke needs twice that width.
      ctx.strokeStyle = ink.outline;
      ctx.lineWidth = px * 0.12;
      ctx.strokeText(l, x, y);
    }
    ctx.fillStyle = ink.color;
    ctx.fillText(l, x, y);
  });
};

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
};

/** Non-indexed triangle soup of quads with normal, uv and colour; each quad's winding is fixed to face its normal. */
class QuadBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private uvs: number[] = [];
  private col: number[] = [];
  get count() {
    return this.pos.length / 3;
  }
  quad(p: THREE.Vector3[], n: [number, number, number], uv: UV4 | null, c: THREE.Color) {
    const cross = new THREE.Vector3().subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0]));
    const order = cross.dot(new THREE.Vector3(...n)) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const i of order) {
      this.pos.push(p[i].x, p[i].y, p[i].z);
      this.nor.push(...n);
      this.uvs.push(...(uv ? uv[i] : [0, 0]));
      this.col.push(c.r, c.g, c.b);
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/* ---------------------------------------------------------------- loading -------------------------------------------------------------- */

let fontLoad: Promise<void> | null = null;
/** True once the label font is registered for canvas drawing. */
export const useLabelFont = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    fontLoad ??= new FontFace(FONT, `url(${fontUrl})`).load().then((f) => {
      document.fonts.add(f);
    });
    fontLoad.then(
      () => live && setReady(true),
      (err) => {
        console.warn(`label font failed to load: ${fontUrl}`, err);
        if (live) setReady(true);
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return ready;
};

/** Every booth logo, resolved once all have loaded or failed (a failed one is left out and its booth shows its name). */
const useLogoImages = (booths: Booth[]) => {
  const [logos, setLogos] = useState<Logos | null>(null);
  useEffect(() => {
    let live = true;
    const want = booths.filter((b) => b.logo);
    Promise.allSettled(
      want.map(async (b) => {
        const img = new Image();
        img.src = b.logo!;
        try {
          await img.decode();
        } catch (err) {
          console.warn(`booth logo failed to load: ${b.logo}`, err);
          throw err;
        }
        return [b.code, { img, aspect: img.naturalWidth / img.naturalHeight }] as const;
      }),
    ).then((rs) => {
      if (live) setLogos(new Map(rs.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))));
    });
    return () => {
      live = false;
    };
  }, [booths]);
  return logos;
};

/* ---------------------------------------------------------------- text fit ------------------------------------------------------------- */

const boothFill = (data: MapData, b: Booth) => data.categories[b.category]?.color ?? "#999999";

const boothName = (b: Booth) => b.exhibitor?.ko || b.exhibitor?.en || b.code;

let measureCtx: CanvasRenderingContext2D | null = null;
/** Advance width in em of `s` in the label font, measured by the canvas that draws it. */
const emOf = (s: string) => {
  measureCtx ??= document.createElement("canvas").getContext("2d")!;
  measureCtx.font = `100px "${FONT}"`;
  return measureCtx.measureText(s).width / 100;
};

/** Hangul and other full-width glyphs; the only runs wrapName may split mid-word. */
const isWide = (ch: string) => ch.charCodeAt(0) >= 0x1100;

/** Advance width in em for the Noto Sans KR Bold label font (measured from its hmtx, rounded up). */
const emWidth = (s: string) => {
  let w = 0;
  for (const ch of s) {
    if (isWide(ch)) w += 0.92;
    else if (/[A-Z]/.test(ch)) w += 0.7;
    else if (/[a-z0-9]/.test(ch)) w += 0.6;
    else if (ch === " ") w += 0.23;
    else w += 0.42;
  }
  return w;
};

/** Greedy wrap aiming at `lines` lines; breaks at spaces and after / · : ), and inside Hangul runs only when `splitWords`. */
const wrapName = (text: string, lines: number, splitWords: boolean) => {
  const target = emWidth(text) / lines;
  const tokens = (text.match(/[^\s/·:)]+[/·:)]?|[/·:)]|\s+/g) ?? [text]).flatMap((t) =>
    splitWords && emWidth(t) > target * 1.2 && [...t].every(isWide) ? [...t] : [t],
  );
  const out: string[] = [];
  let line = "";
  for (const t of tokens) {
    if (line.trim() && emWidth((line + t).trim()) > target * 1.08 && t.trim()) {
      out.push(line.trim());
      line = t;
    } else line += t;
  }
  if (line.trim()) out.push(line.trim());
  return out;
};

/** Exhibitor name (ko, else en, else code) wrapped and sized to fit the booth top. */
const fitBoothText = (b: Booth, m: number) => fitName(boothName(b), b.w * m, b.h * m, true);

/**
 * Wraps and sizes `text` to fit width x depth.
 * Tries 1-4 lines in both orientations (only upright when !turn); an extra line, a 90deg turn, or a break
 * inside a Hangul word is taken only when it buys clearly bigger text, since each reads worse.
 */
const fitName = (text: string, w: number, d: number, turn: boolean) => {
  const fit = (width: number, depth: number, splitWords: boolean) => {
    let best = { size: 0, text };
    for (let n = 1; n <= 4; n++) {
      const lines = wrapName(text, n, splitWords);
      const widest = Math.max(...lines.map(emWidth));
      const size = Math.min((width * 0.88) / widest, (depth * 0.85) / (lines.length * NAME_LINE_H), 3);
      if (size > best.size * 1.25) best = { size, text: lines.join("\n") };
    }
    return best;
  };
  const pick = (splitWords: boolean) => {
    const flat = fit(w, d, splitWords);
    if (!turn) return { ...flat, vertical: false };
    const turned = fit(d, w, splitWords);
    return turned.size > flat.size * 1.4 ? { ...turned, vertical: true } : { ...flat, vertical: false };
  };
  const whole = pick(false);
  if (whole.size >= 0.8) return whole;
  const split = pick(true);
  return split.size > whole.size ? split : whole;
};
