/**
 * Prints the median army (陸軍力) of countries at a date over a range of seeds.
 * Usage: tsx scripts/army-at.ts <YYYY-MM-DD> <tags,comma-separated> [runs]
 */
import { readFileSync } from "node:fs";
import { createSimulation, parseDate, step, tickTime, type Scenario, type SimMap } from "../src/sim";

const [date, tagList, runsArg] = process.argv.slice(2);
const runs = Number(runsArg ?? 50);
const map: SimMap = JSON.parse(readFileSync(new URL("../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../data/presets/historical.json", import.meta.url), "utf8"));
const at = parseDate(date);
const values: Record<string, number[]> = {};
for (let seed = 1; seed <= runs; seed++) {
  const sim = createSimulation(map, scenario, { seed });
  while (!sim.result && tickTime(sim.startMs, sim.tick, sim.config.stepDays) <= at) step(sim);
  for (const t of tagList.split(",")) (values[t] ??= []).push(sim.military[sim.tags.indexOf(t)]);
}
for (const [t, v] of Object.entries(values)) {
  v.sort((a, b) => a - b);
  console.log(`${t}: median ${v[v.length >> 1].toFixed(1)} (p10 ${v[Math.floor(v.length * 0.1)].toFixed(1)}, p90 ${v[Math.floor(v.length * 0.9)].toFixed(1)})`);
}
