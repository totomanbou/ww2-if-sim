import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CAPITAL_NAMES } from "../../sim/capitals";
import { setOwner } from "../../sim/combat";
import { step } from "../../sim/engine";
import { createSimulation } from "../../sim/init";
import { cityEventText } from "../../sim/newsText";
import { cloneScenario, capitalOf, toScenarioFile, applyScenarioFile } from "../../sim/scenario";
import type { CountrySetup, Scenario, SimEvent, SimMap } from "../../sim/types";
import { makeMap, makeScenario } from "../../sim/__tests__/helpers";
import { majorHeadline } from "../majorNews";
import { headline } from "../news";

const setup = (name: string, formalName: string): CountrySetup => ({ name, formalName, industry: 1, shipbuilding: 0,
  color: "#fff", stability: 1, faction: "allies" });
const scenario: Scenario = { name: "wording", seed: 1, wars: [], countries: {
  FRA: setup("フランス", "フランス共和国"), GER: setup("ドイツ", "ドイツ国"), SOV: setup("ソ連", "ソビエト連邦"),
  JAP: setup("日本", "大日本帝国"), FFR: setup("自由フランス", "自由フランス"),
} };
const event = (type: SimEvent["type"], countries: string[], extra: Partial<SimEvent> = {}): SimEvent => ({
  tick: 1, date: "1940-06-21", type, countries, text: "old text must not determine the headline", ...extra,
});

describe("city occupation wording", () => {
  it("uses the requested named-capital phrasing and the actor's formal name", () => {
    expect(majorHeadline(event("capitalFall", ["FRA", "GER"]), scenario)).toBe("ドイツ国がパリを占領");
    expect(majorHeadline(event("capitalRecapture", ["SOV", "SOV"]), scenario)).toBe("ソビエト連邦がモスクワを奪還");
  });
  it("always names the original capital even if an old event contains a moving-seat city name", () => {
    expect(majorHeadline(event("capitalRecapture", ["FRA", "FFR"], { cityName: "ブラザヴィル" }), scenario))
      .toBe("自由フランスがパリを奪還");
  });
  it.each(["キエフ", "バタヴィア", "シンガポール", "スターリングラード"])("applies the same actor-first phrasing to %s", (cityName) => {
    expect(headline(event("cityFall", ["JAP"], { cityName }), scenario)).toBe(`【速報】大日本帝国が${cityName}を占領`);
    expect(headline(event("cityRecapture", ["SOV"], { cityName }), scenario)).toBe(`【速報】ソビエト連邦が${cityName}を奪還`);
  });
  it("also formats existing victory-city events and rejects a missing actor", () => {
    expect(headline(event("cityFall", ["GER"], { city: "Paris" }), scenario)).toBe("【速報】ドイツ国がパリを占領");
    expect(cityEventText(event("capitalFall", ["FRA"]), scenario)).toBeNull();
  });
});

describe("fixed original capitals", () => {
  it("removes obsolete overrides when cloning and saving without mutating the input", () => {
    const base = makeScenario({ FRA: { industry: 50 } });
    Object.assign(base.countries.FRA, { capital: 1 });
    const map = makeMap({ owners: ["FRA", "FRA"], land: [], capitals: { FRA: 0 } });
    expect(cloneScenario(base).countries.FRA).not.toHaveProperty("capital");
    expect(base.countries.FRA).toHaveProperty("capital", 1);
    expect(toScenarioFile(base, map).countries.FRA).not.toHaveProperty("capital");
    expect(capitalOf(map, "FRA")).toBe(0);
  });
  it("ignores a legacy capital override while restoring all remaining saved choices", () => {
    const base = makeScenario({ FRA: {} });
    const map = makeMap({ owners: ["FRA", "FRA"], land: [], capitals: { FRA: 0 } });
    const saved = toScenarioFile(base, map);
    saved.seed = 42;
    Object.assign(saved.countries.FRA, { capital: 1, industry: 75, shipbuilding: 12, stability: 0.7 });
    const imported = applyScenarioFile(JSON.stringify(saved), base, map);
    expect(imported.scenario.seed).toBe(42);
    expect(imported.scenario.countries.FRA).toMatchObject({ industry: 75, shipbuilding: 12, stability: 0.7 });
    expect(imported.scenario.countries.FRA).not.toHaveProperty("capital");
    expect(createSimulation(map, imported.scenario).capital[0]).toBe(0);
    expect(imported.warnings).toHaveLength(1);
  });
  it("keeps capital events, important-city logs and both news views consistent", () => {
    const map = makeMap({ owners: ["FRA", "FRA", "GER", "N"], land: [], capitals: { FRA: 0 } });
    for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = 3;
    map.importantCities = [{ id: "Dunkirk", name: "ダンケルク", home: "FRA", state: 1, position: [1, 1], lonlat: [1, 1] }];
    const s = makeScenario({ FRA: setup("フランス", "フランス共和国"),
      GER: { ...setup("ドイツ", "ドイツ国"), faction: "axis" }, N: {} });
    const sim = createSimulation(map, s, { config: { advanceRate: 0, fleetBattleChance: 0, capitulateOnCapitalLoss: [], capitulateOnContinentLoss: [] } });
    setOwner(sim, 0, sim.tags.indexOf("GER")); setOwner(sim, 1, sim.tags.indexOf("GER")); step(sim);
    const capital = sim.events.find((e) => e.type === "capitalFall")!;
    const important = sim.events.find((e) => e.importantCity === "Dunkirk")!;
    expect(capital.text).toBe("ドイツ国がパリを占領");
    expect(majorHeadline(capital, s)).toBe(capital.text);
    expect(important.text).toBe("ドイツ国がダンケルクを占領");
    expect(headline(important, s)).toBe(`【速報】${important.text}`);
  });
  it("has a named original capital for every country that starts with territory on the real map", () => {
    const map: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
    for (const tag of Object.keys(map.countries)) expect(CAPITAL_NAMES[tag], tag).toBeTruthy();
  });
});
