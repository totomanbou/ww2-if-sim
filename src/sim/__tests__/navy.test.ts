import { describe, expect, it } from "vitest";
import { checkCapitulations } from "../capitulation";
import { applyBattles, computeFronts, resolveCombat, setOwner } from "../combat";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { applyNavyGrowth, moveFleets, navyTotals, resolveFleetBattles } from "../navy";
import type { SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

function addFleet(sim: SimState, tag: string, strength: number, zone = 0) {
  const fleet = { country: sim.tags.indexOf(tag), zone, strength, target: zone };
  sim.fleets.push(fleet);
  return fleet;
}

function landingDuel(zone = 0) {
  const sim = createSimulation(
    makeMap({
      owners: ["A", "B", "C", "D"], land: [], sea: [[0, 1, zone]],
      zones: [{ neighbors: [1] }, { neighbors: [0] }],
    }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "axis" },
      C: { faction: "allies" }, D: { faction: "axis" },
    }),
    { config: { advanceRate: 2, advanceMax: 1 } },
  );
  sim.military.set([30, 10, 0, 0]);
  setWar(sim, "A", "B");
  return sim;
}

function expectBlocked(sim: SimState) {
  const owners = Array.from(sim.owner);
  const military = Array.from(sim.military);
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toEqual([]);
  applyBattles(sim, battles);
  expect(Array.from(sim.owner)).toEqual(owners);
  expect(Array.from(sim.military)).toEqual(military);
}

function expectLanding(sim: SimState) {
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  expect(battles[0].captures).toEqual([1]);
  applyBattles(sim, battles);
  expect(sim.owner[1]).toBe(sim.tags.indexOf("A"));
}

describe("initial navy", () => {
  it("splits 23 navy into five equal fleets at home", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1]] }),
      makeScenario({ A: { shipbuilding: 5.75, stability: 0.5 }, B: {} }),
      { config: { navyPerFleet: 5 } },
    );
    expect(sim.config.navyInitialYears).toBe(8);
    expect(navyTotals(sim)[0]).toBeCloseTo(23);
    expect(sim.fleets).toHaveLength(5);
    for (const fleet of sim.fleets) {
      expect(fleet).toEqual({ country: 0, zone: 0, strength: 4.6, target: 0 });
    }
  });

  it("caps the fleet count without losing naval power", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1]] }),
      makeScenario({ A: { shipbuilding: 10 }, B: {} }),
      { config: { navyPerFleet: 5, maxFleets: 3 } },
    );
    expect(sim.fleets).toHaveLength(3);
    for (const fleet of sim.fleets) expect(fleet.strength).toBeCloseTo(80 / 3);
    expect(navyTotals(sim)[0]).toBeCloseTo(80);
  });

  it("keeps one fleet for a positive navy below navyPerFleet", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1]] }),
      makeScenario({ A: { shipbuilding: 0.125 }, B: {} }),
    );
    expect(sim.fleets).toEqual([{ country: 0, zone: 0, strength: 1, target: 0 }]);
  });

  it("creates no fleets with zero shipbuilding or no home zone", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B", "C"], land: [], sea: [[0, 1]] }),
      makeScenario({ A: {}, B: {}, C: { shipbuilding: 10 } }),
    );
    expect(Array.from(sim.homeZone)).toEqual([0, 0, -1]);
    expect(sim.fleets).toEqual([]);
  });

  it("uses two initial years for USA and eight for other countries", () => {
    const sim = createSimulation(
      makeMap({ owners: ["USA", "JAP"], land: [], sea: [[0, 1]] }),
      makeScenario({ USA: { shipbuilding: 10, stability: 0.5 }, JAP: { shipbuilding: 10, stability: 0.5 } }),
    );
    expect(navyTotals(sim)[sim.tags.indexOf("USA")]).toBe(10);
    expect(navyTotals(sim)[sim.tags.indexOf("JAP")]).toBe(40);
  });
});

