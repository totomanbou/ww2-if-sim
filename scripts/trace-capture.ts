/**
 * Debug: prints the first states of a country taken by another country (date, place, how it was reached).
 * Usage: tsx scripts/trace-capture.ts <victimTag> <captorTag> [seed] [--config '{...}'] [--mask '{...}'] [--max 25]
 */
import { readFileSync } from "node:fs";
import { MASK, createSimulation, formatDate, step, tickTime, type Scenario } from "../src/sim";
import type { MapData } from "../src/sim/mapTypes";

const [victim, captor, seedArg] = process.argv.slice(2);
const opt = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const max = Number(opt("max") ?? 25);
const map: MapData = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../data/presets/historical.json", import.meta.url), "utf8"));
const sim = createSimulation(map, scenario, {
  seed: seedArg && !seedArg.startsWith("--") ? Number(seedArg) : scenario.seed,
  config: JSON.parse(opt("config") ?? "{}"),
  mask: opt("mask") ? JSON.parse(opt("mask")!) : MASK,
});
const v = sim.tags.indexOf(victim), c = sim.tags.indexOf(captor);
const where = (n: number) => `#${n} ${map.states[n].lonlat.join(",")}`;
let shown = 0;
while (!sim.result && shown < max) {
  const before = sim.owner.slice();
  step(sim);
  for (let s = 0; s < sim.nStates && shown < max; s++) {
    if (sim.origOwner[s] !== v || sim.owner[s] !== c || before[s] === c) continue;
    const land = map.landAdj[s].filter((n) => before[n] === c);
    const sea = map.seaRoutes.filter((r) => (r.a === s && before[r.b] === c) || (r.b === s && before[r.a] === c))
      .map((r) => (r.a === s ? r.b : r.a));
    console.log(formatDate(tickTime(sim.startMs, sim.tick - 1, sim.config.stepDays)), where(s),
      land.length ? `land from ${land.map(where).join(" ")}` : `sea from ${sea.map((n) => `${where(n)} (${map.states[n].owner})`).join(" ")}`,
      `| mil ${captor} ${sim.military[c].toFixed(0)} ${victim} ${sim.military[v].toFixed(0)}`);
    shown++;
  }
}
console.log(sim.result ?? "(stopped)");
