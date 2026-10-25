/**
 * Map pre-processing: builds data/map.json from Natural Earth land + historical-basemaps 1938 borders.
 *
 * Pipeline (all on an equirectangular raster, see scripts/map/grid.ts):
 *  1. Rasterize land and 1938 countries, apply 1939-09 border fixes, fill unclaimed land by nearest country.
 *  2. Importance map gives a target state area per pixel; seeds are sampled with density ∝ 1/area.
 *  3. Geodesic Voronoi restricted to each country (multi-source Dijkstra over same-country land),
 *     relaxed with density-weighted Lloyd iterations. States therefore never cross 1939 borders.
 *  4. Merge slivers and tiny islands, keeping strategic islands from importance.json.
 *  5. Land adjacency from the raster; sea routes from a multi-source Dijkstra over sea pixels
 *     (pairs whose sea regions meet within SEA_ROUTE_MAX_KM), plus manual routes.
 *  6. Sea zones (data/sea-zones.json): every sea pixel goes to the zone whose seed point is nearest
 *     by sea (BFS); zone adjacency from touching pixels; each sea route belongs to the zone at its midpoint.
 *  7. Trace pixel boundaries, simplify with TopoJSON (shared arcs keep borders gap-free), project.
 *
 * Usage: npm run build-map  (needs data/raw/, see scripts/fetch-sources.ts)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { topology } from "topojson-server";
import { presimplify, simplify } from "topojson-simplify";
import { feature } from "topojson-client";
import {
  H, Heap, LAT_TOP, N, PX_KM, RES, W, haversineKm, latOf, lonOf, mulberry32, rowArea, rowCos, wrapDx, xOf, yOf,
} from "./map/grid";
import { pointInBbox, pointInRing, polygonsOf, rasterizePolygon } from "./map/raster";
import { traceRings } from "./map/trace";
import { addFormerOwners } from "./map/former-owner";
import { nearestState, splitCountries } from "./map/split";
import { buildImportantCities } from "./map/important-cities";
import { terrainForMap } from "./map/terrain";
import { PROJECTION_NAME, mapHeight, mapProjection } from "./map/projection";

// ---- Build parameters ----
const SEED = 19390901;
const LLOYD_ITERATIONS = 4;
/** States smaller than this fraction of their target area are merged into a same-country neighbour. */
const SLIVER_RATIO = 0.15;
/** Lone islands smaller than this fraction of the target are merged into the nearest same-country state... */
const ISLAND_MIN_RATIO = 0.25;
/** ...if that state is within this distance (km); otherwise they stay as their own state. */
const ISLAND_MERGE_KM = 400;
const SEA_ROUTE_MAX_KM = 250;
/** Visvalingam threshold in pixel² (removes the raster staircase). */
const SIMPLIFY_MIN_WEIGHT = 1.5;
/** Output coordinate space width (projected units). */
const OUT_WIDTH = 8000;

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
const readJson = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

const importance = readJson("data/importance.json");
const fixes = readJson("data/border-fixes.json");
const manualSea = readJson("data/sea-routes.manual.json");
const seaZonesFile = readJson("data/sea-zones.json");
const zoneDefs = seaZonesFile.zones as { name: string; at: [number, number] }[];

const NB8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const NB4 = NB8.slice(0, 4);
/** Neighbour index with x wrap, or -1 outside the grid. */
const nbIndex = (x: number, y: number, dx: number, dy: number) => {
  const ny = y + dy;
  if (ny < 0 || ny >= H) return -1;
  return ny * W + ((x + dx + W) % W);
};
/** Step length in km between neighbouring pixels. */
const stepKm = (y: number, dx: number, dy: number) => {
  const hx = PX_KM * rowCos[y] * Math.abs(dx), hy = PX_KM * Math.abs(dy);
  return Math.sqrt(hx * hx + hy * hy);
};

