// Run: node src/venue-view/check-contrast.mjs
// Catches a map label that renders unreadable on its fill: a new category or area colour (or a
// change to the Scene lights / ink rule) that leaves some label under WCAG 4.5:1 with no halo, as
// "NC 리프레시존" was (dark ink on lit purple #653183, 2.2:1). Mirrors Scene.tsx: booth names on the
// unlit top face and on every wall, area labels on the area top, hall labels on the floor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INK_DARK, INK_LIGHT, TEXT_MIN, WALLS, contrast, inkLuminance, inkOn } from "./contrast.ts";

const map = JSON.parse(readFileSync(new URL("../maps/agf-2026/map.json", import.meta.url), "utf8"));
const FLOOR = "#ffffff"; // unlit floor plane

const rows = [];
const check = (label, fill, shades) => {
  const ink = inkOn(fill, shades);
  const ok = ink.ratio >= TEXT_MIN || (ink.outline !== null && contrast(inkLuminance(ink.color), inkLuminance(ink.outline)) >= TEXT_MIN);
  rows.push({ label, fill, faces: shades.join("+"), ink: ink.color, ratio: ink.ratio.toFixed(2), halo: ink.outline ?? "-", ok });
};

for (const b of map.booths) {
  const fill = map.categories[b.category]?.color ?? "#999999";
  const name = b.exhibitor?.ko || b.exhibitor?.en || b.code;
  check(`${b.code} ${name}`, fill, ["flat"]);
  check(`${b.code} ${name} (walls)`, fill, WALLS);
}
for (const a of map.areas) {
  if (a.label === "") continue;
  if (a.kind !== "hall-label") assert.ok(a.color, `area ${a.id} has no colour; add its kind default here`);
  if (a.kind === "hall-label") check(`area ${a.id} ${a.label}`, FLOOR, ["flat"]);
  else check(`area ${a.id} ${a.label}`, a.color, ["top"]);
}

const worst = [...rows].sort((x, y) => x.ratio - y.ratio).slice(0, 8);
console.table(worst);
const fails = rows.filter((r) => !r.ok);
assert.equal(fails.length, 0, `labels under ${TEXT_MIN}:1 with no halo:\n${fails.map((r) => r.label).join("\n")}`);
assert.ok(contrast(inkLuminance(INK_DARK), inkLuminance(INK_LIGHT)) >= TEXT_MIN, "ink and halo must contrast");
// Road view lays lit grey concrete (HallInterior.tsx) over the white floor, but hall labels keep the ink picked
// for white. #a4a4a6 is the darkest panel tone measured in a road-view screenshot (joint lines aside).
const ROAD_FLOOR = "#a4a4a6";
const hallInk = inkOn(FLOOR, ["flat"]);
const roadRatio = contrast(inkLuminance(hallInk.color), inkLuminance(ROAD_FLOOR));
assert.ok(roadRatio >= TEXT_MIN, `hall label ink ${hallInk.color} on road floor ${ROAD_FLOOR} is ${roadRatio.toFixed(2)}:1`);
console.log(`ok: ${rows.length} label placements, ${rows.filter((r) => r.halo !== "-").length} with halo`);
