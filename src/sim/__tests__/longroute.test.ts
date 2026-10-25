import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyBattles, computeFronts, encircledStates, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import { createWeeklySimulation as createSimulation } from "./helpers";
import { blockedLandings, fleetPower, hasSuperiority, routeControlled } from "../navy";
import type { Scenario, SimMap, SimState } from "../types";
import { makeMap, makeScenario, setWar } from "./helpers";

const Z1 = 0, Z2 = 1, Z3 = 2, Z4 = 3;
const LONG_ROUTE_KM = 1000;

function fixture(map: SimMap, config: Partial<SimConfig> = {}, scenario?: Scenario) {
  const countries = Object.fromEntries(map.states.map(({ owner }) => [owner, { industry: 0 }]));
  return createSimulation(map, scenario ?? makeScenario(countries), {
    seed: 17,
    config: {
      encirclement: false,
      lossFactors: {},
      lowPriorityFronts: {},
      slowAdvanceLand: {},
      capitulateOnCapitalLoss: [],
      capitulateOnContinentLoss: [],
      landingWithoutNavy: {},
      transitSpeedKmPerWeek: 1e9,
      frontComparisonMode: "nation",
      advanceRate: 2,
      advanceMax: 1,
      navalPenalty: 0.5,
      navalSuperiority: 0.7,
      longRouteKm: LONG_ROUTE_KM,
      ...config,
    },
  });
}

// 0: attacker coast A, 1: target T, 2/3: local routes defining the two port zones.
function routeMap(km: number | undefined = LONG_ROUTE_KM + 1): SimMap {
  return {
    ...makeMap({
      owners: ["A", "D", "A", "D"], land: [],
      zones: Array.from({ length: 4 }, () => ({ neighbors: [] })),
    }),
    seaRoutes: [
      { a: 0, b: 2, zone: Z1, km: 10 },
      { a: 1, b: 3, zone: Z2, km: 10 },
      { a: 0, b: 1, zone: Z3, ...(km === undefined ? {} : { km }) },
    ],
  };
}

function duel(map = routeMap(), config: Partial<SimConfig> = {}, scenario?: Scenario) {
  const sim = fixture(map, config, scenario);
  setWar(sim, "A", "D");
  sim.military[sim.tags.indexOf("A")] = 100;
  sim.military[sim.tags.indexOf("D")] = 10;
  return sim;
}

function addFleet(sim: SimState, tag: string, zone: number, strength = 100) {
  sim.fleets.push({ country: sim.tags.indexOf(tag), zone, target: zone, strength });
}

function ports(sim: SimState, state: number) {
  return Array.from(sim.portZone.slice(sim.portOff[state], sim.portOff[state + 1]));
}

function routeEntry(sim: SimState, from: number, to: number) {
  for (let k = sim.seaOff[from]; k < sim.seaOff[from + 1]; k++) {
    if (sim.seaNb[k] === to) return k;
  }
  throw new Error(`Missing route ${from} -> ${to}`);
}

function controlled(sim: SimState, from = 0, to = 1) {
  return routeControlled(sim, fleetPower(sim), sim.tags.indexOf("A"), sim.tags.indexOf("D"), routeEntry(sim, from, to));
}

function expectBlocked(sim: SimState) {
  const owners = sim.owner.slice(), military = sim.military.slice();
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toEqual([]);
  applyBattles(sim, battles);
  expect(sim.owner).toEqual(owners);
  expect(sim.military).toEqual(military);
}

function expectLanding(sim: SimState) {
  const battles = resolveCombat(sim, computeFronts(sim));
  expect(battles).toHaveLength(1);
  expect(battles[0].captures).toEqual([1]);
  expect(battles[0].captors).toEqual([sim.tags.indexOf("A")]);
  applyBattles(sim, battles);
  expect(sim.owner[1]).toBe(sim.tags.indexOf("A"));
}

