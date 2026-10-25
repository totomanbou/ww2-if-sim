import { describe, expect, it } from "vitest";
import { capitulate, checkCapitulations, lostShare } from "../capitulation";
import { allocateArmies, applyBattles, computeFronts, resolveCombat, revive, setOwner } from "../combat";
import type { SimConfig } from "../config";
import { step } from "../engine";
import { createWeeklySimulation as createSimulation } from "./helpers";
import type { Faction } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

const farLongitude = (3000 / 6371) * (180 / Math.PI);

interface TwoLineOptions {
  longFirst?: boolean;
  distant?: boolean;
  enemies?: [number, number];
  mode?: SimConfig["frontComparisonMode"];
}

function twoLines({
  longFirst = false, distant = false, enemies = [30, 30], mode = "allocated",
}: TwoLineOptions = {}) {
  // Lines 0 and 2 are disconnected; state 4 optionally adds an edge to line 0.
  const land: [number, number][] = [[0, 1], [2, 3]];
  if (longFirst) land.push([4, 1]);
  const sim = createSimulation(
    makeMap({
      owners: ["A", "X", "A", "Y", "A"], land,
      lonlat: distant ? [[0, 0], [0, 0], [farLongitude, 0], [farLongitude, 0], [0, 0]] : [],
    }),
    makeScenario({ A: { faction: "allies" }, X: { faction: "axis" }, Y: { faction: "axis" } }),
    { config: { frontComparisonMode: mode, holdShare: 0, allocationDistanceKm: 3000, overseasDistanceFactor: 1, advanceRate: 0, lossRate: 0.1 } },
  );
  sim.military.set([90, ...enemies]);
  setWar(sim, "A", "X");
  setWar(sim, "A", "Y");
  return sim;
}

describe("army allocation", () => {
  it.each([
    { name: "equal fronts and enemies", options: {}, expected: [45, 45], edges: [1, 1] },
    { name: "twice the front length", options: { longFirst: true }, expected: [60, 30], edges: [2, 1] },
    { name: "twice the enemy army", options: { enemies: [60, 30] as [number, number] }, expected: [60, 30], edges: [1, 1] },
  ])("splits by $name without coordinates", ({ options, expected, edges }) => {
    const sim = twoLines(options);
    const a = sim.tags.indexOf("A");
    const fronts = computeFronts(sim);
    expect([...fronts.lineCountries.keys()]).toEqual([0, 2]);
    expect([fronts.lineFront.get(0)!.get(a)!.edges, fronts.lineFront.get(2)!.get(a)!.edges]).toEqual(edges);
    expect(fronts.frontCount[a]).toBe(edges[0] + edges[1]);
    expect(Array.from(sim.stateLonLat).every(Number.isNaN)).toBe(true);
    const allocation = allocateArmies(sim, fronts);
    expect(allocation.get(0)!.get(a)).toBeCloseTo(expected[0]);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(expected[1]);
  });

  it("halves the distance weight at 3000 km along the equator", () => {
    const sim = twoLines({ distant: true });
    const a = sim.tags.indexOf("A");
    expect(sim.stateLonLat[4]).toBeCloseTo(farLongitude);
    const fronts = computeFronts(sim);
    expect(fronts.lineFront.get(2)!.get(a)).toMatchObject({ lon: farLongitude, lat: 0, n: 1 });
    const allocation = allocateArmies(sim, fronts);
    // Equatorial arc length is radius × longitude in radians: exactly 3000 km here.
    expect(allocation.get(0)!.get(a)).toBeCloseTo(90 / (1 + 0.5), 6);
    expect(allocation.get(2)!.get(a)).toBeCloseTo((90 * 0.5) / (1 + 0.5), 6);
  });

  it.each([false, true])("falls back to edges × distance with zero enemy armies (distant = %s)", (distant) => {
    const sim = twoLines({ longFirst: true, distant, enemies: [0, 0] });
    const a = sim.tags.indexOf("A");
    const allocation = allocateArmies(sim, computeFronts(sim));
    const farWeight = distant ? 0.5 : 1;
    expect(allocation.get(0)!.get(a)).toBeCloseTo((90 * 2) / (2 + farWeight), 6);
    expect(allocation.get(2)!.get(a)).toBeCloseTo((90 * farWeight) / (2 + farWeight), 6);
  });

  it.each([
    { distant: false, enemies: [30, 70] as [number, number] },
    { distant: true, enemies: [30, 70] as [number, number] },
    { distant: true, enemies: [0, 0] as [number, number] },
    { distant: false, enemies: [0, 0] as [number, number] },
  ])("conserves every country's army with $enemies enemies, distant = $distant", (options) => {
    const sim = twoLines({ ...options, longFirst: true });
    const allocation = allocateArmies(sim, computeFronts(sim));
    for (let c = 0; c < sim.tags.length; c++) {
      const total = [...allocation.values()].reduce((sum, line) => sum + (line.get(c) ?? 0), 0);
      expect(total).toBeCloseTo(sim.military[c], 8);
    }
  });

  it.each(["nation", "divided"] as const)("uses %s strength on every line", (mode) => {
    const sim = twoLines({ longFirst: true, distant: true, mode });
    const fronts = computeFronts(sim);
    expect(Array.from(fronts.frontCount)).toEqual([3, 2, 1]);
    const allocation = allocateArmies(sim, fronts);
    for (const [line, countries] of fronts.lineCountries) {
      for (const c of countries) {
        const expected = mode === "nation" ? sim.military[c] : sim.military[c] / fronts.frontCount[c];
        expect(allocation.get(line)!.get(c)).toBeCloseTo(expected);
      }
    }
  });

  it("uses each enemy's share of its own fronts when weighting a line", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "X", "A", "Y", "X", "B"], land: [[0, 1], [2, 3], [4, 5]] }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { config: { frontComparisonMode: "allocated", holdShare: 0 } },
    );
    const [a, b, x, y] = ["A", "B", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
    sim.military.set([90, 30, 60, 30]);
    setWar(sim, "A", "X");
    setWar(sim, "A", "Y");
    setWar(sim, "B", "X");
    const fronts = computeFronts(sim);
    expect(fronts.frontCount[x]).toBe(2);
    const allocation = allocateArmies(sim, fronts);
    // X contributes 60 / 2 = 30 to A's first line, matching Y's 30 on the second.
    expect(allocation.get(0)!.get(a)).toBeCloseTo(45);
    expect(allocation.get(2)!.get(a)).toBeCloseTo(45);
    expect(allocation.get(4)!.get(b)).toBe(30);
    expect(allocation.get(2)!.get(y)).toBe(30);
  });
});

