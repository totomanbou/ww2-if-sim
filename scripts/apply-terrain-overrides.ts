/** Apply explicit terrain policies without rebuilding geography or recomputing unrelated natural terrain. */
import { readFileSync, writeFileSync } from "node:fs";
import type { MapData } from "../src/sim/mapTypes";
import { applyTerrainOverrides } from "./map/terrain-overrides";

const file = new URL("../data/map.json", import.meta.url);
const map: MapData = JSON.parse(readFileSync(file, "utf8"));
const before = map.terrain ?? Array<number>(map.states.length).fill(1);
map.terrain = applyTerrainOverrides(map, before);
writeFileSync(file, JSON.stringify(map));
const changes = map.states.filter((s) => before[s.id] !== map.terrain![s.id]).map((s) => ({
  id: s.id, owner: s.owner, lonlat: s.lonlat, before: before[s.id], after: map.terrain![s.id],
}));
console.log(JSON.stringify({ changed: changes.length, toEasy: changes.filter((c) => c.after === 0).length,
  toHard: changes.filter((c) => c.after === 2).length, states: changes }, null, 2));
