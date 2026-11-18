import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { MapData } from "../maps/types";
import { isTypingTarget, collide, freeSpotNear, moveAxes, obstaclesOf, rectAt, rectOf, spotFacing, type MoveInput, type Pose } from "./walk";
import { getNearDoor, nearestDoor, setNearDoor, setPointerLocked, toggleDoor } from "./roadInteract";

type Booth = MapData["booths"][number];

interface DroneRigProps {
  data: MapData;
  flyKey: number;
  selected: string | null;
  input: MoveInput;
  /** Hand-off between views: the floor point under the view centre and the heading. */
  pose: RefObject<Pose | null>;
}

interface RoadRigProps extends DroneRigProps {
  booths: Booth[];
}

/**
 * Overhead orbit camera. Frames the venue once (or looks at the road-view walker when switched to),
 * flies to the selected booth whenever flyKey changes, and pans with WASD relative to the screen.
 */
export const DroneRig = ({ data, flyKey, selected, input, pose }: DroneRigProps) => {
  const camera = useThree((s) => s.camera);
  const aspect = useThree((s) => s.size.width / s.size.height);
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const seenFly = useRef(flyKey);
  const m = data.metersPerPx;
  const W = data.source.widthPx * m;
  const D = data.source.heightPx * m;

  // Frame on first aspect only; later resizes keep the user's view.
  const home = useMemo(() => {
    const half = Math.tan(THREE.MathUtils.degToRad(45) / 2);
    const dist = Math.max((D * 1.2) / (2 * half), (W * 1.1) / aspect / (2 * half));
    const target = new THREE.Vector3(W / 2, 0, D / 2);
    const pos = target.clone().add(new THREE.Vector3(0, 0.9, 0.45).multiplyScalar(dist));
    return { pos, target, dist };
  }, [W, D]);

  useLayoutEffect(() => {
    const p = pose.current;
    const target = p ? new THREE.Vector3(p.x, 0, p.z) : home.target;
    const pos = p
      ? target.clone().add(new THREE.Vector3(Math.sin(p.yaw) * 0.45, 0.9, Math.cos(p.yaw) * 0.45).multiplyScalar(HANDOFF_DIST))
      : home.pos;
    camera.position.copy(pos);
    camera.lookAt(target);
    controls.current?.target.copy(target);
    controls.current?.update();
  }, [camera, home]);

  // Fly only on explicit search picks (flyKey), not on map clicks or on switching back to this view.
  useLayoutEffect(() => {
    if (flyKey === seenFly.current) return;
    seenFly.current = flyKey;
    const b = data.booths.find((x) => x.code === selected);
    if (!b) return;
    const target = new THREE.Vector3((b.x + b.w / 2) * m, 0, (b.y + b.h / 2) * m);
    const dist = THREE.MathUtils.clamp(Math.max(b.w, b.h) * m * 2.2, 25, 60);
    goal.current = { target, pos: target.clone().add(new THREE.Vector3(0, 0.78, 0.62).multiplyScalar(dist)) };
  }, [flyKey]);

  const fwd = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(), []);
  const step = useMemo(() => new THREE.Vector3(), []);
  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const g = goal.current;
    if (g) {
      const k = 1 - Math.exp(-6 * dt);
      camera.position.lerp(g.pos, k);
      c.target.lerp(g.target, k);
      c.update();
      if (camera.position.distanceTo(g.pos) < 0.05) goal.current = null;
    }
    // Screen-up on the floor: view direction plus camera up share an azimuth, and the sum survives a straight-down view.
    camera.getWorldDirection(fwd);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    fwd.add(up).setY(0).normalize();
    const { f, s } = moveAxes(input);
    if (f || s) {
      goal.current = null;
      const speed = camera.position.distanceTo(c.target) * 0.3 * (input.has("fast") ? 3 : 1);
      step.set(fwd.x * f - fwd.z * s, 0, fwd.z * f + fwd.x * s).normalize().multiplyScalar(speed * Math.min(dt, 0.1));
      const tx = THREE.MathUtils.clamp(c.target.x + step.x, 0, W);
      const tz = THREE.MathUtils.clamp(c.target.z + step.z, 0, D);
      step.set(tx - c.target.x, 0, tz - c.target.z);
      c.target.add(step);
      camera.position.add(step);
      c.update();
    }
    pose.current = { x: c.target.x, z: c.target.z, yaw: Math.atan2(-fwd.x, -fwd.z) };
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      maxPolarAngle={Math.PI / 2.1}
      minDistance={6}
      maxDistance={home.dist * 1.5}
      onStart={() => {
        goal.current = null;
      }}
    />
  );
};

