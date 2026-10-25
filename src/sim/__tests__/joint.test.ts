import { describe, expect, it } from "vitest";
import { allocateArmies, applyBattles, computeFronts, resolveCombat, setOwner } from "../combat";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { blockedLandings } from "../navy";
import { makeMap, makeScenario, setWar } from "./helpers";

const config = { encirclement: false, holdShare: 0, lossRate: 0.1, advanceRate: 1, advanceMax: 1 };

function joint(a1 = 20, a2 = 20, x = 30) {
  const sim = createSimulation(
    makeMap({ owners: ["A1", "A2", "X"], land: [[0, 2], [1, 2]] }),
    makeScenario({
      A1: { faction: "allies" }, A2: { faction: "allies" }, X: { faction: "axis" },
    }),
    { config },
  );
  sim.military.set([a1, a2, x]);
  setWar(sim, "A1", "X");
  setWar(sim, "A2", "X");
  return sim;
}

describe("joint front line combat", () => {
  it("combines allies that are each weaker than their common enemy", () => {
    const sim = joint();
    const [a1, a2, x] = ["A1", "A2", "X"].map((tag) => sim.tags.indexOf(tag));
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0]).toMatchObject({
      line: 0, attackers: [a1, a2], defenders: [x], attStrength: 40, defStrength: 30,
    });
    const loss = sim.config.lossRate * 30;
    expect(battles[0].loss).toBeCloseTo(loss);
    expect(battles[0].attShare).toEqual([0.5, 0.5]);
    applyBattles(sim, battles);
    expect(30 - sim.military[x]).toBeCloseTo(loss);
    expect(20 - sim.military[a1]).toBeCloseTo(2 * loss * 0.5);
    expect(20 - sim.military[a2]).toBeCloseTo(2 * loss * 0.5);
  });

  it("keeps disconnected allied fronts as two pairwise battles", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A1", "X", "A2", "Y"], land: [[0, 1], [2, 3]] }),
      makeScenario({
        A1: { faction: "allies" }, A2: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { config },
    );
    sim.military.set([20, 20, 30, 10]);
    setWar(sim, "A1", "X");
    setWar(sim, "A2", "Y");
    const [a1, a2, x, y] = ["A1", "A2", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
    const fronts = computeFronts(sim);
    expect(Array.from(fronts.line)).toEqual([0, 0, 2, 2]);
    const battles = resolveCombat(sim, fronts);
    expect(battles).toHaveLength(2);
    expect(battles).toMatchObject([
      { line: 0, attackers: [x], defenders: [a1], attStrength: 30, defStrength: 20 },
      { line: 2, attackers: [a2], defenders: [y], attStrength: 20, defStrength: 10 },
    ]);
    applyBattles(sim, battles);
    expect(30 - sim.military[x]).toBeCloseTo(2 * config.lossRate * 20);
    expect(20 - sim.military[a1]).toBeCloseTo(config.lossRate * 20);
    expect(20 - sim.military[a2]).toBeCloseTo(2 * config.lossRate * 10);
    expect(10 - sim.military[y]).toBeCloseTo(config.lossRate * 10);
  });

  it("keeps fronts separate across friendly land borders and sea routes", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["A1", "X", "A2", "Y", "A1", "X", "A1"],
        land: [[0, 1], [2, 3], [0, 2], [0, 6]], sea: [[4, 5], [0, 4]],
      }),
      makeScenario({
        A1: { faction: "allies" }, A2: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
    );
    setWar(sim, "A1", "X");
    setWar(sim, "A2", "Y");
    const fronts = computeFronts(sim);
    // Friendly adjacency links supporters, but only shared front states join lines.
    expect(Array.from(fronts.line)).toEqual([0, 0, 2, 2, 4, 4, -1]);
    expect(fronts.lineCountries.size).toBe(3);
    expect(fronts.lineCountries.get(0)).toEqual(new Set([
      sim.tags.indexOf("A1"), sim.tags.indexOf("X"),
    ]));
    expect(fronts.lineCountries.get(2)).toEqual(new Set([
      sim.tags.indexOf("A2"), sim.tags.indexOf("Y"),
    ]));
    expect(fronts.lineCountries.get(4)).toEqual(new Set([
      sim.tags.indexOf("A1"), sim.tags.indexOf("X"),
    ]));
  });

  it.each([
    { name: "enemy", owners: ["A", "X", "B"], wars: [["A", "X"], ["B", "X"]] },
    { name: "attacker", owners: ["X", "A", "Y"], wars: [["A", "X"], ["A", "Y"]] },
  ])("joins a chain of front edges through a shared $name state", ({ owners, wars }) => {
    const sim = createSimulation(
      makeMap({ owners, land: [[0, 1], [1, 2]] }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { config },
    );
    for (const [a, b] of wars) setWar(sim, a, b);
    const fronts = computeFronts(sim);
    // The two outer states need no border: both front edges contain state 1.
    expect(Array.from(fronts.line)).toEqual([0, 0, 0]);
    expect(fronts.lineCountries.size).toBe(1);
    // Countries of the scenario without territory on this map (appended to sim.tags) are not on any line.
    expect(fronts.lineCountries.get(0)).toEqual(new Set(sim.tags.map((_, i) => i).filter((i) => sim.origCount[i] > 0)));
  });

  it("allocates separate fronts against one country until a capture creates a shared state", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A1", "X", "X", "A2"], land: [[0, 1], [1, 2], [2, 3]] }),
      makeScenario({
        A1: { faction: "allies" }, A2: { faction: "allies" }, X: { faction: "axis" },
      }),
      { seed: 42, config: { ...config, frontComparisonMode: "allocated" } },
    );
    const [a1, a2, x] = ["A1", "A2", "X"].map((tag) => sim.tags.indexOf(tag));
    sim.military[a1] = 60;
    sim.military[a2] = 30;
    sim.military[x] = 40;
    setWar(sim, "A1", "X");
    setWar(sim, "A2", "X");
    const fronts = computeFronts(sim);
    expect(Array.from(fronts.line)).toEqual([0, 0, 2, 2]);
    expect(fronts.lineCountries.get(0)).toEqual(new Set([a1, x]));
    expect(fronts.lineCountries.get(2)).toEqual(new Set([a2, x]));
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.size).toBe(2);
    expect(allocation.get(0)!.get(a1)).toBeCloseTo(60);
    expect(allocation.get(0)!.has(a2)).toBe(false);
    expect(allocation.get(2)!.get(a2)).toBeCloseTo(30);
    expect(allocation.get(2)!.has(a1)).toBe(false);
    // The defender splits its army in proportion to the two attackers' strengths.
    expect(allocation.get(0)!.get(x)).toBeCloseTo(40 * 60 / 90);
    expect(allocation.get(2)!.get(x)).toBeCloseTo(40 * 30 / 90);

    // Apply just A1's capture to inspect the instant its new front shares state 2 with A2.
    const battle = resolveCombat(sim, fronts).find((b) => b.line === 0)!;
    expect(battle.captures).toEqual([1]);
    expect(battle.captors).toEqual([a1]);
    applyBattles(sim, [battle]);
    expect(sim.owner[1]).toBe(a1);
    const joined = computeFronts(sim);
    expect(Array.from(joined.line)).toEqual([-1, 1, 1, 1]);
    expect(joined.lineCountries.size).toBe(1);
    expect(joined.lineCountries.get(1)).toEqual(new Set([a1, a2, x]));
    const combined = allocateArmies(sim, joined);
    expect(combined.size).toBe(1);
    for (const c of [a1, a2, x]) {
      expect(combined.get(1)!.get(c)).toBeCloseTo(sim.military[c]);
    }
  });

  it.each([
    { name: "more adjacent states, even with a weaker army", majority: true, captor: "A1" },
    { name: "the stronger army when adjacency is tied", majority: false, captor: "A2" },
  ])("gives the target to $name", ({ majority, captor }) => {
    const land: [number, number][] = [[0, 3], [2, 3]];
    if (majority) {
      land.push([1, 3]);
      // A2 also holds seven protected edges elsewhere on this joint line.
      // Pressure is then 20 / 2 = 80 / 8 = 10, so adjacency still breaks the tie.
      for (let s = 4; s < 11; s++) land.push([2, s]);
    }
    const sim = createSimulation(
      makeMap({ owners: ["A1", "A1", "A2", "X", ...Array<string>(majority ? 7 : 0).fill("X")], land }),
      makeScenario({
        A1: { faction: "allies" }, A2: { faction: "allies" }, X: { faction: "axis" },
      }, [], majority ? [4, 5, 6, 7, 8, 9, 10] : []),
      { config },
    );
    // Without the extra edges, equal adjacency gives pressures 20 and 80.
    sim.military.set([20, 80, 10]);
    setWar(sim, "A1", "X");
    setWar(sim, "A2", "X");
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0].attackers).toEqual([sim.tags.indexOf("A2"), sim.tags.indexOf("A1")]);
    expect(battles[0].captures).toEqual([3]);
    expect(battles[0].captors).toEqual([sim.tags.indexOf(captor)]);
    applyBattles(sim, battles);
    expect(sim.owner[3]).toBe(sim.tags.indexOf(captor));
  });

  it.each([true, false])("respects liberation in a joint battle when enabled = %s", (liberate) => {
    const sim = createSimulation(
      makeMap({ owners: ["A1", "A2", "A2", "X"], land: [[0, 2], [1, 2]] }),
      makeScenario({
        A1: { faction: "allies" }, A2: { faction: "allies" }, X: { faction: "axis" },
      }),
      { config: { ...config, liberateToOriginalOwner: liberate } },
    );
    const [a1, a2, x] = ["A1", "A2", "X"].map((tag) => sim.tags.indexOf(tag));
    setOwner(sim, 2, x);
    sim.military.set([60, 40, 10]);
    setWar(sim, "A1", "X");
    setWar(sim, "A2", "X");
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0]).toMatchObject({
      attackers: [a1, a2], captures: [2], captors: [a1], capturedFrom: [x],
    });
    applyBattles(sim, battles);
    expect(sim.origOwner[2]).toBe(a2);
    expect(sim.owner[2]).toBe(liberate ? a2 : a1);
  });

  it("shares defending losses in proportion to each country's strength", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "X1", "X2"], land: [[0, 1], [0, 2]] }),
      makeScenario({
        A: { faction: "allies" }, X1: { faction: "axis" }, X2: { faction: "axis" },
      }),
      { config },
    );
    sim.military.set([100, 30, 10]);
    setWar(sim, "A", "X1");
    setWar(sim, "A", "X2");
    const [a, x1, x2] = ["A", "X1", "X2"].map((tag) => sim.tags.indexOf(tag));
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0]).toMatchObject({
      attackers: [a], defenders: [x1, x2], attStrength: 100, defStrength: 40,
    });
    const loss = sim.config.lossRate * 40;
    expect(battles[0].loss).toBeCloseTo(loss);
    expect(battles[0].defShare).toEqual([0.75, 0.25]);
    applyBattles(sim, battles);
    expect(30 - sim.military[x1]).toBeCloseTo(0.75 * loss);
    expect(10 - sim.military[x2]).toBeCloseTo(0.25 * loss);
    expect(100 - sim.military[a]).toBeCloseTo(2 * loss);
  });

  it.each(["nation", "divided"] as const)("sums joint strengths using %s comparison", (mode) => {
    const sim = createSimulation(
      makeMap({ owners: ["A1", "A1", "A2", "X"], land: [[0, 3], [1, 3], [2, 3]] }),
      makeScenario({
        A1: { faction: "allies" }, A2: { faction: "allies" }, X: { faction: "axis" },
      }),
      { config: { ...config, frontComparisonMode: mode } },
    );
    sim.military.set([30, 30, 90]);
    setWar(sim, "A1", "X");
    setWar(sim, "A2", "X");
    const [a1, a2, x] = ["A1", "A2", "X"].map((tag) => sim.tags.indexOf(tag));
    const fronts = computeFronts(sim);
    expect(Array.from(fronts.frontCount)).toEqual([2, 1, 3]);
    const battles = resolveCombat(sim, fronts);
    expect(battles).toHaveLength(1);
    expect(battles[0]).toMatchObject(mode === "nation"
      ? { attackers: [x], defenders: [a1, a2], attStrength: 90, defStrength: 60 }
      : { attackers: [a2, a1], defenders: [x], attStrength: 45, defStrength: 30 });
    const loss = config.lossRate * (mode === "nation" ? 60 : 30);
    expect(battles[0].loss).toBeCloseTo(loss);
    applyBattles(sim, battles);
    expect(30 - sim.military[a1]).toBeCloseTo(mode === "nation" ? loss * 0.5 : 2 * loss / 3);
    expect(30 - sim.military[a2]).toBeCloseTo(mode === "nation" ? loss * 0.5 : 2 * loss * 2 / 3);
    expect(90 - sim.military[x]).toBeCloseTo(mode === "nation" ? 2 * loss : loss);
  });

  it("keeps a warring neutral country separate from the allied side", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "N", "X"], land: [[0, 2], [1, 2]] }),
      makeScenario({ A: { faction: "allies" }, N: { faction: "neutral" }, X: { faction: "axis" } }),
      { config },
    );
    sim.military.set([20, 20, 30]);
    setWar(sim, "A", "X");
    setWar(sim, "N", "X");
    const [a, n, x] = ["A", "N", "X"].map((tag) => sim.tags.indexOf(tag));
    const fronts = computeFronts(sim);
    expect(Array.from(fronts.line)).toEqual([0, 0, 0]);
    const battles = resolveCombat(sim, fronts);
    expect(battles).toHaveLength(2);
    expect(battles).toMatchObject([
      { line: 0, attackers: [x], defenders: [a], attStrength: 30, defStrength: 20 },
      { line: 0, attackers: [x], defenders: [n], attStrength: 30, defStrength: 20 },
    ]);
  });

  it("repeats the same captures and losses with the same seed", () => {
    const run = () => {
      const sim = createSimulation(
        makeMap({
          owners: ["A1", "A2", "X", "X", "X", "X"],
          // Both allies border every target, keeping one joint line after any capture.
          land: [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5]],
        }),
        makeScenario({
          A1: { faction: "allies" }, A2: { faction: "allies" }, X: { faction: "axis" },
        }),
        { seed: 42, config },
      );
      sim.military.set([40, 30, 20]);
      setWar(sim, "A1", "X");
      setWar(sim, "A2", "X");
      for (let week = 0; week < 3; week++) {
        const battles = resolveCombat(sim, computeFronts(sim));
        expect(battles).toHaveLength(1);
        expect(battles[0].attackers).toHaveLength(2);
        expect(battles[0].captures).toHaveLength(1);
        applyBattles(sim, battles);
      }
      expect(Array.from(sim.owner).filter((owner) => owner === sim.tags.indexOf("X"))).toHaveLength(1);
      expect(sim.military[sim.tags.indexOf("X")]).toBeLessThan(20);
      return { owners: Array.from(sim.owner), militaries: Array.from(sim.military) };
    };
    expect(run()).toEqual(run());
  });
});

