import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, resolveCombat, sideOf } from "../combat";
import type { SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const config = {
  encirclement: false,
  lossFactors: {},
  lowPriorityFronts: {},
  slowAdvanceLand: {},
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  regionPriority: {},
  landingWithoutNavy: {},
  transitSpeedKmPerWeek: 1e9,
  holdShare: 0,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  frontComparisonMode: "allocated",
  advanceRate: 2,
  advanceMax: 2,
  advanceBreadthEdges: 4,
  navalPenalty: 0.5,
  lossRate: 0.1,
} satisfies Partial<SimConfig>;

type Kind = "land" | "sea";

function star(
  kind: Kind,
  edges = 12,
  overrides: Partial<SimConfig> = {},
  ratio = 100,
  seed = 42,
) {
  // Every edge shares state 0, so all targets belong to a single line.
  const borders: [number, number][] = Array.from({ length: edges }, (_, i) => [0, i + 1]);
  const sim = createSimulation(
    makeMap({
      owners: ["A", ...Array<string>(edges).fill("X")],
      land: kind === "land" ? borders : [],
      sea: kind === "sea" ? borders : [],
    }),
    makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } }),
    { seed, config: { ...config, ...overrides } },
  );
  const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
  // ratio is the effective capture ratio, including the landing penalty.
  sim.military[a] = 10 * ratio / (kind === "sea" ? sim.config.navalPenalty : 1);
  sim.military[x] = 10;
  if (kind === "sea") sim.fleets.push({ country: a, zone: 0, strength: 100, target: 0 });
  setWar(sim, "A", "X");
  return { sim, a, x };
}

function oneBattle(sim: ReturnType<typeof createSimulation>) {
  const fronts = computeFronts(sim);
  expect(fronts.lineCountries.size).toBe(1);
  const battles = resolveCombat(sim, fronts);
  expect(battles).toHaveLength(1);
  return battles[0];
}

describe("links between belligerent allies", () => {
  it.each(["land", "sea"] as const)(
    "does not link through a non-belligerent ally over %s until it enters the war",
    (kind) => {
      const bridge: [number, number][] = [[0, 1], [1, 2]];
      const sim = createSimulation(
        makeMap({
          owners: ["A", "C", "B", "X"],
          land: [[0, 3], ...(kind === "land" ? bridge : [])],
          sea: kind === "sea" ? bridge : [],
        }),
        makeScenario({
          A: { faction: "allies" }, B: { faction: "allies" },
          C: { faction: "allies" }, X: { faction: "axis" },
        }),
        { config },
      );
      const [a, b, c, x] = ["A", "B", "C", "X"].map((tag) => sim.tags.indexOf(tag));
      setWar(sim, "A", "X");
      setWar(sim, "B", "X");

      const before = computeFronts(sim);
      const line = before.line[0];
      expect(Array.from(before.line)).toEqual([line, -1, -1, line]);
      expect(before.lineCountries.get(line)).toEqual(new Set([a, x]));
      expect(before.lineCountries.get(line)!.has(b)).toBe(false);
      expect(before.frontCount[b]).toBe(0);
      expect(before.frontCount[c]).toBe(0);

      setWar(sim, "C", "X");
      const after = computeFronts(sim);
      expect(Array.from(after.line)).toEqual(Array.from(before.line));
      expect(after.lineCountries.get(line)).toEqual(new Set([a, b, c, x]));
      expect(after.lineFront.get(line)!.has(b)).toBe(false);
      expect(after.lineFront.get(line)!.has(c)).toBe(false);
    },
  );

  it.each(["land", "sea"] as const)("links directly adjacent belligerent allies over %s", (kind) => {
    const sim = createSimulation(
      makeMap({
        owners: ["A", "B", "X"],
        land: [[0, 2], ...(kind === "land" ? [[0, 1] as [number, number]] : [])],
        sea: kind === "sea" ? [[0, 1]] : [],
      }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" }, X: { faction: "axis" },
      }),
      { config },
    );
    setWar(sim, "A", "X");
    setWar(sim, "B", "X");
    const fronts = computeFronts(sim);
    expect(fronts.line[1]).toBe(-1);
    expect(fronts.lineCountries.get(fronts.line[0])).toEqual(new Set(sim.tags.map((_, i) => i)));
  });
});

