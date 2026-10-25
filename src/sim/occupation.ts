import type { SimState } from "./types";

/** Active allied occupier of a surrendered country, or -1 when that occupation rule cannot apply. */
export function activeCapitulationOccupier(sim: SimState, c: number): number {
  const occupier = sim.tags.indexOf(sim.config.capitulationOccupier[sim.tags[c]] ?? "");
  return occupier >= 0 && occupier !== c && !sim.capitulated[occupier] &&
    sim.faction[occupier] !== "neutral" && sim.faction[occupier] === sim.faction[c] ? occupier : -1;
}
