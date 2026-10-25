import { describe, expect, it } from "vitest";
import { computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createSimulation } from "../init";
import { moveFleets } from "../navy";
import { createWeeklySimulation } from "./helpers";
import { makeMap, makeScenario, setWar } from "./helpers";

// A (states 0 and 1) fights B (state 2) through zone Z1 and C (state 3) through Z2 (two routes, so Z2 scores best).
function deployment(config: Partial<SimConfig> = {}) {
  const sim = createWeeklySimulation(
    makeMap({
      owners: ["A", "A", "B", "C"], land: [], sea: [[0, 2, 1], [1, 3, 2], [0, 3, 2]],
      zones: [{ neighbors: [1, 2] }, { neighbors: [0] }, { neighbors: [0] }],
    }),
    makeScenario({ A: { industry: 0, shipbuilding: 1 }, B: { industry: 0 }, C: { industry: 0 } }),
    { config: { growthMode: "yearly", maxFleets: 1, fleetBattleChance: 0, ...config } },
  );
  setWar(sim, "A", "B");
  setWar(sim, "A", "C");
  return sim;
}

function target(config: Partial<SimConfig> = {}) {
  const sim = deployment(config);
  expect(sim.fleets).toHaveLength(1);
  moveFleets(sim);
  return sim.zoneNames[sim.fleets[0].target];
}

describe("defaults", () => {
  it("apply only to Japan", () => {
    expect(Object.keys(DEFAULT_CONFIG.fleetZones)).toEqual(["JAP"]);
    expect(DEFAULT_CONFIG.fleetZones.JAP).not.toContain("北海");
    expect(DEFAULT_CONFIG.fleetEnemyWeights).toEqual({ JAP: { CHN: 0.1 } });
    // matchupStrength also holds the Western Allies against Germany from D-Day.
    // ... and Germany against the USSR in 1941.
    expect(Object.keys(DEFAULT_CONFIG.matchupStrength)).toEqual(["JAP", "USA", "UK", "CAN", "FFR", "GER"]);
    expect(DEFAULT_CONFIG.matchupStrength.GER.against).toEqual(["SOV"]);
    for (const t of ["USA", "UK", "CAN", "FFR"]) expect(DEFAULT_CONFIG.matchupStrength[t].against).toEqual(["GER"]);
  });
});

describe("fleetZones", () => {
  it("targets the best-scored zone without the mask", () => {
    expect(target()).toBe("Z2");
  });

  it("never targets a zone outside the list even when it has the best score", () => {
    expect(target({ fleetZones: { A: ["Z1"] } })).toBe("Z1");
  });

  it("ignores unknown zone names and keeps listed known zones", () => {
    expect(target({ fleetZones: { A: ["Nowhere", "Z1"] } })).toBe("Z1");
    expect(target({ fleetZones: { A: ["Nowhere", "Z2"] } })).toBe("Z2");
  });

  it("leaves unlisted countries unaffected", () => {
    expect(target({ fleetZones: { B: ["Z1"], ABSENT: ["Z1"] } })).toBe("Z2");
  });

  it("keeps the fleet at home when no listed zone is a front", () => {
    const sim = deployment({ fleetZones: { A: ["Nowhere"] } });
    moveFleets(sim);
    expect(sim.fleets[0].target).toBe(sim.homeZone[0]);
  });
});

describe("fleetEnemyWeights", () => {
  it("weight 1 leaves the deployment unchanged", () => {
    expect(target({ fleetEnemyWeights: { A: { C: 1 } } })).toBe(target());
  });

  it("weight 0 makes routes against that enemy attract no fleet", () => {
    expect(target({ fleetEnemyWeights: { A: { C: 0 } } })).toBe("Z1");
  });

  it("a fractional weight scales the score and can flip the best zone", () => {
    // The home zone is Z2 (score 2 × weight), Z1 is two hops away (score 1 / 3).
    expect(target({ fleetEnemyWeights: { A: { C: 0.1 } } })).toBe("Z1");
    expect(target({ fleetEnemyWeights: { A: { C: 0.5 } } })).toBe("Z2");
  });

  it("ignores unknown tags and unlisted countries", () => {
    expect(target({ fleetEnemyWeights: { A: { ABSENT: 0 }, ABSENT: { C: 0 }, B: { C: 0 } } })).toBe("Z2");
  });
});

