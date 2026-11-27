import { Fragment, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import type { MoveInput, ViewMode } from "./walk";
import { useAimBooth, useAimDoorOpen, useAimStage, usePointerLocked, useTeleportable } from "./roadInteract";
import type { MapData } from "../maps/types";
import { STAGE } from "../booth-finder/StagePanel";

interface ViewToggleProps {
  view: ViewMode;
  onChange: (view: ViewMode) => void;
}

interface TouchControlsProps {
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

/** Shown once per page visit, so re-entering road view after closing it does not reopen it. */
let roadHelpShown = false;

/**
 * Road-view tutorial modal: opens once per visit when `media` matches (keyboard help for a mouse, touch help for a
 * finger), unless its "다음엔 보여주지 않기" box was ticked before (remembered under `storageKey`).
 */
const HelpDialog = ({ storageKey, media, className, children }: { storageKey: string; media: string; className?: string; children: ReactNode }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const skip = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let hidden = false;
    try {
      hidden = localStorage.getItem(storageKey) === "1";
    } catch {
      // Private mode: nothing stored, so it shows.
    }
    if (roadHelpShown || !matchMedia(media).matches || hidden) return;
    roadHelpShown = true;
    dialog.current?.showModal();
  }, [storageKey, media]);
  const close = () => {
    if (skip.current?.checked) {
      try {
        localStorage.setItem(storageKey, "1");
      } catch {
        // Private mode: the box just lasts for this visit.
      }
    }
  };
  return (
    <dialog ref={dialog} className={className ? `road-help ${className}` : "road-help"} onClose={close}>
      {children}
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

const RoadHelp = () => (
    <>
    <HelpDialog storageKey="boken.roadHelp.hidden" media="(pointer: fine)">
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
    </HelpDialog>
    <TouchHelp />
    </>
);

/** Drag-to-look screen: the desktop help's panorama monitor redrawn as a phone on its side, a fingertip in place of the mouse. */
const LookScreen = () => (
  <svg className="look" viewBox="0 0 96 50" width="96" height="50" aria-hidden>
    <clipPath id="touch-look-screen">
      <rect x="9" y="5" width="78" height="38" />
    </clipPath>
    <rect className="phone" x="3" y="1" width="90" height="46" rx="7" />
    <rect className="look-screen-bg" x="9" y="5" width="78" height="38" />
    <g clipPath="url(#touch-look-screen)">
      <g className="look-pan">
        <g className="look-motif">
          {PANO_DOTS.map((d) => (
            <circle key={d.key} className={d.pink ? "pk" : "nv"} cx={d.x} cy={d.y + 2} r={d.r} />
          ))}
        </g>
      </g>
    </g>
    <g className="look-mouse">
      <circle className="finger" cx="48" cy="27" r="7" />
    </g>
  </svg>
);

/**
 * User: "tutorial shall be modern like desktop does": the touch counterpart of the keyboard help, in its card and
 * colours, each control drawn and animated (stick, drag to look, tap to act) with the run and jump buttons as they look.
 */
const TouchHelp = () => (
  <HelpDialog storageKey="boken.touchHelp.hidden" media="(pointer: coarse)" className="touch-help">
    <div className="touch-help-grid">
      <figure>
        {/* The floating stick: base, knob pushed round the four directions. */}
        <svg viewBox="0 0 96 96" width="96" height="96" aria-hidden>
          <circle className="stick-ring" cx="48" cy="48" r="34" />
          <path className="stick-ticks" d="M48 18l-4 5h8zM48 78l-4-5h8zM18 48l5-4v8zM78 48l-5-4v8z" />
          <circle className="stick-knob-anim" cx="48" cy="48" r="14" />
        </svg>
        <figcaption>
          <strong>이동</strong>
          왼쪽 아래를 누르고 밀기
        </figcaption>
      </figure>
      <figure>
        <LookScreen />
        <figcaption>
          <strong>둘러보기</strong>
          화면을 끌기
        </figcaption>
      </figure>
      <figure>
        {/* Tap: the finger lands on the floor ahead, a ripple, then the teleport ring and its light pillar where it lands. */}
        <svg className="tap" viewBox="0 0 96 64" width="96" height="64" aria-hidden>
          <path className="floor" d="M4 62L40 18h16l36 44" />
          <path className="floor-mid" d="M48 18v44" />
          <g className="tap-mark">
            <rect className="pillar" x="41" y="16" width="14" height="22" />
            <ellipse className="ring" cx="48" cy="38" rx="9" ry="3" />
          </g>
          <circle className="tap-ripple" cx="48" cy="38" r="8" />
          <circle className="finger tap-finger" cx="48" cy="38" r="7" />
        </svg>
        <figcaption>
          <strong>탭하기</strong>
          바닥은 그곳으로 이동
          <br />
          부스·무대는 정보, 문은 여닫기
        </figcaption>
      </figure>
      <figure className="touch-help-buttons">
        <div aria-hidden>
          <span className="touch-btn touch-jump">
            <JumpIcon />
          </span>
          <span className="touch-btn touch-run">
            <RunIcon />
            <span>달리기</span>
          </span>
        </div>
        <figcaption>
          <strong>달리기 · 점프</strong>
          달리기는 눌러서 켜고 끄기
        </figcaption>
      </figure>
    </div>
  </HelpDialog>
);

const RunIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
    <circle cx="15" cy="4.5" r="2.2" />
    <path d="M9 21l2.2-5.2 2.6 2.2V22M13.8 18l1-4.6-3.6-3.4 1.4-3.5L9 8 7 11.5M14.8 13.4L17 15.5 20.5 14.5M12.6 6.5l3.6 1.8 1.5 3" />
  </svg>
);

const JumpIcon = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
    <path d="M12 4l-7 8h4.5v7h5v-7H19z" />
  </svg>
);

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

