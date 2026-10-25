import { parseDate, perStepProbability, stepWeeks, tickTime } from "./date";
import { fleetPower, routeControlled } from "./navy";
import { activeLandingBans, blockedLandings, closedLandings } from "./landing";
import { landingPreference, landingTheatreStates } from "./landingFronts";
import { canDeployToFront } from "./deployment";
import { activeCapitulationOccupier } from "./occupation";
import { nextFloat, type Rng } from "./rng";
import { CellShares } from "./cells";
import type { CellMap, SimState } from "./types";

/** Targets one side can attack in a war pair: state id → number of own adjacent states. */
interface Targets {
  land: Map<number, number>;
  sea: Map<number, number>;
  /** Sea zones of the routes leading to each sea target. */
  seaZones: Map<number, Set<number>>;
  /** Sea route entries (indices into sim.seaNb, from the attacker's states) leading to each sea target. */
  seaRoutes: Map<number, number[]>;
}

export interface Fronts {
  /** Ordered pair key (att * nC + def) → attackable enemy states. */
  targets: Map<number, Targets>;
  /** The same targets split by line, since one embarkation state can serve several amphibious approaches. */
  targetsByLine: Map<number, Map<number, Targets>>;
  /** A state can occur on more than one line; line[] retains its first line for legacy callers. */
  statesByLine: Map<number, number[]>;
  theatreNames: Map<number, string>;
  /** Unordered warring pairs (a < b) that share at least one front, sorted. */
  pairs: [number, number][];
  /** Front count per country (each adjacent enemy state pair counted once per side). */
  frontCount: Int32Array;
  /**
   * Primary line of every state (-1 = not a front state), retained for simple callers. A landing preparation
   * line has separate virtual nodes (offset by theatre × nStates); use statesByLine for all participations.
   * Land lines join touching front edges; shared embarkation states do not join different landing theatres.
   */
  line: Int32Array;
  /** Countries taking part in each line (front-state owners and supporters linked to them). */
  lineCountries: Map<number, Set<number>>;
  /** All front states (line[s] >= 0). */
  frontStates: Int32Array;
  /** Side of every country (sideOf), for hot loops. */
  sideArr: Int32Array;
  /** Own-side land component of every state (sideLand). */
  sideComp: Int32Array;
  /**
   * Per line and country: front length (adjacent enemy state pairs, as in frontCount) and the sum of
   * the lon / lat of the country's front states on the line.
   */
  lineFront: Map<number, Map<number, { edges: number; lon: number; lat: number; n: number }>>;
  /**
   * Per line and side (see sideOf): the side's front length on the line and the sum of the lon / lat of
   * its front states (the line's centre for that side, used for distances from capitals).
   */
  lineSide: Map<number, Map<number, { edges: number; lon: number; lat: number; n: number }>>;
}

/** Side of a country in combat: -1 axis, -2 allies; a "neutral"-faction country is a side of its own. */
export function sideOf(sim: SimState, c: number): number {
  const f = sim.faction[c];
  return f === "axis" ? -1 : f === "allies" ? -2 : c;
}

export const invulnerableActive = (sim: SimState, s: number) => sim.invulnerable[s] === 1 && sim.invLost[s] === 0;

/**
 * Fronts are pairs of adjacent (land or sea) states owned by countries at war. An invulnerable
 * state is never a target, but its fronts still exist and it can be attacked from.
 */
export function computeFronts(sim: SimState): Fronts {
  const nC = sim.tags.length;
  const { owner, atWar, landOff, landNb, seaOff, seaNb, seaZone } = sim;
  const atWarAny = new Uint8Array(nC);
  for (let a = 0; a < nC; a++) for (let b = 0; b < nC; b++) if (atWar[a * nC + b]) atWarAny[a] = 1;
  const sideArr = Int32Array.from({ length: nC }, (_, c) => sideOf(sim, c));
  const sideComp = sideLand(sim, sideArr);
  const targets = new Map<number, Targets>();
  const frontCount = new Int32Array(nC);
  const pairSet = new Set<number>();
  // Union-find over front nodes (-1 = unused), with a separate layer for each amphibious approach.
  const theatre = landingTheatreStates(sim);
  const parent = new Int32Array(sim.nStates * (sim.config.landingTheatres.length + 1)).fill(-1);
  const front: number[] = [];
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (x !== r) {
      const n = parent[x];
      parent[x] = r;
      x = n;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    if (parent[a] < 0) { parent[a] = a; front.push(a); }
    if (parent[b] < 0) { parent[b] = b; front.push(b); }
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };
  const edges: { o: number; s: number; t: number; node: number; kind: "land" | "sea"; zone: number; route: number; sector: number }[] = [];
  // Called for neighbours t of s whose owner p is at war with s's owner o.
  const visit = (o: number, s: number, t: number, p: number, kind: "land" | "sea", zone = -1, route = -1) => {
    const sector = kind === "sea" ? Math.max(theatre[s], theatre[t]) : 0;
    // An existing land attack by the same country needs no second amphibious plan for this target.
    if (sector) {
      for (let k = landOff[t]; k < landOff[t + 1]; k++) if (owner[landNb[k]] === o) return;
    }
    frontCount[o]++;
    pairSet.add(o < p ? o * nC + p : p * nC + o);
    // Distinct copies stop Britain from joining all beaches into one line. Both endpoints are separate from
    // ground combat: troops prepared in Britain must redeploy to the bridgehead before fighting inland.
    const sn = sector * sim.nStates + s;
    const tn = sector * sim.nStates + t;
    union(sn, tn);
    edges.push({ o, s, t, node: sn, kind, zone, route, sector });
    if (invulnerableActive(sim, t)) return;
    const key = o * nC + p;
    let tg = targets.get(key);
    if (!tg) targets.set(key, (tg = { land: new Map(), sea: new Map(), seaZones: new Map(), seaRoutes: new Map() }));
    const m = tg[kind];
    m.set(t, (m.get(t) ?? 0) + 1);
    if (kind === "sea") {
      let zs = tg.seaZones.get(t);
      if (!zs) tg.seaZones.set(t, (zs = new Set()));
      zs.add(zone);
      let rs = tg.seaRoutes.get(t);
      if (!rs) tg.seaRoutes.set(t, (rs = []));
      rs.push(route);
    }
  };
  for (let s = 0; s < sim.nStates; s++) {
    const o = owner[s];
    if (!atWarAny[o]) continue;
    const row = o * nC;
    for (let k = landOff[s]; k < landOff[s + 1]; k++) {
      const t = landNb[k], p = owner[t];
      if (atWar[row + p]) visit(o, s, t, p, "land");
    }
    for (let k = seaOff[s]; k < seaOff[s + 1]; k++) {
      const t = seaNb[k], p = owner[t];
      if (atWar[row + p]) visit(o, s, t, p, "sea", seaZone[k], k);
    }
  }
  // A state reachable by land from any attacker state is a land target, not a landing.
  for (const tg of targets.values()) for (const t of tg.land.keys()) tg.sea.delete(t);
  // A line is a connected set of front edges: two edges are on the same line only if they share a state
  // (e.g. a Soviet state bordering both Finland and German-held land). Fronts that do not touch — Germany's and
  // Italy's against France across Switzerland, Finland's and Germany's against the USSR in 1941 — are separate
  // lines with separate allocations (user requirement), even if the attackers' states are neighbours.
  const line = new Int32Array(sim.nStates).fill(-1);
  const statesByLine = new Map<number, number[]>();
  const lineSets = new Map<number, Set<number>>();
  for (const node of front) {
    const s = node % sim.nStates, l = find(node);
    if (line[s] < 0 || l < line[s]) line[s] = l;
    let set = lineSets.get(l);
    if (!set) lineSets.set(l, (set = new Set()));
    set.add(s);
  }
  for (const [l, set] of lineSets) statesByLine.set(l, [...set]);
  const targetsByLine = new Map<number, Map<number, Targets>>();
  const theatreSets = new Map<number, Set<number>>();
  for (const e of edges) {
    const l = find(e.node);
    if (e.sector) {
      let set = theatreSets.get(l);
      if (!set) theatreSets.set(l, (set = new Set()));
      set.add(e.sector);
    }
    if (invulnerableActive(sim, e.t)) continue;
    const key = e.o * nC + owner[e.t];
    if (e.kind === "sea" && targets.get(key)?.land.has(e.t)) continue;
    let byPair = targetsByLine.get(l);
    if (!byPair) targetsByLine.set(l, (byPair = new Map()));
    let tg = byPair.get(key);
    if (!tg) byPair.set(key, (tg = { land: new Map(), sea: new Map(), seaZones: new Map(), seaRoutes: new Map() }));
    const m = tg[e.kind];
    m.set(e.t, (m.get(e.t) ?? 0) + 1);
    if (e.kind === "sea") {
      const zs = tg.seaZones.get(e.t) ?? new Set<number>();
      zs.add(e.zone); tg.seaZones.set(e.t, zs);
      const rs = tg.seaRoutes.get(e.t) ?? [];
      rs.push(e.route); tg.seaRoutes.set(e.t, rs);
    }
  }
  const theatreNames = new Map<number, string>();
  for (const [l, ts] of theatreSets) if (ts.size === 1) theatreNames.set(l, sim.config.landingTheatres[[...ts][0] - 1].name);
  // Countries of the same side whose territories touch (land border or sea route) are linked; a country
  // can bring its army to any line where a country it is linked to (directly or through others of its side)
  // holds front states — e.g. the USSR through a revived Poland, the USA through Britain.
  const side = (c: number) => sideArr[c];
  const link = Int32Array.from({ length: nC }, (_, i) => i);
  const findC = (x: number): number => {
    while (link[x] !== x) x = link[x] = link[link[x]];
    return x;
  };
  const { adjA, adjB } = sim;
  for (let k = 0; k < adjA.length; k++) {
    const oa = owner[adjA[k]], ob = owner[adjB[k]];
    // Only countries at war link: a not-yet-belligerent country of the same faction (Denmark in 1939) does not carry
    // British and French troops to the Polish front.
    if (oa !== ob && sideArr[oa] === sideArr[ob] && atWarAny[oa] && atWarAny[ob]) {
      const ra = findC(oa), rb = findC(ob);
      if (ra !== rb) link[ra] = rb;
    }
  }
  const lineFront: Fronts["lineFront"] = new Map();
  const lineSide: Fronts["lineSide"] = new Map();
  const lineComps = new Map<number, Map<number, Set<number>>>(); // line → side → linked country groups
  const add = <K,>(m: Map<number, Map<K, { edges: number; lon: number; lat: number; n: number }>>, l: number, key: K, s: number) => {
    let byK = m.get(l);
    if (!byK) m.set(l, (byK = new Map()));
    let f = byK.get(key);
    if (!f) byK.set(key, (f = { edges: 0, lon: 0, lat: 0, n: 0 }));
    f.edges++;
    const lon = sim.stateLonLat[s * 2], lat = sim.stateLonLat[s * 2 + 1];
    if (!Number.isNaN(lon)) { f.lon += lon; f.lat += lat; f.n++; }
  };
  for (const { o, s, node } of edges) {
    const l = find(node), sd = side(o);
    add(lineFront, l, o, s);
    add(lineSide, l, sd, s);
    let bySide = lineComps.get(l);
    if (!bySide) lineComps.set(l, (bySide = new Map()));
    let cs = bySide.get(sd);
    if (!cs) bySide.set(sd, (cs = new Set()));
    cs.add(findC(o));
  }
  // Countries at war per linked group.
  const compCountries = new Map<number, Set<number>>();
  for (let c = 0; c < nC; c++) {
    if (!atWarAny[c]) continue;
    const r = findC(c);
    let set = compCountries.get(r);
    if (!set) compCountries.set(r, (set = new Set()));
    set.add(c);
  }
  // A country takes part in a line if it is linked to a country of its side holding front states there and
  // it is at war with a country holding front states on the other side of the line.
  const lineCountries = new Map<number, Set<number>>();
  for (const [l, byC] of lineFront) {
    const set = new Set<number>();
    for (const [sd, roots] of lineComps.get(l)!) {
      const enemies = [...byC.keys()].filter((e) => side(e) !== sd);
      for (const r of roots) {
        for (const c of compCountries.get(r) ?? []) {
          if (side(c) === sd && enemies.some((e) => atWar[c * nC + e])) set.add(c);
        }
      }
    }
    lineCountries.set(l, set);
  }
  const pairs = [...pairSet].sort((x, y) => x - y).map((k) => [Math.floor(k / nC), k % nC] as [number, number]);
  return { targets, targetsByLine, statesByLine, theatreNames, pairs, frontCount, line, lineCountries, lineFront, lineSide,
    frontStates: Int32Array.from(new Set(front.map((node) => node % sim.nStates))), sideArr, sideComp };
}

