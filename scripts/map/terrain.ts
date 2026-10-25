/**
 * Terrain difficulty of every state (user requirement: rate the land as a whole, per state, as easy / normal /
 * hard to conquer). Sources (Natural Earth, public domain, data/raw/ via npm run fetch-sources):
 * ne_10m_geography_regions_polys (mountain ranges, plateaus, deserts, plains, tundra, wetlands, deltas, ...) and
 * ne_10m_rivers_lake_centerlines (major rivers as obstacles). Each state is sampled at its centre and at points
 * between the centre and its outline; the share of samples in each terrain class weighs that class's score.
 *
 * Score (design values):
 *   +2   × share in mountain ranges ("Range/mtn")
 *   +0.5 × share in plateaus and foothills (mostly rolling uplands, e.g. the Central Russian Upland), +1 gorges
 *   +0.5 × share in deserts (supply; open ground otherwise, as in the North African campaign)
 *   +1.5 × share in tundra
 *   +1   × share in wetlands and deltas
 *   −1   × share in plains, lowlands, basins, valleys, depressions
 *   +1   jungle (tropical rain forest boxes below), +1 arctic (centre north of 66°N, unless already tundra),
 *   +1   marshes missing from the data (MARSH boxes: the Pripyat Marshes)
 *   +0.5 a major river (Natural Earth scalerank ≤ 4) runs through the state
 *   +0.5 a city: a victory city, a capital or an important city (urban fighting, fortifications)
 * Classes: score ≤ EASY_MAX → 0 easy, score ≥ HARD_MIN → 2 hard, otherwise 1 normal.
 */
import { readFileSync } from "node:fs";
import type { MapData } from "../../src/sim/mapTypes";
import { mapProjection } from "./projection";
import { makeStateLookup } from "./lookup";
import { applyTerrainOverrides } from "./terrain-overrides";

export const EASY_MAX = -0.4;
export const HARD_MIN = 1.2;

const CLASS_SCORE: Record<string, number> = {
  "Range/mtn": 2, Plateau: 0.5, Foothills: 0.5, Gorge: 1, Desert: 0.5, Tundra: 1.5, Wetlands: 1, Delta: 1,
  Plain: -1, Lowland: -1, Basin: -1, Valley: -1, Depression: -1,
};

/** Tropical rain forest (jungle), [west, south, east, north]: Malaya–Indonesia–New Guinea, Burma–Assam, Congo, Amazon, Central America. */
const JUNGLE: [number, number, number, number][] = [
  [94, -11, 155, 12], [92, 15, 99, 27], [10, -6, 30, 5], [-75, -12, -48, 5], [-92, 7, -77, 18],
];

/** Marshes Natural Earth does not have as wetlands: the Pripyat (Polesie) Marshes. */
const MARSH: [number, number, number, number][] = [[23.5, 51, 31, 53]];

type Ring = number[][];
interface Poly { cls: string; bbox: [number, number, number, number]; rings: Ring[][] }

function bboxOf(polys: Ring[][]): [number, number, number, number] {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of polys) for (const r of p) for (const [x, y] of r) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  return [w, s, e, n];
}