describe("port zones and sea route indexing", () => {
  it("deduplicates short-route zones, includes missing km and the threshold, and excludes long routes", () => {
    const map: SimMap = {
      ...makeMap({
        owners: ["A", "D", "A", "D", "D", "D"], land: [],
        zones: Array.from({ length: 3 }, () => ({ neighbors: [] })),
      }),
      seaRoutes: [
        { a: 0, b: 2, zone: Z1, km: LONG_ROUTE_KM },
        { a: 0, b: 3, zone: Z1, km: 20 },
        { a: 0, b: 1, zone: Z2 },
        { a: 0, b: 4, zone: Z3, km: LONG_ROUTE_KM + 1 },
        { a: 4, b: 5, zone: Z3, km: LONG_ROUTE_KM + 1 },
        { a: 0, b: 5, zone: -1, km: 0 },
      ],
    };
    const sim = fixture(map);
    expect(map.states.map((_, s) => ports(sim, s))).toEqual([[Z1, Z2], [Z2], [Z1], [Z1], [], []]);
    for (let s = 0; s < sim.nStates; s++) {
      const expected = map.seaRoutes.filter((r) => r.a === s || r.b === s);
      const entries = Array.from({ length: sim.seaOff[s + 1] - sim.seaOff[s] }, (_, i) => sim.seaOff[s] + i);
      expect(entries.map((k) => [sim.seaFrom[k], sim.seaNb[k], sim.seaZone[k], sim.seaKm[k]]))
        .toEqual(expected.map((r) => [s, r.a === s ? r.b : r.a, r.zone, r.km ?? 0]));
    }
  });
});

describe("routeControlled", () => {
  it.each([0, LONG_ROUTE_KM, undefined])("needs only the route zone for short km=%s", (km) => {
    const map = routeMap();
    if (km === undefined) delete map.seaRoutes[2].km;
    else map.seaRoutes[2].km = km;
    const sim = duel(map);
    addFleet(sim, "A", Z3);
    addFleet(sim, "D", Z1, 1000);
    addFleet(sim, "D", Z2, 1000);
    expect(controlled(sim)).toBe(true);
    expect(controlled(sim, 1, 0)).toBe(true);
    sim.fleets = sim.fleets.filter((f) => f.country !== sim.tags.indexOf("A"));
    expect(controlled(sim)).toBe(false);
  });

  it.each([
    { zones: [], allowed: false },
    { zones: [Z3], allowed: false },
    { zones: [Z1, Z3], allowed: false },
    { zones: [Z2, Z3], allowed: false },
    { zones: [Z1, Z2], allowed: false },
    { zones: [Z1, Z2, Z3], allowed: true },
  ])("requires route and both end zones: $zones -> $allowed", ({ zones, allowed }) => {
    const sim = duel();
    for (const z of zones) addFleet(sim, "A", z);
    for (const z of [Z1, Z2, Z3]) addFleet(sim, "D", z);
    expect(ports(sim, 0)).toEqual([Z1]);
    expect(ports(sim, 1)).toEqual([Z2]);
    expect(controlled(sim)).toBe(allowed);
    expect(controlled(sim, 1, 0)).toBe(allowed);
  });

  it.each([Z1, Z2])("checks the superiority threshold at end zone %i", (endZone) => {
    const sim = duel();
    for (const z of [Z1, Z2, Z3]) {
      addFleet(sim, "A", z, z === endZone ? 69 : 100);
      addFleet(sim, "D", z, 100);
    }
    expect(controlled(sim)).toBe(false);
    sim.fleets.find((f) => f.country === sim.tags.indexOf("A") && f.zone === endZone)!.strength = 70;
    expect(controlled(sim)).toBe(true);
  });

  it("accepts any one controlled port zone at each end", () => {
    const map = routeMap();
    map.seaRoutes.push({ a: 0, b: 2, zone: Z4, km: 10 }, { a: 1, b: 3, zone: Z4, km: 10 });
    const sim = duel(map);
    addFleet(sim, "A", Z3);
    addFleet(sim, "A", Z4);
    addFleet(sim, "D", Z1, 1000);
    addFleet(sim, "D", Z2, 1000);
    expect(controlled(sim)).toBe(true);
  });

  it.each([[true, false], [false, true], [true, true]])("ignores absent port zones (origin=%s, target=%s)", (noOriginPorts, noTargetPorts) => {
    const map = routeMap();
    map.seaRoutes = map.seaRoutes.filter((r) => !(noOriginPorts && r.zone === Z1) && !(noTargetPorts && r.zone === Z2));
    const sim = duel(map);
    addFleet(sim, "A", Z3);
    if (!noOriginPorts) addFleet(sim, "A", Z1);
    if (!noTargetPorts) addFleet(sim, "A", Z2);
    expect(controlled(sim)).toBe(true);
    expect(controlled(sim, 1, 0)).toBe(true);
    if (noOriginPorts) expect(ports(sim, 0)).toEqual([]);
    if (noTargetPorts) expect(ports(sim, 1)).toEqual([]);
  });
});