const toRad = Math.PI / 180;
function distanceKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const a = Math.sin(((lat2 - lat1) * toRad) / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(((lon2 - lon1) * toRad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Army fighting on each front line, per country (line → country → strength). The countries on a line are
 * Fronts.lineCountries: the ones holding front states there and the ones their side's territory connects to it.
 * "allocated": each country splits its army across its lines in proportion to
 *   line length × enemy strength on the line × 1 / (1 + distance / allocationDistanceKm),
 *   where line length = its side's front length on the line, distance = capital → centre of its side's front
 *   states on the line, and enemy strength = the army its enemies put on the line in a first pass that splits
 *   by line length × distance only (this avoids a circular definition). If every weight is 0 (no enemy
 *   army anywhere), that first-pass split is used.
 * "nation": the whole army on every line. "divided": army / front count on every line.
 */
/**
 * Region mask factor per (line, country): 1 + (factor − 1) × share of the country's side's front states on the line
 * inside the region, multiplied over the regions listed for the country in config.regionPriority.
 */
const regionShareCache = new WeakMap<Fronts, Map<number, Map<string, number>>>();
const regionBitsCache = new WeakMap<SimState, Uint8Array>();
function regionPriorityOf(sim: SimState, fronts: Fronts): (l: number, c: number) => number {
  const { regionPriority } = sim.config;
  if (!Object.keys(regionPriority).length) return () => 1;
  const shares = regionSharesOf(sim, fronts);
  const byTag = Object.entries(regionPriority).map(([tag, m]) => [sim.tags.indexOf(tag), Object.entries(m)] as const);
  const factorsOf = new Map<number, [string, number][]>(byTag.filter(([c]) => c >= 0));
  return (l, c) => {
    const fs = factorsOf.get(c);
    if (!fs) return 1;
    const m = shares.get(l * 4096 + (fronts.sideArr[c] + 2048));
    if (!m) return 1;
    let f = 1;
    for (const [name, k] of fs) f *= 1 + (k - 1) * (m.get(name) ?? 0);
    return f;
  };
}

/**
 * Per (line × 4096 + side + 2048): region name → share of that side's front states on the line inside the region
 * (config.regions), cached per fronts object.
 */
function regionSharesOf(sim: SimState, fronts: Fronts): Map<number, Map<string, number>> {
  const { regions } = sim.config;
  // Region membership of every state (bit i = names[i]), computed once per simulation (state centres do not move).
  const names = Object.keys(regions);
  let regionBits = regionBitsCache.get(sim);
  if (!regionBits) {
    regionBits = Uint8Array.from({ length: sim.nStates }, (_, s) => {
      const lon = sim.stateLonLat[s * 2], lat = sim.stateLonLat[s * 2 + 1];
      let b = 0;
      names.forEach((name, i) => {
        if (regions[name].some(([w, so, e, n]) => lon >= w && lon <= e && lat >= so && lat <= n)) b |= 1 << i;
      });
      return b;
    });
    regionBitsCache.set(sim, regionBits);
  }
  let shares = regionShareCache.get(fronts);
  if (!shares) {
    // key line × 4096 + side + 2048 → region → share of that side's front states on the line in the region.
    const total = new Map<number, number>(), inR = new Map<number, Map<string, number>>();
    for (const [l, states] of fronts.statesByLine) for (const s of states) {
      const key = l * 4096 + (fronts.sideArr[sim.owner[s]] + 2048);
      total.set(key, (total.get(key) ?? 0) + 1);
      const bits = regionBits[s];
      if (!bits) continue;
      names.forEach((name, i) => {
        if (!(bits & (1 << i))) return;
        let m = inR.get(key);
        if (!m) inR.set(key, (m = new Map()));
        m.set(name, (m.get(name) ?? 0) + 1);
      });
    }
    shares = new Map();
    for (const [key, m] of inR) {
      const out = new Map<string, number>();
      for (const [name, k] of m) out.set(name, k / total.get(key)!);
      shares.set(key, out);
    }
    regionShareCache.set(fronts, shares);
  }
  return shares;
}

/**
 * Per fronts object: own-side land components of every state (sideLand) and, per (line × 4096 + side + 2048),
 * the components of that side's front states on the line.
 */
const lineMassCache = new WeakMap<Fronts, { comp: Int32Array; byLine: Map<number, Set<number>> }>();

/**
 * Encircled pockets: own-side land components (fronts.sideComp) that contain no capital held by a country of their
 * side, have at least one land neighbour outside and all of those are owned by enemies at war with the owner, and
 * cannot be supplied by sea: no sea route from the pocket in a zone where its side's navy is at least
 * navalSuperiority × its enemies' navy (and above 0) — for a route longer than config.longRouteKm, also in a port
 * zone at each end. Returns 1 per encircled state. Uses this week's fleets.
 */
export function encircledStates(sim: SimState, fronts: Fronts, power: Float64Array): Uint8Array {
  const { owner, atWar, landOff, landNb, seaOff, seaZone, faction } = sim;
  const { sideArr, sideComp: comp } = fronts;
  const nC = sim.tags.length, nZ = sim.zoneNames.length;
  // Naval control of a zone for the owner o of a pocket: its side's navy against the navies at war with o.
  const supplied = (o: number, z: number) => {
    if (z < 0) return false;
    let own = 0, enemy = 0;
    for (let c = 0; c < nC; c++) {
      const p = power[c * nZ + z];
      if (!p) continue;
      if (sideArr[c] === sideArr[o] && faction[c] !== "neutral") own += p;
      else if (c === o) own += p;
      else if (atWar[o * nC + c]) enemy += p;
    }
    return own > 0 && own >= sim.config.navalSuperiority * enemy;
  };
  // Per component (indexed by its root state): 0 = supplied (or holds a capital), 1 = no enemy land neighbour seen
  // yet (initial), 2 = candidate pocket.
  const n = sim.nStates;
  const state = new Uint8Array(n).fill(1);
  for (let c = 0; c < nC; c++) {
    const cap = sim.capital[c];
    if (sideArr[owner[cap]] === sideArr[c]) state[comp[cap]] = 0;
  }
  const supplyCache = new Int8Array(nC * nZ).fill(-1);
  const zoneSupplied = (o: number, z: number) => {
    if (z < 0) return false;
    let v = supplyCache[o * nZ + z];
    if (v < 0) supplyCache[o * nZ + z] = v = supplied(o, z) ? 1 : 0;
    return v === 1;
  };
  const portSupplied = (o: number, x: number) => {
    if (sim.portOff[x] === sim.portOff[x + 1]) return true;
    for (let j = sim.portOff[x]; j < sim.portOff[x + 1]; j++) if (zoneSupplied(o, sim.portZone[j])) return true;
    return false;
  };
  for (let s = 0; s < n; s++) {
    const k = comp[s];
    let st = state[k];
    if (st === 0) continue;
    const o = owner[s];
    for (let j = landOff[s]; j < landOff[s + 1] && st !== 0; j++) {
      const t = landNb[j];
      if (comp[t] !== k) st = atWar[o * nC + owner[t]] ? 2 : 0;
    }
    for (let j = seaOff[s]; j < seaOff[s + 1] && st !== 0; j++) {
      // A long route also needs the waters at both ends (as for landings, navy.routeControlled).
      if (zoneSupplied(o, seaZone[j]) && (sim.seaKm[j] <= sim.config.longRouteKm || (portSupplied(o, s) && portSupplied(o, sim.seaNb[j])))) st = 0;
    }
    state[k] = st;
  }
  const out = new Uint8Array(n);
  for (let s = 0; s < n; s++) if (state[comp[s]] === 2) out[s] = 1;
  return out;
}

/** Components over land borders between states whose owners are on the same side (sideArr). */
function sideLand(sim: SimState, sideArr: Int32Array): Int32Array {
  const n = sim.nStates;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const { owner, landPairA: pa, landPairB: pb } = sim;
  for (let k = 0; k < pa.length; k++) {
    const s = pa[k], t = pb[k];
    if (sideArr[owner[s]] !== sideArr[owner[t]]) continue;
    let x = s, y = t;
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    while (parent[y] !== y) y = parent[y] = parent[parent[y]];
    if (x !== y) { if (x < y) parent[y] = x; else parent[x] = y; }
  }
  for (let i = 0; i < n; i++) {
    let x = i;
    while (parent[x] !== x) x = parent[x];
    parent[i] = x;
  }
  return parent;
}

export function allocateArmies(sim: SimState, fronts: Fronts): Map<number, Map<number, number>> {
  const nC = sim.tags.length;
  const { config, military } = sim;
  const { frontCount } = fronts;
  const out = new Map<number, Map<number, number>>();
  const set = (m: Map<number, Map<number, number>>, l: number, c: number, v: number) => {
    let byC = m.get(l);
    if (!byC) m.set(l, (byC = new Map()));
    byC.set(c, v);
  };
  if (config.frontComparisonMode !== "allocated") {
    for (const [l, cs] of fronts.lineCountries) {
      for (const c of cs) if (canDeployToFront(sim, fronts, l, c)) {
        set(out, l, c, config.frontComparisonMode === "divided" ? military[c] / Math.max(1, frontCount[c]) : military[c]);
      }
    }
    return out;
  }
  // Lines per country with the base weight: line length × distance factor × priority (lowPriorityFronts,
  // indirectFrontPriority).
  const low = new Float64Array(nC).fill(1);
  for (const [tag, f] of Object.entries(config.lowPriorityFronts)) {
    const c = sim.tags.indexOf(tag);
    if (c >= 0) low[c] = f;
  }
  // Priority by enemy (config.enemyPriority): country → enemy index → factor.
  const byEnemy = new Map<number, [number, number][]>();
  for (const [tag, m] of Object.entries(config.enemyPriority)) {
    const c = sim.tags.indexOf(tag);
    const xs = Object.entries(m).map(([e, f]) => [sim.tags.indexOf(e), f] as [number, number]).filter(([e]) => e >= 0);
    if (c >= 0 && xs.length) byEnemy.set(c, xs);
  }
  const enemyFactor = (l: number, c: number) => {
    const xs = byEnemy.get(c);
    if (!xs) return 1;
    let total = 0;
    const held = new Map<number, number>();
    for (const [o, f] of fronts.lineFront.get(l) ?? []) {
      if (fronts.sideArr[o] === fronts.sideArr[c]) continue;
      total += f.edges;
      held.set(o, f.edges);
    }
    let factor = 1;
    if (total > 0) for (const [e, f] of xs) factor += (f - 1) * ((held.get(e) ?? 0) / total);
    return factor;
  };
  const priority = (l: number, c: number) => {
    let w = 0, n = 0;
    for (const [o, f] of fronts.lineFront.get(l) ?? []) {
      if (fronts.sideArr[o] !== fronts.sideArr[c]) continue;
      n += f.edges;
      w += f.edges * (o === c ? 1 : low[o]);
    }
    // Lines where it holds no front state (it only supports others there) count less.
    const own = fronts.lineFront.get(l)?.has(c) ? 1 : config.indirectFrontPriority;
    return (n > 0 ? w / n : 1) * own * enemyFactor(l, c);
  };
  // Overseas lines: no land path from the country's capital to its side's front states on the line through
  // territory of its side (e.g. Germany → North Africa, which is joined to Europe by land only through neutral
  // Turkey and the British Middle East). Components and per-line sets are cached per fronts object.
  let reach = lineMassCache.get(fronts);
  if (!reach) {
    const comp = fronts.sideComp;
    const byLine = new Map<number, Set<number>>();
    for (const [l, states] of fronts.statesByLine) for (const s of states) {
      const key = l * 4096 + (fronts.sideArr[sim.owner[s]] + 2048);
      let set = byLine.get(key);
      if (!set) byLine.set(key, (set = new Set()));
      set.add(comp[s]);
    }
    lineMassCache.set(fronts, (reach = { comp, byLine }));
  }
  const overseas = (l: number, c: number) => {
    const cap = sim.capital[c];
    return fronts.sideArr[sim.owner[cap]] !== fronts.sideArr[c] ||
      !reach!.byLine.get(l * 4096 + (fronts.sideArr[c] + 2048))?.has(reach!.comp[cap]);
  };
  // Region mask (config.regionPriority): share of each line's front states (per side) in each region, cached.
  const regionFactor = regionPriorityOf(sim, fronts);
  // Closed land (config.closedLand): per line and side, its front states and those on closed land by owner.
  const closedTags = new Set(config.closedLand.map((t) => sim.tags.indexOf(t)).filter((c) => c >= 0));
  const sideStates = new Map<number, { total: number; closed: Map<number, number>; closedAll: number }>();
  if (closedTags.size) {
    for (const [l, states] of fronts.statesByLine) for (const s of states) {
      const key = l * 4096 + (fronts.sideArr[sim.owner[s]] + 2048);
      let e = sideStates.get(key);
      if (!e) sideStates.set(key, (e = { total: 0, closed: new Map(), closedAll: 0 }));
      e.total++;
      // Closed: the land of a listed country, or any state it holds now (e.g. Manchuria taken by China, whose land
      // is originally Japanese: counting only the land had let the British and American armies in behind China).
      if (closedTags.has(sim.landOf[s]) || closedTags.has(sim.owner[s])) {
        e.closedAll++;
        e.closed.set(sim.owner[s], (e.closed.get(sim.owner[s]) ?? 0) + 1);
      }
    }
  }
  // Banned landings (config.landingBans, scenario landing restrictions; user requirement: no troops for landings that
  // cannot happen yet): per line and side, the attack targets (adjacent enemy states, weighted by adjacency) and the
  // usable ones (land targets and sea targets the attacker may land on now).
  const closedNow = closedLandings(sim);
  const attackTargets = new Map<number, { total: number; usable: number }>();
  for (const [l, pairs] of fronts.targetsByLine) for (const [key, tg] of pairs) {
    const a = Math.floor(key / nC);
    const add = (n: number, factor: number) => {
      const k = l * 4096 + (fronts.sideArr[a] + 2048);
      const e = attackTargets.get(k) ?? { total: 0, usable: 0 };
      e.total += n;
      e.usable += n * factor;
      attackTargets.set(k, e);
    };
    for (const n of tg.land.values()) add(n, 1);
    for (const [t, n] of tg.sea) add(n, closedNow[a]?.[t] ? 0 : landingPreference(sim, a, t));
  }
  /** Share of c's side's attack targets on line l that are usable (1 without targets). */
  const usableShare = (l: number, c: number) => {
    const e = attackTargets.get(l * 4096 + (fronts.sideArr[c] + 2048));
    // A one-way amphibious contact is defence only for the side with no sea targets; retain its holding reserve,
    // but do not fill it with offensive troops that should be advancing from an existing bridgehead instead.
    return e && e.total > 0 ? e.usable / e.total : fronts.theatreNames.has(l) ? 0 : 1;
  };
  /** Share of c's side's front states on line l that c may send troops to (1 without closed land). */
  const openShare = (l: number, c: number) => {
    if (!closedTags.size || closedTags.has(c)) return 1;
    const e = sideStates.get(l * 4096 + (fronts.sideArr[c] + 2048));
    if (!e || !e.total) return 1;
    return 1 - (e.closedAll - (e.closed.get(c) ?? 0)) / e.total;
  };
  const base = new Map<number, [number, number][]>();
  for (const [l, cs] of fronts.lineCountries) {
    for (const c of cs) {
      if (!canDeployToFront(sim, fronts, l, c)) continue;
      const f = fronts.lineSide.get(l)?.get(sideOf(sim, c));
      if (!f) continue;
      const cap = sim.capital[c];
      const clon = sim.stateLonLat[cap * 2], clat = sim.stateLonLat[cap * 2 + 1];
      const d = f.n && !Number.isNaN(clon) ? distanceKm(clon, clat, f.lon / f.n, f.lat / f.n) : 0;
      const open = openShare(l, c);
      if (open <= 0) continue;
      if (config.landSupportOnly.includes(sim.tags[c]) && !fronts.lineFront.get(l)?.has(c) && overseas(l, c)) continue;
      if (!base.has(c)) base.set(c, []);
      const dist = overseas(l, c) ? d * config.overseasDistanceFactor : d;
      // A line whose attacks are all banned landings keeps weight 0 (still held for defence below).
      base.get(c)!.push([l, (f.edges / (1 + dist / config.allocationDistanceKm)) * priority(l, c) * regionFactor(l, c) * open *
        usableShare(l, c)]);
    }
  }
  const split = (weights: Map<number, [number, number][]>, into: Map<number, Map<number, number>>) => {
    for (const [c, ws] of weights) {
      const total = ws.reduce((s, w) => s + w[1], 0);
      for (const [l, w] of ws) set(into, l, c, total > 0 ? (military[c] * w) / total : military[c] / ws.length);
    }
  };
  const first = new Map<number, Map<number, number>>();
  split(base, first);
  const weighted = new Map<number, [number, number][]>();
  for (const [c, ws] of base) {
    const w2 = ws.map(([l, w]): [number, number] => {
      let enemy = 0;
      for (const [e, a] of first.get(l)!) if (sim.atWar[c * nC + e]) enemy += a;
      return [l, w * enemy];
    });
    weighted.set(c, w2.some(([, w]) => w > 0) ? w2 : ws);
  }
  // Holding small fronts first: on its own lines (where it holds front states) a country first sets aside its
  // share of holdRatio × the enemy army there (its share of its side's first-pass army on the line), smallest
  // need first, as long as the total stays within holdShare of its army. The rest is split by weight as above.
  // Without this a weak country spreads thinly everywhere in proportion to the enemy, and a small enemy army
  // (Finland in Karelia) then outnumbers it on its own front.
  // Fronts held first (config.holdAgainst): country → the enemies it meets at `ratio` before its other lines.
  const holdFirst = new Map<number, { against: Set<number>; ratio: number }>();
  for (const [tag, h] of Object.entries(config.holdAgainst)) {
    const c = sim.tags.indexOf(tag);
    if (c >= 0) holdFirst.set(c, { against: new Set(h.against.map((t) => sim.tags.indexOf(t)).filter((e) => e >= 0)), ratio: h.ratio });
  }
  // The enemy army actually on each line last step (sim.frontArmies): the first pass leaves out what the enemy itself
  // sets aside to hold the line, so a front held first is measured against the larger of the two.
  const lastArmies = holdFirst.size ? new Map(sim.frontArmies.map((f) => [f.line, f.armies])) : null;
  for (const [c, ws] of weighted) {
    const needs: [number, number, boolean][] = [];
    const hf = holdFirst.get(c);
    for (const [l] of ws) {
      if (!fronts.lineFront.get(l)?.has(c)) continue;
      // enemyFirst: the part of the enemy army from the countries held first (config.holdAgainst).
      let enemy = 0, mine = 0, side = 0, enemyFirst = 0;
      for (const [e, a] of first.get(l)!) {
        if (sim.atWar[c * nC + e]) { enemy += a; if (hf?.against.has(e)) enemyFirst += a; }
        else if (fronts.sideArr[e] === fronts.sideArr[c]) { side += a; if (e === c) mine = a; }
      }
      // The country's share of its side's defence there: its first-pass army share, or, when its side has no first-pass
      // army on the line (a line whose own attacks are all banned landings, which the enemy can still attack across),
      // its share of the side's front edges on the line.
      let share = side > 0 ? mine / side : 0;
      if (side <= 0) {
        let edges = 0;
        for (const [o, f] of fronts.lineFront.get(l) ?? []) if (fronts.sideArr[o] === fronts.sideArr[c]) edges += f.edges;
        share = edges > 0 ? (fronts.lineFront.get(l)?.get(c)?.edges ?? 0) / edges : 0;
      }
      // A region mask below 1 (config.regionPriority) also lowers what the country sets aside there.
      const mask = Math.min(1, regionFactor(l, c)) * openShare(l, c);
      if (hf) {
        // Held first: the enemies in `against` (the larger of their first-pass army and last step's), less the part of
        // what its allies had there last step that faces them (allies the first pass sends may be held back by the
        // region caps). The other enemies on the line (e.g. the Red Army on a line that joins Italy to the Eastern
        // front) are held as usual below.
        let present = 0, presentFirst = 0, allies = 0;
        for (const [e, a] of lastArmies?.get(l) ?? []) {
          if (sim.atWar[c * nC + e]) { present += a; if (hf.against.has(e)) presentFirst += a; }
          else if (e !== c && fronts.sideArr[e] === fronts.sideArr[c]) allies += a;
        }
        const against = Math.max(enemyFirst, presentFirst);
        if (against > 0) {
          const need = Math.max(0, hf.ratio * against - allies * (present > 0 ? presentFirst / present : 1)) * mask;
          if (need > 0) needs.push([l, need, true]);
          enemy -= enemyFirst;
        }
      }
      const need = config.holdRatio * enemy * share * mask;
      if (need > 0) needs.push([l, need, false]);
    }
    // Lines held first (config.holdAgainst) come before the others, and take what is left of the budget when whole
    // ones no longer fit; the others are all or nothing, smallest first.
    needs.sort((a, b) => Number(b[2]) - Number(a[2]) || a[1] - b[1] || a[0] - b[0]);
    const hold = new Map<number, number>();
    const budget = config.holdShare * military[c];
    let held = 0;
    for (const [l, need, prior] of needs) {
      const amount = prior ? Math.min(need, budget - held) : need;
      if (amount <= 0 || held + amount > budget) { if (prior) continue; break; }
      hold.set(l, (hold.get(l) ?? 0) + amount);
      held += amount;
    }
    const rest = military[c] - held;
    const total = ws.reduce((s, w) => s + w[1], 0);
    for (const [l, w] of ws) {
      set(out, l, c, (hold.get(l) ?? 0) + (total > 0 ? (rest * w) / total : rest / ws.length));
    }
  }
  applyRegionCaps(sim, fronts, out, true);
  return out;
}

/**
 * Caps by region (config.regionCap): a country's army in a region (its army on each line × the share of its side's
 * front states on the line in the region) is limited. A line's army is spread over the whole line, so the lines
 * reaching into the region are scaled as a whole. With `redistribute` (targets) the excess goes to the country's
 * lines entirely outside the region, in proportion (adding to a line partly inside would bring part of it back);
 * with none, or without `redistribute` (deployed troops, which cannot jump to another front), it stays unused.
 */
function applyRegionCaps(sim: SimState, fronts: Fronts, out: Map<number, Map<number, number>>, redistribute: boolean) {
  const { regionCap, regionGroupCaps } = sim.config;
  // Each cap applies to a group of countries (one country for config.regionCap; a faction minus exceptions, or listed
  // tags, for config.regionGroupCaps): the group's army in the region together is limited, every member scaled alike.
  const groups: { members: number[]; region: string; cap: number }[] = [];
  for (const [tag, caps] of Object.entries(regionCap)) {
    const c = sim.tags.indexOf(tag);
    if (c >= 0) for (const [region, cap] of Object.entries(caps)) groups.push({ members: [c], region, cap });
  }
  for (const g of regionGroupCaps) {
    const members = g.tags
      ? g.tags.map((t) => sim.tags.indexOf(t)).filter((c) => c >= 0)
      : sim.tags.map((_, c) => c).filter((c) => sim.faction[c] === g.faction && !(g.except ?? []).includes(sim.tags[c]));
    if (members.length) groups.push({ members, region: g.region, cap: g.cap });
  }
  if (!groups.length) return;
  const shares = regionSharesOf(sim, fronts);
  for (const { members, region, cap } of groups) {
    const lines = new Map<number, [number, number, number][]>();
    let inRegion = 0;
    for (const c of members) {
      const ls: [number, number, number][] = [];
      for (const [l, m] of out) {
        const a = m.get(c);
        if (a === undefined) continue;
        const s = shares.get(l * 4096 + (fronts.sideArr[c] + 2048))?.get(region) ?? 0;
        ls.push([l, a, s]);
        inRegion += a * s;
      }
      lines.set(c, ls);
    }
    if (inRegion <= cap) continue;
    const keep = cap / inRegion;
    for (const [c, ls] of lines) {
      let freed = 0, room = 0;
      for (const [l, a, s] of ls) {
        if (s === 0) { room += a; continue; }
        freed += a * (1 - keep);
        out.get(l)!.set(c, a * keep);
      }
      if (redistribute && room > 0) for (const [l, a, s] of ls) if (s === 0) out.get(l)!.set(c, a + (freed * a) / room);
    }
  }
}

/** Map cell of every state for transit ("allocated" mode); -1 when the map has no coordinates. Cached. */
const stateCellCache = new WeakMap<SimState, Int32Array>();
function stateCells(sim: SimState): Int32Array {
  let cells = stateCellCache.get(sim);
  if (!cells) {
    const d = sim.config.transitCellDeg;
    cells = Int32Array.from({ length: sim.nStates }, (_, s) => {
      const lon = sim.stateLonLat[s * 2], lat = sim.stateLonLat[s * 2 + 1];
      return Number.isNaN(lon) ? -1 : Math.floor((lat + 90) / d) * 1000 + Math.floor((lon + 180) / d);
    });
    stateCellCache.set(sim, cells);
  }
  return cells;
}

/** Cell centre as [lat (rad), lon (rad), cos(lat)], cached per cell size. */
const centreCache = new Map<number, Map<number, [number, number, number]>>();
function cellCentre(sim: SimState, cell: number): [number, number, number] {
  const d = sim.config.transitCellDeg;
  let cache = centreCache.get(d);
  if (!cache) centreCache.set(d, (cache = new Map()));
  let c = cache.get(cell);
  if (!c) {
    const lat = ((Math.floor(cell / 1000) + 0.5) * d - 90) * toRad, lon = ((cell % 1000 + 0.5) * d - 180) * toRad;
    cache.set(cell, (c = [lat, lon, Math.cos(lat)]));
  }
  return c;
}

/** Equirectangular distance in km between two [lat, lon, cos lat] points (good enough for transit times). */
function approxKm(a: [number, number, number], b: [number, number, number]): number {
  let dLon = Math.abs(a[1] - b[1]);
  if (dLon > Math.PI) dLon = 2 * Math.PI - dLon;
  const x = dLon * (a[2] + b[2]) * 0.5, y = a[0] - b[0];
  return 6371 * Math.sqrt(x * x + y * y);
}

/**
 * Transit time: turns the allocation (line → country → army) into the army actually at each line this week,
 * and advances deployment (stateful: call once per update). Each line's allocation of a country is spread
 * over the map cells of its side's front states on that line (by number of front states). In each cell the
 * country's deployed share moves by 1 - (1 - 1/T)^stepWeeks of the remaining gap, with
 * T = max(1, distance / transitSpeedKmPerWeek) and distance = from its capital or, when building up, from a
 * neighbouring cell (the 8 around it) where it already has troops, whichever is shorter (troops shift
 * along a front quickly but come from home to a new front). Troops leaving a cell are in
 * transit and fight nowhere. Shares are of the current army, so production and losses scale them. Maps
 * without coordinates have one cell at distance 0, so troops arrive at once. Other modes: unchanged.
 */
const lineCellsCache = new WeakMap<Fronts, Map<number, Map<number, [number, number][]>>>(); // line → side → [cell index, weight]
/** Reused per-country target buffers. */
const targetPool = new WeakMap<SimState, Map<number, CellShares>>();
/** Offsets of the 8 neighbouring cells, and their distances per cell row (they depend on the latitude only). */
const NB_DR = [-1, -1, -1, 0, 0, 1, 1, 1], NB_DC = [-1, 0, 1, -1, 1, -1, 0, 1];
const neighbourCache = new Map<string, Float64Array>();
function neighbourKm(sim: SimState, row: number): Float64Array {
  const key = `${sim.config.transitCellDeg}:${row}`;
  let a = neighbourCache.get(key);
  if (!a) {
    const p = cellCentre(sim, row * 1000 + 1);
    a = Float64Array.from(NB_DR, (dr, k) => approxKm(cellCentre(sim, (row + dr) * 1000 + 1 + NB_DC[k]), p));
    neighbourCache.set(key, a);
  }
  return a;
}
/** Capital → cell distances per simulation (capitals do not move): key country × 1e6 + cell. */
const capitalDistCache = new WeakMap<SimState, Map<number, number>>();

export function deployArmies(sim: SimState, fronts: Fronts, target: Map<number, Map<number, number>>): Map<number, Map<number, number>> {
  if (sim.config.frontComparisonMode !== "allocated") return target;
  const { military, owner, config } = sim;
  // Front-state cells per line and side (cached per fronts object).
  let lineCells = lineCellsCache.get(fronts);
  if (!lineCells) {
    const counts = new Map<number, Map<number, Map<number, number>>>();
    const cellOfState = stateCells(sim);
    for (const [l, states] of fronts.statesByLine) for (const s of states) {
      const sd = fronts.sideArr[owner[s]], cell = cellOfState[s];
      let bySide = counts.get(l);
      if (!bySide) counts.set(l, (bySide = new Map()));
      let cells = bySide.get(sd);
      if (!cells) bySide.set(sd, (cells = new Map()));
      cells.set(cell, (cells.get(cell) ?? 0) + 1);
    }
    // Weights: the cell's share of the side's front states on the line.
    lineCells = new Map();
    for (const [l, bySide] of counts) {
      const m = new Map<number, [number, number][]>();
      for (const [sd, cells] of bySide) {
        let total = 0;
        for (const n of cells.values()) total += n;
        m.set(sd, [...cells].map(([cell, n]): [number, number] => [gridOf(sim).index(cell), n / total]));
      }
      lineCells.set(l, m);
    }
    lineCellsCache.set(fronts, lineCells);
  }
  // Target shares per country and cell (reused buffers), and per country and line.
  let pool = targetPool.get(sim);
  if (!pool) targetPool.set(sim, (pool = new Map()));
  for (const tc of pool.values()) tc.clear();
  const tCell = new Map<number, CellShares>();
  const tLine = new Map<number, [number, number, [number, number][]][]>(); // country → [line, share, cells]
  const grid = gridOf(sim);
  for (const [l, byC] of target) {
    for (const [c, v] of byC) {
      if (!canDeployToFront(sim, fronts, l, c)) continue;
      const frac = military[c] > 0 ? v / military[c] : 0;
      const cells = lineCells.get(l)?.get(fronts.sideArr[c]);
      if (!cells) continue;
      let tc = tCell.get(c), tl = tLine.get(c);
      if (!tc) {
        tc = pool.get(c);
        if (!tc) pool.set(c, (tc = new CellShares(config.transitCellDeg)));
        tCell.set(c, tc);
      }
      if (!tl) tLine.set(c, (tl = []));
      for (const [i, w] of cells) tc.setAt(i, tc.value[i] + frac * w);
      tl.push([l, frac, cells]);
    }
  }
  // Advance deployment by this step's elapsed time, preserving the old weekly relaxation over two half-steps.
  // Distance for a cell: from the capital, or (when building up) from a neighbouring cell with troops.
  const { perRow, rows } = grid;
  let capCache = capitalDistCache.get(sim);
  if (!capCache) capitalDistCache.set(sim, (capCache = new Map()));
  const speed = config.transitSpeedKmPerWeek;
  const capitalKm = (c: number, i: number) => {
    const key = c * 1_000_000 + i;
    let d = capCache!.get(key);
    if (d === undefined) {
      const cap = sim.capital[c];
      const lat = sim.stateLonLat[cap * 2 + 1] * toRad, lon = sim.stateLonLat[cap * 2] * toRad;
      d = Number.isNaN(lat) ? 0 : approxKm([lat, lon, Math.cos(lat)], cellCentre(sim, grid.cell(i)));
      capCache!.set(key, d);
    }
    return d;
  };
  const advance = (c: number, dep: CellShares, i: number, cur: number, t: number) => {
    if (Math.abs(t - cur) < 1e-9) return; // already there
    let d = 0;
    if (i > 0) {
      d = capitalKm(c, i);
      // Building up beside troops already in a neighbouring cell (the 8 around; its own troops do not shorten
      // the way for reinforcements). Skipped when the capital is within one step anyway.
      if (t > cur && d > speed) {
        const row = Math.floor((i - 1) / perRow), col = i - 1 - row * perRow;
        const nb = neighbourKm(sim, row);
        for (let k = 0; k < 8; k++) {
          const r = row + NB_DR[k];
          if (r < 0 || r >= rows || nb[k] >= d) continue;
          const j = 1 + r * perRow + ((col + NB_DC[k] + perRow) % perRow);
          if (dep.pos[j] >= 0 && dep.value[j] > 1e-4) d = nb[k];
        }
      }
    }
    const T = Math.max(1, d / speed);
    const next = cur + (t - cur) * perStepProbability(1 / T, stepWeeks(config));
    if (t === 0 && next < 1e-5) dep.deleteAt(i);
    else dep.setAt(i, next);
  };
  // Cells with troops first (from the end of the list, so removals do not skip any), then new targets;
  // neighbours are read from the deployment as it is updated (the order is fixed, so this stays deterministic).
  for (const [c, m] of sim.deployed) {
    const dep = m instanceof CellShares ? m : toCellShares(m, config.transitCellDeg);
    if (dep !== m) sim.deployed.set(c, dep);
    const tc = tCell.get(c);
    for (let k = dep.list.length - 1; k >= 0; k--) {
      const i = dep.list[k];
      advance(c, dep, i, dep.value[i], tc && tc.pos[i] >= 0 ? tc.value[i] : 0);
    }
    if (tc) for (const i of tc.list) if (dep.pos[i] < 0) advance(c, dep, i, 0, tc.value[i]);
  }
  for (const [c, tc] of tCell) {
    if (sim.deployed.has(c)) continue;
    const dep = new CellShares(config.transitCellDeg);
    for (const i of tc.list) advance(c, dep, i, 0, tc.value[i]);
    sim.deployed.set(c, dep);
  }
  for (const [c, dep] of sim.deployed) if (!dep.size) sim.deployed.delete(c);
  // Army at each line: the deployed share of each cell, split between the country's lines in that cell
  // in proportion to their targets.
  const out = new Map<number, Map<number, number>>();
  for (const [c, lines] of tLine) {
    const dep = sim.deployed.get(c) as CellShares | undefined;
    const tc = tCell.get(c)!;
    for (const [l, frac, cells] of lines) {
      let v = 0;
      if (dep) {
        for (const [i, w] of cells) {
          const t = tc.value[i];
          if (t > 0) v += military[c] * dep.value[i] * ((frac * w) / t);
        }
      }
      let m = out.get(l);
      if (!m) out.set(l, (m = new Map()));
      m.set(c, v);
    }
  }
  // Region caps also on the troops actually there (transit and shared cells can exceed the capped targets).
  applyRegionCaps(sim, fronts, out, false);
  return out;
}

/** Grid helper per cell size (index ↔ cell). */
const grids = new Map<number, CellShares>();
function gridOf(sim: SimState): CellShares {
  const d = sim.config.transitCellDeg;
  let g = grids.get(d);
  if (!g) grids.set(d, (g = new CellShares(d)));
  return g;
}

function toCellShares(m: CellMap, cellDeg: number): CellShares {
  const out = new CellShares(cellDeg);
  for (const [cell, v] of m) out.set(cell, v);
  return out;
}

/**
 * computeFronts with a one-entry cache per simulation: fronts depend only on ownership, wars and which
 * invulnerable states are still protected, which in long static phases do not change for many weeks.
 * The returned object is shared and must not be modified.
 */
const frontsCache = new WeakMap<SimState, { owner: Uint16Array; atWar: Uint8Array; invLost: Uint8Array; fronts: Fronts }>();
export function computeFrontsCached(sim: SimState): Fronts {
  const c = frontsCache.get(sim);
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };
  if (c && same(c.owner, sim.owner) && same(c.atWar, sim.atWar) && same(c.invLost, sim.invLost)) return c.fronts;
  const fronts = computeFronts(sim);
  frontsCache.set(sim, { owner: sim.owner.slice(), atWar: sim.atWar.slice(), invLost: sim.invLost.slice(), fronts });
  return fronts;
}

/** States taken this week for a strength ratio r > 1 (random rounding of the expected value). */
export function advanceCount(r: number, rate: number, max: number, rng: Rng): number {
  if (!(r > 1)) return 0;
  const x = Math.min(max, rate * (r - 1));
  const k = Math.floor(x);
  return k + (nextFloat(rng) < x - k ? 1 : 0);
}

/** Picks up to k states without replacement, weighted by the number of adjacent attacker states. */
export function pickTargets(cands: Map<number, number>, k: number, rng: Rng): number[] {
  const ids = [...cands.keys()];
  const w = ids.map((id) => cands.get(id)!);
  const out: number[] = [];
  let total = w.reduce((a, b) => a + b, 0);
  while (out.length < k && ids.length) {
    let x = nextFloat(rng) * total;
    let i = 0;
    while (i < ids.length - 1 && x >= w[i]) x -= w[i++];
    out.push(ids[i]);
    total -= w[i];
    ids.splice(i, 1);
    w.splice(i, 1);
  }
  return out;
}

export interface Battle {
  /** Front line id (see Fronts.line). */
  line: number;
  /** Countries of the attacking / defending side on this line, strongest first. */
  attackers: number[];
  defenders: number[];
  /** Strongest attacker / defender. */
  attacker: number;
  defender: number;
  /** Compared strengths: sums over each side (after division in "divided" mode). */
  attStrength: number;
  defStrength: number;
  /** Loss L of the defending side; the attacking side loses 2L × attLossFactor. Both are shared by strength. */
  loss: number;
  /** Terrain factor on the attacker's losses (config.terrainLoss averaged over the targets; 1 without terrain). */
  attLossFactor: number;
  /** Strength share of each attacker / defender (parallel to attackers / defenders). */
  attShare: number[];
  defShare: number[];
  /** Captured states, the country taking each, and the owner it is taken from. */
  captures: number[];
  captors: number[];
  capturedFrom: number[];
}

type Cands = Map<number, Map<number, number>>;

/** States within config.defenceZones[i]'s radius (cached per simulation and zone). */
const zoneCache = new WeakMap<SimState, Map<number, Uint8Array>>();
function defenceZoneStates(sim: SimState, i: number): Uint8Array {
  let byZone = zoneCache.get(sim);
  if (!byZone) zoneCache.set(sim, (byZone = new Map()));
  let m = byZone.get(i);
  if (!m) {
    const { center: [lon0, lat0], radiusKm } = sim.config.defenceZones[i];
    const r = Math.PI / 180;
    m = Uint8Array.from({ length: sim.nStates }, (_, s) => {
      const lon = sim.stateLonLat[2 * s], lat = sim.stateLonLat[2 * s + 1];
      const h = Math.sin((lat - lat0) * r / 2) ** 2 + Math.cos(lat0 * r) * Math.cos(lat * r) * Math.sin((lon - lon0) * r / 2) ** 2;
      return 2 * 6371 * Math.asin(Math.sqrt(h)) <= radiusKm ? 1 : 0;
    });
    byZone.set(i, m);
  }
  return m;
}

/**
 * One week of combat on every front line. Ownership at the start of the week is used for all
 * decisions; captures and losses are applied afterwards (see applyBattles).
 *
 * Countries of the same faction on one front line fight together: each side's compared strength is
 * the sum over its countries of the army they have on that line (allocateArmies: split across lines in
 * "allocated" mode, the whole army in "nation" mode, army / front count in "divided" mode). The side
 * with the larger sum attacks along the whole line. Land targets advance with ratio r = attacker sum /
 * defender sum; sea-only targets (landings) use navalPenalty × attacker sum and are attempted only
 * when that still exceeds the defender sum. A landing target also needs naval superiority
 * (navy.hasSuperiority) for an attacking country next to it in the zone of one of its routes, and must
 * not be protected by an active landing restriction. Each captured state goes to the attacking country
 * with the most states next to it. If the attacking side attempts nothing (no attackable targets),
 * there is no battle and no loss — this is how invulnerable states stop combat on their fronts.
 * Losses: L = lossRate × min(sums); defenders lose L and attackers 2L, shared by strength.
 * With one country per side this is exactly the pairwise rule.
 */
export function resolveCombat(sim: SimState, fronts: Fronts): Battle[] {
  const nC = sim.tags.length;
  const { config, rng, owner, faction } = sim;
  const alloc = deployArmies(sim, fronts, allocateArmies(sim, fronts));
  // Who faces whom this week (sim.facing): for each line, the army each country there has against each enemy that
  // holds front states on it.
  sim.facing.fill(0);
  for (const [l, byC] of fronts.lineFront) {
    const army = alloc.get(l);
    if (!army) continue;
    for (const c of byC.keys()) {
      for (const [e, v] of army) if (sim.atWar[c * nC + e]) sim.facing[c * nC + e] += v;
    }
  }
  sim.frontArmies = [];
  for (const [l, army] of alloc) {
    const armies = [...army].filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1] || p[0] - q[0]);
    if (!armies.length) continue;
    let lon = 0, lat = 0, n = 0;
    for (const f of fronts.lineFront.get(l)?.values() ?? []) { lon += f.lon; lat += f.lat; n += f.n; }
    sim.frontArmies.push({ line: l, lon: n ? lon / n : 0, lat: n ? lat / n : 0, armies,
      states: fronts.statesByLine.get(l) ?? [], theatre: fronts.theatreNames.get(l) });
  }
  const power = fleetPower(sim);
  const blocked = blockedLandings(sim);
  // Targets per line: state → attacking country → adjacent states (sea: only landings that are allowed).
  const byLine = new Map<number, { land: Cands; sea: Cands }>();
  const add = (l: number, kind: "land" | "sea", t: number, a: number, n: number) => {
    let lc = byLine.get(l);
    if (!lc) byLine.set(l, (lc = { land: new Map(), sea: new Map() }));
    let by = lc[kind].get(t);
    if (!by) lc[kind].set(t, (by = new Map()));
    by.set(a, (by.get(a) ?? 0) + n);
  };
  const noNavy = new Set<number>();
  for (const [at, defs] of Object.entries(config.landingWithoutNavy)) {
    const a = sim.tags.indexOf(at);
    for (const dt of defs) {
      const d = sim.tags.indexOf(dt);
      if (a >= 0 && d >= 0) noNavy.add(a * nC + d);
    }
  }
  // Encircled pockets cannot attack (config.encirclement): adjacency from their states is not counted.
  const enc = config.encirclement ? encircledStates(sim, fronts, power) : null;
  const anyEnc = enc?.includes(1) ?? false;
  const free = (t: number, a: number, off: Int32Array, nb: Int32Array) => {
    let n = 0;
    for (let k = off[t]; k < off[t + 1]; k++) if (owner[nb[k]] === a && !enc![nb[k]]) n++;
    return n;
  };
  // Date-limited landing bans (config.landingBans): banned[c] = state mask of the bans active for attacker c now.
  const banned = activeLandingBans(sim);
  for (const [l, pairs] of fronts.targetsByLine) for (const [key, tg] of pairs) {
    const a = Math.floor(key / nC), d = key % nC;
    // Retain the country as a defender of its territory, but give a forbidden deployment no attack targets.
    if (!canDeployToFront(sim, fronts, l, a)) continue;
    for (const [t, n0] of tg.land) {
      const n = anyEnc ? free(t, a, sim.landOff, sim.landNb) : n0;
      if (n) add(l, "land", t, a, n);
    }
    for (const [t, n0] of tg.sea) {
      if (blocked?.[t] || banned[a]?.[t]) continue;
      const n = anyEnc ? free(t, a, sim.seaOff, sim.seaNb) : n0;
      if (!n) continue;
      // A landing needs naval control of one of the routes into the target (routeControlled: the route's zone and,
      // for a long route, the waters at both ends), except for the pairs in config.landingWithoutNavy.
      const preference = landingPreference(sim, a, t);
      if (noNavy.has(a * nC + owner[t])) { add(l, "sea", t, a, n * preference); continue; }
      for (const k of tg.seaRoutes.get(t) ?? []) {
        if (routeControlled(sim, power, a, d, k)) { add(l, "sea", t, a, n * preference); break; }
      }
    }
  }
  const battles: Battle[] = [];
  // Sides on a line: one per faction; a "neutral"-faction country at war is a side of its own.
  const sideKey = (c: number) => (faction[c] === "neutral" ? `c${c}` : faction[c]);
  // Surprise attack (config.surprise): a recently attacked listed country fights at reduced strength.
  const surprise = new Float64Array(nC).fill(1);
  for (let c = 0; c < nC; c++) {
    const s = sim.config.surprise[sim.tags[c]];
    if (!s || sim.surpriseStart[c] < 0) continue;
    const t = (sim.tick - sim.surpriseStart[c]) * stepWeeks(sim.config) / s.weeks;
    if (t < 1) surprise[c] = s.factor + (1 - s.factor) * Math.max(0, t);
  }
  // Scheduled strength factors (config.strengthFactors), e.g. China's early-war penalty.
  const nowMs = tickTime(sim.startMs, sim.tick, sim.config.stepDays);
  for (const [tag, f] of Object.entries(sim.config.strengthFactors)) {
    const c = sim.tags.indexOf(tag);
    if (c >= 0) surprise[c] *= scheduledFactor(f, nowMs);
  }
  // Matchup strength (config.matchupStrength): country → { opponents, factor now }, by tag index.
  const matchups: ({ against: number[]; factor: number } | undefined)[] = [];
  let anyMatchup = false;
  for (const [tag, m] of Object.entries(config.matchupStrength)) {
    const c = sim.tags.indexOf(tag);
    if (c < 0) continue;
    const against = m.against.map((t) => sim.tags.indexOf(t)).filter((e) => e >= 0);
    if (!against.length) continue;
    matchups[c] = { against, factor: scheduledFactor(m.factor, nowMs) };
    anyMatchup = true;
  }
  // The matchup factor of country c on line l: applies when an opponent in `against` has an army there.
  const matchupOn = (l: number, c: number) => {
    const m = matchups[c];
    if (!m) return 1;
    const army = alloc.get(l);
    if (!army) return 1;
    for (const e of m.against) {
      if (e !== c && sideKey(e) !== sideKey(c) && sim.atWar[c * nC + e] && (army.get(e) ?? 0) > 0) return m.factor;
    }
    return 1;
  };
  // Landing strength now (config.landingStrength), by country index; null when none is set.
  let landingF: number[] | null = null;
  for (const [tag, f] of Object.entries(config.landingStrength)) {
    const c = sim.tags.indexOf(tag);
    if (c >= 0) (landingF ??= [])[c] = scheduledFactor(f, nowMs);
  }
  const strengthOn = (l: number) => (c: number) => (alloc.get(l)?.get(c) ?? 0) * surprise[c] * (anyMatchup ? matchupOn(l, c) : 1);
  // Seasons active this step (config.seasons), by the month of the step's date.
  const month = new Date(nowMs).getUTCMonth() + 1;
  const activeSeasons = config.seasons.filter((s) => s.months.includes(month)).map((s) => ({
    land: new Set(s.land.map((t) => sim.tags.indexOf(t)).filter((c) => c >= 0)),
    exempt: new Set(s.exempt.map((t) => sim.tags.indexOf(t)).filter((c) => c >= 0)),
    loss: s.loss, capture: s.capture,
  })).filter((s) => s.land.size);
  // Defence zones (config.defenceZones) in force now: the states inside and the capture factor.
  const zones = config.defenceZones.flatMap((z, i) => {
    const defender = sim.tags.indexOf(z.defender);
    return defender < 0 ? [] : [{ defender, inside: defenceZoneStates(sim, i), capture: scheduledFactor(z.capture, nowMs) }];
  });
  // Slower advance on some countries' land (config.slowAdvanceLand; sim.landOf includes land taken before 1939-09).
  const slow = new Float64Array(nC).fill(1);
  for (const [tag, f] of Object.entries(config.slowAdvanceLand)) {
    const c = sim.tags.indexOf(tag);
    if (c >= 0) slow[c] = f;
  }
  const slowed = (ts: number[]) => ts.filter((t) => slow[sim.landOf[t]] >= 1 || nextFloat(rng) < slow[sim.landOf[t]]);
  for (const l of [...fronts.lineCountries.keys()].sort((x, y) => x - y)) {
    const sides = new Map<string, number[]>();
    for (const c of [...fronts.lineCountries.get(l)!].sort((x, y) => x - y)) {
      const k = sideKey(c);
      if (!sides.has(k)) sides.set(k, []);
      sides.get(k)!.push(c);
    }
    const keys = [...sides.keys()].sort();
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const A = sides.get(keys[i])!, B = sides.get(keys[j])!;
      if (!A.some((a) => B.some((b) => sim.atWar[a * nC + b]))) continue;
      const bt = lineBattle(l, A, B, byLine.get(l));
      if (bt) battles.push(bt);
    }
  }
  return battles;

  function lineBattle(l: number, A: number[], B: number[], cands: { land: Cands; sea: Cands } | undefined): Battle | null {
    const strength = strengthOn(l);
    const sum = (cs: number[]) => cs.reduce((s, c) => s + strength(c), 0);
    const sA = sum(A), sB = sum(B);
    if (sA === sB) return null;
    const [attSide, defSide, eAtt, eDef] = sA > sB ? [A, B, sA, sB] : [B, A, sB, sA];
    const isAtt = new Set(attSide), isDef = new Set(defSide);
    // Pressure of each attacking country per front edge: its army on the line over its own front edges, plus
    // the attacking supporters' army (countries without front states here) spread over all the side's edges.
    // Troops push where they are: a strong country advances on its own sector of a joint line, not on a long,
    // thinly held ally's sector (e.g. Germany's army on the Polish sector, not Finland's border).
    const byC = fronts.lineFront.get(l);
    let sideEdges = 0, support = 0;
    for (const a of attSide) {
      const e = byC?.get(a)?.edges ?? 0;
      sideEdges += e;
      if (!e) support += strength(a);
    }
    const pressure = (a: number) => {
      const e = byC?.get(a)?.edges ?? 0;
      return (e ? strength(a) / e : 0) + (sideEdges ? support / sideEdges : 0);
    };
    // A broad front advances on several sectors at once: the expected advance and its cap grow with the attacking
    // holders' front length beyond config.advanceBreadthEdges (so the Low Countries and France, one long line in
    // 1940, are not limited to a few states a week in total).
    const breadth = Math.max(1, sideEdges / config.advanceBreadthEdges);
    // Target weights: states of the defending side next to states of the attacking side, by the pressure of the
    // adjacent attackers (by adjacency alone if the attackers have no army there).
    const weights = (m: Cands | undefined) => {
      const w = new Map<number, number>(), n = new Map<number, number>();
      let anyPressure = false;
      for (const [t, by] of m ?? []) {
        if (!isDef.has(owner[t])) continue;
        let p = 0, k = 0;
        for (const [a, x] of by) if (isAtt.has(a)) { p += x * pressure(a); k += x; }
        if (k) { w.set(t, p); n.set(t, k); }
        if (p > 0) anyPressure = true;
      }
      if (!anyPressure) return n;
      for (const [t, p] of w) if (!(p > 0)) w.delete(t);
      return w;
    };
    const rawLand = weights(cands?.land), rawSea = weights(cands?.sea);
    // Seasons active now (config.seasons), scaled by the attacking side's non-exempt strength share.
    const active = activeSeasons.map((s) => {
      let free = 0;
      for (const a of attSide) if (!s.exempt.has(a)) free += strength(a);
      const share = eAtt > 0 ? free / eAtt : 1;
      return { land: s.land, loss: 1 + (s.loss - 1) * share, capture: 1 + (s.capture - 1) * share };
    });
    // Terrain and season factors per target state (config.terrainLoss / terrainCapture / seasons).
    const lossOf = (t: number) => {
      let f = config.terrainLoss[sim.terrain[t]];
      for (const s of active) if (s.land.has(sim.landOf[t])) f *= s.loss;
      return f;
    };
    const capOf = (t: number) => {
      let f = config.terrainCapture[sim.terrain[t]];
      for (const s of active) if (s.land.has(sim.landOf[t])) f *= s.capture;
      for (const z of zones) if (z.inside[t] && owner[t] === z.defender) f *= z.capture;
      return f;
    };
    // Averages over the targets by their weights, and each target's weight times its capture factor (easy ground
    // is taken more often, hard ground less).
    let wSum = 0, lossSum = 0;
    for (const m of [rawLand, rawSea]) {
      for (const [t, w] of m) {
        wSum += w;
        lossSum += w * lossOf(t);
      }
    }
    const attLossFactor = wSum > 0 ? lossSum / wSum : 1;
    const capture = (m: Map<number, number>) => {
      let w = 0, c = 0;
      for (const [t, x] of m) { w += x; c += x * capOf(t); }
      return w > 0 ? c / w : 1;
    };
    const skew = (m: Map<number, number>) => new Map([...m].map(([t, w]) => [t, w * capOf(t)]));
    const land = skew(rawLand), sea = skew(rawSea);
    const capLand = capture(rawLand), capSea = capture(rawSea);
    const captures: number[] = [];
    let attempted = false;
    if (land.size) {
      attempted = true;
      const r = eDef > 0 ? eAtt / eDef : Infinity;
      captures.push(...slowed(pickTargets(land, advanceCount(r, config.advanceRate * breadth * stepWeeks(config) * capLand, config.advanceMax * breadth * stepWeeks(config) * capLand, rng), rng)));
    }
    if (sea.size) {
      // A low-priority coast receives only its planned share of amphibious effort, even once other beaches
      // have been cleared. Relative allocation alone would otherwise send the entire idle army there.
      let planned = 0, total = 0;
      for (const [t, w] of rawSea) {
        let n = 0, pref = 0;
        for (const [a, count] of cands?.sea.get(t) ?? []) if (isAtt.has(a)) {
          n += count; pref += count * landingPreference(sim, a, t);
        }
        total += w; planned += w * (n ? pref / n : 1);
      }
      const effort = total ? planned / total : 1;
      // Landing strength (config.landingStrength) counts in the landing comparison only.
      const eLand = landingF ? attSide.reduce((s, a) => s + strength(a) * (landingF[a] ?? 1), 0) : eAtt;
      const rs = eDef > 0 ? (config.navalPenalty * eLand * effort) / eDef : Infinity;
      if (rs > 1) {
        attempted = true;
        captures.push(...slowed(pickTargets(sea, advanceCount(rs, config.advanceRate * breadth * stepWeeks(config) * capSea, config.advanceMax * breadth * stepWeeks(config) * capSea, rng), rng)));
      }
    }
    if (!attempted) return null;
    // The captor is the adjacent attacker pushing hardest on the state (adjacent states × pressure; ties → the
    // stronger army, then the lower index).
    const captor = (t: number) => {
      let best = -1, bestP = -1, bestN = -1;
      for (const m of [cands?.land.get(t), cands?.sea.get(t)]) {
        for (const [a, n] of m ?? []) {
          if (!isAtt.has(a)) continue;
          const p = n * pressure(a);
          if (p > bestP || (p === bestP && (n > bestN || (n === bestN && strength(a) > strength(best))))) { best = a; bestP = p; bestN = n; }
        }
      }
      return best;
    };
    const byStrength = (cs: number[]) => [...cs].sort((x, y) => strength(y) - strength(x) || x - y);
    const attackers = byStrength(attSide), defenders = byStrength(defSide);
    return {
      line: l,
      attackers,
      defenders,
      attacker: attackers[0],
      defender: defenders[0],
      attStrength: eAtt,
      defStrength: eDef,
      loss: config.lossRate * stepWeeks(config) * Math.min(eAtt, eDef),
      attLossFactor,
      attShare: attackers.map((c) => strength(c) / eAtt),
      defShare: defenders.map((c) => (eDef > 0 ? strength(c) / eDef : 1 / defenders.length)),
      captures,
      captors: captures.map(captor),
      capturedFrom: captures.map((t) => owner[t]),
    };
  }
}

