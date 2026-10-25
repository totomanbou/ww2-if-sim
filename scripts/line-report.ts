/**
 * Debug: runs one seed to the end and reports the front line containing a given state: who is on it, the
 * army each country allocates there, naval power in the zones of the routes into the state.
 * Usage: tsx scripts/line-report.ts <candidates.json> <index> <seed> <stateId>
 */
import { readFileSync } from "node:fs";
import { allocateArmies, computeFronts } from "../src/sim/combat";
import { fleetPower, hasSuperiority } from "../src/sim/navy";
import { createSimulation, runToEnd, type Scenario, type SimMap } from "../src/sim";

const [file, idx, seedArg, stateArg] = process.argv.slice(2);
const cand = JSON.parse(readFileSync(file, "utf8"))[Number(idx)];
const map: SimMap = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../data/presets/historical.json", import.meta.url), "utf8"));
const sim = createSimulation(map, scenario, { seed: Number(seedArg), config: cand.config, mask: cand.mask });
console.log(runToEnd(sim));
const st = Number(stateArg);
const fronts = computeFronts(sim);
const l = fronts.line[st];
console.log(`state #${st} owner ${sim.tags[sim.owner[st]]}, line ${l}`);
if (l >= 0) {
  const alloc = allocateArmies(sim, fronts);
  for (const c of fronts.lineCountries.get(l)!) {
    console.log(`  ${sim.tags[c]} (${sim.faction[c]}): army ${sim.military[c].toFixed(1)}, on this line ${alloc.get(l)!.get(c)!.toFixed(2)}, lines total ${[...alloc.values()].filter((m) => m.has(c)).length}`);
  }
}
const power = fleetPower(sim);
const nZ = sim.zoneNames.length;
for (let k = sim.seaOff[st]; k < sim.seaOff[st + 1]; k++) {
  const t = sim.seaNb[k], z = sim.seaZone[k];
  const navy = sim.tags.map((tag, c) => [tag, power[c * nZ + z]] as const).filter(([, p]) => p > 0.5).map(([tag, p]) => `${tag} ${p.toFixed(0)}`).join(" ");
  const att = sim.owner[t];
  console.log(`  route to #${t} (${sim.tags[att]}) zone ${z} ${sim.zoneNames[z] ?? "-"}: navy [${navy}] superiority(${sim.tags[att]}→${sim.tags[sim.owner[st]]}) ${hasSuperiority(sim, power, att, sim.owner[st], z)}`);
}
