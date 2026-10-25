import { describe, expect, it } from "vitest";
import { allocateArmies, applyBattles, computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import type { SimState } from "../types";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

const rules = {
  encirclement: false,
  frontComparisonMode: "allocated",
  lowPriorityFronts: {},
  enemyPriority: {},
  regionPriority: {},
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  holdRatio: 0.5,
  holdShare: 0.5,
  transitSpeedKmPerWeek: 1e9,
  slowAdvanceLand: {},
  lossFactors: {},
  lossRate: 0,
  advanceRate: 100,
  advanceMax: 1,
} satisfies Partial<SimConfig>;

const idx = (sim: SimState, tag: string) => sim.tags.indexOf(tag);

describe("holdAgainst: fronts held first", () => {
  /**
   * G (axis) holds two lines: line 0 against U, line 2 against R. B is an axis ally with no front states.
   * Equal edges, so the first pass splits G's army equally and the final weights are the enemy armies.
   */
  function twoLines(armies: { G?: number; U: number; R: number; B?: number }, config: Partial<SimConfig> = {}) {
    const sim = createSimulation(
      makeMap({ owners: ["G", "U", "G", "R", "B"], land: [[0, 1], [2, 3]] }),
      makeScenario({
        G: { faction: "axis" }, B: { faction: "axis" }, U: { faction: "allies" }, R: { faction: "allies" },
      }),
      { seed: 41, config: { ...rules, ...config } },
    );
    sim.military.fill(0);
    for (const [tag, army] of Object.entries({ G: 100, B: 0, ...armies })) sim.military[idx(sim, tag)] = army;
    setWar(sim, "G", "U");
    setWar(sim, "G", "R");
    return sim;
  }
  const alloc = (sim: SimState) => {
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    const a = allocateArmies(sim, fronts), g = idx(sim, "G");
    return { line0: a.get(0)?.get(g) ?? 0, line2: a.get(2)?.get(g) ?? 0 };
  };
  const hold = { G: { against: ["U"], ratio: 1 } };
  /** What the last step left on line 0 (sim.frontArmies), by tag. */
  const lastStep = (sim: SimState, armies: Record<string, number>) => {
    sim.frontArmies = [{
      line: 0, lon: 0, lat: 0, states: [0, 1],
      armies: Object.entries(armies).map(([t, v]): [number, number] => [idx(sim, t), v]),
    }];
  };

  it("(a) empty holdAgainst gives the old allocation, whatever it is compared with", () => {
    const empty = alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: {} }));
    // Old behaviour: needs 0.5 × 30 and 0.5 × 10 both fit in the reserve of 50; the rest 80 goes 30:10.
    expect(empty.line0).toBeCloseTo(15 + 60, 8);
    expect(empty.line2).toBeCloseTo(5 + 20, 8);
    // Unset (the default has only GER, which is not in this fixture), an entry for an absent country,
    // and an entry that lists no enemy present all give the same allocation.
    const unset = twoLines({ U: 30, R: 10 });
    expect(unset.config.holdAgainst).toBe(DEFAULT_CONFIG.holdAgainst);
    expect(alloc(unset)).toEqual(empty);
    expect(alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: { ZZZ: { against: ["U"], ratio: 1 } } }))).toEqual(empty);
    expect(alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: { G: { against: [], ratio: 1 } } }))).toEqual(empty);
    expect(alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: { G: { against: ["ZZZ"], ratio: 1 } } }))).toEqual(empty);
    // Listing only the enemy of the other line leaves line 0 as it was too (R is held at ratio on line 2).
    const other = alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: { G: { against: ["R"], ratio: 0.5 } } }));
    expect(other).toEqual(empty);
  });

  it("(a) a listed country's allocation still sums to its whole army", () => {
    const r = alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: hold }));
    expect(r.line0 + r.line2).toBeCloseTo(100, 8);
  });

  it("(b) sets aside ratio × the listed enemy army on the listed line before the other line", () => {
    // Budget 50. Old order is smallest need first: line 2 (20) then line 0 (40) no longer fits.
    const base = { holdRatio: 1 };
    const old = alloc(twoLines({ U: 40, R: 20 }, { ...base, holdAgainst: {} }));
    expect(old.line0).toBeCloseTo(80 * 40 / 60, 8); // No hold on line 0 at all.
    expect(old.line2).toBeCloseTo(20 + 80 * 20 / 60, 8);
    // Held first: line 0 sets aside the whole 40, then line 2's 20 no longer fits and is skipped; the rest 60 by 40:20.
    const first = alloc(twoLines({ U: 40, R: 20 }, { ...base, holdAgainst: hold }));
    expect(first.line0).toBeGreaterThanOrEqual(1 * 40);
    expect(first.line0).toBeCloseTo(40 + 60 * 40 / 60, 8);
    expect(first.line2).toBeCloseTo(60 * 20 / 60, 8);
    expect(first.line0 + first.line2).toBeCloseTo(100, 8);
  });

  it("(b) a larger ratio sets aside proportionally more on the listed line", () => {
    const r = alloc(twoLines({ U: 20, R: 10 }, { holdAgainst: { G: { against: ["U"], ratio: 2 } } }));
    // Hold 2 × 20 = 40 on line 0 and 0.5 × 10 = 5 on line 2 (45 ≤ 50); the rest 55 goes 20:10.
    expect(r.line0).toBeCloseTo(40 + 55 * 20 / 30, 8);
    expect(r.line2).toBeCloseTo(5 + 55 * 10 / 30, 8);
  });

  it("(c) on a line with a listed and a non-listed enemy only the listed part is held at ratio", () => {
    // Line 0: G meets U (30, listed) and R (20, not listed). Line 3: G meets T (20, not listed).
    const sim = createSimulation(
      makeMap({ owners: ["G", "U", "R", "G", "T"], land: [[0, 1], [0, 2], [3, 4]] }),
      makeScenario({
        G: { faction: "axis" }, U: { faction: "allies" }, R: { faction: "allies" }, T: { faction: "allies" },
      }),
      { seed: 43, config: { ...rules, holdAgainst: hold } },
    );
    sim.military.fill(0);
    for (const [tag, army] of Object.entries({ G: 100, U: 30, R: 20, T: 20 })) sim.military[idx(sim, tag)] = army;
    for (const e of ["U", "R", "T"]) setWar(sim, "G", e);
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 3]);
    const a = allocateArmies(sim, fronts), g = idx(sim, "G");
    // Line 0: 1 × 30 (U) + 0.5 × 20 (R) = 40; line 3: 0.5 × 20 = 10; total 50 = the reserve.
    // Had U also been held at holdRatio the line-0 hold would be 25; had R been held at ratio, 50.
    // The rest 50 is split by edges × enemy first-pass army: 2 × 50 : 1 × 20.
    expect(a.get(0)!.get(g)).toBeCloseTo(40 + 50 * 100 / 120, 8);
    expect(a.get(3)!.get(g)).toBeCloseTo(10 + 50 * 20 / 120, 8);
    expect(a.get(0)!.get(g)! + a.get(3)!.get(g)!).toBeCloseTo(100, 8);
  });

  it("(d) is capped at holdShare × the army, taking the listed line partly", () => {
    // U = 80 would need 80, the reserve is 0.3 × 100 = 30: line 0 takes all 30, line 2's need no longer fits.
    const capped = alloc(twoLines({ U: 80, R: 10 }, { holdShare: 0.3, holdAgainst: hold }));
    expect(capped.line0).toBeCloseTo(30 + 70 * 80 / 90, 8);
    expect(capped.line2).toBeCloseTo(70 * 10 / 90, 8);
    // With holdShare 1 nothing is cut: 80 on line 0, 5 on line 2, the rest 15 by 80:10.
    const whole = alloc(twoLines({ U: 80, R: 10 }, { holdShare: 1, holdAgainst: hold }));
    expect(whole.line0).toBeCloseTo(80 + 15 * 80 / 90, 8);
    expect(whole.line2).toBeCloseTo(5 + 15 * 10 / 90, 8);
    // With holdShare 0 nothing is set aside, even for a listed enemy.
    const none = alloc(twoLines({ U: 80, R: 10 }, { holdShare: 0, holdAgainst: hold }));
    expect(none.line0).toBeCloseTo(100 * 80 / 90, 8);
    expect(none.line2).toBeCloseTo(100 * 10 / 90, 8);
  });

  it("(e) allies' army on the line last step reduces the hold", () => {
    // Without allies (nothing in frontArmies): hold 30 and 5, the rest 65 by 30:10.
    const withoutAllies = alloc(twoLines({ U: 30, R: 10 }, { holdAgainst: hold }));
    expect(withoutAllies.line0).toBeCloseTo(30 + 65 * 30 / 40, 8);
    expect(withoutAllies.line2).toBeCloseTo(5 + 65 * 10 / 40, 8);
    const sim = twoLines({ U: 30, R: 10, B: 20 }, { holdAgainst: hold });
    lastStep(sim, { U: 30, B: 20 });
    // Need 1 × 30 − 20 = 10 on line 0, 0.5 × 10 = 5 on line 2; the rest 85 by 30:10.
    const r = alloc(sim);
    expect(r.line0).toBeCloseTo(10 + 85 * 30 / 40, 8);
    expect(r.line2).toBeCloseTo(5 + 85 * 10 / 40, 8);
    // Allies who cover the whole need leave nothing to hold on line 0 (and not at holdRatio either).
    const covered = twoLines({ U: 30, R: 10, B: 50 }, { holdAgainst: hold });
    lastStep(covered, { U: 30, B: 50 });
    const c = alloc(covered);
    expect(c.line0).toBeCloseTo(95 * 30 / 40, 8);
    expect(c.line2).toBeCloseTo(5 + 95 * 10 / 40, 8);
  });

  it("(e) measures the listed enemy by the larger of the first pass and last step's army", () => {
    const sim = twoLines({ U: 30, R: 10 }, { holdAgainst: hold });
    lastStep(sim, { U: 45 });
    // Against = 45 > 30: hold 45 on line 0 and 5 on line 2 (exactly the reserve of 50); the rest 50 by 30:10.
    const r = alloc(sim);
    expect(r.line0).toBeCloseTo(45 + 50 * 30 / 40, 8);
    expect(r.line2).toBeCloseTo(5 + 50 * 10 / 40, 8);
    // A smaller army last step does not lower the first-pass measure.
    const smaller = twoLines({ U: 30, R: 10 }, { holdAgainst: hold });
    lastStep(smaller, { U: 10 });
    expect(alloc(smaller).line0).toBeCloseTo(30 + 65 * 30 / 40, 8);
  });

  it("(e) only the part of the allies facing the listed enemies is deducted", () => {
    // Last step line 0 held U 30 (listed) and R 30 (not listed): the allies' 20 count 30/60 against U.
    const sim = twoLines({ U: 30, R: 10, B: 20 }, { holdAgainst: hold });
    lastStep(sim, { U: 30, R: 30, B: 20 });
    const r = alloc(sim);
    // R is not adjacent to line 0 on the map, but it is in last step's army there: need = 30 − 20 × 30/60 = 20.
    expect(r.line0).toBeCloseTo(20 + 75 * 30 / 40, 8);
    expect(r.line2).toBeCloseTo(5 + 75 * 10 / 40, 8);
  });

  it("(f) the default config holds Germany at ratio 1 against the western Allies", () => {
    const ger = DEFAULT_CONFIG.holdAgainst.GER;
    expect(ger).toBeDefined();
    expect(ger.against).toContain("UK");
    expect(ger.against).toContain("USA");
    expect(ger.ratio).toBe(1);
  });
});

