import { makeConfig, type SimConfig } from "./config";
import { parseDate } from "./date";
import { MASK, type MaskTable } from "./mask";
import { makeRng } from "./rng";
import { importantCityFallen } from "./importantCities";
import { capitalOf } from "./scenario";
import type { CountrySetup, Faction, Fleet, Scenario, SimMap, SimState } from "./types";

function csr(n: number, lists: number[][]): { off: Int32Array; nb: Int32Array } {
  const off = new Int32Array(n + 1);
  for (let s = 0; s < n; s++) off[s + 1] = off[s] + lists[s].length;
  const nb = new Int32Array(off[n]);
  for (let s = 0; s < n; s++) nb.set(lists[s], off[s]);
  return { off, nb };
}

const FALLBACK_COUNTRY: Omit<CountrySetup, "name"> = { color: "#999999", faction: "neutral", industry: 0.1, shipbuilding: 0, stability: 0.5 };

export interface InitOptions {
  config?: Partial<SimConfig>;
  mask?: MaskTable;
  /** Overrides scenario.seed. */
  seed?: number;
}

/** Every land-border pair once (s < t), for own-side land components. */
function landPairs(map: SimMap): { landPairA: Int32Array; landPairB: Int32Array } {
  const a: number[] = [], b: number[] = [];
  map.landAdj.forEach((ns, s) => ns.forEach((t) => { if (t > s) { a.push(s); b.push(t); } }));
  return { landPairA: Int32Array.from(a), landPairB: Int32Array.from(b) };
}

/** Every adjacent state pair (land border or sea route) once. */
function adjacentPairs(map: SimMap): { adjA: Int32Array; adjB: Int32Array } {
  const a: number[] = [], b: number[] = [];
  map.landAdj.forEach((ns, s) => ns.forEach((t) => { if (t > s) { a.push(s); b.push(t); } }));
  for (const r of map.seaRoutes) { a.push(r.a); b.push(r.b); }
  return { adjA: Int32Array.from(a), adjB: Int32Array.from(b) };
}

