import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts } from "../combat";
import type { SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const rules = {
  frontComparisonMode: "allocated",
  regions: {},
  regionPriority: {},
  holdShare: 0,
  holdRatio: 1,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  lowPriorityFronts: {},
  encirclement: false,
  lossFactors: {},
  transitSpeedKmPerWeek: 1e9,
} satisfies Partial<SimConfig>;

const regions: SimConfig["regions"] = { R: [[-2, -2, 2, 2]] };
type Centre = [number, number] | undefined;

interface LineOptions {
  centres?: Centre[];
  config?: Partial<SimConfig>;
  enemies?: [number, number];
}

function ownLines({ centres = [[0, 0]], config = {}, enemies = [30, 30] }: LineOptions = {}) {
  // A's isolated capital has no coordinates, so both lines have exactly zero distance penalty.
  // Each line has the same number of edges; the second is entirely outside R.
  const owners = ["A"];
  const lonlat: Centre[] = [undefined];
  const land: [number, number][] = [];
  const lines: number[] = [];
  for (const [i, tag] of ["X", "Y"].entries()) {
    const enemy = owners.length;
    lines.push(enemy);
    owners.push(tag);
    lonlat.push([0, 0]);
    for (const centre of centres) {
      land.push([enemy, owners.length]);
      owners.push("A");
      lonlat.push(i === 0 ? centre : [30, 0]);
    }
  }
  const sim = createSimulation(
    makeMap({ owners, land, lonlat }),
    makeScenario({
      A: { faction: "allies" }, X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    { seed: 17, config: { ...rules, ...config } },
  );
  const a = sim.tags.indexOf("A");
  sim.military[a] = 90;
  for (const [i, tag] of ["X", "Y"].entries()) {
    sim.military[sim.tags.indexOf(tag)] = enemies[i];
    setWar(sim, "A", tag);
  }
  const fronts = computeFronts(sim);
  expect([...fronts.lineCountries.keys()]).toEqual(lines);
  expect(fronts.line[0]).toBe(-1);
  return { sim, fronts, a, lines };
}

function expectSplit(fixture: ReturnType<typeof ownLines>, factor: number) {
  const { sim, fronts, a, lines } = fixture;
  const allocation = allocateArmies(sim, fronts);
  const inside = allocation.get(lines[0])!.get(a)!;
  const outside = allocation.get(lines[1])!.get(a)!;
  expect(inside / outside).toBeCloseTo(factor, 8);
  expect(inside).toBeCloseTo(90 * factor / (1 + factor), 8);
  expect(outside).toBeCloseTo(90 / (1 + factor), 8);
  expect(inside + outside).toBeCloseTo(sim.military[a], 8);
}

describe("region allocation mask", () => {
  it.each([4, 0.25])("scales a fully covered own line by %s", (factor) => {
    expectSplit(ownLines({ config: { regions, regionPriority: { A: { R: factor } } } }), factor);
  });

  it.each([4, 0.25])("interpolates half coverage with R = %s", (factor) => {
    expectSplit(ownLines({
      centres: [[0, 0], [30, 0]],
      config: { regions, regionPriority: { A: { R: factor } } },
    }), 1 + (factor - 1) * 0.5);
  });

  it.each([
    { name: "one missing centre", centres: [[0, 0], undefined] as Centre[], share: 0.5 },
    { name: "all missing centres", centres: [undefined] as Centre[], share: 0 },
  ])("keeps $name in the denominator but outside the region", ({ centres, share }) => {
    expectSplit(ownLines({
      centres,
      config: { regions, regionPriority: { A: { R: 4 } } },
    }), 1 + 3 * share);
  });

  it("counts a state in the second box of a region", () => {
    expectSplit(ownLines({
      centres: [[11, 11]],
      config: {
        regions: { R: [[-2, -2, 2, 2], [10, 10, 12, 12]] },
        regionPriority: { A: { R: 4 } },
      },
    }), 4);
  });

  it.each([
    { name: "west edge", centre: [-2, 0], factor: 4 },
    { name: "south edge", centre: [0, -2], factor: 4 },
    { name: "east edge", centre: [2, 0], factor: 4 },
    { name: "north edge", centre: [0, 2], factor: 4 },
    { name: "southwest corner", centre: [-2, -2], factor: 4 },
    { name: "northeast corner", centre: [2, 2], factor: 4 },
    { name: "outside west", centre: [-2.001, 0], factor: 1 },
    { name: "outside south", centre: [0, -2.001], factor: 1 },
    { name: "outside east", centre: [2.001, 0], factor: 1 },
    { name: "outside north", centre: [0, 2.001], factor: 1 },
  ])("uses inclusive box bounds at $name", ({ centre, factor }) => {
    expectSplit(ownLines({
      centres: [centre as [number, number]],
      config: { regions, regionPriority: { A: { R: 4 } } },
    }), factor);
  });

  it("counts a state in overlapping boxes only once", () => {
    expectSplit(ownLines({
      centres: [[1, 0]],
      config: {
        regions: { R: [[-2, -2, 2, 2], [0, -1, 3, 1]] },
        regionPriority: { A: { R: 4 } },
      },
    }), 4);
  });

  it.each([
    { name: "half the allied side", allyCentre: [30, 0], factor: 2.5 },
    { name: "the whole allied side", allyCentre: [0, 0], factor: 4 },
  ])("applies A's mask to $name without changing unlisted countries", ({ allyCentre, factor }) => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "B", "A", "X", "B", "A", "Y", "B"],
        land: [[2, 3], [4, 3], [5, 6], [7, 6]],
        lonlat: [undefined, undefined, [0, 0], [0, 0], allyCentre as [number, number],
          [30, 0], [0, 0], [30, 0]],
      }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { seed: 19, config: { ...rules, regions } },
    );
    for (const [tag, army] of Object.entries({ A: 90, B: 120, X: 30, Y: 30 })) {
      sim.military[sim.tags.indexOf(tag)] = army;
    }
    for (const ally of ["A", "B"]) for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([2, 5]);
    const baseline = allocateArmies(sim, fronts);
    sim.config.regionPriority = { A: { R: 4 } };
    const masked = allocateArmies(sim, fronts);
    const a = sim.tags.indexOf("A"), b = sim.tags.indexOf("B");
    expect(masked.get(2)!.get(a)).toBeCloseTo(90 * factor / (1 + factor), 8);
    expect(masked.get(5)!.get(a)).toBeCloseTo(90 / (1 + factor), 8);
    for (const line of [2, 5]) {
      expect(baseline.get(line)!.get(a)).toBeCloseTo(45, 8);
      expect(masked.get(line)!.get(b)).toBeCloseTo(60, 8);
      for (const tag of ["B", "X", "Y"]) {
        const c = sim.tags.indexOf(tag);
        if (baseline.get(line)!.has(c)) {
          expect(masked.get(line)!.get(c)).toBeCloseTo(baseline.get(line)!.get(c)!, 8);
        }
      }
    }
  });

  it("multiplies region factors after interpolating each region's share", () => {
    // R covers both states, S covers one: 4 * (1 + (0.25 - 1) * 0.5) = 2.5.
    expectSplit(ownLines({
      centres: [[0, 0], [1, 0]],
      config: {
        regions: { ...regions, S: [[-0.5, -0.5, 0.5, 0.5]] },
        regionPriority: { A: { R: 4, S: 0.25 } },
      },
    }), 2.5);
  });

  it("has no effect with empty regionPriority even when regions are defined", () => {
    expectSplit(ownLines({ config: { regions, regionPriority: {} } }), 1);
  });

  it.each([0.25, 1, 4])("scales hold need by min(1, %s)", (factor) => {
    const { sim, fronts, a, lines } = ownLines({
      enemies: [10, 100],
      config: { regions, regionPriority: { A: { R: factor } }, holdShare: 0.5 },
    });
    const allocation = allocateArmies(sim, fronts);
    // Only the small need fits the reserve of 45. The rest uses weights 10 * factor : 100.
    const held = 10 * Math.min(1, factor);
    const rest = 90 - held;
    const weight = 10 * factor;
    expect(allocation.get(lines[0])!.get(a)).toBeCloseTo(held + rest * weight / (weight + 100), 8);
    expect(allocation.get(lines[1])!.get(a)).toBeCloseTo(rest * 100 / (weight + 100), 8);
    expect(allocation.get(lines[0])!.get(a)! + allocation.get(lines[1])!.get(a)!).toBeCloseTo(90, 8);
  });

  it.each(["nation", "divided"] as const)("ignores region masks in %s mode", (mode) => {
    const { sim, fronts, a, lines } = ownLines({
      config: {
        frontComparisonMode: mode, regions, regionPriority: { A: { R: 4 } }, holdShare: 0.5,
      },
    });
    const baseline = allocateArmies(sim, fronts);
    sim.config.regionPriority = { A: { R: 0.25 } };
    const masked = allocateArmies(sim, fronts);
    expect(fronts.frontCount[a]).toBe(2);
    for (const line of lines) {
      for (const [c, army] of baseline.get(line)!) {
        const expected = mode === "nation" ? sim.military[c] : sim.military[c] / fronts.frontCount[c];
        expect(army).toBeCloseTo(expected, 8);
        expect(masked.get(line)!.get(c)).toBeCloseTo(expected, 8);
      }
    }
  });
});