// A and B (allies, both next to E) against E (axis): A 60, B 40, E 80, as in the strength tests.
function fight(config: Partial<SimConfig> = {}, tick = 0, extraWar = false) {
  const sim = createSimulation(
    makeMap({ owners: ["A", "E", "B", "F"], land: [[0, 1], [2, 1]] }),
    makeScenario({
      A: { faction: "allies" }, B: { faction: "allies" }, E: { faction: "axis" }, F: { faction: "axis" },
    }),
    {
      seed: 17,
      config: {
        startDate: "2000-01-01", stepDays: 7, holdShare: 0, lowPriorityFronts: {}, slowAdvanceLand: {},
        capitulateOnCapitalLoss: [], indirectFrontPriority: 1, overseasDistanceFactor: 1,
        transitSpeedKmPerWeek: 1e9, frontComparisonMode: "allocated", advanceRate: 0, lossRate: 0.1, surprise: {},
        ...config,
      },
    },
  );
  sim.tick = tick;
  for (const [tag, army] of Object.entries({ A: 60, B: 40, E: 80, F: 0 })) sim.military[sim.tags.indexOf(tag)] = army;
  setWar(sim, "A", "E");
  setWar(sim, "B", "E");
  if (extraWar) setWar(sim, "A", "F");
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  return battles[0];
}

describe("matchupStrength", () => {
  const A = 0, B = 1, E = 2;

  it("raises the country's effective strength against a listed enemy", () => {
    const base = fight();
    expect(base.defStrength).toBeCloseTo(80, 8);
    const boosted = fight({ matchupStrength: { A: { against: ["E"], factor: 1.5 } } });
    expect(boosted.attStrength).toBeCloseTo(60 * 1.5 + 40, 8);
    expect(boosted.defStrength).toBeCloseTo(80, 8);
    expect(boosted.attackers).toEqual([A, B]);
    expect(boosted.attShare[0]).toBeCloseTo(90 / 130, 8);
  });

  it("applies to a defending country too", () => {
    const weak = fight({ matchupStrength: { E: { against: ["A"], factor: 0.5 } } });
    expect(weak.attStrength).toBeCloseTo(100, 8);
    expect(weak.defStrength).toBeCloseTo(40, 8);
    const strong = fight({ matchupStrength: { E: { against: ["B"], factor: 2 } } });
    expect(strong.attackers).toEqual([E]);
    expect(strong.attStrength).toBeCloseTo(160, 8);
    expect(strong.defStrength).toBeCloseTo(100, 8);
  });

  it("factor 1 gives identical results to no entry, with the same seed", () => {
    expect(fight({ matchupStrength: { A: { against: ["E"], factor: 1 } } })).toEqual(fight());
    expect(fight({ matchupStrength: {} })).toEqual(fight());
  });

  it("is not applied where only non-listed enemies fight", () => {
    const base = fight();
    // F is a listed enemy but has no army on the line (and is not at war with A).
    expect(fight({ matchupStrength: { A: { against: ["F"], factor: 3 } } })).toEqual(base);
    // F is at war with A but has no army on the line.
    expect(fight({ matchupStrength: { A: { against: ["F"], factor: 3 } } }, 0, true)).toEqual(fight({}, 0, true));
    // Unknown tags and countries absent from the scenario are ignored.
    expect(fight({ matchupStrength: { A: { against: ["ABSENT"], factor: 3 }, ABSENT: { against: ["E"], factor: 3 } } }))
      .toEqual(base);
    // A listed enemy on the same side is not an opponent.
    expect(fight({ matchupStrength: { A: { against: ["B"], factor: 3 } } })).toEqual(base);
  });

  it("respects a schedule before, between and after its dates", () => {
    const matchupStrength: SimConfig["matchupStrength"] = {
      A: { against: ["E"], factor: [["2000-01-08", 0.2], ["2000-01-22", 0.6]] },
    };
    for (const [tick, factor] of [[0, 0.2], [2, 0.4], [4, 0.6]] as const) {
      const scheduled = fight({ matchupStrength }, tick);
      const numeric = fight({ matchupStrength: { A: { against: ["E"], factor } } }, tick);
      expect(scheduled).toEqual(numeric);
      expect(scheduled.attStrength).toBeCloseTo(80, 8);
      expect(scheduled.defStrength).toBeCloseTo(60 * factor + 40, 8);
    }
  });
});
