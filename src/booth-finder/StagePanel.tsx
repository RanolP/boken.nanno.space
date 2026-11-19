import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MapMeta, StageEntry, StageId, Stages } from "../maps/types";

type LoadStages = NonNullable<MapMeta["loadStages"]>;
/** Timetables per map, kept for the session so a reopened card paints them at once. */
const stageCache = new Map<LoadStages, Stages>();
const stageLoads = new Map<LoadStages, Promise<Stages>>();
const loadOnce = (load: LoadStages) => {
  let p = stageLoads.get(load);
  if (!p) {
    p = load().then((s) => (stageCache.set(load, s), s));
    p.catch((e) => console.error("stage card: stages.json failed to load", e));
    stageLoads.set(load, p);
  }
  return p;
};

const STAGE: Record<StageId, { title: string; color: string; official: string }> = {
  red: { title: "RED STAGE", color: "#d22f6e", official: "https://www.agfkorea.com/stage?idx=1" },
  blue: { title: "BLUE STAGE", color: "#1f74b8", official: "https://www.agfkorea.com/stage?idx=2" },
};
const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
/** Time axis step: every official slot starts and ends on a quarter hour (checked against stages.json). */
const GRID_MIN = 15;
/** User: "간격이 너무 크다" -- compact scale; a 45-minute slot (158 px) shows time, name and a few description lines. */
const PX_PER_MIN = 3.5;
/** User: "타임테이블 10:30부터 시작하게 하고" -- the axis starts at 10:30 on every day and both stages. */
const AXIS_START = 10 * 60 + 30;
/** Narrowest day column the approved block (participants | description) still reads in; below it the week scrolls. */
const DAY_MIN_PX = 360;
/** The pinned time axis column and the gap between columns, as in styles.css (.stage-week). */
const AXIS_PX = 38;
const DAY_GAP_PX = 6;
/** Scrolling states: the inset on each side where the previous / next day peeks in (styles.css: .stage-week[data-fit]). */
const PEEK_PX = 16;
const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
/** "11:45~12:30" -> [705, 750], in minutes since midnight. */
const spanOf = (time: string) => time.split("~").map(minutesOf) as [number, number];
/** User: "‘한 끼의 용사들’은 nbsp로 좀 묶자" -- phrases kept on one line in the card (bound here, not in stages.json,
 *  so a re-crawl keeps them). */
const UNBROKEN = ["한 끼의 용사들"];
const bind = (s: string) => UNBROKEN.reduce((t, p) => t.split(p).join(p.replace(/ /g, "\u{a0}")), s);
const hhmm = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

/** One programme: the name across the top, then guest and image on the left, description and copyright on the right; the time axis
 *  shows when, the block's title and accessible name carry the time. */
