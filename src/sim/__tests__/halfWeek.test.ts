import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { advanceCount, allocateArmies, computeFronts, deployArmies, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, makeConfig } from "../config";
import { DAY_MS, formatDate, parseDate, perStepProbability, tickTime, weekContainsSept1 } from "../date";
import { step } from "../engine";
import { createSimulation } from "../init";
import { moveFleets, navyTotals } from "../navy";
import { makeRng } from "../rng";
import type { Scenario, SimMap } from "../types";
import { checkVictory } from "../victory";
import { makeMap, makeScenario, setWar } from "./helpers";

function quiet(stepDays: 3.5 | 7 = 3.5, yearly = false) {
  const map = makeMap({ owners: ["A", "N"], land: [], sea: [[0, 1]] });
  for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = 1;
  return createSimulation(map, makeScenario({ A: { industry: 52, shipbuilding: 52 }, N: {} }),
    { mask: {}, config: { stepDays, growthMode: yearly ? "yearly" : "weekly", fleetBattleChance: 0 } });
}

function duel(stepDays: 3.5 | 7) {
  const map = makeMap({ owners: ["A", "D", "N"], land: [[0, 1]] });
  for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = 2;
  const sim = createSimulation(map, makeScenario({ A: { faction: "axis" }, D: { faction: "allies" }, N: {} }),
    { config: { stepDays, frontComparisonMode: "nation", lossRate: 0.1, advanceRate: 0,
      surprise: { D: { weeks: 2, factor: 0.25 } } } });
  setWar(sim, "A", "D");
  sim.military[sim.tags.indexOf("A")] = 100;
  sim.military[sim.tags.indexOf("D")] = 40;
  return sim;
}

describe("half-week calendar", () => {
  it("defaults to 3.5 days and keeps the half-day instead of rounding it away", () => {
    expect(DEFAULT_CONFIG.stepDays).toBe(3.5);
    const start = parseDate("1939-09-01");
    expect(new Date(tickTime(start, 1)).toISOString()).toBe("1939-09-04T12:00:00.000Z");
    expect(tickTime(start, 2)).toBe(parseDate("1939-09-08"));
    expect(tickTime(start, 104) - start).toBe(364 * DAY_MS);
  });
  it("advances two half-steps in exactly the same calendar time as one legacy weekly step", () => {
    const half = quiet(), weekly = quiet(7);
    step(half); step(half); step(weekly);
    expect(half.tick).toBe(2); expect(weekly.tick).toBe(1);
    expect(tickTime(half.startMs, half.tick, half.config.stepDays)).toBe(tickTime(weekly.startMs, weekly.tick, weekly.config.stepDays));
  });
  it("does not accept zero or unsupported time steps", () => {
    expect(() => makeConfig({ stepDays: 0 as 3.5 })).toThrow();
    expect(() => makeConfig({ stepDays: 4 as 3.5 })).toThrow();
  });
  it("checks both half-week intervals around September 1 without double counting", () => {
    const first = parseDate("1940-08-30");
    expect(weekContainsSept1(first, 3.5)).toBe(true);
    expect(weekContainsSept1(first + 3.5 * DAY_MS, 3.5)).toBe(false);
    expect(weekContainsSept1(parseDate("1940-08-28"), 3.5)).toBe(false);
  });
  it("activates a dated declaration once, on the first half-step at or after the date", () => {
    const sim = duel(3.5);
    sim.atWar.fill(0);
    sim.wars.push({ date: "1939-09-03", a: ["A"], b: ["D"] });
    step(sim);
    expect(sim.events.filter((e) => e.type === "war")).toEqual([]);
    step(sim); step(sim);
    expect(sim.events.filter((e) => e.type === "war")).toMatchObject([{ tick: 1, date: "1939-09-04" }]);
  });
});

