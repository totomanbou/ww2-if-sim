import { describe, expect, it } from "vitest";
import { allocateArmies, computeFronts, deployArmies, resolveCombat } from "../combat";
import { step } from "../engine";
import { landingPreference, landingTheatreStates } from "../landingFronts";
import type { SimConfig } from "../config";
import { createWeeklySimulation, makeMap, makeScenario, setWar } from "./helpers";

const config: Partial<SimConfig> = {
  landingBans: [], regionCap: {}, regionGroupCaps: [], regionPriority: {}, closedLand: [],
  holdRatio: 0, holdShare: 0, lowPriorityFronts: {}, enemyPriority: {}, encirclement: false,
  capitulateOnCapitalLoss: [], transitSpeedKmPerWeek: 1e9, overseasDistanceFactor: 1,
};

function approaches(overrides: Partial<SimConfig> = {}, bridgehead = false) {
  const map = makeMap({
    owners: ["UK", "FRA", "GER", "SOV", "GER", "FRA"],
    lonlat: [[-1, 51], [0, 49], [8, 54], [30, 53], [29, 53], [1, 49]],
    land: [[3, 4], ...(bridgehead ? [[1, 5] as [number, number]] : [])],
    sea: [[0, 1], [0, 2], [0, 3]],
  });
  const sim = createWeeklySimulation(map, makeScenario({
    UK: { faction: "allies" }, FRA: { faction: "allies" }, GER: { faction: "axis" }, SOV: { faction: "allies" },
  }), { config: { ...config, ...overrides } });
  sim.owner[1] = sim.tags.indexOf("GER");
  if (bridgehead) sim.owner[5] = sim.tags.indexOf("UK");
  setWar(sim, "UK", "GER"); setWar(sim, "SOV", "GER");
  for (const tag of ["UK", "GER", "SOV"]) sim.military[sim.tags.indexOf(tag)] = 100;
  sim.fleets = [{ country: sim.tags.indexOf("UK"), zone: 0, target: 0, strength: 100 }];
  return sim;
}

describe("separated western landing approaches", () => {
  it("separates French and German beaches even with one shared British embarkation state", () => {
    const fronts = computeFronts(approaches());
    const names = [...fronts.theatreNames];
    expect(names.map(([, n]) => n).sort()).toEqual(["ドイツ方面", "フランス方面"]);
    const fr = names.find(([, n]) => n === "フランス方面")![0];
    const ge = names.find(([, n]) => n === "ドイツ方面")![0];
    expect(fronts.statesByLine.get(fr)).toEqual(expect.arrayContaining([0, 1]));
    expect(fronts.statesByLine.get(ge)).toEqual(expect.arrayContaining([0, 2]));
    expect(fronts.statesByLine.get(fr)).not.toContain(2);
    expect(fronts.statesByLine.get(ge)).not.toContain(1);
    expect(fronts.line[3]).not.toBe(fr); expect(fronts.line[3]).not.toBe(ge);
  });

  it("keeps land combat at a beachhead separate from the sea preparation line", () => {
    const fronts = computeFronts(approaches({}, true));
    const fr = [...fronts.theatreNames].find(([, n]) => n === "フランス方面")![0];
    expect(fronts.line[1]).not.toBe(fr);
    expect(fronts.statesByLine.get(fronts.line[1])).toEqual(expect.arrayContaining([1, 5]));
    expect(fronts.statesByLine.get(fronts.line[1])).not.toContain(0);
  });

  it("preserves the unsplit topology when the feature is disabled", () => {
    const fronts = computeFronts(approaches({ landingTheatres: [] }));
    expect(fronts.line[0]).toBe(fronts.line[1]);
    expect(fronts.line[0]).toBe(fronts.line[2]);
    expect(fronts.theatreNames.size).toBe(0);
  });

  it("keeps a defence-only coast out of the offensive allocation once a land attack already exists", () => {
    const sim = approaches({}, true), fronts = computeFronts(sim), uk = sim.tags.indexOf("UK");
    const fr = [...fronts.theatreNames].find(([, n]) => n === "フランス方面")![0];
    const allocated = allocateArmies(sim, fronts);
    expect(allocated.get(fr)?.get(uk) ?? 0).toBe(0);
    expect(allocated.get(fronts.line[1])?.get(uk)).toBeGreaterThan(0);
  });

  it("keeps bidirectional targets and sea routes assigned to the correct approach", () => {
    const sim = approaches(), fronts = computeFronts(sim), uk = sim.tags.indexOf("UK"), ge = sim.tags.indexOf("GER");
    for (const [l, name] of fronts.theatreNames) {
      const targets = fronts.targetsByLine.get(l)!.get(uk * sim.tags.length + ge)!;
      expect([...targets.sea.keys()]).toEqual([name === "フランス方面" ? 1 : 2]);
      expect(targets.seaRoutes.get(name === "フランス方面" ? 1 : 2)).toHaveLength(1);
      expect(fronts.targetsByLine.get(l)!.get(ge * sim.tags.length + uk)!.sea.has(0)).toBe(true);
    }
  });

  it("never duplicates a country's army when one state belongs to two preparation lines", () => {
    const sim = approaches(), fronts = computeFronts(sim);
    for (const armies of [allocateArmies(sim, fronts), deployArmies(sim, fronts, allocateArmies(sim, fronts))]) {
      for (let c = 0; c < sim.tags.length; c++) {
        const total = [...armies.values()].reduce((v, m) => v + (m.get(c) ?? 0), 0);
        expect(total).toBeLessThanOrEqual(sim.military[c] + 1e-8);
      }
    }
  });

  it("uses original geography after occupation and leaves overseas French land outside the theatre", () => {
    const sim = approaches(), mask = landingTheatreStates(sim);
    expect(mask[1]).toBe(1); expect(mask[2]).toBe(2);
    const colony = createWeeklySimulation(makeMap({ owners: ["FRA"], land: [], core: [false], lonlat: [[0, 49]] }),
      makeScenario({ FRA: { faction: "allies" } }));
    expect(landingTheatreStates(colony)[0]).toBe(0);
  });

  it("emits distinct names and different soldier totals for the observation panel", () => {
    const sim = approaches();
    resolveCombat(sim, computeFronts(sim));
    expect(sim.frontArmies.map((f) => f.theatre)).toEqual(expect.arrayContaining(["フランス方面", "ドイツ方面"]));
    const uk = sim.tags.indexOf("UK");
    const on = (name: string) => sim.frontArmies.find((f) => f.theatre === name)!.armies.find(([c]) => c === uk)?.[1] ?? 0;
    expect(on("フランス方面")).toBeGreaterThan(on("ドイツ方面"));
  });
});

