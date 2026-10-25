import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { capitulate, checkCapitulations } from "../capitulation";
import { applyBattles, computeFronts, resolveCombat, setOwner, type Revival } from "../combat";
import type { SimConfig } from "../config";
import { parseDate } from "../date";
import { step } from "../engine";
import { effectiveIndustry } from "../growth";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { createSimulation as createRealSimulation } from "../init";
import { tickTime as realTickTime } from "../date";
import type { Scenario, SimMap, SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

const config: Partial<SimConfig> = {
  encirclement: false,
  lossFactors: {},
  regionPriority: {},
  lowPriorityFronts: {},
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  transitSpeedKmPerWeek: 1e9,
  holdShare: 0,
  surprise: {},
  successors: {},
  lossRate: 0,
  advanceRate: 0,
  fleetBattleChance: 0,
};

const successors: SimConfig["successors"] = { F: { tag: "G", seat: [8, 8] } };

function fixtureMap(options: Parameters<typeof makeMap>[0]): SimMap {
  const map = makeMap(options);
  // Keep all victory cities neutral so several step() calls cannot end a fixture early.
  const neutral = options.owners.indexOf("N");
  if (neutral < 0) throw new Error("Fixture requires a neutral N state");
  for (const city of Object.keys(map.cities) as (keyof typeof map.cities)[]) map.cities[city] = neutral;
  return map;
}

function surpriseFixture() {
  return createSimulation(
    fixtureMap({
      owners: ["A", "D", "U", "N"],
      land: [[0, 1], [0, 2], [1, 2]],
    }),
    makeScenario({
      A: { faction: "axis", industry: 1000 },
      D: { faction: "allies", industry: 100 },
      U: { faction: "allies", industry: 100 },
      N: {},
    }, [
      { date: "1939-09-15", a: ["A"], b: ["D", "U"] },
      { date: "1939-09-29", a: ["A"], b: ["D"] },
    ]),
    { config: { ...config, surprise: { D: { weeks: 4, factor: 0.25 } } } },
  );
}

function transferFixture(withSuccessor = false) {
  const scenario = makeScenario({
    F: { faction: "allies" },
    G: { faction: "allies" },
    X: { faction: "axis" },
    N: {},
  });
  scenario.transfers = [{
    date: "1939-09-08",
    from: "F",
    to: "G",
    name: "Colonies",
    boxes: [[0, 0, 5, 5], [7, 7, 9, 9]],
  }];
  const sim = createSimulation(
    fixtureMap({
      // 0: capital outside boxes; 1-2: transferable; 3: occupied; 4: outside;
      // 5: occupied by F but not originally F; 6: X's capital; 7: neutral cities.
      owners: ["F", "F", "F", "F", "F", "X", "X", "N"],
      core: [true, false, false, false, false, false, true, true],
      lonlat: [[50, 50], [2, 2], [8, 8], [3, 3], [20, 20], [4, 4], [60, 60], [70, 70]],
      capitals: { X: 6 },
      land: [],
    }),
    scenario,
    { config: { ...config, successors: withSuccessor ? successors : {} } },
  );
  const [f, g, x, n] = ["F", "G", "X", "N"].map((tag) => sim.tags.indexOf(tag));
  setOwner(sim, 3, x);
  setOwner(sim, 5, f);
  return { sim, f, g, x, n };
}

function liberationFixture(withSuccessor: boolean) {
  const sim = createSimulation(
    fixtureMap({
      owners: ["A", "F", "F", "X", "N"],
      core: [true, true, false, true, true],
      land: [[0, 2]],
    }),
    makeScenario({
      A: { faction: "allies", industry: 1000 },
      F: { faction: "allies" },
      G: { faction: "allies", industry: 0 },
      X: { faction: "axis", industry: 10 },
      N: {},
    }),
    { config: { ...config, successors: withSuccessor ? successors : {}, advanceRate: 1, advanceMax: 1 } },
  );
  const [a, f, g, x] = ["A", "F", "G", "X"].map((tag) => sim.tags.indexOf(tag));
  capitulate(sim, f, x);
  setOwner(sim, 2, x);
  setWar(sim, "A", "X");
  setWar(sim, "G", "X");
  return { sim, a, f, g, x };
}

describe("governments without original territory", () => {
  it("appends sorted scenario-only tags without changing map indices and skips their capitulation", () => {
    const map = fixtureMap({ owners: ["Z", "F", "N"], land: [], sea: [[0, 1]] });
    const countries = { Z: { shipbuilding: 10 }, F: {}, N: {} };
    const baseline = createSimulation(map, makeScenario(countries), { config });
    const sim = createSimulation(map, makeScenario({
      G: { faction: "allies", shipbuilding: 10, navy: 100 },
      ...countries,
      B: { faction: "allies" },
    }), { config: { ...config, capitulationThreshold: 0 } });

    expect(baseline.tags).toEqual(["F", "N", "Z"]);
    expect(sim.tags).toEqual(["F", "N", "Z", "B", "G"]);
    expect(Array.from(sim.origOwner)).toEqual(Array.from(baseline.origOwner));
    expect(sim.fleets.some((fleet) => fleet.country === sim.tags.indexOf("Z"))).toBe(true);
    for (const tag of ["B", "G"]) {
      const c = sim.tags.indexOf(tag);
      expect(sim.origCount[c]).toBe(0);
      expect(sim.capital[c]).toBe(-1);
      expect(sim.homeZone[c]).toBe(-1);
      expect(sim.fleets.filter((fleet) => fleet.country === c)).toEqual([]);
    }
    expect(checkCapitulations(sim)).toEqual([]);
    expect(Array.from(sim.capitulated)).toEqual([0, 0, 0, 0, 0]);
  });

  it("produces its full industry plus occupied-state output, and zero after capitulation", () => {
    const sim = createSimulation(
      fixtureMap({ owners: ["F", "F", "N"], core: [true, false, true], land: [] }),
      makeScenario({ F: { industry: 80 }, G: { industry: 12 }, N: {} }),
      { config },
    );
    const g = sim.tags.indexOf("G");
    expect(effectiveIndustry(sim)[g]).toBe(12);
    setOwner(sim, 1, g);
    expect(effectiveIndustry(sim)[g]).toBeCloseTo(12 + 80 * 0.25 * sim.config.occupiedIndustryRate);
    setOwner(sim, 0, g);
    expect(effectiveIndustry(sim)[g]).toBeCloseTo(12 + 80 * sim.config.occupiedIndustryRate);
    capitulate(sim, g, -1);
    expect(effectiveIndustry(sim)[g]).toBe(0);
  });
});

describe("surprise attacks", () => {
  it("records the declaration tick once, without surprising unlisted countries or the declaring side", () => {
    const sim = surpriseFixture();
    const [a, d, u] = ["A", "D", "U"].map((tag) => sim.tags.indexOf(tag));
    expect(Array.from(sim.surpriseStart)).toEqual([-1, -1, -1, -1]);
    step(sim);
    step(sim);
    expect(sim.tick).toBe(2);
    expect(sim.surpriseStart[d]).toBe(-1);
    expect(sim.atWar[a * sim.tags.length + d]).toBe(0);
    step(sim);
    expect(sim.surpriseStart[d]).toBe(2);
    expect(sim.atWar[a * sim.tags.length + d]).toBe(1);
    step(sim);
    step(sim);
    expect(sim.nextWar).toBe(2);
    expect(sim.surpriseStart[d]).toBe(2);
    expect([sim.surpriseStart[a], sim.surpriseStart[u]]).toEqual([-1, -1]);
  });

  it.each([
    [0, 0.25],
    [1, 0.4375],
    [2, 0.625],
    [3, 0.8125],
    [4, 1],
    [5, 1],
  ])("recovers after %s weeks to a strength factor of %s", (elapsed, factor) => {
    const sim = surpriseFixture();
    const [a, d, u] = ["A", "D", "U"].map((tag) => sim.tags.indexOf(tag));
    step(sim);
    step(sim);
    step(sim);
    // Probe combat at an exact elapsed week after step() activated the scenario declaration.
    sim.tick = sim.surpriseStart[d] + elapsed;
    const battles = resolveCombat(sim, computeFronts(sim));

    expect(battles).toHaveLength(1);
    const battle = battles[0];
    const reduced = sim.military[d] * factor;
    const normal = sim.military[u];
    expect(battle.attacker).toBe(a);
    expect(battle.attStrength).toBeCloseTo(sim.military[a]);
    expect(battle.defStrength).toBeCloseTo(reduced + normal);
    expect(battle.defShare[battle.defenders.indexOf(d)]).toBeCloseTo(reduced / (reduced + normal));
    expect(battle.defShare[battle.defenders.indexOf(u)]).toBeCloseTo(normal / (reduced + normal));
    expect(sim.surpriseStart[u]).toBe(-1);
  });

  it("does not penalize a listed country when it declares the war", () => {
    const sim = createSimulation(
      fixtureMap({ owners: ["D", "A", "N"], land: [[0, 1]] }),
      makeScenario({ D: { industry: 1000 }, A: { industry: 100 }, N: {} }, [
        { date: "1939-09-01", a: ["D"], b: ["A"] },
      ]),
      { config: { ...config, surprise: { D: { weeks: 4, factor: 0.25 } } } },
    );
    const d = sim.tags.indexOf("D");
    step(sim);
    expect(sim.surpriseStart[d]).toBe(-1);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0].attacker).toBe(d);
    expect(battles[0].attStrength).toBeCloseTo(sim.military[d]);
  });
});

