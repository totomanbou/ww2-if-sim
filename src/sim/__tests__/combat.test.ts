import { describe, expect, it } from "vitest";
import { advanceCount, applyBattles, computeFronts, pickTargets, resolveCombat } from "../combat";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeRng } from "../rng";
import { makeMap, makeScenario, setWar } from "./helpers";

function duel(a: number, b: number, lossRate = 0.1) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "B"], land: [[0, 1]] }),
    makeScenario({ A: {}, B: {} }),
    { config: { lossRate, advanceRate: 0 } },
  );
  setWar(sim, "A", "B");
  sim.military.set([a, b]);
  return sim;
}

describe("combat losses", () => {
  it("charges the defender L and the attacker exactly 2L", () => {
    const sim = duel(100, 40);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    const loss = sim.config.lossRate * Math.min(100, 40);
    expect(battles[0]).toMatchObject({ attacker: 0, defender: 1, loss });
    applyBattles(sim, battles);
    expect(40 - sim.military[1]).toBe(loss);
    expect(100 - sim.military[0]).toBe(2 * loss);
  });

  it("clamps both militaries at zero when losses exceed their reserves", () => {
    // A is stronger, but its 15 military is less than the attack cost 2 * 10.
    const sim = duel(15, 10, 1);
    applyBattles(sim, resolveCombat(sim, computeFronts(sim)));
    expect(Array.from(sim.military)).toEqual([0, 0]);
  });

  it.each([
    [30, 10, 0, 1],
    [10, 30, 1, 0],
  ])("the stronger side attacks (%i versus %i)", (a, b, attacker, defender) => {
    const sim = duel(a, b);
    expect(resolveCombat(sim, computeFronts(sim))).toMatchObject([{ attacker, defender }]);
  });

  it("does not battle when compared strengths are equal", () => {
    const sim = duel(20, 20);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toEqual([]);
    applyBattles(sim, battles);
    expect(Array.from(sim.military)).toEqual([20, 20]);
  });
});

describe("advance selection", () => {
  it.each([0, 0.5, 1])("advances zero states for ratio %s", (ratio) => {
    expect(advanceCount(ratio, 2, 6, makeRng(1))).toBe(0);
  });

  it("uses exact integer expectations and caps them at the maximum", () => {
    expect(advanceCount(2, 2, 6, makeRng(1))).toBe(2);
    expect(advanceCount(100, 2, 3, makeRng(1))).toBe(3);
  });

  it("rounds a fractional expectation to its floor or floor plus one", () => {
    for (let seed = 0; seed < 32; seed++) {
      expect([2, 3]).toContain(advanceCount(2.25, 2, 6, makeRng(seed)));
    }
  });

  it.each([0, 2, 10])("picks distinct candidate ids, up to k = %i", (k) => {
    const candidates = new Map([[7, 1], [11, 4], [23, 2]]);
    const selected = pickTargets(candidates, k, makeRng(1));
    expect(selected).toHaveLength(Math.min(k, candidates.size));
    expect(new Set(selected).size).toBe(selected.length);
    for (const id of selected) expect(candidates.has(id)).toBe(true);
  });

  it("takes only the starting frontline this week and advances further in later weeks", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "B", "B", "B"],
        land: [[0, 1], [1, 2], [2, 3], [3, 4]],
        capitals: { B: 4 },
      }),
      makeScenario({ A: { industry: 100 }, B: { industry: 1 } }),
      { config: { advanceRate: 1, advanceMax: 1 } },
    );
    setWar(sim, "A", "B");
    step(sim);
    expect(Array.from(sim.owner)).toEqual([0, 0, 0, 1, 1]);
    step(sim);
    expect(Array.from(sim.owner)).toEqual([0, 0, 0, 0, 1]);
    step(sim);
    expect(Array.from(sim.owner)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("liberation", () => {
  it.each([true, false])("respects liberateToOriginalOwner = %s", (liberate) => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B", "C", "C"], land: [[0, 2]], capitals: { C: 3 } }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "axis" }, C: { faction: "allies" },
      }),
      { config: { liberateToOriginalOwner: liberate, advanceRate: 1, advanceMax: 1 } },
    );
    sim.owner[2] = sim.tags.indexOf("B");
    sim.military.set([100, 10, 10]);
    setWar(sim, "A", "B");
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles[0].captures).toEqual([2]);
    applyBattles(sim, battles);
    expect(sim.owner[2]).toBe(sim.tags.indexOf(liberate ? "C" : "A"));
  });
});

describe("front comparison", () => {
  it("chooses different attackers when military is divided by front count", () => {
    const map = makeMap({ owners: ["A", "B", "A", "C"], land: [[0, 1], [2, 3]] });
    const scenario = makeScenario({ A: {}, B: {}, C: {} });
    for (const mode of ["nation", "divided"] as const) {
      const sim = createSimulation(map, scenario, { config: { frontComparisonMode: mode } });
      sim.military.set([30, 20, 10]);
      setWar(sim, "A", "B");
      setWar(sim, "A", "C");
      const fronts = computeFronts(sim);
      expect(Array.from(fronts.frontCount)).toEqual([2, 1, 1]);
      const battle = resolveCombat(sim, fronts).find(
        (b) => [b.attacker, b.defender].includes(sim.tags.indexOf("B")),
      );
      expect(battle).toMatchObject(mode === "nation"
        ? { attacker: 0, defender: 1, attStrength: 30, defStrength: 20 }
        : { attacker: 1, defender: 0, attStrength: 20, defStrength: 15 });
    }
  });
});
