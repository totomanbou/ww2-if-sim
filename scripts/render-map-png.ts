/**
 * Renders data/map.json to a PNG for checking the build without a browser.
 * Usage: tsx scripts/render-map-png.ts <out.png> [cx cy width] [--routes]
 *   cx, cy, width: view centre and width in map units (default: whole map).
 */
import { writeFileSync, readFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import type { MapData } from "../src/sim/mapTypes";

const args = process.argv.slice(2);
const routes = args.includes("--routes");
const [out, ...nums] = args.filter((a) => a !== "--routes");
const map: MapData = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const [cx, cy, vw] = nums.length >= 3 ? nums.map(Number) : [map.width / 2, map.height / 2, map.width];
const PW = 1600, PH = Math.round((PW * (nums.length >= 3 ? 0.6 : map.height / map.width)));
const s = PW / vw;
const c = createCanvas(PW, PH);
const g = c.getContext("2d");
g.fillStyle = "#a9c4d6";
g.fillRect(0, 0, PW, PH);
g.setTransform(s, 0, 0, s, PW / 2 - cx * s, PH / 2 - cy * s);

const hue = (tag: string) => {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
};
for (const st of map.states) {
  g.beginPath();
  for (const r of st.rings) {
    g.moveTo(r[0], r[1]);
    for (let k = 2; k < r.length; k += 2) g.lineTo(r[k], r[k + 1]);
    g.closePath();
  }
  g.fillStyle = `hsl(${hue(st.owner)} 45% ${52 + (st.id % 4) * 5}%)`;
  g.fill("evenodd");
  g.strokeStyle = "rgba(0,0,0,0.35)";
  g.lineWidth = 0.6 / s;
  g.stroke();
}
if (routes) {
  g.lineWidth = 1 / s;
  for (const r of map.seaRoutes) {
    const a = map.states[r.a].center, b = map.states[r.b].center;
    if (Math.abs(a[0] - b[0]) > map.width / 2) continue;
    g.strokeStyle = r.src === "manual" ? "rgba(200,0,0,0.9)" : "rgba(0,40,160,0.7)";
    g.beginPath();
    g.moveTo(a[0], a[1]);
    g.lineTo(b[0], b[1]);
    g.stroke();
  }
}
// Country tags at the largest state of each country, for orientation.
g.font = `${11 / s}px sans-serif`;
g.fillStyle = "#000";
for (const [tag, info] of Object.entries(map.countries)) {
  const st = map.states[info.defaultCapital];
  g.fillText(tag, st.center[0], st.center[1]);
}
writeFileSync(out, c.toBuffer("image/png"));
console.log(`wrote ${out}`);