describe("explicit landing protection", () => {
  it("blocks only listed sea targets until the axis-held region is cleared", () => {
    const scenario = makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } });
    scenario.landingRestrictions = [{
      defender: "X", coreOnly: true, protect: [1], blockedWhileHeldBy: "axis", region: [3, 4],
    }];
    const sim = createSimulation(
      makeMap({
        owners: ["A", "X", "X", "X", "X"], land: [], sea: [[0, 1], [0, 2]],
        core: [true, false, true, true, true],
      }),
      scenario,
      { config },
    );
    const [a, x] = ["A", "X"].map((tag) => sim.tags.indexOf(tag));
    sim.military.set([100, 10]);
    sim.fleets.push({ country: a, zone: 0, strength: 100, target: 0 });
    setWar(sim, "A", "X");
    const fronts = computeFronts(sim);
    expect(fronts.targets.get(a * sim.tags.length + x)?.land.size).toBe(0);
    expect([...fronts.targets.get(a * sim.tags.length + x)!.sea.keys()]).toEqual([1, 2]);
    expect(Array.from(sim.restrictions[0].protects)).toEqual([0, 1, 0, 0, 0]);
    expect(blockedLandings(sim)?.[1]).toBe(1);
    expect(blockedLandings(sim)?.[2]).toBe(0);
    const blocked = resolveCombat(sim, fronts);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].captures).toEqual([2]);
    applyBattles(sim, blocked);
    expect(sim.owner[1]).toBe(x);
    expect(sim.owner[2]).toBe(a);

    setOwner(sim, 3, a);
    expect(blockedLandings(sim)?.[1]).toBe(1);
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
    setOwner(sim, 4, a);
    expect(blockedLandings(sim)).toBeNull();
    const allowed = resolveCombat(sim, computeFronts(sim));
    expect(allowed).toHaveLength(1);
    expect(allowed[0].captures).toEqual([1]);
    applyBattles(sim, allowed);
    expect(sim.owner[1]).toBe(a);
  });
});
