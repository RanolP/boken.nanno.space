import { useMemo, useRef, useState, type CSSProperties } from "react";
import type { MapData } from "../maps/types";

type Booth = MapData["booths"][number];

interface Props {
  booths: Booth[];
  onPick: (code: string) => void;
}

export const Search = ({ booths, onPick }: Props) => {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const query = q.trim().toLowerCase();
  const results = useMemo(
    () => (query ? booths.filter((b) => matches(b, query)).slice(0, 8) : []),
    [booths, query],
  );
  const pick = (code: string) => {
    onPick(code);
    setQ("");
    // the clicked result button unmounts with the list; move focus back to the input
    inputRef.current?.focus();
  };
  return (
    <div className="search">
      <input
        ref={inputRef}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="부스 번호 / 참가사 검색"
        aria-label="부스 번호 또는 참가사 검색 / Search booth code or exhibitor"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing && results[0]) pick(results[0].code);
        }}
      />
      {results.length > 0 && (
        <ul className="results" aria-label="검색 결과 / Search results">
          {results.map((b) => (
            <li key={b.code}>
              <button onClick={() => pick(b.code)}>
                <strong>{b.code}</strong>
                <span>
                  {b.exhibitor?.ko}
                  {b.exhibitor?.en ? ` / ${b.exhibitor.en}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div aria-live="polite">
        {query &&
          (results.length === 0 ? (
            <p className="none">결과 없음 / No results</p>
          ) : (
            <p style={srOnly}>
              {results.length}개 결과 / {results.length} results
            </p>
          ))}
      </div>
    </div>
  );
};

const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

const matches = (b: Booth, q: string) =>
  [b.code, b.exhibitor?.ko, b.exhibitor?.en].some((s) => s?.toLowerCase().includes(q));
