// Dev-only map preview for stage 1 (state generation, borders, sea routes) and draw benchmarks.
import mapUrl from "../data/map.json?url";
import type { MapData } from "./sim/mapTypes";
import { MapRenderer } from "./render/mapRenderer";

const hue = (tag: string) => {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
};

const t0 = performance.now();
const map: MapData = await (await fetch(mapUrl)).json();
const loadMs = performance.now() - t0;
const renderer = new MapRenderer(map, document.getElementById("map")!);
const colors = map.states.map((s) => `hsl(${hue(s.owner)} 45% ${55 + (s.id % 3) * 4}%)`);
const routes = document.getElementById("routes") as HTMLInputElement;
let highlight: number | null = null;
const draw = () => renderer.draw({ fill: (i) => colors[i], showSeaRoutes: routes.checked, highlight });
draw();
routes.onchange = draw;

const stats = document.getElementById("stats")!;
const seaAuto = map.seaRoutes.filter((r) => r.src === "auto").length;
stats.textContent =
  `ステート数: ${map.states.length}\n国: ${Object.keys(map.countries).length}\n` +
  `海路: ${map.seaRoutes.length}(自動 ${seaAuto} / 手動 ${map.seaRoutes.length - seaAuto})\n` +
  `map.json 読込+解析: ${loadMs.toFixed(0)} ms\n初回描画: ${renderer.lastDrawMs.toFixed(1)} ms`;

document.getElementById("bench")!.onclick = () => {
  const times: number[] = [];
  for (let k = 0; k < 200; k++) {
    // Change ~20 owners per frame, like a busy simulation week.
    for (let j = 0; j < 20; j++) colors[(k * 97 + j * 131) % colors.length] = `hsl(${(k * 7) % 360} 50% 55%)`;
    draw();
    times.push(renderer.lastDrawMs);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  stats.textContent += `\n\nベンチ(${renderer.canvas.width}×${renderer.canvas.height} px): 平均 ${avg.toFixed(2)} ms, ` +
    `中央値 ${times[100].toFixed(2)} ms, 95% ${times[190].toFixed(2)} ms`;
};

renderer.onHoverState = (id) => {
  if (id === highlight) return;
  highlight = id;
  draw();
  const hv = document.getElementById("hover")!;
  if (id === null) { hv.textContent = ""; return; }
  const s = map.states[id];
  const sea = map.seaRoutes.filter((r) => r.a === id || r.b === id).map((r) => `${r.a === id ? r.b : r.a}(${map.states[r.a === id ? r.b : r.a].owner}, ${r.km}km${r.name ? ", " + r.name : ""})`);
  hv.textContent = `#${id} ${s.owner}\n面積 ${s.areaKm2.toLocaleString()} km²\n中心 ${s.lonlat.join(", ")}\n沿岸: ${s.coastal}\n` +
    `陸の隣接: ${map.landAdj[id].map((n) => `${n}(${map.states[n].owner})`).join(" ")}\n海路: ${sea.join(" ") || "なし"}`;
};

// Debug hook: zoom to a lon/lat-ish box in map units from the console.
(window as any).__preview = { renderer, map, redraw: draw };