// ---- 1. Land and countries ----
const land = new Uint8Array(N);
for (const f of ["ne_10m_land.geojson", "ne_10m_minor_islands.geojson"]) {
  const g = readJson(`data/raw/${f}`);
  for (const feat of g.features) {
    if (feat.properties?.featurecla === "Null island") continue; // Natural Earth easter egg at 0°, 0°
    for (const poly of polygonsOf(feat.geometry)) rasterizePolygon(poly, (i) => (land[i] = 1));
  }
}
let landCount = 0;
for (let i = 0; i < N; i++) landCount += land[i];
log(`land pixels: ${landCount}`);

const tags: string[] = [];
const tagIndex = new Map<string, number>();
const tagId = (t: string) => {
  let k = tagIndex.get(t);
  if (k === undefined) {
    k = tags.length + 1; // 0 = none
    tags.push(t);
    tagIndex.set(t, k);
  }
  return k;
};
const country = new Uint16Array(N);
/** 1 = homeland (core) pixel, 0 = colony / occupied / mandate. Tags without a listed home feature are all core. */
const core = new Uint8Array(N);
const homeFeature = fixes.homeFeature as Record<string, string>;
{
  const g = readJson("data/raw/world_1938.geojson");
  const unknown = new Set<string>();
  for (const feat of g.features) {
    const p = feat.properties;
    if (p.NAME === null) continue;
    const tag = fixes.nameToTag[p.NAME] ?? fixes.subjectToTag[p.SUBJECTO];
    if (!tag) {
      unknown.add(`${p.NAME} / ${p.SUBJECTO}`);
      continue;
    }
    const id = tagId(tag);
    const isCore = homeFeature[tag] === undefined || homeFeature[tag] === p.NAME ? 1 : 0;
    for (const poly of polygonsOf(feat.geometry)) rasterizePolygon(poly, (i) => { if (land[i]) { country[i] = id; core[i] = isCore; } });
  }
  if (unknown.size) log(`WARNING unmapped 1938 features: ${[...unknown].join(", ")}`);
}
const overrides = (fixes.fillOverrides as any[]).filter((o) => o.tag);
for (let i = 0; i < N; i++) {
  if (!land[i] || country[i]) continue;
  const lon = lonOf(i % W), lat = latOf(Math.floor(i / W));
  for (const o of overrides) {
    if (o.bbox ? pointInBbox(lon, lat, o.bbox) : pointInRing(lon, lat, o.polygon)) {
      country[i] = tagId(o.tag);
      core[i] = homeFeature[o.tag] === undefined || o.core ? 1 : 0;
      break;
    }
  }
}
{
  // Nearest-country fill for the remaining unclaimed land (BFS over all pixels).
  const queue = new Int32Array(N);
  const seen = new Uint8Array(N);
  let qh = 0, qt = 0, filled = 0;
  for (let i = 0; i < N; i++) if (country[i]) { queue[qt++] = i; seen[i] = 1; }
  const src = new Uint16Array(N);
  const srcCore = new Uint8Array(N);
  for (let k = 0; k < qt; k++) { src[queue[k]] = country[queue[k]]; srcCore[queue[k]] = core[queue[k]]; }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of NB4) {
      const j = nbIndex(x, y, dx, dy);
      if (j < 0 || seen[j]) continue;
      seen[j] = 1;
      src[j] = src[i];
      srcCore[j] = srcCore[i];
      if (land[j] && !country[j]) { country[j] = src[i]; core[j] = srcCore[i]; filled++; }
      queue[qt++] = j;
    }
  }
  log(`nearest-country fill: ${filled} px; countries: ${tags.length}`);
}

// Region fixes run after the fill so they can also correct islands the fill gave to a neighbour.
for (const fix of fixes.regionFixes) {
  const from = new Set((fix.from as string[]).map(tagId));
  const to = tagId(fix.tag);
  let n = 0;
  rasterizePolygon([[...fix.polygon, fix.polygon[0]]], (i) => {
    if (land[i] && from.has(country[i])) {
      country[i] = to;
      core[i] = homeFeature[fix.tag] === undefined || fix.core ? 1 : 0;
      n++;
    }
  });
  log(`region fix "${fix.name}": ${n} px`);
}
// ---- 2. Importance map ----
const target = new Float32Array(N); // target state area (km²) for land pixels
const rules = importance.rules as { bbox: number[]; targetKm2: number }[];
for (let y = 0; y < H; y++) {
  const lat = latOf(y);
  const rowRules = rules.filter((r) => lat >= r.bbox[1] && lat <= r.bbox[3]);
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!land[i]) continue;
    const lon = lonOf(x);
    const r = rowRules.find((r) => lon >= r.bbox[0] && lon <= r.bbox[2]);
    target[i] = r ? r.targetKm2 : importance.defaultKm2;
  }
}

