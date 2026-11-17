#!/usr/bin/env node
// Fetches AGF 2026 exhibitor logos from the official AGF exhibitor list API,
// downscales them into public/maps/agf-2026/logos/<code>.webp, records each
// source URL in logos/SOURCES.tsv, and writes `logo` into map.json.
// Booth -> exhibitor matching lives in scripts/agf-2026-logos.tsv (hand-checked).
// Originals are kept in .cache/agf-2026-logos/. Needs ffmpeg with libwebp.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.agfkorea.com:3070/front/api/getAttend?yy=2026";
const mapPath = join(root, "src/maps/agf-2026/map.json");
const outDir = join(root, "public/maps/agf-2026/logos");
const cacheDir = join(root, ".cache/agf-2026-logos");
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheDir, { recursive: true });

const res = await fetch(API);
if (!res.ok) throw new Error(`${API}: HTTP ${res.status} ${await res.text()}`);
const body = await res.json();
if (body.intReturn !== 0) throw new Error(`${API}: intReturn ${body.intReturn}`);
const byName = new Map();
for (const e of body.listData) {
  const name = e.boothName.trim();
  if (byName.has(name) && byName.get(name).logoJpg !== e.logoJpg) throw new Error(`duplicate boothName: ${name}`);
  byName.set(name, e);
}

const rows = readFileSync(join(root, "scripts/agf-2026-logos.tsv"), "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => l.split("\t"));

const map = JSON.parse(readFileSync(mapPath, "utf8"));
const sources = ["code\tboothName\turl"];
const missing = [];
for (const [code, name] of rows) {
  const booth = map.booths.find((b) => b.code === code);
  const entry = byName.get(name.trim());
  if (!booth || !entry) {
    missing.push(`${code}\t${name}\t${!booth ? "no such booth" : "boothName not in API"}`);
    continue;
  }
  const url = entry.logoJpg;
  const orig = join(cacheDir, basename(new URL(url).pathname));
  if (!existsSync(orig)) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    writeFileSync(orig, Buffer.from(await r.arrayBuffer()));
  }
  const file = `${code}.webp`;
  // Fit inside 512x256 (logos are mostly wide), never upscale; alpha is kept.
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", orig,
    "-vf", "scale='min(512,iw)':'min(256,ih)':force_original_aspect_ratio=decrease",
    "-frames:v", "1", "-c:v", "libwebp", "-quality", "88", join(outDir, file),
  ]);
  booth.logo = `/maps/agf-2026/logos/${file}`;
  sources.push(`${code}\t${name.trim()}\t${url}`);
}

writeFileSync(join(outDir, "SOURCES.tsv"), sources.join("\n") + "\n");
writeFileSync(mapPath, JSON.stringify(map, null, 1));
console.log(`logos: ${sources.length - 1} written to ${outDir}`);
if (missing.length) {
  console.error(`unresolved mapping rows:\n${missing.join("\n")}`);
  process.exit(1);
}