describe("half-week rates", () => {
  it("adds half the weekly production on each half-step, keeping weekly army and navy totals", () => {
    const half = quiet(), weekly = quiet(7);
    const a = half.tags.indexOf("A"), initial = half.military[a], navy = navyTotals(half)[a];
    step(half);
    expect(half.military[a] - initial).toBeCloseTo(0.5);
    expect(navyTotals(half)[a] - navy).toBeCloseTo(0.5);
    step(half); step(weekly);
    for (let i = 0; i < half.tags.length; i++) {
      expect(half.military[i]).toBeCloseTo(weekly.military[i], 10);
      expect(navyTotals(half)[i]).toBeCloseTo(navyTotals(weekly)[i], 10);
    }
  });
  it("applies annual army and navy production exactly once across adjacent half-steps", () => {
    const sim = quiet(3.5, true), a = sim.tags.indexOf("A");
    const initial = sim.military[a], navy = navyTotals(sim)[a];
    for (let i = 0; i < 104; i++) step(sim);
    expect(sim.military[a]).toBe(initial);
    step(sim); step(sim);
    expect(sim.military[a] - initial).toBeCloseTo(52);
    expect(navyTotals(sim)[a] - navy).toBeCloseTo(52);
  });
  it("scales continuous combat losses by the elapsed half-week", () => {
    const half = duel(3.5), weekly = duel(7);
    const loss = (sim: typeof half) => resolveCombat(sim, computeFronts(sim))[0].loss;
    expect(loss(half)).toBeCloseTo(loss(weekly) / 2);
  });
  it("keeps a two-week surprise effect for four half-steps", () => {
    const half = duel(3.5), d = half.tags.indexOf("D");
    half.surpriseStart[d] = 0;
    for (const [tick, factor] of [[0, 0.25], [1, 0.4375], [2, 0.625], [3, 0.8125], [4, 1]]) {
      half.tick = tick;
      expect(resolveCombat(half, computeFronts(half))[0].defStrength).toBeCloseTo(40 * factor);
    }
  });
  it("scales advance caps without discarding fractional expected captures", () => {
    function captures(stepDays: 3.5 | 7) {
      const map = makeMap({ owners: ["A", ...Array(10).fill("D")], land: Array.from({ length: 10 }, (_, i) => [0, i + 1] as [number, number]) });
      const sim = createSimulation(map, makeScenario({ A: {}, D: {} }),
        { config: { stepDays, frontComparisonMode: "nation", advanceRate: 1, advanceMax: 6, advanceBreadthEdges: 100 } });
      setWar(sim, "A", "D"); sim.military.set([1000, 1]);
      return resolveCombat(sim, computeFronts(sim))[0].captures.length;
    }
    expect(captures(7)).toBe(6);
    expect(captures(3.5)).toBe(3);
  });
  it.each([0, 0.01, 0.25, 0.6, 1])("preserves weekly occurrence probability %s over two half-steps", (p) => {
    const half = perStepProbability(p, 0.5);
    expect(1 - (1 - half) ** 2).toBeCloseTo(p, 12);
    expect(perStepProbability(p, 1)).toBe(p);
  });
  it("preserves fractional advance in expectation over many half-steps instead of flooring it to zero", () => {
    const rng = makeRng(8675309), trials = 20_000;
    let total = 0;
    for (let i = 0; i < trials; i++) total += advanceCount(1.75, 0.5, 3, rng) + advanceCount(1.75, 0.5, 3, rng);
    expect(total / trials).toBeCloseTo(0.75, 1);
  });
  it("preserves one-week deployment after two exponential half-step relaxations", () => {
    function transit(stepDays: 3.5 | 7) {
      const map = makeMap({ owners: ["A", "A", "D"], land: [[0, 1], [1, 2]], lonlat: [[0, 0], [30, 0], [31, 0]] });
      const sim = createSimulation(map, makeScenario({ A: {}, D: {} }), { config: { stepDays, holdShare: 0, transitSpeedKmPerWeek: 570 } });
      setWar(sim, "A", "D");
      const fronts = computeFronts(sim), allocation = allocateArmies(sim, fronts);
      let last = deployArmies(sim, fronts, allocation);
      if (stepDays === 3.5) last = deployArmies(sim, fronts, allocation);
      return last.get(fronts.line[1])!.get(sim.tags.indexOf("A"));
    }
    expect(transit(3.5)).toBeCloseTo(transit(7)!, 9);
  });
  it("does not double fleet travel speed when updates double", () => {
    function fleets(stepDays: 3.5 | 7) {
      const map = makeMap({ owners: ["A", "D"], land: [], sea: [[0, 1, 2]], zones: [{ neighbors: [1] }, { neighbors: [0, 2] }, { neighbors: [1] }] });
      const sim = createSimulation(map, makeScenario({ A: { shipbuilding: 10 }, D: { shipbuilding: 10 } }), { config: { stepDays, maxFleets: 1 } });
      setWar(sim, "A", "D");
      const fleet = sim.fleets.find((f) => f.country === sim.tags.indexOf("A"))!;
      fleet.zone = 0;
      moveFleets(sim);
      if (stepDays === 3.5) { expect(fleet.zone).toBe(0); moveFleets(sim); }
      return fleet.zone;
    }
    expect(fleets(3.5)).toBe(fleets(7));
    expect(fleets(3.5)).toBe(1);
  });
});

