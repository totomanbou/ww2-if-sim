import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, resolveCombat, scheduledFactor } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { parseDate } from "../date";
import { weeklyTickTime as tickTime } from "./helpers";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

const schedule: [string, number][] = [["2000-01-01", 3], ["2000-01-31", 1]];

describe("scheduledFactor", () => {
  it.each([0, 0.5, 3])("returns the numeric factor %s unchanged", (factor) => {
    expect(scheduledFactor(factor, parseDate("2000-01-16"))).toBeCloseTo(factor, 8);
  });

  it("defaults an empty schedule to 1", () => {
    expect(scheduledFactor([], parseDate("2000-01-16"))).toBeCloseTo(1, 8);
  });

  it.each([
    { date: "1999-12-31", factor: 3 },
    { date: "2000-01-01", factor: 3 },
    { date: "2000-01-16", factor: 2 },
    { date: "2000-01-31", factor: 1 },
    { date: "2000-02-01", factor: 1 },
  ])("evaluates the two-point schedule on $date as $factor", ({ date, factor }) => {
    expect(scheduledFactor(schedule, parseDate(date))).toBeCloseTo(factor, 8);
  });

  it.each(["1999-12-31", "2000-01-01", "2000-02-01"])(
    "keeps a single-point schedule constant on %s",
    (date) => {
      expect(scheduledFactor([["2000-01-01", 2.5]], parseDate(date))).toBeCloseTo(2.5, 8);
    },
  );

  it.each([
    { date: "1999-12-31", factor: 3 },
    { date: "2000-01-01", factor: 3 },
    { date: "2000-01-06", factor: 2 },
    { date: "2000-01-11", factor: 1 },
    { date: "2000-01-21", factor: 3 },
    { date: "2000-01-31", factor: 5 },
    { date: "2000-02-05", factor: 3.5 },
    { date: "2000-02-10", factor: 2 },
    { date: "2000-02-11", factor: 2 },
  ])("selects the right segment of a multi-point schedule on $date", ({ date, factor }) => {
    const points: [string, number][] = [
      ["2000-01-01", 3],
      ["2000-01-11", 1],
      ["2000-01-31", 5],
      ["2000-02-10", 2],
    ];
    expect(scheduledFactor(points, parseDate(date))).toBeCloseTo(factor, 8);
  });
});

const lossFactors: SimConfig["lossFactors"] = {
  A: { E: [["1941-11-30", 3], ["1942-07-31", 1]] },
};

function fight(attacks: boolean, tick: number, factors: SimConfig["lossFactors"] = {}) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "E", "B"], land: [[0, 1], [2, 1]] }),
    makeScenario({
      A: { faction: "allies" },
      B: { faction: "allies" },
      E: { faction: "axis" },
    }),
    {
      seed: 17,
      config: {
        startDate: "1941-11-23",
        holdShare: 0,
        lowPriorityFronts: {},
        slowAdvanceLand: {},
        capitulateOnCapitalLoss: [],
        indirectFrontPriority: 1,
        overseasDistanceFactor: 1,
        transitSpeedKmPerWeek: 1e9,
        frontComparisonMode: "allocated",
        advanceRate: 0,
        lossRate: 0.1,
        lossFactors: factors,
      },
    },
  );
  sim.tick = tick;
  for (const [tag, army] of Object.entries({ A: 60, B: 40, E: attacks ? 50 : 200 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
  }
  setWar(sim, "A", "E");
  setWar(sim, "B", "E");
  const before = sim.military.slice();
  const owners = sim.owner.slice();
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  const battle = battles[0];
  const a = sim.tags.indexOf("A");
  expect(attacks ? battle.attackers : battle.defenders).toContain(a);
  expect(battle.captures).toEqual([]);
  applyBattles(sim, battles);
  expect(sim.owner).toEqual(owners);
  const losses = Object.fromEntries(sim.tags.map((tag, c) => [tag, before[c] - sim.military[c]]));
  return { sim, battle, losses };
}

describe("applyBattles with scheduled loss factors", () => {
  const cases = [false, true].flatMap((attacks) => [
    { attacks, tick: 0, date: "1941-11-23", factor: 3 },
    // The interval is 243 days: the nearest weekly tick is 119 days after its start.
    { attacks, tick: 18, date: "1942-03-29", factor: 3 - 2 * 119 / 243 },
    { attacks, tick: 36, date: "1942-08-02", factor: 1 },
  ]);

  it.each(cases)(
    "scales only A's loss on $date (A attacks = $attacks)",
    ({ attacks, tick, date, factor }) => {
      const baseline = fight(attacks, tick);
      const factored = fight(attacks, tick, lossFactors);
      expect(factored.sim.startMs).toBe(parseDate("1941-11-23"));
      expect(tickTime(factored.sim.startMs, factored.sim.tick)).toBe(parseDate(date));
      const loss = 0.1 * Math.min(100, attacks ? 50 : 200);
      expect(baseline.losses.A).toBeCloseTo((attacks ? 2 : 1) * loss * 0.6, 8);
      expect(factored.battle).toEqual(baseline.battle);
      expect(factored.losses.A).toBeCloseTo(factor * baseline.losses.A, 8);
      if (tick === 18) {
        expect(factored.losses.A / baseline.losses.A).toBeCloseTo(2, 1);
      }
      for (const tag of ["B", "E"]) {
        expect(factored.losses[tag]).toBeCloseTo(baseline.losses[tag], 8);
      }
    },
  );
});

describe("default loss factor schedule", () => {
  it("schedules SOV's losses against GER from 3 to 1 on the specified dates", () => {
    expect(DEFAULT_CONFIG.lossFactors.SOV.GER).toEqual([
      ["1941-11-30", 3],
      ["1942-07-31", 1],
    ]);
  });

  it("halves GER's losses against SOV until the end of 1942", () => {
    expect(DEFAULT_CONFIG.lossFactors.GER.SOV).toEqual([
      ["1942-12-31", 0.5],
      ["1943-01-01", 1],
    ]);
  });
});

describe("factors below 1", () => {
  it.each([false, true])("reduce the country's loss (A attacks = %s)", (attacks) => {
    const baseline = fight(attacks, 0);
    const halved = fight(attacks, 0, { A: { E: 0.5 } });
    expect(halved.losses.A).toBeCloseTo(0.5 * baseline.losses.A, 8);
    expect(halved.losses.E).toBeCloseTo(baseline.losses.E, 8);
  });
});
