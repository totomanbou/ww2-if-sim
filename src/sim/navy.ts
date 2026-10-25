import { nextFloat } from "./rng";
import { perStepProbability, stepWeeks } from "./date";
import { closedLandings } from "./landing";
import type { Faction, SimState } from "./types";

/** Naval power per country per zone: index c * nZ + z. */
export function fleetPower(sim: SimState): Float64Array {
  const nZ = sim.zoneNames.length;
  const out = new Float64Array(sim.tags.length * nZ);
  for (const f of sim.fleets) if (f.zone >= 0) out[f.country * nZ + f.zone] += f.strength;
  return out;
}

/** Total naval power per country. */
export function navyTotals(sim: SimState): Float64Array {
  const out = new Float64Array(sim.tags.length);
  for (const f of sim.fleets) out[f.country] += f.strength;
  return out;
}

/**
 * Navy growth: shipbuilding × stability per year (stepWeeks/52 per update, or all on the half-step
 * containing 1 September in yearly mode), times preWarGrowth; shared equally by its fleets.
 * No mask and no reduction for lost territory.
 */
export function applyNavyGrowth(sim: SimState, isSept1Week: boolean) {
  let factor: number;
  if (sim.config.growthMode === "weekly") factor = stepWeeks(sim.config) / 52;
  else if (isSept1Week && sim.tick > 0) factor = 1;
  else return;
  const count = new Int32Array(sim.tags.length);
  for (const f of sim.fleets) count[f.country]++;
  for (const f of sim.fleets) {
    const c = f.country;
    if (sim.capitulated[c]) continue;
    const pre = sim.entered[c] ? 1 : sim.config.preWarGrowth[sim.tags[c]] ?? 1;
    f.strength += (sim.shipbuilding[c] * sim.stability[c] * factor * pre) / count[c];
  }
}

/**
 * Fleet deployment (automatic: the game is observation only). Each week every country at war scores
 * the zones by the sea routes running through them that connect it to an enemy (weight 1) or an ally to a
 * common enemy (weight 0.5); the score is divided by (1 + hops from the home zone), so nearby fronts come
 * first but a navy still goes to distant fronts where its side fights (an earlier squared discount with
 * allied fronts limited to 2 hops kept the US fleet out of the western Pacific for the whole war). It
 * shares its fleets between the best zones in proportion to the score (largest remainder), sends each slot
 * the nearest fleet that can reach it, and moves every fleet one zone towards its target. Countries not at
 * war keep their fleets in the home zone. A route does not count for a country while its landing on the enemy end is
 * banned (config.landingBans, the scenario's landing restrictions; user requirement: no fleets for landings that
 * cannot happen yet).
 */