/** Nearest land pixel to a lon/lat within `radiusPx`, or -1. */
function nearestLand(lon: number, lat: number, radiusPx = 20): number {
  const cx = xOf(lon), cy = yOf(lat);
  let best = -1, bestD = Infinity;
  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      const j = nbIndex(cx, cy, dx, dy);
      if (j < 0 || !land[j]) continue;
      const d = (dx * rowCos[cy]) ** 2 + dy * dy;
      if (d < bestD) { bestD = d; best = j; }
    }
  }
  return best;
}

// ---- 3. Seeds and constrained geodesic Voronoi ----
const rng = mulberry32(SEED);
let seeds: number[] = [];
for (let i = 0; i < N; i++) {
  if (land[i] && rng() < rowArea[Math.floor(i / W)] / target[i]) seeds.push(i);
}
{
  // Every same-country land component needs at least one seed.
  const comp = new Int32Array(N).fill(-1);
  const hasSeed: boolean[] = [];
  const stack = new Int32Array(N);
  let nComp = 0;
  const firstPixel: number[] = [];
  for (let i = 0; i < N; i++) {
    if (!land[i] || comp[i] >= 0) continue;
    const c = nComp++;
    firstPixel.push(i);
    hasSeed.push(false);
    let sp = 0;
    stack[sp++] = i;
    comp[i] = c;
    while (sp) {
      const p = stack[--sp];
      const x = p % W, y = (p - x) / W;
      for (const [dx, dy] of NB8) {
        const j = nbIndex(x, y, dx, dy);
        if (j >= 0 && land[j] && comp[j] < 0 && country[j] === country[p]) { comp[j] = c; stack[sp++] = j; }
      }
    }
  }
  for (const s of seeds) hasSeed[comp[s]] = true;
  let added = 0;
  for (let c = 0; c < nComp; c++) if (!hasSeed[c]) { seeds.push(firstPixel[c]); added++; }
  log(`seeds: ${seeds.length} (${added} added for seedless components of ${nComp})`);
}

const label = new Int32Array(N);
const dist = new Float32Array(N);
function assign(seedList: number[]) {
  label.fill(-1);
  dist.fill(Infinity);
  const heap = new Heap();
  seedList.forEach((p, k) => { dist[p] = 0; label[p] = k; heap.push(0, p); });
  while (heap.size) {
    const d = heap.topKey();
    const p = heap.pop();
    if (d > dist[p]) continue;
    const x = p % W, y = (p - x) / W;
    for (const [dx, dy] of NB8) {
      const j = nbIndex(x, y, dx, dy);
      if (j < 0 || !land[j] || country[j] !== country[p]) continue;
      const nd = Math.fround(d + stepKm(y, dx, dy));
      if (nd < dist[j]) { dist[j] = nd; label[j] = label[p]; heap.push(nd, j); }
    }
  }
}

for (let it = 0; it <= LLOYD_ITERATIONS; it++) {
  assign(seeds);
  if (it === LLOYD_ITERATIONS) break;
  // Density-weighted centroids (CVT density ∝ target^-2 gives cell area ∝ target).
  const S = seeds.length;
  const sw = new Float64Array(S), sx = new Float64Array(S), sy = new Float64Array(S);
  for (let i = 0; i < N; i++) {
    const k = label[i];
    if (k < 0) continue;
    const x = i % W, y = (i - x) / W;
    const w = rowArea[y] / (target[i] * target[i]);
    const s = seeds[k];
    sw[k] += w;
    sx[k] += w * wrapDx(x - (s % W));
    sy[k] += w * y;
  }
  const best = new Int32Array(S).fill(-1);
  const bestD = new Float64Array(S).fill(Infinity);
  for (let i = 0; i < N; i++) {
    const k = label[i];
    if (k < 0) continue;
    const x = i % W, y = (i - x) / W;
    const s = seeds[k];
    const dx = (wrapDx(x - (s % W)) - sx[k] / sw[k]) * rowCos[y];
    const dy = y - sy[k] / sw[k];
    const d = dx * dx + dy * dy;
    if (d < bestD[k]) { bestD[k] = d; best[k] = i; }
  }
  seeds = seeds.map((s, k) => (best[k] >= 0 ? best[k] : s));
  log(`lloyd iteration ${it + 1}`);
}

