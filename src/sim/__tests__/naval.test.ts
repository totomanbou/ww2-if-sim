import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, resolveCombat } from "../combat";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

function seaDuel(attackerMilitary: number) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1]] }),
    makeScenario({ A: { shipbuilding: 1 }, B: {} }),
    { config: { advanceRate: 2, advanceMax: 1 } },
  );
  sim.military.set([attackerMilitary, 10]);
  setWar(sim, "A", "B");
  return sim;
}

describe("naval landings", () => {
  it("causes no capture or losses if the naval penalty removes the strength advantage", () => {
    const sim = seaDuel(15);
    expect(sim.config.navalPenalty).toBe(0.5);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toEqual([]);
    applyBattles(sim, battles);
    expect(Array.from(sim.owner)).toEqual([0, 1]);
    expect(Array.from(sim.military)).toEqual([15, 10]);
  });

  it("lands and incurs losses when three times the defender's military survives the penalty", () => {
    const sim = seaDuel(30);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0].captures).toEqual([1]);
    applyBattles(sim, battles);
    expect(sim.owner[1]).toBe(sim.tags.indexOf("A"));
    expect(sim.military[0]).toBeLessThan(30);
    expect(sim.military[1]).toBeLessThan(10);
  });

  it("classifies a state reachable by land from another attacker state as a land target", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "A", "B"], land: [[1, 2]], sea: [[0, 2]] }),
      makeScenario({ A: {}, B: {} }),
    );
    setWar(sim, "A", "B");
    const targets = computeFronts(sim).targets.get(0 * sim.tags.length + 1);
    expect(targets?.land.has(2)).toBe(true);
    expect(targets?.sea.has(2)).toBe(false);
  });
});
