import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

// Isolate allocation weights from holding reserves and unrelated tag-based rules.
const rules = {
  encirclement: false,
  frontComparisonMode: "allocated",
  holdRatio: 1,
  holdShare: 0,
  lowPriorityFronts: {},
  regionPriority: {},
  slowAdvanceLand: {},
  capitulateOnCapitalLoss: [],
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  lossFactors: {},
  transitSpeedKmPerWeek: 1e9,
} satisfies Partial<SimConfig>;

const distance = 3000;
const longitude = (distance / 6371) * (180 / Math.PI);

function separateLines(enemyPriority: SimConfig["enemyPriority"] = {}) {
  const sim = createSimulation(
    makeMap({
      owners: ["X", "E1", "X", "E2", "X"],
      // Non-front capital 4 connects X's states without merging lines 0 and 2.
      land: [[0, 1], [2, 3], [4, 0], [4, 2]],
      capitals: { X: 4 },
      lonlat: [[longitude, 0], [longitude, 0], [-longitude, 0], [-longitude, 0], [0, 0]],
    }),
    makeScenario({
      X: { faction: "axis" }, E1: { faction: "allies" }, E2: { faction: "allies" },
    }),
    { seed: 17, config: { ...rules, allocationDistanceKm: distance, enemyPriority } },
  );
  sim.military.fill(40);
  sim.military[sim.tags.indexOf("X")] = 120;
  setWar(sim, "X", "E1");
  setWar(sim, "X", "E2");
  return sim;
}