describe("colony transfers and successor seats", () => {
  it("waits for capitulation even past the date, filters states, logs the transfer and applies it only once", () => {
    const { sim, f, g, x, n } = transferFixture();
    const before = Array.from(sim.owner);
    step(sim);
    step(sim);
    step(sim);
    expect(sim.capitulated[f]).toBe(0);
    expect(Array.from(sim.owner)).toEqual(before);
    expect(sim.transferDone[0]).toBe(0);
    expect(sim.events.filter((event) => event.type === "transfer")).toEqual([]);

    // No recipient preserves F's occupations, so the transfer itself must filter non-original states.
    capitulate(sim, f, -1);
    step(sim);
    expect(Array.from(sim.owner)).toEqual([f, g, g, x, f, f, x, n]);
    expect(sim.transferDone[0]).toBe(1);
    const transfers = sim.events.filter((event) => event.type === "transfer");
    expect(transfers).toHaveLength(1);
    expect(transfers[0]).toMatchObject({ tick: 3, date: "1939-09-22", countries: ["G", "F"] });
    expect(transfers[0].text).toContain("Colonies");
    setOwner(sim, 1, f);
    step(sim);
    expect(sim.owner[1]).toBe(f);
    expect(sim.transferDone[0]).toBe(1);
    expect(sim.events.filter((event) => event.type === "transfer")).toEqual(transfers);
  });

  it("waits until the scheduled date when the predecessor has already capitulated", () => {
    const { sim, f, g } = transferFixture();
    capitulate(sim, f, -1);
    step(sim);
    expect(sim.owner[1]).toBe(f);
    expect(sim.transferDone[0]).toBe(0);
    step(sim);
    expect([sim.owner[1], sim.owner[2]]).toEqual([g, g]);
    expect(sim.transferDone[0]).toBe(1);
    expect(sim.events.filter((event) => event.type === "transfer")).toMatchObject([
      { tick: 1, date: "1939-09-08", countries: ["G", "F"] },
    ]);
  });

  it("moves the successor seat from no territory to the nearest state, preferring the original capital", () => {
    const { sim, f, g, x } = transferFixture(true);
    expect(sim.origCount[g]).toBe(0);
    expect(sim.capital[g]).toBe(-1);
    step(sim);
    expect(sim.capital[g]).toBe(-1);
    capitulate(sim, f, -1);
    step(sim);
    expect([sim.owner[1], sim.owner[2]]).toEqual([g, g]);
    expect(sim.capital[g]).toBe(2);
    setOwner(sim, 0, g);
    step(sim);
    expect(sim.capital[g]).toBe(sim.capital[f]);
    expect(sim.capital[g]).toBe(0);
    setOwner(sim, 0, x);
    step(sim);
    expect(sim.capital[g]).toBe(2);
    setOwner(sim, 2, x);
    step(sim);
    expect(sim.capital[g]).toBe(1);
    setOwner(sim, 1, x);
    step(sim);
    expect(sim.capital[g]).toBe(-1);
    expect(sim.capitulated[g]).toBe(0);
    expect(sim.events.filter((event) => event.type === "capitalFall" && event.countries.includes("G"))).toEqual([]);
  });
});