// ---- 4. Merge slivers and tiny islands ----
let nStates = seeds.length;
{
  const area = new Float64Array(nStates);
  const cx = new Float64Array(nStates), cy = new Float64Array(nStates);
  const shared = new Map<number, number>(); // a*nStates+b -> shared edge count
  // Land components ignoring country, to detect lone islands.
  const landComp = new Int32Array(N).fill(-1);
  {
    const stack = new Int32Array(N);
    let c = 0;
    for (let i = 0; i < N; i++) {
      if (!land[i] || landComp[i] >= 0) continue;
      let sp = 0;
      stack[sp++] = i;
      landComp[i] = c;
      while (sp) {
        const p = stack[--sp];
        const x = p % W, y = (p - x) / W;
        for (const [dx, dy] of NB8) {
          const j = nbIndex(x, y, dx, dy);
          if (j >= 0 && land[j] && landComp[j] < 0) { landComp[j] = c; stack[sp++] = j; }
        }
      }
      c++;
    }
  }
  const statesInComp = new Map<number, Set<number>>();
  for (let i = 0; i < N; i++) {
    const s = label[i];
    if (s < 0) continue;
    const x = i % W, y = (i - x) / W;
    area[s] += rowArea[y];
    const sp = seeds[s];
    cx[s] += rowArea[y] * (sp % W + wrapDx(x - (sp % W)));
    cy[s] += rowArea[y] * y;
    let set = statesInComp.get(landComp[i]);
    if (!set) statesInComp.set(landComp[i], (set = new Set()));
    set.add(s);
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const j = nbIndex(x, y, dx, dy);
      if (j < 0 || label[j] < 0 || label[j] === s) continue;
      const a = Math.min(s, label[j]), b = Math.max(s, label[j]);
      shared.set(a * nStates + b, (shared.get(a * nStates + b) ?? 0) + 1);
    }
  }
  const lon = (s: number) => -180 + ((cx[s] / area[s]) + 0.5) * RES;
  const lat = (s: number) => LAT_TOP - ((cy[s] / area[s]) + 0.5) * RES;
  const keep = new Set<number>();
  for (const k of importance.keepIslands) {
    const p = nearestLand(k.lon, k.lat);
    if (p < 0) log(`WARNING keep island ${k.name} not found on land raster`);
    else keep.add(label[p]);
  }
  const neighbors: Map<number, number>[] = Array.from({ length: nStates }, () => new Map());
  for (const [key, n] of shared) {
    const a = Math.floor(key / nStates), b = key % nStates;
    neighbors[a].set(b, n);
    neighbors[b].set(a, n);
  }
  const parent = Int32Array.from({ length: nStates }, (_, i) => i);
  const find = (s: number): number => (parent[s] === s ? s : (parent[s] = find(parent[s])));
  const stateCountry = seeds.map((p) => country[p]);
  const byCountry = new Map<number, number[]>();
  seeds.forEach((_, s) => {
    const c = stateCountry[s];
    if (!byCountry.has(c)) byCountry.set(c, []);
    byCountry.get(c)!.push(s);
  });
  let slivers = 0, islands = 0;
  for (let s = 0; s < nStates; s++) {
    if (keep.has(s)) continue;
    const tgt = target[seeds[s]];
    const sameNb = [...neighbors[s]].filter(([t]) => stateCountry[t] === stateCountry[s]);
    if (area[s] < SLIVER_RATIO * tgt && sameNb.length) {
      sameNb.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
      parent[find(s)] = find(sameNb[0][0]);
      slivers++;
      continue;
    }
    const lone = statesInComp.get(landComp[seeds[s]])!.size === 1;
    if (lone && area[s] < ISLAND_MIN_RATIO * tgt) {
      let best = -1, bestD = ISLAND_MERGE_KM;
      for (const t of byCountry.get(stateCountry[s])!) {
        if (t === s || find(t) === find(s)) continue;
        // Centroid distance minus the candidate's approximate radius, so huge states (Greenland) still absorb offshore islets.
        const d = haversineKm(lon(s), lat(s), lon(t), lat(t)) - 0.6 * Math.sqrt(area[t]);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best >= 0) { parent[find(s)] = find(best); islands++; }
    }
  }
  // Renumber in raster order for deterministic ids.
  const newId = new Int32Array(nStates).fill(-1);
  let next = 0;
  for (let i = 0; i < N; i++) {
    const s = label[i];
    if (s < 0) continue;
    const r = find(s);
    if (newId[r] < 0) newId[r] = next++;
    label[i] = newId[r];
  }
  log(`merged ${slivers} slivers and ${islands} small islands: ${nStates} -> ${next} states`);
  nStates = next;
}

