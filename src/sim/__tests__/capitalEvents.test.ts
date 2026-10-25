import { describe, expect, it } from "vitest";
import { capitulate } from "../capitulation";
import { setOwner } from "../combat";
import { step } from "../engine";
import { createSimulation } from "../init";
import type { SimConfig } from "../config";
import { makeMap, makeScenario, setWar } from "./helpers";

function fixture(capital = 0, config: Partial<SimConfig> = {}) {
  const map = makeMap({ owners: ["FRA", "FRA", "GER", "USA", "N"], land: [], capitals: { FRA: 0 } });
  for (const key of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[key] = 4;
  const scenario = makeScenario({
    FRA: { faction: "allies" }, GER: { faction: "axis" }, USA: { faction: "allies" },
    FFR: { faction: "allies" }, N: {},
  });
  Object.assign(scenario.countries.FRA, { capital }); // Old untyped inputs must not restore the removed feature.
  return createSimulation(map, scenario, { config: { advanceRate: 0, fleetBattleChance: 0, capitulationThreshold: 1,
    capitulateOnCapitalLoss: [], capitulateOnContinentLoss: [], ...config } });
}

describe("national capital events", () => {
  it("reports enemy capture and recovery by the original country once each", () => {
    const sim = fixture(), fra = sim.tags.indexOf("FRA"), ger = sim.tags.indexOf("GER");
    setOwner(sim, 0, ger); step(sim); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalFall")).toHaveLength(1);
    setOwner(sim, 0, fra); step(sim); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalRecapture")).toMatchObject([
      { countries: ["FRA", "FRA"] },
    ]);
  });
  it("reports Free France liberating Paris after the Republic of France has surrendered", () => {
    const sim = fixture(), fra = sim.tags.indexOf("FRA"), ger = sim.tags.indexOf("GER"), ffr = sim.tags.indexOf("FFR");
    setOwner(sim, 0, ger); step(sim);
    capitulate(sim, fra, ger);
    expect(sim.capitulated[fra]).toBe(1);
    setOwner(sim, 0, ffr); step(sim); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalRecapture")).toMatchObject([
      { countries: ["FRA", "FFR"], cityName: "パリ", text: "FFRがパリを奪還" },
    ]);
    expect(sim.events.filter((e) => (e.type === "capitalFall" || e.type === "capitalRecapture") && e.countries[0] === "FFR")).toEqual([]);
  });
  it("does not call a transfer between allies a fall or a recapture", () => {
    const sim = fixture();
    setOwner(sim, 0, sim.tags.indexOf("USA")); step(sim);
    setOwner(sim, 0, sim.tags.indexOf("FRA")); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalFall" || e.type === "capitalRecapture")).toEqual([]);
  });
  it("does not treat a neutral hand-over as liberation, but detects the later allied liberation", () => {
    const sim = fixture();
    setOwner(sim, 0, sim.tags.indexOf("GER")); step(sim);
    setOwner(sim, 0, sim.tags.indexOf("N")); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalRecapture")).toEqual([]);
    setOwner(sim, 0, sim.tags.indexOf("USA")); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalRecapture")).toMatchObject([{ countries: ["FRA", "USA"] }]);
  });
  it("ignores an old IF capital override and tracks the original capital", () => {
    const sim = fixture(1), ger = sim.tags.indexOf("GER");
    expect(sim.capital[sim.tags.indexOf("FRA")]).toBe(0);
    setOwner(sim, 1, ger); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalFall")).toEqual([]);
    setOwner(sim, 0, ger); step(sim);
    expect(sim.events.filter((e) => e.type === "capitalFall")).toMatchObject([{ countries: ["FRA", "GER"] }]);
  });
  it("detects liberation caused by an enemy surrender later in the same week", () => {
    const sim = fixture(0, { capitulateOnCapitalLoss: ["GER"] });
    const fra = sim.tags.indexOf("FRA"), ger = sim.tags.indexOf("GER"), usa = sim.tags.indexOf("USA");
    setOwner(sim, 0, ger); step(sim);
    capitulate(sim, fra, ger);
    setWar(sim, "GER", "USA");
    setOwner(sim, 2, usa); step(sim);
    expect(sim.capitulated[ger]).toBe(1);
    expect(sim.events.filter((e) => e.type === "capitalRecapture" && e.countries[0] === "FRA")).toHaveLength(1);
  });
});