export function moveFleets(sim: SimState) {
  const nC = sim.tags.length, nZ = sim.zoneNames.length;
  if (!nZ) return;
  const { owner, atWar, faction, routeA, routeB, routeZone, zoneDist } = sim;
  const atWarAny = new Uint8Array(nC);
  for (let a = 0; a < nC; a++) for (let b = 0; b < nC; b++) if (atWar[a * nC + b]) atWarAny[a] = 1;
  const score = new Float64Array(nC * nZ);
  const closed = closedLandings(sim);
  // Fleet enemy weights (config.fleetEnemyWeights): country → enemy → multiplier, by tag index.
  let enemyW: (Map<number, number> | undefined)[] | null = null;
  for (const [tag, byEnemy] of Object.entries(sim.config.fleetEnemyWeights)) {
    const c = sim.tags.indexOf(tag);
    if (c < 0) continue;
    for (const [et, k] of Object.entries(byEnemy)) {
      const e = sim.tags.indexOf(et);
      if (e < 0) continue;
      if (!enemyW) enemyW = [];
      (enemyW[c] ??= new Map()).set(e, k);
    }
  }
  for (let r = 0; r < routeA.length; r++) {
    const z = routeZone[r];
    if (z < 0) continue;
    const oa = owner[routeA[r]], ob = owner[routeB[r]];
    if (oa === ob || !atWar[oa * nC + ob]) continue;
    for (let c = 0; c < nC; c++) {
      if (!atWarAny[c]) continue;
      // The enemy end of the route for c (c's own or its ally's state at the other end) and the enemy there. A route
      // c cannot land through still counts for defence while the enemy may land through it, with a lower weight
      // (config.fleetDefenceWeight).
      const ownSideA = c === oa || (c !== ob && faction[c] === faction[oa]);
      const enemyEnd = ownSideA ? routeB[r] : routeA[r], ownEnd = ownSideA ? routeA[r] : routeB[r];
      const enemy = owner[enemyEnd];
      let w = 1;
      if (closed[c]?.[enemyEnd]) {
        if (closed[enemy]?.[ownEnd]) continue;
        w = sim.config.fleetDefenceWeight;
      }
      if (enemyW) {
        const ew = enemyW[c]?.get(enemy);
        if (ew !== undefined) w *= ew;
      }
      if (c === oa || c === ob) score[c * nZ + z] += w;
      else if (faction[c] !== "neutral" &&
        (faction[c] === faction[oa] && atWar[c * nC + ob] || faction[c] === faction[ob] && atWar[c * nC + oa])) {
        score[c * nZ + z] += 0.5 * w;
      }
    }
  }
  const byCountry = new Map<number, typeof sim.fleets>();
  for (const f of sim.fleets) {
    if (!byCountry.has(f.country)) byCountry.set(f.country, []);
    byCountry.get(f.country)!.push(f);
  }
  for (const [c, fleets] of byCountry) {
    const home = sim.homeZone[c];
    const reachable = (z: number) => fleets.some((f) => zoneDist[f.zone * nZ + z] !== 255);
    // Fleet zones (config.fleetZones): the other zones are never targets.
    const allowedNames = sim.config.fleetZones[sim.tags[c]];
    if (allowedNames) {
      const allowed = new Set(allowedNames.map((n) => sim.zoneNames.indexOf(n)).filter((z) => z >= 0));
      for (let z = 0; z < nZ; z++) if (!allowed.has(z)) score[c * nZ + z] = 0;
    }
    for (let z = 0; z < nZ; z++) {
      const d = zoneDist[home * nZ + z];
      if (score[c * nZ + z] > 0) score[c * nZ + z] /= 1 + (d === 255 ? nZ : d);
    }
    const zones = [];
    for (let z = 0; z < nZ; z++) if (score[c * nZ + z] > 0 && reachable(z)) zones.push(z);
    zones.sort((p, q) => score[c * nZ + q] - score[c * nZ + p] || p - q);
    let slots: number[];
    if (!atWarAny[c] || !zones.length) slots = fleets.map(() => home);
    else {
      const top = zones.slice(0, fleets.length);
      const total = top.reduce((s, z) => s + score[c * nZ + z], 0);
      const quota = top.map((z) => (fleets.length * score[c * nZ + z]) / total);
      const n = quota.map(Math.floor);
      const order = top.map((_, i) => i).sort((i, j) => quota[j] - n[j] - (quota[i] - n[i]) || i - j);
      for (let k = 0, left = fleets.length - n.reduce((s, x) => s + x, 0); k < left; k++) n[order[k % order.length]]++;
      slots = top.flatMap((z, i) => Array(n[i]).fill(z));
    }
    // Greedy: best-scored slots first take the nearest free fleet that can reach them.
    const free = new Set(fleets);
    for (const z of slots) {
      let best: (typeof fleets)[number] | null = null;
      for (const f of free) {
        const d = zoneDist[f.zone * nZ + z];
        if (d !== 255 && (!best || d < zoneDist[best.zone * nZ + z])) best = f;
      }
      if (!best) continue;
      best.target = z;
      free.delete(best);
    }
    for (const f of free) f.target = f.zone;
    for (const f of fleets) {
      if (f.zone === f.target) { f.moveWeeks = 0; continue; }
      f.moveWeeks = (f.moveWeeks ?? 0) + stepWeeks(sim.config);
      if (f.moveWeeks < 1) continue;
      f.moveWeeks -= 1;
      const d = zoneDist[f.zone * nZ + f.target];
      const next = sim.zoneNeighbors[f.zone].filter((n) => zoneDist[n * nZ + f.target] === d - 1).sort((p, q) => p - q)[0];
      if (next !== undefined) f.zone = next;
    }
  }
}

export interface FleetBattle {
  zone: number;
  before: Record<"axis" | "allies", number>;
  loss: Record<"axis" | "allies", number>;
  /** All participating countries. */
  countries: number[];
  /** Up to the 2 strongest navies per side, strongest first. */
  main: Record<"axis" | "allies", number[]>;
}

/**
 * Fleet battles: opposing fleets at war meet with the weekly probability fleetBattleChance converted
 * to the elapsed half-week (1 - sqrt(1 - p)). Conditional battle damage is per battle, not a weekly flow.
 * Each side loses min(own, fleetBattleLossRate × enemy power × random 0.6–1.4), shared by its
 * participating fleets in proportion to their strength.
 */
