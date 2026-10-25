import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, deployArmies } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

const rules = {
  frontComparisonMode: "allocated",
  regions: { R: [[-2, -2, 2, 2]] },
  regionPriority: {},
  enemyPriority: {},
  regionCap: {},
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
const western: SimConfig["regionGroupCaps"][number] = {
  name: "Western allies", region: "R", cap: 40, faction: "allies", except: ["SOV"],
};

function fixture(
  specs = separateLines,
  group: SimConfig["regionGroupCaps"][number] = western,
  regionCap: SimConfig["regionCap"] = {},
) {
  // Coordinate-free, isolated capitals eliminate distance penalties.
  const owners = ["A", "B", "SOV"], lonlat: Centre[] = [undefined, undefined, undefined];
  const land: [number, number][] = [], lines: number[] = [];
  const countries: Parameters<typeof makeScenario>[0] = {
    A: { faction: "allies" }, B: { faction: "allies" }, SOV: { faction: "allies" },
  };
  for (const [i, { centres }] of specs.entries()) {
    const tag = "E" + i, enemy = owners.length;
    lines.push(enemy);
    countries[tag] = { faction: "axis" };
    owners.push(tag);
    // Opposite-side coordinates must not determine the Allied side's regional share.
    lonlat.push(i === 0 ? [30, 0] : [0, 0]);
    for (const centre of centres) for (const ally of ["A", "B", "SOV"]) {
      land.push([enemy, owners.length]);
      owners.push(ally);
      lonlat.push(centre);
    }
  }
  const sim = createSimulation(makeMap({ owners, land, lonlat }), makeScenario(countries),
    { seed: 17, config: { ...rules, regionCap, regionGroupCaps: [group] } });
  const [a, b, sov] = ["A", "B", "SOV"].map((tag) => sim.tags.indexOf(tag));
  for (const [c, amount] of [[a, 90], [b, 120], [sov, 150]]) sim.military[c] = amount;
  for (const [i, spec] of specs.entries()) {
    sim.military[sim.tags.indexOf("E" + i)] = spec.enemyArmy;
    for (const ally of ["A", "B", "SOV"]) setWar(sim, ally, "E" + i);
  }
  const fronts = computeFronts(sim);
  expect([...fronts.lineCountries.keys()]).toEqual(lines);
  for (const capital of [0, 1, 2]) expect(fronts.line[capital]).toBe(-1);
  return { sim, fronts, a, b, sov, lines };
}

const army = (out: ReturnType<typeof allocateArmies>, line: number, country: number) => out.get(line)!.get(country)!;

function withoutGroup({ sim, fronts }: ReturnType<typeof fixture>) {
  const caps = sim.config.regionGroupCaps;
  sim.config.regionGroupCaps = [];
  try { return allocateArmies(sim, fronts); }
  finally { sim.config.regionGroupCaps = caps; }
}

describe("region group cap defaults", () => {
  it("caps the Western Allies together at 40 in Italy, excluding the USSR", () => {
    expect(DEFAULT_CONFIG.regionGroupCaps).toEqual([{
      name: "西側連合国のイタリア", region: "ITP", cap: 40, faction: "allies", except: ["SOV"],
    }]);
  });

  it("defines the Italian peninsula, Sicily and Sardinia boxes in longitude/latitude order", () => {
    expect(DEFAULT_CONFIG.regions.ITP).toEqual([
      [6.6, 43.6, 13.9, 47.1], [9.5, 41.2, 16.2, 44.2], [13.8, 37.9, 18.6, 42],
      [12.3, 36.6, 15.7, 38.4], [8.1, 38.8, 9.9, 41.3],
    ]);
  });
});

describe("region group allocation", () => {
  it("scales two members by the same factor and makes their regional total equal the cap", () => {
    const f = fixture(), { sim, fronts, a, b, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    expect(army(baseline, lines[0], a)).toBeCloseTo(45, 8);
    expect(army(baseline, lines[0], b)).toBeCloseTo(60, 8);
    const total = army(baseline, lines[0], a) + army(baseline, lines[0], b);
    for (const c of [a, b]) {
      expect(army(out, lines[0], c) / army(baseline, lines[0], c)).toBeCloseTo(40 / total, 8);
    }
    expect(army(out, lines[0], a) + army(out, lines[0], b)).toBeCloseTo(40, 8);
  });

  it("redistributes each member's own excess only to its entirely outside line", () => {
    const f = fixture(), { sim, fronts, a, b, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    for (const c of [a, b]) {
      const freed = army(baseline, lines[0], c) - army(out, lines[0], c);
      expect(freed).toBeGreaterThan(0);
      expect(army(out, lines[1], c)).toBeCloseTo(army(baseline, lines[1], c) + freed, 8);
      expect(lines.reduce((sum, l) => sum + army(out, l, c), 0)).toBeCloseTo(sim.military[c], 8);
    }
    expect(sim.military[a]).toBe(90);
    expect(sim.military[b]).toBe(120);
  });

  it("leaves the excepted ally and every enemy unchanged on every line", () => {
    const f = fixture(), { sim, fronts, a, b, sov, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    expect(army(baseline, lines[0], sov)).toBeCloseTo(75, 8);
    for (const line of lines) for (const [c, amount] of baseline.get(line)!) {
      if (c !== a && c !== b) expect(army(out, line, c)).toBeCloseTo(amount, 8);
    }
  });

  it("uses side shares and scales every positively covered line by the group's cap/total", () => {
    const f = fixture([
      { centres: [[0, 0]], enemyArmy: 20 },
      { centres: [[0, 0], [30, 0]], enemyArmy: 10 },
      { centres: [[30, 0]], enemyArmy: 30 },
    ]);
    const { sim, fronts, a, b, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    const regional = [a, b].reduce((sum, c) =>
      sum + army(baseline, lines[0], c) + 0.5 * army(baseline, lines[1], c), 0);
    expect(regional).toBeGreaterThan(40);
    for (const c of [a, b]) {
      for (const line of lines.slice(0, 2)) {
        expect(army(out, line, c) / army(baseline, line, c)).toBeCloseTo(40 / regional, 8);
      }
      const freed = lines.slice(0, 2).reduce((sum, l) => sum + army(baseline, l, c) - army(out, l, c), 0);
      expect(army(out, lines[2], c)).toBeCloseTo(army(baseline, lines[2], c) + freed, 8);
    }
    expect([a, b].reduce((sum, c) =>
      sum + army(out, lines[0], c) + 0.5 * army(out, lines[1], c), 0)).toBeCloseTo(40, 8);
  });

  it("redistributes each member's excess proportionally over multiple outside lines", () => {
    const f = fixture([
      separateLines[0],
      { centres: [[30, 0]], enemyArmy: 10 },
      { centres: [[40, 0]], enemyArmy: 30 },
    ]);
    const { sim, fronts, a, b, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    for (const c of [a, b]) {
      const freed = army(baseline, lines[0], c) - army(out, lines[0], c);
      const room = army(baseline, lines[1], c) + army(baseline, lines[2], c);
      for (const line of lines.slice(1)) {
        expect(army(out, line, c)).toBeCloseTo(army(baseline, line, c) * (1 + freed / room), 8);
      }
      expect(army(out, lines[1], c) / army(out, lines[2], c)).toBeCloseTo(1 / 3, 8);
    }
  });

  it("leaves excess unallocated when members have no outside line", () => {
    const { sim, fronts, a, b, lines } = fixture([separateLines[0]]);
    const out = allocateArmies(sim, fronts);
    expect(army(out, lines[0], a) + army(out, lines[0], b)).toBeCloseTo(40, 8);
    for (const c of [a, b]) expect(army(out, lines[0], c)).toBeLessThan(sim.military[c]);
  });

  it.each([105, 200])("leaves allocation unchanged at or below a group cap of %s", (cap) => {
    const f = fixture(separateLines, { ...western, cap });
    const baseline = withoutGroup(f);
    expect(army(baseline, f.lines[0], f.a) + army(baseline, f.lines[0], f.b)).toBeCloseTo(105, 8);
    expect(allocateArmies(f.sim, f.fronts)).toEqual(baseline);
  });

  it("supports a zero group cap and returns all member armies to outside lines", () => {
    const { sim, fronts, a, b, lines } = fixture(separateLines, { ...western, cap: 0 });
    const out = allocateArmies(sim, fronts);
    for (const c of [a, b]) {
      expect(army(out, lines[0], c)).toBe(0);
      expect(army(out, lines[1], c)).toBeCloseTo(sim.military[c], 8);
    }
  });

  it("keeps per-country caps effective alongside a binding group cap", () => {
    const f = fixture(separateLines, western, { A: { R: 10 } });
    const { sim, fronts, a, b, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    expect(army(baseline, lines[0], a)).toBeCloseTo(10, 8);
    expect(army(baseline, lines[0], b)).toBeCloseTo(60, 8);
    for (const c of [a, b]) {
      expect(army(out, lines[0], c) / army(baseline, lines[0], c)).toBeCloseTo(40 / 70, 8);
      expect(lines.reduce((sum, l) => sum + army(out, l, c), 0)).toBeCloseTo(sim.military[c], 8);
    }
    expect(army(out, lines[0], a)).toBeLessThanOrEqual(10);
    expect(army(out, lines[0], a) + army(out, lines[0], b)).toBeCloseTo(40, 8);
  });
});

describe("region group membership", () => {
  it.each([
    { name: "Explicit tags", region: "R", cap: 40, tags: ["A", "SOV", "ABSENT"] },
    { name: "Tags take precedence", region: "R", cap: 40, tags: ["A", "SOV", "ABSENT"],
      faction: "axis", except: ["A", "SOV"] },
  ] satisfies SimConfig["regionGroupCaps"])("selects only listed tags for $name", (group) => {
    const f = fixture(separateLines, group), { sim, fronts, a, b, sov, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    const total = army(baseline, lines[0], a) + army(baseline, lines[0], sov);
    for (const c of [a, sov]) {
      expect(army(out, lines[0], c) / army(baseline, lines[0], c)).toBeCloseTo(40 / total, 8);
    }
    expect(army(out, lines[0], a) + army(out, lines[0], sov)).toBeCloseTo(40, 8);
    for (const line of lines) expect(army(out, line, b)).toBeCloseTo(army(baseline, line, b), 8);
  });

  it("includes the USSR when faction membership has no exceptions", () => {
    const f = fixture(separateLines, { name: "All allies", region: "R", cap: 40, faction: "allies" });
    const { sim, fronts, a, b, sov, lines } = f;
    const baseline = withoutGroup(f), out = allocateArmies(sim, fronts);
    for (const c of [a, b, sov]) {
      expect(army(out, lines[0], c) / army(baseline, lines[0], c)).toBeCloseTo(40 / 180, 8);
    }
    expect([a, b, sov].reduce((sum, c) => sum + army(out, lines[0], c), 0)).toBeCloseTo(40, 8);
  });

  it.each([{ tags: [] }, { tags: ["ABSENT"] }])("ignores a group with no existing members ($tags)", ({ tags }) => {
    const f = fixture(separateLines, { name: "Empty", region: "R", cap: 0, tags });
    expect(allocateArmies(f.sim, f.fronts)).toEqual(withoutGroup(f));
  });
});

describe("region group deployment", () => {
  it.each([1, 0.5])("enforces the cap on deployed side share %s without redistributing", (share) => {
    const centres: Centre[] = share === 1 ? [[0, 0]] : [[0, 0], [30, 0]];
    const f = fixture([
      { centres, enemyArmy: 30 },
      { centres: centres.map(() => [30, 0]), enemyArmy: 30 },
    ]);
    const { sim, fronts, a, b, sov, lines } = f;
    const target = withoutGroup(f), out = deployArmies(sim, fronts, target);
    const total = share * (army(target, lines[0], a) + army(target, lines[0], b));
    expect(total).toBeGreaterThan(40);
    for (const c of [a, b]) {
      expect(army(out, lines[0], c) / army(target, lines[0], c)).toBeCloseTo(40 / total, 8);
      expect(army(out, lines[1], c)).toBeCloseTo(army(target, lines[1], c), 8);
      expect(lines.reduce((sum, l) => sum + army(out, l, c), 0)).toBeLessThan(sim.military[c]);
    }
    expect(share * (army(out, lines[0], a) + army(out, lines[0], b))).toBeCloseTo(40, 8);
    for (const line of lines) expect(army(out, line, sov)).toBeCloseTo(army(target, line, sov), 8);
    expect(army(target, lines[0], a)).toBeCloseTo(45, 8);
  });
});