describe("navy growth", () => {
  it("shares unmasked weekly growth equally across fleets", () => {
    const map = makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1]] });
    const scenario = makeScenario({ A: { shipbuilding: 52, stability: 0.5 }, B: {} });
    const normal = createSimulation(map, scenario, { mask: { A: { 1939: 1 } } });
    const masked = createSimulation(map, scenario, { mask: { A: { 1939: 1000 } } });
    const before = normal.fleets.map((fleet) => fleet.strength);
    expect(navyTotals(masked)).toEqual(navyTotals(normal));

    step(normal);
    step(masked);

    for (const [i, fleet] of normal.fleets.entries()) {
      expect(fleet.strength - before[i]).toBeCloseTo(52 * 0.5 / 52 / before.length);
    }
    expect(navyTotals(normal)[0]).toBeCloseTo(208 + 0.5);
    expect(navyTotals(masked)).toEqual(navyTotals(normal));
    expect(masked.military[0]).toBeGreaterThan(normal.military[0]);
  });

  it("starts production on the first war week when preWarGrowth is zero", () => {
    const sim = createSimulation(
      makeMap({ owners: ["USA", "JAP"], land: [], sea: [[0, 1]] }),
      makeScenario(
        { USA: { industry: 0, shipbuilding: 52 }, JAP: { industry: 0 } },
        [{ date: "1939-09-15", a: ["JAP"], b: ["USA"] }],
      ),
      { config: { preWarGrowth: { USA: 0 }, fleetBattleChance: 0 } },
    );
    const usa = sim.tags.indexOf("USA");
    step(sim);
    step(sim);
    expect(sim.entered[usa]).toBe(0);
    expect(navyTotals(sim)[usa]).toBeCloseTo(104);
    step(sim);
    expect(sim.entered[usa]).toBe(1);
    expect(navyTotals(sim)[usa]).toBeCloseTo(105);
    sim.atWar.fill(0);
    step(sim);
    expect(navyTotals(sim)[usa]).toBeCloseTo(106);
  });

  it("adds yearly production only in the September 1 week after tick zero", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1]] }),
      makeScenario({ A: { shipbuilding: 12, stability: 0.5 }, B: {} }),
      { config: { growthMode: "yearly" } },
    );
    for (let tick = 0; tick < 52; tick++) step(sim);
    expect(navyTotals(sim)[0]).toBeCloseTo(48);
    step(sim);
    expect(navyTotals(sim)[0]).toBeCloseTo(54);
    step(sim);
    expect(navyTotals(sim)[0]).toBeCloseTo(54);
  });

  it("does not reduce ship production when territory is occupied", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "A", "B"], land: [], sea: [[0, 2]] }),
      makeScenario({ A: { shipbuilding: 52 }, B: {} }),
    );
    setOwner(sim, 1, sim.tags.indexOf("B"));
    const before = navyTotals(sim)[0];
    applyNavyGrowth(sim, false);
    expect(navyTotals(sim)[0] - before).toBeCloseTo(1);
  });
});

describe("naval superiority for landings", () => {
  it("allows a landing at exactly 70 versus 100", () => {
    const sim = landingDuel();
    addFleet(sim, "A", 70);
    addFleet(sim, "B", 100);
    expect(sim.config.navalSuperiority).toBe(0.7);
    expectLanding(sim);
  });

  it("blocks 69 versus 100 without captures or army losses", () => {
    const sim = landingDuel();
    addFleet(sim, "A", 69);
    addFleet(sim, "B", 100);
    expectBlocked(sim);
  });

  it.each([0, 100])("blocks zero attacking power against %i defending power", (strength) => {
    const sim = landingDuel();
    addFleet(sim, "A", 0);
    addFleet(sim, "B", strength);
    expectBlocked(sim);
  });

  it("counts a faction mate only when it is at war with the defender", () => {
    const sim = landingDuel();
    addFleet(sim, "C", 70);
    addFleet(sim, "B", 100);
    expectBlocked(sim);
    setWar(sim, "C", "B");
    expectLanding(sim);
  });

  it("counts defending faction mates at war with the attacker", () => {
    const sim = landingDuel();
    addFleet(sim, "A", 70);
    addFleet(sim, "B", 100);
    addFleet(sim, "D", 100);
    setWar(sim, "D", "A");
    expectBlocked(sim);
  });

  it("ignores fleets in another zone", () => {
    const sim = landingDuel();
    addFleet(sim, "A", 1000, 1);
    expectBlocked(sim);
  });

  it.each(["negative", "missing"])("blocks a route with a %s zone", (kind) => {
    const map = makeMap({ owners: ["A", "B"], land: [], sea: [[0, 1, -1]] });
    if (kind === "missing") delete map.seaRoutes[0].zone;
    const sim = createSimulation(map, makeScenario({ A: {}, B: {} }));
    sim.military.set([1000, 10]);
    setWar(sim, "A", "B");
    addFleet(sim, "A", 1000);
    expectBlocked(sim);
  });
});

describe("landing restrictions", () => {
  function restrictedDuel(land = false, core = true) {
    const scenario = makeScenario({ A: { faction: "allies" }, B: { faction: "axis" } });
    scenario.landingRestrictions = [{ defender: "B", coreOnly: true, blockedWhileHeldBy: "axis", region: [2] }];
    const sim = createSimulation(
      makeMap({ owners: ["A", "B", "B"], land: land ? [[0, 1]] : [], sea: [[0, 1]], core: [true, core, false] }),
      scenario,
      { config: { advanceRate: 2, advanceMax: 1 } },
    );
    sim.military.set([30, 10]);
    setWar(sim, "A", "B");
    addFleet(sim, "A", 70);
    return sim;
  }

  it("blocks core landings until the region changes from an axis to an allied owner", () => {
    const sim = restrictedDuel();
    expectBlocked(sim);
    setOwner(sim, 2, sim.tags.indexOf("A"));
    expectLanding(sim);
  });

  it("allows land attacks on a protected core even without a navy", () => {
    const sim = restrictedDuel(true);
    sim.fleets = [];
    expectLanding(sim);
  });

  it("does not protect non-core targets with a core-only restriction", () => {
    expectLanding(restrictedDuel(false, false));
  });
});

