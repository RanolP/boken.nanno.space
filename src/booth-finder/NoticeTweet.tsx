import { useMemo, useRef, useState, type ReactNode } from "react";
import { QuotedTweet, Verified, VerifiedBusiness, VerifiedGovernment, TweetBody, TweetContainer, TweetMediaVideo, enrichTweet, getMediaUrl } from "react-tweet";
import type { Tweet } from "react-tweet/api";

/** Added by scripts/fetch-tweets.mjs for long posts: the whole text, with link/tag ranges as UTF-16 offsets. */
type NoteFull = { text: string; facets: { type: string; start: number; end: number; original?: string; replacement?: string; display?: string }[] };
type Enriched = ReturnType<typeof enrichTweet>;

/** User: long posts expanded by default. Media ranges are dropped like react-tweet's own body does (the media shows below). */
const NoteBody = ({ note, lang }: { note: NoteFull; lang: string }) => {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [k, f] of [...note.facets].sort((a, b) => a.start - b.start).entries()) {
    if (f.start < at) continue;
    parts.push(note.text.slice(at, f.start));
    const href =
      f.type === "hashtag" ? `https://x.com/hashtag/${f.original}` : f.type === "mention" ? `https://x.com/${f.original}` : f.type === "url" ? f.replacement : f.type === "symbol" ? `https://x.com/search?q=%24${f.original}` : undefined;
    if (f.type !== "media")
      parts.push(
        href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {f.type === "url" ? (f.display ?? f.replacement) : note.text.slice(f.start, f.end)}
          </a>
        ) : (
          note.text.slice(f.start, f.end)
        ),
      );
    at = f.end;
  }
  parts.push(note.text.slice(at).trimEnd());
  return (
    <p className="nt-note" lang={lang} dir="auto">
      {parts}
    </p>
  );
};

/** User: a post's images slide sideways (one at a time) instead of react-tweet's grid. The frame keeps the first item's ratio.
 * User: "클릭해서 트윗 보기 하지 말고" — a slide is not a link to the post on X. */
const MediaSlides = ({ tweet }: { tweet: Enriched }) => {
  const list = tweet.mediaDetails ?? [];
  const track = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const first = list[0];
  if (!first) return null;
  const go = (k: number) => {
    const el = track.current;
    if (el) el.scrollTo({ left: k * el.clientWidth, behavior: "smooth" });
  };
  return (
    <div className="nt-media">
      <div
        className="nt-track"
        ref={track}
        // Height from the width (cqw of .nt-media), capped: aspect-ratio + max-height would shrink the width instead.
        style={{ height: `min(70vh, ${(100 * first.original_info.height) / first.original_info.width}cqw)` }}
        onScroll={(e) => setAt(Math.round(e.currentTarget.scrollLeft / e.currentTarget.clientWidth))}
      >
        {list.map((m, k) =>
          m.type === "photo" ? (
            <div key={k} className="nt-slide">
              <img src={getMediaUrl(m, "medium")} alt={m.ext_alt_text || "Image"} loading={k ? "lazy" : undefined} draggable={false} />
            </div>
          ) : (
            <div key={k} className="nt-slide">
              <TweetMediaVideo tweet={tweet} media={m} />
            </div>
          ),
        )}
      </div>
      {list.length > 1 && (
        <>
          <button type="button" className="nt-prev" aria-label="이전 이미지" disabled={at === 0} onClick={() => go(at - 1)}>
            ‹
          </button>
          <button type="button" className="nt-next" aria-label="다음 이미지" disabled={at >= list.length - 1} onClick={() => go(at + 1)}>
            ›
          </button>
          <span className="nt-count">
            {at + 1} / {list.length}
          </span>
        </>
      )}
    </div>
  );
};

/** Copied from react-tweet 3.3.1 (twitter-theme/verified-badge.js), which the package does not export. */
const VerifiedBadge = ({ user }: { user: Enriched["user"] }) => {
  const verified = user.verified || user.is_blue_verified || user.verified_type;
  if (!verified) return null;
  let icon = <Verified />;
  let tone: string | undefined = user.is_blue_verified ? "blue" : "old";
  if (user.verified_type === "Government") (icon = <VerifiedGovernment />), (tone = "gov");
  if (user.verified_type === "Business") (icon = <VerifiedBusiness />), (tone = undefined);
  return <span className={tone ? `nt-verified ${tone}` : "nt-verified"}>{icon}</span>;
};

