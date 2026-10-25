/**
 * Seeded random search over tuning parameters (config coefficients and per-period mask factors).
 * Each candidate runs the historical preset on `--seeds` seeds and is scored on:
 *   - the allied win share (target 0.90; dominant term),
 *   - plausibility: France falls 1940–41, Britain usually holds, Italy lasts into 1942+,
 *     Berlin and Tokyo fall around 1944–47, Moscow usually holds.
 * Prints the best candidates as JSON (config + mask) for scripts/sweep.ts / batch.ts.
 * Usage: tsx scripts/tune.ts [--candidates 150] [--seeds 40] [--rng 1]
 */
import { readFileSync } from "node:fs";
import {
  DEFAULT_CONFIG, createSimulation, parseDate, runToEnd, step, tickTime, type MaskTable, type Scenario, type SimConfig, type SimMap,
} from "../src/sim";
import { makeRng, nextFloat } from "../src/sim/rng";

const arg = (n: string, d: number) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const N = arg("candidates", 150), SEEDS = arg("seeds", 40);
const rng = makeRng(arg("rng", 1));
const U = (a: number, b: number) => +(a + (b - a) * nextFloat(rng)).toFixed(3);
const pick = <T,>(xs: T[]) => xs[Math.floor(nextFloat(rng) * xs.length)];

const root = new URL("../", import.meta.url);
const map: SimMap = JSON.parse(readFileSync(new URL("data/map.json", root), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("data/presets/historical.json", root), "utf8"));

/** Periods: early 1939–41, mid 1942–44, late 1945–50. */
function periods(early: number, mid: number, late = 1): Record<number, number> {
  const out: Record<number, number> = {};
  for (let y = 1939; y <= 1950; y++) out[y] = y <= 1941 ? early : y <= 1944 ? mid : late;
  return out;
}

type Candidate = { config: Partial<SimConfig>; mask: MaskTable; sovRatio?: number };

function candidate(): Candidate {
  return {
    // Soviet initial army as a share of Germany's in June 1941 (60 % originally; the user allowed changing
    // it once Soviet losses against Germany were tripled).
    sovRatio: U(0.6, 1.5),
    config: {
      // Lower bound 0.008: with less the Soviet loss rule (lossFactors) barely matters (losses near 0).
      lossRate: U(0.008, 0.03),
      advanceRate: U(0.3, 2),
      advanceMax: pick([2, 3, 4, 6]),
      initialYears: U(0.5, 3),
      fleetBattleChance: U(0.1, 0.5),
      fleetBattleLossRate: U(0.05, 0.3),
      allocationDistanceKm: U(1000, 8000),
      transitSpeedKmPerWeek: U(200, 1000),
    },
    // USA's pre-war production is fixed at 0 by config.preWarGrowth, so only its wartime mask varies. Ranges widened
    // after the army production values were rewritten from 1938 data (UK, France, Japan and Italy became 2–3× larger,
    // so their masks may now need to be lower).
    mask: {
      // GER starts with 5 years of military (config.initialYearsByCountry), so its growth may be below 1.
      // Range raised after the user found Germany too weak with the 1938-based production values.
      GER: periods(U(0.8, 3.5), U(0.6, 3)),
      // ITA is searched again; config.regionPriority is re-calibrated afterwards for the North African ratio.
      ITA: periods(U(0.5, 3), U(0.5, 3)),
      JAP: periods(U(0.5, 4), U(0.5, 4)),
      USA: periods(1, U(0.6, 1.5)),
      SOV: periods(U(0.5, 1.5), U(0.6, 2)),
      // UK: small standing army (config.initialYearsByCountry.UK 0.5) and a low early mask, as the BEF was small; a
      // large British army in France slowed the 1940 campaign to August.
      UK: periods(U(0.3, 1.2), U(0.3, 2)),
      CHN: periods(U(0.5, 4), U(0.5, 4)),
    },
  };
}

const yearOf = (iso: string) => Number(iso.slice(0, 4)) + (Number(iso.slice(5, 7)) - 1) / 12;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const outside = (v: number, lo: number, hi: number) => (v < lo ? lo - v : v > hi ? v - hi : 0);

/**
 * The USSR starts with `ratio` × Germany's army in June 1941 (user requirement: 60 %, later allowed to change;
 * it produces nothing before its war). Germany's army then does not depend on the Soviet value (the USSR is not
 * at war before), so it is measured first (median over the seeds, at 1941-06-20) and the Soviet
 * initial years are set from it.
 */
