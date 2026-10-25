import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { resolveFleetBattles } from "../navy";
import { makeMap, makeScenario, setWar } from "./helpers";

function prepareFight(attacks: boolean, lossFactors: SimConfig["lossFactors"] = {}) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "E", "B"], land: [[0, 1], [2, 1]] }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" }, E: { faction: "axis" },
    }),
    {
      seed: 17,
      config: {
        holdShare: 0,
        lowPriorityFronts: {},
        slowAdvanceLand: {},
        capitulateOnCapitalLoss: [],
        indirectFrontPriority: 1,
        overseasDistanceFactor: 1,
        transitSpeedKmPerWeek: 1e9,
        frontComparisonMode: "allocated",
        advanceRate: 0,
        lossRate: 0.1,
        lossFactors,
      },
    },
  );
  for (const [tag, army] of Object.entries({ A: 60, B: 40, E: attacks ? 50 : 200 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
  }
  setWar(sim, "A", "E");
  setWar(sim, "B", "E");
  return sim;
}

function fight(attacks: boolean, lossFactors: SimConfig["lossFactors"] = {}) {
  const sim = prepareFight(attacks, lossFactors);
  const before = sim.military.slice();
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  expect(attacks ? battles[0].attackers : battles[0].defenders).toContain(sim.tags.indexOf("A"));
  expect(battles[0].captures).toEqual([]);
  applyBattles(sim, battles);
  const decreases = Object.fromEntries(sim.tags.map((tag, c) => [tag, before[c] - sim.military[c]]));
  return { sim, before, decreases };
}

describe("cumulative combat losses", () => {
  it("initializes all four loss counters to zero", () => {
    expect(prepareFight(true).losses).toEqual({
      axis: { army: 0, navy: 0 }, allies: { army: 0, navy: 0 },
    });
  });

  it("defaults to 37,000 people per loss", () => {
    expect(DEFAULT_CONFIG.peoplePerLoss).toBe(37_000);
    expect(prepareFight(true).config.peoplePerLoss).toBe(37_000);
  });

  it.each([false, true])("counts each country's actual army decrease (allies attack = %s)", (attacks) => {
    const { sim, decreases } = fight(attacks, { A: { E: 3 }, E: { A: 0.5, B: 0.5 } });
    for (const tag of ["A", "B", "E"]) expect(decreases[tag]).toBeGreaterThan(0);
    expect(sim.losses.allies.army).toBeCloseTo(decreases.A + decreases.B, 8);
    expect(sim.losses.axis.army).toBeCloseTo(decreases.E, 8);
    expect(sim.losses.allies.navy).toBe(0);
    expect(sim.losses.axis.navy).toBe(0);
  });

  it.each([false, true])("caps army losses at available military (allies attack = %s)", (attacks) => {
    const { sim, before } = fight(attacks, {
      A: { E: 10_000 }, B: { E: 10_000 }, E: { A: 10_000, B: 10_000 },
    });
    expect(Array.from(sim.military)).toEqual([0, 0, 0]);
    expect(sim.losses.allies.army).toBe(before[sim.tags.indexOf("A")] + before[sim.tags.indexOf("B")]);
    expect(sim.losses.axis.army).toBe(before[sim.tags.indexOf("E")]);
  });

  it("accumulates army losses across battles", () => {
    const sim = prepareFight(true);
    const before = sim.military.slice();
    let previousAllies = 0, previousAxis = 0;
    for (let round = 0; round < 2; round++) {
      const battles = resolveCombat(sim, computeFronts(sim));
      expect(battles).toHaveLength(1);
      applyBattles(sim, battles);
      expect(sim.losses.allies.army).toBeGreaterThan(previousAllies);
      expect(sim.losses.axis.army).toBeGreaterThan(previousAxis);
      previousAllies = sim.losses.allies.army;
      previousAxis = sim.losses.axis.army;
    }
    const decrease = (tag: string) => {
      const c = sim.tags.indexOf(tag);
      return before[c] - sim.military[c];
    };
    expect(sim.losses.allies.army).toBeCloseTo(decrease("A") + decrease("B"), 8);
    expect(sim.losses.axis.army).toBeCloseTo(decrease("E"), 8);
  });

  it("excludes a neutral country's army decrease from faction losses", () => {
    const sim = createSimulation(
      makeMap({ owners: ["N", "E"], land: [[0, 1]] }),
      makeScenario({ N: { faction: "neutral" }, E: { faction: "axis" } }),
      { seed: 17, config: { advanceRate: 0, lossRate: 0.1, lossFactors: {}, holdShare: 0 } },
    );
    sim.military[sim.tags.indexOf("N")] = 100;
    sim.military[sim.tags.indexOf("E")] = 50;
    setWar(sim, "N", "E");
    const before = sim.military.slice();
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    applyBattles(sim, battles);
    const neutral = sim.tags.indexOf("N"), axis = sim.tags.indexOf("E");
    expect(before[neutral] - sim.military[neutral]).toBeGreaterThan(0);
    expect(sim.losses.axis.army).toBeGreaterThan(0);
    expect(sim.losses.axis.army).toBeCloseTo(before[axis] - sim.military[axis], 8);
    expect(sim.losses.allies).toEqual({ army: 0, navy: 0 });
    expect(sim.losses.axis.navy).toBe(0);
  });
});

function fleetBattle(lossRate = 0.1) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "B", "E", "N", "P"], land: [] }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" }, E: { faction: "axis" },
      N: { faction: "neutral" }, P: { faction: "axis" },
    }),
    { seed: 17, config: { fleetBattleChance: 1, fleetBattleLossRate: lossRate } },
  );
  const fleets: [string, number][] = [
    ["A", 60], ["A", 40], ["B", 25], ["E", 50], ["E", 30], ["N", 70], ["P", 90],
  ];
  sim.fleets = fleets.map(([tag, strength]) => ({
    country: sim.tags.indexOf(tag), strength, zone: 0, target: 0,
  }));
  setWar(sim, "A", "E");
  setWar(sim, "B", "E");
  setWar(sim, "N", "E");
  return sim;
}

