import type { VictoryCity } from "../mapTypes";
import { createSimulation, type InitOptions } from "../init";
import { tickTime } from "../date";
import type { CountrySetup, Scenario, SimMap, SimState, WarDeclaration } from "../types";

/** Keep existing weekly coefficient / fixture assertions as explicit legacy regression checks. */
// Legacy rules for the older tests: weekly steps and a fixed capitulation threshold (no stability dependence),
// unless the test's config says otherwise.
export function createWeeklySimulation(map: SimMap, scenario: Scenario, opts: InitOptions = {}): SimState {
  return createSimulation(map, scenario, { ...opts, config: { capitulationStabilitySlope: 0, ...opts.config, stepDays: 7 } });
}

export function weeklyTickTime(startMs: number, tick: number): number { return tickTime(startMs, tick, 7); }

interface MapOptions {
  owners: string[];
  land: [number, number][];
  sea?: ([number, number] | [number, number, number])[];
  zones?: { neighbors: number[] }[];
  core?: boolean[];
  lonlat?: ([number, number] | undefined)[];
  cities?: Partial<Record<VictoryCity, number>>;
  capitals?: Record<string, number>;
}

export function makeMap({
  owners, land, sea = [], zones = [{ neighbors: [] }], core = [],
  lonlat = [], cities = {}, capitals = {},
}: MapOptions): SimMap {
  const landAdj: number[][] = owners.map(() => []);
  for (const [a, b] of land) {
    landAdj[a].push(b);
    landAdj[b].push(a);
  }
  const countries = Object.fromEntries(
    [...new Set(owners)].map((tag) => [
      tag, { defaultCapital: capitals[tag] ?? owners.indexOf(tag) },
    ]),
  );
  return {
    states: owners.map((owner, i) => ({
      owner, core: core[i] ?? true, ...(lonlat[i] ? { lonlat: lonlat[i] } : {}),
    })),
    landAdj,
    seaRoutes: sea.map(([a, b, zone = 0]) => ({ a, b, zone })),
    seaZones: zones.map(({ neighbors }, i) => ({ name: `Z${i}`, neighbors })),
    cities: {
      London: 0, Moscow: 0, Honolulu: 0, Paris: 0,
      Rome: 0, Berlin: 0, Tokyo: 0, ...cities,
    },
    countries,
  };
}

export function makeScenario(
  countries: Record<string, Partial<CountrySetup>>,
  wars: WarDeclaration[] = [],
  invulnerable: number[] = [],
): Scenario {
  return {
    name: "Test scenario",
    seed: 1,
    countries: Object.fromEntries(Object.entries(countries).map(([tag, setup]) => [
      tag,
      { name: tag, color: "#888", faction: "neutral", industry: 10, shipbuilding: 0, stability: 1, ...setup },
    ])),
    wars,
    stateOverrides: Object.fromEntries(invulnerable.map((id) => [String(id), { invulnerable: true }])),
  };
}

export function setWar(sim: SimState, tagA: string, tagB: string): void {
  const a = sim.tags.indexOf(tagA);
  const b = sim.tags.indexOf(tagB);
  if (a < 0 || b < 0) throw new Error("Both countries must exist on the map");
  const nC = sim.tags.length;
  sim.atWar[a * nC + b] = sim.atWar[b * nC + a] = 1;
}