/**
 * Touch screens, which have no WASD (CSS shows it only for coarse pointers): a stick at the bottom left (walk speed
 * follows how far it is pushed), and run (a toggle) and jump buttons at the bottom right above the minimap.
 * Looking around (drag) and interacting (tap) happen on the canvas itself, in RoadRig.
 */
export const TouchControls = ({ input }: TouchControlsProps) => {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const stickId = useRef<number | null>(null);
  // Floating stick: its centre is where the thumb landed in the zone (client px), so the thumb never has to find it.
  const centre = useRef({ x: 0, y: 0 });
  const [run, setRun] = useState(input.run);
  // Unmounting mid-hold (switching view) never sends pointerup.
  useEffect(
    () => () => {
      input.stick.f = input.stick.s = 0;
      input.jump.held = false;
    },
    [input],
  );

  const aim = (e: PointerEvent<HTMLDivElement>) => {
    let dx = (e.clientX - centre.current.x) / STICK_TRAVEL_PX;
    let dy = (e.clientY - centre.current.y) / STICK_TRAVEL_PX;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    // Dead zone at the centre, then the rest rescaled to 0..1 so the speed starts from zero past it.
    const mag = Math.min(1, len);
    const k = mag < STICK_DEAD ? 0 : (mag - STICK_DEAD) / (1 - STICK_DEAD) / (mag || 1);
    input.stick.f = -dy * k;
    input.stick.s = dx * k;
    if (knob.current) knob.current.style.transform = `translate(${dx * STICK_TRAVEL_PX}px, ${dy * STICK_TRAVEL_PX}px)`;
  };
  const release = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== stickId.current) return;
    stickId.current = null;
    input.stick.f = input.stick.s = 0;
    if (knob.current) knob.current.style.transform = "";
    if (base.current) base.current.style.cssText = "";
    e.currentTarget.classList.remove("active");
  };
  const noMenu = (e: { preventDefault: () => void }) => e.preventDefault();

  return (
    <>
      <div
        className="touch-ctl stick"
        role="group"
        aria-label="이동 / Move"
        onPointerDown={(e) => {
          if (stickId.current !== null) return;
          stickId.current = e.pointerId;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.classList.add("active");
          const r = e.currentTarget.getBoundingClientRect();
          // Keep the whole base inside the zone, so a press at its very edge still has room to push outward.
          const half = STICK_BASE_PX / 2;
          const x = Math.min(Math.max(e.clientX - r.left, half), r.width - half);
          const y = Math.min(Math.max(e.clientY - r.top, half), r.height - half);
          centre.current = { x: r.left + x, y: r.top + y };
          if (base.current) base.current.style.cssText = `left:${x - half}px;top:${y - half}px;bottom:auto`;
          aim(e);
        }}
        onPointerMove={(e) => {
          if (e.pointerId === stickId.current) aim(e);
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
        onContextMenu={noMenu}
      >
        <div ref={base} className="stick-base">
          <div ref={knob} className="stick-knob" />
        </div>
      </div>
      <div className="touch-ctl touch-actions">
        <button
          type="button"
          className="touch-btn touch-jump"
          aria-label="점프 / Jump"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            input.jump.held = true;
            input.jump.pressedAt = performance.now() / 1000;
          }}
          onPointerUp={() => (input.jump.held = false)}
          onPointerCancel={() => (input.jump.held = false)}
          onLostPointerCapture={() => (input.jump.held = false)}
          onContextMenu={noMenu}
        >
          <JumpIcon />
        </button>
        <button
          type="button"
          className="touch-btn touch-run"
          aria-pressed={run}
          aria-label="달리기 / Run"
          onClick={() => {
            input.run = !input.run;
            setRun(input.run);
          }}
          onContextMenu={noMenu}
        >
          <RunIcon />
          <span>달리기</span>
        </button>
      </div>
    </>
  );
};

/** Stick: how far (CSS px) the knob travels from the centre at full deflection, and the centre dead zone (fraction of it). */
const STICK_TRAVEL_PX = 40;
/** Base diameter; matches .stick-base in styles.css. */
const STICK_BASE_PX = 128;
const STICK_DEAD = 0.12;

const VIEWS: { id: ViewMode; label: string }[] = [
  { id: "drone", label: "드론 뷰 / Drone view" },
  { id: "road", label: "로드뷰 / Road view" },
];
