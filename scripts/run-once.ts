/**
 * Runs the historical preset once headless and prints the event log and result.
 * Usage: tsx scripts/run-once.ts [seed] [--config '{...}'] [--mask '{...}'] [--yearly]
 *   --yearly prints military of major countries every 26 weeks.
 */
import { readFileSync } from "node:fs";
import { MASK, createSimulation, formatDate, step, tickTime, type Scenario, type SimMap } from "../src/sim";

const map: SimMap = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../data/presets/historical.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const seed = argv[0] && !argv[0].startsWith("--") ? Number(argv[0]) : scenario.seed;
const config = JSON.parse(opt("config") ?? "{}");
const mask = opt("mask") ? JSON.parse(opt("mask")!) : MASK;
const MAJORS = ["GER", "ITA", "JAP", "UK", "FRA", "SOV", "USA", "CHN"];
const t0 = performance.now();
const sim = createSimulation(map, scenario, { seed, config, mask });
const ix = (t: string) => sim.tags.indexOf(t);
while (!sim.result) {
  if (argv.includes("--yearly") && sim.tick % (26 * 7 / sim.config.stepDays) === 0) {
    console.log(formatDate(tickTime(sim.startMs, sim.tick, sim.config.stepDays)), MAJORS.map((t) => `${t} ${sim.military[ix(t)].toFixed(0)}`).join(" "));
  }
  step(sim);
}
const result = sim.result!;
const ms = performance.now() - t0;
for (const e of sim.events) if (e.type !== "war") console.log(e.date, e.text);
console.log(result, `${ms.toFixed(0)} ms`);
console.log("military:", MAJORS.map((t) => `${t} ${sim.military[ix(t)].toFixed(1)}`).join("  "));