describe("half-week victory duration", () => {
  function held() {
    // Moscow and Paris are on allied land (D) held by the axis (A); a city's side is its 1939 owner's faction.
    // The other targets stay with their owners (London and Honolulu with D, Rome, Berlin and Tokyo with A).
    const map = makeMap({ owners: ["D", "A", "N", "D"], land: [] });
    map.cities.Moscow = map.cities.Paris = 0;
    map.cities.London = map.cities.Honolulu = 3;
    map.cities.Rome = map.cities.Berlin = map.cities.Tokyo = 1;
    const sim = createSimulation(map, makeScenario({ A: { faction: "axis" }, D: { faction: "allies" }, N: {} }), { config: { axisBWeeks: 3 } });
    sim.owner[0] = sim.tags.indexOf("A");
    return sim;
  }
  it("requires six consecutive half-week checks for a three-week hold", () => {
    const sim = held();
    for (let i = 0; i < 5; i++) expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(2.5);
    expect(checkVictory(sim)).toBe("axisB"); expect(sim.axisBWeeks).toBe(3);
  });
  it("resets the duration even if a city is liberated for only half a week", () => {
    const sim = held();
    checkVictory(sim); checkVictory(sim);
    sim.owner[sim.cities.Paris] = sim.tags.indexOf("D");
    checkVictory(sim); expect(sim.axisBWeeks).toBe(0);
    sim.owner[sim.cities.Paris] = sim.tags.indexOf("A");
    for (let i = 0; i < 5; i++) expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
  });
});

it("runs the real historical default on half-week ticks with monotonic dates and no duplicate declarations", () => {
  const map: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
  const scenario: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));
  const sim = createSimulation(map, scenario);
  const cutoff = parseDate("1941-12-31");
  while (!sim.result && tickTime(sim.startMs, sim.tick, sim.config.stepDays) <= cutoff) step(sim);
  expect(sim.tick).toBeGreaterThan(200);
  const wars = sim.events.filter((e) => e.type === "war");
  expect(new Set(wars.map((e) => e.date + e.countries.join(","))).size).toBe(wars.length);
  expect(wars.some((e) => e.countries[0] === "JAP" && e.countries.includes("USA"))).toBe(true);
  for (const event of sim.events) expect(event.date).toBe(formatDate(tickTime(sim.startMs, event.tick, 3.5)));
  expect([...sim.military].every((n) => Number.isFinite(n) && n >= 0)).toBe(true);
});
