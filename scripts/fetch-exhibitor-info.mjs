#!/usr/bin/env node
// Writes each booth's exhibitor intro (`promotionCopy`) and homepage from the official AGF exhibitor list API into
// map.json as `intro` / `homepage`. Booth -> exhibitor matching is the hand-checked scripts/agf-2026-logos.tsv
// shared with `npm run logos`; booths without a row there get neither field.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.agfkorea.com:3070/front/api/getAttend?yy=2026";
const mapPath = join(root, "src/maps/agf-2026/map.json");

const res = await fetch(API);
if (!res.ok) throw new Error(`${API}: HTTP ${res.status} ${await res.text()}`);
const body = await res.json();
if (body.intReturn !== 0) throw new Error(`${API}: intReturn ${body.intReturn}`);
const byName = new Map(body.listData.map((e) => [e.boothName.trim(), e]));

const rows = readFileSync(join(root, "scripts/agf-2026-logos.tsv"), "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => l.split("\t"));

const map = JSON.parse(readFileSync(mapPath, "utf8"));
let intros = 0;
let homepages = 0;
const missing = [];
for (const [code, name] of rows) {
  const booth = map.booths.find((b) => b.code === code);
  const entry = byName.get(name.trim());
  if (!booth || !entry) {
    missing.push(`${code}\t${name}\t${!booth ? "no such booth" : "boothName not in API"}`);
    continue;
  }
  // The official site strips tags the same way before showing the copy.
  const intro = entry.promotionCopy.replace(/<[^>]*>?/g, "").trim();
  delete booth.intro;
  delete booth.homepage;
  // A one- or two-character copy is a placeholder, not an intro.
  if (intro.length > 2) {
    booth.intro = intro;
    intros++;
  }
  const homepage = entry.homepage.trim();
  if (/^https?:\/\/\S+$/.test(homepage)) {
    booth.homepage = homepage;
    homepages++;
  } else if (homepage) {
    console.error(`${code}: skipped homepage ${JSON.stringify(entry.homepage)}`);
  }
}

writeFileSync(mapPath, JSON.stringify(map, null, 1));
console.log(`exhibitor info: ${intros} intros, ${homepages} homepages`);
if (missing.length) {
  console.error(`unresolved mapping rows:\n${missing.join("\n")}`);
  process.exit(1);
}
