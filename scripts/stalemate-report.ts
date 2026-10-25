/**
 * Debug: for runs that end in a stalemate, shows who holds the victory cities, the landing-restriction regions
 * and the armies at the end. Usage: tsx scripts/stalemate-report.ts <candidates.json> <index> [runs]
 */
import { readFileSync } from "node:fs";
import { createSimulation, runToEnd, type Scenario, type SimMap } from "../src/sim";

const [file, idx, runsArg] = process.argv.slice(2);
const cand = JSON.parse(readFileSync(file, "utf8"))[Number(idx)];
const runs = Number(runsArg ?? 60);
const map: SimMap = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../data/presets/historical.json", import.meta.url), "utf8"));
let shown = 0;
for (let seed = 1; seed <= runs && shown < 8; seed++) {
  const sim = createSimulation(map, scenario, { seed, config: cand.config, mask: cand.mask });
  const r = runToEnd(sim);
  if (r.winner !== "stalemate") continue;
  shown++;
  const tag = (s: number) => sim.tags[sim.owner[s]];
  const cities = Object.entries(sim.cities).map(([c, s]) => `${c}:${tag(s)}`).join(" ");
  const regions = sim.restrictions.map((rs, i) => {
    const count: Record<string, number> = {};
    for (const s of rs.region) count[tag(s)] = (count[tag(s)] ?? 0) + 1;
    const held = scenario.landingRestrictions![i].defender;
    return `${held}-region{${Object.entries(count).map(([t, n]) => `${t} ${n}`).join(", ")}}`;
  }).join(" ");
  const mil = ["GER", "ITA", "JAP", "UK", "USA", "SOV"].map((t) => `${t} ${sim.military[sim.tags.indexOf(t)].toFixed(0)}`).join(" ");
  const cap = ["GER", "ITA", "JAP"].filter((t) => sim.capitulated[sim.tags.indexOf(t)]).join(",");
  console.log(`seed ${seed}: ${cities} | capitulated: ${cap || "-"} | ${regions} | army ${mil}`);
}
