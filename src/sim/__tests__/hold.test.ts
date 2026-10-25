import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, resolveCombat, setOwner } from "../combat";
import type { SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const rules = {
  encirclement: false,
  frontComparisonMode: "allocated",
  lowPriorityFronts: {},
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  holdRatio: 1,
  holdShare: 0.5,
  transitSpeedKmPerWeek: 1e9,
  slowAdvanceLand: {},
  lossFactors: {},
  lossRate: 0,
  advanceRate: 100,
  advanceMax: 1,
} satisfies Partial<SimConfig>;

function ownLines(enemies: number[], holdShare = 0.5) {
  const tags = enemies.map((_, i) => `X${i}`);
  const sim = createSimulation(
    makeMap({
      owners: tags.flatMap((tag) => ["A", tag]),
      land: tags.map((_, i): [number, number] => [2 * i, 2 * i + 1]),
    }),
    makeScenario({
      A: { faction: "allies" },
      ...Object.fromEntries(tags.map((tag) => [tag, { faction: "axis" as const }])),
    }),
    { seed: 17, config: { ...rules, holdShare } },
  );
  sim.military[sim.tags.indexOf("A")] = 60;
  tags.forEach((tag, i) => {
    sim.military[sim.tags.indexOf(tag)] = enemies[i];
    setWar(sim, "A", tag);
  });
  return sim;
}

describe("holding small own fronts", () => {
  it.each([0.5, 0])("adds the affordable need to the weighted rest with holdShare = %s", (holdShare) => {
    const sim = ownLines([10, 100], holdShare);
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    // Equal base weights give first-pass armies 30:30; final weights are 10:100.
    // Only the small need (10) fits the reserve of 30.
    const held = holdShare === 0 ? 0 : 10;
    expect(allocation.get(0)!.get(a)).toBeCloseTo(held + (60 - held) * 10 / 110, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo((60 - held) * 100 / 110, 8);
    expect(allocation.get(0)!.get(a)! + allocation.get(2)!.get(a)!).toBeCloseTo(60, 8);
  });

  it("sorts needs before reserving, accepts the exact cap, and skips the unaffordable need", () => {
    // Line order is deliberately different from need order: 20, 10, 25.
    const sim = ownLines([20, 10, 25]);
    const a = sim.tags.indexOf("A");
    const allocation = allocateArmies(sim, computeFronts(sim));
    const needs = [20, 10, 25];
    const holds = [20, 10, 0];
    needs.forEach((weight, i) => {
      expect(allocation.get(2 * i)!.get(a)).toBeCloseTo(holds[i] + 30 * weight / 55, 8);
    });
    expect([...allocation.values()].reduce((sum, line) => sum + line.get(a)!, 0)).toBeCloseTo(60, 8);
  });

  it("does not reserve a hold on a supporter-only line even when its need would fit", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "X", "B", "Y", "A"],
        land: [[0, 1], [2, 3], [0, 4], [4, 2]],
      }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { seed: 19, config: rules },
    );
    for (const [tag, army] of Object.entries({ A: 60, B: 0, X: 10, Y: 20 })) {
      sim.military[sim.tags.indexOf(tag)] = army;
    }
    for (const ally of ["A", "B"]) for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect(fronts.lineCountries.get(2)!.has(a)).toBe(true);
    expect(fronts.lineFront.get(2)!.has(a)).toBe(false);
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(10 + 50 / 3, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(50 * 2 / 3, 8);
  });

  it("splits a joint line's need by the countries' first-pass army shares", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "X", "B", "A", "Y", "B"],
        land: [[0, 1], [2, 1], [3, 4], [5, 4]],
      }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { seed: 23, config: rules },
    );
    for (const [tag, army] of Object.entries({ A: 60, B: 120, X: 30, Y: 300 })) {
      sim.military[sim.tags.indexOf(tag)] = army;
    }
    for (const ally of ["A", "B"]) for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    // Equal edges on both lines: first-pass shares are A = 30/90, B = 60/90.
    // Their small-line holds are 10 and 20, despite identical front lengths.
    for (const [tag, held, rest] of [["A", 10, 50], ["B", 20, 100]] as const) {
      const c = sim.tags.indexOf(tag);
      expect(allocation.get(0)!.get(c)).toBeCloseTo(held + rest / 11, 8);
      expect(allocation.get(3)!.get(c)).toBeCloseTo(rest * 10 / 11, 8);
      expect(allocation.get(0)!.get(c)! + allocation.get(3)!.get(c)!).toBeCloseTo(sim.military[c], 8);
    }
  });
});