/** Land mass of each state: connected components over land borders only (the smallest state index). */
function landMasses(map: SimMap): Int32Array {
  const parent = Int32Array.from(map.states, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  map.landAdj.forEach((ns, s) => ns.forEach((t) => {
    const a = find(s), b = find(t);
    if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
  }));
  return Int32Array.from(parent, (_, i) => find(i));
}

/** Builds the initial simulation state for 1939-09-01 (tick 0, nothing processed yet). */
export function createSimulation(map: SimMap, scenario: Scenario, opts: InitOptions = {}): SimState {
  const config = makeConfig(opts.config);
  const nStates = map.states.length;

  // Country order: every tag on the map (sorted), so indices are stable for a given map, then the scenario's countries
  // without territory at the start (e.g. Free France), sorted.
  const mapTags = [...new Set(map.states.map((s) => s.owner))].sort();
  const tags = [...mapTags, ...Object.keys(scenario.countries).filter((t) => !mapTags.includes(t)).sort()];
  const tagIndex = new Map(tags.map((t, i) => [t, i]));
  const nC = tags.length;
  const setups = tags.map((t) => scenario.countries[t] ?? { ...FALLBACK_COUNTRY, name: t });

  const origOwner = Uint16Array.from(map.states, (s) => tagIndex.get(s.owner)!);
  const origCount = new Int32Array(nC);
  const coreCount = new Int32Array(nC);
  map.states.forEach((s, i) => {
    origCount[origOwner[i]]++;
    if (s.core) coreCount[origOwner[i]]++;
  });
  // Industry weight per state: homeland states share (1 − colonyIndustryShare), colonies the rest.
  const weight = new Float64Array(nStates);
  map.states.forEach((s, i) => {
    const c = origOwner[i];
    const nCore = coreCount[c], nCol = origCount[c] - nCore;
    if (nCol === 0) weight[i] = 1 / nCore;
    else if (nCore === 0) weight[i] = 1 / nCol;
    else weight[i] = s.core ? (1 - config.colonyIndustryShare) / nCore : config.colonyIndustryShare / nCol;
  });

  const seaLists: number[][] = Array.from({ length: nStates }, () => []);
  const seaZoneLists: number[][] = Array.from({ length: nStates }, () => []);
  const seaKmLists: number[][] = Array.from({ length: nStates }, () => []);
  const portLists: number[][] = Array.from({ length: nStates }, () => []);
  for (const r of map.seaRoutes) {
    const z = r.zone ?? -1, km = r.km ?? 0;
    seaLists[r.a].push(r.b);
    seaZoneLists[r.a].push(z);
    seaKmLists[r.a].push(km);
    seaLists[r.b].push(r.a);
    seaZoneLists[r.b].push(z);
    seaKmLists[r.b].push(km);
    if (z >= 0 && km <= config.longRouteKm) {
      if (!portLists[r.a].includes(z)) portLists[r.a].push(z);
      if (!portLists[r.b].includes(z)) portLists[r.b].push(z);
    }
  }
  const seaKm = Float32Array.from(csr(nStates, seaKmLists).nb);
  const port = csr(nStates, portLists);
  const seaFrom = new Int32Array(seaKm.length);
  for (let s = 0, k = 0; s < nStates; s++) for (let j = 0; j < seaLists[s].length; j++) seaFrom[k++] = s;
  const land = csr(nStates, map.landAdj);
  const sea = csr(nStates, seaLists);
  const seaZone = Int16Array.from(csr(nStates, seaZoneLists).nb);

  // Sea zones: all-pairs hop distances (BFS from each zone).
  const zoneNeighbors = (map.seaZones ?? []).map((z) => z.neighbors);
  const nZ = zoneNeighbors.length;
  const zoneDist = new Uint8Array(nZ * nZ).fill(255);
  for (let z0 = 0; z0 < nZ; z0++) {
    zoneDist[z0 * nZ + z0] = 0;
    for (let queue = [z0], h = 0; h < queue.length; h++) {
      const z = queue[h];
      for (const n of zoneNeighbors[z]) {
        if (zoneDist[z0 * nZ + n] !== 255) continue;
        zoneDist[z0 * nZ + n] = zoneDist[z0 * nZ + z] + 1;
        queue.push(n);
      }
    }
  }
  // Home zone: the zone most of a country's homeland sea routes run through (any own route if none).
  const homeVotes = Array.from({ length: nC }, () => new Map<number, number>());
  for (const r of map.seaRoutes) {
    const z = r.zone ?? -1;
    if (z < 0) continue;
    for (const s of [r.a, r.b]) {
      const v = homeVotes[origOwner[s]];
      v.set(z, (v.get(z) ?? 0) + (map.states[s].core ? 10 : 1));
    }
  }
  const homeZone = Int16Array.from(homeVotes, (v) => {
    let best = -1, bestN = 0;
    for (const [z, n] of v) if (n > bestN || (n === bestN && z < best)) { best = z; bestN = n; }
    return best;
  });

  const capital = Int32Array.from(tags, (tag) => capitalOf(map, tag));
  const landOf = Uint16Array.from(map.states, (s, i) => tagIndex.get(s.formerOwner ?? "") ?? origOwner[i]);
  const stateLonLat = new Float64Array(nStates * 2).fill(NaN);
  map.states.forEach((s, i) => {
    if (s.lonlat) stateLonLat.set(s.lonlat, i * 2);
  });

  const invulnerable = new Uint8Array(nStates);
  for (const [id, o] of Object.entries(scenario.stateOverrides ?? {})) {
    const s = Number(id);
    if (o.invulnerable && s >= 0 && s < nStates) invulnerable[s] = 1;
  }

  const industry = Float64Array.from(setups, (c) => Math.max(0, c.industry));
  const shipbuilding = Float64Array.from(setups, (c) => Math.max(0, c.shipbuilding ?? 0));
  const stability = Float64Array.from(setups, (c) => Math.min(1, Math.max(0, c.stability)));
  const military = Float64Array.from(industry, (ind, c) => ind * stability[c] * (config.initialYearsByCountry[tags[c]] ?? config.initialYears));

  // Fleets: initial navy = the preset's 1939 fleet (CountrySetup.navy) or, if missing, shipbuilding × stability ×
  // years; split into equal fleets at home.
  const fleets: Fleet[] = [];
  tags.forEach((t, c) => {
    const given = setups[c].navy;
    const navy = typeof given === "number" && Number.isFinite(given)
      ? Math.max(0, given)
      : shipbuilding[c] * stability[c] * (config.navyInitialYearsByCountry[t] ?? config.navyInitialYears);
    if (navy <= 0 || homeZone[c] < 0) return;
    const n = Math.min(config.maxFleets, Math.max(1, Math.ceil(navy / config.navyPerFleet)));
    for (let k = 0; k < n; k++) fleets.push({ country: c, zone: homeZone[c], strength: navy / n, target: homeZone[c] });
  });

  const restrictions = (scenario.landingRestrictions ?? []).flatMap((r) => {
    const d = tagIndex.get(r.defender);
    if (d === undefined) return [];
    const explicit = r.protect ? new Set(r.protect) : null;
    const protects = Uint8Array.from(map.states, (s, i) =>
      (explicit ? explicit.has(i) : origOwner[i] === d && (!r.coreOnly || s.core)) ? 1 : 0);
    return [{ protects, region: Int32Array.from(r.region.filter((s) => s >= 0 && s < nStates)), heldBy: r.blockedWhileHeldBy }];
  });

  const wars = [...scenario.wars]
    .map((w, i) => ({ w, i }))
    .sort((p, q) => parseDate(p.w.date) - parseDate(q.w.date) || p.i - q.i)
    .map(({ w }) => w);

  const sim: SimState = {
    config,
    mask: opts.mask ?? MASK,
    scenario,
    seed: opts.seed ?? scenario.seed,
    tags,
    names: setups.map((c) => c.name),
    faction: setups.map((c) => c.faction as Faction),
    industry,
    shipbuilding,
    stability,
    capital,
    terrain: Uint8Array.from({ length: map.states.length }, (_, s) => map.terrain?.[s] ?? 1),
    importantCities: (map.importantCities ?? []).map((city) => ({ ...city })),
    importantCityFallen: new Uint8Array(map.importantCities?.length ?? 0),
    stateLonLat,
    landOf,
    nStates,
    landOff: land.off,
    landNb: land.nb,
    seaOff: sea.off,
    seaNb: sea.nb,
    seaZone,
    zoneNames: (map.seaZones ?? []).map((z) => z.name),
    zoneNeighbors,
    zoneDist,
    homeZone,
    routeA: Int32Array.from(map.seaRoutes, (r) => r.a),
    routeB: Int32Array.from(map.seaRoutes, (r) => r.b),
    routeZone: Int16Array.from(map.seaRoutes, (r) => r.zone ?? -1),
    ...adjacentPairs(map),
    seaFrom,
    seaKm,
    portOff: port.off,
    portZone: Int16Array.from(port.nb),
    ...landPairs(map),
    landMass: landMasses(map),
    restrictions,
    origOwner,
    weight,
    origCount,
    invulnerable,
    core: Uint8Array.from(map.states, (s) => (s.core ? 1 : 0)),
    cities: { ...map.cities },
    startMs: parseDate(config.startDate),
    endMs: parseDate(config.endDate),
    tick: 0,
    owner: origOwner.slice(),
    fleets,
    invLost: new Uint8Array(nStates),
    military,
    atWar: new Uint8Array(nC * nC),
    capitulated: new Uint8Array(nC),
    capitalHeld: new Uint8Array(nC).fill(1),
    capitalOccupied: new Uint8Array(nC),
    revivedAwaitingCapital: new Uint8Array(nC),
    facing: new Float64Array(nC * nC),
    frontArmies: [],
    reinforcementsDone: new Uint8Array(config.cityFallReinforcements.length),
    warStartDone: new Uint8Array(config.warStartReinforcements.length),
    surpriseStart: new Int32Array(nC).fill(-1),
    losses: { axis: { army: 0, navy: 0 }, allies: { army: 0, navy: 0 } },
    transfers: [...(scenario.transfers ?? [])].sort((a, b) => a.date.localeCompare(b.date)),
    transferDone: new Uint8Array((scenario.transfers ?? []).length),
    deployed: new Map(),
    entered: new Uint8Array(nC),
    nextWar: 0,
    wars,
    axisBWeeks: 0,
    cityFallen: { London: false, Moscow: false, Honolulu: false, Paris: false, Rome: false, Berlin: false, Tokyo: false },
    events: [],
    history: [],
    rng: makeRng(opts.seed ?? scenario.seed),
    result: null,
  };
  sim.importantCities.forEach((_, i) => { sim.importantCityFallen[i] = importantCityFallen(sim, i) ? 1 : 0; });
  return sim;
}
