import { describe, expect, it } from "vitest";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import type { VictoryCity } from "../mapTypes";
import { alliedVictoryCountries, checkVictory } from "../victory";
import { makeMap, makeScenario } from "./helpers";

function victorySim(axisBWeeks?: number) {
  return createSimulation(
    makeMap({
      owners: ["ALY", "ALY", "ALY", "ALY", "AXI", "AXI", "AXI"],
      land: [],
      cities: { London: 0, Moscow: 1, Honolulu: 2, Paris: 3, Rome: 4, Berlin: 5, Tokyo: 6 },
    }),
    makeScenario({ ALY: { faction: "allies" }, AXI: { faction: "axis" } }),
    { config: axisBWeeks === undefined ? {} : { axisBWeeks } },
  );
}

function conditionB(sim: ReturnType<typeof victorySim>) {
  for (const city of ["Moscow", "Paris"] as const) {
    sim.owner[sim.cities[city]] = sim.tags.indexOf("AXI");
  }
}

describe("victory conditions", () => {
  it("starts with no victory and awards axis A when London, Moscow and Honolulu fall", () => {
    const sim = victorySim();
    expect(checkVictory(sim)).toBeNull();
    for (const city of ["London", "Moscow", "Honolulu"] as const) {
      sim.owner[sim.cities[city]] = sim.tags.indexOf("AXI");
    }
    expect(checkVictory(sim)).toBe("axisA");
  });

  it.each<VictoryCity>(["London", "Moscow", "Honolulu"])(
    "cannot win axis A while %s remains allied",
    (missing) => {
      const sim = victorySim();
      for (const city of ["London", "Moscow", "Honolulu"] as const) {
        if (city !== missing) sim.owner[sim.cities[city]] = sim.tags.indexOf("AXI");
      }
      expect(checkVictory(sim)).toBeNull();
    },
  );

  it("requires all 156 consecutive checks for axis B", () => {
    const sim = victorySim();
    conditionB(sim);
    for (let i = 0; i < 155; i++) expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(155);
    expect(checkVictory(sim)).toBe("axisB");
    expect(sim.axisBWeeks).toBe(156);
  });

  it("resets axis B on a Paris recapture and requires another full 156 checks", () => {
    const sim = victorySim();
    conditionB(sim);
    for (let i = 0; i < 155; i++) expect(checkVictory(sim)).toBeNull();
    sim.owner[sim.cities.Paris] = sim.tags.indexOf("ALY");
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0);
    conditionB(sim);
    for (let i = 0; i < 155; i++) expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
  });

  it("honors an axis B duration of three checks", () => {
    const sim = victorySim(3);
    conditionB(sim);
    expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
    expect(sim.axisBWeeks).toBe(3);
  });

  it("counts axis B with Honolulu still allied (Honolulu is not part of condition B)", () => {
    const sim = victorySim(2);
    conditionB(sim);
    sim.owner[sim.cities.Honolulu] = sim.tags.indexOf("ALY");
    expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
  });

  it.each<VictoryCity>(["Moscow", "Paris"])(
    "does not count axis B while %s is held by allies",
    (missing) => {
      const sim = victorySim(3);
      conditionB(sim);
      expect(checkVictory(sim)).toBeNull();
      sim.owner[sim.cities[missing]] = sim.tags.indexOf("ALY");
      expect(checkVictory(sim)).toBeNull();
      expect(sim.axisBWeeks).toBe(0);
    },
  );

  it("requires surrender rather than just allied occupation of Rome, Berlin and Tokyo", () => {
    const sim = victorySim();
    for (const city of ["Rome", "Berlin", "Tokyo"] as const) {
      sim.owner[sim.cities[city]] = sim.tags.indexOf("ALY");
    }
    expect(checkVictory(sim)).toBeNull();
    sim.capitulated[sim.tags.indexOf("AXI")] = 1;
    expect(checkVictory(sim)).toBe("allies");
  });

  it.each<VictoryCity>(["Rome", "Berlin", "Tokyo"])(
    "does not award allied victory while %s is still axis",
    (missing) => {
      const sim = victorySim();
      for (const city of ["Rome", "Berlin", "Tokyo"] as const) {
        if (city !== missing) sim.owner[sim.cities[city]] = sim.tags.indexOf("ALY");
      }
      expect(checkVictory(sim)).toBeNull();
    },
  );

  it("undoes fallen status and logs cityFall then cityRecapture through step", () => {
    const sim = victorySim();
    sim.owner[sim.cities.Paris] = sim.tags.indexOf("AXI");
    step(sim);
    expect(sim.cityFallen.Paris).toBe(true);
    sim.owner[sim.cities.Paris] = sim.tags.indexOf("ALY");
    step(sim);
    expect(sim.cityFallen.Paris).toBe(false);
    expect(sim.events.filter((event) => event.city === "Paris")).toMatchObject([
      { type: "cityFall", tick: 0, countries: ["AXI"] },
      { type: "cityRecapture", tick: 1, countries: ["ALY"] },
    ]);
  });
});