describe("fleet battles", () => {
  function fleetDuel(chance = 1, rate = 0.15) {
    const sim = landingDuel();
    sim.config.fleetBattleChance = chance;
    sim.config.fleetBattleLossRate = rate;
    addFleet(sim, "A", 100);
    addFleet(sim, "B", 80);
    return sim;
  }

  it("damages both sides within bounds based on their pre-battle strength", () => {
    const sim = fleetDuel();
    const before = sim.fleets.map((fleet) => fleet.strength);
    const battles = resolveFleetBattles(sim);
    expect(battles).toHaveLength(1);
    for (const [i, fleet] of sim.fleets.entries()) {
      const loss = before[i] - fleet.strength;
      const rate = sim.config.fleetBattleLossRate;
      expect(loss).toBeGreaterThan(0);
      expect(loss).toBeGreaterThanOrEqual(rate * before[1 - i] * 0.6);
      expect(loss).toBeLessThanOrEqual(Math.min(before[i], rate * before[1 - i] * 1.4));
    }
  });

  it("caps losses at each side's own strength", () => {
    const sim = fleetDuel(1, 10);
    expect(resolveFleetBattles(sim)).toHaveLength(1);
    expect(sim.fleets.map((fleet) => fleet.strength)).toEqual([0, 0]);
  });

  it("does not fight when fleetBattleChance is zero", () => {
    const sim = fleetDuel(0);
    expect(resolveFleetBattles(sim)).toEqual([]);
    expect(sim.fleets.map((fleet) => fleet.strength)).toEqual([100, 80]);
  });

  it("does not fight between countries that are not at war", () => {
    const sim = fleetDuel();
    sim.atWar.fill(0);
    expect(resolveFleetBattles(sim)).toEqual([]);
    expect(sim.fleets.map((fleet) => fleet.strength)).toEqual([100, 80]);
  });

  it("does not fight between fleets in different zones", () => {
    const sim = fleetDuel();
    sim.fleets[1].zone = 1;
    expect(resolveFleetBattles(sim)).toEqual([]);
    expect(sim.fleets.map((fleet) => fleet.strength)).toEqual([100, 80]);
  });
});

describe("fleet movement", () => {
  function deployment() {
    return createSimulation(
      makeMap({
        owners: ["A", "A", "B"], land: [], sea: [[0, 1, 0], [1, 2, 2]],
        zones: [{ neighbors: [1] }, { neighbors: [0, 2] }, { neighbors: [1] }],
      }),
      makeScenario({ A: { industry: 0, shipbuilding: 1 }, B: { industry: 0 } }),
      { config: { growthMode: "yearly", maxFleets: 1, fleetBattleChance: 0 } },
    );
  }

  it("moves one hop per step and reaches its only front after two steps", () => {
    const sim = deployment();
    setWar(sim, "A", "B");
    expect(sim.homeZone[0]).toBe(0);
    expect(sim.fleets[0].zone).toBe(0);
    step(sim);
    expect(sim.fleets[0]).toMatchObject({ zone: 1, target: 2 });
    step(sim);
    expect(sim.fleets[0]).toMatchObject({ zone: 2, target: 2 });
  });

  it("returns a peaceful fleet home one hop at a time and keeps it there", () => {
    const sim = deployment();
    sim.fleets[0].zone = 2;
    sim.fleets[0].target = 2;
    moveFleets(sim);
    expect(sim.fleets[0]).toMatchObject({ zone: 1, target: 0 });
    moveFleets(sim);
    expect(sim.fleets[0]).toMatchObject({ zone: 0, target: 0 });
    moveFleets(sim);
    expect(sim.fleets[0]).toMatchObject({ zone: 0, target: 0 });
  });
});

describe("navy capitulation", () => {
  it("removes all of a capitulating country's fleets and preserves other fleets", () => {
    const sim = landingDuel();
    addFleet(sim, "A", 10);
    addFleet(sim, "A", 20, 1);
    const survivor = addFleet(sim, "B", 30);
    setOwner(sim, 0, sim.tags.indexOf("B"));
    expect(checkCapitulations(sim)).toEqual([[sim.tags.indexOf("A"), sim.tags.indexOf("B")]]);
    expect(sim.capitulated[sim.tags.indexOf("A")]).toBe(1);
    expect(sim.fleets).toEqual([survivor]);
    expect(navyTotals(sim)[sim.tags.indexOf("A")]).toBe(0);
  });
});
