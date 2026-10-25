/**
 * Runs the historical preset headless for many seeds and prints the outcome distribution.
 * Usage: npm run batch -- --runs 200 [--seed0 1] [--scenario data/presets/historical.json]
 * Tuning options:
 *   --config '{"lossRate":0.02}'      override SimConfig fields
 *   --mask '{"USA":{"1940":0.5}}'     replace the mask table (default: src/sim/mask.ts)
 *   --detail                          also print when major countries capitulate / lose their capital
 *   --brief                           one summary line only (for parameter sweeps)
 */
import { readFileSync } from "node:fs";
import { MASK, createSimulation, runToEnd, type MaskTable, type Scenario, type SimEvent, type SimMap, type SimResult } from "../src/sim";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const runs = Number(arg("runs", "200"));
const seed0 = Number(arg("seed0", "1"));
const scenarioPath = arg("scenario", "data/presets/historical.json");
const config = JSON.parse(arg("config", "{}"));
const mask: MaskTable = process.argv.includes("--mask") ? JSON.parse(arg("mask", "{}")) : MASK;
const detail = process.argv.includes("--detail");
const brief = process.argv.includes("--brief");

const root = new URL("../", import.meta.url);
const map: SimMap = JSON.parse(readFileSync(new URL("data/map.json", root), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL(scenarioPath, root), "utf8"));

const results: SimResult[] = [];
const times: number[] = [];
const eventLogs: SimEvent[][] = [];
for (let k = 0; k < runs; k++) {
  const t0 = performance.now();
  const sim = createSimulation(map, scenario, { seed: seed0 + k, config, mask });
  results.push(runToEnd(sim));
  times.push(performance.now() - t0);
  eventLogs.push(sim.events);
}

if (brief) {
  const n = (w: string) => results.filter((r) => r.winner === w).length;
  const ends = results.map((r) => r.endTick).sort((a, b) => a - b);
  const year = (t: number) => (1939 + 8 / 12 + (t * 7) / 365.25).toFixed(1);
  console.log(`allies ${((100 * n("allies")) / runs).toFixed(1)}%  axis ${((100 * n("axis")) / runs).toFixed(1)}%  ` +
    `stalemate ${((100 * n("stalemate")) / runs).toFixed(1)}%  end median ${year(ends[runs >> 1])} (p10 ${year(ends[Math.floor(runs * 0.1)])}, p90 ${year(ends[Math.floor(runs * 0.9)])})`);
  process.exit(0);
}

const pct = (n: number) => `${((100 * n) / runs).toFixed(1)}%`;
const count = (f: (r: SimResult) => boolean) => results.filter(f).length;
console.log(`\n${scenario.name}: ${runs} runs (seeds ${seed0}..${seed0 + runs - 1})\n`);
console.log("勝利陣営の分布");
for (const [label, w] of [["連合国", "allies"], ["枢軸国", "axis"], ["膠着", "stalemate"]] as const) {
  const n = count((r) => r.winner === w);
  console.log(`  ${label.padEnd(4, "　")} ${String(n).padStart(4)}  ${pct(n)}`);
}
console.log("\n勝利条件の成立回数");
for (const [label, c] of [["枢軸A", "axisA"], ["枢軸B", "axisB"], ["連合国", "allies"]] as const) {
  console.log(`  ${label.padEnd(4, "　")} ${String(count((r) => r.condition === c)).padStart(4)}`);
}
console.log("\n終結日の分布(年別)");
const byYear = new Map<string, Record<string, number>>();
for (const r of results) {
  const y = r.endDate.slice(0, 4);
  const row = byYear.get(y) ?? { allies: 0, axis: 0, stalemate: 0 };
  row[r.winner]++;
  byYear.set(y, row);
}
for (const y of [...byYear.keys()].sort()) {
  const row = byYear.get(y)!;
  const n = row.allies + row.axis + row.stalemate;
  console.log(`  ${y}  ${String(n).padStart(4)}  ${"#".repeat(Math.ceil((40 * n) / runs)).padEnd(40)} 連合 ${row.allies} / 枢軸 ${row.axis} / 膠着 ${row.stalemate}`);
}
const ends = results.map((r) => r.endTick).sort((a, b) => a - b);
console.log(`  終結ティック 中央値 ${ends[ends.length >> 1]}(最小 ${ends[0]} / 最大 ${ends[ends.length - 1]})`);
if (detail) {
  console.log("\n主要国の首都陥落・降伏(発生率と日付の中央値)");
  const median = (xs: string[]) => xs.sort()[xs.length >> 1];
  for (const tag of ["POL", "FRA", "UK", "SOV", "CHN", "USA", "GER", "ITA", "JAP"]) {
    const cells = (["capitalFall", "capitulation"] as const).map((type) => {
      const dates = eventLogs.map((ev) => ev.find((e) => e.type === type && e.countries[0] === tag)?.date).filter((d): d is string => !!d);
      return `${type === "capitalFall" ? "首都陥落" : "降伏"} ${pct(dates.length).padStart(6)} ${dates.length ? median(dates) : "—".padEnd(10)}`;
    });
    console.log(`  ${tag.padEnd(4)} ${cells.join("   ")}`);
  }
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / runs;
console.log(`\n1回あたりの計算時間: 平均 ${avg.toFixed(1)} ms、中央値 ${times[runs >> 1].toFixed(1)} ms、最大 ${times[runs - 1].toFixed(1)} ms`);
