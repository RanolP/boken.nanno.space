import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { MapData } from "../maps/types";
import type { ViewMode } from "./walk";

interface Props {
  data: MapData;
  mode: ViewMode;
}

/** Drone view tilts down over the halls; full-height walls would hide the booths behind them. */
const DRONE_WALL_M = 1.5;
const PARTITION_W_M = 0.3;

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
  const seamMat = useMemo(() => new THREE.MeshStandardMaterial({ color: "#d4d8df" }), []);
  const roadWallMat = useMemo(makeRoadWallMaterial, []);
  useEffect(() => () => roadWallMat.dispose(), [roadWallMat]);
  if (!s) return null;
  const drone = mode === "drone";
  const pieces: { key: string; r: Run; y0: number; y1: number; t: number }[] = [];
  for (const [i, w] of s.walls.entries()) {
    pieces.push({ key: `w${i}`, r: run(w.a, w.b, m), y0: 0, y1: drone ? Math.min(DRONE_WALL_M, w.heightM) : w.heightM, t: w.thicknessM });
  }
  // A door head only shows once walls rise above it (road view).
  if (!drone) {
    for (const [i, o] of s.openings.entries()) {
      if (o.heightM !== undefined) pieces.push({ key: `o${i}`, r: run(o.a, o.b, m), y0: o.heightM, y1: s.ceilingM, t: 0.4 });
    }
  }
  return (
    <group>
      {pieces.map(({ key, r, y0, y1, t }) => (
        <mesh
          key={key}
          geometry={box}
          material={drone ? wallMat : roadWallMat}
          position={[r.cx, (y0 + y1) / 2, r.cz]}
          rotation={[0, r.angle, 0]}
          scale={[r.len + t, y1 - y0, t]}
        />
      ))}
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
