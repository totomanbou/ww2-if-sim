import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, deployArmies } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

const regions: SimConfig["regions"] = { R: [[-2, -2, 2, 2]] };
const rules = {
  frontComparisonMode: "allocated",
  regions,
  regionPriority: {},
  enemyPriority: {},
  holdShare: 0,
  holdRatio: 1,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  lowPriorityFronts: {},
  encirclement: false,
  lossFactors: {},
  transitSpeedKmPerWeek: 1e9,
} satisfies Partial<SimConfig>;

type Centre = [number, number] | undefined;
interface LineSpec { centres: Centre[]; enemyArmy: number }
const separateLines: LineSpec[] = [
  { centres: [[0, 0]], enemyArmy: 30 },
  { centres: [[30, 0]], enemyArmy: 30 },
];

function fixture(
  specs = separateLines,
  regionCap: SimConfig["regionCap"] = { A: { R: 6 } },
  military = 90,
) {
  // An isolated capital without coordinates removes distance penalties from allocation and deployment.
  const owners = ["A"], lonlat: Centre[] = [undefined];
  const land: [number, number][] = [], lines: number[] = [];
  const countries: Parameters<typeof makeScenario>[0] = { A: { faction: "allies" } };
  for (const [i, { centres }] of specs.entries()) {
    const tag = "E" + i, enemy = owners.length;
    lines.push(enemy);
    countries[tag] = { faction: "axis" };
    owners.push(tag);
    // Enemy coordinates deliberately oppose A's coverage on the two default lines.
    lonlat.push(i === 0 ? [30, 0] : [0, 0]);
    for (const centre of centres) {
      land.push([enemy, owners.length]);
      owners.push("A");
      lonlat.push(centre);
    }
  }
  const sim = createSimulation(makeMap({ owners, land, lonlat }), makeScenario(countries),
    { seed: 17, config: { ...rules, regionCap } });
  const a = sim.tags.indexOf("A");
  sim.military[a] = military;
  for (const [i, spec] of specs.entries()) {
    sim.military[sim.tags.indexOf("E" + i)] = spec.enemyArmy;
    setWar(sim, "A", "E" + i);
  }
  const fronts = computeFronts(sim);
  expect([...fronts.lineCountries.keys()]).toEqual(lines);
  expect(fronts.line[0]).toBe(-1);
  return { sim, fronts, a, lines };
}

function uncappedTargets({ sim, fronts }: ReturnType<typeof fixture>) {
  const caps = sim.config.regionCap;
  sim.config.regionCap = {};
  const target = allocateArmies(sim, fronts);
  sim.config.regionCap = caps;
  return target;
}

const army = (out: ReturnType<typeof allocateArmies>, line: number, country: number) => out.get(line)!.get(country)!;

describe("region cap defaults", () => {
  it("limits Germany to 6 in North Africa and 0 in East Africa, and Italy to 12 in East Africa", () => {
    expect(DEFAULT_CONFIG.regionCap).toEqual({ GER: { NAF: 6, EAF: 0 }, ITA: { EAF: 12 }, JAP: { IND: 8 } });
  });

  it("defines the East African boxes", () => {
    expect(DEFAULT_CONFIG.regions.EAF).toEqual([[21, -12, 52, 15], [33, 15, 45, 18.5]]);
  });

  it("defines the North African box in longitude/latitude order", () => {
    expect(DEFAULT_CONFIG.regions.NAF).toEqual([[-17, 15, 33, 37.2]]);
  });
});