describe("landing preferences", () => {
  it("favours France while retaining nonzero German landing effort", () => {
    const sim = approaches(), uk = sim.tags.indexOf("UK"), ge = sim.tags.indexOf("GER"), sov = sim.tags.indexOf("SOV");
    expect(landingPreference(sim, uk, 1)).toBe(1);
    expect(landingPreference(sim, uk, 2)).toBe(0.2);
    expect(landingPreference(sim, ge, 1)).toBe(1);
    expect(landingPreference(sim, sov, 2)).toBe(1);
  });

  function coast(land: boolean, preferred = true, attack = 100) {
    const sim = createWeeklySimulation(makeMap({ owners: ["UK", "GER"], lonlat: [[-1, 51], [8, 54]],
      land: land ? [[0, 1]] : [], sea: [[0, 1]] }),
    makeScenario({ UK: { faction: "allies" }, GER: { faction: "axis" } }),
    { config: { ...config, ...(preferred ? {} : { landingPreferences: [] }) } });
    sim.military[sim.tags.indexOf("UK")] = attack;
    sim.military[sim.tags.indexOf("GER")] = 30;
    sim.fleets = [{ country: sim.tags.indexOf("UK"), zone: 0, target: 0, strength: 100 }];
    setWar(sim, "UK", "GER");
    return sim;
  }

  it("limits direct German landing effort even if it is the only available sea front", () => {
    const sim = coast(false), plain = coast(false, false);
    expect(resolveCombat(sim, computeFronts(sim))).toHaveLength(0);
    expect(resolveCombat(plain, computeFronts(plain))).toHaveLength(1);
  });

  it("still permits a direct German landing with overwhelming amphibious superiority", () => {
    const sim = coast(false, true, 1000);
    expect(resolveCombat(sim, computeFronts(sim))).toHaveLength(1);
  });

  it("does not penalise overland attacks or create a second landing front at an existing land contact", () => {
    const sim = coast(true), plain = coast(true, false);
    expect(computeFronts(sim).lineCountries.size).toBe(1);
    expect(resolveCombat(sim, computeFronts(sim))).toEqual(resolveCombat(plain, computeFronts(plain)));
  });
});

describe("Soviet support follows the land front", () => {
  it("blocks overseas support of British landings but keeps the eastern allocation", () => {
    const sim = approaches(), sov = sim.tags.indexOf("SOV"), fronts = computeFronts(sim), a = allocateArmies(sim, fronts);
    for (const [l] of fronts.theatreNames) expect(a.get(l)?.get(sov) ?? 0).toBe(0);
    expect(a.get(fronts.line[3])?.get(sov)).toBeGreaterThan(0);
    const unrestricted = approaches({ landSupportOnly: [], frontDeploymentBans: [] }), uf = computeFronts(unrestricted), ua = allocateArmies(unrestricted, uf);
    expect([...uf.theatreNames.keys()].some((l) => (ua.get(l)?.get(sov) ?? 0) > 0)).toBe(true);
  });

  it("allows support through a liberated ally connected to Soviet territory by land", () => {
    const sim = createWeeklySimulation(makeMap({ owners: ["SOV", "POL", "GER"], land: [[0, 1], [1, 2]],
      lonlat: [[30, 53], [25, 53], [24, 53]] }), makeScenario({ SOV: { faction: "allies" },
      POL: { faction: "allies" }, GER: { faction: "axis" } }), { config });
    setWar(sim, "SOV", "GER"); setWar(sim, "POL", "GER");
    const fronts = computeFronts(sim);
    expect(allocateArmies(sim, fronts).get(fronts.line[1])?.get(sim.tags.indexOf("SOV"))).toBeGreaterThan(0);
  });
});

describe("combat observation for diagnostics", () => {
  it("observes battles before capture application without changing results or random numbers", () => {
    const observed = approaches(), control = approaches();
    let calls = 0;
    step(observed, (battles, fronts) => {
      calls++;
      for (const b of battles) for (let i = 0; i < b.captures.length; i++) {
        expect(observed.owner[b.captures[i]]).toBe(b.capturedFrom[i]);
        expect(fronts.targetsByLine.has(b.line)).toBe(true);
      }
    });
    step(control);
    expect(calls).toBe(1);
    expect(observed.owner).toEqual(control.owner);
    expect(observed.military).toEqual(control.military);
    expect(observed.rng).toEqual(control.rng);
    expect(observed.events).toEqual(control.events);
  });
});
