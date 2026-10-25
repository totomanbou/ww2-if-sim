import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import definitions from "../../../data/important-cities.json";
import { setOwner } from "../combat";
import { runToEnd, step } from "../engine";
import { importantCityFallen } from "../importantCities";
import { createSimulation } from "../init";
import type { MapData } from "../mapTypes";
import type { Scenario } from "../types";
import { headline } from "../../ui/news";
import { NewsQueue } from "../../ui/newsQueue";
import { makeMap, makeScenario } from "./helpers";

const map: MapData = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
const scenario: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));

function fixture(occupied = false) {
  const m = makeMap({ owners: ["A", occupied ? "A" : "D", "D", "U", "N"], land: [], capitals: { D: 2 } });
  for (const key of Object.keys(m.cities) as (keyof typeof m.cities)[]) m.cities[key] = 4;
  m.importantCities = [{ id: "Kiev", name: "キエフ", home: "D", state: 1, lonlat: [30, 50], position: [20, 30] }];
  return createSimulation(m, makeScenario({ A: { faction: "axis" }, D: { faction: "allies" }, U: { faction: "allies" }, N: {} }),
    { config: { advanceRate: 0, fleetBattleChance: 0, capitulateOnCapitalLoss: [], capitulateOnContinentLoss: [] } });
}

describe("important cities", () => {
  it("binds all 26 historical cities, including the four requested ones, to the correct 1939 country", () => {
    expect(map.importantCities).toHaveLength(26);
    expect(new Set(map.importantCities!.map((c) => c.id)).size).toBe(26);
    expect(map.importantCities!.map((c) => c.name)).toEqual(expect.arrayContaining(["キエフ", "スターリングラード", "バタヴィア", "シンガポール"]));
    for (const city of map.importantCities!) {
      expect(map.states[city.state].owner).toBe(definitions.find((c) => c.id === city.id)!.owner);
      expect(city.position[0]).toBeGreaterThan(0); expect(city.position[0]).toBeLessThan(map.width);
      expect(city.position[1]).toBeGreaterThan(0); expect(city.position[1]).toBeLessThan(map.height);
    }
  });

  it("reports a capture once, then a liberation once, with the correct names in news", () => {
    const sim = fixture(), a = sim.tags.indexOf("A"), u = sim.tags.indexOf("U");
    setOwner(sim, 1, a); step(sim); step(sim);
    let events = sim.events.filter((e) => e.importantCity);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "cityFall", importantCity: "Kiev", cityName: "キエフ", countries: ["A"] });
    expect(headline(events[0], sim.scenario)).toBe("【速報】Aがキエフを占領");
    setOwner(sim, 1, u); step(sim); step(sim);
    events = sim.events.filter((e) => e.importantCity);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "cityRecapture", countries: ["U"] });
    expect(headline(events[1], sim.scenario)).toBe("【速報】Uがキエフを奪還");
  });

  it("does not call an allied transfer a fall", () => {
    const sim = fixture();
    setOwner(sim, 1, sim.tags.indexOf("U")); step(sim);
    expect(sim.events.filter((e) => e.importantCity)).toEqual([]);
  });

  it("initialises pre-war occupation without issuing a false new fall at tick 0", () => {
    const sim = fixture(true);
    expect(importantCityFallen(sim, 0)).toBe(true);
    step(sim);
    expect(sim.events.filter((e) => e.importantCity)).toEqual([]);
    setOwner(sim, 1, sim.tags.indexOf("D")); step(sim);
    expect(sim.events.find((e) => e.importantCity)?.type).toBe("cityRecapture");
  });

  it("does not report a neutral hand-over as a liberation", () => {
    const sim = fixture(true);
    setOwner(sim, 1, sim.tags.indexOf("N")); step(sim);
    expect(sim.events.filter((e) => e.importantCity)).toEqual([]);
  });

  it("adds news without changing victory, territory, forces, losses, history, RNG or existing events", () => {
    // Without the reinforcements tied to city falls (config.cityFallReinforcements), which intentionally change forces.
    const config = { cityFallReinforcements: [] };
    const withCities = createSimulation(map, scenario, { config });
    const withoutCities = createSimulation({ ...map, importantCities: [] }, scenario, { config });
    runToEnd(withCities); runToEnd(withoutCities);
    expect(withCities.result).toEqual(withoutCities.result);
    expect(withCities.owner).toEqual(withoutCities.owner);
    expect(withCities.military).toEqual(withoutCities.military);
    expect(withCities.losses).toEqual(withoutCities.losses);
    expect(withCities.history).toEqual(withoutCities.history);
    expect(withCities.events.filter((e) => !e.importantCity)).toEqual(withoutCities.events);
    expect(withCities.rng.state).toBe(withoutCities.rng.state);
    expect(withCities.events.some((e) => e.importantCity)).toBe(true);
  });

  it("retains the real French surrender, Free French declaration and city news in order", () => {
    const sim = createSimulation(map, scenario);
    runToEnd(sim);
    const news = sim.events.filter((e) => e.tick > 0 && headline(e, scenario));
    const frenchFall = news.find((e) => e.type === "capitulation" && e.countries[0] === "FRA");
    const freeFrenchWar = news.find((e) => e.type === "war" && e.countries[0] === "FFR");
    expect(frenchFall).toBeDefined(); expect(freeFrenchWar).toBeDefined();
    const queue = new NewsQueue();
    for (const e of news) queue.add({ date: e.date, text: headline(e, scenario)! }, 0);
    const displayed: string[] = [];
    for (let now = 0; now <= news.length * 100; now += 100) {
      queue.update(now);
      if (queue.current) displayed.push(queue.current.text);
    }
    expect(displayed).toContain(headline(frenchFall!, scenario));
    expect(displayed).toContain(headline(freeFrenchWar!, scenario));
    expect(queue.items.map((n) => n.text)).toEqual(news.map((e) => headline(e, scenario)));
  });
});
