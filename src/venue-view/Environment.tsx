import { useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import * as THREE from "three";

/** Eye height of the road-view walker (CameraRigs `EYE_H`): a probe sees its hall from where a visitor stands. */
const PROBE_EYE_M = 1.6;
/** Cube face size of the capture; PMREM blurs it per roughness level, so the sharpest mip is all this needs. */
const PROBE_FACE_PX = 256;
const PROBE_FAR_M = 1000;

/** A hall's floor-plan rect in meters, `[x0, z0, x1, z1]`. */
export type HallRect = [number, number, number, number];
/** A hall's floor polygon in meters, `[x, z]` per vertex. */
export type HallPolygon = [number, number][];
export type HallProbe = { id: string; rect: HallRect; polygon?: HallPolygon; envMap: THREE.Texture };

/**
 * Where a hall's probe stands: the area centroid of its polygon (an L-shaped hall's bounding-box centre can sit in
 * the notch), else the rect centre; the rect centre also when the centroid falls outside the polygon.
 */
const probeXZ = ({ rect, polygon }: { rect: HallRect; polygon?: HallPolygon }): [number, number] => {
  const centre: [number, number] = [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
  if (!polygon || polygon.length < 3) return centre;
  let a = 0;
  let cx = 0;
  let cz = 0;
  polygon.forEach(([x0, z0], i) => {
    const [x1, z1] = polygon[(i + 1) % polygon.length];
    const k = x0 * z1 - x1 * z0;
    a += k;
    cx += (x0 + x1) * k;
    cz += (z0 + z1) * k;
  });
  if (!a) return centre;
  const c: [number, number] = [cx / (3 * a), cz / (3 * a)];
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, az] = polygon[i];
    const [bx, bz] = polygon[j];
    if (az > c[1] !== bz > c[1] && c[0] < ax + ((c[1] - az) * (bx - ax)) / (bz - az)) inside = !inside;
  }
  return inside ? c : centre;
};

const materialsOf = (o: THREE.Mesh): THREE.Material[] => (Array.isArray(o.material) ? o.material : [o.material]);

/** Probes of the mounted road view, per scene, so metal outside HallInterior (BuildingDetails) can take one. */
type Store = { probes: HallProbe[]; listeners: Set<() => void> };
const stores = new WeakMap<THREE.Scene, Store>();
const storeOf = (scene: THREE.Scene): Store => {
  let s = stores.get(scene);
  if (!s) stores.set(scene, (s = { probes: [], listeners: new Set() }));
  return s;
};
const publish = (scene: THREE.Scene, probes: HallProbe[]) => {
  const s = storeOf(scene);
  s.probes = probes;
  for (const l of s.listeners) l();
};

/**
 * One reflection probe per hall, prefiltered (PMREM) for metal materials to take as `envMap`: a CubeCamera render of
 * the scene from the hall's centre at eye height, so a hall's steel trench covers show that hall's own ceiling and
 * walls. A PBR metal has no diffuse term, so it shows only what its environment holds.
 *
 * Static probes, as in any engine's baked reflection probes: `capture()` renders them once, and the caller runs it
 * when the scene content they reflect has loaded (and again only if that content changes). Meshes that use a probe
 * are hidden while it is captured, so a reflector never reflects itself.
 *
 * Passed per metal material rather than set as `scene.environment`: a scene environment also adds diffuse light to
 * every matte surface and breaks the ambient + directional model `contrast.ts` checks sign legibility against.
 * The PMREM targets are allocated up front (from a black cube) so materials built on them keep the same texture
 * through captures, and are disposed when the halls change or the caller unmounts.
 */
export const useHallProbes = (halls: { id: string; rect: HallRect; polygon?: HallPolygon }[]) => {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const rig = useMemo(() => {
    const cubeTarget = new THREE.WebGLCubeRenderTarget(PROBE_FACE_PX, { type: THREE.HalfFloatType });
    const camera = new THREE.CubeCamera(0.05, PROBE_FAR_M, cubeTarget);
    const pmrem = new THREE.PMREMGenerator(gl);
    const targets = halls.map(() => pmrem.fromCubemap(cubeTarget.texture));
    const probes: HallProbe[] = halls.map((h, i) => ({ id: h.id, rect: h.rect, polygon: h.polygon, envMap: targets[i].texture }));
    return { cubeTarget, camera, pmrem, targets, probes };
  }, [gl, halls]);

  useEffect(() => {
    publish(scene, rig.probes);
    return () => {
      publish(scene, []);
      for (const t of rig.targets) t.dispose();
      rig.pmrem.dispose();
      rig.cubeTarget.dispose();
    };
  }, [scene, rig]);

  const capture = useCallback(() => {
    rig.probes.forEach((p, i) => {
      const [x, z] = probeXZ(p);
      rig.camera.position.set(x, PROBE_EYE_M, z);
      rig.camera.updateMatrixWorld();
      const self: THREE.Object3D[] = [];
      scene.traverseVisible((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && materialsOf(mesh).some((m) => (m as THREE.MeshStandardMaterial).envMap === p.envMap)) self.push(mesh);
      });
      for (const o of self) o.visible = false;
      rig.camera.update(gl, scene);
      for (const o of self) o.visible = true;
      rig.pmrem.fromCubemap(rig.cubeTarget.texture, rig.targets[i]);
    });
  }, [gl, scene, rig]);

  return { probes: rig.probes, capture };
};

/**
 * The probe of the hall whose x-span holds `x` (nearest hall if none), or null while no road view is mounted. The
 * halls tile the building west to east, so the x-span picks the same hall a point-in-polygon test would.
 */
export const useHallEnvMapAt = (x: number): THREE.Texture | null => {
  const scene = useThree((s) => s.scene);
  const subscribe = useCallback(
    (l: () => void) => {
      const s = storeOf(scene);
      s.listeners.add(l);
      return () => void s.listeners.delete(l);
    },
    [scene],
  );
  const probes = useSyncExternalStore(subscribe, () => storeOf(scene).probes);
  if (!probes.length) return null;
  const dist = (p: HallProbe) => Math.max(p.rect[0] - x, x - p.rect[2], 0);
  return probes.reduce((a, b) => (dist(b) < dist(a) ? b : a)).envMap;
};
