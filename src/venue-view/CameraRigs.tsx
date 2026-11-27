import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { stageKey, stageOfArea, type MapData, type StageId } from "../maps/types";
import { isRunning, isTypingTarget, collide, freeSpotNear, lookBooth, lookFloorSpot, moveAxes, obstaclesOf, rectAt, rectOf, spotFacing, type MoveInput, type Pose } from "./walk";
import { DOOR_REACH_M, doorLeaves, getAimBooth, getAimDoor, setAimBooth, setAimDoor, setAimStage, setPointerLocked, setTeleportable, toggleDoor } from "./roadInteract";
import { BOOTH_H } from "./BoothFrame";

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
  /** A locked click on the booth under the crosshair selects it instead of teleporting; a right click (null) closes it. */
  onSelect: (code: string | null) => void;
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
      const speed = camera.position.distanceTo(c.target) * 0.3 * (isRunning(input) ? 3 : 1);
      // fwd is unit length and (f, s) at most 1, so a half-pushed stick pans at half speed.
      step.set(fwd.x * f - fwd.z * s, 0, fwd.z * f + fwd.x * s).multiplyScalar(speed * Math.min(dt, 0.1));
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
export const RoadRig = ({ data, booths, flyKey, selected, input, pose, onSelect }: RoadRigProps) => {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const m = data.metersPerPx;
  const W = data.source.widthPx * m;
  const D = data.source.heightPx * m;
  const obstacles = useMemo(() => obstaclesOf(data, booths), [data, booths]);
  // User: the RED/BLUE STAGE opens its timetable on a locked click too. Aimed with the booth ray (lookBooth) over the
  // stage areas' boxes, up to booth height so looking at the performers above the deck counts.
  const stageAim = useMemo(() => {
    const at = data.areas.flatMap((a) => {
      const s = stageOfArea(a);
      return s ? [{ s, r: rectOf(a, m) }] : [];
    });
    return { ids: at.map((x) => x.s), obs: { ...obstacles, booths: at.map((x) => x.r) } };
  }, [data, m, obstacles]);
  const aimStage = useRef<StageId | null>(null);
  const walker = useRef<Pose>({ x: W / 2, z: D / 2, yaw: 0 });
  const pitch = useRef(0);
  const devEye = useRef<{ h: number; roll: number } | null>(null);
  const tpRing = useRef<THREE.Group>(null);
  const tpPillar = useRef<THREE.Group>(null);
  const pillarFade = useMemo(() => {
    // Vertical alpha ramp for the light pillar (v = 0 at the floor, 1 at the top).
    const n = 32;
    const px = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) px.fill(Math.round(255 * (1 - i / (n - 1)) ** 1.6), i * 4, i * 4 + 4);
    const t = new THREE.DataTexture(px, 1, n);
    t.needsUpdate = true;
    return t;
  }, []);
  const tpMark = useRef({ key: "", t: 0 });
  // Touch tap on the floor: a short dash from (x0, z0) to (x, z) starting at t0 (performance.now() s). The stick does
  // not cancel it, so a tap works while walking; walking resumes when it lands.
  const glide = useRef<{ x0: number; z0: number; x: number; z: number; t0: number } | null>(null);
  // The booth panel is open while a booth is selected: walking and teleporting stop until it is closed (right click).
  const panelOpen = useRef(selected !== null);
  panelOpen.current = selected !== null;
  const seenFly = useRef(flyKey);
  const bobRef = useRef({ phase: 0, amp: 0, run: false });
  // Jump: eye offset above EYE_H and its vertical speed. Times are performance.now() seconds.
  // input.jump.pressedAt buffers a press made just before landing; groundedAt gives coyote time; input.jump.held repeats on landing.
  const jumpRef = useRef({ y: 0, vy: 0, groundedAt: 0, used: false });
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
    w.__boken = { view: "road", camera, scene, gl, pitch, eye: devEye, get pose() { return walker.current; } };
    return () => {
      delete w.__boken;
    };
  }, [camera, scene, gl]);

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
    // sx/sy/t: where and when the press started; far: the farthest it has strayed, so a drag that comes back is no tap.
    let drag: { id: number; x: number; y: number; sx: number; sy: number; t: number; far: number; touch: boolean } | null = null;
    let lastType = "mouse";
    // Event timestamp until which the click a touch tap may still produce is swallowed (see lockClick).
    let swallowUntil = -Infinity;
    const down = (e: PointerEvent) => {
      lastType = e.pointerType;
      if (document.pointerLockElement === el && e.button === 0) {
        teleport();
        return;
      }
      if (document.pointerLockElement === el || drag || (e.pointerType === "mouse" && e.button !== 0)) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: e.timeStamp, far: 0, touch: e.pointerType !== "mouse" };
    };
    // User: touch has no crosshair, so a tap acts on the spot under the finger: the door, booth or stage there, else
    // the walker glides to that floor spot. Same rules as the locked click, aimed along the tap's ray instead.
    const tapAt = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      tapNdc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
      aimRay.setFromCamera(tapNdc, camera);
      const dir = aimRay.ray.direction;
      const yaw = Math.atan2(-dir.x, -dir.z);
      const pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
      aimRay.far = DOOR_REACH_M;
      let door: number | null = null;
      let best = Infinity;
      for (const leaf of doorLeaves) {
        const hit = aimRay.intersectObject(leaf.object, true)[0];
        if (hit && hit.distance < best) {
          best = hit.distance;
          door = leaf.i;
        }
      }
      if (door !== null) {
        toggleDoor(door);
        return;
      }
      if (panelOpen.current) return;
      const w = walker.current;
      const eye = devEye.current?.h ?? EYE_H;
      const bi = lookBooth(w, yaw, pitch, eye, BOOTH_H, obstacles, W, D);
      if (bi !== null && booths[bi]) {
        onSelect(booths[bi].code);
        return;
      }
      const si = lookBooth(w, yaw, pitch, eye, BOOTH_H, stageAim.obs, W, D);
      if (si !== null) {
        onSelect(stageKey(stageAim.ids[si]));
        return;
      }
      const to = lookFloorSpot(w, yaw, pitch, eye, obstacles, W, D);
      if (to) glide.current = { x0: w.x, z0: w.z, ...to, t0: performance.now() / 1000 };
    };
    // Pointer lock: the first click on the canvas captures the mouse, then movement alone turns the view (same sensitivity
    // and pitch clamp as the drag). Esc releases it (browser default). The locking click is swallowed here (stopPropagation
    // in the window capture phase, before R3F's handler) so it cannot select the booth under the cursor.
    // Locked left press teleports to the floor spot the crosshair looks at (stops in front of whatever is in the way).
    // On pointerdown rather than click: some browsers do not deliver click while the pointer is locked.
    const teleport = () => {
      // User: door aim wins over teleport; the click toggles the door pair instead.
      const door = getAimDoor();
      if (door !== null) {
        toggleDoor(door);
        return;
      }
      const aimed = getAimBooth();
      if (aimed) {
        // Free the cursor so the card can be scrolled and its link clicked; looking is blocked while it is open anyway.
        document.exitPointerLock();
        onSelect(aimed);
        return;
      }
      if (aimStage.current) {
        document.exitPointerLock();
        onSelect(stageKey(aimStage.current));
        return;
      }
      if (panelOpen.current) return;
      const w = walker.current;
      const to = teleportSpot(w, w.yaw, pitch.current, devEye.current?.h ?? EYE_H, obstacles, W, D);
      if (to) {
        w.x = to.x;
        w.z = to.z;
      }
    };
    const look = (dx: number, dy: number) => {
      walker.current.yaw -= dx * LOOK_RAD_PER_PX;
      pitch.current = THREE.MathUtils.clamp(pitch.current - dy * LOOK_RAD_PER_PX, -1.2, 1.2);
    };
    const lockClick = (e: MouseEvent) => {
      // Locked: the teleport already ran on pointerdown; swallow the click so it cannot also select a booth.
      if (document.pointerLockElement === el) {
        e.stopPropagation();
        return;
      }
      // Touch: the tap already acted on pointerup (browsers send no click for a tap while another finger, such as the
      // stick's, is down). The click a lone tap still produces would land on the card backdrop (.panel-dim) that tap just
      // opened and close it, or reach R3F as a miss: swallow it. Never lock (phones have no pointer lock).
      if (lastType !== "mouse" && (e.target === el || e.timeStamp < swallowUntil)) {
        e.stopPropagation();
        e.preventDefault();
        return;
      }
      // Open card: the click that follows the opening press lands on the now-unlocked canvas and must not re-lock it.
      if (e.target !== el || panelOpen.current) return;
      e.stopPropagation();
      void el.requestPointerLock?.();
    };
    const lockMove = (e: MouseEvent) => {
      if (document.pointerLockElement === el && !panelOpen.current) look(e.movementX, e.movementY);
    };
    const lockChange = () => setPointerLocked(document.pointerLockElement === el);
    window.addEventListener("click", lockClick, true);
    window.addEventListener("mousemove", lockMove);
    document.addEventListener("pointerlockchange", lockChange);
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.far = Math.max(drag.far, Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy));
      if (panelOpen.current) {
        drag.x = e.clientX;
        drag.y = e.clientY;
        return;
      }
      walker.current.yaw -= (e.clientX - drag.x) * LOOK_RAD_PER_PX;
      pitch.current = THREE.MathUtils.clamp(pitch.current - (e.clientY - drag.y) * LOOK_RAD_PER_PX, -1.2, 1.2);
      drag.x = e.clientX;
      drag.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      const tap = drag.touch && drag.far < TAP_SLOP_PX && e.timeStamp - drag.t < TAP_MS;
      drag = null;
      if (!tap) return;
      swallowUntil = e.timeStamp + TAP_CLICK_MS;
      tapAt(e.clientX, e.clientY);
    };
    const cancel = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    return () => {
      window.removeEventListener("click", lockClick, true);
      window.removeEventListener("mousemove", lockMove);
      document.removeEventListener("pointerlockchange", lockChange);
      if (document.pointerLockElement === el) document.exitPointerLock();
      setPointerLocked(false);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
  }, [gl, camera, booths, obstacles, stageAim, onSelect]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (e.repeat) return;
        input.jump.held = true;
        input.jump.pressedAt = performance.now() / 1000;
        return;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") input.jump.held = false;
    };
    // A key released while the window is unfocused never sends keyup; stop hold-repeat instead of hopping forever.
    const onBlur = () => {
      input.jump.held = false;
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      setAimDoor(null);
      setAimStage(null);
      setAimBooth(null);
      setTeleportable(false);
    };
  }, [input]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const w = walker.current;
    const bob = bobRef.current;
    const { f, s } = panelOpen.current ? { f: 0, s: 0 } : moveAxes(input);
    const x0 = w.x;
    const z0 = w.z;
    const g = panelOpen.current ? null : glide.current;
    const gliding = g !== null;
    if (g) {
      // Fixed-length dash with an ease-out (cubic), the same for a near and a far tap. lookFloorSpot already marched
      // the straight path clear, so the dash only interpolates; collide below still keeps it off anything new.
      const k = Math.min(1, (performance.now() / 1000 - g.t0) / DASH_S);
      const e = 1 - (1 - k) ** 3;
      w.x = g.x0 + (g.x - g.x0) * e;
      w.z = g.z0 + (g.z - g.z0) * e;
      if (k === 1) glide.current = null;
    } else glide.current = null;
    if ((f || s) && !gliding) {
      bob.run = isRunning(input);
      // (f, s) is at most length 1: full speed on keys or a fully pushed stick, slower for a partly pushed one.
      const speed = bob.run ? RUN : WALK;
      const sin = Math.sin(w.yaw);
      const cos = Math.cos(w.yaw);
      w.x += (-sin * f + cos * s) * speed * dt;
      w.z += (-cos * f - sin * s) * speed * dt;
    }
    // Also runs at rest, so a booth un-hidden on top of the walker pushes it out.
    collide(w, obstacles, W, D);
    const jump = jumpRef.current;
    const now = performance.now() / 1000;
    if (jump.y === 0 && jump.vy <= 0) {
      jump.groundedAt = now;
      jump.used = false;
    }
    if (panelOpen.current) {
      input.jump.pressedAt = -Infinity;
    } else if (!jump.used && now - jump.groundedAt <= COYOTE_S) {
      const buffered = now - input.jump.pressedAt <= JUMP_BUFFER_S;
      const repeat = input.jump.held && jump.y === 0;
      if (buffered || repeat) {
        jump.vy = JUMP_V;
        jump.used = true;
        input.jump.pressedAt = -Infinity;
      }
    }
    if (jump.vy || jump.y) {
      jump.vy -= GRAVITY * dt;
      jump.y += jump.vy * dt;
      if (jump.y <= 0) jump.y = jump.vy = 0;
    }
    // View bob rides on the camera only; the walker/collision position stays untouched. Phase advances by the
    // distance actually covered after collision, so pushing into a wall does not bob.
    const dist = Math.hypot(w.x - x0, w.z - z0);
    const nominal = bob.run ? RUN : WALK;
    const bobbing = !gliding && dist > BOB_MOVE_FRAC * nominal * dt && !reducedMotion.matches && !devEye.current && jump.y === 0;
    if (bobbing) bob.phase += dist / (nominal / (bob.run ? RUN_CADENCE : WALK_CADENCE));
    // Frame-rate independent exponential ease: amplitude chases its target and is ~0 within ~0.15 s of stopping.
    const target = bobbing ? (bob.run ? RUN_BOB_PP : WALK_BOB_PP) : 0;
    bob.amp += (target - bob.amp) * (1 - Math.exp(-dt / BOB_TAU));
    const bobY = bob.amp * (Math.abs(Math.sin(Math.PI * bob.phase)) - 2 / Math.PI);
    const bobX = bob.amp * LATERAL_RATIO * Math.sin(Math.PI * bob.phase);
    camera.position.set(w.x + Math.cos(w.yaw) * bobX, (devEye.current?.h ?? EYE_H) + bobY + jump.y, w.z - Math.sin(w.yaw) * bobX);
    camera.rotation.set(pitch.current, w.yaw, devEye.current?.roll ?? 0, "YXZ");
    pose.current = { x: w.x, z: w.z, yaw: w.yaw };

    // Teleport marker: a floor ring where a locked left click would land. The march is costly (every obstacle per
    // 10 cm step), so it reruns only when the view moved and at most every TP_MARK_EVERY_S.
    const ring = tpRing.current;
    if (ring) {
      const mark = tpMark.current;
      mark.t += dt;
      const key = `${w.x.toFixed(2)},${w.z.toFixed(2)},${w.yaw.toFixed(3)},${pitch.current.toFixed(3)},${panelOpen.current}`;
      if (document.pointerLockElement !== gl.domElement) {
        // Unlocked (touch): the ring marks where a tap is gliding to.
        ring.visible = glide.current !== null;
        if (glide.current) ring.position.set(glide.current.x, TP_RING_Y, glide.current.z);
        mark.key = "";
        setAimBooth(null);
        setAimDoor(null);
        setAimStage(null);
        setTeleportable(false);
        aimStage.current = null;
      } else if (key !== mark.key && mark.t >= TP_MARK_EVERY_S) {
        mark.key = key;
        mark.t = 0;
        const eye = devEye.current?.h ?? EYE_H;
        // Looking at a booth: no teleport marker; the booth gets the aim outline and the probe HUD instead.
        // A door leaf under the crosshair within reach beats booth, stage and teleport aim alike.
        let di: number | null = null;
        if (!panelOpen.current && doorLeaves.size) {
          aimRay.set(camera.getWorldPosition(aimOrigin), camera.getWorldDirection(aimDir));
          aimRay.far = DOOR_REACH_M;
          let best = Infinity;
          for (const leaf of doorLeaves) {
            const hit = aimRay.intersectObject(leaf.object, true)[0];
            if (hit && hit.distance < best) {
              best = hit.distance;
              di = leaf.i;
            }
          }
        }
        setAimDoor(di);
        const bi = di !== null ? null : lookBooth(w, w.yaw, pitch.current, eye, BOOTH_H, obstacles, W, D);
        setAimBooth(bi === null ? null : (booths[bi]?.code ?? null));
        const si = bi === null && di === null ? lookBooth(w, w.yaw, pitch.current, eye, BOOTH_H, stageAim.obs, W, D) : null;
        aimStage.current = si === null ? null : stageAim.ids[si];
        setAimStage(aimStage.current);
        const to = bi === null && si === null && di === null && !panelOpen.current ? teleportSpot(w, w.yaw, pitch.current, eye, obstacles, W, D) : null;
        ring.visible = to !== null;
        setTeleportable(to !== null);
        if (to) ring.position.set(to.x, TP_RING_Y, to.z);
      }
      // Past TP_SCALE_FROM_M the on-screen size (scale / distance) shrinks like 1 / (1 + ln(d / d0)) instead of 1 / d,
      // so a far marker still reads smaller but fades only logarithmically. scale = x / (1 + ln x), x = d / d0: 1 with zero
      // slope at d0 (no kink), about 3 at 10 d0.
      const x = Math.hypot(ring.position.x - w.x, ring.position.z - w.z) / TP_SCALE_FROM_M;
      const s = x > 1 ? x / (1 + Math.log(x)) : 1;
      ring.scale.setScalar(s);
      // The pillar's height keeps a constant on-screen length past TP_PILLAR_FULL_FROM_M so it still clears booths when far.
      if (tpPillar.current) {
        tpPillar.current.scale.y = Math.max(s, (x * TP_SCALE_FROM_M) / TP_PILLAR_FULL_FROM_M) / s;
        // Same cut-off as the teleport itself, so a shown ring always carries its pillar.
        tpPillar.current.visible = x * TP_SCALE_FROM_M >= TP_MIN_M;
      }
    }
  });

  return (
    <group ref={tpRing} visible={false}>
      <mesh rotation-x={-Math.PI / 2} renderOrder={10}>
        <torusGeometry args={[TP_RING_R, TP_RING_TUBE, 12, 48]} />
        <meshBasicMaterial color={TP_COLOR} transparent opacity={0.85} depthWrite={false} />
      </mesh>
      {/* Light pillar so a far target still reads: an open tube, brightest at the floor and fading out upward. */}
      <group ref={tpPillar}>
        <mesh position-y={TP_PILLAR_H / 2} renderOrder={10}>
          <cylinderGeometry args={[TP_RING_R * 0.8, TP_RING_R * 0.8, TP_PILLAR_H, 32, 1, true]} />
          <meshBasicMaterial color={TP_COLOR} alphaMap={pillarFade} transparent opacity={0.7} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>
      </group>
    </group>
  );
};