export function resolveFleetBattles(sim: SimState): FleetBattle[] {
  const nC = sim.tags.length, nZ = sim.zoneNames.length;
  const out: FleetBattle[] = [];
  const inZone: (typeof sim.fleets)[] = Array.from({ length: nZ }, () => []);
  for (const f of sim.fleets) if (f.zone >= 0 && f.strength > 0) inZone[f.zone].push(f);
  const sideOf = (c: number): "axis" | "allies" | null => {
    const f: Faction = sim.faction[c];
    return f === "neutral" ? null : f;
  };
  for (let z = 0; z < nZ; z++) {
    const fl = inZone[z];
    if (fl.length < 2) continue;
    const present = [...new Set(fl.map((f) => f.country))];
    const fighting = new Set<number>();
    for (const a of present) for (const b of present) {
      const sa = sideOf(a), sb = sideOf(b);
      if (sa && sb && sa !== sb && sim.atWar[a * nC + b]) { fighting.add(a); fighting.add(b); }
    }
    if (!fighting.size) continue;
    const part = fl.filter((f) => fighting.has(f.country));
    const power = { axis: 0, allies: 0 };
    for (const f of part) power[sideOf(f.country)!] += f.strength;
    if (power.axis <= 0 || power.allies <= 0) continue;
    if (nextFloat(sim.rng) >= perStepProbability(sim.config.fleetBattleChance, stepWeeks(sim.config))) continue;
    const rate = sim.config.fleetBattleLossRate;
    const loss = {
      axis: Math.min(power.axis, rate * power.allies * (0.6 + 0.8 * nextFloat(sim.rng))),
      allies: Math.min(power.allies, rate * power.axis * (0.6 + 0.8 * nextFloat(sim.rng))),
    };
    const main = { axis: [] as number[], allies: [] as number[] };
    for (const side of ["axis", "allies"] as const) {
      const by = new Map<number, number>();
      for (const f of part) if (sideOf(f.country) === side) by.set(f.country, (by.get(f.country) ?? 0) + f.strength);
      main[side] = [...by].sort((p, q) => q[1] - p[1] || p[0] - q[0]).slice(0, 2).map(([c]) => c);
    }
    for (const f of part) {
      const side = sideOf(f.country)!;
      const before = f.strength;
      f.strength = Math.max(0, f.strength * (1 - loss[side] / power[side]));
      sim.losses[side].navy += before - f.strength;
    }
    out.push({ zone: z, before: power, loss, countries: [...fighting].sort((a, b) => a - b), main });
  }
  return out;
}

/**
 * Naval superiority for a landing by `att` on `def` through zone z: the attacker side (att and its
 * faction mates at war with def) must have fleets there and at least navalSuperiority × the
 * defender side (def and its faction mates at war with att).
 */
export function hasSuperiority(sim: SimState, power: Float64Array, att: number, def: number, z: number): boolean {
  if (z < 0) return false;
  const nC = sim.tags.length, nZ = sim.zoneNames.length;
  let a = 0, d = 0;
  for (let c = 0; c < nC; c++) {
    const p = power[c * nZ + z];
    if (!p) continue;
    if (c === att || (sim.faction[c] !== "neutral" && sim.faction[c] === sim.faction[att] && sim.atWar[c * nC + def])) a += p;
    else if (c === def || (sim.faction[c] !== "neutral" && sim.faction[c] === sim.faction[def] && sim.atWar[c * nC + att])) d += p;
  }
  return a > 0 && a >= sim.config.navalSuperiority * d;
}

/**
 * Naval control of sea route k (an entry of sim.seaNb) for a landing by att against def: superiority in the route's
 * zone and, for a route longer than config.longRouteKm, also in at least one port zone of each end (an end with no
 * port zones does not count).
 */
export function routeControlled(sim: SimState, power: Float64Array, att: number, def: number, k: number): boolean {
  if (!hasSuperiority(sim, power, att, def, sim.seaZone[k])) return false;
  if (sim.seaKm[k] <= sim.config.longRouteKm) return true;
  const end = (x: number) => {
    if (sim.portOff[x] === sim.portOff[x + 1]) return true;
    for (let j = sim.portOff[x]; j < sim.portOff[x + 1]; j++) if (hasSuperiority(sim, power, att, def, sim.portZone[j])) return true;
    return false;
  };
  return end(sim.seaFrom[k]) && end(sim.seaNb[k]);
}

export { blockedLandings } from "./landing";
