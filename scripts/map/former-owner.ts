import { pointInRing } from "./raster";

interface RegionFix { name: string; from: string[]; tag: string; polygon: number[][] }

/**
 * Marks the states a region fix moved from one country to another (e.g. Japanese-occupied China, 1939) with
 * `formerOwner` = the country it was taken from, so rules about a country's land (config.slowAdvanceLand) can
 * include them. A state counts if it now belongs to the fix's country and its centre lies in the fix's polygon.
 */
export function addFormerOwners(states: { owner: string; lonlat: number[]; formerOwner?: string }[], fixes: RegionFix[]): number {
  let n = 0;
  for (const fix of fixes) {
    if (fix.from.length !== 1 || fix.from[0] === fix.tag) continue;
    for (const s of states) {
      if (s.owner === fix.tag && !s.formerOwner && pointInRing(s.lonlat[0], s.lonlat[1], fix.polygon)) {
        s.formerOwner = fix.from[0];
        n++;
      }
    }
  }
  return n;
}
