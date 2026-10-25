import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { tickTime } from "../date";
import { applyGrowth, effectiveIndustry } from "../growth";
import { createSimulation } from "../init";
import type { SimState } from "../types";
import { makeMap, makeScenario } from "./helpers";

const aid: SimConfig["lendLease"] = [
  { from: ["USA", "UK"], to: "SOV", share: 0.25, start: "1941-10-01" },
];

function fixture(config: Partial<SimConfig> = {}) {
  const sim = createSimulation(
    makeMap({ owners: ["USA", "UK", "SOV"], land: [] }),
    makeScenario({ USA: { industry: 208 }, UK: { industry: 104 }, SOV: { industry: 52 } }),
    { mask: {}, config: { stepDays: 7, startDate: "1941-10-01", initialYears: 0, initialYearsByCountry: {},
      preWarGrowth: {}, lendLease: aid, ...config } },
  );
  sim.entered.fill(1);
  return sim;
}

function grow(sim: SimState, anniversary = false): Record<string, number> {
  const before = sim.military.slice();
  const year = new Date(tickTime(sim.startMs, sim.tick, sim.config.stepDays)).getUTCFullYear();
  applyGrowth(sim, effectiveIndustry(sim), year, anniversary);
  return Object.fromEntries(sim.tags.map((tag, c) => [tag, sim.military[c] - before[c]]));
}