/** Copied from react-tweet 3.3.1 (twitter-theme/highlighted-label.js): the affiliate badge next to the name. */
const HighlightedLabel = ({ user }: { user: Enriched["user"] }) => {
  const label = user.highlighted_label;
  const url = label?.badge?.url;
  return url ? (
    <span className="nt-label">
      <img src={url} alt={label.description} />
    </span>
  ) : null;
};

/** User: post time as Korean year-month-day plus a 12-hour clock written "8:50 PM" (English AM/PM goes after the time),
 * in KST (the venue's time), e.g. "2026. 11. 17. 8:50 PM". */
const ymdHm = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", hourCycle: "h23" });
const postedAt = {
  format: (d: Date) => {
    const p = Object.fromEntries(ymdHm.formatToParts(d).map((x) => [x.type, x.value]));
    const h = Number(p.hour);
    return `${p.year}. ${p.month}. ${p.day}. ${h % 12 || 12}:${p.minute} ${h < 12 ? "AM" : "PM"}`;
  },
};

/** User: avatar on the left, nickname with the @handle to its right, no Follow button; the post sits right under the name. */
/** X display requirements: avatar, name and @handle link to the author's profile; the time links to the post. */
const ext = { target: "_blank", rel: "noopener noreferrer" } as const;
const profileUrl = (u: Enriched["user"]) => `https://x.com/${u.screen_name}`;

const Author = ({ tweet }: { tweet: Enriched }) => (
  <div className="nt-author">
    <a className="nt-name" href={profileUrl(tweet.user)} title={tweet.user.name} {...ext}>
      {tweet.user.name}
    </a>
    <VerifiedBadge user={tweet.user} />
    <HighlightedLabel user={tweet.user} />
    <a className="nt-handle" href={profileUrl(tweet.user)} {...ext}>
      @{tweet.user.screen_name}
    </a>
    <span className="nt-sep" aria-hidden="true">·</span>
    <a className="nt-time" href={tweet.url} {...ext}>
      <time dateTime={tweet.created_at}>{postedAt.format(new Date(tweet.created_at))}</time>
    </a>
    {/* X display requirements: the X logo stays at the post's upper right, and "View on X" on the time's line stands in
        for the like/reply row (user: Reply and Copy link removed). */}
    <a className="nt-brand" href={tweet.url} {...ext}>
      <span>View on</span>
      <svg aria-label="X" role="img" viewBox="0 0 24 24">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    </a>
  </div>
);

/** One post: avatar column on the left, everything else beside it. `linked` draws the thread line down to the next post. */
const Post = ({ tweet: t, linked }: { tweet: Tweet; linked?: boolean }) => {
  const tweet = useMemo(() => enrichTweet(t), [t]);
  const note = (t as Tweet & { note_full?: NoteFull }).note_full;
  return (
    <div className={linked ? "nt-row linked" : "nt-row"}>
      <a className="nt-avatar-link" href={profileUrl(tweet.user)} {...ext}>
        <img
          className={tweet.user.profile_image_shape === "Square" ? "nt-avatar square" : "nt-avatar"}
          src={tweet.user.profile_image_url_https}
          alt={tweet.user.name}
          width={48}
          height={48}
        />
      </a>
      <div className="nt-main">
        <Author tweet={tweet} />
        {note ? <NoteBody note={note} lang={tweet.lang} /> : <TweetBody tweet={tweet} />}
        {tweet.mediaDetails?.length ? <MediaSlides tweet={tweet} /> : null}
        {tweet.quoted_tweet && <QuotedTweet tweet={tweet.quoted_tweet} />}
      </div>
    </div>
  );
};

/** react-tweet's EmbeddedTweet, rebuilt from its exported parts with the full long text and sliding media.
 * User: no "Read N replies"; the account's own thread continuation (`thread`) is chained below, other replies are not. */
export const NoticeTweet = ({ tweet, thread = [] }: { tweet: Tweet; thread?: Tweet[] }) => (
  <TweetContainer>
    {[tweet, ...thread].map((t, k, all) => (
      <Post key={t.id_str} tweet={t} linked={k < all.length - 1} />
    ))}
  </TweetContainer>
);
