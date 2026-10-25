import { describe, expect, it } from "vitest";
import { allocateArmies, applyBattles, computeFronts, resolveCombat, setOwner } from "../combat";
import type { SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

// Every fixture disables all unrelated tag-based defaults and transit delays.
const rules = {
  // Keep weighting assertions independent of the small-front holding reserve.
  holdShare: 0,
  lowPriorityFronts: {},
  slowAdvanceLand: {},
  capitulateOnCapitalLoss: [],
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  lossFactors: {},
  transitSpeedKmPerWeek: 1e9,
} satisfies Partial<SimConfig>;

function indirectFixture(config: Partial<SimConfig> = {}) {
  // Non-front state 4 connects A to B without joining lines 0 and 2.
  // X and Y each fight on only one line, with identical armies and front lengths.
  const sim = createSimulation(
    makeMap({
      owners: ["A", "X", "B", "Y", "A"],
      land: [[0, 1], [2, 3], [4, 0], [4, 2]],
    }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    { seed: 11, config: { ...rules, frontComparisonMode: "allocated", ...config } },
  );
  sim.military.fill(40);
  sim.military[sim.tags.indexOf("A")] = 100;
  for (const ally of ["A", "B"]) {
    for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
  }
  return sim;
}

const distance = 3000;
const longitude = (distance / 6371) * (180 / Math.PI);

function overseasFixture(config: Partial<SimConfig> = {}, allyOnHomeLand = false) {
  // Capital 0 is not a front state. Home line 1 has A's states 1 and 6;
  // remote line 3 has A's state 3 and B's state 5, both at -longitude.
  // Both sides' front lengths are two edges on each line. Sea routes connect
  // the remote states for support; only the optional own-side land border
  // makes a remote front state reachable from A's capital without crossing another side.
  const land: [number, number][] = [[0, 1], [0, 6], [1, 2], [6, 2], [3, 4]];
  if (allyOnHomeLand) land.push([0, 5]);
  const sim = createSimulation(
    makeMap({
      owners: ["A", "A", "X", "A", "Y", "B", "A"],
      land,
      sea: [[0, 3], [0, 5], [5, 4]],
      lonlat: [
        [0, 0], [longitude, 0], [longitude, 0], [-longitude, 0],
        [-longitude, 0], [-longitude, 0], [longitude, 0],
      ],
    }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    {
      seed: 13,
      config: {
        ...rules, frontComparisonMode: "allocated", allocationDistanceKm: distance, ...config,
      },
    },
  );
  sim.military.fill(40);
  sim.military[sim.tags.indexOf("A")] = 120;
  for (const ally of ["A", "B"]) {
    for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
  }
  return sim;
}

describe("land masses", () => {
  it("joins transitive land borders but never joins components through sea routes", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "A", "A", "A", "A"],
        land: [[2, 1], [1, 0], [4, 3]],
        sea: [[2, 3], [4, 5]],
      }),
      makeScenario({ A: {} }),
      { seed: 7, config: { ...rules } },
    );
    expect(Array.from(sim.landMass)).toEqual([0, 0, 0, 3, 3, 5]);
  });
});