const distance = 3000;
const longitude = (distance / 6371) * (180 / Math.PI);

function landReachability(bridge: "allies" | "neutral", capitalOwner: "A" | "B" | "X" = "A") {
  const sim = createSimulation(
    makeMap({
      owners: ["A", "A", "B", "A", "X", "Y"],
      // State 2 is not a front state; it connects the capital to the remote front.
      land: [[0, 1], [0, 2], [2, 3], [1, 4], [3, 5]],
      lonlat: [[0, 0], [longitude, 0], [0, 0], [2 * longitude, 0], [longitude, 0], [2 * longitude, 0]],
    }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: bridge },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    { seed: 29, config: { ...rules, holdShare: 0, allocationDistanceKm: distance, overseasDistanceFactor: 2 } },
  );
  sim.military.fill(0);
  for (const [tag, army] of Object.entries({ A: 120, X: 40, Y: 40 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
  }
  setWar(sim, "A", "X");
  setWar(sim, "A", "Y");
  setOwner(sim, 0, sim.tags.indexOf(capitalOwner));
  return sim;
}

describe("overseas via own-side land", () => {
  it.each([
    { bridge: "allies" as const, remoteWeight: 1 / 3 },
    { bridge: "neutral" as const, remoteWeight: 1 / 5 },
  ])("uses the same geometry with a $bridge bridge", ({ bridge, remoteWeight }) => {
    const sim = landReachability(bridge);
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([1, 3]);
    expect(fronts.line[2]).toBe(-1);
    // Raw landMass cannot distinguish these fixtures: both fronts are on the capital's mass.
    expect(sim.landMass[3]).toBe(sim.landMass[0]);
    expect(sim.landMass[1]).toBe(sim.landMass[0]);
    const allocation = allocateArmies(sim, fronts);
    const homeWeight = 1 / 2;
    expect(allocation.get(1)!.get(a)).toBeCloseTo(120 * homeWeight / (homeWeight + remoteWeight), 8);
    expect(allocation.get(3)!.get(a)).toBeCloseTo(120 * remoteWeight / (homeWeight + remoteWeight), 8);
  });

  it("allows a capital held by an ally to supply own-side land paths", () => {
    const sim = landReachability("allies", "B");
    const a = sim.tags.indexOf("A");
    const allocation = allocateArmies(sim, computeFronts(sim));
    expect(allocation.get(1)!.get(a)).toBeCloseTo(72, 8);
    expect(allocation.get(3)!.get(a)).toBeCloseTo(48, 8);
  });

  it("treats every line as overseas when the capital is held by the enemy", () => {
    const sim = landReachability("allies", "X");
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    // The occupied capital adds a second home edge; front centres stay at d and 2d.
    expect(sim.owner[sim.capital[a]]).toBe(sim.tags.indexOf("X"));
    expect([...fronts.lineCountries.keys()]).toEqual([0, 3]);
    expect(fronts.lineSide.get(0)!.get(fronts.sideArr[a])!.edges).toBe(2);
    expect(fronts.lineSide.get(3)!.get(fronts.sideArr[a])!.edges).toBe(1);
    const allocation = allocateArmies(sim, fronts);
    const homeWeight = 2 / (1 + 2), remoteWeight = 1 / (1 + 4);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(120 * homeWeight / (homeWeight + remoteWeight), 8);
    expect(allocation.get(3)!.get(a)).toBeCloseTo(120 * remoteWeight / (homeWeight + remoteWeight), 8);
  });
});

interface PressureOptions {
  strong: number;
  weak: number;
  support?: number;
  fallback?: boolean;
}

function pressureFixture(seed: number, { strong, weak, support = 0, fallback = false }: PressureOptions) {
  const sim = createSimulation(
    makeMap({
      owners: ["S", "W", "X", "X", "W", "W", "X", "P", "P", "H"],
      land: [
        [0, 2], [1, 3], [4, 3], [5, 3], [0, 6], [1, 6], [0, 8], [8, 7],
        ...(fallback ? [[9, 6] as [number, number]] : []),
      ],
    }),
    // Protected state 6 joins all holders into one line but cannot be selected.
    makeScenario({
      S: { faction: "allies" }, W: { faction: "allies" },
      P: { faction: "allies" }, H: { faction: "allies" }, X: { faction: "axis" },
    }, [], [6]),
    { seed, config: { ...rules, holdShare: 0 } },
  );
  for (const [tag, army] of Object.entries({ S: strong, W: weak, P: support, H: fallback ? 10 : 0, X: 1 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
    if (tag !== "X") setWar(sim, tag, "X");
  }
  return sim;
}

function samplePressure(options: PressureOptions, runs = 1024) {
  let strong = 0, weak = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const sim = pressureFixture(seed, options);
    const fronts = computeFronts(sim);
    expect(fronts.line[2]).toBe(fronts.line[3]);
    expect(fronts.lineFront.get(0)!.get(sim.tags.indexOf("S"))!.edges).toBe(2);
    expect(fronts.lineFront.get(0)!.get(sim.tags.indexOf("W"))!.edges).toBe(4);
    expect(fronts.lineFront.get(0)!.has(sim.tags.indexOf("P"))).toBe(false);
    const battles = resolveCombat(sim, fronts);
    expect(battles).toHaveLength(1);
    const battle = battles[0];
    expect(battle.captures).toHaveLength(1);
    const target = battle.captures[0];
    expect([2, 3]).toContain(target);
    expect(battle.captors).toEqual([sim.tags.indexOf(target === 2 ? "S" : "W")]);
    if (target === 2) strong++;
    else weak++;
  }
  return { strong, weak, share: strong / runs };
}

describe("pressure-weighted targets and captors", () => {
  it.each([
    { name: "higher pressure-weighted adjacency", strong: 100, weak: 10, extraWeakEdge: true, captor: "S" },
    { name: "more adjacency when weighted pressure ties", strong: 40, weak: 10, extraWeakEdge: true, captor: "W" },
    { name: "stronger army when pressure and adjacency tie", strong: 40, weak: 10, extraWeakEdge: false, captor: "S" },
  ])("chooses the captor by $name", ({ strong, weak, extraWeakEdge, captor }) => {
    const land: [number, number][] = [[0, 5], [3, 5], [0, 6], [1, 6], [2, 6]];
    if (extraWeakEdge) land.push([4, 5]);
    const sim = createSimulation(
      makeMap({ owners: ["S", "S", "S", "W", "W", "X", "X"], land }),
      makeScenario({
        S: { faction: "allies" }, W: { faction: "allies" }, X: { faction: "axis" },
      }, [], [6]),
      { seed: 31, config: { ...rules, holdShare: 0 } },
    );
    const s = sim.tags.indexOf("S"), w = sim.tags.indexOf("W");
    sim.military[s] = strong;
    sim.military[w] = weak;
    sim.military[sim.tags.indexOf("X")] = 1;
    setWar(sim, "S", "X");
    setWar(sim, "W", "X");
    // S has four edges. W has two (or one), all adjacent to target 5.
    // At armies 40 and 10 both contribute 10 to that target: adjacency wins
    // with two W edges; equal adjacency instead awards it to S's larger army.
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0].captures).toEqual([5]);
    expect(battles[0].captors).toEqual([sim.tags.indexOf(captor)]);
  });

  it("concentrates captures beside the strong attacker with few edges", () => {
    // S pressure = 2000/2 = 1000, W pressure = 4/4 = 1.
    // Target weights are 1000 and 3, rather than adjacency weights 1 and 3.
    const counts = samplePressure({ strong: 2000, weak: 4 });
    expect(counts.share).toBeGreaterThan(0.98);
    expect(Math.abs(counts.share - 1000 / 1003)).toBeLessThan(0.02);
  });

  it("retains adjacency proportions when holders have equal pressure", () => {
    // Both pressures are 10; target weights are 10 and 30.
    const counts = samplePressure({ strong: 20, weak: 40 });
    expect(Math.abs(counts.share - 1 / 4)).toBeLessThan(0.05);
    expect(counts.strong + counts.weak).toBe(1024);
  });

  it("adds the same supporter pressure to every holder", () => {
    const unsupported = samplePressure({ strong: 20, weak: 0 });
    expect(unsupported.share).toBeCloseTo(1, 8);
    // P has no front states. Its 60 army / 6 holder edges adds 10 to both:
    // S pressure = 20, W pressure = 10; target weights = 20 and 30.
    const supported = samplePressure({ strong: 20, weak: 0, support: 60 });
    expect(Math.abs(supported.share - 20 / 50)).toBeLessThan(0.05);
    expect(supported.weak).toBeGreaterThan(0);
  });

  it("falls back to adjacency when every eligible adjacent holder has zero army", () => {
    // H's army makes the side attack, but H borders only protected state 6.
    // Both attackable targets have zero pressure, so their weights revert to 1:3.
    const counts = samplePressure({ strong: 0, weak: 0, fallback: true });
    expect(Math.abs(counts.share - 1 / 4)).toBeLessThan(0.05);
  });
});