describe.each(["land", "sea"] as const)("%s broad-front advance", (kind) => {
  it.each([2, 4])("preserves captures below or at the breadth threshold with %i edges", (edges) => {
    // Exercise both random rounding and a saturated cap, using independent simulations.
    for (const ratio of [1.75, 100]) {
      for (const seed of [1, 7, 42, 2026]) {
        const normal = star(kind, edges, {}, ratio, seed);
        const baseline = star(kind, edges, { advanceBreadthEdges: 1e9 }, ratio, seed);
        const battle = oneBattle(normal.sim);
        expect(battle.captures.length).toBeGreaterThan(0);
        expect(battle).toEqual(oneBattle(baseline.sim));
      }
    }
  });

  it("captures exactly three times advanceMax in one week when overwhelming", () => {
    const { sim, a, x } = star(kind);
    const fronts = computeFronts(sim);
    expect(fronts.lineFront.get(fronts.line[0])!.get(a)!.edges).toBe(3 * config.advanceBreadthEdges);
    expect(fronts.targets.get(a * sim.tags.length + x)![kind].size).toBe(12);
    const battle = oneBattle(sim);
    const expected = 3 * config.advanceMax;
    expect(battle.captures).toHaveLength(expected);
    expect(new Set(battle.captures).size).toBe(expected);
    expect(battle.captors).toEqual(Array<number>(expected).fill(a));
    expect(battle.capturedFrom).toEqual(Array<number>(expected).fill(x));
    applyBattles(sim, [battle]);
    expect(Array.from(sim.owner).filter((owner) => owner === a)).toHaveLength(1 + expected);
    expect(Array.from(sim.owner).filter((owner) => owner === x)).toHaveLength(12 - expected);

    const baseline = star(kind, 12, { advanceBreadthEdges: 1e9 });
    expect(oneBattle(baseline.sim).captures).toHaveLength(config.advanceMax);
  });

  it("multiplies advanceRate by three for an uncapped moderate ratio", () => {
    // r = 1.5 gives the integer expectation 3 * 2 * (1.5 - 1) = 3, below the cap of 6.
    const ratio = 1.5;
    const expected = 3 * config.advanceRate * (ratio - 1);
    for (const seed of [1, 7, 42, 2026]) {
      const { sim } = star(kind, 12, {}, ratio, seed);
      const battle = oneBattle(sim);
      const effectiveRatio = battle.attStrength / battle.defStrength * (kind === "sea" ? config.navalPenalty : 1);
      expect(effectiveRatio).toBe(ratio);
      expect(expected).toBeLessThan(3 * config.advanceMax);
      expect(battle.captures).toHaveLength(expected);
      const baseline = star(kind, 12, { advanceBreadthEdges: 1e9 }, ratio, seed);
      expect(oneBattle(baseline.sim).captures).toHaveLength(config.advanceRate * (ratio - 1));
    }
  });

  it("repeats captures, losses, owners and RNG state with the same seed", () => {
    const run = () => {
      const { sim } = star(kind, 12, {}, 1.75, 8675309);
      // Expected advance is 4.5: this exercises random rounding and weighted target selection.
      const battle = oneBattle(sim);
      expect([4, 5]).toContain(battle.captures.length);
      applyBattles(sim, [battle]);
      return {
        battle,
        owners: Array.from(sim.owner),
        military: Array.from(sim.military),
        rngState: sim.rng.state,
      };
    };
    expect(run()).toEqual(run());
  });
});

describe("breadth from attacking holders only", () => {
  it("sums joint holders' edges without adding defending or supporting countries' edges", () => {
    // A and B each hold 6 edges, sharing target 2 to join their sectors into one line.
    // S has many friendly borders but no front state; it contributes strength, not breadth.
    const land: [number, number][] = [[0, 2], [1, 2]];
    for (let s = 3; s < 8; s++) land.push([0, s]);
    for (let s = 8; s < 13; s++) land.push([1, s]);
    for (let s = 13; s < 21; s++) land.push([0, s]);
    const run = (supporter: boolean) => {
      const sim = createSimulation(
        makeMap({
          owners: ["A", "B", ...Array<string>(11).fill("X"), ...Array<string>(8).fill("S")],
          land,
        }),
        makeScenario({
          A: { faction: "axis" }, B: { faction: "axis" },
          S: { faction: "axis" }, X: { faction: "allies" },
        }),
        { seed: 42, config },
      );
      const [a, b, s, x] = ["A", "B", "S", "X"].map((tag) => sim.tags.indexOf(tag));
      // Keep total strength and pressure per edge unchanged when adding the supporter.
      sim.military[a] = supporter ? 100 : 500;
      sim.military[b] = supporter ? 100 : 500;
      sim.military[s] = supporter ? 800 : 0;
      sim.military[x] = 10;
      setWar(sim, "A", "X");
      setWar(sim, "B", "X");
      if (supporter) setWar(sim, "S", "X");
      const fronts = computeFronts(sim), line = fronts.line[0];
      expect(fronts.lineFront.get(line)!.get(a)!.edges).toBe(6);
      expect(fronts.lineFront.get(line)!.get(b)!.edges).toBe(6);
      expect(fronts.lineFront.get(line)!.get(x)!.edges).toBe(12);
      expect(fronts.lineSide.get(line)!.get(sideOf(sim, a))!.edges).toBe(12);
      expect(fronts.frontCount[s]).toBe(0);
      expect(fronts.lineFront.get(line)!.has(s)).toBe(false);
      expect(fronts.lineCountries.get(line)!.has(s)).toBe(supporter);
      const battle = oneBattle(sim);
      expect(battle.attStrength).toBeCloseTo(1000);
      expect(battle.attackers).toHaveLength(supporter ? 3 : 2);
      expect(battle.captures).toHaveLength(3 * config.advanceMax);
      expect(battle.captors.every((c) => c === a || c === b)).toBe(true);
      return battle.captures;
    };
    expect(run(true)).toEqual(run(false));
  });
});