/** Even-odd test over a polygon's rings (outer ring and holes). */
function inPolygon(lon: number, lat: number, rings: Ring[]): boolean {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function loadRegions(file: URL): Poly[] {
  const g = JSON.parse(readFileSync(file, "utf8"));
  const out: Poly[] = [];
  for (const f of g.features) {
    const cls = f.properties.FEATURECLA as string;
    if (!(cls in CLASS_SCORE) || !f.geometry) continue;
    const polys: Ring[][] = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    out.push({ cls, bbox: bboxOf(polys), rings: polys });
  }
  return out;
}

function loadRivers(file: URL, maxRank: number): number[][][] {
  const g = JSON.parse(readFileSync(file, "utf8"));
  const out: number[][][] = [];
  for (const f of g.features) {
    if (!(f.properties.scalerank <= maxRank) || !f.geometry) continue;
    const lines: number[][][] = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
    out.push(...lines);
  }
  return out;
}

export interface TerrainResult {
  /** 0 easy, 1 normal, 2 hard per state id. */
  terrain: number[];
  score: number[];
}

/**
 * `invert` maps projected map units back to [lon, lat] (the map's projection). `stateAt(lon, lat)` returns the
 * state containing a point or -1 (for the rivers).
 */
export function buildTerrain(
  map: Pick<MapData, "states" | "cities" | "countries" | "importantCities">,
  invert: (x: number, y: number) => [number, number] | null,
  stateAt: (lon: number, lat: number) => number,
  rawDir = new URL("../../data/raw/", import.meta.url),
): TerrainResult {
  const regions = loadRegions(new URL("ne_10m_geography_regions_polys.geojson", rawDir));
  const rivers = loadRivers(new URL("ne_10m_rivers_lake_centerlines.geojson", rawDir), 4);
  const n = map.states.length;

  // Major rivers: states containing points along them (sampled every ~0.1°).
  const river = new Uint8Array(n);
  for (const line of rivers) {
    for (let i = 1; i < line.length; i++) {
      const [x0, y0] = line[i - 1], [x1, y1] = line[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.1));
      for (let k = 0; k <= steps; k++) {
        const s = stateAt(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps);
        if (s >= 0) river[s] = 1;
      }
    }
  }
  const city = new Uint8Array(n);
  for (const s of Object.values(map.cities)) city[s] = 1;
  for (const c of Object.values(map.countries)) if (c.defaultCapital >= 0) city[c.defaultCapital] = 1;
  for (const c of map.importantCities ?? []) city[c.state] = 1;

  const terrain: number[] = [], score: number[] = [];
  for (const st of map.states) {
    // Samples: the centre, and points 1/3 and 2/3 of the way to up to 12 vertices of the outer outline.
    const [clon, clat] = st.lonlat;
    const pts: [number, number][] = [[clon, clat]];
    const ring = st.rings.reduce((a, b) => (b.length > a.length ? b : a), [] as number[]);
    const nv = ring.length / 2, stride = Math.max(1, Math.floor(nv / 12));
    for (let v = 0; v < nv; v += stride) {
      const ll = invert(ring[2 * v], ring[2 * v + 1]);
      if (!ll) continue;
      for (const f of [1 / 3, 2 / 3]) pts.push([clon + (ll[0] - clon) * f, clat + (ll[1] - clat) * f]);
    }
    const share = new Map<string, number>();
    for (const [lon, lat] of pts) {
      const seen = new Set<string>();
      for (const r of regions) {
        if (seen.has(r.cls)) continue;
        const [w, s, e, nn] = r.bbox;
        if (lon < w || lon > e || lat < s || lat > nn) continue;
        if (r.rings.some((p) => inPolygon(lon, lat, p))) seen.add(r.cls);
      }
      for (const c of seen) share.set(c, (share.get(c) ?? 0) + 1 / pts.length);
    }
    let sc = 0;
    for (const [c, f] of share) sc += CLASS_SCORE[c] * f;
    if (JUNGLE.some(([w, s, e, nn]) => clon >= w && clon <= e && clat >= s && clat <= nn)) sc += 1;
    if (clat >= 66 && !share.has("Tundra")) sc += 1;
    if (MARSH.some(([w, s, e, nn]) => clon >= w && clon <= e && clat >= s && clat <= nn)) sc += 1;
    if (river[st.id]) sc += 0.5;
    if (city[st.id]) sc += 0.5;
    score.push(Math.round(sc * 100) / 100);
    terrain.push(sc <= EASY_MAX ? 0 : sc >= HARD_MIN ? 2 : 1);
  }
  // Scores remain the natural model's scores; named gameplay regions have an explicit final class.
  return { terrain: applyTerrainOverrides(map, terrain), score };
}

/**
 * buildTerrain for a finished map (map.json or build-map's output): the map's projection for the samples, and a
 * strict point-in-state test for the rivers (points at sea count for no state).
 */
export function terrainForMap(map: MapData): TerrainResult {
  const projection = mapProjection(map.width, map.projection);
  const lookup = makeStateLookup(map);
  const stateAt = (lon: number, lat: number) => {
    const s = lookup(lon, lat);
    if (s < 0) return -1;
    const [x, y] = projection([lon, lat])!;
    const inside = map.states[s].rings.some((r) => {
      let c = false;
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        if (r[i + 1] > y !== r[j + 1] > y && x < ((r[j] - r[i]) * (y - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
      }
      return c;
    });
    return inside ? s : -1;
  };
  return buildTerrain(map, (x, y) => projection.invert!([x, y]) as [number, number] | null, stateAt);
}