/**
 * First-person camera at eye height. Drag looks around, WASD walks relative to the heading,
 * booths and stages block the way, and a search pick (flyKey) teleports in front of the booth.
 */
export const RoadRig = ({ data, booths, flyKey, selected, input, pose }: RoadRigProps) => {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const m = data.metersPerPx;
  const W = data.source.widthPx * m;
  const D = data.source.heightPx * m;
  const obstacles = useMemo(() => obstaclesOf(data, booths), [data, booths]);
  const walker = useRef<Pose>({ x: W / 2, z: D / 2, yaw: 0 });
  const pitch = useRef(0);
  const devEye = useRef<{ h: number; roll: number } | null>(null);
  const seenFly = useRef(flyKey);
  const bobRef = useRef({ phase: 0, amp: 0, run: false });
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)"), []);

  useLayoutEffect(() => {
    const p = pose.current ?? { x: W / 2, z: D / 2, yaw: 0 };
    // Landing on a booth (the drone was looking at it): stand back from its face on the drone's side instead of against the wall.
    const under = rectAt(p.x, p.z, obstacles);
    walker.current = under
      ? spotFacing(under, { x: p.x + Math.sin(p.yaw) * 50, z: p.z + Math.cos(p.yaw) * 50 }, obstacles, W, D)
      : { ...freeSpotNear(p.x, p.z, obstacles, W, D), yaw: p.yaw };
    pitch.current = 0;
    const prev = { fov: camera.fov, near: camera.near };
    camera.fov = 70;
    camera.near = 0.1;
    camera.updateProjectionMatrix();
    return () => {
      camera.fov = prev.fov;
      camera.near = prev.near;
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  // Dev-only handle for headless checks: `pose` is the live walker (mutable), plus the scene to inspect.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __boken?: unknown };
    // `eye` overrides eye height and roll so a photo-match check can stand exactly at a solved photo camera.
    w.__boken = { view: "road", camera, scene, pitch, eye: devEye, get pose() { return walker.current; } };
    return () => {
      delete w.__boken;
    };
  }, [camera, scene]);

  useLayoutEffect(() => {
    if (flyKey === seenFly.current) return;
    seenFly.current = flyKey;
    const b = data.booths.find((x) => x.code === selected);
    if (!b) return;
    walker.current = spotFacing(rectOf(b, m), walker.current, obstacles, W, D);
    pitch.current = 0;
  }, [flyKey]);

  // Drag to look, FPS style for mouse and touch alike: the view follows the pointer (drag right looks right, drag up
  // looks up). Positive yaw/pitch turn left/up, hence the minus. R3F's onClick ignores drags via ThreeEvent.delta.
  useEffect(() => {
    const el = gl.domElement;
    let drag: { id: number; x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (document.pointerLockElement === el || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    };
    // Pointer lock: the first click on the canvas captures the mouse, then movement alone turns the view (same sensitivity
    // and pitch clamp as the drag). Esc releases it (browser default). The locking click is swallowed here (stopPropagation
    // in the window capture phase, before R3F's handler) so it cannot select the booth under the cursor.
    const look = (dx: number, dy: number) => {
      walker.current.yaw -= dx * LOOK_RAD_PER_PX;
      pitch.current = THREE.MathUtils.clamp(pitch.current - dy * LOOK_RAD_PER_PX, -1.2, 1.2);
    };
    const lockClick = (e: MouseEvent) => {
      if (e.target !== el || document.pointerLockElement === el) return;
      e.stopPropagation();
      void el.requestPointerLock?.();
    };
    const lockMove = (e: MouseEvent) => {
      if (document.pointerLockElement === el) look(e.movementX, e.movementY);
    };
    const lockChange = () => setPointerLocked(document.pointerLockElement === el);
    window.addEventListener("click", lockClick, true);
    window.addEventListener("mousemove", lockMove);
    document.addEventListener("pointerlockchange", lockChange);
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      walker.current.yaw -= (e.clientX - drag.x) * LOOK_RAD_PER_PX;
      pitch.current = THREE.MathUtils.clamp(pitch.current - (e.clientY - drag.y) * LOOK_RAD_PER_PX, -1.2, 1.2);
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("click", lockClick, true);
      window.removeEventListener("mousemove", lockMove);
      document.removeEventListener("pointerlockchange", lockChange);
      if (document.pointerLockElement === el) document.exitPointerLock();
      setPointerLocked(false);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [gl]);

  // E toggles the nearest exit door within reach (both leaves together).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "KeyE" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const i = getNearDoor();
      if (i !== null) toggleDoor(i);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setNearDoor(null);
    };
  }, []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const w = walker.current;
    const bob = bobRef.current;
    const { f, s } = moveAxes(input);
    const x0 = w.x;
    const z0 = w.z;
    if (f || s) {
      bob.run = input.has("fast");
      const speed = (bob.run ? RUN : WALK) / Math.hypot(f, s);
      const sin = Math.sin(w.yaw);
      const cos = Math.cos(w.yaw);
      w.x += (-sin * f + cos * s) * speed * dt;
      w.z += (-cos * f - sin * s) * speed * dt;
    }
    // Also runs at rest, so a booth un-hidden on top of the walker pushes it out.
    collide(w, obstacles, W, D);
    setNearDoor(nearestDoor(w.x, w.z));
    // View bob rides on the camera only; the walker/collision position stays untouched. Phase advances by the
    // distance actually covered after collision, so pushing into a wall does not bob.
    const dist = Math.hypot(w.x - x0, w.z - z0);
    const nominal = bob.run ? RUN : WALK;
    const bobbing = dist > BOB_MOVE_FRAC * nominal * dt && !reducedMotion.matches && !devEye.current;
    if (bobbing) bob.phase += dist / (nominal / (bob.run ? RUN_CADENCE : WALK_CADENCE));
    // Frame-rate independent exponential ease: amplitude chases its target and is ~0 within ~0.15 s of stopping.
    const target = bobbing ? (bob.run ? RUN_BOB_PP : WALK_BOB_PP) : 0;
    bob.amp += (target - bob.amp) * (1 - Math.exp(-dt / BOB_TAU));
    const bobY = bob.amp * (Math.abs(Math.sin(Math.PI * bob.phase)) - 2 / Math.PI);
    const bobX = bob.amp * LATERAL_RATIO * Math.sin(Math.PI * bob.phase);
    camera.position.set(w.x + Math.cos(w.yaw) * bobX, (devEye.current?.h ?? EYE_H) + bobY, w.z - Math.sin(w.yaw) * bobX);
    camera.rotation.set(pitch.current, w.yaw, devEye.current?.roll ?? 0, "YXZ");
    pose.current = { x: w.x, z: w.z, yaw: w.yaw };
  });

  return null;
};

