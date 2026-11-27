import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { MapData } from "../maps/types";
import { AREA_STYLE } from "./Scene";
import type { Pose } from "./walk";

type Booth = MapData["booths"][number];

interface MinimapProps {
  data: MapData;
  booths: Booth[];
  selected: string | null;
  pose: RefObject<Pose | null>;
}

/** Metres the minimap shows from its centre to an edge (its CSS size is in styles.css). */
const RADIUS_M = 30;
/** Texels per metre of the pre-drawn plan; above the 200 px minimap's 3.3 px/m times devicePixelRatio, so it stays sharp. */
const PLAN_TEX_PER_M = 8;

/**
 * Road view, bottom right: the plan around the walker, heading up (the map turns, the arrow always points up), redrawn
 * every frame from the walker pose RoadRig writes. The plan itself is drawn once into an offscreen canvas.
 */
export const Minimap = ({ data, booths, selected, pose }: MinimapProps) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const plan = useMemo(() => drawPlan(data, booths, selected), [data, booths, selected]);

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    // Pose and size last drawn: standing still redraws nothing (a full-plan drawImage every frame adds up on phones).
    let drawn = "";
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dpr = window.devicePixelRatio || 1;
      const n = Math.round(c.clientWidth * dpr);
      const p = pose.current;
      const key = p ? `${n},${p.x},${p.z},${p.yaw}` : `${n}`;
      if (key === drawn) return;
      drawn = key;
      if (c.width !== n) c.width = c.height = n;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = OUTSIDE;
      ctx.fillRect(0, 0, n, n);
      if (!p) return;
      const k = n / 2 / RADIUS_M;
      // Walker at the centre; rotating by yaw brings its forward (-sin yaw, -cos yaw) on the plan to screen up.
      ctx.translate(n / 2, n / 2);
      ctx.rotate(p.yaw);
      ctx.scale(k / PLAN_TEX_PER_M, k / PLAN_TEX_PER_M);
      ctx.drawImage(plan, -p.x * PLAN_TEX_PER_M, -p.z * PLAN_TEX_PER_M);
      // Walker: view wedge and arrow, unrotated.
      ctx.setTransform(1, 0, 0, 1, n / 2, n / 2);
      const u = n / 200;
      const r = 9 * u;
      ctx.fillStyle = "#3b5bdb33";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 44 * u, -Math.PI / 2 - 0.61, -Math.PI / 2 + 0.61);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.75, r * 0.8);
      ctx.lineTo(0, r * 0.35);
      ctx.lineTo(-r * 0.75, r * 0.8);
      ctx.closePath();
      ctx.fillStyle = "#3b5bdb";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 * u;
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.fill();
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [plan, pose]);

  return <canvas ref={canvas} className="minimap" aria-hidden />;
};

/** Outside the halls, and the hall floor. */
const OUTSIDE = "#d5dae3";
const FLOOR = "#ffffff";

/** The whole plan at PLAN_TEX_PER_M, x/z in metres from its top-left: hall floor, raised areas, booths, walls. */
const drawPlan = (data: MapData, booths: Booth[], selected: string | null) => {
  const m = data.metersPerPx;
  const s = PLAN_TEX_PER_M * m;
  const c = Object.assign(document.createElement("canvas"), {
    width: Math.ceil(data.source.widthPx * s),
    height: Math.ceil(data.source.heightPx * s),
  });
  const ctx = c.getContext("2d")!;
  ctx.scale(s, s);
  const poly = (pts: [number, number][]) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  };
  const st = data.structure;
  ctx.fillStyle = st?.outline ? OUTSIDE : FLOOR;
  ctx.fillRect(0, 0, data.source.widthPx, data.source.heightPx);
  if (st?.outline) {
    poly(st.outline);
    ctx.fillStyle = FLOOR;
    ctx.fill();
  }
  for (const a of data.areas) {
    const style = AREA_STYLE[a.kind];
    if (style.h === 0 && !a.color) continue;
    ctx.fillStyle = a.color ?? style.color;
    if (a.polygon) {
      poly(a.polygon);
      ctx.fill();
    } else ctx.fillRect(a.x, a.y, a.w, a.h);
  }
  // Booths: category colour with a thin dark rim so neighbours stay apart; the selected booth gets a thick yellow rim.
  ctx.lineJoin = "round";
  for (const b of booths) {
    ctx.fillStyle = data.categories[b.category]?.color ?? "#8a8f98";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.strokeStyle = "#0006";
    ctx.lineWidth = 0.15 / m;
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  const sel = booths.find((b) => b.code === selected);
  if (sel) {
    ctx.strokeStyle = "#ffcc00";
    ctx.lineWidth = 0.8 / m;
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
  }
  if (st) {
    ctx.strokeStyle = "#5b6070";
    ctx.lineCap = "square";
    for (const w of st.walls) {
      ctx.lineWidth = Math.max(w.thicknessM, 0.4) / m;
      ctx.beginPath();
      ctx.moveTo(...w.a);
      ctx.lineTo(...w.b);
      ctx.stroke();
    }
  }
  return c;
};