describe("region cap allocation", () => {
  it("caps a fully covered line and gives its entire excess to the outside line", () => {
    const f = fixture(), { sim, fronts, a, lines } = f;
    const baseline = uncappedTargets(f), out = allocateArmies(sim, fronts);
    expect(army(baseline, lines[0], a)).toBeCloseTo(45, 8);
    expect(army(baseline, lines[1], a)).toBeCloseTo(45, 8);
    expect(army(out, lines[0], a)).toBeCloseTo(6, 8);
    expect(army(out, lines[1], a)).toBeCloseTo(84, 8);
    expect(army(out, lines[1], a) - army(baseline, lines[1], a)).toBeCloseTo(45 - 6, 8);
    expect(lines.reduce((sum, l) => sum + army(out, l, a), 0)).toBeCloseTo(sim.military[a], 8);
    for (const line of lines) for (const [c, amount] of baseline.get(line)!) {
      if (c !== a) expect(army(out, line, c)).toBeCloseTo(amount, 8);
    }
  });

  it("leaves the excess unallocated when there is no outside line", () => {
    const { sim, fronts, a, lines } = fixture([separateLines[0]]);
    const out = allocateArmies(sim, fronts);
    const total = lines.reduce((sum, l) => sum + army(out, l, a), 0);
    expect(total).toBeCloseTo(6, 8);
    expect(total).toBeLessThan(sim.military[a]);
    expect(sim.military[a]).toBe(90);
  });

  it("caps the regional share of a partly covered line by scaling the whole line", () => {
    const f = fixture([
      { centres: [[0, 0], [30, 0]], enemyArmy: 30 },
      { centres: [[30, 0], [30, 0]], enemyArmy: 30 },
    ]);
    const { sim, fronts, a, lines } = f;
    const baseline = uncappedTargets(f), out = allocateArmies(sim, fronts);
    expect(army(baseline, lines[0], a)).toBeCloseTo(45, 8);
    expect(army(out, lines[0], a)).toBeCloseTo(12, 8);
    expect(army(out, lines[0], a) * 0.5).toBeCloseTo(6, 8);
    expect(army(out, lines[1], a)).toBeCloseTo(78, 8);
  });

  it("uses all allied front states for the share and leaves the uncapped ally unchanged", () => {
    const sim = createSimulation(makeMap({
      owners: ["A", "B", "A", "X", "B", "A", "Y", "B"],
      land: [[2, 3], [4, 3], [5, 6], [7, 6]],
      lonlat: [undefined, undefined, [0, 0], [30, 0], [30, 0], [30, 0], [0, 0], [30, 0]],
    }), makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }), { config: { ...rules, regionCap: { A: { R: 6 } } } });
    for (const [tag, amount] of Object.entries({ A: 90, B: 120, X: 30, Y: 30 })) {
      sim.military[sim.tags.indexOf(tag)] = amount;
    }
    for (const ally of ["A", "B"]) for (const enemy of ["X", "Y"]) setWar(sim, ally, enemy);
    const a = sim.tags.indexOf("A"), b = sim.tags.indexOf("B"), fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([2, 5]);
    const out = allocateArmies(sim, fronts);
    expect(army(out, 2, a) * 0.5).toBeCloseTo(6, 8);
    expect(army(out, 2, a)).toBeCloseTo(12, 8);
    expect(army(out, 5, a)).toBeCloseTo(78, 8);
    for (const line of [2, 5]) expect(army(out, line, b)).toBeCloseTo(60, 8);
  });

  it("applies the same cap/inRegion factor to every line with positive coverage", () => {
    const f = fixture([
      { centres: [[0, 0]], enemyArmy: 20 },
      { centres: [[0, 0], [30, 0]], enemyArmy: 10 },
      { centres: [[30, 0]], enemyArmy: 30 },
    ]);
    const { sim, fronts, a, lines } = f;
    const baseline = uncappedTargets(f), out = allocateArmies(sim, fronts);
    const inRegion = army(baseline, lines[0], a) + 0.5 * army(baseline, lines[1], a);
    expect(inRegion).toBeGreaterThan(6);
    for (const line of lines.slice(0, 2)) {
      expect(army(out, line, a) / army(baseline, line, a)).toBeCloseTo(6 / inRegion, 8);
    }
    expect(army(out, lines[0], a) + 0.5 * army(out, lines[1], a)).toBeCloseTo(6, 8);
    const freed = lines.slice(0, 2).reduce((sum, l) => sum + army(baseline, l, a) - army(out, l, a), 0);
    expect(army(out, lines[2], a)).toBeCloseTo(army(baseline, lines[2], a) + freed, 8);
  });

  it("redistributes excess proportionally among multiple entirely outside lines", () => {
    const f = fixture([
      separateLines[0],
      { centres: [[30, 0]], enemyArmy: 10 },
      { centres: [[40, 0]], enemyArmy: 30 },
    ]);
    const { sim, fronts, a, lines } = f;
    const baseline = uncappedTargets(f), out = allocateArmies(sim, fronts);
    const freed = army(baseline, lines[0], a) - 6;
    const outside = army(baseline, lines[1], a) + army(baseline, lines[2], a);
    expect(freed).toBeGreaterThan(0);
    expect(army(out, lines[0], a)).toBeCloseTo(6, 8);
    for (const line of lines.slice(1)) {
      const amount = army(baseline, line, a);
      expect(army(out, line, a)).toBeCloseTo(amount + freed * amount / outside, 8);
    }
    expect(army(out, lines[1], a) / army(out, lines[2], a)).toBeCloseTo(1 / 3, 8);
    expect(lines.reduce((sum, l) => sum + army(out, l, a), 0)).toBeCloseTo(90, 8);
  });

  it.each([10, 12])("does not change allocation below or exactly at the cap (military %s)", (military) => {
    const f = fixture(separateLines, { A: { R: 6 } }, military);
    const baseline = uncappedTargets(f);
    expect(allocateArmies(f.sim, f.fronts)).toEqual(baseline);
    expect(army(baseline, f.lines[0], f.a)).toBeCloseTo(military / 2, 8);
  });

  it("restores the uncapped split when regionCap is cleared", () => {
    const { sim, fronts, a, lines } = fixture();
    expect(army(allocateArmies(sim, fronts), lines[0], a)).toBeCloseTo(6, 8);
    sim.config.regionCap = {};
    const out = allocateArmies(sim, fronts);
    for (const line of lines) expect(army(out, line, a)).toBeCloseTo(45, 8);
  });

  it("supports a zero cap and moves all army to the outside line", () => {
    const { sim, fronts, a, lines } = fixture(separateLines, { A: { R: 0 } });
    const out = allocateArmies(sim, fronts);
    expect(army(out, lines[0], a)).toBe(0);
    expect(army(out, lines[1], a)).toBeCloseTo(90, 8);
  });
});