describe("landings over long routes", () => {
  it("rejects route-zone control alone and then lands with superiority at both ends", () => {
    const sim = duel();
    addFleet(sim, "A", Z3);
    addFleet(sim, "D", Z2);
    const a = sim.tags.indexOf("A"), d = sim.tags.indexOf("D");
    const fronts = computeFronts(sim);
    expect(fronts.targets.get(a * sim.tags.length + d)?.seaRoutes.get(1)).toEqual([routeEntry(sim, 0, 1)]);
    expect(hasSuperiority(sim, fleetPower(sim), a, d, Z3)).toBe(true);
    expectBlocked(sim);
    addFleet(sim, "A", Z1);
    addFleet(sim, "A", Z2);
    expectLanding(sim);
  });

  it.each([Z1, Z2])("does not land if end zone %i alone is lost", (endZone) => {
    const sim = duel();
    for (const z of [Z1, Z2, Z3]) addFleet(sim, "A", z);
    addFleet(sim, "D", endZone, 1000);
    expectBlocked(sim);
  });
});

function exemptDuel(attacker = "A", defender = "D", land = false) {
  const map: SimMap = {
    ...makeMap({ owners: [attacker, defender, defender, "A", "D"], land: land ? [[0, 1]] : [] }),
    seaRoutes: land ? [] : [{ a: 0, b: 1, zone: 0, km: LONG_ROUTE_KM + 1 }],
  };
  const sim = fixture(map, { landingWithoutNavy: { A: ["D"] } });
  setWar(sim, attacker, defender);
  sim.military[sim.tags.indexOf(attacker)] = 30;
  sim.military[sim.tags.indexOf(defender)] = 10;
  return sim;
}

describe("landingWithoutNavy", () => {
  it.each([false, true])("allows the specified pair with no attacker fleet (enemy fleet: %s)", (enemyFleet) => {
    const sim = exemptDuel();
    if (enemyFleet) addFleet(sim, "D", 0, 1000);
    expect(sim.fleets.some((f) => f.country === sim.tags.indexOf("A"))).toBe(false);
    expect(controlled(sim)).toBe(false);
    expectLanding(sim);
  });

  it("still applies navalPenalty: a 1.5:1 land attack wins while the same landing cannot attack", () => {
    const sea = exemptDuel(), land = exemptDuel("A", "D", true);
    for (const sim of [sea, land]) sim.military[sim.tags.indexOf("A")] = 15;
    const battles = resolveCombat(land, computeFronts(land));
    expect(battles).toHaveLength(1);
    expect(battles[0].attStrength / battles[0].defStrength).toBe(1.5);
    expect(battles[0].captures).toEqual([1]);
    expectBlocked(sea);
    // At 3:1 the penalized landing ratio is 1.5:1 and guarantees one capture.
    sea.military[sea.tags.indexOf("A")] = 30;
    expectLanding(sea);
  });

  it.each([["B", "D"], ["A", "E"], ["D", "A"]])("does not exempt %s -> %s", (attacker, defender) => {
    const sim = exemptDuel(attacker, defender);
    addFleet(sim, defender, 0, 1000);
    expectBlocked(sim);
    // Positive control: this pair can land once it actually has naval superiority.
    addFleet(sim, attacker, 0, 1000);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles.flatMap((b) => b.captures)).toEqual([1]);
  });

  it("keeps blockedLandings effective until the blocking region is released", () => {
    const map = makeMap({ owners: ["A", "D", "D"], land: [], sea: [[0, 1]] });
    const scenario = makeScenario({ A: { faction: "allies" }, D: { faction: "axis" } });
    scenario.landingRestrictions = [{ defender: "D", coreOnly: true, region: [2], blockedWhileHeldBy: "axis" }];
    const sim = duel(map, { landingWithoutNavy: { A: ["D"] } }, scenario);
    addFleet(sim, "D", 0, 1000);
    expect(blockedLandings(sim)?.[1]).toBe(1);
    expectBlocked(sim);
    sim.owner[2] = sim.tags.indexOf("A");
    expect(blockedLandings(sim)).toBeNull();
    expectLanding(sim);
  });
});