describe("fleet battle losses", () => {
  it("accumulates every participating fleet's strength decrease by faction", () => {
    const sim = fleetBattle();
    const before = sim.fleets.map((f) => f.strength);
    let previous = { axis: 0, allies: 0 };
    for (let round = 0; round < 2; round++) {
      expect(resolveFleetBattles(sim)).toHaveLength(1);
      for (const side of ["axis", "allies"] as const) {
        const decrease = sim.fleets.reduce((total, f, i) =>
          total + (sim.faction[f.country] === side ? before[i] - f.strength : 0), 0);
        expect(sim.losses[side].navy).toBeGreaterThan(previous[side]);
        expect(sim.losses[side].navy).toBeCloseTo(decrease, 8);
        expect(sim.losses[side].army).toBe(0);
      }
      previous = { axis: sim.losses.axis.navy, allies: sim.losses.allies.navy };
    }
    for (let i = 0; i < 5; i++) expect(sim.fleets[i].strength).toBeLessThan(before[i]);
    expect(sim.fleets[5].strength).toBe(70);
    expect(sim.fleets[6].strength).toBe(90);
  });

  it("counts only available strength when participating fleets are destroyed", () => {
    const sim = fleetBattle(100);
    expect(resolveFleetBattles(sim)).toHaveLength(1);
    expect(sim.fleets.slice(0, 5).map((f) => f.strength)).toEqual([0, 0, 0, 0, 0]);
    expect(sim.losses).toEqual({ axis: { army: 0, navy: 80 }, allies: { army: 0, navy: 125 } });
    expect(resolveFleetBattles(sim)).toEqual([]);
    expect(sim.losses).toEqual({ axis: { army: 0, navy: 80 }, allies: { army: 0, navy: 125 } });
  });

  it("records no losses when no fleet battle occurs", () => {
    const sim = fleetBattle();
    sim.atWar.fill(0);
    const before = sim.fleets.map((f) => f.strength);
    expect(resolveFleetBattles(sim)).toEqual([]);
    expect(sim.fleets.map((f) => f.strength)).toEqual(before);
    expect(sim.losses).toEqual({ axis: { army: 0, navy: 0 }, allies: { army: 0, navy: 0 } });
  });
});
