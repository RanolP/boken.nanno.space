import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { isTypingTarget } from "./walk";

/**
 * Road-view debug inspector (toggle: Backquote). Every mesh the road view renders carries `userData.debug`
 * (see `debug()`), and the probe ray-casts the camera's centre ray against all visible meshes itself, bypassing the
 * `raycast={() => null}` overrides the scenery uses to stay out of pointer picking. The HUD lists the nearest hit and
 * the next two behind it, so a wrongly drawn or doubled (z-fighting) surface can be named and traced to its source.
 */

/** CAD = data.structure (KINTEX drawing), 배치도 = official layout image / booth data, 임의 = invented by code. */
export type DebugSource = "CAD" | "배치도" | "임의";
type HitInfo = { instanceId?: number; faceIndex?: number };
export interface DebugTag {
  /** Korean element name. */
  what: string;
  source: DebugSource;
  /** Data path or id; a function maps the hit instance or triangle to it. */
  ref?: string | ((hit: HitInfo) => string);
  /** File that draws it. */
  component: string;
  /** Which part is invented or otherwise worth knowing (e.g. a stand-in height). */
  note?: string;
}

/** Spread onto a mesh: `<mesh {...debug({...})} />`, or assign to `mesh.userData` for imperative meshes. */
export const debug = (tag: DebugTag) => ({ userData: { debug: tag } });

interface Hit {
  what: string;
  source: string;
  ref: string;
  note: string;
  component: string;
  dist: number;
  point: THREE.Vector3;
  normal: THREE.Vector3 | null;
  material: string;
  map: string;
  instanceId?: number;
  object: string;
}
interface Snapshot {
  hits: Hit[];
}

const store = { on: false, snap: null as Snapshot | null, listeners: new Set<() => void>() };
const emit = () => store.listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  store.listeners.add(l);
  return () => void store.listeners.delete(l);
};
const useStore = <T,>(pick: () => T) => useSyncExternalStore(subscribe, pick);

const textureKind = (t: THREE.Texture | null | undefined) => {
  if (!t) return "";
  const kind = (t as THREE.CanvasTexture).isCanvasTexture ? "CanvasTexture" : (t as THREE.DataTexture).isDataTexture ? "DataTexture" : "Texture";
  const img = t.image as { constructor?: { name?: string }; width?: number; height?: number } | null;
  return `${kind}${img?.width ? ` ${img.width}x${img.height}` : ""}${img?.constructor?.name ? ` (${img.constructor.name})` : ""}`;
};

const describeMaterial = (m: THREE.Material | undefined) => {
  if (!m) return { material: "none", map: "" };
  const c = (m as THREE.MeshStandardMaterial).color;
  const maps = (["map", "roughnessMap", "metalnessMap", "alphaMap", "envMap"] as const)
    .map((k) => [k, textureKind((m as unknown as Record<string, THREE.Texture | null>)[k])] as const)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);
  return { material: `${m.type}${c ? ` #${c.getHexString()}` : ""} side=${["Front", "Back", "Double"][m.side]}${m.transparent ? " transparent" : ""}`, map: maps.join(", ") };
};

const tagOf = (o: THREE.Object3D) => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const t = (p.userData as { debug?: DebugTag }).debug;
    if (t) return t;
  }
  return null;
};

const toHit = (h: THREE.Intersection): Hit => {
  const o = h.object as THREE.Mesh;
  const tag = tagOf(o);
  const info: HitInfo = { instanceId: h.instanceId, faceIndex: h.faceIndex ?? undefined };
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const { material, map } = describeMaterial(mats[h.face?.materialIndex ?? 0] ?? mats[0]);
  return {
    what: tag?.what ?? "UNTAGGED",
    source: tag?.source ?? "?",
    ref: tag ? (typeof tag.ref === "function" ? tag.ref(info) : (tag.ref ?? "")) : "",
    note: tag?.note ?? "",
    component: tag?.component ?? "?",
    dist: h.distance,
    point: h.point,
    normal: h.face ? h.face.normal.clone().transformDirection(o.matrixWorld) : null,
    material,
    map,
    instanceId: h.instanceId,
    object: `${o.type}${o.name ? ` "${o.name}"` : ""}${o.parent?.name ? ` in "${o.parent.name}"` : ""}`,
  };
};

const PROBE_PERIOD_S = 0.1;
const CENTRE = new THREE.Vector2(0, 0);
const MESH_RAYCAST = THREE.Mesh.prototype.raycast;
const INSTANCED_RAYCAST = THREE.InstancedMesh.prototype.raycast;

/** Inside the Canvas, road view only: casts the centre ray at ~10 Hz while the inspector is on. */
export const DebugProbe = () => {
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const acc = useRef(0);
  useEffect(
    () => () => {
      store.snap = null;
      emit();
    },
    [],
  );
  useFrame(({ camera, scene }, dt) => {
    if (!store.on) return;
    acc.current += dt;
    if (acc.current < PROBE_PERIOD_S) return;
    acc.current = 0;
    raycaster.setFromCamera(CENTRE, camera);
    raycaster.near = 0;
    raycaster.far = Infinity;
    const hits: THREE.Intersection[] = [];
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.every((m) => m && !m.visible)) return;
      (((o as THREE.InstancedMesh).isInstancedMesh ? INSTANCED_RAYCAST : MESH_RAYCAST) as typeof MESH_RAYCAST).call(mesh, raycaster, hits);
    });
    hits.sort((a, b) => a.distance - b.distance);
    store.snap = { hits: hits.slice(0, 3).map(toHit) };
    emit();
  });
  return null;
};

const f = (n: number) => n.toFixed(2);
const v3 = (v: THREE.Vector3) => `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;

/** DOM overlay (outside the Canvas, road view only): Backquote toggles it; crosshair plus the hit panel. */
export const DebugHud = () => {
  const on = useStore(() => store.on);
  const snap = useStore(() => store.snap);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Backquote" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      store.on = !store.on;
      store.snap = null;
      emit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!on) return null;
  const [h, ...behind] = snap?.hits ?? [];
  return (
    <>
      <div className="dbg-crosshair" aria-hidden />
      <div className="dbg-hud">
        {!h ? (
          <div>(no hit)</div>
        ) : (
          <>
            <div className="dbg-what">
              {h.what} <span className="dbg-dim">· {h.source}{h.ref ? ` · ${h.ref}` : ""}</span>
            </div>
            {h.note && <div>note: {h.note}</div>}
            <div>component: {h.component}</div>
            <div>dist: {f(h.dist)} m  point: {v3(h.point)}</div>
            <div>normal: {h.normal ? v3(h.normal) : "-"}</div>
            <div>material: {h.material}</div>
            {h.map && <div>maps: {h.map}</div>}
            {h.instanceId !== undefined && <div>instanceId: {h.instanceId}</div>}
            {h.what === "UNTAGGED" && <div>object: {h.object}</div>}
            {behind.map((b, i) => (
              <div key={i} className="dbg-dim">
                +{i + 1}: {b.what} · {b.source}{b.ref ? ` ${b.ref}` : ""} · {f(b.dist)} m ({f(b.dist - h.dist)} behind)
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
};
