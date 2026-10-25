import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { step } from "../engine";
import { createSimulation } from "../init";
import type { MapData } from "../mapTypes";
import type { Scenario, SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

type Reinforcements = SimConfig["warStartReinforcements"];
const entries: Reinforcements = [{ to: "JAP", against: ["USA", "UK"], years: 2 }];

function fixture(reinforcements: Reinforcements = entries, fleets = true) {
  const map = makeMap({ owners: ["JAP", "USA", "UK", "CHN", "N"], land: [] });
  for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = 4;
  const sim = createSimulation(map, makeScenario({
    JAP: { faction: "axis", industry: 18, shipbuilding: 12, stability: 0.4 },
    USA: { faction: "allies" }, UK: { faction: "allies" }, CHN: { faction: "allies" }, N: {},
  }), { config: {
    warStartReinforcements: reinforcements,
    advanceRate: 0, fleetBattleChance: 0,
    capitulateOnCapitalLoss: [], capitulateOnContinentLoss: [],
  } });
  // Different initial strengths verify that growth is split equally, rather than proportionally.
  if (fleets) sim.fleets.push(
    { country: sim.tags.indexOf("JAP"), zone: 0, target: 0, strength: 3 },
    { country: sim.tags.indexOf("JAP"), zone: 0, target: 0, strength: 7 },
    { country: sim.tags.indexOf("USA"), zone: 0, target: 0, strength: 5 },
  );
  return sim;
}

function paired(reinforcements: Reinforcements = entries, fleets = true) {
  return [fixture(reinforcements, fleets), fixture([], fleets)] as const;
}

function advance(sims: readonly SimState[], enemy?: string) {
  for (const sim of sims) {
    if (enemy) setWar(sim, "JAP", enemy);
    step(sim);
    expect(sim.result).toBeNull();
  }
}

function expectBonus([sim, control]: readonly [SimState, SimState], army: number, navy: number) {
  const to = sim.tags.indexOf("JAP");
  expect(sim.military[to] - control.military[to]).toBeCloseTo(army, 8);
  const total = (run: SimState) => run.fleets.filter((f) => f.country === to).reduce((n, f) => n + f.strength, 0);
  expect(total(sim) - total(control)).toBeCloseTo(navy, 8);
  for (let c = 0; c < sim.tags.length; c++) {
    if (c !== to) expect(sim.military[c]).toBeCloseTo(control.military[c], 8);
  }
  expect(sim.fleets.filter((f) => f.country !== to)).toEqual(control.fleets.filter((f) => f.country !== to));
}

describe("war start reinforcements", () => {
  it("defaults to two production years for Japan against the USA or UK", () => {
    expect(DEFAULT_CONFIG.warStartReinforcements).toEqual(entries);
  });

  it("initializes separate zero-filled state for every entry and simulation", () => {
    const first = fixture([...entries, ...entries]), second = fixture([...entries, ...entries]);
    expect(first.warStartDone).toBeInstanceOf(Uint8Array);
    expect(first.warStartDone).toEqual(new Uint8Array(2));
    expect(second.warStartDone).toEqual(new Uint8Array(2));
    expect(first.warStartDone).not.toBe(second.warStartDone);
    expect(fixture([]).warStartDone).toEqual(new Uint8Array(0));
  });

  it("grants nothing before a listed war, including while at war with China", () => {
    const sims = paired();
    advance(sims);
    advance(sims, "CHN");
    expectBonus(sims, 0, 0);
    expect(sims[0].warStartDone[0]).toBe(0);
  });

  it.each(["USA", "UK"])("grants army and equally split navy on the first step at war with %s", (enemy) => {
    const sims = paired();
    advance(sims, enemy);
    expectBonus(sims, 18 * 0.4 * 2, 12 * 0.4 * 2);
    const [sim, control] = sims, to = sim.tags.indexOf("JAP");
    const fleets = sim.fleets.filter((f) => f.country === to);
    const controls = control.fleets.filter((f) => f.country === to);
    fleets.forEach((f, i) => expect(f.strength - controls[i].strength).toBeCloseTo(12 * 0.4 * 2 / 2, 8));
    expect(sim.warStartDone[0]).toBe(1);
  });

  it("grants on the declaration tick immediately after startWars", () => {
    const sims = paired();
    for (const sim of sims) sim.wars.push({ date: sim.config.startDate, a: ["JAP"], b: ["USA"] });
    advance(sims);
    expect(sims[0].events.some((e) => e.type === "war")).toBe(true);
    expectBonus(sims, 14.4, 9.6);
  });

  it("grants only once across later steps and a second listed enemy", () => {
    const sims = paired();
    advance(sims, "USA");
    advance(sims);
    advance(sims, "UK");
    expectBonus(sims, 14.4, 9.6);
    expect(sims[0].warStartDone[0]).toBe(1);
  });

  it("tracks multiple entries independently", () => {
    const sims = paired([
      { to: "JAP", against: ["USA"], years: 0.5 },
      { to: "JAP", against: ["UK"], years: 1.5 },
    ]);
    advance(sims, "USA");
    expectBonus(sims, 3.6, 2.4);
    expect(sims[0].warStartDone).toEqual(new Uint8Array([1, 0]));
    advance(sims, "UK");
    expectBonus(sims, 14.4, 9.6);
    expect(sims[0].warStartDone).toEqual(new Uint8Array([1, 1]));
  });

  it("does not grant to a capitulated recipient", () => {
    const sims = paired();
    for (const sim of sims) {
      const to = sim.tags.indexOf("JAP");
      sim.capitulated[to] = 1;
      sim.military[to] = 0;
      sim.fleets = sim.fleets.filter((f) => f.country !== to);
    }
    advance(sims, "USA");
    expectBonus(sims, 0, 0);
    expect(sims[0].military[sims[0].tags.indexOf("JAP")]).toBe(0);
    expect(sims[0].warStartDone[0]).toBe(0);
  });

  it("grants only army when no fleets exist", () => {
    const sims = paired(entries, false);
    advance(sims, "USA");
    expectBonus(sims, 14.4, 0);
    expect(sims[0].fleets).toEqual([]);
    expect(sims[0].warStartDone[0]).toBe(1);
  });

  it("ignores unknown recipient and enemy tags", () => {
    const sims = paired([
      { to: "UNKNOWN", against: ["USA"], years: 2 },
      { to: "JAP", against: ["UNKNOWN"], years: 2 },
    ]);
    advance(sims, "USA");
    expectBonus(sims, 0, 0);
    expect(sims[0].warStartDone).toEqual(new Uint8Array(2));
  });

  it("ignores unknown enemies while still matching known enemies in the same entry", () => {
    const sims = paired([{ to: "JAP", against: ["UNKNOWN", "UK"], years: 2 }]);
    advance(sims, "UK");
    expectBonus(sims, 14.4, 9.6);
  });

  it("adds two army production years on the real preset's Pacific War declaration tick", () => {
    const map: MapData = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
    const scenario: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));
    // Isolate the production jump from combat losses while retaining the real map, economy and war schedule.
    const config = { advanceRate: 0, lossRate: 0, fleetBattleChance: 0 };
    const sim = createSimulation(map, scenario, { config });
    const control = createSimulation(map, scenario, { config: { ...config, warStartReinforcements: [] } });
    const jpn = sim.tags.indexOf("JAP"), nC = sim.tags.length;
    const atWar = () => ["USA", "UK"].some((tag) => sim.atWar[jpn * nC + sim.tags.indexOf(tag)]);
    let before = 0, normalGrowth = 0;
    for (let i = 0; i < 300 && !atWar() && !sim.result; i++) {
      expect(sim.military[jpn]).toBeCloseTo(control.military[jpn], 8);
      expect(sim.warStartDone[0]).toBe(0);
      before = sim.military[jpn];
      const controlBefore = control.military[jpn];
      step(sim); step(control);
      normalGrowth = control.military[jpn] - controlBefore;
    }
    expect(atWar()).toBe(true);
    expect(sim.warStartDone[0]).toBe(1);
    const bonus = sim.industry[jpn] * sim.stability[jpn] * 2;
    expect(bonus).toBeGreaterThan(0);
    expect(sim.military[jpn] - before - normalGrowth).toBeCloseTo(bonus, 8);
    expect(sim.events.some((e) => e.type === "war" && e.countries.includes("JAP")
      && e.countries.some((tag) => tag === "USA" || tag === "UK"))).toBe(true);
  });
});
