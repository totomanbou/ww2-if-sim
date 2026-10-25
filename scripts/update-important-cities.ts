import { readFileSync, writeFileSync } from "node:fs";
import type { MapData } from "../src/sim/mapTypes";
import { buildImportantCities } from "./map/important-cities";
import { mapProjection } from "./map/projection";

const file = new URL("../data/map.json", import.meta.url);
const map: MapData = JSON.parse(readFileSync(file, "utf8"));
const projection = mapProjection(map.width, map.projection);
map.importantCities = buildImportantCities(map.states, (lon, lat) => projection([lon, lat])!);
writeFileSync(file, JSON.stringify(map));
for (const city of map.importantCities) console.log(`${city.name}: state ${city.state} (${map.states[city.state].owner})`);
