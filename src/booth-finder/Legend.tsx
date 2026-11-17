import type { MapData } from "../maps/types";

interface Props {
  categories: MapData["categories"];
  hidden: Set<string>;
  onToggle: (cat: string) => void;
}

export const Legend = ({ categories, hidden, onToggle }: Props) => (
  <ul className="legend" aria-label="카테고리 / Categories">
    {Object.entries(categories).map(([id, c]) => {
      const off = hidden.has(id);
      return (
        <li key={id}>
          <button aria-pressed={!off} onClick={() => onToggle(id)} className={off ? "off" : ""}>
            <span className="dot" style={{ background: c.color }} />
            {c.label}
          </button>
        </li>
      );
    })}
  </ul>
);
