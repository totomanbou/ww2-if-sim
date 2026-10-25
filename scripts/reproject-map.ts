/**
 * One-time conversion of data/map.json from the Natural Earth projection to Mercator (scripts/map/projection.ts)
 * without rebuilding the map: every ring vertex is taken back to longitude/latitude with the old projection and
 * projected again; state centres, important-city positions and sea-zone centres are projected from their stored
 * longitudes/latitudes. Nothing else (adjacency, sea routes, terrain, ...) changes.
 * Usage: tsx scripts/reproject-map.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { MapData } from "../src/sim/mapTypes";
import { reprojectMap } from "./map/reproject";

const file = new URL("../data/map.json", import.meta.url);
const source: MapData = JSON.parse(readFileSync(file, "utf8"));
const map = reprojectMap(source);
writeFileSync(file, JSON.stringify(map));
console.log(`${source.projection} → ${map.projection}: ${map.states.length} states, ${map.width}×${map.height}; simulation data preserved`);
