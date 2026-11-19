import { useEffect, useRef } from "react";
import type { MapData } from "../maps/types";

type Booth = MapData["booths"][number];

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

interface Props {
  booth: Booth;
  category?: { label: string; color: string };
  showsLogoCredit?: boolean;
  onClose: () => void;
  /** Playing the exit animation; onClosed fires when it ends (at once when animations are off). */
  closing?: boolean;
  onClosed?: () => void;
}

/** Booth card: logotype as the backdrop, "<code> <ko> (<en>)" as the title, the category as a hashtag. */
export const Panel = ({ booth, category, showsLogoCredit, onClose, closing, onClosed }: Props) => {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Reduced motion and the mobile sheet have no animation, so animationend would never come.
    if (closing && ref.current && getComputedStyle(ref.current).animationName === "none") onClosed?.();
  }, [closing]);
  const ex = booth.exhibitor;
  const en = ex?.en && ex.en !== ex.ko ? ` (${ex.en})` : "";
  const name = ex ? `${ex.ko || ex.en}${ex.ko ? en : ""}` : "참가사 정보 없음 / No exhibitor info";
  return (
    <aside
      ref={ref}
      className={closing ? "panel closing" : "panel"}
      aria-label="부스 정보 / Booth details"
      onAnimationEnd={closing ? onClosed : undefined}
    >
      <button className="close" onClick={onClose} aria-label="닫기 / Close">
        ×
      </button>
      {booth.logo && (
        <div
          className="logotype"
          role="img"
          aria-label={`${ex?.en ?? ex?.ko ?? booth.code} logo`}
          style={{ backgroundImage: `url("${booth.logo}")` }}
        />
      )}
      {booth.logo && showsLogoCredit && <p className="logo-credit">로고 © 해당 참가사 / Logo © its owner</p>}
      <h1>
        {booth.code} {name}
      </h1>
      <p className="hashtag">
        #{(category?.label ?? booth.category).toUpperCase().replace(/\s+/g, "")}
      </p>
      {booth.intro && <p className="intro">{booth.intro}</p>}
      {booth.homepage && (
        <a className="homepage" href={booth.homepage} target="_blank" rel="noopener noreferrer">
          {hostOf(booth.homepage)}
        </a>
      )}
      {booth.xAccount && (
        <a className="homepage" href={`https://x.com/${booth.xAccount}`} target="_blank" rel="noopener noreferrer">
          @{booth.xAccount}
        </a>
      )}
      {booth.notices && (
        <section className="notices" aria-label="SNS 공지 / Notices">
          <h2>SNS 공지</h2>
          <ul>
            {booth.notices.map((n) => (
              <li key={n.url}>
                <a href={n.url} target="_blank" rel="noopener noreferrer">
                  {n.date && <time dateTime={n.date}>{n.date.slice(5).replace("-", ".")}</time>}
                  {n.summary}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
};