describe("indirect front priority", () => {
  it.each([0.5, 1])("weights a support-only line by factor %s", (factor) => {
    const sim = indirectFixture({ indirectFrontPriority: factor });
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    expect(fronts.line[4]).toBe(-1);
    expect(fronts.lineFront.get(0)!.has(a)).toBe(true);
    expect(fronts.lineFront.get(2)!.has(a)).toBe(false);
    expect(fronts.lineCountries.get(2)!.has(a)).toBe(true);
    expect(Array.from(sim.stateLonLat).every(Number.isNaN)).toBe(true);
    const allocation = allocateArmies(sim, fronts);
    const own = allocation.get(0)!.get(a)!;
    const support = allocation.get(2)!.get(a)!;
    expect(support / own).toBeCloseTo(factor, 8);
    expect(own).toBeCloseTo(100 / (1 + factor), 8);
    expect(support).toBeCloseTo(100 * factor / (1 + factor), 8);
    expect(own + support).toBeCloseTo(sim.military[a], 8);
  });

  it("removes the indirect factor once A holds an occupied front state on the second line", () => {
    const sim = indirectFixture({ indirectFrontPriority: 0.5 });
    const a = sim.tags.indexOf("A");
    const before = allocateArmies(sim, computeFronts(sim));
    expect(before.get(2)!.get(a)! / before.get(0)!.get(a)!).toBeCloseTo(0.5, 8);
    expect(sim.origOwner[2]).toBe(sim.tags.indexOf("B"));
    setOwner(sim, 2, a);
    const fronts = computeFronts(sim);
    expect(fronts.lineFront.get(2)!.has(a)).toBe(true);
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(50, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(50, 8);
  });

  it("multiplies indirect priority by a listed ally's low priority", () => {
    const sim = indirectFixture({ indirectFrontPriority: 0.5, lowPriorityFronts: { B: 0.25 } });
    const a = sim.tags.indexOf("A");
    const allocation = allocateArmies(sim, computeFronts(sim));
    const own = allocation.get(0)!.get(a)!;
    const support = allocation.get(2)!.get(a)!;
    const weight = 0.5 * 0.25;
    expect(support / own).toBeCloseTo(weight, 8);
    expect(own).toBeCloseTo(100 / (1 + weight), 8);
    expect(support).toBeCloseTo(100 * weight / (1 + weight), 8);
  });
});

describe("overseas distance decay", () => {
  it.each([2, 1])("multiplies only the overseas distance by factor %s", (factor) => {
    const sim = overseasFixture({ overseasDistanceFactor: factor });
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([1, 3]);
    expect(fronts.line[0]).toBe(-1);
    const capitalMass = sim.landMass[sim.capital[a]];
    expect(sim.landMass[1]).toBe(capitalMass);
    expect(sim.landMass[3]).not.toBe(capitalMass);
    expect(sim.landMass[5]).not.toBe(capitalMass);
    // The equatorial arc from the capital to either side's centre is exactly d.
    const home = fronts.lineSide.get(1)!.get(fronts.sideArr[a])!;
    const remote = fronts.lineSide.get(3)!.get(fronts.sideArr[a])!;
    expect(home.edges).toBe(2);
    expect(remote.edges).toBe(2);
    expect(home.lon / home.n).toBeCloseTo(longitude, 8);
    expect(remote.lon / remote.n).toBeCloseTo(-longitude, 8);
    expect(home.lat).toBeCloseTo(0, 8);
    expect(remote.lat).toBeCloseTo(0, 8);
    const ratio = (1 + distance / sim.config.allocationDistanceKm) /
      (1 + factor * distance / sim.config.allocationDistanceKm);
    const allocation = allocateArmies(sim, fronts);
    const domesticArmy = allocation.get(1)!.get(a)!;
    const overseasArmy = allocation.get(3)!.get(a)!;
    expect(overseasArmy / domesticArmy).toBeCloseTo(ratio, 8);
    expect(domesticArmy).toBeCloseTo(120 / (1 + ratio), 8);
    expect(overseasArmy).toBeCloseTo(120 * ratio / (1 + ratio), 8);
    expect(domesticArmy + overseasArmy).toBeCloseTo(sim.military[a], 8);
  });

  it("counts ANY front state reachable by own-side land, including an ally's", () => {
    const sim = overseasFixture({ overseasDistanceFactor: 2 }, true);
    const baseline = overseasFixture({}, true);
    const a = sim.tags.indexOf("A"), b = sim.tags.indexOf("B");
    const fronts = computeFronts(sim);
    const capitalMass = sim.landMass[sim.capital[a]];
    expect(sim.landMass[3]).not.toBe(capitalMass);
    expect(sim.landMass[5]).toBe(capitalMass);
    expect(sim.owner[5]).toBe(b);
    expect(fronts.line[3]).toBe(fronts.line[5]);
    expect(fronts.lineFront.get(3)!.has(b)).toBe(true);
    const allocation = allocateArmies(sim, fronts);
    const normal = allocateArmies(baseline, computeFronts(baseline));
    for (const line of [1, 3]) {
      expect(allocation.get(line)!.get(a)).toBeCloseTo(60, 8);
      expect(allocation.get(line)!.get(a)).toBeCloseTo(normal.get(line)!.get(a)!, 8);
    }
  });
});

function fight(attacks: boolean, lossFactors: SimConfig["lossFactors"] = {}, secondEnemy = false) {
  const land: [number, number][] = [[0, 1], [2, 1]];
  if (secondEnemy) land.push([0, 3]);
  const sim = createSimulation(
    makeMap({ owners: ["A", "E", "B", "F", "N"], land }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" },
      E: { faction: "axis" }, F: { faction: "axis" }, N: { faction: "axis" },
    }),
    {
      seed: 17,
      config: { ...rules, frontComparisonMode: "allocated", advanceRate: 0, lossRate: 0.1, lossFactors },
    },
  );
  for (const [tag, army] of Object.entries({ A: 60, B: 40, E: attacks ? 50 : 200, F: attacks ? 25 : 100, N: 10 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
  }
  for (const ally of ["A", "B"]) {
    setWar(sim, ally, "E");
    if (secondEnemy) setWar(sim, ally, "F");
  }
  const before = sim.military.slice();
  const owners = sim.owner.slice();
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  const battle = battles[0];
  const a = sim.tags.indexOf("A");
  expect((attacks ? battle.attackers : battle.defenders).includes(a)).toBe(true);
  expect(battle.captures).toEqual([]);
  applyBattles(sim, battles);
  expect(sim.owner).toEqual(owners);
  const losses = Object.fromEntries(sim.tags.map((tag, c) => [tag, before[c] - sim.military[c]]));
  return { sim, battle, losses };
}

describe("matchup loss factors", () => {
  it.each([false, true])("triples only A's share against E (A attacks = %s)", (attacks) => {
    const baseline = fight(attacks);
    const factored = fight(attacks, { A: { E: 3 } });
    // A and B share the one line 60:40; attackers lose 2L, defenders L.
    const loss = 0.1 * Math.min(100, attacks ? 50 : 200);
    expect(baseline.battle.loss).toBeCloseTo(loss, 8);
    expect(baseline.losses.A).toBeCloseTo((attacks ? 2 : 1) * loss * 0.6, 8);
    expect(baseline.losses.B).toBeCloseTo((attacks ? 2 : 1) * loss * 0.4, 8);
    expect(baseline.losses.E).toBeCloseTo((attacks ? 1 : 2) * loss, 8);
    expect(factored.battle).toEqual(baseline.battle);
    expect(factored.losses.A).toBeCloseTo(3 * baseline.losses.A, 8);
    for (const tag of ["B", "E", "F", "N"]) {
      expect(factored.losses[tag]).toBeCloseTo(baseline.losses[tag], 8);
    }
  });

  it.each([false, true])("ignores a factor against an existing country outside the battle (A attacks = %s)", (attacks) => {
    const baseline = fight(attacks);
    const factored = fight(attacks, { A: { N: 99 } });
    const n = factored.sim.tags.indexOf("N");
    expect(factored.battle.attackers).not.toContain(n);
    expect(factored.battle.defenders).not.toContain(n);
    for (const tag of factored.sim.tags) {
      expect(factored.losses[tag]).toBeCloseTo(baseline.losses[tag], 8);
    }
  });

  it.each([
    { attacks: false, e: 3, f: 5 },
    { attacks: true, e: 3, f: 5 },
    { attacks: false, e: 5, f: 3 },
    { attacks: true, e: 5, f: 3 },
  ])("uses the largest applicable factor (A attacks = $attacks, E = $e, F = $f)", ({ attacks, e, f }) => {
    const baseline = fight(attacks, {}, true);
    const factored = fight(attacks, { A: { E: e, F: f, N: 99 } }, true);
    const enemies = attacks ? factored.battle.defenders : factored.battle.attackers;
    expect(enemies).toEqual(["E", "F"].map((tag) => factored.sim.tags.indexOf(tag)));
    expect(factored.losses.A).toBeCloseTo(Math.max(e, f) * baseline.losses.A, 8);
    for (const tag of ["B", "E", "F", "N"]) {
      expect(factored.losses[tag]).toBeCloseTo(baseline.losses[tag], 8);
    }
  });

  it.each([false, true])("floors military at zero for overwhelming losses (A attacks = %s)", (attacks) => {
    const baseline = fight(attacks);
    const factored = fight(attacks, { A: { E: 1000 } });
    const a = factored.sim.tags.indexOf("A");
    expect(1000 * baseline.losses.A).toBeGreaterThan(60);
    expect(factored.sim.military[a]).toBeCloseTo(0, 8);
    expect(factored.losses.A).toBeCloseTo(60, 8);
    expect(Array.from(factored.sim.military).every((army) => army >= 0)).toBe(true);
    expect(factored.losses.B).toBeCloseTo(baseline.losses.B, 8);
    expect(factored.losses.E).toBeCloseTo(baseline.losses.E, 8);
  });
});

describe("other comparison modes", () => {
  it.each(["nation", "divided"] as const)("%s ignores indirectFrontPriority", (mode) => {
    const sim = indirectFixture({ frontComparisonMode: mode, indirectFrontPriority: 0.5 });
    const baseline = indirectFixture({ frontComparisonMode: mode });
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    const normal = allocateArmies(baseline, computeFronts(baseline));
    for (const [line, countries] of fronts.lineCountries) {
      for (const c of countries) {
        const expected = mode === "nation" ? sim.military[c] : sim.military[c] / Math.max(1, fronts.frontCount[c]);
        expect(allocation.get(line)!.get(c)).toBeCloseTo(expected, 8);
        expect(allocation.get(line)!.get(c)).toBeCloseTo(normal.get(line)!.get(c)!, 8);
      }
    }
  });

  it.each(["nation", "divided"] as const)("%s ignores overseasDistanceFactor", (mode) => {
    const sim = overseasFixture({ frontComparisonMode: mode, overseasDistanceFactor: 2 });
    const baseline = overseasFixture({ frontComparisonMode: mode });
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    const normal = allocateArmies(baseline, computeFronts(baseline));
    for (const [line, countries] of fronts.lineCountries) {
      for (const c of countries) {
        const expected = mode === "nation" ? sim.military[c] : sim.military[c] / Math.max(1, fronts.frontCount[c]);
        expect(allocation.get(line)!.get(c)).toBeCloseTo(expected, 8);
        expect(allocation.get(line)!.get(c)).toBeCloseTo(normal.get(line)!.get(c)!, 8);
      }
    }
  });
});