// ---- Final per-state attributes ----
const owner = new Uint16Array(nStates);
const corePx = new Float64Array(nStates);
const sArea = new Float64Array(nStates);
const refX = new Int32Array(nStates).fill(-1);
const sumX = new Float64Array(nStates), sumY = new Float64Array(nStates);
const coastal = new Uint8Array(nStates);
const landAdj = new Map<number, Set<number>>();
const addAdj = (a: number, b: number) => {
  if (!landAdj.has(a)) landAdj.set(a, new Set());
  if (!landAdj.has(b)) landAdj.set(b, new Set());
  landAdj.get(a)!.add(b);
  landAdj.get(b)!.add(a);
};
for (let i = 0; i < N; i++) {
  const s = label[i];
  if (s < 0) continue;
  const x = i % W, y = (i - x) / W;
  owner[s] = country[i];
  corePx[s] += core[i] * rowArea[y];
  sArea[s] += rowArea[y];
  if (refX[s] < 0) refX[s] = x;
  sumX[s] += rowArea[y] * (refX[s] + wrapDx(x - refX[s]));
  sumY[s] += rowArea[y] * y;
  for (const [dx, dy] of NB4) {
    const j = nbIndex(x, y, dx, dy);
    if (j < 0) continue;
    if (!land[j]) coastal[s] = 1;
    else if (label[j] !== s) addAdj(s, label[j]);
  }
}
const cLon = (s: number) => {
  const l = -180 + (sumX[s] / sArea[s] + 0.5) * RES;
  return l > 180 ? l - 360 : l < -180 ? l + 360 : l;
};
const cLat = (s: number) => LAT_TOP - (sumY[s] / sArea[s] + 0.5) * RES;

/** State at (or nearest to) a lon/lat; with `tag`, only land of that country counts. */
function stateAt(lon: number, lat: number, tag?: string): number {
  if (tag) {
    const cid = tagIndex.get(tag);
    const cx = xOf(lon), cy = yOf(lat);
    let best = -1, bestD = Infinity;
    for (let dy = -40; dy <= 40; dy++) for (let dx = -40; dx <= 40; dx++) {
      const j = nbIndex(cx, cy, dx, dy);
      if (j < 0 || !land[j] || country[j] !== cid) continue;
      const d = (dx * rowCos[cy]) ** 2 + dy * dy;
      if (d < bestD) { bestD = d; best = j; }
    }
    return best < 0 ? -1 : label[best];
  }
  const p = nearestLand(lon, lat, 40);
  return p < 0 ? -1 : label[p];
}

