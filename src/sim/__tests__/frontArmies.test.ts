import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeFronts } from "../combat";
import { parseDate, tickTime } from "../date";
import { step } from "../engine";
import { createSimulation } from "../init";
import type { Scenario, SimMap } from "../types";
import { createWeeklySimulation, makeMap, makeScenario, setWar } from "./helpers";

const realMap: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
const realPreset: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));

/** A: states 0, 1; B: states 2, 3; land chain 0-1-2-3, so the front states are 1 and 2. */
function chain() {
  const sim = createWeeklySimulation(
    makeMap({ owners: ["A", "A", "B", "B"], land: [[0, 1], [1, 2], [2, 3]] }),
    makeScenario({ A: {}, B: {} }),
  );
  sim.military.set([40, 25]);
  return sim;
}

describe("SimState.frontArmies", () => {
  it("is empty before the first step", () => {
    expect(chain().frontArmies).toEqual([]);
  });

  it("is empty after a step when nobody is at war", () => {
    const sim = chain();
    step(sim);
    expect(sim.frontArmies).toEqual([]);
  });

  it("holds one entry for a two-country land front, with armies sorted descending", () => {
    const sim = chain();
    setWar(sim, "A", "B");
    const fronts = computeFronts(sim);
    const expectedLine = fronts.line[1];
    const expectedStates = Array.from(fronts.frontStates).sort((p, q) => p - q);
    expect(expectedStates).toEqual([1, 2]);
    step(sim);
    expect(sim.frontArmies).toHaveLength(1);
    const f = sim.frontArmies[0];
    expect(f.line).toBe(expectedLine);
    expect(f.armies.map(([c]) => c).sort()).toEqual([0, 1]);
    for (const [, v] of f.armies) expect(v).toBeGreaterThan(0);
    for (let i = 1; i < f.armies.length; i++) expect(f.armies[i - 1][1]).toBeGreaterThanOrEqual(f.armies[i][1]);
    // A (40) has more army than B (25) at the start of the step (losses are applied after the snapshot).
    expect(f.armies[0][0]).toBe(0);
    expect(f.armies[0][1]).toBeGreaterThan(f.armies[1][1]);
    expect([...f.states].sort((p, q) => p - q)).toEqual(expectedStates);
  });

  it("lists exactly the states on both sides of the border as the line's states", () => {
    const sim = chain();
    setWar(sim, "A", "B");
    step(sim);
    // computed before ownership changes this step: border between states 1 (A) and 2 (B)
    expect([...sim.frontArmies[0].states].sort((p, q) => p - q)).toEqual([1, 2]);
  });

  it("puts the stronger country first when B is the larger army", () => {
    const sim = chain();
    sim.military.set([10, 50]);
    setWar(sim, "A", "B");
    step(sim);
    expect(sim.frontArmies).toHaveLength(1);
    expect(sim.frontArmies[0].armies[0][0]).toBe(1);
  });

  it("is rebuilt every step (does not accumulate)", () => {
    const sim = chain();
    setWar(sim, "A", "B");
    sim.config.advanceRate = 0;
    step(sim);
    step(sim);
    step(sim);
    expect(sim.frontArmies).toHaveLength(1);
  });

  it("has a separate entry for each disconnected front", () => {
    // Two independent duels: A-B on states 0-1, C-D on states 2-3.
    const sim = createWeeklySimulation(
      makeMap({ owners: ["A", "B", "C", "D"], land: [[0, 1], [2, 3]] }),
      makeScenario({ A: {}, B: {}, C: {}, D: {} }),
    );
    setWar(sim, "A", "B");
    setWar(sim, "C", "D");
    step(sim);
    expect(sim.frontArmies).toHaveLength(2);
    const pairs = sim.frontArmies.map((f) => f.armies.map(([c]) => c).sort().join(",")).sort();
    expect(pairs).toEqual(["0,1", "2,3"]);
  });

  it("is emptied again once the war is over (peace)", () => {
    const sim = chain();
    setWar(sim, "A", "B");
    step(sim);
    expect(sim.frontArmies).toHaveLength(1);
    const nC = sim.tags.length;
    sim.atWar.fill(0);
    expect(nC).toBe(2);
    step(sim);
    expect(sim.frontArmies).toEqual([]);
  });
});

describe("SimState.frontArmies on the historical preset", () => {
  it("has a front with both GER and SOV by August 1941", () => {
    const sim = createSimulation(realMap, realPreset);
    const ger = sim.tags.indexOf("GER");
    const sov = sim.tags.indexOf("SOV");
    expect(ger).toBeGreaterThanOrEqual(0);
    expect(sov).toBeGreaterThanOrEqual(0);
    const until = parseDate("1941-08-01");
    let guard = 0;
    while (!sim.result && tickTime(sim.startMs, sim.tick, sim.config.stepDays) < until) {
      step(sim);
      if (++guard > 5000) throw new Error("did not reach 1941-08-01");
    }
    expect(sim.result).toBeNull();
    expect(sim.frontArmies.length).toBeGreaterThan(0);
    const both = sim.frontArmies.filter((f) => f.armies.some(([c]) => c === ger) && f.armies.some(([c]) => c === sov));
    expect(both.length).toBeGreaterThan(0);
    for (const f of sim.frontArmies) {
      expect(f.states.length).toBeGreaterThan(0);
      for (let i = 1; i < f.armies.length; i++) expect(f.armies[i - 1][1]).toBeGreaterThanOrEqual(f.armies[i][1]);
    }
  });
});
