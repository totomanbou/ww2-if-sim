import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSimulation, runToEnd } from "../index";
import type { Scenario, SimMap } from "../types";

const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as SimMap;
const scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8")) as Scenario;

describe("Italian surrender on the historical preset", () => {
  it.each([1, 2])("keeps surrender effective after German recaptures and finishes seed %i without a ghost Italy", (seed) => {
    const sim = createSimulation(map, scenario, { seed });
    const result = runToEnd(sim);
    const italy = sim.tags.indexOf("ITA");
    expect(sim.events.some((e) => e.type === "capitulation" && e.countries[0] === "ITA")).toBe(true);
    expect(sim.events.filter((e) => e.type === "revival" && e.countries[0] === "ITA")).toEqual([]);
    expect(sim.capitulated[italy]).toBe(1);
    expect(sim.revivedAwaitingCapital[italy]).toBe(0);
    expect(result.condition).toBe("allies");
    for (const tag of ["ITA", "GER", "JAP"]) expect(sim.capitulated[sim.tags.indexOf(tag)]).toBe(1);
  });
});
