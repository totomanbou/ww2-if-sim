import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTerrain } from "../../../scripts/map/terrain";
import { applyBattles, computeFronts, resolveCombat } from "../combat";
import { DEFAULT_CONFIG, type SimConfig } from "../config";
import type { MapData, MapState } from "../mapTypes";
import { createWeeklySimulation as createSimulation, makeMap, makeScenario, setWar } from "./helpers";

const config = {
  encirclement: false,
  lossFactors: {},
  lowPriorityFronts: {},
  slowAdvanceLand: {},
  capitulateOnCapitalLoss: [],
  capitulateOnContinentLoss: [],
  regionPriority: {},
  landingWithoutNavy: {},
  transitSpeedKmPerWeek: 1e9,
  holdShare: 0,
  indirectFrontPriority: 1,
  overseasDistanceFactor: 1,
  frontComparisonMode: "allocated",
  advanceRate: 2,
  advanceMax: 2,
  advanceBreadthEdges: 1e9,
  navalPenalty: 0.5,
  lossRate: 0.1,
} satisfies Partial<SimConfig>;

type Kind = "land" | "sea";
const seeds = Array.from({ length: 200 }, (_, i) => Math.imul(i + 1, 0x9e3779b9) >>> 0);

function star(kind: Kind, targets: number[], seed = 17, ratio = 1.5, overrides: Partial<SimConfig> = {}, missing = false) {
  const edges: [number, number][] = targets.map((_, i) => [0, i + 1]);
  const map = makeMap({
    owners: ["A", ...targets.map(() => "X")],
    land: kind === "land" ? edges : [],
    sea: kind === "sea" ? edges : [],
  });
  if (!missing) map.terrain = [2, ...targets];
  const sim = createSimulation(map, makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } }), {
    seed, config: { ...config, ...overrides },
  });
  const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
  sim.military[a] = 10 * ratio / (kind === "sea" ? sim.config.navalPenalty : 1);
  sim.military[x] = 10;
  if (kind === "sea") sim.fleets.push({ country: a, zone: 0, strength: 100, target: 0 });
  setWar(sim, "A", "X");
  return sim;
}

function oneBattle(sim: ReturnType<typeof createSimulation>) {
  const fronts = computeFronts(sim);
  expect(fronts.lineCountries.size).toBe(1);
  const battles = resolveCombat(sim, fronts);
  expect(battles).toHaveLength(1);
  return battles[0];
}

function fight(kind: Kind, terrain: number, factors: SimConfig["lossFactors"] = {}) {
  const edges: [number, number][] = [[0, 1], [2, 1]];
  const sim = createSimulation({
    ...makeMap({ owners: ["A", "X", "B"], land: kind === "land" ? edges : [], sea: kind === "sea" ? edges : [] }),
    terrain: [2, terrain, 0],
  }, makeScenario({ A: { faction: "allies" }, B: { faction: "allies" }, X: { faction: "axis" } }), {
    seed: 17, config: { ...config, advanceRate: 0, lossFactors: factors },
  });
  for (const [tag, army] of Object.entries({ A: 60, B: 40, X: 25 })) sim.military[sim.tags.indexOf(tag)] = army;
  if (kind === "sea") {
    for (const tag of ["A", "B"]) sim.fleets.push({ country: sim.tags.indexOf(tag), zone: 0, strength: 100, target: 0 });
  }
  setWar(sim, "A", "X");
  setWar(sim, "B", "X");
  const before = sim.military.slice(), owners = sim.owner.slice();
  const battle = oneBattle(sim);
  expect(battle.attackers).toEqual([sim.tags.indexOf("A"), sim.tags.indexOf("B")]);
  expect(battle.attShare).toEqual([0.6, 0.4]);
  expect(battle.captures).toEqual([]);
  applyBattles(sim, [battle]);
  expect(sim.owner).toEqual(owners);
  const losses = Object.fromEntries(sim.tags.map((tag, c) => [tag, before[c] - sim.military[c]]));
  return { battle, losses, sim };
}

