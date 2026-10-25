import type { SimState } from "./types";

export interface CapitalChange { country: number; by: number; recaptured: boolean }

/** Notification state survives surrender and revival, independently of the country's activity. */
export function capitalChanges(sim: SimState): CapitalChange[] {
  const changes: CapitalChange[] = [];
  for (let c = 0; c < sim.tags.length; c++) {
    const state = sim.capital[c];
    if (state < 0 || state >= sim.nStates) continue;
    const by = sim.owner[state];
    // Keep the existing strict country-ownership flag for the rest of the engine.
    if (!sim.capitulated[c]) sim.capitalHeld[c] = by === c ? 1 : 0;
    // An exile government's moving seat is not a national capital that can fall.
    if (sim.origCount[c] === 0) continue;
    const home = sim.faction[c], holder = sim.faction[by];
    const friendly = by === c || (home !== "neutral" && holder === home);
    const enemy = home !== "neutral" && holder !== "neutral" && holder !== home;
    if (enemy && !sim.capitalOccupied[c]) {
      sim.capitalOccupied[c] = 1;
      changes.push({ country: c, by, recaptured: false });
    } else if (friendly && sim.capitalOccupied[c]) {
      sim.capitalOccupied[c] = 0;
      changes.push({ country: c, by, recaptured: true });
    }
  }
  return changes;
}