describe("landingStrength: landing comparison only", () => {
  const config = {
    encirclement: false,
    lossFactors: {},
    lowPriorityFronts: {},
    slowAdvanceLand: {},
    capitulateOnCapitalLoss: [],
    capitulateOnContinentLoss: [],
    regionPriority: {},
    landingWithoutNavy: {},
    landingBans: [],
    transitSpeedKmPerWeek: 1e9,
    holdShare: 0,
    indirectFrontPriority: 1,
    overseasDistanceFactor: 1,
    frontComparisonMode: "allocated",
    advanceRate: 100,
    advanceMax: 1,
    advanceBreadthEdges: 1e9,
    navalPenalty: 0.5,
    lossRate: 0.1,
    startDate: "1944-06-05",
    landingStrength: {},
  } satisfies Partial<SimConfig>;

  /** A attacks X by sea (one target, state 1): the landing ratio is navalPenalty × army / 10. */
  function landing(army: number, landingStrength: SimConfig["landingStrength"] = {}, startDate = config.startDate) {
    const sim = createSimulation(
      makeMap({ owners: ["A", "X"], land: [], sea: [[0, 1]] }),
      makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } }),
      { seed: 7, config: { ...config, landingStrength, startDate } },
    );
    sim.military[idx(sim, "A")] = army;
    sim.military[idx(sim, "X")] = 10;
    sim.fleets.push({ country: idx(sim, "A"), zone: 0, strength: 100, target: 0 });
    setWar(sim, "A", "X");
    return sim;
  }
  const fight = (sim: SimState) => resolveCombat(sim, computeFronts(sim));

  it("fixture: a landing at 19 against 10 stays just below the threshold (0.5 × 19 / 10 = 0.95)", () => {
    expect(fight(landing(19))).toEqual([]);
    const above = fight(landing(21));
    expect(above).toHaveLength(1);
    expect(above[0].captures).toEqual([1]);
  });

  it("a large enough factor makes the landing happen and capture by sea", () => {
    const [battle] = fight(landing(19, { A: 3 }));
    expect(battle).toBeDefined();
    expect(battle.captures).toEqual([1]);
    expect(battle.captors).toEqual([idx(landing(19), "A")]);
    expect(battle.capturedFrom).toEqual([idx(landing(19), "X")]);
    // The land-battle strength is not multiplied.
    expect(battle.attStrength).toBe(19);
    expect(battle.defStrength).toBe(10);
  });

  it("flips exactly where navalPenalty × army × factor / defender passes 1", () => {
    expect(fight(landing(19, { A: 1.05 }))).toEqual([]); // 0.9975
    expect(fight(landing(19, { A: 1.06 }))).toHaveLength(1); // 1.007
    expect(fight(landing(19, { A: 0.99 }))).toEqual([]);
    // A factor below 1 stops a landing that would otherwise happen.
    expect(fight(landing(30))).toHaveLength(1);
    expect(fight(landing(30, { A: 0.5 }))).toEqual([]);
    expect(fight(landing(30, { A: 0 }))).toEqual([]);
  });

  it("factor 1 is identical to no entry, below and above the threshold", () => {
    for (const army of [19, 30]) {
      const none = landing(army), one = landing(army, { A: 1 });
      const a = fight(none), b = fight(one);
      expect(b).toEqual(a);
      applyBattles(none, a);
      applyBattles(one, b);
      expect(one.owner).toEqual(none.owner);
      expect(one.military).toEqual(none.military);
      expect(one.losses).toEqual(none.losses);
      expect(one.rng.state).toBe(none.rng.state);
    }
    expect(fight(landing(19, { A: [["1944-06-05", 1], ["1944-06-06", 1]] }))).toEqual([]);
  });

  it("an entry for another country does not matter", () => {
    expect(fight(landing(19, { X: 5, ZZZ: 5 }))).toEqual([]);
  });

  it("a schedule has no effect before its date and takes effect from it", () => {
    const schedule: SimConfig["landingStrength"] = { A: [["1944-06-05", 1], ["1944-06-06", 3]] };
    // startDate 1944-06-05 (tick 0): factor 1, no landing.
    expect(fight(landing(19, schedule))).toEqual([]);
    // From the second date on the factor is 3 (also after it, the last value stays).
    expect(fight(landing(19, schedule, "1944-06-06"))).toHaveLength(1);
    const much = landing(19, schedule);
    much.tick = 10;
    expect(fight(much)).toHaveLength(1);
  });

  it("a schedule is interpolated between its dates", () => {
    // Weekly steps from 1944-06-05: tick 1 is half way to 1944-06-19, so the factor is 2 (landing at 15: 0.5 × 15 × 2 / 10).
    const schedule: SimConfig["landingStrength"] = { A: [["1944-06-05", 1], ["1944-06-19", 3]] };
    const sim = landing(15, schedule);
    expect(fight(sim)).toEqual([]); // Tick 0: factor 1, ratio 0.75.
    sim.tick = 1;
    expect(fight(sim)).toHaveLength(1);
    // At the same factor 2 a smaller army stays below the threshold: 0.5 × 9 × 2 / 10 = 0.9.
    const small = landing(9, schedule);
    small.tick = 1;
    expect(fight(small)).toEqual([]);
  });

  it("a factor above 1 gives the same result as the same landing with a bigger army", () => {
    const big = fight(landing(19 * 1.5)); // Same landing ratio: 0.5 × 28.5 / 10 = 1.425.
    const strong = fight(landing(19, { A: 1.5 }));
    expect(strong).toHaveLength(1);
    expect(big).toHaveLength(1);
    expect(strong[0].captures).toEqual(big[0].captures);
  });

  it("land-only battles are unaffected, in captures, losses and the random stream", () => {
    const land = (landingStrength: SimConfig["landingStrength"]) => {
      const sim = createSimulation(
        makeMap({ owners: ["A", "X", "X"], land: [[0, 1], [0, 2]] }),
        makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } }),
        { seed: 11, config: { ...config, advanceRate: 2, advanceMax: 2, landingStrength } },
      );
      sim.military[idx(sim, "A")] = 15;
      sim.military[idx(sim, "X")] = 10;
      setWar(sim, "A", "X");
      return sim;
    };
    for (const factor of [3, 0, 0.1]) {
      const plain = land({}), with_ = land({ A: factor });
      const a = fight(plain), b = fight(with_);
      expect(a).toHaveLength(1);
      expect(a[0].captures.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
      applyBattles(plain, a);
      applyBattles(with_, b);
      expect(with_.owner).toEqual(plain.owner);
      expect(with_.military).toEqual(plain.military);
      expect(with_.losses).toEqual(plain.losses);
      expect(with_.rng.state).toBe(plain.rng.state);
    }
  });

  it("on a line with land and sea targets only the sea attack depends on the factor", () => {
    // A (18) against X (10): a land attack at 1.8 always captures state 1; the landing on state 2 needs a factor.
    const mixed = (landingStrength: SimConfig["landingStrength"]) => {
      const sim = createSimulation(
        makeMap({ owners: ["A", "X", "X"], land: [[0, 1]], sea: [[0, 2]] }),
        makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } }),
        { seed: 13, config: { ...config, landingStrength } },
      );
      sim.military[idx(sim, "A")] = 18;
      sim.military[idx(sim, "X")] = 10;
      sim.fleets.push({ country: idx(sim, "A"), zone: 0, strength: 100, target: 0 });
      setWar(sim, "A", "X");
      return sim;
    };
    const without = fight(mixed({})), withF = fight(mixed({ A: 3 }));
    expect(without).toHaveLength(1);
    expect(without[0].captures).toEqual([1]);
    expect(withF).toHaveLength(1);
    expect([...withF[0].captures].sort()).toEqual([1, 2]);
    // The battle itself (strengths, shares, losses) is the same.
    for (const key of ["attStrength", "defStrength", "loss", "attLossFactor", "attShare", "defShare", "attackers", "defenders"] as const) {
      expect(withF[0][key]).toEqual(without[0][key]);
    }
  });

  it("sums the factor-weighted strength of all attackers on the landing", () => {
    // A (10) and B (9) both land on X (10): ratio 0.5 × (10 f + 9) / 10 is 0.95 for f = 1 and 1.95 for f = 3.
    const duo = (landingStrength: SimConfig["landingStrength"]) => {
      const sim = createSimulation(
        makeMap({ owners: ["A", "B", "X"], land: [], sea: [[0, 2], [1, 2]] }),
        makeScenario({ A: { faction: "allies" }, B: { faction: "allies" }, X: { faction: "axis" } }),
        { seed: 17, config: { ...config, landingStrength } },
      );
      for (const [tag, army] of Object.entries({ A: 10, B: 9, X: 10 })) sim.military[idx(sim, tag)] = army;
      for (const tag of ["A", "B"]) {
        sim.fleets.push({ country: idx(sim, tag), zone: 0, strength: 100, target: 0 });
        setWar(sim, tag, "X");
      }
      return sim;
    };
    expect(fight(duo({}))).toEqual([]);
    expect(fight(duo({ B: 1 }))).toEqual([]);
    const boosted = fight(duo({ A: 3 }));
    expect(boosted).toHaveLength(1);
    expect(boosted[0].captures).toEqual([2]);
    // B's factor counts too: 0.5 × (10 + 9 × 3) / 10 = 1.85.
    expect(fight(duo({ B: 3 }))).toHaveLength(1);
  });

  it("default: the western Allies land at full strength on 1944-06-05 and at triple from 1944-06-06", () => {
    const f = DEFAULT_CONFIG.landingStrength;
    for (const tag of ["USA", "UK", "CAN", "FFR"]) {
      expect(f[tag]).toEqual([["1944-06-05", 1], ["1944-06-06", 3]]);
    }
    expect(Object.keys(f).sort()).toEqual(["CAN", "FFR", "UK", "USA"]);
  });
});