describe("terrain defaults and initialization", () => {
  it("defaults to the documented easy, normal and hard factors", () => {
    expect(DEFAULT_CONFIG.terrainLoss).toEqual([0.75, 1, 1.5]);
    expect(DEFAULT_CONFIG.terrainCapture).toEqual([1.3, 1, 0.6]);
  });

  it("copies per-state terrain, including easy zero, into sim.terrain", () => {
    const map = { ...makeMap({ owners: ["A", "X", "X"], land: [[0, 1], [0, 2]] }), terrain: [0, 1, 2] };
    const sim = createSimulation(map, makeScenario({ A: {}, X: {} }));
    expect(sim.terrain).toBeInstanceOf(Uint8Array);
    expect(Array.from(sim.terrain)).toEqual([0, 1, 2]);
    map.terrain[0] = 2;
    expect(sim.terrain[0]).toBe(0);
  });

  it("defaults every state to normal when map.terrain is missing", () => {
    const sim = star("land", [1, 1, 1], 17, 1.5, {}, true);
    expect(Array.from(sim.terrain)).toEqual([1, 1, 1, 1]);
  });
});

describe.each(["land", "sea"] as const)("%s terrain combat", (kind) => {
  it("produces identical battles and applied results for missing and explicit all-normal terrain", () => {
    for (const seed of seeds.slice(0, 20)) {
      const missing = star(kind, [1, 1, 1], seed, 1.75, {}, true);
      const explicit = star(kind, [1, 1, 1], seed, 1.75);
      explicit.terrain[0] = 1;
      const baseline = oneBattle(missing), battle = oneBattle(explicit);
      expect(battle).toEqual(baseline);
      expect(battle.attLossFactor).toBe(1);
      applyBattles(missing, [baseline]);
      applyBattles(explicit, [battle]);
      expect(explicit.owner).toEqual(missing.owner);
      expect(explicit.military).toEqual(missing.military);
      expect(explicit.losses).toEqual(missing.losses);
      expect(explicit.rng.state).toBe(missing.rng.state);
    }
  });

  it.each([{ terrain: 0, factor: 0.75 }, { terrain: 2, factor: 1.5 }])(
    "scales each attacker's losses by $factor for target terrain $terrain, leaving defenders unchanged",
    ({ terrain, factor }) => {
      const baseline = fight(kind, 1), changed = fight(kind, terrain);
      expect(changed.battle).toEqual({ ...baseline.battle, attLossFactor: factor });
      expect(baseline.losses.A).toBeCloseTo(2 * 2.5 * 0.6, 8);
      expect(baseline.losses.B).toBeCloseTo(2 * 2.5 * 0.4, 8);
      expect(baseline.losses.X).toBeCloseTo(2.5, 8);
      for (const tag of ["A", "B"]) expect(changed.losses[tag]).toBeCloseTo(factor * baseline.losses[tag], 8);
      expect(changed.losses.X).toBeCloseTo(baseline.losses.X, 8);
      expect(changed.sim.losses.allies.army).toBeCloseTo(changed.losses.A + changed.losses.B, 8);
      expect(changed.sim.losses.axis.army).toBeCloseTo(changed.losses.X, 8);
    },
  );

  it("multiplies terrain, attacker share and country loss factors together", () => {
    const { losses } = fight(kind, 2, { A: { X: 0.5 }, B: { X: 2 }, X: { A: 0.8 } });
    expect(losses.A).toBeCloseTo(2 * 2.5 * 0.6 * 1.5 * 0.5, 8);
    expect(losses.B).toBeCloseTo(2 * 2.5 * 0.4 * 1.5 * 2, 8);
    expect(losses.X).toBeCloseTo(2.5 * 0.8, 8);
  });

  it.each([{ ratio: 1.5, expected: 1, mode: "rate" }, { ratio: 100, expected: 2, mode: "cap" }])(
    "scales the advance $mode: mean captures are hard < normal < easy over 200 fixed seeds",
    ({ ratio, expected }) => {
      const means = [0, 1, 2].map((terrain) => {
        const counts = seeds.map((seed) => oneBattle(star(kind, Array<number>(8).fill(terrain), seed, ratio)).captures.length);
        const mean = counts.reduce((sum, n) => sum + n, 0) / seeds.length;
        expect(Math.abs(mean - expected * configFactor(terrain))).toBeLessThan(0.12);
        return mean;
      });
      expect(means[2]).toBeLessThan(means[1]);
      expect(means[1]).toBeLessThan(means[0]);
    },
  );

  it.each([[0, 2], [2, 0]])("prefers easy over hard candidates independent of state order (%j)", (...terrain) => {
    const totals = [0, 0];
    for (const seed of seeds) {
      // The unskewed average is 0.95; rate and cap yield exactly one capture.
      const sim = star(kind, terrain, seed, 100, { advanceRate: 1 / 0.95, advanceMax: 1 / 0.95 });
      const battle = oneBattle(sim);
      expect(battle.captures).toHaveLength(1);
      totals[battle.captures[0] - 1]++;
    }
    const easy = totals[terrain.indexOf(0)], hard = totals[terrain.indexOf(2)];
    expect(easy + hard).toBe(seeds.length);
    expect(easy).toBeGreaterThan(hard);
    expect(Math.abs(easy / seeds.length - 1.3 / 1.9)).toBeLessThan(0.1);
  });

  it("averages loss and capture factors over unskewed, unequal target weights", () => {
    // Easy state 2 has two adjacent attacker states; hard state 3 has one.
    const edges: [number, number][] = [[0, 2], [1, 2], [0, 3]];
    let captures = 0;
    for (const seed of seeds) {
      const sim = createSimulation({
        ...makeMap({ owners: ["A", "A", "X", "X"], land: kind === "land" ? edges : [], sea: kind === "sea" ? edges : [] }),
        terrain: [2, 0, 0, 2],
      }, makeScenario({ A: { faction: "allies" }, X: { faction: "axis" } }), {
        seed, config: { ...config, advanceRate: 1, advanceMax: 10 },
      });
      const a = sim.tags.indexOf("A"), x = sim.tags.indexOf("X");
      sim.military[a] = 20 / (kind === "sea" ? config.navalPenalty : 1);
      sim.military[x] = 10;
      if (kind === "sea") sim.fleets.push({ country: a, zone: 0, strength: 100, target: 0 });
      setWar(sim, "A", "X");
      const battle = oneBattle(sim);
      expect(battle.attLossFactor).toBeCloseTo((2 * 0.75 + 1.5) / 3, 8);
      captures += battle.captures.length;
    }
    // The capture mean is (2 * 1.3 + 0.6) / 3, before capture weights are skewed.
    expect(Math.abs(captures / seeds.length - (2 * 1.3 + 0.6) / 3)).toBeLessThan(0.08);
  });
});