export function sovietInitialYears(c: Candidate, seeds: number, ratio = 0.6): number {
  const at = parseDate("1941-06-20");
  const ger: number[] = [];
  for (let k = 0; k < seeds; k++) {
    const sim = createSimulation(map, scenario, { seed: 1 + k, config: c.config, mask: c.mask });
    while (!sim.result && tickTime(sim.startMs, sim.tick, sim.config.stepDays) <= at) step(sim);
    ger.push(sim.military[sim.tags.indexOf("GER")]);
  }
  const med = [...ger].sort((a, b) => a - b)[ger.length >> 1];
  const sov = scenario.countries.SOV;
  return +((ratio * med) / (sov.industry * sov.stability)).toFixed(3);
}

function evaluate(c: Candidate) {
  c.config.initialYearsByCountry = { ...DEFAULT_CONFIG.initialYearsByCountry, ...c.config.initialYearsByCountry };
  c.config.initialYearsByCountry.SOV = sovietInitialYears(c, SEEDS, c.sovRatio);
  let allies = 0;
  const when = (sim: ReturnType<typeof createSimulation>, type: string, tag: string) =>
    sim.events.find((e) => e.type === type && e.countries[0] === tag)?.date;
  const pol: number[] = [], fra: number[] = [], ita: number[] = [], ger: number[] = [], jap: number[] = [];
  let ukFall = 0, sovFall = 0, usaFall = 0;
  for (let k = 0; k < SEEDS; k++) {
    const sim = createSimulation(map, scenario, { seed: 1 + k, config: c.config, mask: c.mask });
    if (runToEnd(sim).winner === "allies") allies++;
    const end = 1951;
    const d = (t: string, tag: string) => { const x = when(sim, t, tag); return x ? yearOf(x) : end; };
    pol.push(d("capitulation", "POL"));
    fra.push(d("capitulation", "FRA"));
    ita.push(d("capitulation", "ITA"));
    ger.push(d("capitalFall", "GER"));
    jap.push(d("capitalFall", "JAP"));
    if (when(sim, "capitalFall", "UK")) ukFall++;
    if (when(sim, "capitalFall", "SOV")) sovFall++;
    if (when(sim, "capitalFall", "USA")) usaFall++;
  }
  const share = allies / SEEDS;
  const plaus = {
    // Poland falls in 1939–40 (added when Germany came out too weak to finish Poland in half the runs).
    // Tightened at the user's request: Poland and France should fall near the historical dates (Oct 1939, Jun 1940).
    pol: outside(median(pol), 1939.65, 1939.85),
    fra: outside(median(fra), 1940.4, 1940.6),
    ita: outside(median(ita), 1942.5, 1945.5),
    ger: outside(median(ger), 1944, 1947),
    jap: outside(median(jap), 1944, 1947),
    uk: Math.max(0, ukFall / SEEDS - 0.2),
    sov: Math.max(0, sovFall / SEEDS - 0.4),
    usa: usaFall / SEEDS,
  };
  const score = 20 * Math.abs(share - 0.9) + 10 * plaus.pol + 10 * plaus.fra + plaus.ita + plaus.ger + 0.5 * plaus.jap + 2 * plaus.uk + plaus.sov + 3 * plaus.usa;
  return { score, share, med: { pol: median(pol), fra: median(fra), ita: median(ita), ger: median(ger), jap: median(jap) }, ukFall, sovFall, usaFall };
}

const results: { score: number; c: ReturnType<typeof candidate>; e: ReturnType<typeof evaluate> }[] = [];
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const c = candidate();
  const e = evaluate(c);
  results.push({ score: e.score, c, e });
  if ((i + 1) % 10 === 0) {
    const best = results.reduce((a, b) => (b.score < a.score ? b : a));
    console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${i + 1}/${N} best score ${best.score.toFixed(2)} share ${best.e.share}`);
  }
}
results.sort((a, b) => a.score - b.score);
console.log(JSON.stringify(results.slice(0, 5).map((r, i) => ({
  label: `tune#${i} score ${r.score.toFixed(2)}`, eval: r.e, sovRatio: r.c.sovRatio, config: r.c.config, mask: r.c.mask,
})), null, 1));