/** Drone distance from the walker when switching back from road view. */
const HANDOFF_DIST = 45;
const EYE_H = 1.6;
const GRAVITY = 9.8;
// Take-off speed for a ~0.45 m hop: v = sqrt(2gh).
const JUMP_V = Math.sqrt(2 * GRAVITY * 0.45);
// Coyote time: a jump still starts this long after last touching the ground.
const COYOTE_S = 0.1;
// Input buffer: a press this long before landing jumps on landing.
const JUMP_BUFFER_S = 0.15;
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
// Teleport marker ring: outer radius about the walker's footprint, lifted just off the floor paint.
const TP_RING_R = 0.35;
const TP_RING_TUBE = 0.04;
const TP_RING_Y = 0.05;
const TP_MARK_EVERY_S = 1 / 20;
const TP_PILLAR_H = 3;
const aimRay = new THREE.Raycaster();
const tapNdc = new THREE.Vector2();
// A touch press is a tap (interact) when it stays within this many CSS px and lifts within TAP_MS; otherwise it looked around.
const TAP_SLOP_PX = 10;
// Event timestamps, not handler time: a janky frame that delays pointerup must not turn a tap into a long press.
const TAP_MS = 600;
// After a touch tap acts, its own click (sent up to ~300 ms later) is swallowed for this long.
const TAP_CLICK_MS = 700;
// Tap dash length in seconds: quick enough to feel like the desktop teleport, long enough to see where you went.
const DASH_S = 0.3;
const aimOrigin = new THREE.Vector3();
const aimDir = new THREE.Vector3();
const TP_SCALE_FROM_M = 4;
const TP_PILLAR_FULL_FROM_M = 8;
// User: "텔레포트 빛 사라질 때 그냥 불가 처리해버리자 로직 2개 짜친다": one cut-off. A floor spot nearer than this is
// walking distance (and its light pillar would just fill the view): no marker, no pillar, no teleport.
const TP_MIN_M = 3;
const teleportSpot = (...args: Parameters<typeof lookFloorSpot>) => {
  const to = lookFloorSpot(...args);
  return to && Math.hypot(to.x - args[0].x, to.z - args[0].z) >= TP_MIN_M ? to : null;
};
const TP_COLOR = "#38bdf8";