/** A loss factor at time `now` (ms): a number, or a schedule of [date, factor] points interpolated linearly. */
export function scheduledFactor(f: number | [string, number][], now: number): number {
  if (typeof f === "number") return f;
  if (!f.length) return 1;
  const pts = f.map(([d, k]) => [parseDate(d), k] as const);
  if (now <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t1, k1] = pts[i], [t0, k0] = pts[i - 1];
    if (now <= t1) return k0 + ((k1 - k0) * (now - t0)) / (t1 - t0);
  }
  return pts[pts.length - 1][1];
}

/** The successor government of c (config.successors) if it exists and has not capitulated, else -1. */
export function successorOf(sim: SimState, c: number): number {
  const s = sim.config.successors[sim.tags[c]];
  if (!s) return -1;
  const t = sim.tags.indexOf(s.tag);
  return t >= 0 && !sim.capitulated[t] ? t : -1;
}

export interface Revival {
  country: number;
  /** Country whose capture liberated it. */
  by: number;
  state: number;
}

/**
 * Applies captures in battle order and losses (each attacker 2L × its share, each defender L × its
 * share, floored at 0). A state is skipped if it already changed hands this week. With
 * liberateToOriginalOwner, a state whose original owner is on the captor's side goes back to that
 * owner; if that owner had capitulated, it is revived first (see revive). Returns the revivals.
 */
