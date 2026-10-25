import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, deployArmies } from "../combat";
import type { SimConfig } from "../config";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const config = {
  // Transit tests use the plain weighted allocation as their target.
  holdShare: 0,
  frontComparisonMode: "allocated", transitSpeedKmPerWeek: 1000, transitCellDeg: 5,
  growthMode: "yearly", lossRate: 0, advanceRate: 100, advanceMax: 1, fleetBattleChance: 0,
} satisfies Partial<SimConfig>;

// The front is at a cell centre, exactly 3000 km north of the capital along a meridian.
const capitalLat = 27.5 - (3000 / 6371) * (180 / Math.PI);
const cellAt = (lon: number, lat: number) => Math.floor((lat + 90) / 5) * 1000 + Math.floor((lon + 180) / 5);
const farCell = cellAt(2.5, 27.5);

function singleFront(withCoordinates = true, mode: SimConfig["frontComparisonMode"] = "allocated") {
  const sim = createSimulation(
    makeMap({
      owners: ["A", "A", "B"], land: [[0, 1], [1, 2]],
      lonlat: withCoordinates ? [[2.5, capitalLat], [2.5, 27.5], [2.5, 32.5]] : [],
    }),
    makeScenario({ A: {}, B: {} }),
    { config: { ...config, frontComparisonMode: mode } },
  );
  setWar(sim, "A", "B");
  sim.military.set([90, 40]);
  return sim;
}

