import { revive, setOwner, successorOf, type Revival } from "./combat";
import { CAPITULATION_MASK } from "./mask";
import type { SimState } from "./types";

/**
 * Share of its original territory (industry weight) a country must lose, with its capital, to capitulate:
 * linear in political stability, times the hidden capitulation mask, clamped (config.capitulationThreshold).
 */
export function capitulationThreshold(sim: SimState, c: number): number {
  const { capitulationThreshold: base, capitulationStabilitySlope: slope, capitulationStabilityRef: ref,
    capitulationThresholdRange: [lo, hi] } = sim.config;
  const t = (base + slope * (sim.stability[c] - ref)) * (CAPITULATION_MASK[sim.tags[c]] ?? 1);
  return Math.min(hi, Math.max(lo, t));
}

/** The continent: the land mass with the most states (cached per simulation). */
const continentCache = new WeakMap<SimState, number>();
export function continentMass(sim: SimState): number {
  let m = continentCache.get(sim);
  if (m === undefined) {
    const count = new Map<number, number>();
    for (const x of sim.landMass) count.set(x, (count.get(x) ?? 0) + 1);
    m = -1;
    let best = -1;
    for (const [x, n] of count) if (n > best || (n === best && x < m)) { m = x; best = n; }
    continentCache.set(sim, m);
  }
  return m;
}

/** True if c has original states on the continent and holds none of them. */
export function lostContinent(sim: SimState, c: number): boolean {
  const mass = continentMass(sim);
  let any = false;
  for (let s = 0; s < sim.nStates; s++) {
    if (sim.origOwner[s] !== c || sim.landMass[s] !== mass) continue;
    if (sim.owner[s] === c) return false;
    any = true;
  }
  return any;
}

/** Share of a country's original territory (industry weight) held by others. */
export function lostShare(sim: SimState, c: number): number {
  // Countries in config.capitulationOwnLandOnly count only their own land (sim.landOf = c: homeland and colonies),
  // not what they had taken from others before 1939 (e.g. Japan's occupied China, Manchukuo included).
  if (sim.config.capitulationOwnLandOnly.includes(sim.tags[c])) {
    let lost = 0, total = 0;
    for (let s = 0; s < sim.nStates; s++) {
      if (sim.origOwner[s] !== c || sim.landOf[s] !== c) continue;
      total += sim.weight[s];
      if (sim.owner[s] !== c) lost += sim.weight[s];
    }
    return total > 0 ? lost / total : 0;
  }
  let lost = 0;
  for (let s = 0; s < sim.nStates; s++) if (sim.origOwner[s] === c && sim.owner[s] !== c) lost += sim.weight[s];
  return lost;
}

/**
 * Enemy that receives a capitulating country's remaining territory: the one at war with it with the largest army on
 * its fronts this week (sim.facing, set in combat.resolveCombat); ties → most of its original states held → larger
 * military → lower index. Returns -1 if it has no enemies.
 */
/**
 * Who receives a capitulating country's remaining territory: its occupying ally (config.capitulationOccupier) if
 * that ally is on the same side and has not capitulated, otherwise the enemy chosen by capitulationRecipient.
 */
export function capitulationReceiver(sim: SimState, c: number): number {
  const occ = sim.tags.indexOf(sim.config.capitulationOccupier[sim.tags[c]] ?? "");
  if (occ >= 0 && occ !== c && !sim.capitulated[occ] && sim.faction[occ] !== "neutral" && sim.faction[occ] === sim.faction[c]) return occ;
  return capitulationRecipient(sim, c);
}

export function capitulationRecipient(sim: SimState, c: number): number {
  const nC = sim.tags.length;
  const held = new Int32Array(nC);
  for (let s = 0; s < sim.nStates; s++) if (sim.origOwner[s] === c && sim.owner[s] !== c) held[sim.owner[s]]++;
  // User requirement: the enemy with the largest army this week on the fronts with c (sim.facing) receives the
  // territory; ties and weeks without any such army fall back to the most original states held, then the larger army.
  const facing = (e: number) => sim.facing[c * nC + e];
  let best = -1;
  for (let e = 0; e < nC; e++) {
    if (!sim.atWar[c * nC + e] || sim.capitulated[e]) continue;
    if (best < 0 || facing(e) > facing(best) || (facing(e) === facing(best) &&
      (held[e] > held[best] || (held[e] === held[best] && sim.military[e] > sim.military[best])))) best = e;
  }
  return best;
}

/**
 * Capitulates every country that has lost its capital and at least capitulationThreshold(sim, c) of its
 * original territory, or only its capital for the countries in config.capitulateOnCapitalLoss, or all its
 * continental states (capital or not) for those in config.capitulateOnContinentLoss
 * (revived countries only after they have held their capital again).
 * Returns [country, recipient] pairs in country order.
 */
export function checkCapitulations(sim: SimState, revivals: Revival[] = []): [number, number][] {
  const nC = sim.tags.length;
  const out: [number, number][] = [];
  for (let c = 0; c < nC; c++) {
    if (sim.capitulated[c] || sim.origCount[c] === 0) continue;
    const onContinent = sim.config.capitulateOnContinentLoss.includes(sim.tags[c]);
    if (onContinent && !sim.revivedAwaitingCapital[c] && lostContinent(sim, c)) {
      const to = capitulationReceiver(sim, c);
      capitulate(sim, c, to, revivals);
      out.push([c, to]);
      continue;
    }
    if (sim.owner[sim.capital[c]] === c) {
      sim.revivedAwaitingCapital[c] = 0;
      continue;
    }
    // A revived country cannot capitulate again before it has got its capital back.
    if (sim.revivedAwaitingCapital[c]) continue;
    const onCapital = sim.config.capitulateOnCapitalLoss.includes(sim.tags[c]);
    if (!onCapital && lostShare(sim, c) < capitulationThreshold(sim, c) - 1e-9) continue;
    const to = capitulationReceiver(sim, c);
    capitulate(sim, c, to, revivals);
    out.push([c, to]);
  }
  return out;
}

/**
 * Capitulates c: its colonies stay its own (out of the war, like Vichy France's); the rest of what it holds — its
 * homeland and territory it occupied — goes to the recipient `to`, except states originally of an ally of `to`
 * (same non-neutral faction): those are handed back to that ally, which is revived if it had capitulated (as on
 * liberation, config.liberateToOriginalOwner). Revivals are appended to `revivals`.
 */
export function capitulate(sim: SimState, c: number, to: number, revivals: Revival[] = []) {
  const nC = sim.tags.length;
  if (to >= 0) {
    const { origOwner, faction } = sim;
    for (let s = 0; s < sim.nStates; s++) {
      if (sim.owner[s] !== c || (origOwner[s] === c && !sim.core[s])) continue;
      const orig = origOwner[s];
      let dest = to;
      if (sim.config.liberateToOriginalOwner && orig !== to && orig !== c && faction[orig] !== "neutral" && faction[orig] === faction[to]) {
        const succ = sim.capitulated[orig] ? successorOf(sim, orig) : -1;
        if (succ >= 0) dest = succ;
        else {
          if (sim.capitulated[orig]) {
            revive(sim, orig, to);
            revivals.push({ country: orig, by: to, state: s });
          }
          dest = orig;
        }
      }
      setOwner(sim, s, dest);
    }
  }
  sim.capitulated[c] = 1;
  sim.military[c] = 0;
  sim.fleets = sim.fleets.filter((f) => f.country !== c);
  for (let e = 0; e < nC; e++) {
    sim.atWar[c * nC + e] = 0;
    sim.atWar[e * nC + c] = 0;
  }
}