export function applyBattles(sim: SimState, battles: Battle[]): Revival[] {
  const { owner, origOwner, military, capitulated, faction } = sim;
  const changed = new Set<number>();
  const revivals: Revival[] = [];
  for (const bt of battles) {
    bt.captures.forEach((s, i) => {
      if (changed.has(s) || owner[s] !== bt.capturedFrom[i]) return;
      let to = bt.captors[i];
      const orig = origOwner[s];
      if (sim.config.liberateToOriginalOwner && orig !== to && faction[orig] !== "neutral" && faction[orig] === faction[to]) {
        // A capitulated country with a successor government (config.successors, e.g. Free France) is not revived:
        // its liberated land goes to the successor.
        const succ = capitulated[orig] ? successorOf(sim, orig) : -1;
        const occ = capitulated[orig] ? activeCapitulationOccupier(sim, orig) : -1;
        if (succ >= 0) to = succ;
        // A surrendered country under allied occupation stays surrendered when that side retakes its land.
        else if (occ >= 0) to = occ;
        else {
          if (capitulated[orig]) {
            revive(sim, orig, to);
            revivals.push({ country: orig, by: to, state: s });
          }
          to = orig;
        }
      }
      setOwner(sim, s, to);
      changed.add(s);
    });
  }
  // Loss multipliers by matchup (config.lossFactors): the largest factor against any enemy in the battle.
  const factors: [number, number, number][] = [];
  const now = tickTime(sim.startMs, sim.tick, sim.config.stepDays);
  for (const [tag, byEnemy] of Object.entries(sim.config.lossFactors)) {
    const c = sim.tags.indexOf(tag);
    for (const [etag, f] of Object.entries(byEnemy)) {
      const e = sim.tags.indexOf(etag);
      if (c >= 0 && e >= 0) factors.push([c, e, scheduledFactor(f, now)]);
    }
  }
  // The largest factor against any enemy in the battle (factors below 1 count too); 1 if none applies.
  const lossFactor = (c: number, enemies: number[]) => {
    let f = -Infinity;
    for (const [x, e, k] of factors) if (x === c && enemies.includes(e)) f = Math.max(f, k);
    return f === -Infinity ? 1 : f;
  };
  // Losses, also added up per faction (sim.losses).
  const lose = (c: number, amount: number) => {
    const before = military[c];
    military[c] = Math.max(0, before - amount);
    const f = faction[c];
    if (f !== "neutral") sim.losses[f].army += before - military[c];
  };
  for (const bt of battles) {
    bt.defenders.forEach((c, i) => lose(c, bt.loss * bt.defShare[i] * lossFactor(c, bt.attackers)));
    bt.attackers.forEach((c, i) => lose(c, 2 * bt.loss * (bt.attLossFactor ?? 1) * bt.attShare[i] * lossFactor(c, bt.defenders)));
  }
  return revivals;
}