describe("Allied victory by major-country capitulation", () => {
  function majorSim() {
    return createSimulation(
      makeMap({
        owners: ["UK", "SOV", "USA", "FRA", "ITA", "GER", "JAP"],
        land: [],
        cities: { London: 0, Moscow: 1, Honolulu: 2, Paris: 3, Rome: 4, Berlin: 5, Tokyo: 6 },
      }),
      makeScenario({
        UK: { faction: "allies" }, SOV: { faction: "allies" }, USA: { faction: "allies" }, FRA: { faction: "allies" },
        ITA: { faction: "axis" }, GER: { faction: "axis" }, JAP: { faction: "axis" },
      }),
    );
  }
  function surrender(sim: ReturnType<typeof majorSim>, ...tags: string[]) {
    for (const tag of tags) sim.capitulated[sim.tags.indexOf(tag)] = 1;
  }

  it("targets Italy, Germany and Japan once each with the historical factions", () => {
    const sim = majorSim();
    expect(alliedVictoryCountries(sim).map((c) => sim.tags[c])).toEqual(["ITA", "GER", "JAP"]);
    expect(alliedVictoryCountries(victorySim())).toHaveLength(1);
  });

  it("does not finish when all three capitals are occupied but their countries are still fighting", () => {
    const sim = majorSim();
    for (const city of ["Rome", "Berlin", "Tokyo"] as const) sim.owner[sim.cities[city]] = sim.tags.indexOf("UK");
    surrender(sim, "GER", "ITA");
    expect(checkVictory(sim)).toBeNull();
    surrender(sim, "JAP");
    expect(checkVictory(sim)).toBe("allies");
  });

  it("wins on the countries' surrender flags even if their capital ownership has not changed", () => {
    const sim = majorSim();
    surrender(sim, "JAP", "GER", "ITA");
    expect(checkVictory(sim)).toBe("allies");
  });

  it.each(["JAP", "GER", "ITA"])("cannot win while %s is still fighting", (missing) => {
    const sim = majorSim();
    surrender(sim, ...["JAP", "GER", "ITA"].filter((tag) => tag !== missing));
    expect(checkVictory(sim)).toBeNull();
  });

  it("requires a revived target to surrender again", () => {
    const sim = majorSim();
    surrender(sim, "JAP", "GER", "ITA");
    expect(checkVictory(sim)).toBe("allies");
    sim.capitulated[sim.tags.indexOf("GER")] = 0;
    expect(checkVictory(sim)).toBeNull();
  });

  it.each(["allies", "neutral"] as const)("does not require Italy to surrender after it is changed to %s", (side) => {
    const sim = majorSim();
    sim.faction[sim.tags.indexOf("ITA")] = side;
    surrender(sim, "GER", "JAP");
    expect(alliedVictoryCountries(sim).map((c) => sim.tags[c])).toEqual(["GER", "JAP"]);
    expect(checkVictory(sim)).toBe("allies");
  });

  it("also requires the USA to surrender when it is changed to the Axis", () => {
    const sim = majorSim();
    sim.faction[sim.tags.indexOf("USA")] = "axis";
    surrender(sim, "GER", "JAP", "ITA");
    sim.owner[sim.cities.Honolulu] = sim.tags.indexOf("UK");
    expect(checkVictory(sim)).toBeNull();
    surrender(sim, "USA");
    expect(checkVictory(sim)).toBe("allies");
  });

  it("finishes through the engine after the last major actually capitulates in that step", () => {
    const sim = majorSim();
    surrender(sim, "GER", "ITA");
    sim.owner[sim.cities.Tokyo] = sim.tags.indexOf("USA");
    step(sim);
    expect(sim.capitulated[sim.tags.indexOf("JAP")]).toBe(1);
    expect(sim.result?.condition).toBe("allies");
    expect(sim.events.findIndex((e) => e.type === "capitulation" && e.countries.includes("JAP"))).toBeLessThan(
      sim.events.findIndex((e) => e.type === "victory"),
    );
  });
});