const EntryBody = ({ e }: { e: StageEntry }) => (
  <>
    {/* User: "타이틀만 카드 위쪽으로 빼자" -- the name runs across the top of the block, over both columns. */}
    <span className="name">{bind(e.name)}</span>
    {(e.guest || e.image) && (
    <div className="stage-what">
      {/* User: "참가 인원은 한줄에 한명씩 오른쪽 정렬해서 정리" -- guest is the official GUEST column, names split on commas. */}
      {e.guest && (
        <ul className="guests">
          {e.guest.split(",").map((g) => g.trim()).filter(Boolean).map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      )}
      {e.image && <img src={e.image} alt="" loading="lazy" />}
    </div>
    )}
    <div className="stage-about">
      {(e.comment || e.copyright) && (
        <div className="stage-desc">
          {/* User: "각 문장 시작에 text indent 넣어주고" -- each line of the comment is its own indented paragraph; a blank
              line becomes space before the next one. */}
          {e.comment.split("\n").map(
            (line, i, lines) =>
              line.trim() && (
                <p key={i} className={i > 0 && !lines[i - 1].trim() ? "comment gap" : "comment"}>
                  {bind(line)}
                </p>
              ),
          )}
          {e.copyright && <p className="copyright">{e.copyright}</p>}
        </div>
      )}
    </div>
  </>
);

interface Props {
  stage: StageId;
  /** Show year, for the weekday of each day heading. */
  year: number;
  loadStages?: MapMeta["loadStages"];
  onClose: () => void;
  /** Playing the exit animation; onClosed fires when it ends (at once when animations are off). */
  closing?: boolean;
  onClosed?: () => void;
}

/** Stage card: the stage's official timetable, every show day side by side, in the booth card's shell. */
export const StagePanel = ({ stage, year, loadStages, onClose, closing, onClosed }: Props) => {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Reduced motion and the mobile sheet have no animation, so animationend would never come.
    if (closing && ref.current && getComputedStyle(ref.current).animationName === "none") onClosed?.();
  }, [closing]);
  const [stages, setStages] = useState<Stages | undefined>(() => (loadStages ? stageCache.get(loadStages) : undefined));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!loadStages || stages) return;
    let live = true;
    loadOnce(loadStages).then(
      (s) => live && setStages(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [stage]);
  const s = STAGE[stage];
  const byDay = stages?.[stage] ?? {};
  // User: "금토일 동시에 볼 수 있게 펴봐" -- every show day side by side on one
  // time axis from AXIS_START to the latest end on either stage, so the RED and BLUE cards read on the same scale.
  // User: "RED STAGE는 토, 일만 보여주면 됨" -- only the days this stage has programmes; the axis stays shared.
  const days = Object.keys(byDay).sort();
  const axisEnd = Math.ceil(Math.max(AXIS_START, ...Object.values(stages ?? {}).flatMap((s) => Object.values(s).flat().map((e) => spanOf(e.time)[1]))) / GRID_MIN) * GRID_MIN;
  // User: each programme as tall as the time it takes, breaks as empty space of their length. A description cut short
  // by its slot fades out at the bottom; hover, focus or a tap grows only the description over the blocks below
  // ("설명 부분만 heighten되면 됨"), leaving the block and every other block where they are.
  const pxPerMin = PX_PER_MIN;
  const [opened, setOpened] = useState<string | null>(null);
  const weekRef = useRef<HTMLDivElement>(null);
  // Whether the week can scroll further back / forward, for the day buttons.
  const [edge, setEdge] = useState({ prev: false, next: false });
  const edges = () => {
    const week = weekRef.current;
    if (!week) return;
    const prev = week.scrollLeft > 1;
    const next = week.scrollLeft + week.clientWidth < week.scrollWidth - 1;
    setEdge((e) => (e.prev === prev && e.next === next ? e : { prev, next }));
  };
  /** One day's snap step: a column and the gap after it. */
  const step = (dir: 1 | -1) => {
    const week = weekRef.current;
    const track = week?.querySelector<HTMLElement>(".stage-track");
    if (week && track) week.scrollBy({ left: dir * (track.offsetWidth + DAY_GAP_PX), behavior: "smooth" });
  };
  useLayoutEffect(() => {
    const week = weekRef.current;
    if (!week) return;
    const mark = () => {
      // User: "폭이 좁아지면 ... seeing two-col scroll, seeing one-col scroll 상태에 돌입하게" -- from the week's measured width:
      // every day at once when all fit at DAY_MIN_PX, else exactly two (or one) day columns fill the width and the rest
      // scroll sideways, snapping per day. Written on this card's own element, so red and blue never share it.
      const avail = week.clientWidth - AXIS_PX - DAY_GAP_PX;
      const fits = (k: number) => k * DAY_MIN_PX + (k - 1) * DAY_GAP_PX <= avail + 1;
      // User: "스크롤 된다는 걸 알려주게 그 약간은 보이게 ... 16px 정도 좌우 padding 영역에" -- when scrolling, the shown days
      // leave PEEK_PX on each side, where the neighbouring days show through.
      const peek = (k: number) => (k === n ? 0 : 2 * PEEK_PX);
      const n = week.querySelectorAll(".stage-track").length;
      const shown = fits(n) ? n : 2 * DAY_MIN_PX + DAY_GAP_PX + peek(2) <= avail + 1 ? 2 : 1;
      const fit = shown === n ? "all" : shown === 2 ? "two" : "one";
      if (week.dataset.fit !== fit) week.dataset.fit = fit;
      const col = fit === "all" ? "" : `${(avail - peek(shown) - (shown - 1) * DAY_GAP_PX) / shown}px`;
      if (week.style.getPropertyValue("--col-w") !== col) week.style.setProperty("--col-w", col);
      edges();
      // User: "max of max-content를 measure해서 설정하라는것" -- one participant column width for the whole card: the
      // widest list at its max-content width (each list is laid out max-content, so its own width is that measure).
      // offsetWidth, not getBoundingClientRect: the card opens with a scale animation, and a scaled rect measured mid-pop
      // stuck as a too-narrow column (+1 covers offsetWidth's rounding).
      const w = Math.max(0, ...Array.from(week.querySelectorAll<HTMLElement>(".guests"), (g) => g.offsetWidth + 1));
      if (week.style.getPropertyValue("--guests") !== `${w}px`) week.style.setProperty("--guests", `${w}px`);
      for (const desc of Array.from(week.querySelectorAll<HTMLElement>(".stage-desc"))) {
        // Measured at the slot height only; an open description keeps the mark it had.
        if (desc.closest("li")?.matches(":hover, :focus-visible, .open")) continue;
        desc.toggleAttribute("data-clipped", desc.scrollHeight > desc.clientHeight + 1);
      }
    };
    mark();
    document.fonts.ready.then(mark);
    week.addEventListener("scroll", edges, { passive: true });
    const ro = new ResizeObserver(mark);
    ro.observe(week);
    const imgs = Array.from(week.querySelectorAll("img"));
    imgs.forEach((img) => img.addEventListener("load", mark));
    return () => {
      ro.disconnect();
      week.removeEventListener("scroll", edges);
      imgs.forEach((img) => img.removeEventListener("load", mark));
    };
  });
  const label = (d: string) => {
    const [mm, dd] = d.split("-").map(Number);
    return `${d.replace("-", ".")} (${WEEKDAY[new Date(Date.UTC(year, mm - 1, dd)).getUTCDay()]})`;
  };
  return (
    <aside
      ref={ref}
      className={["panel", "stage-panel", closing && "closing"].filter(Boolean).join(" ")}
      style={{ "--stage": s.color, ...(days.length ? { "--days": days.length } : {}) } as React.CSSProperties}
      aria-label={`${s.title} 타임테이블 / Timetable`}
      onAnimationEnd={closing ? onClosed : undefined}
    >
      <button className="close" onClick={onClose} aria-label="닫기 / Close">
        ×
      </button>
      <header className="panel-head">
        <h1>{s.title}</h1>
        <a className="official" href={s.official} target="_blank" rel="noopener noreferrer">
          공식 타임테이블
        </a>
      </header>
      {!stages && <p className="stage-status">{failed ? "타임테이블을 불러오지 못했습니다. 공식 타임테이블을 확인하세요." : "불러오는 중…"}</p>}
      {stages && (() => {
        const ticks = Array.from({ length: (axisEnd - AXIS_START) / GRID_MIN + 1 }, (_, i) => AXIS_START + i * GRID_MIN);
        const y = (min: number) => (min - AXIS_START) * pxPerMin;
        return (
          <div className="stage-scroller">
          {/* User: "non-touchable을 위해 넘기기 버튼도 viewport 가운데에 추가" -- a day back / forward, shown only while the
              week scrolls sideways and only for a mouse (styles.css). */}
          <button type="button" className="stage-nav prev" aria-label="이전 날" disabled={!edge.prev} onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" className="stage-nav next" aria-label="다음 날" disabled={!edge.next} onClick={() => step(1)}>
            ›
          </button>
          <div className="stage-week" ref={weekRef}>
            <span className="stage-corner" aria-hidden />
            {days.map((d) => (
              <h2 key={d} className="stage-day">
                {label(d)}
              </h2>
            ))}
            <div className="stage-axis" style={{ height: y(axisEnd) }} aria-hidden>
              {ticks.map((t) => (
                <span key={t} className={t % 60 === 0 ? "hour" : undefined} style={{ top: y(t) }}>
                  {hhmm(t)}
                </span>
              ))}
            </div>
            {days.map((d) => (
              <div key={d} className="stage-track" style={{ height: y(axisEnd) }} aria-label={label(d)}>
                {ticks.map((t) => (
                  <i key={t} className={t % 60 === 0 ? "tick hour" : "tick"} style={{ top: y(t) }} aria-hidden />
                ))}
                {/* User: "스테이지 정보를 접긴 왜 접니" -- every programme shows its image, text and copyright, never folded. */}
                {/* User: one row per programme in two columns: time above the name (and the image under them) on the left,
                    the description with its copyright on the right. */}
                {byDay[d]?.length ? (
                  <ol className="stage-list">
                    {byDay[d].map((e) => {
                      const [a, b] = spanOf(e.time);
                      const key = d + e.time + e.name;
                      return (
                        <li
                          key={key}
                          tabIndex={0}
                          className={[opened === key && "open", !(e.guest || e.image) && "solo"].filter(Boolean).join(" ") || undefined}
                          // User: "이제 각 카드에 시간 정보는 안 중요하지" -- the axis shows the time; it stays in the title and name.
                          title={e.time}
                          aria-label={`${e.time} ${e.name}`}
                          style={{ top: y(a), height: (b - a) * pxPerMin }}
                          onClick={() => setOpened((o) => (o === key ? null : key))}
                        >
                          <EntryBody e={e} />
                        </li>
                      );
                    })}
                  </ol>
                ) : (
                  <p className="stage-none">공연 없음</p>
                )}
              </div>
            ))}
          </div>
          </div>
        );
      })()}
    </aside>
  );
};
