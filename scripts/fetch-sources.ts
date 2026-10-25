/**
 * Downloads the map source data into data/raw/ (not committed).
 * Usage: npm run fetch-sources
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

const SOURCES: Record<string, string> = {
  // historical-basemaps (A. Ourednik), GPL-3.0
  "world_1938.geojson": "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson/world_1938.geojson",
  "HB_LICENSE.txt": "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/LICENSE",
  // Natural Earth, public domain
  "ne_10m_land.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson",
  "ne_10m_minor_islands.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_minor_islands.geojson",
  // Natural Earth physical data for the terrain difficulty of states (scripts/map/terrain.ts), public domain
  "ne_10m_geography_regions_polys.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_geography_regions_polys.geojson",
  "ne_10m_rivers_lake_centerlines.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson",
};

const dir = new URL("../data/raw/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, url] of Object.entries(SOURCES)) {
  const dest = new URL(name, dir);
  if (existsSync(dest) && !process.argv.includes("--force")) {
    console.log(`skip ${name} (exists)`);
    continue;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`fetched ${name}`);
}
