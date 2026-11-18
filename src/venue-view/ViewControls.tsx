import { useEffect, type PointerEvent } from "react";
import type { MoveInput, MoveKey, ViewMode } from "./walk";
import { useNearDoor, usePointerLocked } from "./roadInteract";

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
export const RoadHud = () => {
  const locked = usePointerLocked();
  const door = useNearDoor();
  return (
    <>
      {locked && <div className="road-dot" aria-hidden />}
      {door !== null && <span className="hint road-hint">E: 문 열기/닫기</span>}
      {!locked && door === null && <span className="hint road-hint">클릭: 마우스 잠금 · Esc: 해제</span>}
    </>
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
