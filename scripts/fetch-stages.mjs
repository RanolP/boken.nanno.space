#!/usr/bin/env node
// Crawls the official AGF stage timetables (the API behind https://www.agfkorea.com/stage?idx=1 red / idx=2 blue) and
// writes src/maps/agf-2026/stages.json, so a click on the RED/BLUE STAGE opens its timetable without calling the
// AGF API at runtime (the site is static). Shape: { red: { "12-05": Entry[] }, blue: { ... } }, each day sorted by time.
// stageComment is HTML ("<br />" line breaks, entities); it is stored as plain text with newlines, never as markup.
// Guests come from getStageTimeline, the TIME/STAGE/GUEST table the official page itself shows, matched on time + name.
// stageImg names a file under the site's stageImgUrl, but that path answered 404 for every image when this was written
// (the official page does not show them either); each image is checked and left out (with a log line) unless it loads.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const YEAR = 2026;
const API = "https://api.agfkorea.com:3070/front/api";
const IMG = "https://bc8azosk4j.ecn.cdn.ofs.kr/AGF/stage/";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src/maps/agf-2026/stages.json");

const get = async (path) => {
  const r = await fetch(`${API}/${path}`);
  const body = await r.text();
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}: ${body.slice(0, 200)}`);
  const j = JSON.parse(body);
  if (j.intReturn !== 0 || !Array.isArray(j.listData)) throw new Error(`${path}: unexpected response ${body.slice(0, 200)}`);
  return j.listData;
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
// The admin leaves a full-width space ("　") in a field it means to be empty; it is trimmed like any other blank.
const decodeOnce = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? all),
  );
// Some fields arrive encoded twice ("&amp;amp;" for "&"), so decode until the text stops changing (a few passes at most).
const decode = (s) => {
  for (let i = 0; i < 4; i++) {
    const next = decodeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s;
};
/** HTML fragment to plain text: <br> to newlines, other tags dropped, entities decoded, blank lines at the ends trimmed. */
const text = (html) =>
  decode(
    (html ?? "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[\s　]+$/u, ""))
    .join("\n")
    .replace(/^[\s　]+|[\s　]+$/gu, "");

const days = await get(`getStageMain?yy=${YEAR}`);
const stages = { red: {}, blue: {} };
for (const { gubun, stageDay } of days) {
  if (!(gubun in stages)) throw new Error(`unknown stage gubun ${JSON.stringify(gubun)}`);
  const list = await get(`getStageList?gubun=${gubun}&stageDay=${stageDay}&yy=${YEAR}`);
  const timeline = await get(`getStageTimeline?yy=${YEAR}&gubun=${gubun}&stageDay=${stageDay}`);
  const guestOf = new Map(timeline.map((t) => [`${text(t.stageTime)}|${text(t.stageName)}`, text(t.guest)]));
  stages[gubun][stageDay] = (
    await Promise.all(
      list.map(async (e) => {
        const time = text(e.stageTime);
        const name = text(e.stageName);
        const guest = guestOf.get(`${time}|${name}`);
        if (guest === undefined) console.log(`${gubun} ${stageDay} ${time} ${name}: not in getStageTimeline, no guest`);
        let image = e.stageImg ? IMG + e.stageImg : "";
        if (image) {
          const r = await fetch(image, { method: "HEAD" });
          if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) {
            console.log(`${gubun} ${stageDay} ${time}: image left out, ${image} -> HTTP ${r.status} ${r.headers.get("content-type")}`);
            image = "";
          }
        }
        return { time, name, guest: guest ?? "", comment: text(e.stageComment), image, copyright: text(e.copyright), url: e.url || "" };
      }),
    )
  ).sort((a, b) => a.time.localeCompare(b.time));
}
for (const g of Object.keys(stages)) stages[g] = Object.fromEntries(Object.entries(stages[g]).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(out, JSON.stringify(stages, null, 2) + "\n");
for (const [g, byDay] of Object.entries(stages))
  console.log(`${g}: ${Object.entries(byDay).map(([d, l]) => `${d} ${l.length}`).join(", ")}`);
