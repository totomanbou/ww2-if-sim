import { describe, expect, it } from "vitest";
import { allocateArmies, applyBattles, computeFronts, resolveCombat, sideOf } from "../combat";
import type { SimConfig } from "../config";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const config = {
  // GER's synthetic state lies inside the North Africa box; no regional cap here.
  regionCap: {},
  frontComparisonMode: "allocated", advanceRate: 1, advanceMax: 1,
  lossRate: 0.1, growthMode: "yearly", fleetBattleChance: 0,
  // Support mechanics only: troops arrive at once (transit time is tested in transit.test.ts).
  transitSpeedKmPerWeek: 1e9,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  lossFactors: {},
} satisfies Partial<SimConfig>;

function twoLines(mode: SimConfig["frontComparisonMode"] = "allocated", enemies = [40, 40]) {
  // SOV (0) links the two Polish fronts through a non-front state.
  // Line 1 has two POL–GER edges; line 3 has one POL–ITA edge.
  const sim = createSimulation(
    makeMap({
      owners: ["SOV", "POL", "GER", "POL", "POL", "ITA"],
      land: [[0, 1], [0, 3], [1, 2], [4, 2], [3, 5]],
    }),
    makeScenario({
      SOV: { faction: "allies" }, POL: { faction: "allies" },
      GER: { faction: "axis" }, ITA: { faction: "axis" },
    }),
    { config: { ...config, frontComparisonMode: mode } },
  );
  const [s, p, x, y] = ["SOV", "POL", "GER", "ITA"].map((tag) => sim.tags.indexOf(tag));
  sim.military[s] = 90;
  sim.military[p] = 30;
  sim.military[x] = enemies[0];
  sim.military[y] = enemies[1];
  for (const ally of ["SOV", "POL"]) {
    setWar(sim, ally, "GER");
    setWar(sim, ally, "ITA");
  }
  return { sim, s, p, x, y };
}