describe("combat with allocated armies", () => {
  it("makes the smaller nation attack when its opponent is spread across two lines", () => {
    const sim = twoLines({ enemies: [60, 60] });
    const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
    expect(sim.military[a]).toBeGreaterThan(sim.military[x]);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(2);
    expect(battles.find((b) => b.line === 0)).toMatchObject({
      attacker: x, defender: a, attStrength: 60, defStrength: 45, captures: [],
    });
  });

  // A's lines: line 0 (allied front length 2: A–X and B–X, enemy X with 60) and line 2 (length 1, enemy Y with
  // 180). Weights 2 × 60 = 120 and 1 × 180 = 180, so A puts 120 × 120 / 300 = 48 on line 0.
  it.each([
    { allyArmy: 10, attacks: false, aLoss: 4.8, bLoss: 1, xLoss: 11.6 },
    { allyArmy: 60, attacks: true, aLoss: (12 * 48) / 108, bLoss: (12 * 60) / 108, xLoss: 6 },
  ])("sums allies and shares allocated losses when attacks = $attacks", ({ allyArmy, attacks, aLoss, bLoss, xLoss }) => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "X", "A", "Y", "B"], land: [[0, 1], [2, 3], [4, 1]] }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
      { config: { frontComparisonMode: "allocated", holdShare: 0, advanceRate: 0, lossRate: 0.1 } },
    );
    const [a, b, x] = ["A", "B", "X"].map((tag) => sim.tags.indexOf(tag));
    sim.military.set([120, allyArmy, 60, 180]);
    setWar(sim, "A", "X");
    setWar(sim, "A", "Y");
    setWar(sim, "B", "X");
    const battle = resolveCombat(sim, computeFronts(sim)).find((bt) => bt.line === 0)!;
    // Only 48 of A's 120 fights here; B commits its entire army.
    expect(battle).toMatchObject(attacks
      ? { attackers: [b, a], defenders: [x], attStrength: 108, defStrength: 60 }
      : { attackers: [x], defenders: [a, b], attStrength: 60, defStrength: 58 });
    expect(attacks ? battle.attShare : battle.defShare).toEqual(attacks ? [60 / 108, 48 / 108] : [48 / 58, 10 / 58]);
    applyBattles(sim, [battle]);
    expect(120 - sim.military[a]).toBeCloseTo(aLoss);
    expect(allyArmy - sim.military[b]).toBeCloseTo(bLoss);
    expect(60 - sim.military[x]).toBeCloseTo(xLoss);
  });
});