// ---- 5. Sea routes ----
const pairKey = (a: number, b: number) => (a < b ? a * nStates + b : b * nStates + a);
const seaRoutes = new Map<number, { a: number; b: number; km: number; src: "auto" | "manual"; name?: string }>();
{
  const R = SEA_ROUTE_MAX_KM / 2;
  const sLab = new Int32Array(N).fill(-1);
  const sDist = new Float32Array(N).fill(Infinity);
  const best = new Map<number, number>();
  const cand = (a: number, b: number, d: number) => {
    if (a === b) return;
    const k = pairKey(a, b);
    if (d < (best.get(k) ?? Infinity)) best.set(k, d);
  };
  const heap = new Heap();
  for (let i = 0; i < N; i++) {
    if (land[i]) continue;
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of NB4) {
      const j = nbIndex(x, y, dx, dy);
      if (j < 0 || !land[j]) continue;
      if (sLab[i] < 0) { sLab[i] = label[j]; sDist[i] = 0; heap.push(0, i); }
      else cand(sLab[i], label[j], 0);
    }
  }
  while (heap.size) {
    const d = heap.topKey();
    const p = heap.pop();
    if (d > sDist[p]) continue;
    const x = p % W, y = (p - x) / W;
    for (const [dx, dy] of NB8) {
      const j = nbIndex(x, y, dx, dy);
      if (j < 0 || land[j]) continue;
      const nd = Math.fround(d + stepKm(y, dx, dy));
      if (sLab[j] >= 0 && sLab[j] !== sLab[p]) cand(sLab[p], sLab[j], nd + sDist[j]);
      if (nd < sDist[j] && nd <= R) { sDist[j] = nd; sLab[j] = sLab[p]; heap.push(nd, j); }
    }
  }
  for (const [k, d] of best) {
    const a = Math.floor(k / nStates), b = k % nStates;
    if (d <= SEA_ROUTE_MAX_KM && !landAdj.get(a)?.has(b)) seaRoutes.set(k, { a, b, km: Math.round(d), src: "auto" });
  }
  log(`auto sea routes: ${seaRoutes.size}`);
}
for (const cut of manualSea.landCuts) {
  const a = stateAt(cut.a[0], cut.a[1]), b = stateAt(cut.b[0], cut.b[1]);
  if (a >= 0 && b >= 0 && landAdj.get(a)?.has(b)) {
    landAdj.get(a)!.delete(b);
    landAdj.get(b)!.delete(a);
    seaRoutes.set(pairKey(a, b), { a, b, km: Math.round(haversineKm(cut.a[0], cut.a[1], cut.b[0], cut.b[1])), src: "manual", name: cut.name });
  } else log(`note: land cut "${cut.name}" found no land adjacency (${a}, ${b})`);
}
for (const r of manualSea.remove) seaRoutes.delete(pairKey(stateAt(r.a[0], r.a[1]), stateAt(r.b[0], r.b[1])));
for (const r of manualSea.add) {
  const a = stateAt(r.a[0], r.a[1]), b = stateAt(r.b[0], r.b[1]);
  if (a < 0 || b < 0 || a === b) { log(`WARNING manual route "${r.name}" unresolved (${a}, ${b})`); continue; }
  seaRoutes.set(pairKey(a, b), { a, b, km: Math.round(haversineKm(r.a[0], r.a[1], r.b[0], r.b[1])), src: "manual", name: r.name });
}

