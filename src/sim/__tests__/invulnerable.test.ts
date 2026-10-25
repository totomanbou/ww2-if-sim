import { describe, expect, it } from "vitest";
import { capitulate } from "../capitulation";
import { applyBattles, computeFronts, resolveCombat } from "../combat";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

function protectedDuel(a: number, b: number) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "B"], land: [[0, 1]] }),
    makeScenario({ A: {}, B: {} }, [], [1]),
    { config: { growthMode: "yearly", advanceRate: 1, advanceMax: 1 } },
  );
  sim.military.set([a, b]);
  setWar(sim, "A", "B");
  return sim;
}

describe("invulnerable states", () => {
  it("excludes the protected state from targets and causes no battle or losses on its only front", () => {
    const sim = protectedDuel(1000, 10);
    expect(sim.scenario.stateOverrides?.["1"]).toEqual({ invulnerable: true });
    const fronts = computeFronts(sim);
    for (const targets of fronts.targets.values()) {
      expect(targets.land.has(1)).toBe(false);
      expect(targets.sea.has(1)).toBe(false);
    }
    expect(resolveCombat(sim, fronts)).toEqual([]);
    step(sim);
    expect(Array.from(sim.owner)).toEqual([0, 1]);
    expect(Array.from(sim.military)).toEqual([1000, 10]);
  });

  it("allows the stronger owner to attack out of its protected state", () => {
    const sim = protectedDuel(10, 1000);
    expect(computeFronts(sim).targets.get(1 * sim.tags.length + 0)?.land.has(0)).toBe(true);
    step(sim);
    expect(sim.owner[0]).toBe(sim.tags.indexOf("B"));
    expect(sim.owner[1]).toBe(sim.tags.indexOf("B"));
  });

  it("permanently loses protection when capitulation transfers the state", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B", "C"], land: [[0, 1]] }),
      makeScenario({ A: {}, B: {}, C: {} }, [], [1]),
      { config: { advanceRate: 1, advanceMax: 1 } },
    );
    setWar(sim, "A", "B");
    expect(computeFronts(sim).targets.get(0 * sim.tags.length + 1)).toBeUndefined();
    capitulate(sim, sim.tags.indexOf("B"), sim.tags.indexOf("C"));
    expect(sim.capitulated[1]).toBe(1);
    expect(sim.owner[1]).toBe(sim.tags.indexOf("C"));
    expect(sim.invLost[1]).toBe(1);
    setWar(sim, "A", "C");
    sim.military.set([1000, 0, 10]);
    const fronts = computeFronts(sim);
    expect(fronts.targets.get(0 * sim.tags.length + 2)?.land.has(1)).toBe(true);
    const battles = resolveCombat(sim, fronts);
    expect(battles[0].captures).toEqual([1]);
    applyBattles(sim, battles);
    expect(sim.owner[1]).toBe(sim.tags.indexOf("A"));
  });
});
