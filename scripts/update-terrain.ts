/**
 * Writes the terrain difficulty of every state (scripts/map/terrain.ts) into data/map.json (`terrain`), without
 * rebuilding the map. Usage: npm run update-terrain (needs data/raw from npm run fetch-sources).
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { MapData } from "../src/sim/mapTypes";
import { terrainForMap } from "./map/terrain";

const file = new URL("../data/map.json", import.meta.url);
const map: MapData = JSON.parse(readFileSync(file, "utf8"));
const { terrain, score } = terrainForMap(map);
map.terrain = terrain;
writeFileSync(file, JSON.stringify(map));
const count = [0, 1, 2].map((k) => terrain.filter((t) => t === k).length);
console.log(`easy ${count[0]}, normal ${count[1]}, hard ${count[2]} of ${terrain.length}`);
writeFileSync(new URL("../.debug/terrain-scores.json", import.meta.url), JSON.stringify(score));
