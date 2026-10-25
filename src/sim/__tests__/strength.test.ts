import { describe, expect, it } from "vitest";
import { computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { parseDate, tickTime } from "../date";
import { createSimulation } from "../init";
import { makeMap, makeScenario, setWar } from "./helpers";

function fight(config: Partial<SimConfig> = {}, tick = 0, surpriseStart = -1) {
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
        startDate: "2000-01-01",
        stepDays: 7,
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
        surprise: {},
        ...config,
      },
    },
  );
  sim.tick = tick;
  for (const [tag, army] of Object.entries({ A: 60, B: 40, E: 80 })) {
    sim.military[sim.tags.indexOf(tag)] = army;
  }
  sim.surpriseStart[sim.tags.indexOf("A")] = surpriseStart;
  setWar(sim, "A", "E");
  setWar(sim, "B", "E");
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  expect(battles[0].captures).toEqual([]);
  return { sim, battle: battles[0] };
}

describe("default strength settings", () => {
  it("ramps CHN's strength from 0.5 to 1 on the specified dates", () => {
    expect(DEFAULT_CONFIG.strengthFactors).toEqual({
      CHN: [["1939-09-01", 0.5], ["1944-12-31", 1]],
    });
  });

  it("sets the advance factor on Chinese land to 0.05", () => {
    expect(DEFAULT_CONFIG.slowAdvanceLand.CHN).toBe(0.05);
  });

  it("gives CHN eight initial years of army production", () => {
    expect(DEFAULT_CONFIG.initialYearsByCountry.CHN).toBe(8);
  });
});

describe("resolveCombat with strength factors", () => {
  it("scales only A's strength and flips the attacking side", () => {
    const baseline = fight();
    const factored = fight({ strengthFactors: { A: 0.4 } });
    const a = baseline.sim.tags.indexOf("A");
    const b = baseline.sim.tags.indexOf("B");
    const e = baseline.sim.tags.indexOf("E");

    expect(baseline.battle.attackers).toEqual([a, b]);
    expect(baseline.battle.defenders).toEqual([e]);
    expect(baseline.battle.attacker).toBe(a);
    expect(baseline.battle.defender).toBe(e);
    expect(baseline.battle.attStrength).toBeCloseTo(100, 8);
    expect(baseline.battle.defStrength).toBeCloseTo(80, 8);
    expect(baseline.battle.loss).toBeCloseTo(8, 8);

    // A now contributes 24 and B still contributes 40; B is the strongest defender.
    expect(factored.battle.attackers).toEqual([e]);
    expect(factored.battle.defenders).toEqual([b, a]);
    expect(factored.battle.attacker).toBe(e);
    expect(factored.battle.defender).toBe(b);
    expect(factored.battle.attStrength).toBeCloseTo(80, 8);
    expect(factored.battle.defStrength).toBeCloseTo(64, 8);
    expect(factored.battle.attShare).toEqual([1]);
    expect(factored.battle.defShare[0]).toBeCloseTo(40 / 64, 8);
    expect(factored.battle.defShare[1]).toBeCloseTo(24 / 64, 8);
    expect(factored.battle.loss).toBeCloseTo(6.4, 8);
  });

  it("multiplies the strength already reduced by surprise", () => {
    const surprise = { A: { weeks: 8, factor: 0.5 } };
    const baseline = fight({ surprise }, 0, 0);
    const factored = fight({ surprise, strengthFactors: { A: 0.4 } }, 0, 0);

    expect(baseline.battle.defStrength).toBeCloseTo(60 * 0.5 + 40, 8);
    expect(factored.battle.defStrength).toBeCloseTo(60 * 0.5 * 0.4 + 40, 8);
    expect(factored.battle).toEqual(fight({ strengthFactors: { A: 0.2 } }).battle);
  });

  it.each<{ name: string; strengthFactors: SimConfig["strengthFactors"] }>([
    { name: "a numeric factor of one", strengthFactors: { A: 1 } },
    { name: "an empty object", strengthFactors: {} },
  ])("preserves the full battle result with $name", ({ strengthFactors }) => {
    expect(fight({ strengthFactors }).battle).toEqual(fight().battle);
  });

  it.each([
    { name: "numeric", factor: 0.4 },
    { name: "scheduled", factor: [["2000-01-01", 0.2], ["2000-01-29", 0.6]] },
  ] satisfies { name: string; factor: SimConfig["strengthFactors"][string] }[])(
    "ignores a $name factor for a country absent from the scenario",
    ({ factor }) => {
      const baseline = fight();
      const factored = fight({ strengthFactors: { ABSENT: factor } });
      expect(factored.sim.tags).not.toContain("ABSENT");
      expect(factored.battle).toEqual(baseline.battle);
    },
  );
});

describe.each([3.5, 7] as const)("strength schedule with %s-day steps", (stepDays) => {
  const strengthFactors: SimConfig["strengthFactors"] = {
    A: [["2000-01-08", 0.2], ["2000-01-22", 0.6]],
  };

  it.each([
    { days: 0, date: "2000-01-01", factor: 0.2, position: "before the schedule" },
    { days: 14, date: "2000-01-15", factor: 0.4, position: "halfway between dates" },
    { days: 28, date: "2000-01-29", factor: 0.6, position: "after the schedule" },
  ])("matches numeric factor $factor $position", ({ days, date, factor }) => {
    const tick = days / stepDays;
    const scheduled = fight({ stepDays, strengthFactors }, tick);
    const numeric = fight({ stepDays, strengthFactors: { A: factor } }, tick);

    expect(tickTime(scheduled.sim.startMs, scheduled.sim.tick, scheduled.sim.config.stepDays))
      .toBe(parseDate(date));
    expect(scheduled.battle).toEqual(numeric.battle);
    expect(scheduled.battle.attStrength).toBeCloseTo(80, 8);
    expect(scheduled.battle.defStrength).toBeCloseTo(60 * factor + 40, 8);
    expect(scheduled.battle.loss).toBeCloseTo(0.1 * (stepDays / 7) * (60 * factor + 40), 8);
  });
});
