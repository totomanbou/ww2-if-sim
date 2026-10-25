import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, setOwner } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

function fixture(closedLand = ["L"], mixed = false, config: Partial<SimConfig> = {}) {
  // Two separate, equally long lines: U-X at 0 and L/U-Y at 2. Non-front A state 6 links the allies.
  // State 2 has two enemy edges and state 4 only one: openShare must count states, not edges.
  const sim = createSimulation(
    makeMap({ owners: ["U", "X", "L", "Y", mixed ? "U" : "L", "X", "A", "U", "Y"],
      land: [[0, 1], [7, 1], [0, 5], [2, 3], [2, 8], [4, 3], [2, 4], [6, 0], [6, 2]] }),
    makeScenario({ A: { faction: "allies" }, U: { faction: "allies" }, L: { faction: "allies" },
      X: { faction: "axis" }, Y: { faction: "axis" } }),
    { config: {
      closedLand, frontComparisonMode: "allocated", holdShare: 0, lowPriorityFronts: {}, enemyPriority: {},
      regionPriority: {}, indirectFrontPriority: 1, overseasDistanceFactor: 1, ...config,
    } },
  );
  for (const ally of ["A", "U", "L"]) for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
  sim.military.fill(40);
  sim.military[sim.tags.indexOf("A")] = 120;
  return sim;
}

describe("closed land allocation", () => {
  it("gives an ally zero on a line entirely on closed land and sends its army to the open line", () => {
    const sim = fixture(), a = sim.tags.indexOf("A"), fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    expect(fronts.lineCountries.get(2)!.has(a)).toBe(true); // It can reach the line, so geography is the restriction.
    expect([...fronts.frontStates].filter((s) => fronts.line[s] === 2 && fronts.sideArr[sim.owner[s]] === -2))
      .toEqual([2, 4]);
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.get(2)?.get(a) ?? 0).toBe(0);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(120, 8);
  });

  it("leaves the closed country itself and enemies unchanged", () => {
    const sim = fixture(), baseline = fixture([]);
    const allocation = allocateArmies(sim, computeFronts(sim));
    const normal = allocateArmies(baseline, computeFronts(baseline));
    for (const tag of ["L", "X", "Y"]) {
      const c = sim.tags.indexOf(tag);
      for (const line of [0, 2]) expect(allocation.get(line)?.get(c) ?? 0).toBeCloseTo(normal.get(line)?.get(c) ?? 0, 8);
    }
    expect(allocation.get(2)!.get(sim.tags.indexOf("L"))).toBeCloseTo(20, 8);
    expect(allocation.get(2)!.get(sim.tags.indexOf("Y"))).toBeCloseTo(40, 8);
  });

  it("halves the weight of a mixed line by front-state share, independently of edge counts", () => {
    const sim = fixture(["L"], true), a = sim.tags.indexOf("A"), fronts = computeFronts(sim);
    expect(fronts.lineFront.get(2)!.get(sim.tags.indexOf("L"))!.edges).toBe(2);
    expect(fronts.lineFront.get(2)!.get(sim.tags.indexOf("U"))!.edges).toBe(1);
    for (const line of [0, 2]) expect(fronts.lineSide.get(line)!.get(-2)!.edges).toBe(3);
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.get(2)!.get(a)! / allocation.get(0)!.get(a)!).toBeCloseTo(0.5, 8);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(80, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(40, 8);
  });

  it("counts a state held by the allocating country as open even on closed land", () => {
    const sim = fixture(), a = sim.tags.indexOf("A");
    setOwner(sim, 4, a);
    expect(sim.landOf[4]).toBe(sim.tags.indexOf("L"));
    const allocation = allocateArmies(sim, computeFronts(sim));
    expect(allocation.get(0)!.get(a)).toBeCloseTo(80, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(40, 8);
  });

  it("uses landOf even when closed land was already occupied before the simulation", () => {
    const sim = fixture(["L"], true), a = sim.tags.indexOf("A");
    // Simulate a map state's formerOwner: the current and original owner remain U, but its land is L.
    sim.landOf[4] = sim.tags.indexOf("L");
    expect(sim.origOwner[4]).toBe(sim.tags.indexOf("U"));
    const allocation = allocateArmies(sim, computeFronts(sim));
    expect(allocation.get(2)?.get(a) ?? 0).toBe(0);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(120, 8);
  });

  it("closedLand [] restores an equal split on the two equal lines", () => {
    const sim = fixture([]), a = sim.tags.indexOf("A"), allocation = allocateArmies(sim, computeFronts(sim));
    expect(allocation.get(0)!.get(a)).toBeCloseTo(60, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(60, 8);
  });

  it("does not allocate to any closed line even when that leaves the ally with no eligible lines", () => {
    const sim = fixture(["L", "U"]), a = sim.tags.indexOf("A");
    const allocation = allocateArmies(sim, computeFronts(sim));
    expect(allocation.get(0)?.get(a) ?? 0).toBe(0);
    expect(allocation.get(2)?.get(a) ?? 0).toBe(0);
  });

  it("also scales the holding reserve on a partially closed line", () => {
    function allocate(closedLand: string[]) {
      const sim = fixture(closedLand, false, { holdRatio: 0.5, holdShare: 1 });
      const a = sim.tags.indexOf("A");
      setOwner(sim, 0, a); setOwner(sim, 7, a); setOwner(sim, 4, a);
      sim.military[sim.tags.indexOf("L")] = 0;
      sim.military[sim.tags.indexOf("U")] = 0;
      return { sim, a, allocation: allocateArmies(sim, computeFronts(sim)) };
    }
    const closed = allocate(["L"]), open = allocate([]);
    // Enemy first-pass armies are 40 per line and A is the only ally with troops.
    // Closed: holds 20 on the open line, 10 on the half-open line, then splits 90 in the ratio 2:1.
    expect(closed.allocation.get(0)!.get(closed.a)).toBeCloseTo(80, 8);
    expect(closed.allocation.get(2)!.get(closed.a)).toBeCloseTo(40, 8);
    expect(open.allocation.get(0)!.get(open.a)).toBeCloseTo(60, 8);
    expect(open.allocation.get(2)!.get(open.a)).toBeCloseTo(60, 8);
  });

  it.each(["nation", "divided"] as const)("keeps legacy %s mode unaffected", (frontComparisonMode) => {
    const sim = fixture(["L"], false, { frontComparisonMode });
    const normal = fixture([], false, { frontComparisonMode });
    expect(allocateArmies(sim, computeFronts(sim))).toEqual(allocateArmies(normal, computeFronts(normal)));
  });

  it("defaults to Soviet and Chinese land", () => {
    expect(DEFAULT_CONFIG.closedLand).toEqual(["SOV", "CHN"]);
  });
});
