/**
 * Re-derives the state ids in data/presets/historical.json that depend on the generated map
 * (state ids change when the map is rebuilt): the Maginot line (every French homeland state with a
 * land border to Germany, marked invulnerable), the North Africa region of the Italy landing rule, and
 * the Japanese home islands / Okinawa / Iwo Jima of the Japan landing rule.
 * Usage: npm run update-preset-ids
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { MapData } from "../src/sim/mapTypes";
import { makeStateLookup } from "./map/lookup";

const mapUrl = new URL("../data/map.json", import.meta.url);
const presetUrl = new URL("../data/presets/historical.json", import.meta.url);
const map: MapData = JSON.parse(readFileSync(mapUrl, "utf8"));
const preset = JSON.parse(readFileSync(presetUrl, "utf8"));

const maginot = map.states
  .filter((s) => s.owner === "FRA" && s.core && map.landAdj[s.id].some((n) => map.states[n].owner === "GER"))
  .map((s) => s.id);
preset.stateOverrides = Object.fromEntries(maginot.map((id) => [String(id), { invulnerable: true }]));

// North Africa (for the Italy landing restriction): states on the African mainland from Morocco to
// Egypt — flood fill over land borders from a state in Algeria, limited to a box, so islands
// (Sicily, Crete, Cyprus, Malta), the Levant and Sudan / the Sahel are excluded.
const NA_BOX = [-18, 21.8, 34.2, 38]; // south edge = Egypt–Sudan border
const inBox = (id: number) => {
  const [lon, lat] = map.states[id].lonlat;
  return lon >= NA_BOX[0] && lat >= NA_BOX[1] && lon <= NA_BOX[2] && lat <= NA_BOX[3];
};
const anchor = map.states.filter((s) => inBox(s.id)).reduce((a, b) =>
  Math.hypot(b.lonlat[0] - 3, b.lonlat[1] - 30) < Math.hypot(a.lonlat[0] - 3, a.lonlat[1] - 30) ? b : a).id;
const northAfrica = new Set([anchor]);
for (const queue = [anchor]; queue.length; ) {
  for (const n of map.landAdj[queue.pop()!]) if (!northAfrica.has(n) && inBox(n)) { northAfrica.add(n); queue.push(n); }
}
for (const r of preset.landingRestrictions ?? []) if (r.defender === "ITA") r.region = [...northAfrica].sort((a, b) => a - b);

// Japan: landings on the home islands (Honshu, Kyushu, Shikoku, Hokkaido and nearby islets) only after
// Okinawa and Iwo Jima have fallen. Home islands = Japanese homeland states in a box around them,
// excluding Korea (west of 131.2°E and north of 34°N) and the Ryukyus / Bonins (south of 30.9°N).
const homeIslands = map.states.filter((st) => {
  const [lon, lat] = st.lonlat;
  return st.owner === "JAP" && st.core && lon >= 129.2 && lon <= 146 && lat >= 30.9 && lat <= 45.6 && !(lon < 131.2 && lat > 34);
}).map((st) => st.id);
const stateAt = makeStateLookup(map);
const okinawa = stateAt(127.8, 26.3), iwoJima = stateAt(141.32, 24.78);
if (map.states[okinawa].owner !== "JAP" || map.states[iwoJima].owner !== "JAP") throw new Error("Okinawa / Iwo Jima not Japanese");
preset.landingRestrictions = (preset.landingRestrictions ?? []).filter((r: { defender: string }) => r.defender !== "JAP");
preset.landingRestrictions.push({
  defender: "JAP", coreOnly: true, protect: homeIslands, blockedWhileHeldBy: "axis", region: [okinawa, iwoJima],
  note: "日本本土(本州・九州・四国・北海道)への上陸は、沖縄と硫黄島がともに陥落してから",
});
writeFileSync(presetUrl, JSON.stringify(preset, null, 1) + "\n");
console.log(`Maginot line: ${maginot.length} states (${maginot.join(", ")})`);
const owners: Record<string, number> = {};
for (const id of northAfrica) owners[map.states[id].owner] = (owners[map.states[id].owner] ?? 0) + 1;
console.log(`Japan home islands: ${homeIslands.length} states; Okinawa #${okinawa} ${map.states[okinawa].lonlat}, Iwo Jima #${iwoJima} ${map.states[iwoJima].lonlat}`);
console.log(`North Africa: ${northAfrica.size} states (${Object.entries(owners).map(([t, n]) => `${t} ${n}`).join(", ")})`);