/** Drone distance from the walker when switching back from road view. */
const HANDOFF_DIST = 45;
const EYE_H = 1.6;
// Doubled from 2.3 / 4.2 m/s (real pace felt sluggish across 70 m halls). Bob cadence below stays per step.
const WALK = 4.6;
const RUN = 8.4;
// View bob. A step is one foot strike; the head is lowest at each strike, so vertical offset is |sin(pi*phase)| per
// step and lateral sway is sin(pi*phase) (half the step frequency). Cadence (steps/s): race walking 2.99 Hz at 12 km/h
// (Hanley et al., PMC6191987); running 150.02 + 6.012*V spm = 175 spm = 2.92 Hz at 4.2 m/s (Van Oeveren 2019).
const WALK_CADENCE = 3.0;
const RUN_CADENCE = 2.92;
// Peak-to-peak vertical excursion (m): walking 4-5 cm (doi 10.1016/S0167-9457(03)00085-X); running 7.6 cm (Cavanagh 1977,
// quoted in Pletta 2016, journalcra.com/sites/default/files/issue-pdf/8495.pdf). Lateral amplitude is half the vertical amplitude.
const WALK_BOB_PP = 0.04;
const RUN_BOB_PP = 0.076;
const LATERAL_RATIO = 0.25;
const BOB_TAU = 0.04;
const BOB_MOVE_FRAC = 0.3;
const LOOK_RAD_PER_PX = 0.004;