describe("long-route encirclement supply", () => {
  function pocket(zones: number[]) {
    // 0 is A's capital, 1 its pocket, 2/3 hostile neighbours. Local port routes
    // 1-2 and 0-3 define Z1/Z2; the pocket's only long route is 1-0 in Z3.
    const map: SimMap = {
      ...makeMap({
        owners: ["A", "A", "D", "D"], land: [[1, 2], [2, 3]],
        zones: Array.from({ length: 3 }, () => ({ neighbors: [] })),
      }),
      seaRoutes: [
        { a: 1, b: 2, zone: Z1, km: 10 },
        { a: 0, b: 3, zone: Z2, km: 10 },
        { a: 1, b: 0, zone: Z3, km: LONG_ROUTE_KM + 1 },
      ],
    };
    const sim = duel(map, { encirclement: true });
    for (const z of [Z1, Z2]) addFleet(sim, "D", z);
    for (const z of zones) addFleet(sim, "A", z);
    return encircledStates(sim, computeFronts(sim), fleetPower(sim));
  }

  it.each([
    { zones: [Z3], encircled: true },
    { zones: [Z2, Z3], encircled: true },
    { zones: [Z1, Z2, Z3], encircled: false },
  ])("checks both ends of the supply route: $zones -> encircled=$encircled", ({ zones, encircled }) => {
    const enc = pocket(zones);
    expect(enc[0]).toBe(0);
    expect(enc[1]).toBe(encircled ? 1 : 0);
  });

  // By design, control of the waters at the pocket itself counts as sea supply: the short 1-2 route lies in Z1, so
  // controlling Z1 supplies the pocket whatever the long route's ends (sea supply does not need a route to own-side
  // territory; Libya, for example, has no route to Italy in the map).
  it.each([[Z1, Z3], [Z1, Z2]])("is supplied through its own controlled waters (%s/%s)", (a, b) => {
    expect(pocket([a, b])[1]).toBe(0);
  });

  it("supplies a pocket over its only long route when neither end has port zones", () => {
    const map: SimMap = {
      ...makeMap({ owners: ["A", "A", "D"], land: [[1, 2]] }),
      seaRoutes: [{ a: 1, b: 0, zone: 0, km: LONG_ROUTE_KM + 1 }],
    };
    const sim = duel(map, { encirclement: true });
    expect(ports(sim, 0)).toEqual([]);
    expect(ports(sim, 1)).toEqual([]);
    expect(encircledStates(sim, computeFronts(sim), fleetPower(sim))[1]).toBe(1);
    addFleet(sim, "A", 0);
    expect(encircledStates(sim, computeFronts(sim), fleetPower(sim))[1]).toBe(0);
  });

  it("requires destination-port control even when the pocket has no port zones", () => {
    const map: SimMap = {
      ...makeMap({
        owners: ["A", "A", "D", "A"], land: [[1, 2]],
        zones: Array.from({ length: 3 }, () => ({ neighbors: [] })),
      }),
      seaRoutes: [
        { a: 0, b: 3, zone: Z2, km: 10 },
        { a: 1, b: 0, zone: Z3, km: LONG_ROUTE_KM + 1 },
      ],
    };
    const sim = duel(map, { encirclement: true });
    expect(ports(sim, 1)).toEqual([]);
    expect(ports(sim, 0)).toEqual([Z2]);
    addFleet(sim, "A", Z3);
    addFleet(sim, "D", Z2);
    expect(encircledStates(sim, computeFronts(sim), fleetPower(sim))[1]).toBe(1);
    addFleet(sim, "A", Z2);
    expect(encircledStates(sim, computeFronts(sim), fleetPower(sim))[1]).toBe(0);
  });
});

