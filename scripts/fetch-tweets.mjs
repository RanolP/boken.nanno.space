#!/usr/bin/env node
// Crawls every booth notice in map.json (`notices[].url`, an x.com status link) through X's public syndication
// endpoint (react-tweet's getTweet) and writes the tweet data to src/maps/agf-2026/tweets.json, keyed by status id,
// so the booth card can render the posts with react-tweet's parts without calling X at runtime.
// Long posts ("note tweets") come back from syndication cut short with only a note id; the card shows them in full
// (user: "내용도 expand by default"), so their whole text and link/tag ranges are added as `note_full` from the public
// FxTwitter API (api.fxtwitter.com), with ranges converted to UTF-16 offsets for String.slice.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTweet } from "react-tweet/api";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "src/maps/agf-2026");
const map = JSON.parse(readFileSync(join(dir, "map.json"), "utf8"));

const ids = [...new Set(map.booths.flatMap((b) => (b.notices ?? []).map((n) => n.url.match(/\/status\/(\d+)/)?.[1]).filter(Boolean)))];
// FxTwitter facet indices count code points; re-check each tag/mention against the text so a mismatch fails loudly.
const noteOf = async (id) => {
  const r = await fetch(`https://api.fxtwitter.com/status/${id}`);
  if (!r.ok) throw new Error(`fxtwitter HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const raw = (await r.json()).tweet?.raw_text;
  if (!raw?.text) throw new Error("fxtwitter: no raw_text in the response");
  const cps = Array.from(raw.text);
  const u16 = (cp) => cps.slice(0, cp).join("").length;
  const facets = (raw.facets ?? []).map((f) => {
    const start = u16(f.indices[0]);
    const end = u16(f.indices[1]);
    const seen = raw.text.slice(start, end);
    if ((f.type === "hashtag" && seen !== `#${f.original}`) || (f.type === "mention" && seen.toLowerCase() !== `@${f.original}`.toLowerCase()))
      throw new Error(`fxtwitter facet ${f.type} ${JSON.stringify(f.original)} does not match text ${JSON.stringify(seen)}`);
    return { type: f.type, start, end, original: f.original, replacement: f.replacement, display: f.display };
  });
  return { text: raw.text, facets };
};
// User: when the official account continued a notice as a thread (its own replies under it), the card chains those
// posts below the notice. FxTwitter's /2/thread lists the author's self-reply chain around a post; the posts after the
// notice in it are its continuation. Their ids go on the notice as `thread_ids`, their data into tweets.json too.
const threadOf = async (id, author) => {
  const r = await fetch(`https://api.fxtwitter.com/2/thread/${id}`);
  if (!r.ok) throw new Error(`fxtwitter thread HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const chain = (await r.json()).thread ?? [];
  const at = chain.findIndex((p) => p.id === id);
  if (at < 0) throw new Error("fxtwitter thread does not contain the post itself");
  return chain.slice(at + 1).filter((p) => p.author?.screen_name?.toLowerCase() === author.toLowerCase()).map((p) => p.id);
};
const tweets = {};
const failed = [];
const crawl = async (id) => {
  try {
    const t = await getTweet(id);
    if (!t) return void failed.push(`${id}\tnot found (deleted, protected or age-restricted)`);
    if (t.note_tweet) {
      try {
        t.note_full = await noteOf(id);
      } catch (e) {
        failed.push(`${id}\tlong text not fetched, card shows X's cut text: ${e.message}`);
      }
    }
    tweets[id] = t;
    return t;
  } catch (e) {
    failed.push(`${id}\t${e.message}`);
  }
};
await Promise.all(ids.map(crawl));
await Promise.all(
  ids.filter((id) => tweets[id]).map(async (id) => {
    try {
      const rest = await threadOf(id, tweets[id].user.screen_name);
      const got = [];
      for (const r of rest) if (tweets[r] || (await crawl(r))) got.push(r);
      if (got.length) tweets[id].thread_ids = got;
    } catch (e) {
      failed.push(`${id}\tthread not fetched, card shows the notice alone: ${e.message}`);
    }
  }),
);
// User: "최근 타임라인" for every booth with official X accounts. FxTwitter's profile feed lists an account's newest
// posts; keep the 5 newest that the account itself wrote (not replies, not reposts), crawl them like notices, and
// write the per-handle id lists (newest first) to timelines.json.
const handles = [...new Set(map.booths.flatMap((b) => b.xAccounts ?? []))];
const timelines = {};
const timelineOf = async (handle) => {
  // fxtwitter answers some profile requests with a spurious non-2xx; retry with backoff, report only the last failure.
  let r;
  for (const wait of [1500, 4000, 0]) {
    r = await fetch(`https://api.fxtwitter.com/2/profile/${handle}/statuses`);
    if (r.ok) break;
    if (wait) await new Promise((res) => setTimeout(res, wait));
  }
  if (!r.ok) throw new Error(`fxtwitter profile HTTP ${r.status} after 3 attempts: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  if (body.code !== 200) throw new Error(`fxtwitter profile code ${body.code}`);
  const own = (body.results ?? []).filter((p) => p.type === "status" && p.author?.screen_name?.toLowerCase() === handle.toLowerCase() && !p.replying_to && !p.reposted_by);
  own.sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
  const got = [];
  for (const p of own.slice(0, 5)) if (tweets[p.id] || (await crawl(p.id))) got.push(p.id);
  if (!got.length) throw new Error("no original posts (empty feed, suspended or only replies/reposts)");
  return got;
};
const queue = [...handles];
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (let h; (h = queue.shift()); ) {
      try {
        timelines[h] = await timelineOf(h);
      } catch (e) {
        failed.push(`@${h}\ttimeline not fetched: ${e.message}`);
      }
    }
  }),
);
const threaded = ids.filter((id) => tweets[id]?.thread_ids);
console.log(`threads: ${threaded.map((id) => `${id} +${tweets[id].thread_ids.length}`).join(", ") || "none"}`);
const sorted = Object.fromEntries(Object.entries(tweets).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(dir, "tweets.json"), JSON.stringify(sorted));
writeFileSync(join(dir, "timelines.json"), JSON.stringify(timelines));
console.log(`timelines.json: ${Object.keys(timelines).length} of ${handles.length} accounts, ${Object.values(timelines).flat().length} posts`);
console.log(`tweets.json: ${Object.keys(sorted).length} posts (${ids.length} notices)`);
if (failed.length) console.log(`not crawled (the card links to these instead):\n${failed.join("\n")}`);
