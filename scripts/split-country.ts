/**
 * Applies data/border-fixes.json "countrySplits" to an existing data/map.json (owners, core flags and the countries
 * table with stateCount / defaultCapital) without rebuilding the map; build-map.ts does the same for new builds.
 * Usage: tsx scripts/split-country.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { nearestState, splitCountries } from "./map/split";

const mapUrl = new URL("../data/map.json", import.meta.url);
const map = JSON.parse(readFileSync(mapUrl, "utf8"));
const fixes = JSON.parse(readFileSync(new URL("../data/border-fixes.json", import.meta.url), "utf8"));
const moved = splitCountries(map.states, fixes.countrySplits);
for (const sp of fixes.countrySplits) {
  for (const t of [sp.from, sp.tag]) {
    const own = map.states.filter((s: { owner: string }) => s.owner === t);
    const prev = map.countries[t];
    const c = fixes.capitals[t];
    const cap = prev && map.states[prev.defaultCapital]?.owner === t ? prev.defaultCapital : nearestState(map.states, t, c[0], c[1]);
    map.countries[t] = { stateCount: own.length, defaultCapital: cap };
  }
}
writeFileSync(mapUrl, JSON.stringify(map));
console.log("moved", Object.fromEntries(moved), Object.fromEntries(fixes.countrySplits.map((sp: { tag: string }) => [sp.tag, map.countries[sp.tag]])));