function configFactor(terrain: number) { return DEFAULT_CONFIG.terrainCapture[terrain]; }

const rawDir = new URL("../../../data/raw/", import.meta.url);
const missingRaw = ["ne_10m_geography_regions_polys.geojson", "ne_10m_rivers_lake_centerlines.geojson"]
  .some((file) => !existsSync(new URL(file, rawDir)));

function terrainMap(points: [number, number][]): Pick<MapData, "states" | "cities" | "countries" | "importantCities"> {
  const states: MapState[] = points.map((lonlat, id) => ({
    id, owner: "A", areaKm2: 1, lonlat, center: lonlat, coastal: false, core: true, rings: [],
  }));
  return { states, cities: { London: -1, Moscow: -1, Honolulu: -1, Paris: -1, Rome: -1, Berlin: -1, Tokyo: -1 }, countries: {} };
}

describe("buildTerrain with Natural Earth raw data", () => {
  it.skipIf(missingRaw)("classifies an open ocean sample as normal and Arctic jungle-free terrain as hard with a city", () => {
    const map = terrainMap([[0, 0], [0, 89]]);
    map.cities.London = 1;
    const result = buildTerrain(map, () => null, () => -1, rawDir);
    expect(result.terrain).toEqual([1, 2]);
    expect(result.score).toEqual([0, 1.5]);
  });

  it.skipIf(missingRaw)("adds one urban bonus for overlapping victory cities, capitals and important cities", () => {
    const map = terrainMap([[0, 0]]);
    const baseline = buildTerrain(map, () => null, () => -1, rawDir);
    map.cities.London = 0;
    map.countries.A = { defaultCapital: 0, stateCount: 1 };
    map.importantCities = [{ id: "test", name: "Test", home: "A", state: 0, lonlat: [0, 0], position: [0, 0] }];
    const urban = buildTerrain(map, () => null, () => -1, rawDir);
    expect(urban.score[0] - baseline.score[0]).toBeCloseTo(0.5, 8);
    expect(urban.terrain).toEqual([1]);
  });
});
