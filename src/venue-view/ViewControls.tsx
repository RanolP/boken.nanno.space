import { Fragment, useEffect, useRef, type CSSProperties, type PointerEvent } from "react";
import type { MoveInput, MoveKey, ViewMode } from "./walk";
import { useAimBooth, useAimDoorOpen, useAimStage, usePointerLocked, useTeleportable } from "./roadInteract";
import type { MapData } from "../maps/types";
import { STAGE } from "../booth-finder/StagePanel";

interface ViewToggleProps {
  view: ViewMode;
  onChange: (view: ViewMode) => void;
}

interface MovePadProps {
  input: MoveInput;
}

export const ViewToggle = ({ view, onChange }: ViewToggleProps) => (
  <div className="view-toggle">
    <div role="group" aria-label="시점 / View" className="segmented">
      {VIEWS.map((v) => (
        <button key={v.id} aria-pressed={view === v.id} onClick={() => onChange(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
    <span className="hint">V 전환</span>
  </div>
);

/** Road-view HUD: centre dot (donut plus a click hint where a click teleports) while the mouse is captured, and the one-line hint for the mouse lock. */
interface RoadHudProps {
  /** The booth panel is open: walking is off until a right click closes it. */
  panelOpen: boolean;
}

export const RoadHud = ({ panelOpen }: RoadHudProps) => {
  const locked = usePointerLocked();
  const doorOpen = useAimDoorOpen();
  const boothCode = useAimBooth();
  const stage = useAimStage();
  // User: "이름 없이 그냥 '정보 열람'만 놔두기": the name is already in the booth probe below.
  const info = boothCode !== null || stage !== null;
  const aimed = doorOpen !== null || info;
  const canTeleport = useTeleportable();
  return (
    <>
      {locked && <div className={canTeleport || aimed ? "road-dot road-donut" : "road-dot"} aria-hidden />}
      {locked && (canTeleport || aimed) && (
        <div className="road-tp-hint" aria-hidden>
          <svg viewBox="0 0 24 24" width="18" height="18">
            {/* Mouse with the left button filled. */}
            <rect x="6" y="2" width="12" height="20" rx="6" fill="none" />
            <path d="M12 2H12v8H6V8a6 6 0 0 1 6-6z" fill="#fff" />
            <path d="M12 2v8M6 10h12" fill="none" />
          </svg>
          <span>{doorOpen !== null ? (doorOpen ? "문 닫기" : "문 열기") : info ? "정보 열람" : "바라보는 곳으로 이동"}</span>
        </div>
      )}
      <RoadHelp />
    </>
  );
};

const ROAD_HELP_KEY = "boken.roadHelp.hidden";
const roadHelpHidden = () => {
  try {
    return localStorage.getItem(ROAD_HELP_KEY) === "1";
  } catch {
    return false;
  }
};
/** Shown once per page visit, so re-entering road view after closing it does not reopen it. */
let roadHelpShown = false;

/**
 * Left section of a real keyboard, in key units (u) from its left edge: Tab 1.5u, Caps 1.75u, Shift 2.25u, Ctrl/Win/Alt 1.25u,
 * then Space. Only the keys with a legend are used by road view; the rest are blank (무각인) caps drawn faint.
 */
const KB_ROWS: { x: number; keys: { label?: string; w?: number }[] }[] = [
  { x: 0, keys: [{ label: "Esc" }] },
  { x: 0, keys: [{}, {}, {}, {}, {}, {}] },
  { x: 0, keys: [{ w: 1.5 }, {}, { label: "W" }, {}, {}, {}] },
  { x: 0, keys: [{ w: 1.75 }, { label: "A" }, { label: "S" }, { label: "D" }, {}, {}] },
  { x: 0, keys: [{ label: "Shift", w: 2.25 }, {}, {}, {}, {}, {}] },
  { x: 0, keys: [{ w: 1.25 }, { w: 1.25 }, { w: 1.25 }, { label: "Space", w: 6 }] },
];
const KB_KEYS = KB_ROWS.flatMap((r, row) => {
  let x = r.x;
  return r.keys.map((k) => {
    const key = { id: `${row}-${x}`, label: k.label ?? "", x, row, w: k.w ?? 1, blank: !k.label };
    x += key.w;
    return key;
  });
});
/** One key unit in px (the --u of .kb). */
const KB_U = 26;
const KB_X0 = 2.4;
const KB_LEAD_PX = 14;
/** Callouts: dashed leader out of a key's edge, bending once, with the label at the end. */
/** Closed polygon through `pts` as an SVG path with each corner rounded by radius `r` px. */
const roundedPath = (pts: [number, number][], r: number) =>
  pts
    .map((p, i) => {
      const a = pts[(i + pts.length - 1) % pts.length];
      const b = pts[(i + 1) % pts.length];
      const toward = (q: [number, number]) => {
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
        return [p[0] + ((q[0] - p[0]) / d) * r, p[1] + ((q[1] - p[1]) / d) * r];
      };
      const [ax, ay] = toward(a);
      const [bx, by] = toward(b);
      return `${i ? "L" : "M"}${ax} ${ay}Q${p[0]} ${p[1]} ${bx} ${by}`;
    })
    .join("") + "Z";
/** Outline of the W + A S D caps as one shape (an inverted T), standing KB_OUTLINE_PX outside the caps. */
const KB_OUTLINE_PX = 4;
const wasdOutline = () => {
  const d = KB_OUTLINE_PX;
  const cap = (x: number, row: number, w: number) => ({ x0: (x + KB_X0) * KB_U, x1: (x + w + KB_X0) * KB_U - 4, y0: row * KB_U, y1: (row + 1) * KB_U - 4 });
  const w = cap(2.5, 2, 1);
  const asd = cap(1.75, 3, 3);
  return roundedPath(
    [
      [w.x0 - d, w.y0 - d],
      [w.x1 + d, w.y0 - d],
      [w.x1 + d, asd.y0 - d],
      [asd.x1 + d, asd.y0 - d],
      [asd.x1 + d, asd.y1 + d],
      [asd.x0 - d, asd.y1 + d],
      [asd.x0 - d, asd.y0 - d],
      [w.x0 - d, asd.y0 - d],
    ],
    KB_OUTLINE_PX,
  );
};
const u = (n: number | string) => `calc((${n}) * var(--u))`;
const keyMid = (row: number) => `calc(${u(row)} + (var(--u) - 4px) / 2)`;
const keyBottom = (row: number) => `calc(${u(row)} + var(--u) - 4px)`;

/** User: "WASD 이동 Space 점프 Esc 해제는 touch 아닌 디바이스에서 접속시 보여주고 다음엔 보여주지 않기 체크박스 만들고 modal로 처리"; then "W A S D로 kbd 각각 거시고 Esc는 '나가기'". */
// Halftone panorama strip (x -30..126, centre 48): dots grow from the centre outward until they merge into solid fill at both ends; left half pink, right half navy.
const PANO_DOTS = (() => {
  const dots: { key: string; x: number; y: number; r: number; pink: boolean }[] = [];
  for (let x = -28; x <= 124; x += 4) {
    const r = 0.3 + 2.2 * Math.pow(Math.abs(x - 48) / 76, 1.3);
    for (let y = 5; y <= 41; y += 4) dots.push({ key: x + "," + y, x, y, r, pink: x < 48 });
  }
  return dots;
})();

const RoadHelp = () => {
  const dialog = useRef<HTMLDialogElement>(null);
  const skip = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (roadHelpShown || !matchMedia("(pointer: fine)").matches || roadHelpHidden()) return;
    roadHelpShown = true;
    dialog.current?.showModal();
  }, []);
  const close = () => {
    if (skip.current?.checked) {
      try {
        localStorage.setItem(ROAD_HELP_KEY, "1");
      } catch {
        // Private mode: the box just lasts for this visit.
      }
    }
  };
  return (
    <dialog ref={dialog} className="road-help" onClose={close}>
      <div className="road-help-main">
      <div className="kb" style={{ "--u": `${KB_U}px` } as CSSProperties} aria-label="W A S D 이동, Shift 달리기, Space 점프, Esc 나가기">
        {KB_KEYS.map((k) => (
          <kbd key={k.id} className={k.blank ? undefined : "used"} style={{ left: u(k.x + KB_X0), top: u(k.row), width: `calc(${k.w} * var(--u) - 4px)` }}>
            {k.label}
          </kbd>
        ))}
        {/* One solid line round the W A S D group, then a dashed leader out of its left edge to the label (over the Caps key, hence the backdrop). */}
        <svg className="kb-outline" aria-hidden>
          <path d={wasdOutline()} />
        </svg>
        {/* Dashed leaders out of Esc, W (its outline) and Shift to one label column, right-aligned just left of the keyboard. */}
        {(
          [
            { row: 0, text: "나가기", from: u(KB_X0) },
            { row: 2, text: "이동", from: `calc(${u(KB_X0 + 2.5)} - ${KB_OUTLINE_PX}px)` },
            { row: 4, text: "달리기", from: u(KB_X0) },
          ] as const
        ).map((c) => (
          <Fragment key={c.row}>
            <i className="co co-left" style={{ left: `calc(${u(KB_X0)} - ${KB_LEAD_PX}px)`, width: `calc(${c.from} - ${u(KB_X0)} + ${KB_LEAD_PX}px)`, top: keyMid(c.row) }} />
            <span style={{ left: 0, width: `calc(${u(KB_X0)} - ${KB_LEAD_PX + 4}px)`, top: u(c.row), textAlign: "right" }}>{c.text}</span>
          </Fragment>
        ))}
        {/* Space: straight down out of its bottom edge, label centred under the end. */}
        <i className="co co-down" style={{ left: u(KB_X0 + 6.75), top: keyBottom(5), height: KB_LEAD_PX }} />
        <span style={{ left: u(KB_X0 + 6.75), top: `calc(${keyBottom(5)} + ${KB_LEAD_PX}px)`, transform: "translateX(-50%)" }}>점프</span>
      </div>
      {/* Mouse look, top to bottom: a monitor whose panorama slides against the turn, the top-down view wedge (arc plus the two lines to the player) and the mouse, all on one keyframe clock. */}
      <svg className="look" viewBox="0 0 96 156" width="96" height="156" aria-hidden>
        <clipPath id="look-screen">
          <rect x="9" y="3" width="78" height="38" />
        </clipPath>
        <rect className="look-screen-bg" x="8" y="2" width="80" height="40" rx="3" />
        <path d="M48 42v8M36 50h24" />
        <g clipPath="url(#look-screen)">
          <g className="look-pan">
            <g className="look-motif">
              {PANO_DOTS.map((d) => (
                <circle key={d.key} className={d.pink ? "pk" : "nv"} cx={d.x} cy={d.y} r={d.r} />
              ))}
            </g>
          </g>
        </g>
        <linearGradient id="look-band" gradientUnits="userSpaceOnUse" x1="20" y1="0" x2="76" y2="0">
          <stop offset="0" stopColor="#f472b6" />
          <stop offset="0.5" stopColor="#e2e8f0" />
          <stop offset="1" stopColor="#1e3a8a" />
        </linearGradient>
        <path className="look-band" d="M20 108 A28 28 0 0 1 76 108" />
        <g className="look-wedge">
          <path className="wf" d="M48 108 L26.8 86.8 A30 30 0 0 1 69.2 86.8 Z" />
          <path className="wl" d="M48 108 L26.8 86.8 M48 108 L69.2 86.8" />
        </g>
        <circle cx="48" cy="108" r="6" />
        <g className="look-mouse">
          <g transform="translate(36 128)">
            <rect x="6" y="2" width="12" height="20" rx="6" />
            <path d="M12 2v8M6 10h12" />
          </g>
        </g>
      </svg>
      </div>
      <label>
        <input ref={skip} type="checkbox" />
        다음엔 보여주지 않기
      </label>
      <button type="button" onClick={() => dialog.current?.close()}>
        확인
      </button>
    </dialog>
  );
};

interface BoothProbeProps {
  data: MapData;
}

/** Road view, top centre: the booth under the crosshair (category, code, exhibitor, logo), like a block-info tooltip. */
export const BoothProbe = ({ data }: BoothProbeProps) => {
  const code = useAimBooth();
  const b = code === null ? undefined : data.booths.find((x) => x.code === code);
  const stage = useAimStage();
  // User: "스테이지도 WAILA 정보 뜨게 해줭": the stage card's title; the data holds nothing else to put on a meta line.
  if (!b && stage !== null) {
    return (
      <div className="booth-probe" aria-live="polite">
        <div>
          <strong>{STAGE[stage].title}</strong>
        </div>
      </div>
    );
  }
  if (!b) return null;
  const cat = data.categories[b.category];
  return (
    <div className="booth-probe" aria-live="polite">
      {b.logo && <img src={b.logo} alt="" />}
      <div>
        <strong>{b.exhibitor?.ko ?? b.code}</strong>
        {b.exhibitor?.en && b.exhibitor.en !== b.exhibitor.ko && <span className="en">{b.exhibitor.en}</span>}
        <span className="meta">
          <span className="code">{b.code}</span>
          {cat && (
            <span className="cat">
              <i style={{ background: cat.color }} />
              {cat.label}
            </span>
          )}
        </span>
      </div>
    </div>
  );
};

/** Hold-to-walk buttons for touch screens, which have no WASD; CSS shows it only for coarse pointers. */
export const MovePad = ({ input }: MovePadProps) => {
  // Unmounting mid-hold (switching view) never sends pointerup.
  useEffect(() => () => PAD.forEach((p) => input.delete(p.key)), [input]);
  const hold = (key: MoveKey) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      input.add(key);
    },
    onPointerUp: () => input.delete(key),
    onPointerCancel: () => input.delete(key),
    onLostPointerCapture: () => input.delete(key),
    onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
  });
  return (
    <div className="move-pad" role="group" aria-label="이동 / Move">
      {PAD.map((p) => (
        <button key={p.key} className={`pad-${p.key}`} aria-label={p.label} {...hold(p.key)}>
          {p.glyph}
        </button>
      ))}
    </div>
  );
};

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "drone", label: "드론 뷰 / Drone view" },
  { id: "road", label: "로드뷰 / Road view" },
];

const PAD: { key: MoveKey; label: string; glyph: string }[] = [
  { key: "forward", label: "앞으로 / Forward", glyph: "▲" },
  { key: "left", label: "왼쪽 / Left", glyph: "◀" },
  { key: "back", label: "뒤로 / Back", glyph: "▼" },
  { key: "right", label: "오른쪽 / Right", glyph: "▶" },
];