interface LiberationOptions {
  faction?: Faction;
  captorFaction?: Faction;
  liberate?: boolean;
  shipbuilding?: number;
  home?: boolean;
}

function occupiedAlly({
  faction = "allies", captorFaction = "allies", liberate = true, shipbuilding = 5, home = true,
}: LiberationOptions = {}) {
  const sim = createSimulation(
    makeMap({
      owners: ["A", "B", "B", "B", "B", "B", "X", "Y"],
      land: [[0, 2]], sea: home ? [[1, 6]] : [],
    }),
    makeScenario({
      A: { name: "Liberator A", faction: captorFaction },
      B: { name: "Ally B", faction, shipbuilding },
      X: { faction: "axis" }, Y: { faction: "axis" },
    }),
    { config: {
      frontComparisonMode: "allocated", liberateToOriginalOwner: liberate,
      growthMode: "yearly", fleetBattleChance: 0, advanceRate: 1, advanceMax: 1, lossRate: 0,
    } },
  );
  const [a, b, x, y] = ["A", "B", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
  sim.military.set([100, 20, 10, 10]);
  setWar(sim, "A", "X");
  setWar(sim, "A", "Y");
  setWar(sim, "B", "X");
  capitulate(sim, b, x);
  return { sim, a, b, x, y };
}

describe("liberated ally revival", () => {
  it("can capitulate again after losing its last state before recovering its capital", () => {
    const { sim, b, x } = occupiedAlly();
    applyBattles(sim, resolveCombat(sim, computeFronts(sim)));
    expect(sim.capitulated[b]).toBe(0);
    expect(sim.revivedAwaitingCapital[b]).toBe(1);
    setOwner(sim, 2, x);
    expect(sim.owner.includes(b)).toBe(false);
    expect(checkCapitulations(sim)).toEqual([[b, x]]);
    expect(sim.capitulated[b]).toBe(1);
    expect(sim.revivedAwaitingCapital[b]).toBe(0);
    expect(sim.military[b]).toBe(0);
    expect(sim.fleets.some((fleet) => fleet.country === b)).toBe(false);
  });

  it("revives a capitulated ally and protects it until its capital is recovered", () => {
    const { sim, a, b, x, y } = occupiedAlly();
    const nC = sim.tags.length;
    expect(sim.capitulated[b]).toBe(1);
    expect(Array.from(sim.owner).slice(1, 6)).toEqual([x, x, x, x, x]);
    expect(sim.fleets.filter((fleet) => fleet.country === b)).toEqual([]);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles).toHaveLength(1);
    expect(battles[0]).toMatchObject({ captures: [2], captors: [a], capturedFrom: [x] });
    expect(applyBattles(sim, battles)).toEqual([{ country: b, by: a, state: 2 }]);
    expect(sim.owner[2]).toBe(b);
    expect(sim.capitulated[b]).toBe(0);
    expect(sim.military[b]).toBe(0);
    expect(sim.entered[b]).toBe(1);
    expect(sim.capitalHeld[b]).toBe(0);
    expect(sim.revivedAwaitingCapital[b]).toBe(1);
    for (let c = 0; c < nC; c++) {
      const expected = Number(c === x || c === y);
      expect(sim.atWar[b * nC + c]).toBe(expected);
      expect(sim.atWar[c * nC + b]).toBe(expected);
    }
    expect(sim.homeZone[b]).toBe(0);
    expect(sim.fleets.filter((fleet) => fleet.country === b)).toEqual([
      { country: b, zone: 0, target: 0, strength: 0 },
    ]);
    expect(sim.owner[sim.capital[b]]).toBe(x);
    expect(lostShare(sim, b)).toBeCloseTo(0.8);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.capitulated[b]).toBe(0);
    expect(sim.revivedAwaitingCapital[b]).toBe(1);

    setOwner(sim, sim.capital[b], b);
    expect(checkCapitulations(sim)).toEqual([]);
    expect(sim.revivedAwaitingCapital[b]).toBe(0);

    setOwner(sim, sim.capital[b], x);
    expect(lostShare(sim, b)).toBeCloseTo(0.8);
    expect(checkCapitulations(sim)).toEqual([[b, x]]);
    expect(sim.capitulated[b]).toBe(1);
    expect(sim.owner[2]).toBe(x);
    expect(sim.fleets.filter((fleet) => fleet.country === b)).toEqual([]);
  });

  it("logs the revived ally and its liberator through step", () => {
    const { sim, b } = occupiedAlly();
    step(sim);
    const revivals = sim.events.filter((event) => event.type === "revival");
    expect(revivals).toHaveLength(1);
    expect(revivals[0]).toMatchObject({
      tick: 0, date: "1939-09-01", countries: ["B", "A"],
    });
    expect(revivals[0].text).toContain("Ally B");
    expect(revivals[0].text).toContain("Liberator A");
    expect(sim.owner[2]).toBe(b);
    expect(sim.capitulated[b]).toBe(0);
    expect(sim.revivedAwaitingCapital[b]).toBe(1);
  });

  it.each([
    { name: "a different faction", options: { faction: "axis" as const } },
    { name: "the neutral faction", options: { faction: "neutral" as const, captorFaction: "neutral" as const } },
    { name: "liberation disabled", options: { liberate: false } },
  ])("keeps the capture without revival for $name", ({ options }) => {
    const { sim, a, b, x } = occupiedAlly(options);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles[0]).toMatchObject({ captures: [2], captors: [a], capturedFrom: [x] });
    expect(applyBattles(sim, battles)).toEqual([]);
    expect(sim.owner[2]).toBe(a);
    expect(sim.capitulated[b]).toBe(1);
    expect(sim.entered[b]).toBe(0);
    expect(sim.revivedAwaitingCapital[b]).toBe(0);
    expect(sim.fleets.filter((fleet) => fleet.country === b)).toEqual([]);
  });

  it("still returns an active ally's original state without reporting a revival", () => {
    const { sim, b } = occupiedAlly();
    // Represent a surviving ally holding its capital while X occupies the other states.
    sim.capitulated[b] = 0;
    setOwner(sim, sim.capital[b], b);
    expect(applyBattles(sim, resolveCombat(sim, computeFronts(sim)))).toEqual([]);
    expect(sim.owner[2]).toBe(b);
    expect(sim.entered[b]).toBe(0);
    expect(sim.revivedAwaitingCapital[b]).toBe(0);
  });

  it.each([
    { shipbuilding: 0, home: true },
    { shipbuilding: 5, home: false },
  ])("revives without a fleet with shipbuilding = $shipbuilding, home = $home", (options) => {
    const { sim, b } = occupiedAlly(options);
    expect(applyBattles(sim, resolveCombat(sim, computeFronts(sim)))).toHaveLength(1);
    expect(sim.capitulated[b]).toBe(0);
    expect(sim.owner[2]).toBe(b);
    expect(sim.fleets.filter((fleet) => fleet.country === b)).toEqual([]);
  });

  it("does not inherit wars with capitulated enemies or the liberator's own faction", () => {
    const sim = createSimulation(
      makeMap({ owners: ["A", "B", "C", "X", "Y"], land: [] }),
      makeScenario({
        A: { faction: "allies" }, B: { faction: "allies" }, C: { faction: "allies" },
        X: { faction: "axis" }, Y: { faction: "axis" },
      }),
    );
    const [a, b, x, y] = ["A", "B", "X", "Y"].map((tag) => sim.tags.indexOf(tag));
    capitulate(sim, b, x);
    capitulate(sim, y, x);
    setWar(sim, "A", "X");
    // The revival filter must handle same-faction wars and stale capitulated enemies.
    setWar(sim, "A", "C");
    setWar(sim, "A", "Y");
    revive(sim, b, a);
    const nC = sim.tags.length;
    for (let c = 0; c < nC; c++) {
      expect(sim.atWar[b * nC + c]).toBe(Number(c === x));
      expect(sim.atWar[c * nC + b]).toBe(Number(c === x));
    }
  });
});