interface RouteData extends SimMap {
  seaRoutes: (SimMap["seaRoutes"][number] & { name?: string })[];
}

const realMap = JSON.parse(readFileSync(new URL("../../../data/map.json", import.meta.url), "utf8")) as RouteData;

describe("real route data and regressions", () => {
  it("keeps the UK-Malta convoy long and the three 1940 Germany-Norway routes short", () => {
    const convoy = realMap.seaRoutes.find((r) => r.name === "UK - Malta (convoy)");
    expect(convoy).toBeDefined();
    expect(convoy!.km).toBeGreaterThan(DEFAULT_CONFIG.longRouteKm);
    const norway = realMap.seaRoutes.filter((r) => /^Germany - .* \(1940\)$/.test(r.name ?? ""));
    expect(norway.map((r) => r.name).sort()).toEqual([
      "Germany - Bergen (1940)", "Germany - Kristiansand (1940)", "Germany - Oslo (1940)",
    ]);
    for (const route of norway) {
      expect([realMap.states[route.a].owner, realMap.states[route.b].owner].sort()).toEqual(["GER", "NOR"]);
      expect(route.km).toBeGreaterThan(0);
      expect(route.km).toBeLessThan(DEFAULT_CONFIG.longRouteKm);
    }
  });

  it("stops Italy landing in Cornwall from captured Malta with only Western Mediterranean control", () => {
    const convoy = realMap.seaRoutes.find((r) => r.name === "UK - Malta (convoy)")!;
    const sim = fixture(realMap, { longRouteKm: DEFAULT_CONFIG.longRouteKm });
    const italy = sim.tags.indexOf("ITA"), uk = sim.tags.indexOf("UK");
    setWar(sim, "ITA", "UK");
    sim.military.fill(0);
    sim.military[italy] = 1e6;
    sim.military[uk] = 1;
    // The convoy's two endpoints are Cornwall and Malta, both originally British.
    expect([realMap.states[convoy.a].owner, realMap.states[convoy.b].owner]).toEqual(["UK", "UK"]);
    sim.owner[convoy.b] = italy;
    const k = routeEntry(sim, convoy.b, convoy.a);
    expect(sim.zoneNames[convoy.zone!]).toBe("西地中海");
    addFleet(sim, "ITA", convoy.zone!);
    for (const z of ports(sim, convoy.a)) addFleet(sim, "UK", z);
    expect(ports(sim, convoy.a).length).toBeGreaterThan(0);
    expect(hasSuperiority(sim, fleetPower(sim), italy, uk, convoy.zone!)).toBe(true);
    expect(routeControlled(sim, fleetPower(sim), italy, uk, k)).toBe(false);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles.flatMap((b) => b.captures)).not.toContain(convoy.a);
    applyBattles(sim, battles);
    expect(sim.owner[convoy.a]).toBe(uk);
  });

  it("lets Germany land in Norway under the default exemption despite Norway's navy", () => {
    expect(DEFAULT_CONFIG.landingWithoutNavy.GER).toEqual(["NOR"]);
    const route = realMap.seaRoutes.find((r) => r.name === "Germany - Oslo (1940)")!;
    const sim = fixture({
      ...makeMap({ owners: ["GER", "NOR", "NOR"], land: [] }),
      seaRoutes: [{ a: 0, b: 1, zone: 0, km: route.km }],
    }, { landingWithoutNavy: DEFAULT_CONFIG.landingWithoutNavy });
    setWar(sim, "GER", "NOR");
    sim.military[sim.tags.indexOf("GER")] = 30;
    sim.military[sim.tags.indexOf("NOR")] = 10;
    addFleet(sim, "NOR", 0, 1000);
    const battles = resolveCombat(sim, computeFronts(sim));
    expect(battles.flatMap((b) => b.captures)).toEqual([1]);
    applyBattles(sim, battles);
    expect(sim.owner[1]).toBe(sim.tags.indexOf("GER"));
  });
});
