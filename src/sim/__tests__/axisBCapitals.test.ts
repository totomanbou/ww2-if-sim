import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createSimulation } from "../init";
import type { Faction, Scenario, SimMap } from "../types";
import { capitalHeldByAxis, checkVictory, victoryTargets } from "../victory";
import { makeMap, makeScenario } from "./helpers";

function fixture(config: Partial<SimConfig> = {}, chinaFaction: Faction = "allies") {
  // Moscow/Paris fall on state 0. London/Honolulu remain allied on state 3,
  // while Rome/Berlin/Tokyo remain axis on state 1, so neither other victory can fire.
  const map = makeMap({ owners: ["D", "A", "N", "D", "CHN", "C2", "A2"], land: [],
    cities: { Moscow: 0, Paris: 0, London: 3, Honolulu: 3, Rome: 1, Berlin: 1, Tokyo: 1 } });
  const sim = createSimulation(map, makeScenario({
    A: { faction: "axis" }, A2: { faction: "axis" }, D: { faction: "allies" },
    CHN: { faction: chinaFaction }, C2: { faction: "allies" }, N: {},
  }), { config: { axisBWeeks: 3, ...config } });
  sim.owner[0] = sim.tags.indexOf("A");
  return sim;
}

describe("Axis condition B capital requirements", () => {
  it("defaults to China's capital as an additional target", () => {
    expect(DEFAULT_CONFIG.axisBCapitals).toEqual(["CHN"]);
    const sim = fixture();
    expect(victoryTargets(sim).axisB).toBe(true);
    expect(victoryTargets(sim).axisBCapitals).toEqual([sim.tags.indexOf("CHN")]);
  });

  it("does not accumulate B weeks while the listed allied capital remains allied", () => {
    const sim = fixture();
    for (let i = 0; i < 8; i++) {
      expect(checkVictory(sim)).toBeNull();
      expect(sim.axisBWeeks).toBe(0);
    }
  });

  it("accumulates six half-weeks only after the additional capital falls", () => {
    const sim = fixture(), china = sim.tags.indexOf("CHN");
    expect(capitalHeldByAxis(sim, china)).toBe(false);
    expect(checkVictory(sim)).toBeNull();
    sim.owner[sim.capital[china]] = sim.tags.indexOf("A");
    expect(capitalHeldByAxis(sim, china)).toBe(true);
    for (let i = 1; i <= 5; i++) {
      expect(checkVictory(sim)).toBeNull();
      expect(sim.axisBWeeks).toBe(i / 2);
    }
    expect(checkVictory(sim)).toBe("axisB");
    expect(sim.axisBWeeks).toBe(3);
  });

  it.each(["CHN", "N"])("resets the consecutive duration when the capital passes to %s", (newOwner) => {
    const sim = fixture(), cap = sim.capital[sim.tags.indexOf("CHN")], axis = sim.tags.indexOf("A");
    sim.owner[cap] = axis;
    checkVictory(sim); checkVictory(sim);
    expect(sim.axisBWeeks).toBe(1);
    sim.owner[cap] = sim.tags.indexOf(newOwner);
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0);
    sim.owner[cap] = axis;
    for (let i = 0; i < 5; i++) expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
  });

  it("accepts any axis country's occupation of the fixed capital", () => {
    const sim = fixture(), china = sim.tags.indexOf("CHN");
    sim.owner[sim.capital[china]] = sim.tags.indexOf("A2");
    expect(capitalHeldByAxis(sim, china)).toBe(true);
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0.5);
  });

  it("requires every listed allied capital and resets if either is lost", () => {
    const sim = fixture({ axisBCapitals: ["CHN", "C2"] });
    const china = sim.tags.indexOf("CHN"), other = sim.tags.indexOf("C2"), axis = sim.tags.indexOf("A");
    expect(victoryTargets(sim).axisBCapitals).toEqual([china, other]);
    sim.owner[sim.capital[china]] = axis;
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0);
    sim.owner[sim.capital[other]] = axis;
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0.5);
    sim.owner[sim.capital[other]] = other;
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0);
  });

  it.each(["axis", "neutral"] as const)("ignores a listed country on the %s side", (faction) => {
    const sim = fixture({}, faction);
    expect(victoryTargets(sim).axisBCapitals).toEqual([]);
    for (let i = 0; i < 5; i++) expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
  });

  it("ignores an absent country", () => {
    const sim = fixture({ axisBCapitals: ["MISSING"] });
    expect(sim.tags).not.toContain("MISSING");
    expect(victoryTargets(sim).axisBCapitals).toEqual([]);
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0.5);
  });

  it("ignores a listed allied country without a capital", () => {
    const sim = fixture();
    sim.capital[sim.tags.indexOf("CHN")] = -1;
    expect(victoryTargets(sim).axisBCapitals).toEqual([]);
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0.5);
  });

  it("allows an empty requirement list to restore the city-only B condition", () => {
    const sim = fixture({ axisBCapitals: [] });
    for (let i = 0; i < 5; i++) expect(checkVictory(sim)).toBeNull();
    expect(checkVictory(sim)).toBe("axisB");
  });

  it("still requires Moscow and Paris even after the listed capital falls", () => {
    const sim = fixture(), china = sim.tags.indexOf("CHN");
    sim.owner[sim.capital[china]] = sim.tags.indexOf("A");
    sim.owner[0] = sim.tags.indexOf("D");
    expect(checkVictory(sim)).toBeNull();
    expect(sim.axisBWeeks).toBe(0);
  });

  it("uses China's country index on the real historical preset", () => {
    const map: SimMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8"));
    const scenario: Scenario = JSON.parse(readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"));
    const sim = createSimulation(map, scenario), china = sim.tags.indexOf("CHN");
    expect(china).toBeGreaterThanOrEqual(0);
    expect(sim.faction[china]).toBe("allies");
    expect(sim.capital[china]).toBeGreaterThanOrEqual(0);
    expect(victoryTargets(sim).axisBCapitals).toEqual([china]);
  });
});