describe("Lend-Lease growth", () => {
  it.each([3.5, 7] as const)("conserves total growth and moves each donor's share with %s-day steps", (stepDays) => {
    const sim = fixture({ stepDays });
    const normal = grow(fixture({ stepDays, lendLease: [] }));
    const actual = grow(sim), weeks = stepDays / 7;
    expect(actual.USA).toBeCloseTo(3 * weeks, 10);
    expect(actual.UK).toBeCloseTo(1.5 * weeks, 10);
    expect(actual.SOV).toBeCloseTo(2.5 * weeks, 10);
    expect(Object.values(actual).reduce((a, b) => a + b, 0))
      .toBeCloseTo(Object.values(normal).reduce((a, b) => a + b, 0), 10);
  });

  it.each([0, 1])("supports a constant share of %s without moving standing armies", (share) => {
    const sim = fixture({ lendLease: [{ ...aid[0], share }] });
    sim.military.fill(10_000);
    const actual = grow(sim);
    expect(actual.USA).toBeCloseTo(4 * (1 - share), 10);
    expect(actual.UK).toBeCloseTo(2 * (1 - share), 10);
    expect(actual.SOV).toBeCloseTo(1 + 6 * share, 10);
  });

  it("does nothing before start and activates exactly at start using the current tick", () => {
    const sim = fixture({ startDate: "1941-09-24" });
    expect(grow(sim)).toEqual({ SOV: 1, UK: 2, USA: 4 });
    sim.tick = 1; // 1941-10-01, even though the simulation started a week earlier.
    expect(grow(sim)).toEqual({ SOV: 2.5, UK: 1.5, USA: 3 });
  });

  it.each(["not entered", "capitulated"])("does not send aid to a recipient that has %s", (status) => {
    const sim = fixture(), sov = sim.tags.indexOf("SOV");
    if (status === "not entered") sim.entered[sov] = 0;
    else sim.capitulated[sov] = 1;
    expect(grow(sim)).toEqual({ SOV: status === "capitulated" ? 0 : 1, UK: 2, USA: 4 });
  });

  it("ignores a capitulated donor while the other donor still contributes", () => {
    const sim = fixture();
    sim.capitulated[sim.tags.indexOf("USA")] = 1;
    expect(grow(sim)).toEqual({ SOV: 1.5, UK: 1.5, USA: 0 });
  });

  it("takes nothing from a preWarGrowth-zero donor until it enters the war", () => {
    const sim = fixture({ preWarGrowth: { USA: 0 } }), usa = sim.tags.indexOf("USA");
    sim.entered[usa] = 0;
    expect(grow(sim)).toEqual({ SOV: 1.5, UK: 1.5, USA: 0 });
    sim.entered[usa] = 1;
    expect(grow(sim)).toEqual({ SOV: 2.5, UK: 1.5, USA: 3 });
  });

  it.each([
    ["1941-10-01", 0.2], ["1941-10-03", 0.2], ["1941-10-05", 0.5],
    ["1941-10-07", 0.8], ["1941-10-09", 0.8],
  ] as const)("uses the scheduled share on %s", (startDate, share) => {
    const sim = fixture({ startDate, lendLease: [{ ...aid[0], share: [["1941-10-03", 0.2], ["1941-10-07", 0.8]] }] });
    const actual = grow(sim);
    expect(actual.USA).toBeCloseTo(4 * (1 - share), 10);
    expect(actual.UK).toBeCloseTo(2 * (1 - share), 10);
    expect(actual.SOV).toBeCloseTo(1 + 6 * share, 10);
  });

  it("skips unknown donors and self-donation, and ignores an absent recipient", () => {
    const sim = fixture({ lendLease: [
      { ...aid[0], from: ["MISSING", "SOV", "USA"] },
      { ...aid[0], to: "MISSING" },
    ] });
    expect(grow(sim)).toEqual({ SOV: 2, UK: 2, USA: 3 });
  });

  it("redistributes annual growth only on the eligible anniversary tick", () => {
    const sim = fixture({ growthMode: "yearly" });
    expect(grow(sim, true)).toEqual({ SOV: 0, UK: 0, USA: 0 });
    sim.tick = 1;
    expect(grow(sim)).toEqual({ SOV: 0, UK: 0, USA: 0 });
    expect(grow(sim, true)).toEqual({ SOV: 130, UK: 78, USA: 156 });
  });

  it("documents sequential entries taking shares of the donor's remaining growth", () => {
    // Current behaviour: two 50% entries move 2 then 1 from USA's growth of 4, rather than 2 each.
    const entry = { ...aid[0], from: ["USA"], share: 0.5 };
    expect(grow(fixture({ lendLease: [entry, entry] }))).toEqual({ SOV: 4, UK: 2, USA: 1 });
  });

  it("defaults to USA/UK aid for CHN (20 %, from March 1941) and then SOV (from October 1941, 80 % falling to 20 % in June 1944)", () => {
    expect(DEFAULT_CONFIG.lendLease).toEqual([
      { from: ["USA", "UK"], to: "CHN", share: 0.2, start: "1941-03-11" },
      { from: ["USA", "UK"], to: "SOV", share: [["1944-06-06", 0.8], ["1944-06-07", 0.2]], start: "1941-10-01" },
    ]);
    // The fixture has no CHN, so its entry is skipped and the Soviet share applies to the whole growth.
    for (const [startDate, share] of [["1944-06-06", 0.8], ["1944-06-07", 0.2]] as const) {
      const actual = grow(fixture({ startDate, lendLease: DEFAULT_CONFIG.lendLease }));
      expect(actual.SOV).toBeCloseTo(1 + 6 * share, 10);
      expect(actual.USA).toBeCloseTo(4 * (1 - share), 10);
      expect(actual.UK).toBeCloseTo(2 * (1 - share), 10);
    }
  });

  it("interpolates the default schedule at the actual half-day tick time", () => {
    const sim = fixture({ startDate: "1944-06-03", stepDays: 3.5, lendLease: DEFAULT_CONFIG.lendLease });
    sim.tick = 1; // June 6 at 12:00 UTC: halfway from 80% to 20%, so the share is 50%.
    const actual = grow(sim);
    expect(actual.USA).toBeCloseTo(1, 10);
    expect(actual.UK).toBeCloseTo(0.5, 10);
    expect(actual.SOV).toBeCloseTo(2, 10);
  });
});

describe("default aid to China and the USSR together", () => {
  it("gives China 20 % of the donors' growth first and the USSR its share of the rest", () => {
    const make = (lendLease: SimConfig["lendLease"]) => {
      const sim = createSimulation(
        makeMap({ owners: ["USA", "UK", "SOV", "CHN"], land: [] }),
        makeScenario({ USA: { industry: 208 }, UK: { industry: 104 }, SOV: { industry: 52 }, CHN: { industry: 52 } }),
        { mask: {}, config: { stepDays: 7, startDate: "1942-06-01", initialYears: 0, initialYearsByCountry: {}, preWarGrowth: {}, lendLease } },
      );
      sim.entered.fill(1);
      return sim;
    };
    const base = grow(make([]));
    const actual = grow(make(DEFAULT_CONFIG.lendLease));
    const donors = base.USA + base.UK;
    expect(actual.CHN).toBeCloseTo(base.CHN + 0.2 * donors, 10);
    expect(actual.SOV).toBeCloseTo(base.SOV + 0.8 * 0.8 * donors, 10);
    expect(actual.USA + actual.UK).toBeCloseTo(0.8 * 0.2 * donors, 10);
  });
});