function sharedLine(enemyPriority: SimConfig["enemyPriority"], e1Edges: number) {
  const sim = createSimulation(
    makeMap({
      // Each mixed-line enemy has one front state, but state 2 has two front edges.
      owners: ["X", e1Edges === 1 ? "E1" : "E2", e1Edges === 1 ? "E2" : "E1", "X",
        "X", "E3", "X", "X", "X"],
      land: [[0, 1], [0, 2], [3, 2], [4, 5], [6, 5], [7, 5],
        [8, 0], [8, 3], [8, 4], [8, 6], [8, 7]],
      capitals: { X: 8 },
      lonlat: [[longitude, 0], [longitude, 0], [longitude, 0], [longitude, 0],
        [-longitude, 0], [-longitude, 0], [-longitude, 0], [-longitude, 0], [0, 0]],
    }),
    makeScenario({
      X: { faction: "axis" }, E1: { faction: "allies" },
      E2: { faction: "allies" }, E3: { faction: "allies" },
    }),
    { seed: 19, config: { ...rules, allocationDistanceKm: distance, enemyPriority } },
  );
  for (const [tag, army] of Object.entries({ X: 120, E1: 15, E2: 15, E3: 30 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
    if (tag !== "X") setWar(sim, "X", tag);
  }
  return sim;
}

describe("enemy priority defaults", () => {
  it("has no enemy priority by default (Germany's Soviet priority was removed)", () => {
    expect(DEFAULT_CONFIG.enemyPriority).toEqual({});
  });

  it("defaults holdRatio to 0.5", () => {
    expect(DEFAULT_CONFIG.holdRatio).toBe(0.5);
  });
});

describe("enemy priority allocation", () => {
  it("triples X's weight against E1 on otherwise equal separate lines", () => {
    const baseline = separateLines();
    const sim = separateLines({ X: { E1: 3 } });
    const x = sim.tags.indexOf("X");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    expect(fronts.line[4]).toBe(-1);
    for (const [line, enemy, centre] of [[0, "E1", longitude], [2, "E2", -longitude]] as const) {
      const e = sim.tags.indexOf(enemy);
      expect(fronts.lineCountries.get(line)).toEqual(new Set([x, e]));
      const side = fronts.lineSide.get(line)!.get(fronts.sideArr[x])!;
      expect(side.edges).toBe(1);
      expect(side.lon / side.n).toBeCloseTo(centre, 8);
      expect(side.lat / side.n).toBe(0);
      expect(fronts.lineFront.get(line)!.get(e)!.edges).toBe(1);
    }
    const allocation = allocateArmies(sim, fronts);
    const split = allocateArmies(baseline, computeFronts(baseline));
    // Base = 1 edge / (1 + d/d). Each enemy puts its entire 40 army on its only line.
    // Final weights = base * priority * enemy first-pass army; holdShare = 0.
    const base = 1 / (1 + distance / sim.config.allocationDistanceKm);
    const e1Weight = base * 3 * 40, e2Weight = base * 40;
    expect(split.get(0)!.get(x)).toBeCloseTo(60, 8);
    expect(split.get(2)!.get(x)).toBeCloseTo(60, 8);
    const e1Army = allocation.get(0)!.get(x)!, e2Army = allocation.get(2)!.get(x)!;
    expect(e1Army).toBeGreaterThan(split.get(0)!.get(x)!);
    expect(e1Army / e2Army).toBeCloseTo(3, 8);
    expect(e1Army).toBeCloseTo(120 * e1Weight / (e1Weight + e2Weight), 8);
    expect(e2Army).toBeCloseTo(120 * e2Weight / (e1Weight + e2Weight), 8);
    expect(e1Army + e2Army).toBeCloseTo(sim.military[x], 8);
  });

  it.each([1, 2])("weights a mixed line by E1's %s of 3 enemy edges", (e1Edges) => {
    const sim = sharedLine({ X: { E1: 3 } }, e1Edges);
    const baseline = sharedLine({}, e1Edges);
    const x = sim.tags.indexOf("X"), e1 = sim.tags.indexOf("E1"), e2 = sim.tags.indexOf("E2");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 4]);
    expect(fronts.line[8]).toBe(-1);
    const holders = fronts.lineFront.get(0)!;
    expect(holders.get(e1)!.edges).toBe(e1Edges);
    expect(holders.get(e2)!.edges).toBe(3 - e1Edges);
    expect(fronts.sideArr[e1]).toBe(fronts.sideArr[e2]);
    expect(fronts.sideArr[e1]).not.toBe(fronts.sideArr[x]);
    for (const e of [e1, e2]) {
      expect([...fronts.frontStates].filter((s) => fronts.line[s] === 0 && sim.owner[s] === e)).toHaveLength(1);
    }
    for (const line of [0, 4]) {
      expect(fronts.lineSide.get(line)!.get(fronts.sideArr[x])!.edges).toBe(3);
    }
    const enemyEdges = holders.get(e1)!.edges + holders.get(e2)!.edges;
    const factor = 1 + (3 - 1) * (e1Edges / enemyEdges);
    // Both lines have 3 edges at distance d and 30 enemy army in the first pass.
    // The mixed-line multiplier uses enemy edges, not enemy states or both sides' edges.
    const base = 3 / (1 + distance / sim.config.allocationDistanceKm);
    const mixedWeight = base * factor * 30, otherWeight = base * 30;
    const allocation = allocateArmies(sim, fronts);
    const split = allocateArmies(baseline, computeFronts(baseline));
    expect(split.get(0)!.get(x)).toBeCloseTo(60, 8);
    expect(split.get(4)!.get(x)).toBeCloseTo(60, 8);
    const mixedArmy = allocation.get(0)!.get(x)!, otherArmy = allocation.get(4)!.get(x)!;
    expect(mixedArmy / otherArmy).toBeCloseTo(factor, 8);
    expect(mixedArmy).toBeCloseTo(120 * mixedWeight / (mixedWeight + otherWeight), 8);
    expect(otherArmy).toBeCloseTo(120 * otherWeight / (mixedWeight + otherWeight), 8);
    expect(mixedArmy + otherArmy).toBeCloseTo(sim.military[x], 8);
  });

  const inertCases: { name: string; enemyPriority: SimConfig["enemyPriority"] }[] = [
    { name: "factor 1", enemyPriority: { X: { E1: 1, E2: 1 } } },
    { name: "an unknown enemy tag", enemyPriority: { X: { UNKNOWN: 3 } } },
    { name: "an unknown allocating country", enemyPriority: { UNKNOWN: { E1: 3 } } },
    { name: "another existing country's entry", enemyPriority: { E1: { X: 3 } } },
  ];

  it.each(inertCases)("leaves X's split unchanged with $name", ({ enemyPriority }) => {
    const baseline = separateLines();
    const sim = separateLines(enemyPriority);
    const x = sim.tags.indexOf("X");
    const allocation = allocateArmies(sim, computeFronts(sim));
    const split = allocateArmies(baseline, computeFronts(baseline));
    expect([...allocation.keys()]).toEqual([...split.keys()]);
    for (const line of [0, 2]) {
      expect(allocation.get(line)!.get(x)).toBeCloseTo(split.get(line)!.get(x)!, 8);
      expect(allocation.get(line)!.get(x)).toBeCloseTo(60, 8);
    }
  });
});