describe("support through own-side territory", () => {
  it("adds a land supporter to combat and losses, but gives captures to the adjacent ally", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["SOV", "POL", "GER"], land: [[0, 1], [1, 2]],
        lonlat: [[-50, 0], [10, 20], [11, 20]],
      }),
      makeScenario({
        SOV: { faction: "allies" }, POL: { faction: "allies" }, GER: { faction: "axis" },
      }),
      { config },
    );
    const [s, p, x] = ["SOV", "POL", "GER"].map((tag) => sim.tags.indexOf(tag));
    sim.military[s] = 90;
    sim.military[p] = 10;
    sim.military[x] = 40;
    setWar(sim, "SOV", "GER");
    setWar(sim, "POL", "GER");

    const fronts = computeFronts(sim);
    const line = fronts.line[1];
    expect(fronts.line[0]).toBe(-1);
    expect(fronts.frontCount[s]).toBe(0);
    expect(fronts.lineFront.get(line)!.has(s)).toBe(false);
    expect(fronts.lineCountries.get(line)).toEqual(new Set([s, p, x]));
    // Only Poland's front contributes to the allied centre, not the supporter's capital.
    expect(fronts.lineSide.get(line)!.get(sideOf(sim, s))).toEqual({ edges: 1, lon: 10, lat: 20, n: 1 });
    expect(allocateArmies(sim, fronts).get(line)!.get(s)).toBeCloseTo(90);

    const battles = resolveCombat(sim, fronts);
    expect(battles).toHaveLength(1);
    expect(battles[0]).toMatchObject({
      attackers: [s, p], defenders: [x], captures: [2], captors: [p], capturedFrom: [x],
    });
    expect(battles[0].attStrength).toBeCloseTo(100);
    expect(battles[0].defStrength).toBeCloseTo(40);
    expect(battles[0].attShare[0]).toBeCloseTo(0.9);
    expect(battles[0].attShare[1]).toBeCloseTo(0.1);
    expect(battles[0].loss).toBeCloseTo(4);
    applyBattles(sim, battles);
    expect(sim.owner[2]).toBe(p);
    expect(sim.military[s]).toBeCloseTo(90 - 2 * 4 * 0.9);
    expect(sim.military[p]).toBeCloseTo(10 - 2 * 4 * 0.1);
    expect(sim.military[x]).toBeCloseTo(36);
  });

  it("brings a supporter over a sea route to an ally's land front", () => {
    const sim = createSimulation(
      makeMap({ owners: ["USA", "ENG", "GER"], land: [[1, 2]], sea: [[0, 1]] }),
      makeScenario({
        USA: { faction: "allies" }, ENG: { faction: "allies" }, GER: { faction: "axis" },
      }),
      { config },
    );
    const [u, b, x] = ["USA", "ENG", "GER"].map((tag) => sim.tags.indexOf(tag));
    sim.military[u] = 80;
    setWar(sim, "USA", "GER");
    setWar(sim, "ENG", "GER");
    const fronts = computeFronts(sim);
    const line = fronts.line[1];
    expect(fronts.line[0]).toBe(-1);
    expect(fronts.frontCount[u]).toBe(0);
    expect(fronts.lineCountries.get(line)).toEqual(new Set([u, b, x]));
    expect(allocateArmies(sim, fronts).get(line)!.get(u)).toBeCloseTo(80);
  });

  it("does not support a separate line through a sea route into enemy territory", () => {
    const sim = createSimulation(
      makeMap({
        owners: ["USA", "ENG", "GER", "GER", "GER"],
        land: [[1, 2], [2, 3], [3, 4]], sea: [[0, 4]],
      }),
      makeScenario({
        USA: { faction: "allies" }, ENG: { faction: "allies" }, GER: { faction: "axis" },
      }),
      { config },
    );
    const [u, b, x] = ["USA", "ENG", "GER"].map((tag) => sim.tags.indexOf(tag));
    setWar(sim, "USA", "GER");
    setWar(sim, "ENG", "GER");
    const fronts = computeFronts(sim);
    const britishLine = fronts.line[1], americanLine = fronts.line[0];
    // The non-front German state 3 separates the two lines, but not German territory.
    expect(fronts.line[3]).toBe(-1);
    expect(americanLine).not.toBe(britishLine);
    expect(fronts.lineCountries.get(americanLine)).toEqual(new Set([u, x]));
    expect(fronts.lineCountries.get(britishLine)).toEqual(new Set([b, x]));
    expect(allocateArmies(sim, fronts).get(britishLine)!.has(u)).toBe(false);
  });

  it.each([false, true])("excludes a connected ally without a war on this line (unrelated war = %s)", (unrelatedWar) => {
    const sim = createSimulation(
      makeMap({ owners: ["SOV", "POL", "GER", "ITA"], land: [[0, 1], [1, 2]] }),
      makeScenario({
        SOV: { faction: "allies" }, POL: { faction: "allies" },
        GER: { faction: "axis" }, ITA: { faction: "axis" },
      }),
      { config },
    );
    const [s, p, x] = ["SOV", "POL", "GER"].map((tag) => sim.tags.indexOf(tag));
    setWar(sim, "POL", "GER");
    if (unrelatedWar) setWar(sim, "SOV", "ITA");
    const fronts = computeFronts(sim);
    const line = fronts.line[1];
    expect(fronts.lineCountries.get(line)).toEqual(new Set([p, x]));
    expect(allocateArmies(sim, fronts).get(line)!.has(s)).toBe(false);
  });

  it("excludes a warring ally on an island without a route to its side's front", () => {
    const sim = createSimulation(
      makeMap({ owners: ["SOV", "POL", "GER"], land: [[1, 2]] }),
      makeScenario({
        SOV: { faction: "allies" }, POL: { faction: "allies" }, GER: { faction: "axis" },
      }),
      { config },
    );
    const [s, p, x] = ["SOV", "POL", "GER"].map((tag) => sim.tags.indexOf(tag));
    setWar(sim, "SOV", "GER");
    setWar(sim, "POL", "GER");
    const fronts = computeFronts(sim);
    const line = fronts.line[1];
    expect(fronts.line[0]).toBe(-1);
    expect(fronts.lineCountries.get(line)).toEqual(new Set([p, x]));
    expect(allocateArmies(sim, fronts).get(line)!.has(s)).toBe(false);
  });

  it("treats neutral-faction countries as separate sides when connecting territory", () => {
    const sim = createSimulation(
      makeMap({ owners: ["S", "P", "X"], land: [[0, 1], [1, 2]] }),
      makeScenario({ S: {}, P: {}, X: { faction: "axis" } }),
      { config },
    );
    const [s, p, x] = ["S", "P", "X"].map((tag) => sim.tags.indexOf(tag));
    setWar(sim, "S", "X");
    setWar(sim, "P", "X");
    expect(sideOf(sim, s)).toBe(s);
    expect(sideOf(sim, p)).toBe(p);
    expect(sideOf(sim, x)).toBe(-1);
    const fronts = computeFronts(sim);
    expect(fronts.lineCountries.get(fronts.line[1])).toEqual(new Set([p, x]));
  });

  it.each([
    { enemies: [40, 40], expected: [60, 30] },
    { enemies: [0, 0], expected: [60, 30] },
    { enemies: [80, 40], expected: [72, 18] },
  ])("splits a supporter by side length and enemy strength with enemies $enemies", ({ enemies, expected }) => {
    const { sim, s, p, x, y } = twoLines("allocated", enemies);
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([1, 3]);
    expect(fronts.line[0]).toBe(-1);
    expect(fronts.frontCount[s]).toBe(0);
    expect(Array.from(sim.stateLonLat).every(Number.isNaN)).toBe(true);
    expect(fronts.lineCountries.get(1)).toEqual(new Set([s, p, x]));
    expect(fronts.lineCountries.get(3)).toEqual(new Set([s, p, y]));
    expect(sideOf(sim, s)).toBe(-2);
    expect(fronts.lineSide.get(1)!.get(-2)).toEqual({ edges: 2, lon: 0, lat: 0, n: 0 });
    expect(fronts.lineSide.get(3)!.get(-2)).toEqual({ edges: 1, lon: 0, lat: 0, n: 0 });
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.get(1)!.get(s)).toBeCloseTo(expected[0]);
    expect(allocation.get(3)!.get(s)).toBeCloseTo(expected[1]);
    const total = [...allocation.values()].reduce((sum, countries) => sum + (countries.get(s) ?? 0), 0);
    expect(total).toBeCloseTo(sim.military[s]);
  });

  it("counts the supporter's whole army on each reachable line in nation mode", () => {
    const { sim, s, p } = twoLines("nation");
    const fronts = computeFronts(sim);
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.size).toBe(2);
    for (const line of [1, 3]) {
      expect(fronts.lineCountries.get(line)!.has(s)).toBe(true);
      expect(allocation.get(line)!.get(s)).toBeCloseTo(90);
    }
    const battles = resolveCombat(sim, fronts);
    expect(battles).toHaveLength(2);
    for (const battle of battles) {
      expect(battle.attackers).toEqual([s, p]);
      expect(battle.attStrength).toBeCloseTo(120);
    }
  });

  it("repeats owners and armies over three steps with land and sea supporters and the same seed", () => {
    const run = () => {
      const sim = createSimulation(
        makeMap({
          owners: ["SOV", "POL", "GER", "GER", "GER", "GER", "GER", "ENG", "USA"],
          // A chain keeps one shared-state front as Poland advances; SOV and USA still support by land and sea.
          land: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 7]],
          sea: [[7, 8]], capitals: { GER: 6 },
          cities: { Rome: 6, Berlin: 6, Tokyo: 6 },
        }),
        makeScenario({
          SOV: { faction: "allies" }, POL: { faction: "allies" },
          ENG: { faction: "allies" }, USA: { faction: "allies" }, GER: { faction: "axis" },
        }),
        { seed: 42, config },
      );
      for (const [tag, army] of Object.entries({ SOV: 90, POL: 10, ENG: 20, USA: 30, GER: 40 })) {
        sim.military[sim.tags.indexOf(tag)] = army;
        if (tag !== "GER") setWar(sim, tag, "GER");
      }
      const s = sim.tags.indexOf("SOV"), p = sim.tags.indexOf("POL"), x = sim.tags.indexOf("GER");
      const snapshots = [];
      for (let week = 0; week < 3; week++) {
        const fronts = computeFronts(sim);
        expect(fronts.line[0]).toBe(-1);
        expect(fronts.line[8]).toBe(-1);
        // The chain's active front moves one state forward after each capture.
        expect(fronts.lineCountries.size).toBe(1);
        expect(fronts.lineCountries.get(fronts.line[week + 1])).toEqual(new Set(sim.tags.map((_, i) => i)));
        step(sim);
        expect(sim.tick).toBe(week + 1);
        expect(sim.result).toBeNull();
        expect(Array.from(sim.owner).filter((owner) => owner === x)).toHaveLength(4 - week);
        snapshots.push({ owners: Array.from(sim.owner), armies: Array.from(sim.military) });
      }
      expect(Array.from(sim.owner).filter((owner, state) => state >= 2 && state <= 6 && owner === p)).toHaveLength(3);
      expect(sim.military[s]).toBeLessThan(90);
      return snapshots;
    };
    expect(run()).toEqual(run());
  });
});