describe("region cap deployment", () => {
  it.each([1, 0.5])("caps deployed army with coverage %s without redistributing the removed army", (share) => {
    const centres: Centre[] = share === 1 ? [[0, 0]] : [[0, 0], [30, 0]];
    const f = fixture([
      { centres, enemyArmy: 30 },
      { centres: centres.map(() => [30, 0]), enemyArmy: 30 },
    ]);
    const { sim, fronts, a, lines } = f;
    // Feed an over-cap target directly so this checks deployment's own cap enforcement.
    // Weekly steps and fast transit make the pre-cap deployment equal to this target.
    const target = uncappedTargets(f), out = deployArmies(sim, fronts, target);
    expect(army(target, lines[0], a)).toBeCloseTo(45, 8);
    expect(army(out, lines[0], a) * share).toBeCloseTo(6, 8);
    expect(army(out, lines[0], a)).toBeCloseTo(6 / share, 8);
    expect(army(out, lines[1], a)).toBeCloseTo(45, 8);
    expect(lines.reduce((sum, l) => sum + army(out, l, a), 0)).toBeLessThan(sim.military[a]);
    expect(army(target, lines[0], a)).toBeCloseTo(45, 8);
    expect(sim.military[a]).toBe(90);
  });

  it("leaves deployment below the cap unchanged", () => {
    const f = fixture(separateLines, { A: { R: 6 } }, 10);
    const target = uncappedTargets(f);
    expect(deployArmies(f.sim, f.fronts, target)).toEqual(target);
  });

  it("leaves uncapped deployment unchanged when regionCap is empty", () => {
    const { sim, fronts } = fixture(separateLines, {});
    const target = allocateArmies(sim, fronts);
    expect(deployArmies(sim, fronts, target)).toEqual(target);
  });
});
