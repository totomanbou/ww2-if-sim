import { describe, expect, it } from "vitest";
import { computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createSimulation } from "../init";
import { makeMap, makeScenario, setWar } from "./helpers";

const config = {
  encirclement: false,
  lossFactors: {},
  lowPriorityFronts: {},
  slowAdvanceLand: {},
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  regionPriority: {},
  enemyPriority: {},
  closedLand: [],
  strengthFactors: {},
  surprise: {},
  transitSpeedKmPerWeek: 1e9,
  holdShare: 0,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  frontComparisonMode: "allocated",
  advanceRate: 2,
  advanceMax: 2,
  advanceBreadthEdges: 1e9,
  lossRate: 0.1,
  seasons: [
    { name: "冬季", land: ["SOV"], months: [12, 1, 2], loss: 1.5, capture: 0.5, exempt: ["SOV"] },
    { name: "泥濘期", land: ["SOV"], months: [3, 4, 10, 11], loss: 1.25, capture: 0.5, exempt: [] },
  ],
} satisfies Partial<SimConfig>;

/** One battle on 1-state-wide land: `att` attacks a state of `def` on the given date (all terrain normal). */
function battle(date: string, att: string, def: string, overrides: Partial<SimConfig> = {}) {
  const sim = createSimulation(
    makeMap({ owners: [att, def], land: [[0, 1]] }),
    // The attacker's enemy is on the other side (the Red Army is allied).
    makeScenario({ [att]: { faction: att === "SOV" ? "allies" : "axis" }, [def]: { faction: att === "SOV" ? "axis" : "allies" } }),
    { seed: 3, config: { ...config, startDate: date, ...overrides } },
  );
  sim.military[sim.tags.indexOf(att)] = 30;
  sim.military[sim.tags.indexOf(def)] = 10;
  setWar(sim, att, def);
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  expect(sim.tags[battles[0].attacker]).toBe(att);
  return battles[0];
}

describe("seasons on Soviet land", () => {
  it("has winter and mud seasons on Soviet land by default, the Red Army exempt from the winter", () => {
    expect(DEFAULT_CONFIG.seasons.map((s) => [s.name, s.land, s.months, s.loss, s.capture, s.exempt])).toEqual([
      ["冬季", ["SOV"], [12, 1, 2], 1.5, 0.5, ["SOV"]],
      ["泥濘期", ["SOV"], [3, 4, 10, 11], 1.25, 0.5, []],
    ]);
  });

  it.each([
    ["1941-07-15", 1], ["1941-12-15", 1.5], ["1942-01-20", 1.5], ["1941-10-15", 1.25], ["1942-04-10", 1.25], ["1942-06-10", 1],
  ])("German attack on Soviet land on %s: attacker loss factor %s", (date, factor) => {
    expect(battle(date as string, "GER", "SOV").attLossFactor).toBeCloseTo(factor as number, 8);
  });

  it("exempts the Red Army from the winter but not from the mud", () => {
    expect(battle("1941-12-15", "SOV", "GER").attLossFactor).toBeCloseTo(1, 8);
    expect(battle("1941-10-15", "SOV", "GER").attLossFactor).toBeCloseTo(1, 8); // German land: no season there
  });

  it("only applies on the listed land", () => {
    expect(battle("1941-12-15", "GER", "POL").attLossFactor).toBeCloseTo(1, 8);
  });

  it("captures less in winter: fewer captures over many seeds", () => {
    let summer = 0, winter = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const run = (date: string) => {
        const sim = createSimulation(
          makeMap({ owners: ["GER", "SOV", "SOV", "SOV", "SOV"], land: [[0, 1], [0, 2], [0, 3], [0, 4]] }),
          makeScenario({ GER: { faction: "axis" }, SOV: { faction: "allies" } }),
          { seed, config: { ...config, startDate: date } },
        );
        sim.military[sim.tags.indexOf("GER")] = 40;
        sim.military[sim.tags.indexOf("SOV")] = 10;
        setWar(sim, "GER", "SOV");
        return resolveCombat(sim, computeFronts(sim))[0].captures.length;
      };
      summer += run("1941-07-15");
      winter += run("1942-01-15");
    }
    expect(winter).toBeLessThan(summer);
  });

  it("does nothing without seasons", () => {
    expect(battle("1941-12-15", "GER", "SOV", { seasons: [] }).attLossFactor).toBeCloseTo(1, 8);
  });
});