/**
 * Brings back a capitulated country when an ally (`by`) liberates one of its original states: it is at
 * war again with every country of another faction that `by` is at war with, starts with army 0 (it then
 * grows from the industry of the states it holds) and, if it builds ships, one empty fleet at home. It
 * cannot capitulate again until it has held its capital once more (revivedAwaitingCapital), unless it loses every state.
 */
export function revive(sim: SimState, c: number, by: number) {
  const nC = sim.tags.length;
  sim.capitulated[c] = 0;
  sim.military[c] = 0;
  sim.entered[c] = 1;
  sim.capitalHeld[c] = 0;
  sim.revivedAwaitingCapital[c] = 1;
  for (let e = 0; e < nC; e++) {
    if (sim.atWar[by * nC + e] && sim.faction[e] !== sim.faction[c] && !sim.capitulated[e]) {
      sim.atWar[c * nC + e] = 1;
      sim.atWar[e * nC + c] = 1;
    }
  }
  if (sim.shipbuilding[c] > 0 && sim.homeZone[c] >= 0 && !sim.fleets.some((f) => f.country === c)) {
    sim.fleets.push({ country: c, zone: sim.homeZone[c], strength: 0, target: sim.homeZone[c] });
  }
}

export function setOwner(sim: SimState, s: number, to: number) {
  if (sim.owner[s] === to) return;
  sim.owner[s] = to;
  sim.invLost[s] = 1;
}
