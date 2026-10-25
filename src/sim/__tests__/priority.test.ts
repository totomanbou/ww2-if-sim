import { describe, expect, it } from "vitest";
import { capitulate, checkCapitulations, lostShare } from "../capitulation";
import { allocateArmies, applyBattles, computeFronts, resolveCombat, revive, setOwner } from "../combat";
import type { SimConfig } from "../config";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import type { Faction } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

// Every fixture explicitly disables unrelated tag-based defaults.
const rules = {
  encirclement: false,
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

function allocationFixture(
  lowPriorityFronts: Record<string, number>,
  mode: SimConfig["frontComparisonMode"] = "allocated",
  firstHolder = "U",
  mixed = false,
) {
  // State 4 links the allies without being a front state, keeping lines 0 and 2 separate.
  // Each line has two enemy edges; the mixed line has one edge each from L and U.
  const result = createSimulation(
    makeMap({
      owners: [firstHolder, "X", "L", "Y", "A", mixed ? "U" : "L", "X", "X"],
      land: [[0, 1], [0, 6], [2, 3], [5, 3], [4, 0], [4, 2]],
      sea: [[4, 5]],
      // An isolated Axis capital keeps step() running after the active fronts are captured.
      capitals: { X: 7 },
      cities: { London: 4, Moscow: 4, Honolulu: 4, Paris: 4, Rome: 7, Berlin: 7, Tokyo: 7 },
    }),
    makeScenario({
      A: { faction: "allies" }, L: { faction: "allies" }, U: { faction: "allies" },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    { seed: 17, config: { ...rules, lowPriorityFronts, frontComparisonMode: mode } },
  );
  for (const tag of result.tags) {
    result.military[result.tags.indexOf(tag)] = tag === "A" ? 100 : 40;
  }
  for (const ally of ["A", "L", "U"]) {
    if (!result.tags.includes(ally)) continue;
    for (const enemy of ["X", "Y"]) setWar(result, ally, enemy);
  }
  return result;
}

describe("low-priority front allocation", () => {
  it.each(["A", "U"])("reduces A's support for L relative to a line held by %s", (holder) => {
    const sim = allocationFixture({ L: 0.25 }, "allocated", holder);
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    expect(fronts.lineSide.get(0)!.get(-2)!.edges).toBe(2);
    expect(fronts.lineSide.get(2)!.get(-2)!.edges).toBe(2);
    const allocation = allocateArmies(sim, fronts);
    const normal = allocation.get(0)!.get(a)!;
    const low = allocation.get(2)!.get(a)!;
    expect(low).toBeLessThan(normal);
    expect(low / normal).toBeCloseTo(0.25, 8);
    expect(normal).toBeCloseTo(80, 8);
    expect(low).toBeCloseTo(20, 8);

    const baseline = allocationFixture({}, "allocated", holder);
    const split = allocateArmies(baseline, computeFronts(baseline));
    expect(split.get(0)!.get(a)).toBeCloseTo(50, 8);
    expect(split.get(2)!.get(a)).toBeCloseTo(50, 8);
  });

  it("does not reduce L's allocation on its own front", () => {
    const sim = allocationFixture({ L: 0.25 });
    const baseline = allocationFixture({});
    const l = sim.tags.indexOf("L");
    const allocation = allocateArmies(sim, computeFronts(sim));
    const split = allocateArmies(baseline, computeFronts(baseline));
    for (const line of [0, 2]) {
      expect(allocation.get(line)!.get(l)).toBeCloseTo(split.get(line)!.get(l)!, 8);
      expect(allocation.get(line)!.get(l)).toBeCloseTo(20, 8);
    }
  });

  it("uses the edge-weighted intermediate priority on a mixed line", () => {
    const sim = allocationFixture({ L: 0.25 }, "allocated", "U", true);
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect(fronts.lineFront.get(2)!.get(sim.tags.indexOf("L"))!.edges).toBe(1);
    expect(fronts.lineFront.get(2)!.get(sim.tags.indexOf("U"))!.edges).toBe(1);
    const allocation = allocateArmies(sim, fronts);
    const factor = 0.5 * 1 + 0.5 * 0.25;
    expect(allocation.get(2)!.get(a)! / allocation.get(0)!.get(a)!).toBeCloseTo(factor, 8);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(100 * factor / (1 + factor), 8);
  });

  it.each(["nation", "divided"] as const)("%s ignores lowPriorityFronts", (mode) => {
    const sim = allocationFixture({ L: 0.25 }, mode);
    const baseline = allocationFixture({}, mode);
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    const split = allocateArmies(baseline, computeFronts(baseline));
    for (const [line, countries] of fronts.lineCountries) {
      for (const c of countries) {
        const expected = mode === "nation" ? sim.military[c] : sim.military[c] / Math.max(1, fronts.frontCount[c]);
        expect(allocation.get(line)!.get(c)).toBeCloseTo(expected, 8);
        expect(allocation.get(line)!.get(c)).toBeCloseTo(split.get(line)!.get(c)!, 8);
      }
    }
  });
});

const advanceMax = 4;

function advanceFixture(
  slowAdvanceLand: Record<string, number>,
  seed: number,
  attackerFaction: Faction = "allies",
  sea = false,
) {
  const edges: [number, number][] = [[0, 1], [0, 2], [0, 3], [0, 4], [5, 6], [5, 7], [5, 8], [5, 9]];
  const sim = createSimulation(
    makeMap({
      owners: ["A", "L", "L", "L", "L", "A", "U", "U", "U", "U"],
      land: sea ? [] : edges,
      sea: sea ? edges : [],
    }),
    makeScenario({
      A: { faction: attackerFaction },
      L: { faction: attackerFaction === "allies" ? "axis" : "allies" },
      U: { faction: attackerFaction === "allies" ? "axis" : "allies" },
    }),
    {
      seed,
      config: {
        ...rules, slowAdvanceLand, frontComparisonMode: "allocated",
        advanceMax, advanceRate: 1, lossRate: 0, fleetBattleChance: 0,
      },
    },
  );
  const a = sim.tags.indexOf("A");
  sim.military.fill(1);
  sim.military[a] = 1e6;
  setWar(sim, "A", "L");
  setWar(sim, "A", "U");
  if (sea) sim.fleets = [{ country: a, zone: 0, target: 0, strength: 100 }];
  return sim;
}

function firstWeekCaptures(sim: ReturnType<typeof advanceFixture>) {
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(2);
  expect(battles.every((battle) => battle.attacker === sim.tags.indexOf("A"))).toBe(true);
  applyBattles(sim, battles);
  return {
    listed: [1, 2, 3, 4].filter((s) => sim.owner[s] === sim.tags.indexOf("A")).length,
    unlisted: [6, 7, 8, 9].filter((s) => sim.owner[s] === sim.tags.indexOf("A")).length,
  };
}

describe("slow advance on original territory", () => {
  it.each([
    { faction: "allies" as const, sea: false },
    { faction: "axis" as const, sea: false },
    { faction: "allies" as const, sea: true },
    { faction: "axis" as const, sea: true },
  ])("scales first-week captures for $faction, sea = $sea", ({ faction, sea }) => {
    const runs = 256;
    const factor = 0.5;
    let listed = 0, unlisted = 0;
    for (let seed = 1; seed <= runs; seed++) {
      const counts = firstWeekCaptures(advanceFixture({ L: factor }, seed, faction, sea));
      expect(counts.unlisted).toBe(advanceMax);
      listed += counts.listed;
      unlisted += counts.unlisted;
    }
    // 1024 Bernoulli trials: tolerance 0.05 is over three standard deviations.
    expect(Math.abs(listed / unlisted - factor)).toBeLessThan(0.05);
    expect(listed / runs).toBeCloseTo(factor * unlisted / runs, 0);
  });

  it.each([
    { faction: "allies" as const, sea: false },
    { faction: "axis" as const, sea: false },
    { faction: "allies" as const, sea: true },
    { faction: "axis" as const, sea: true },
  ])("factor 1 matches no entry for $faction, sea = $sea", ({ faction, sea }) => {
    for (let seed = 1; seed <= 16; seed++) {
      const normal = advanceFixture({}, seed, faction, sea);
      const unchanged = advanceFixture({ L: 1 }, seed, faction, sea);
      expect(firstWeekCaptures(normal)).toEqual({ listed: advanceMax, unlisted: advanceMax });
      expect(firstWeekCaptures(unchanged)).toEqual({ listed: advanceMax, unlisted: advanceMax });
      expect(unchanged.owner).toEqual(normal.owner);
      expect(unchanged.rng).toEqual(normal.rng);
    }
  });

  it.each([
    { faction: "allies" as const, sea: false },
    { faction: "axis" as const, sea: false },
    { faction: "allies" as const, sea: true },
    { faction: "axis" as const, sea: true },
  ])("factor 0 blocks listed soil for $faction, sea = $sea", ({ faction, sea }) => {
    for (let seed = 1; seed <= 16; seed++) {
      expect(firstWeekCaptures(advanceFixture({ L: 0 }, seed, faction, sea)))
        .toEqual({ listed: 0, unlisted: advanceMax });
    }
  });

  it.each<{ slow: Record<string, number>; expected: { listed: number; unlisted: number } }>([
    { slow: { L: 0 }, expected: { listed: 0, unlisted: advanceMax } },
    { slow: { U: 0 }, expected: { listed: advanceMax, unlisted: 0 } },
  ])("uses original ownership after occupation with $slow", ({ slow, expected }) => {
    const sim = advanceFixture(slow, 31);
    const u = sim.tags.indexOf("U");
    for (const s of [1, 2, 3, 4]) setOwner(sim, s, u);
    expect(firstWeekCaptures(sim)).toEqual(expected);
  });
});

function capitalFixture() {
  const sim = createSimulation(
    makeMap({
      owners: [...Array<string>(10).fill("L"), ...Array<string>(10).fill("U"), "X", "A"],
      land: [],
    }),
    makeScenario({
      L: { faction: "allies" }, U: { faction: "allies" },
      X: { faction: "axis" }, A: { faction: "allies" },
    }),
    { seed: 41, config: { ...rules, capitulateOnCapitalLoss: ["L"], capitulationThreshold: 0.6, capitulationStabilitySlope: 0 } },
  );
  for (const ally of ["L", "U", "A"]) setWar(sim, ally, "X");
  return sim;
}

describe("capitulation on capital loss", () => {
  it("capitulates the listed country below the threshold while an unlisted country survives", () => {
    const sim = capitalFixture();
    const l = sim.tags.indexOf("L"), u = sim.tags.indexOf("U"), x = sim.tags.indexOf("X");
    setOwner(sim, sim.capital[l], x);
    setOwner(sim, sim.capital[u], x);
    expect(lostShare(sim, l)).toBeCloseTo(0.1, 8);
    expect(lostShare(sim, u)).toBeCloseTo(0.1, 8);
    expect(lostShare(sim, l)).toBeLessThan(sim.config.capitulationThreshold);
    expect(checkCapitulations(sim)).toEqual([[l, x]]);
    expect(sim.capitulated[l]).toBe(1);
    expect(sim.capitulated[u]).toBe(0);
    expect(Array.from(sim.owner).slice(0, 10)).toEqual(Array<number>(10).fill(x));

    // Unlisted countries still capitulate once both conditions are met.
    for (let s = 10; s < 16; s++) setOwner(sim, s, x);
    expect(lostShare(sim, u)).toBeCloseTo(0.6, 8);
    expect(checkCapitulations(sim)).toEqual([[u, x]]);
  });

  it("still requires capital loss even above the threshold", () => {
    const sim = capitalFixture();
    const l = sim.tags.indexOf("L"), u = sim.tags.indexOf("U"), x = sim.tags.indexOf("X");
    for (let s = 1; s < 10; s++) setOwner(sim, s, x);
    for (let s = 11; s < 20; s++) setOwner(sim, s, x);
    expect(lostShare(sim, l)).toBeCloseTo(0.9, 8);
    expect(lostShare(sim, u)).toBeCloseTo(0.9, 8);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[l]).toBe(0);
    expect(sim.capitulated[u]).toBe(0);
  });

  it("protects a listed revived country until it has recovered its capital", () => {
    const sim = capitalFixture();
    const l = sim.tags.indexOf("L"), x = sim.tags.indexOf("X"), a = sim.tags.indexOf("A");
    capitulate(sim, l, x);
    revive(sim, l, a);
    setOwner(sim, 1, l);
    expect(sim.owner[sim.capital[l]]).toBe(x);
    expect(lostShare(sim, l)).toBeCloseTo(0.9, 8);
    expect(sim.revivedAwaitingCapital[l]).toBe(1);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[l]).toBe(0);

    setOwner(sim, sim.capital[l], l);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.revivedAwaitingCapital[l]).toBe(0);
    setOwner(sim, sim.capital[l], x);
    expect(checkCapitulations(sim)).toEqual([[l, x]]);
  });
});