describe("successor liberation and capitulation returns", () => {
  it.each([true, false])("liberates to G without reviving F only with successors = %s", (withSuccessor) => {
    const { sim, a, f, g, x } = liberationFixture(withSuccessor);
    expect(sim.capitulated[f]).toBe(1);
    expect(sim.owner[2]).toBe(x);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0].captures).toEqual([2]);
    expect(battles[0].captors).toEqual([a]);

    const revivals = applyBattles(sim, battles);

    expect(sim.owner[2]).toBe(withSuccessor ? g : f);
    expect(sim.capitulated[f]).toBe(withSuccessor ? 1 : 0);
    expect(sim.revivedAwaitingCapital[f]).toBe(withSuccessor ? 0 : 1);
    expect(revivals).toEqual(withSuccessor ? [] : [{ country: f, by: a, state: 2 }]);
  });

  it.each([true, false])("returns occupied original states on enemy capitulation with successors = %s", (withSuccessor) => {
    const { sim, a, f, g, x } = liberationFixture(withSuccessor);
    const revivals: Revival[] = [];

    capitulate(sim, x, a, revivals);

    expect([sim.owner[1], sim.owner[2]]).toEqual(withSuccessor ? [g, g] : [f, f]);
    expect(sim.owner[3]).toBe(a);
    expect(sim.capitulated[x]).toBe(1);
    expect(sim.capitulated[f]).toBe(withSuccessor ? 1 : 0);
    expect(revivals).toEqual(withSuccessor ? [] : [{ country: f, by: a, state: 1 }]);
  });
});

