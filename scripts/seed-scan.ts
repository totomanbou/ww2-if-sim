/**
 * Prints the outcome, end date and a few key dates for a range of seeds (to pick a representative
 * default seed for the preset). Usage: tsx scripts/seed-scan.ts [from] [to]
 */
import { readFileSync } from "node:fs";
import { createSimulation, runToEnd, type Scenario, type SimMap } from "../src/sim";

const [from = 1939, to = 1950] = process.argv.slice(2).map(Number);
const map: SimMap = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../data/presets/historical.json", import.meta.url), "utf8"));
for (let seed = from; seed <= to; seed++) {
  const sim = createSimulation(map, scenario, { seed });
  const r = runToEnd(sim);
  const when = (type: string, tag: string) => sim.events.find((e) => e.type === type && e.countries[0] === tag)?.date ?? "-";
  console.log(seed, r.winner, r.endDate, `FRA- ${when("capitulation", "FRA")}`, `ITA- ${when("capitulation", "ITA")}`,
    `Berlin ${when("capitalFall", "GER")}`, `Tokyo ${when("capitalFall", "JAP")}`);
}