// ---- 6. Sea zones ----
/** Nearest sea pixel to a lon/lat within `radiusPx`, or -1. */
function nearestSea(lon: number, lat: number, radiusPx = 60): number {
  const cx = xOf(lon), cy = yOf(lat);
  let best = -1, bestD = Infinity;
  for (let dy = -radiusPx; dy <= radiusPx; dy++) {
    for (let dx = -radiusPx; dx <= radiusPx; dx++) {
      const j = nbIndex(cx, cy, dx, dy);
      if (j < 0 || land[j]) continue;
      const d = (dx * rowCos[cy]) ** 2 + dy * dy;
      if (d < bestD) { bestD = d; best = j; }
    }
  }
  return best;
}
const zone = new Int16Array(N).fill(-1);
{
  const queue = new Int32Array(N);
  let qh = 0, qt = 0;
  zoneDefs.forEach((z, k) => {
    const p = nearestSea(z.at[0], z.at[1]);
    if (p < 0 || zone[p] >= 0) throw new Error(`sea zone ${z.name}: no free sea pixel near ${z.at}`);
    zone[p] = k;
    queue[qt++] = p;
  });
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W, y = (i - x) / W;
    for (const [dx, dy] of NB8) {
      const j = nbIndex(x, y, dx, dy);
      if (j < 0 || land[j] || zone[j] >= 0) continue;
      zone[j] = zone[i];
      queue[qt++] = j;
    }
  }
}
const zoneAdj = zoneDefs.map(() => new Set<number>());
for (let i = 0; i < N; i++) {
  const zi = zone[i];
  if (zi < 0) continue;
  const x = i % W, y = (i - x) / W;
  for (const [dx, dy] of [[1, 0], [0, 1]]) {
    const j = nbIndex(x, y, dx, dy);
    if (j >= 0 && zone[j] >= 0 && zone[j] !== zi) { zoneAdj[zi].add(zone[j]); zoneAdj[zone[j]].add(zi); }
  }
}
for (const [na, nb, why] of seaZonesFile.links as string[][]) {
  const za = zoneDefs.findIndex((z) => z.name === na), zb = zoneDefs.findIndex((z) => z.name === nb);
  if (za < 0 || zb < 0) throw new Error(`sea zone link ${na}-${nb} (${why}): unknown zone`);
  zoneAdj[za].add(zb);
  zoneAdj[zb].add(za);
}
const routeZone = new Map<number, number>();
{
  const perZone = new Int32Array(zoneDefs.length);
  let lake = 0;
  for (const [k, r] of seaRoutes) {
    let la = cLon(r.a), lb = cLon(r.b);
    if (Math.abs(la - lb) > 180) lb += la > lb ? 360 : -360;
    let mid = (la + lb) / 2;
    if (mid > 180) mid -= 360;
    if (mid < -180) mid += 360;
    const p = nearestSea(mid, (cLat(r.a) + cLat(r.b)) / 2, 80);
    const z = p < 0 ? -1 : zone[p];
    routeZone.set(k, z);
    if (z >= 0) perZone[z]++;
    else lake++;
  }
  // Routes whose midpoint is in water no zone reaches (lakes such as Geneva or Ladoga) get -1:
  // no fleet can be there, so no landing is possible on them.
  log(`routes without a sea zone (lakes): ${lake}`);
  log(`sea zones: ${zoneDefs.map((z, k) => `${z.name} ${perZone[k]}`).join(", ")}`);
}

// ---- 7. Geometry: trace, simplify, project ----
const rings = traceRings(label, nStates);
log(`traced ${rings.reduce((n, r) => n + r.length, 0)} rings`);
const fc = {
  type: "FeatureCollection" as const,
  features: rings.map((rs, s) => ({
    type: "Feature" as const,
    id: s,
    properties: {},
    geometry: { type: "MultiPolygon" as const, coordinates: rs.map((r) => [r]) },
  })),
};
let topo = topology({ states: fc as any });
topo = presimplify(topo as any);
topo = simplify(topo as any, SIMPLIFY_MIN_WEIGHT);
const simplified = feature(topo as any, (topo as any).objects.states) as any;
log("simplified geometry");

const projection = mapProjection(OUT_WIDTH);
const OUT_HEIGHT = mapHeight(OUT_WIDTH);
const project = (lon: number, lat: number) => projection([lon, lat])!.map(Math.round);

let pointCount = 0;
const states = simplified.features.map((f: any, s: number) => {
  const outRings: number[][] = [];
  for (const poly of f.geometry.coordinates) {
    for (const ring of poly) {
      const flat: number[] = [];
      for (const [i, j] of ring) {
        const [px, py] = project(-180 + i * RES, LAT_TOP - j * RES);
        const n = flat.length;
        if (n >= 2 && flat[n - 2] === px && flat[n - 1] === py) continue;
        flat.push(px, py);
      }
      if (flat.length >= 6) { outRings.push(flat); pointCount += flat.length / 2; }
    }
  }
  if (!outRings.length) {
    // Simplification collapsed a tiny state; keep its unsimplified pixel outline instead.
    for (const ring of rings[s]) {
      const flat = ring.flatMap(([i, j]) => project(-180 + i * RES, LAT_TOP - j * RES));
      outRings.push(flat);
      pointCount += flat.length / 2;
    }
  }
  const lon = cLon(s), lat = cLat(s);
  return {
    id: s,
    owner: tags[owner[s] - 1],
    areaKm2: Math.round(sArea[s]),
    lonlat: [+lon.toFixed(2), +lat.toFixed(2)],
    center: project(lon, lat),
    coastal: !!coastal[s],
    core: corePx[s] * 2 >= sArea[s],
    rings: outRings,
  };
});

