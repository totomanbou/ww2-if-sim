import { describe, expect, it } from "vitest";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import type { VictoryCity } from "../mapTypes";
import { checkVictory } from "../victory";
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

  it("awards allied victory when Rome, Berlin and Tokyo are all allied", () => {
    const sim = victorySim();
    for (const city of ["Rome", "Berlin", "Tokyo"] as const) {
      sim.owner[sim.cities[city]] = sim.tags.indexOf("ALY");
    }
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
