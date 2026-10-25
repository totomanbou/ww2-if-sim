import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { fleetPower, hasSuperiority } from "../navy";
import type { Faction, SimState } from "../types";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

const ban: SimConfig["landingBans"][number] = {
  name: "Test coast", faction: "allies", except: [], boxes: [[10, 30, 20, 50]], until: "1944-06-06",
};

function fixture({
  config = {}, land = false, lonlat = [15, 40], faction = "allies", original = "D",
}: {
  config?: Partial<SimConfig>; land?: boolean; lonlat?: [number, number]; faction?: Faction; original?: string;
} = {}) {
  // State 1 can be occupied D territory originally belonging to E (for exceptLand checks).
  const sim = createSimulation(
    makeMap({ owners: ["A", original, "D"], land: land ? [[0, 1]] : [], sea: [[0, 1, 0]],
      zones: [{ neighbors: [] }], lonlat: [[0, 0], lonlat, [25, 40]] }),
    makeScenario({ A: { faction }, D: { faction: faction === "axis" ? "allies" : "axis" },
      ...(original === "D" ? {} : { [original]: { faction: "allies" as const } }) }),
    { seed: 17, config: {
      startDate: "1944-06-05", landingBans: [ban], encirclement: false,
      frontComparisonMode: "nation", advanceRate: 2, advanceMax: 1, lossRate: 0,
      navalPenalty: 0.5, landingWithoutNavy: {}, slowAdvanceLand: {}, strengthFactors: {},
      ...config,
    } },
  );
  const a = sim.tags.indexOf("A"), d = sim.tags.indexOf("D");
  sim.owner[1] = d;
  setWar(sim, "A", "D");
  sim.military.fill(0);
  sim.military[a] = 100;
  sim.military[d] = 10;
  sim.fleets = [{ country: a, zone: 0, target: 0, strength: 100 }];
  expect(hasSuperiority(sim, fleetPower(sim), a, d, 0)).toBe(true);
  return sim;
}

function expectLanding(sim: SimState, finalOwner = "A") {
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  expect(battles[0].captures).toEqual([1]);
  expect(battles[0].captors).toEqual([sim.tags.indexOf("A")]);
  applyBattles(sim, battles);
  expect(sim.owner[1]).toBe(sim.tags.indexOf(finalOwner));
}

describe("date-limited landing bans", () => {
  it("blocks a landing before until even with naval superiority; removing the ban permits it", () => {
    const sim = fixture(), owners = sim.owner.slice(), military = sim.military.slice();
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toEqual([]);
    applyBattles(sim, battles);
    expect(sim.owner).toEqual(owners);
    expect(sim.military).toEqual(military);
    expectLanding(fixture({ config: { landingBans: [] } }));
  });

  it.each(["1944-06-06", "1944-06-07"])("allows a landing on/after until: %s", (startDate) => {
    expectLanding(fixture({ config: { startDate } }));
  });

  it("uses tickTime and expires a cached ban when the simulation advances", () => {
    const sim = fixture({ config: { startDate: "1944-05-30" } });
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
    sim.tick = 1; // June 6, with the original startMs unchanged.
    expectLanding(sim);
  });

  it("allows an attacker listed in except before until", () => {
    expectLanding(fixture({ config: { landingBans: [{ ...ban, except: ["A"] }] } }));
  });

  it("leaves land attacks into the banned box unaffected, even when a sea route also exists", () => {
    expectLanding(fixture({ land: true }));
  });

  it.each(["axis", "neutral"] as const)("leaves an attacker of faction %s unaffected by an allied ban", (faction) => {
    expectLanding(fixture({ faction }));
  });

  it("supports bans on the axis faction too", () => {
    const sim = fixture({ faction: "axis", config: { landingBans: [{ ...ban, faction: "axis" }] } });
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
  });

  it.each([[9, 40], [21, 40], [15, 29], [15, 51]] as [number, number][])(
    "allows landings outside the box at lon=%s, lat=%s", (lon, lat) => {
      expectLanding(fixture({ lonlat: [lon, lat] }));
    },
  );

  it.each([[10, 30], [20, 50]] as [number, number][])("includes the box boundary at %s/%s", (lon, lat) => {
    const sim = fixture({ lonlat: [lon, lat] });
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
  });

  it("checks all boxes in an entry", () => {
    const sim = fixture({ config: { landingBans: [{ ...ban, boxes: [[-20, -20, -10, -10], ...ban.boxes] }] } });
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
  });

  it("exempts exceptLand using origOwner even after another country occupies the state", () => {
    const sim = fixture({ original: "E", config: { landingBans: [{ ...ban, exceptLand: ["E"] }] } });
    expect(sim.origOwner[1]).toBe(sim.tags.indexOf("E"));
    expect(sim.owner[1]).toBe(sim.tags.indexOf("D"));
    expectLanding(sim, "E"); // The successful landing liberates the allied original owner's state.
  });

  it("does not exempt land merely because its current occupier is in exceptLand", () => {
    const sim = fixture({ original: "E", config: { landingBans: [{ ...ban, exceptLand: ["D"] }] } });
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
  });

  it("keeps another overlapping ban active when one ban exempts the attacker", () => {
    const sim = fixture({ config: { landingBans: [{ ...ban, except: ["A"] }, { ...ban, name: "Second ban" }] } });
    expect(resolveCombat(sim, computeFronts(sim))).toEqual([]);
  });

  it("defaults to two allied bans ending at Sicily and Normandy, both exempting SOV, and lasting axis bans on the Americas and India", () => {
    expect(DEFAULT_CONFIG.landingBans).toHaveLength(4);
    expect(DEFAULT_CONFIG.landingBans.map(({ until }) => until)).toEqual(["1943-07-10", "1944-06-06", "9999-12-31", "9999-12-31"]);
    // Lasting axis bans: the Americas and the Indian mainland.
    for (const ban of DEFAULT_CONFIG.landingBans.slice(2)) expect(ban).toMatchObject({ faction: "axis", except: [] });
    for (const entry of DEFAULT_CONFIG.landingBans.slice(0, 2)) {
      expect(entry.faction).toBe("allies");
      expect(entry.except).toEqual(["SOV"]);
      expect(entry.boxes.length).toBeGreaterThan(0);
    }
    expect(DEFAULT_CONFIG.landingBans[1].exceptLand).toEqual(["UK", "IRE"]);
  });
});
