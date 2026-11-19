import { useEffect, type PointerEvent } from "react";
import type { MoveInput, MoveKey, ViewMode } from "./walk";
import { useAimBooth, useNearDoor, usePointerLocked } from "./roadInteract";
import type { MapData } from "../maps/types";

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
    <span className="hint">WASD 이동 · V 전환</span>
  </div>
);

/** Road-view HUD: centre dot while the mouse is captured, and the one-line hints for the door key and the mouse lock. */
interface RoadHudProps {
  /** The booth panel is open: walking is off until a right click closes it. */
  panelOpen: boolean;
}

export const RoadHud = ({ panelOpen }: RoadHudProps) => {
  const locked = usePointerLocked();
  const door = useNearDoor();
  return (
    <>
      {locked && <div className="road-dot" aria-hidden />}
      {panelOpen && <span className="hint road-hint">우클릭: 닫기</span>}
      {!panelOpen && door !== null && <span className="hint road-hint">E: 문 열기/닫기</span>}
      {!panelOpen && door === null && <span className="hint road-hint">{locked ? "클릭: 바라보는 바닥으로 이동 · Space: 점프 · Esc: 해제" : "클릭: 마우스 잠금 · Space: 점프 · Esc: 해제"}</span>}
    </>
  );
};

interface BoothProbeProps {
  data: MapData;
}

/** Road view, top centre: the booth under the crosshair (category, code, exhibitor, logo), like a block-info tooltip. */
export const BoothProbe = ({ data }: BoothProbeProps) => {
  const code = useAimBooth();
  const b = code === null ? undefined : data.booths.find((x) => x.code === code);
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
          <span className="click">클릭: 상세 보기</span>
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
