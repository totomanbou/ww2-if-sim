import { describe, expect, it } from "vitest";
import { setOwner } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { step } from "../engine";
import { createSimulation } from "../init";
import type { SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

type Reinforcements = SimConfig["cityFallReinforcements"];
const kiev: Reinforcements = [{ city: "キエフ", to: "SOV", years: 1.5 }];

function fixture(reinforcements?: Reinforcements, occupied = false) {
  const map = makeMap({
    owners: ["A", occupied ? "A" : "D", "D", "D", "SOV", "N"],
    land: [],
    capitals: { D: 3 },
  });
  // Neutral victory-city placeholders keep the simulation running through recapture and a second fall.
  for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = 5;
  map.importantCities = [
    { id: "Kiev", name: "キエフ", home: "D", state: 1, lonlat: [30, 50], position: [20, 30] },
    { id: "Smolensk", name: "スモレンスク", home: "D", state: 2, lonlat: [32, 55], position: [40, 50] },
  ];
  const sim = createSimulation(map, makeScenario({
    A: { faction: "axis" }, D: { faction: "allies" },
    SOV: { faction: "allies", industry: 18, stability: 0.4 }, N: {},
  }), { seed: 17, config: {
    advanceRate: 0,
    fleetBattleChance: 0,
    capitulateOnCapitalLoss: [],
    capitulateOnContinentLoss: [],
    capitulationThreshold: 0,
    capitulationStabilitySlope: 0,
    capitulationThresholdRange: [0, 1],
    ...(reinforcements === undefined ? {} : { cityFallReinforcements: reinforcements }),
  } });
  setWar(sim, "A", "D");
  setWar(sim, "A", "SOV");
  return sim;
}

function paired(reinforcements: Reinforcements = kiev) {
  return [fixture(reinforcements), fixture([])] as const;
}

function changeOwner(sims: readonly SimState[], state: number, tag: string) {
  for (const sim of sims) {
    setOwner(sim, state, sim.tags.indexOf(tag));
    step(sim);
    expect(sim.result).toBeNull();
  }
}

function expectBonus([sim, control]: readonly [SimState, SimState], expected: number) {
  const to = sim.tags.indexOf("SOV");
  expect(sim.military[to] - control.military[to]).toBeCloseTo(expected, 8);
  for (let c = 0; c < sim.tags.length; c++) {
    if (c !== to) expect(sim.military[c]).toBeCloseTo(control.military[c], 8);
  }
}

describe("city fall reinforcement defaults and state", () => {
  it("grants SOV one production year for each of Kiev and Smolensk", () => {
    expect(DEFAULT_CONFIG.cityFallReinforcements).toEqual([
      { city: "キエフ", to: "SOV", years: 1 },
      { city: "スモレンスク", to: "SOV", years: 1 },
    ]);
    expect(fixture().reinforcementsDone).toEqual(new Uint8Array(2));
  });

  it("initializes a separate zero-filled Uint8Array for every configured entry and simulation", () => {
    const entries: Reinforcements = [
      ...kiev,
      { city: "スモレンスク", to: "SOV", years: 2 },
      { city: "Other", to: "A", years: 0.5 },
    ];
    const first = fixture(entries), second = fixture(entries), disabled = fixture([]);
    expect(first.reinforcementsDone).toBeInstanceOf(Uint8Array);
    expect(first.reinforcementsDone).toEqual(new Uint8Array(3));
    expect(second.reinforcementsDone).toEqual(new Uint8Array(3));
    expect(first.reinforcementsDone).not.toBe(second.reinforcementsDone);
    expect(disabled.reinforcementsDone).toEqual(new Uint8Array(0));
  });
});

describe("city fall reinforcements", () => {
  it.each([
    { years: 0.5, amount: 3.6 },
    { years: 1, amount: 7.2 },
    { years: 2.5, amount: 18 },
  ])("adds industry × stability × $years years on the first fall", ({ years, amount }) => {
    const sims = paired([{ city: "キエフ", to: "SOV", years }]);
    const [sim, control] = sims, to = sim.tags.indexOf("SOV");
    expect(sim.industry[to]).toBe(18);
    expect(sim.stability[to]).toBe(0.4);
    expectBonus(sims, 0);
    expect(sim.reinforcementsDone[0]).toBe(0);
    changeOwner(sims, 1, "A");
    for (const run of sims) {
      expect(run.events.filter((e) => e.importantCity === "Kiev")).toMatchObject([
        { type: "cityFall", cityName: "キエフ", countries: ["A"] },
      ]);
    }
    expectBonus(sims, amount);
    expect(sim.reinforcementsDone[0]).toBe(1);
    expect(control.reinforcementsDone).toHaveLength(0);
  });

  it("grants the bonus only once through occupation, recapture and a second fall", () => {
    const sims = paired(), [sim] = sims;
    changeOwner(sims, 1, "A");
    expectBonus(sims, 10.8);
    changeOwner(sims, 1, "A");
    expectBonus(sims, 10.8);
    changeOwner(sims, 1, "D");
    expectBonus(sims, 10.8);
    expect(sim.reinforcementsDone[0]).toBe(1);
    changeOwner(sims, 1, "A");
    expect(sim.events.filter((e) => e.importantCity === "Kiev").map((e) => e.type))
      .toEqual(["cityFall", "cityRecapture", "cityFall"]);
    expectBonus(sims, 10.8);
    expect(sim.reinforcementsDone[0]).toBe(1);
  });

  it("does not reinforce a capitulated recipient even though the city falls", () => {
    const sims = paired();
    for (const sim of sims) {
      const to = sim.tags.indexOf("SOV");
      sim.capitulated[to] = 1;
      sim.military[to] = 0;
    }
    changeOwner(sims, 1, "A");
    const [sim] = sims, to = sim.tags.indexOf("SOV");
    expect(sim.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "cityFall", importantCity: "Kiev" }),
    ]));
    expect(sim.capitulated[to]).toBe(1);
    expect(sim.military[to]).toBe(0);
    expectBonus(sims, 0);
    expect(sim.reinforcementsDone[0]).toBe(0);
  });

  it.each(["Unlisted city", "Kiev"])("does not grant an entry for %s when the name キエフ falls", (city) => {
    // Kiev is the important-city ID; configuration matches the Japanese name instead.
    const sims = paired([{ city, to: "SOV", years: 1.5 }]);
    changeOwner(sims, 1, "A");
    expect(sims[0].events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "cityFall", importantCity: "Kiev", cityName: "キエフ" }),
    ]));
    expectBonus(sims, 0);
    expect(sims[0].reinforcementsDone[0]).toBe(0);
  });

  it("tracks and pays different city entries independently", () => {
    const sims = paired([
      { city: "キエフ", to: "SOV", years: 0.5 },
      { city: "スモレンスク", to: "SOV", years: 2 },
    ]), [sim] = sims;
    changeOwner(sims, 1, "A");
    expectBonus(sims, 3.6);
    expect(sim.reinforcementsDone).toEqual(new Uint8Array([1, 0]));
    changeOwner(sims, 2, "A");
    expect(sim.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "cityFall", importantCity: "Smolensk" }),
    ]));
    expectBonus(sims, 18);
    expect(sim.reinforcementsDone).toEqual(new Uint8Array([1, 1]));
    changeOwner(sims, 1, "D");
    changeOwner(sims, 1, "A");
    expectBonus(sims, 18);
    expect(sim.reinforcementsDone).toEqual(new Uint8Array([1, 1]));
  });

  it("does not grant reinforcements for a friendly handover", () => {
    const sims = paired();
    changeOwner(sims, 1, "SOV");
    expect(sims[0].events.filter((e) => e.importantCity)).toEqual([]);
    expectBonus(sims, 0);
    expect(sims[0].reinforcementsDone[0]).toBe(0);
  });

  it("does not grant reinforcements before a city fall", () => {
    const sims = paired();
    for (const sim of sims) { step(sim); step(sim); }
    expect(sims[0].events.filter((e) => e.importantCity)).toEqual([]);
    expectBonus(sims, 0);
    expect(sims[0].reinforcementsDone[0]).toBe(0);
  });

  it("does not treat occupation at initialization as a new city fall", () => {
    const sims = [fixture(kiev, true), fixture([], true)] as const;
    expect(sims[0].importantCityFallen[0]).toBe(1);
    for (const sim of sims) { step(sim); step(sim); }
    expect(sims[0].events.filter((e) => e.importantCity)).toEqual([]);
    expectBonus(sims, 0);
    expect(sims[0].reinforcementsDone[0]).toBe(0);
  });

  it("ignores a configured recipient absent from the simulation", () => {
    const sims = paired([{ city: "キエフ", to: "UNKNOWN", years: 1.5 }]);
    expect(sims[0].tags).not.toContain("UNKNOWN");
    changeOwner(sims, 1, "A");
    expectBonus(sims, 0);
    expect(sims[0].reinforcementsDone[0]).toBe(0);
  });

  it("applies both defaults while an empty configuration disables both bonuses", () => {
    const sims = [fixture(), fixture([])] as const;
    changeOwner(sims, 1, "A");
    expectBonus(sims, 7.2);
    expect(sims[0].reinforcementsDone).toEqual(new Uint8Array([1, 0]));
    changeOwner(sims, 2, "A");
    expectBonus(sims, 14.4);
    expect(sims[0].reinforcementsDone).toEqual(new Uint8Array([1, 1]));
    expect(sims[1].reinforcementsDone).toHaveLength(0);
  });
});