describe("army transit", () => {
  it("matches allocation after one call without coordinates, including lines sharing cell -1", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "X", "A", "Y"], land: [[0, 1], [2, 3]] }),
      makeScenario({ A: {}, X: {}, Y: {} }),
      { config },
    );
    sim.military.set([90, 30, 60]);
    setWar(sim, "A", "X");
    setWar(sim, "A", "Y");
    const fronts = computeFronts(sim);
    const target = allocateArmies(sim, fronts);
    expect(target.size).toBe(2);
    expect(target.get(0)!.get(0)).toBeCloseTo(30);
    expect(target.get(2)!.get(0)).toBeCloseTo(60);

    const deployed = deployArmies(sim, fronts, target);
    for (const [line, countries] of target) {
      for (const [c, strength] of countries) {
        expect(deployed.get(line)!.get(c)).toBeCloseTo(strength, 8);
      }
    }
    for (let c = 0; c < sim.tags.length; c++) {
      expect([...sim.deployed.get(c)!.keys()]).toEqual([-1]);
      expect(sim.deployed.get(c)!.get(-1)).toBeCloseTo(1, 8);
    }
  });

  it("approaches the target over successive weeks with a three-week time constant", () => {
    const sim = singleFront();
    const fronts = computeFronts(sim);
    const line = fronts.line[1];
    const target = allocateArmies(sim, fronts);
    const strength = target.get(line)!.get(0)!;
    expect(strength).toBeCloseTo(90);
    expect(sim.deployed.size).toBe(0);

    for (let week = 1; week <= 3; week++) {
      const deployed = deployArmies(sim, fronts, target);
      const share = 1 - (2 / 3) ** week;
      expect(sim.deployed.get(0)!.get(farCell)).toBeCloseTo(share, 8);
      expect(deployed.get(line)!.get(0)).toBeCloseTo(strength * share, 8);
    }
  });

  it("fully mans a near front in one week while a far front is still filling", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "X", "A", "Y"],
        land: [[0, 1], [1, 2], [0, 3], [3, 4]],
        lonlat: [[2.5, 2.5], [2.5, 7.5], [2.5, 7.5], [2.5, 32.5], [2.5, 32.5]],
      }),
      makeScenario({ A: {}, X: {}, Y: {} }),
      { config },
    );
    sim.military.set([90, 40, 40]);
    setWar(sim, "A", "X");
    setWar(sim, "A", "Y");
    const fronts = computeFronts(sim);
    const near = fronts.line[1], far = fronts.line[3];
    expect(near).not.toBe(far);
    const target = allocateArmies(sim, fronts);
    const deployed = deployArmies(sim, fronts, target);
    const farT = (6371 * 30 * Math.PI / 180) / config.transitSpeedKmPerWeek;
    expect(target.get(near)!.get(0)).toBeGreaterThan(0);
    expect(target.get(far)!.get(0)).toBeGreaterThan(0);
    expect(deployed.get(near)!.get(0)).toBeCloseTo(target.get(near)!.get(0)!, 8);
    expect(sim.deployed.get(0)!.get(cellAt(2.5, 7.5))).toBeCloseTo(target.get(near)!.get(0)! / 90, 8);
    expect(deployed.get(far)!.get(0)).toBeCloseTo(target.get(far)!.get(0)! / farT, 8);
    expect(deployed.get(far)!.get(0)).toBeLessThan(target.get(far)!.get(0)!);
  });

  it.each([
    [-1, -1], [-1, 0], [-1, 1], [0, -1],
    [0, 1], [1, -1], [1, 0], [1, 1],
  ])("reinforces faster from existing troops in neighbouring cell offset (%i, %i)", (dx, dy) => {
    const cold = singleFront();
    const reinforced = singleFront();
    const neighbour = cellAt(2.5 + dx * 5, 27.5 + dy * 5);
    reinforced.deployed.set(0, new Map([[neighbour, 0.25]]));
    const coldFronts = computeFronts(cold), warmFronts = computeFronts(reinforced);
    const coldArmy = deployArmies(cold, coldFronts, allocateArmies(cold, coldFronts));
    const warmArmy = deployArmies(reinforced, warmFronts, allocateArmies(reinforced, warmFronts));
    const line = coldFronts.line[1];
    expect(coldArmy.get(line)!.get(0)).toBeCloseTo(30, 8);
    // Even a diagonal neighbour is less than 1000 km away: T = 1.
    expect(warmArmy.get(line)!.get(0)).toBeCloseTo(90, 8);
    expect(warmArmy.get(line)!.get(0)).toBeGreaterThan(coldArmy.get(line)!.get(0)!);
    expect(reinforced.deployed.get(0)!.get(farCell)).toBeCloseTo(1, 8);
  });

  it.each([1e-5, 1e-4])("does not reinforce from a neighbour with only %s deployed share", (share) => {
    const sim = singleFront();
    sim.deployed.set(0, new Map([[cellAt(2.5, 22.5), share]]));
    const fronts = computeFronts(sim);
    expect(deployArmies(sim, fronts, allocateArmies(sim, fronts)).get(fronts.line[1])!.get(0)).toBeCloseTo(30, 8);
  });

  it("spreads a line's target by front-state count across its cells", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "A", "A", "B"],
        land: [[0, 1], [1, 2], [2, 3], [1, 4], [2, 4], [3, 4]],
        lonlat: [[2.5, 2.5], [2.5, 27.5], [3, 27.5], [2.5, 42.5], [2.5, 32.5]],
      }),
      makeScenario({ A: {}, B: {} }),
      { config },
    );
    sim.military.set([90, 40]);
    setWar(sim, "A", "B");
    const fronts = computeFronts(sim);
    const target = allocateArmies(sim, fronts);
    const deployed = deployArmies(sim, fronts, target);
    const nearT = (6371 * 25 * Math.PI / 180) / 1000;
    const farT = (6371 * 40 * Math.PI / 180) / 1000;
    const nearShare = (2 / 3) / nearT, farShare = (1 / 3) / farT;
    expect(fronts.line[1]).toBe(fronts.line[3]);
    expect(sim.deployed.get(0)!.size).toBe(2);
    expect(sim.deployed.get(0)!.get(farCell)).toBeCloseTo(nearShare, 8);
    expect(sim.deployed.get(0)!.get(cellAt(2.5, 42.5))).toBeCloseTo(farShare, 8);
    expect(deployed.get(fronts.line[1])!.get(0)).toBeCloseTo(90 * (nearShare + farShare), 8);
  });

  it("splits deployed strength between disconnected lines sharing a coordinate cell by their targets", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "X", "A", "Y"], land: [[0, 1], [1, 2], [0, 3], [3, 4]],
        lonlat: [[2.5, capitalLat], [2.5, 27.5], [2.5, 32.5], [2.5, 27.5], [2.5, 32.5]],
      }),
      makeScenario({ A: {}, X: {}, Y: {} }),
      { config },
    );
    sim.military.set([90, 30, 60]);
    setWar(sim, "A", "X");
    setWar(sim, "A", "Y");
    const fronts = computeFronts(sim);
    const target = allocateArmies(sim, fronts);
    expect(target.size).toBe(2);
    const deployed = deployArmies(sim, fronts, target);
    expect(sim.deployed.get(0)!.size).toBe(1);
    expect(sim.deployed.get(0)!.get(farCell)).toBeCloseTo(1 / 3, 8);
    expect(deployed.get(fronts.line[1])!.get(0)).toBeCloseTo(10, 8);
    expect(deployed.get(fronts.line[3])!.get(0)).toBeCloseTo(20, 8);
  });

  it.each(["war ends", "target is zero"])("withdraws using capital distance and removes tiny shares when %s", (reason) => {
    const sim = singleFront();
    const fronts = computeFronts(sim);
    deployArmies(sim, fronts, allocateArmies(sim, fronts));
    const cells = sim.deployed.get(0)!;
    const initial = cells.get(farCell)!;
    // A neighbouring garrison must not speed up withdrawal.
    const neighbour = cellAt(2.5, 22.5);
    cells.set(neighbour, 0.25);
    if (reason === "war ends") sim.atWar.fill(0);
    const withdrawalFronts = computeFronts(sim);
    const target = reason === "war ends"
      ? allocateArmies(sim, withdrawalFronts)
      : new Map([[fronts.line[1], new Map([[0, 0]])]]);
    if (reason === "war ends") expect(withdrawalFronts.line[1]).toBe(-1);
    const removalWeek = Math.floor(Math.log(1e-5 / initial) / Math.log(2 / 3)) + 1;

    for (let week = 1; week < removalWeek; week++) {
      const deployed = deployArmies(sim, withdrawalFronts, target);
      expect(cells.get(farCell)).toBeCloseTo(initial * (2 / 3) ** week, 10);
      expect(cells.has(farCell)).toBe(true);
      if (reason === "war ends") expect(deployed.size).toBe(0);
      else expect(deployed.get(fronts.line[1])!.get(0)).toBeCloseTo(0);
    }
    expect(cells.get(farCell)).toBeGreaterThanOrEqual(1e-5);
    deployArmies(sim, withdrawalFronts, target);
    expect(cells.has(farCell)).toBe(false);
    expect(sim.deployed.has(0)).toBe(false);
  });

  it.each(["nation", "divided"] as const)("returns the target unchanged in %s mode", (mode) => {
    const sim = singleFront(true, mode);
    const fronts = computeFronts(sim);
    const target = allocateArmies(sim, fronts);
    sim.deployed.set(0, new Map([[farCell, 0.125]]));
    expect(deployArmies(sim, fronts, target)).toBe(target);
    expect(sim.deployed.get(0)!.get(farCell)).toBeCloseTo(0.125);
  });

  it("uses deployed strength in step: a stronger distant army wins only after arrival", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "A", "B", "B"], land: [[0, 1], [1, 2], [2, 3]],
        capitals: { B: 3 },
        lonlat: [[2.5, capitalLat], [2.5, 27.5], [2.5, 32.5], [2.5, 32.5]],
      }),
      // Protect A's forward state so B cannot move the front during the buildup.
      makeScenario({ A: {}, B: {} }, [], [1]),
      { config },
    );
    sim.military.set([90, 65]);
    setWar(sim, "A", "B");
    const fronts = computeFronts(sim);
    expect(allocateArmies(sim, fronts).get(fronts.line[1])!.get(0)).toBeGreaterThan(65);

    for (let week = 1; week <= 3; week++) {
      step(sim);
      expect(sim.tick).toBe(week);
      expect(sim.result).toBeNull();
      expect(sim.owner[2]).toBe(1);
      expect(sim.deployed.get(0)!.get(farCell)).toBeCloseTo(1 - (2 / 3) ** week, 8);
      expect(90 * sim.deployed.get(0)!.get(farCell)!).toBeLessThan(65);
    }
    step(sim);
    expect(sim.tick).toBe(4);
    expect(sim.owner[2]).toBe(0);
    expect(90 * sim.deployed.get(0)!.get(farCell)!).toBeGreaterThan(65);
    expect(sim.military[0]).toBeCloseTo(90);
    expect(sim.military[1]).toBeCloseTo(65);
  });
});