// ---- Countries, capitals, cities ----
// Country splits (data/border-fixes.json countrySplits) on the finished states; their capitals by state centre.
const splitTags = new Set<string>();
for (const t of splitCountries(states, fixes.countrySplits ?? []).keys()) {
  splitTags.add(t);
  if (!tags.includes(t)) tags.push(t);
}
const countries: Record<string, { stateCount: number; defaultCapital: number }> = {};
for (const t of tags) {
  const own = states.filter((s: any) => s.owner === t);
  if (!own.length) continue;
  let cap = -1;
  const c = fixes.capitals[t];
  if (c && splitTags.has(t)) cap = nearestState(states, t, c[0], c[1]);
  else if (c) {
    cap = stateAt(c[0], c[1], t);
    if (cap < 0) log(`WARNING capital of ${t} not found near its coordinates; using largest state`);
  }
  if (cap < 0) cap = own.reduce((a: any, b: any) => (b.areaKm2 > a.areaKm2 ? b : a)).id;
  countries[t] = { stateCount: own.length, defaultCapital: cap };
}
const cities: Record<string, number> = {};
for (const [name, [lon, lat]] of Object.entries(fixes.cities as Record<string, number[]>)) {
  cities[name] = stateAt(lon, lat);
  log(`city ${name}: state ${cities[name]} (${states[cities[name]].owner})`);
}

const out = {
  version: 1,
  generated: { seed: SEED, resolutionDeg: RES, seaRouteMaxKm: SEA_ROUTE_MAX_KM },
  projection: PROJECTION_NAME,
  width: OUT_WIDTH,
  height: OUT_HEIGHT,
  countries,
  cities,
  importantCities: buildImportantCities(states, project),
  states,
  landAdj: states.map((s: any) => [...(landAdj.get(s.id) ?? [])].sort((a, b) => a - b)),
  seaRoutes: [...seaRoutes.entries()]
    .map(([k, r]) => ({ ...r, zone: routeZone.get(k) ?? -1 }))
    .sort((p, q) => p.a - q.a || p.b - q.b),
  seaZones: zoneDefs.map((z, k) => ({
    id: k, name: z.name, lonlat: z.at, center: project(z.at[0], z.at[1]), neighbors: [...zoneAdj[k]].sort((a, b) => a - b),
  })),
};
addFormerOwners(states, [...fixes.regionFixes, ...(fixes.formerOwners ?? [])]);
// Terrain difficulty per state (needs the Natural Earth physical data in data/raw).
(out as any).terrain = terrainForMap(out as any).terrain;
const json = JSON.stringify(out);
writeFileSync(new URL("../data/map.json", import.meta.url), json);

// ---- Summary ----
const areas = states.map((s: any) => s.areaKm2).sort((a: number, b: number) => a - b);
log(`states: ${states.length}, countries: ${Object.keys(countries).length}, points: ${pointCount}, ` +
  `land adjacencies: ${out.landAdj.reduce((n: number, a: number[]) => n + a.length, 0) / 2}, sea routes: ${out.seaRoutes.length}`);
log(`state area km² — median ${areas[areas.length >> 1]}, p10 ${areas[Math.floor(areas.length * 0.1)]}, p90 ${areas[Math.floor(areas.length * 0.9)]}`);
for (const r of rules as any[]) {
  const inR = states.filter((s: any) => pointInBbox(s.lonlat[0], s.lonlat[1], r.bbox));
  if (inR.length && r.targetKm2 <= 20000) {
    const mean = inR.reduce((a: number, s: any) => a + s.areaKm2, 0) / inR.length;
    log(`  region ${r.name}: ${inR.length} states, mean ${Math.round(mean)} km² (target ${r.targetKm2})`);
  }
}
log(`wrote data/map.json (${(json.length / 1e6).toFixed(1)} MB)`);
