import { readFileSync } from "node:fs";
import definitions from "../../data/terrain-overrides.json";
import type { MapData } from "../../src/sim/mapTypes";
import { mapProjection } from "./projection";
import { polygonsOverlap } from "./polygon-intersection";

interface Rule {
  id: string;
  name: string;
  terrain: number;
  onlyFrom?: number[];
  owners?: string[];
  boxes?: number[][];
  geometry?: string;
  geometryMode?: string;
}
type Rings = number[][][];
type Geometry = { type: string; coordinates: number[][][] | number[][][][] };

const rules: Rule[] = definitions.rules;
const polygons = new Map<string, Rings[]>();
export type TerrainOverrideMap = Pick<MapData, "states"> & Partial<Pick<MapData, "width" | "projection">>;
const projectedCache = new WeakMap<TerrainOverrideMap, Map<string, Rings[]>>();
for (const rule of rules) {
  if (!rule.geometry) continue;
  const json = JSON.parse(readFileSync(new URL(`../../data/${rule.geometry}`, import.meta.url), "utf8")) as {
    features: { geometry: Geometry }[];
  };
  polygons.set(rule.id, json.features.flatMap(({ geometry }) =>
    geometry.type === "Polygon" ? [geometry.coordinates as Rings] : geometry.coordinates as Rings[]));
}

function contains(lon: number, lat: number, rings: Rings): boolean {
  let inside = false;
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function terrainRegionAt(id: string, lon: number, lat: number, owner = "SOV"): boolean {
  const rule = rules.find((r) => r.id === id);
  if (!rule) return false;
  if (rule.owners && !rule.owners.includes(owner)) return false;
  if (rule.boxes && !rule.boxes.some(([w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n)) return false;
  if (rule.geometry && !polygons.get(id)!.some((p) => contains(lon, lat, p))) return false;
  return true;
}

/** Include border states whose centre lies outside Ukraine but whose territory overlaps it. */
export function terrainStateInRegion(id: string, map: TerrainOverrideMap, state: MapData["states"][number]): boolean {
  if (terrainRegionAt(id, ...state.lonlat, state.owner)) return true;
  const rule = rules.find((r) => r.id === id);
  if (!rule?.geometry || rule.geometryMode !== "intersects" || !map.width || !map.projection || !state.rings.length) return false;
  if (rule.owners && !rule.owners.includes(state.owner)) return false;
  let projected = projectedCache.get(map);
  if (!projected) projectedCache.set(map, (projected = new Map()));
  let ps = projected.get(id);
  if (!ps) {
    const p = mapProjection(map.width, map.projection);
    ps = polygons.get(id)!.map((poly) => poly.map((ring) => ring.map((ll) => p(ll as [number, number])!)));
    projected.set(id, ps);
  }
  const stateRings = state.rings.map((r) => Array.from({ length: r.length / 2 }, (_, i) => [r[2 * i], r[2 * i + 1]]));
  return ps.some((poly) => polygonsOverlap(stateRings, poly));
}

/** The state graph and the natural terrain score are preserved; explicit policies override only the class. */
export function applyTerrainOverrides(map: TerrainOverrideMap, terrain: number[]): number[] {
  if (terrain.length !== map.states.length) throw new Error("Terrain length must match map states");
  return map.states.map((state, i) => {
    let value = terrain[i];
    for (const rule of rules) {
      if (rule.onlyFrom && !rule.onlyFrom.includes(value)) continue;
      if (terrainStateInRegion(rule.id, map, state)) value = rule.terrain;
    }
    return value;
  });
}
