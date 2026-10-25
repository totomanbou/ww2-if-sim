import { FACTION_COLORS } from "../data";
import { fleetPower, type SimState } from "../sim";
import type { MapData } from "../sim/mapTypes";

/** Map badges: Axis / Allied naval power per sea zone (zones without fleets of either side are omitted). */
export function fleetBadges(sim: SimState, map: MapData) {
  const nZ = sim.zoneNames.length;
  const power = fleetPower(sim);
  const out: { at: [number, number]; lines: { text: string; color: string }[] }[] = [];
  for (let z = 0; z < nZ; z++) {
    const side = { axis: 0, allies: 0 };
    for (let c = 0; c < sim.tags.length; c++) {
      const f = sim.faction[c];
      if (f !== "neutral") side[f] += power[c * nZ + z];
    }
    const lines = [];
    if (side.axis >= 0.5) lines.push({ text: `枢 ${Math.round(side.axis)}`, color: FACTION_COLORS.axis });
    if (side.allies >= 0.5) lines.push({ text: `連 ${Math.round(side.allies)}`, color: FACTION_COLORS.allies });
    if (lines.length) out.push({ at: map.seaZones[z].center, lines });
  }
  return out;
}
