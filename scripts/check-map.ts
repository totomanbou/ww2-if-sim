/**
 * Sanity checks for data/map.json: owners of known places in September 1939, victory cities,
 * key land borders and sea links, and graph consistency. Exits non-zero on failure.
 * Usage: npm run check-map
 */
import { readFileSync } from "node:fs";
import type { MapData } from "../src/sim/mapTypes";
import { makeStateLookup } from "./map/lookup";

const map: MapData = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const S = map.states;

const stateAt = makeStateLookup(map);

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${msg}`);
};

const expected: [string, number, number, string][] = [
  ["Vienna", 16.37, 48.21, "GER"], ["Prague", 14.42, 50.08, "GER"], ["Danzig", 18.65, 54.35, "GER"],
  ["Klaipeda", 21.14, 55.71, "GER"], ["Bratislava", 17.11, 48.15, "SLO"], ["Uzhhorod", 22.3, 48.62, "HUN"],
  ["Warsaw", 21.01, 52.23, "POL"], ["Vilnius", 25.28, 54.69, "POL"], ["Lwow", 24.03, 49.84, "POL"],
  ["Kaunas", 23.9, 54.9, "LIT"], ["Riga", 24.1, 56.95, "LAT"], ["Helsinki", 24.94, 60.17, "FIN"],
  ["Aland", 19.95, 60.1, "FIN"], ["Bornholm", 14.9, 55.12, "DEN"], ["Copenhagen", 12.57, 55.68, "DEN"],
  ["Gotland", 18.5, 57.5, "SWE"], ["Oslo", 10.75, 59.91, "NOR"], ["Reykjavik", -21.9, 64.13, "DEN"],
  ["Tirana", 19.82, 41.33, "ITA"], ["Rhodes", 28.0, 36.2, "ITA"], ["Tripoli", 13.19, 32.89, "ITA"],
  ["Addis Ababa", 38.75, 9.03, "ITA"], ["Malta", 14.45, 35.88, "UK"], ["Cyprus", 33.4, 35.1, "UK"],
  ["Cairo", 31.24, 30.04, "UK"], ["Jerusalem", 35.2, 31.77, "UK"], ["Aden", 45.03, 12.8, "UK"],
  ["Tunis", 10.18, 36.8, "FRA"], ["Algiers", 3.06, 36.75, "FRA"], ["Damascus", 36.3, 33.5, "FRA"],
  ["Tetouan", -5.37, 35.57, "SPA"], ["Dakar", -17.3, 14.75, "FRA"], ["Hanoi", 105.85, 21.03, "FRA"],
  ["Saigon", 106.7, 10.8, "FRA"], ["Phnom Penh", 104.9, 11.55, "FRA"],
  ["Harbin", 126.6, 45.75, "JAP"], ["Seoul", 126.98, 37.57, "JAP"], ["Taipei", 121.5, 25.03, "JAP"],
  ["Peking", 116.4, 39.9, "JAP"], ["Shanghai", 121.47, 31.23, "JAP"], ["Nanjing", 118.8, 32.06, "JAP"],
  ["Wuhan", 114.3, 30.6, "JAP"], ["Canton", 113.26, 23.13, "JAP"], ["Hainan", 109.8, 19.2, "JAP"],
  ["Chongqing", 106.55, 29.56, "CHN"], ["Changsha", 112.94, 28.23, "CHN"], ["Xian", 108.94, 34.34, "CHN"],
  ["Hong Kong", 114.17, 22.3, "UK"], ["Singapore", 103.82, 1.35, "UK"], ["Rangoon", 96.16, 16.8, "UK"],
  ["Colombo", 79.86, 6.93, "UK"], ["Batavia", 106.8, -6.2, "NEI"], ["Manila", 120.98, 14.6, "USA"],
  ["Guam", 144.79, 13.44, "USA"], ["Wake", 166.63, 19.29, "USA"], ["Midway", -177.37, 28.21, "USA"],
  ["Saipan", 145.75, 15.18, "JAP"], ["Truk", 151.85, 7.42, "JAP"], ["Rabaul", 152.2, -4.2, "AST"],
  ["Guadalcanal", 160.0, -9.6, "UK"], ["Vladivostok", 131.9, 43.1, "SOV"], ["Ulaanbaatar", 106.9, 47.9, "MON"],
  ["Bangkok", 100.5, 13.75, "SIA"], ["Tehran", 51.39, 35.69, "IRN"], ["Ankara", 32.85, 39.93, "TUR"],
  ["Madrid", -3.7, 40.42, "SPA"], ["Lisbon", -9.14, 38.72, "POR"], ["Bern", 7.45, 46.95, "SWI"],
  ["Ottawa", -75.7, 45.42, "CAN"], ["Washington", -77.04, 38.9, "USA"], ["Juneau", -134.4, 58.3, "USA"],
];
for (const [name, lon, lat, tag] of expected) {
  const s = stateAt(lon, lat);
  check(S[s].owner === tag, `${name} -> ${S[s].owner} (expected ${tag}, state ${s})`);
}

const cityOwner: Record<string, string> = {
  London: "UK", Moscow: "SOV", Honolulu: "USA", Paris: "FRA", Rome: "ITA", Berlin: "GER", Tokyo: "JAP",
};
for (const [c, tag] of Object.entries(cityOwner)) {
  const s = map.cities[c as keyof typeof map.cities];
  check(S[s]?.owner === tag, `city ${c}: state ${s} (${S[s]?.owner})`);
}
for (const [tag, info] of Object.entries(map.countries)) {
  if (S[info.defaultCapital].owner !== tag) check(false, `capital of ${tag} is owned by ${S[info.defaultCapital].owner}`);
}

const landPairs = (a: string, b: string) => {
  let n = 0;
  map.landAdj.forEach((ns, i) => ns.forEach((j) => { if (S[i].owner === a && S[j].owner === b) n++; }));
  return n;
};
const seaPairs = (a: string, b: string) =>
  map.seaRoutes.filter((r) => (S[r.a].owner === a && S[r.b].owner === b) || (S[r.a].owner === b && S[r.b].owner === a)).length;
for (const [a, b] of [["GER", "FRA"], ["GER", "POL"], ["POL", "SOV"], ["UK", "ITA"], ["JAP", "CHN"], ["JAP", "SOV"], ["GER", "BEL"], ["FRA", "ITA"]]) {
  check(landPairs(a, b) > 0, `land border ${a}-${b}: ${landPairs(a, b)} state pairs`);
}
check(landPairs("GER", "SOV") === 0, "no GER-SOV land border in 1939");
check(landPairs("DEN", "SWE") === 0, "no DEN-SWE land border (Oresund is sea)");
for (const [a, b] of [["UK", "FRA"], ["JAP", "USA"], ["USA", "UK"], ["ITA", "UK"]]) {
  check(seaPairs(a, b) > 0, `sea link ${a}-${b}: ${seaPairs(a, b)} routes`);
}

// Graph consistency: symmetric land adjacency, routes reference valid distinct states.
let asym = 0;
map.landAdj.forEach((ns, i) => ns.forEach((j) => { if (!map.landAdj[j].includes(i)) asym++; }));
check(asym === 0, `land adjacency symmetric (${asym} asymmetric)`);
check(map.seaRoutes.every((r) => r.a !== r.b && S[r.a] && S[r.b]), "sea routes valid");
check(S.every((s, i) => s.id === i && s.rings.length > 0), "state ids contiguous and every state has geometry");
const isolated = S.filter((s) => map.landAdj[s.id].length === 0 && !map.seaRoutes.some((r) => r.a === s.id || r.b === s.id));
console.log(`info: ${isolated.length} states with no land or sea connection (unreachable islands): ` +
  isolated.map((s) => `${s.owner}@${s.lonlat.join(",")}`).join(" "));

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