describe("step determinism with the new rules", () => {
  it("produces the same owner array at every step for the same seed", () => {
    const run = () => {
      const sim = allocationFixture({ L: 0.25 });
      sim.config.slowAdvanceLand = { X: 0.5, Y: 0.5 };
      sim.config.capitulateOnCapitalLoss = ["Y"];
      sim.config.advanceMax = 1;
      sim.config.advanceRate = 1;
      sim.config.lossRate = 0;
      sim.config.fleetBattleChance = 0;
      sim.military[sim.tags.indexOf("A")] = 1e6;
      return sim;
    };
    const a = run(), b = run();
    const initial = a.owner.slice();
    for (let week = 0; week < 8; week++) {
      step(a);
      step(b);
      expect(a.owner).toEqual(b.owner);
      expect(a.capitulated).toEqual(b.capitulated);
      expect(a.rng).toEqual(b.rng);
    }
    expect(a.owner).not.toEqual(initial);
    expect(a.tick).toBe(8);
    expect(a.capitulated[a.tags.indexOf("Y")]).toBe(1);
  });
});

describe("land of a country (landOf)", () => {
  it("counts states the map took from a country before the start as its land", () => {
    const map = makeMap({ owners: ["A", "A", "L"], land: [[0, 1], [1, 2]] });
    (map.states[1] as { formerOwner?: string }).formerOwner = "L";
    const sim = createSimulation(map, makeScenario({ A: { faction: "axis" }, L: { faction: "allies" } }), { seed: 1, config: rules });
    const [a, l] = [sim.tags.indexOf("A"), sim.tags.indexOf("L")];
    expect([...sim.landOf]).toEqual([a, l, l]);
    expect([...sim.origOwner]).toEqual([a, a, l]);
  });
});
