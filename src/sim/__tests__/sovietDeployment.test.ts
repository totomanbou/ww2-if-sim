import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, deployArmies, resolveCombat } from "../combat";
import { canDeployToFront } from "../deployment";
import type { SimConfig } from "../config";
import { createWeeklySimulation, makeMap, makeScenario, setWar } from "./helpers";

function connected(mode: SimConfig["frontComparisonMode"] = "allocated", mixed = false) {
  const sim = createWeeklySimulation(makeMap({
    owners: ["SOV", "POL", "FRA", "GER", "GER"],
    lonlat: [[30, 54], [22, 52], [7, 50], [8, 50], [31, 54]],
    land: [[0, 1], [1, 2], [2, 3], [0, 4], ...(mixed ? [[0, 3] as [number, number]] : [])],
  }), makeScenario({ SOV: { faction: "allies" }, POL: { faction: "allies" }, FRA: { faction: "allies" }, GER: { faction: "axis" } }), {
    config: { frontComparisonMode: mode, closedLand: [], landingBans: [], regionCap: {}, regionGroupCaps: [], holdShare: 0,
      transitSpeedKmPerWeek: 1e9, encirclement: false },
  });
  for (const tag of ["SOV", "POL", "FRA"]) setWar(sim, tag, "GER");
  return sim;
}

describe("no Soviet deployment to the western front", () => {
  it.each(["allocated", "nation", "divided"] as const)("enforces the ban even with a friendly land path in %s mode", (mode) => {
    const sim = connected(mode), fronts = computeFronts(sim), sov = sim.tags.indexOf("SOV"), west = fronts.line[2];
    expect(fronts.lineCountries.get(west)?.has(sov)).toBe(true); // still a belligerent, with no deployed army here
    expect(canDeployToFront(sim, fronts, west, sov)).toBe(false);
    const a = allocateArmies(sim, fronts);
    expect(a.get(west)?.get(sov) ?? 0).toBe(0);
    expect(a.get(fronts.line[0])?.get(sov)).toBeGreaterThan(0);
  });

  it("does not exempt Soviet-held states on a mixed western line", () => {
    const sim = connected("allocated", true), fronts = computeFronts(sim), sov = sim.tags.indexOf("SOV");
    expect(fronts.lineFront.get(fronts.line[2])?.has(sov)).toBe(true);
    expect(allocateArmies(sim, fronts).get(fronts.line[2])?.get(sov) ?? 0).toBe(0);
  });

  it("rejects stale or externally supplied deployment targets for a forbidden line", () => {
    const sim = connected(), fronts = computeFronts(sim), sov = sim.tags.indexOf("SOV"), west = fronts.line[2];
    sim.deployed.set(sov, new Map([[0, 1]]));
    const deployed = deployArmies(sim, fronts, new Map([[west, new Map([[sov, sim.military[sov]]])]]));
    expect(deployed.get(west)?.get(sov) ?? 0).toBe(0);
    resolveCombat(sim, fronts);
    expect(sim.frontArmies.find((f) => f.line === west)?.armies.some(([c]) => c === sov)).toBe(false);
  });

  it("can be explicitly disabled for isolated comparisons", () => {
    const sim = connected(); sim.config.frontDeploymentBans = [];
    const fronts = computeFronts(sim), sov = sim.tags.indexOf("SOV");
    expect(allocateArmies(sim, fronts).get(fronts.line[2])?.get(sov)).toBeGreaterThan(0);
  });

  it("keeps Soviet and Polish fronts advancing from the east into Berlin available", () => {
    const sim = createWeeklySimulation(makeMap({ owners: ["SOV", "POL", "GER"], land: [[0, 1], [1, 2]],
      lonlat: [[30, 54], [14, 52], [13.4, 52.5]] }), makeScenario({ SOV: { faction: "allies" },
      POL: { faction: "allies" }, GER: { faction: "axis" } }), { config: { closedLand: [], regionCap: {}, regionGroupCaps: [] } });
    setWar(sim, "SOV", "GER"); setWar(sim, "POL", "GER");
    const fronts = computeFronts(sim), sov = sim.tags.indexOf("SOV");
    expect(canDeployToFront(sim, fronts, fronts.line[1], sov)).toBe(true);
    expect(allocateArmies(sim, fronts).get(fronts.line[1])?.get(sov)).toBeGreaterThan(0);
  });

  it("also prevents a Soviet-owned western beachhead from becoming a loophole", () => {
    const sim = createWeeklySimulation(makeMap({ owners: ["SOV", "FRA", "GER"], land: [[0, 1], [1, 2]],
      lonlat: [[30, 54], [4, 50], [5, 50]] }), makeScenario({ SOV: { faction: "allies" },
      FRA: { faction: "allies" }, GER: { faction: "axis" } }));
    const sov = sim.tags.indexOf("SOV"); sim.owner[1] = sov;
    setWar(sim, "SOV", "GER");
    const fronts = computeFronts(sim);
    expect(canDeployToFront(sim, fronts, fronts.line[1], sov)).toBe(false);
  });

  it("does not make Soviet-held western territory invulnerable when Soviet troops cannot be sent there", () => {
    const sim = createWeeklySimulation(makeMap({ owners: ["SOV", "FRA", "GER"], land: [[1, 2]],
      lonlat: [[30, 54], [4, 50], [5, 50]] }), makeScenario({ SOV: { faction: "allies" },
      FRA: { faction: "allies" }, GER: { faction: "axis" } }), { config: { encirclement: false,
      transitSpeedKmPerWeek: 1e9, regionCap: {}, regionGroupCaps: [], advanceRate: 6, advanceMax: 6 } });
    sim.owner[1] = sim.tags.indexOf("SOV"); sim.military[sim.tags.indexOf("GER")] = 10000;
    setWar(sim, "SOV", "GER");
    expect(resolveCombat(sim, computeFronts(sim)).some((b) => b.captures.includes(1))).toBe(true);
  });
});