describe("Free France in the historical preset", () => {
  const map = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as SimMap;
  const scenario = JSON.parse(
    readFileSync(new URL("../../../data/presets/historical.json", import.meta.url), "utf8"),
  ) as Scenario;
  const cutoff = parseDate("1940-09-30");
  let sim: SimState;

  beforeAll(() => {
    // The real game (half-week steps, default capitulation rules), not the legacy weekly helper.
    sim = createRealSimulation(map, scenario, { seed: scenario.seed });
    while (!sim.result && realTickTime(sim.startMs, sim.tick, sim.config.stepDays) <= cutoff) step(sim);
  });

  function originalStatesIn(name: string): number[] {
    const transfer = scenario.transfers!.find((entry) => entry.name === name)!;
    expect(transfer, name).toBeDefined();
    const states = map.states.flatMap((state, s) => {
      if (state.owner !== "FRA" || !state.lonlat) return [];
      const [lon, lat] = state.lonlat;
      return transfer.boxes.some(([w, so, e, no]) => lon >= w && lon <= e && lat >= so && lat <= no) ? [s] : [];
    });
    expect(states.length, name).toBeGreaterThan(0);
    return states;
  }

  it("includes allied FFR, its wars, and 17 chronologically ordered FRA-to-FFR transfers", () => {
    expect(scenario.countries.FFR).toBeDefined();
    expect(scenario.countries.FFR.faction).toBe("allies");
    // The other transfers are Japan's occupation of French Indochina.
    const transfers = scenario.transfers!.filter((transfer) => transfer.to !== "JAP");
    expect(transfers).toHaveLength(17);
    expect(transfers.every((transfer) => transfer.from === "FRA" && transfer.to === "FFR")).toBe(true);
    const dates = transfers.map((transfer) => transfer.date);
    expect(dates).toEqual([...dates].sort());
    expect(scenario.wars.filter((war) => war.a.includes("FFR"))).toMatchObject([
      { date: "1940-06-18", b: ["GER", "ITA"] },
      { date: "1941-12-08", b: ["JAP"] },
    ]);
  });

  it("transfers the three colonies and holds Cameroon and Congo by 1940-09-30 without a Free French capital fall", () => {
    expect(sim.result).toBeNull();
    expect(realTickTime(sim.startMs, sim.tick - 1, sim.config.stepDays)).toBeLessThanOrEqual(cutoff);
    expect(realTickTime(sim.startMs, sim.tick, sim.config.stepDays)).toBeGreaterThan(cutoff);
    const fra = sim.tags.indexOf("FRA"), ffr = sim.tags.indexOf("FFR");
    expect(sim.capitulated[fra]).toBe(1);
    expect(ffr).toBeGreaterThanOrEqual(0);
    for (const name of ["チャド", "フランス領カメルーン", "中部コンゴ・ウバンギ=シャリ"]) {
      originalStatesIn(name);
      expect(sim.events.some((event) => event.type === "transfer"
        && event.countries[0] === "FFR" && event.text.startsWith(name)), name).toBe(true);
    }
    for (const name of ["フランス領カメルーン", "中部コンゴ・ウバンギ=シャリ"]) {
      expect(originalStatesIn(name).some((s) => sim.owner[s] === ffr), name).toBe(true);
    }
    expect(sim.events.filter((event) =>
      event.type === "capitalFall" && (event.countries.includes("FFR") || event.text.includes(sim.names[ffr])),
    )).toEqual([]);
  });

  // Whether Free France still holds part of Chad on 1940-09-30 depends on the whole run (it flipped with nearly every
  // balance change), so it is not tested; the transfer itself is checked above.
});

