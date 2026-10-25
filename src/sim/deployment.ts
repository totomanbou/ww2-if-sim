import type { Fronts } from "./combat";
import type { SimState } from "./types";

const cache = new WeakMap<Fronts, Map<number, boolean>>();

/** Hard access check: owning front states, a land connection and already-deployed troops grant no exception. */
export function canDeployToFront(sim: SimState, fronts: Fronts, line: number, country: number): boolean {
  let byKey = cache.get(fronts);
  if (!byKey) cache.set(fronts, (byKey = new Map()));
  const key = line * sim.tags.length + country;
  const cached = byKey.get(key);
  if (cached !== undefined) return cached;
  const tag = sim.tags[country], side = fronts.sideArr[country];
  let allowed = true;
  for (const ban of sim.config.frontDeploymentBans) {
    if (ban.country !== tag) continue;
    const theatre = fronts.theatreNames.get(line);
    if (theatre && ban.theatres.includes(theatre)) { allowed = false; break; }
    for (const s of fronts.statesByLine.get(line) ?? []) {
      const lon = sim.stateLonLat[2 * s], lat = sim.stateLonLat[2 * s + 1];
      if (!ban.boxes.some(([w, so, e, n]) => lon >= w && lon <= e && lat >= so && lat <= n)) continue;
      if (ban.land.includes(sim.tags[sim.origOwner[s]])) { allowed = false; break; }
      const holder = sim.owner[s];
      if (holder === country || fronts.sideArr[holder] !== side || !ban.heldBy.includes(sim.tags[holder])) continue;
      allowed = false;
      break;
    }
    if (!allowed) break;
  }
  byKey.set(key, allowed);
  return allowed;
}
