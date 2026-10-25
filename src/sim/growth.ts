import { maskFactor } from "./mask";
import { parseDate, stepWeeks, tickTime } from "./date";
import { scheduledFactor } from "./combat";
import type { SimState } from "./types";

/**
 * Effective industry per country:
 *   I_n × (weight of own original states still held)
 *   + occupiedIndustryRate × Σ over occupied states s: I_orig(s) × weight(s)
 * Weights sum to 1 per original owner (see init.ts), so holding everything gives I_n.
 */
export function effectiveIndustry(sim: SimState): Float64Array {
  const nC = sim.tags.length;
  const eff = new Float64Array(nC);
  const { owner, origOwner, weight, industry, capitulated } = sim;
  const rate = sim.config.occupiedIndustryRate;
  for (let s = 0; s < sim.nStates; s++) {
    const o = owner[s], orig = origOwner[s];
    if (o === orig) eff[o] += industry[o] * weight[s];
    else eff[o] += rate * industry[orig] * weight[s];
  }
  // A country without original territory (a government in exile such as Free France) produces from its own
  // industry value, independent of what it holds (Allied supply).
  for (let c = 0; c < nC; c++) if (sim.origCount[c] === 0) eff[c] += industry[c];
  for (let c = 0; c < nC; c++) if (capitulated[c]) eff[c] = 0;
  return eff;
}

/** Yearly military growth = effective industry × stability × mask(country, year). */
export function yearlyGrowth(sim: SimState, eff: Float64Array, year: number): Float64Array {
  return Float64Array.from(eff, (e, c) => e * sim.stability[c] * maskFactor(sim.tags[c], year, sim.mask));
}

/**
 * Applies this tick's growth: continuous mode adds stepWeeks/52 of the yearly amount; yearly mode adds
 * the full amount on the half-step containing 1 September (excluding the start tick, which
 * already has the initial military). Countries not yet at war grow × config.preWarGrowth[tag].
 */
export function applyGrowth(sim: SimState, eff: Float64Array, year: number, isSept1Week: boolean) {
  let factor: number;
  if (sim.config.growthMode === "weekly") factor = stepWeeks(sim.config) / 52;
  else if (isSept1Week && sim.tick > 0) factor = 1;
  else return;
  const g = yearlyGrowth(sim, eff, year);
  const add = new Float64Array(g.length);
  for (let c = 0; c < g.length; c++) {
    if (sim.capitulated[c]) continue;
    const pre = sim.entered[c] ? 1 : sim.config.preWarGrowth[sim.tags[c]] ?? 1;
    add[c] = g[c] * factor * pre;
  }
  // Lend-Lease (config.lendLease): a share of the donors' growth goes to the recipient.
  const now = tickTime(sim.startMs, sim.tick, sim.config.stepDays);
  for (const ll of sim.config.lendLease) {
    const to = sim.tags.indexOf(ll.to);
    if (to < 0 || sim.capitulated[to] || !sim.entered[to] || now < parseDate(ll.start)) continue;
    for (const tag of ll.from) {
      const d = sim.tags.indexOf(tag);
      if (d < 0 || d === to || sim.capitulated[d]) continue;
      const moved = add[d] * scheduledFactor(ll.share, now);
      add[d] -= moved;
      add[to] += moved;
    }
  }
  for (let c = 0; c < g.length; c++) sim.military[c] += add[c];
}
