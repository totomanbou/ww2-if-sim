import type { SimState } from "./types";

const theatreCache = new WeakMap<SimState, Uint8Array>();
/** Geographic theatre of the original continental state. Occupation and faction changes do not move it. */
export function landingTheatreStates(sim: SimState): Uint8Array {
  let mask = theatreCache.get(sim);
  if (!mask) {
    mask = Uint8Array.from({ length: sim.nStates }, (_, s) => {
      const tag = sim.tags[sim.origOwner[s]], lon = sim.stateLonLat[2 * s], lat = sim.stateLonLat[2 * s + 1];
      if (!sim.core[s]) return 0;
      const i = sim.config.landingTheatres.findIndex((t) => t.land.includes(tag) &&
        t.boxes.some(([w, so, e, n]) => lon >= w && lon <= e && lat >= so && lat <= n));
      return i + 1;
    });
    theatreCache.set(sim, mask);
  }
  return mask;
}

const preferenceCache = new WeakMap<SimState, Map<number, Float64Array>>();
/** Preference is paid only for a sea attack, never for an existing land front or coastal defence. */
export function landingPreference(sim: SimState, attacker: number, state: number): number {
  let cache = preferenceCache.get(sim);
  if (!cache) preferenceCache.set(sim, (cache = new Map()));
  let weights = cache.get(attacker);
  if (!weights) {
    const rules = sim.config.landingPreferences.filter((r) => r.faction === sim.faction[attacker] && !r.except.includes(sim.tags[attacker]));
    weights = Float64Array.from({ length: sim.nStates }, (_, s) => {
      const tag = sim.tags[sim.origOwner[s]], lon = sim.stateLonLat[2 * s], lat = sim.stateLonLat[2 * s + 1];
      let factor = 1;
      for (const r of rules) if (sim.core[s] && r.land.includes(tag) &&
        r.boxes.some(([w, so, e, n]) => lon >= w && lon <= e && lat >= so && lat <= n)) factor *= r.factor;
      return factor;
    });
    cache.set(attacker, weights);
  }
  return weights[state];
}
