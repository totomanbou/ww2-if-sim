import { describe, expect, it } from "vitest";
import { lostShare } from "../capitulation";
import { DEFAULT_CONFIG } from "../config";
import { createSimulation } from "../init";
import { makeMap, makeScenario } from "./helpers";

/** J owns 4 states: 0–1 its own land, 2–3 taken from C before the start (formerOwner C). */
function fixture(ownLandOnly: string[]) {
  const map = makeMap({ owners: ["J", "J", "J", "J", "C", "A"], land: [] });
  map.states[2].formerOwner = "C";
  map.states[3].formerOwner = "C";
  return createSimulation(map, makeScenario({ J: { faction: "axis" }, C: { faction: "allies" }, A: { faction: "allies" } }),
    { config: { capitulationOwnLandOnly: ownLandOnly } });
}

describe("capitulation share over own land only (config.capitulationOwnLandOnly)", () => {
  it("defaults to Japan", () => {
    expect(DEFAULT_CONFIG.capitulationOwnLandOnly).toEqual(["JAP"]);
  });

  it("ignores territory taken from others and normalizes over the own land", () => {
    const sim = fixture(["J"]);
    const j = sim.tags.indexOf("J"), a = sim.tags.indexOf("A");
    sim.owner[0] = a;
    expect(lostShare(sim, j)).toBeCloseTo(sim.weight[0] / (sim.weight[0] + sim.weight[1]), 10);
    sim.owner[2] = a; sim.owner[3] = a; // losing occupied land changes nothing
    expect(lostShare(sim, j)).toBeCloseTo(sim.weight[0] / (sim.weight[0] + sim.weight[1]), 10);
    sim.owner[1] = a;
    expect(lostShare(sim, j)).toBeCloseTo(1, 10);
  });

  it("counts all original territory for countries not listed", () => {
    const sim = fixture([]);
    const j = sim.tags.indexOf("J"), a = sim.tags.indexOf("A");
    sim.owner[0] = a; sim.owner[2] = a;
    expect(lostShare(sim, j)).toBeCloseTo(sim.weight[0] + sim.weight[2], 10);
  });
});
