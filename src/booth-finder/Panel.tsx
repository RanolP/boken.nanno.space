import { useEffect, useRef, useState, type ReactElement } from "react";
import type { Tweet } from "react-tweet/api";
import type { MapData, MapMeta } from "../maps/types";
import { NoticeTweet } from "./NoticeTweet";

type Booth = MapData["booths"][number];

type LoadTweets = NonNullable<MapMeta["loadTweets"]>;
const statusId = (url: string) => url.match(/\/status\/(\d+)/)?.[1] ?? "";
/** The account's own thread continuation under a post, added by scripts/fetch-tweets.mjs. */
const threadIds = (t: Tweet | undefined) => (t as (Tweet & { thread_ids?: string[] }) | undefined)?.thread_ids;
/** Crawled posts per map, kept for the session: a card opened after they land reads them on its first render, so the
 * notice row never paints the link fallback and then swaps in the embeds (that swap was the relayout). */
const tweetCache = new Map<LoadTweets, Record<string, Tweet>>();
const tweetLoads = new Map<LoadTweets, Promise<Record<string, Tweet>>>();
/** Starts (once) loading a map's crawled posts; App calls it when the map mounts so they are in memory before any card opens. */
export const preloadTweets = (load: LoadTweets) => {
  let p = tweetLoads.get(load);
  if (!p) {
    p = load().then((t) => (tweetCache.set(load, t), t));
    p.catch((e) => console.error("booth notices: tweets.json failed to load", e));
    tweetLoads.set(load, p);
  }
  return p;
};

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

type LinkKind = "website" | "x" | "instagram";

const isInstagram = (url: string) => hostOf(url) === "instagram.com";

/** 24-unit stroke/fill glyphs; brand marks are simplified single paths. */
const ICONS: Record<LinkKind, ReactElement> = {
  website: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" />
    </svg>
  ),
  x: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.24 2.25h3.31l-7.23 8.26 8.5 11.24h-6.66l-5.21-6.82-5.97 6.82H1.67l7.73-8.84L1.25 2.25h6.83l4.71 6.23 5.45-6.23Zm-1.16 17.52h1.83L7.08 4.13H5.12l11.96 15.64Z" />
    </svg>
  ),
  instagram: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="0.6" fill="currentColor" />
    </svg>
  ),
};

interface Props {
  booth: Booth;
  category?: { label: string; color: string };
  showsLogoCredit?: boolean;
  loadTweets?: MapMeta["loadTweets"];
  onClose: () => void;
  /** Playing the exit animation; onClosed fires when it ends (at once when animations are off). */
  closing?: boolean;
  onClosed?: () => void;
}

/** Booth card: logotype as the backdrop, "<code> <ko> (<en>)" as the title, the category as a hashtag. */
export const Panel = ({
  booth,
  category,
  showsLogoCredit,
  loadTweets,
  onClose,
  closing,
  onClosed,
}: Props) => {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    // Reduced motion and the mobile sheet have no animation, so animationend would never come.
    if (
      closing &&
      ref.current &&
      getComputedStyle(ref.current).animationName === "none"
    )
      onClosed?.();
  }, [closing]);
  const [tweets, setTweets] = useState<Record<string, Tweet> | undefined>(() => (loadTweets ? tweetCache.get(loadTweets) : undefined));
  useEffect(() => {
    if (!booth.notices || !loadTweets || tweets) return;
    let live = true;
    preloadTweets(loadTweets).then(
      (t) => live && setTweets(t),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [booth.code]);
  const inThread = new Set(booth.notices?.flatMap((n) => threadIds(tweets?.[statusId(n.url)]) ?? []));
  const ex = booth.exhibitor;
  const en = ex?.en && ex.en !== ex.ko ? ` (${ex.en})` : "";
  // Two exhibitors list an Instagram page as their homepage; show it as the Instagram button, not as a website.
  const links: { kind: LinkKind; href: string; label: string }[] = [];
  if (booth.homepage && !isInstagram(booth.homepage))
    links.push({
      kind: "website",
      href: booth.homepage,
      label: `웹사이트 / Website: ${hostOf(booth.homepage)}`,
    });
  if (booth.xAccount)
    links.push({
      kind: "x",
      href: `https://x.com/${booth.xAccount}`,
      label: `X: @${booth.xAccount}`,
    });
  if (booth.homepage && isInstagram(booth.homepage))
    links.push({
      kind: "instagram",
      href: booth.homepage,
      label: `Instagram: ${booth.homepage.replace(/^https?:\/\/(www\.)?instagram\.com\/?/, "").replace(/\/$/, "")}`,
    });
  const name = ex ? ex.ko || ex.en : "참가사 정보 없음 / No exhibitor info";
  return (
    <aside
      ref={ref}
      className={["panel", booth.logo && "has-logo", closing && "closing"]
        .filter(Boolean)
        .join(" ")}
      aria-label="부스 정보 / Booth details"
      onAnimationEnd={closing ? onClosed : undefined}
    >
      <button className="close" onClick={onClose} aria-label="닫기 / Close">
        ×
      </button>
      <header className="panel-head">
        {booth.logo && (
          <div
            className="logotype"
            role="img"
            aria-label={`${ex?.en ?? ex?.ko ?? booth.code} logo`}
            style={{ "--logo": `url("${booth.logo}")` } as React.CSSProperties}
          />
        )}
        <h1>
          {booth.code} {name}
          {ex?.ko && en && <span className="en">{en}</span>}
        </h1>
        <p
          className="hashtag"
          style={
            category
              ? ({ "--cat": category.color } as React.CSSProperties)
              : undefined
          }
        >
          #
          {(category?.label ?? booth.category)
            .toUpperCase()
            .replace(/\s+/g, "")}
        </p>
      </header>
      {(booth.intro || links.length > 0) && (
        <div className="about">
          {booth.intro && <p className="intro">{booth.intro}</p>}
          {links.length > 0 && (
            <ul className="links">
              {links.map((l) => (
                <li key={l.kind}>
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={l.label}
                    title={l.label}
                  >
                    {ICONS[l.kind]}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {booth.notices && (
        <section className="notices" aria-label="SNS 공지 / Notices">
          <h2>SNS 공지</h2>
          <ul>
            {/* User: newest first. Undated notices keep their order at the end. */}
            {[...booth.notices].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).map((n) => {
              const tweet = tweets?.[statusId(n.url)];
              // A notice that is itself the continuation of another notice here already shows chained under that one.
              if (tweet && inThread.has(tweet.id_str)) return null;
              const thread = (threadIds(tweet) ?? []).map((id) => tweets?.[id]).filter((t): t is Tweet => !!t);
              return (
                <li key={n.url}>
                  {tweet ? (
                    <div data-theme="light">
                      <NoticeTweet tweet={tweet} thread={thread} />
                    </div>
                  ) : (
                    // Not crawled (or still loading): a plain link to the post.
                    <a className="notice-link" href={n.url} target="_blank" rel="noopener noreferrer">
                      {n.date && <time dateTime={n.date}>{n.date.slice(5).replace("-", ".")}</time>}
                      {n.summary ?? n.url.replace(/^https:\/\/x\.com\//, "@").replace(/\/status\/.*/, "")}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {booth.logo && showsLogoCredit && (
        <p className="logo-credit">로고 © 해당 참가사 / Logo © its owner</p>
      )}
    </aside>
  );
};
