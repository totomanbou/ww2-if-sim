import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { runToEnd } from "../engine";
import { createSimulation } from "../init";
import type { Scenario, SimMap } from "../types";

const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as SimMap;
const scenario = JSON.parse(
  readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"),
) as Scenario;

describe("historical determinism", () => {
  it("produces identical results and events within a time budget proportional to the update count", () => {
    const runs = Array.from({ length: 2 }, () => {
      const start = performance.now();
      const sim = createSimulation(map, scenario, { seed: scenario.seed });
      const result = runToEnd(sim);
      const elapsed = performance.now() - start;
      // One second per weekly resolution of a 1939–1945 war (about 315 weeks); half-week resolution processes twice as
      // many steps, and a longer war proportionally more.
      const weeks = sim.tick * sim.config.stepDays / 7;
      return { result, events: JSON.stringify(sim.events), elapsed, budgetMs: 1000 * 7 / sim.config.stepDays * Math.max(1, weeks / 315) };
    });
    expect(runs[0].result).toEqual(runs[1].result);
    expect(runs[0].events).toBe(runs[1].events);
    for (const run of runs) expect(run.elapsed).toBeLessThan(run.budgetMs);
  }, 30_000);
});
